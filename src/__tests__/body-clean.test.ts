import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery, mockJudge } = vi.hoisted(() => ({ mockQuery: vi.fn(), mockJudge: vi.fn() }));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock("../services/chat-service", () => ({
  judgeChoices: (...args: unknown[]) => mockJudge(...args),
}));

import {
  cleanBodies,
  toUnits,
  buildJudgment,
  CLEANER_VERSION,
  MAX_JUDGED_PER_READ,
  MAX_UNITS,
  LINE_KINDS,
} from "../services/body-clean";
import { structureBody } from "../services/body-structure";

const ORG = "00000000-0000-4000-a000-000000000001";
const IDENTITY = { orgId: ORG, userId: "u", runId: "r" };

const LINKEDIN_DIGEST = [
  "You have 1 new message",
  "",
  ".....................................",
  "",
  "Marwene Amor (Founder @ EmailToolsHub)",
  `View message: https://www.linkedin.com/comm/messaging/thread/2?${"t".repeat(300)}`,
  "}",
  "----------------------------------------",
  "This email was intended for Kevin Lourd",
  "Unsubscribe: https://www.linkedin.com/comm/mypreferences/u/emailunsub?" + "u".repeat(300),
  "© 2026 LinkedIn Corporation, 1000 West Maude Avenue, Sunnyvale, CA 94085.",
].join("\n");

// Answers keyed by the line text: kind + P(message).
const answerFor = (verdicts: Record<string, [string, number]>) =>
  async (state: string, questions: Record<string, { instructions: string }>) => {
    const answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      const hit = Object.entries(verdicts).find(([text]) => q.instructions.includes(text));
      if (!hit) throw new Error(`no verdict for ${q.instructions}`);
      const [kind, pm] = hit[1];
      answers[key] = { type: "choice", choice: kind, confidence: 0.9, probabilities: { message: pm, [kind]: 1 - pm } };
    }
    return { model: "jev-1.13.0", answers, usage: { inputTokens: 1234, outputTokens: 0 } };
  };

const msg = (id: string, text: string | null, readable = true) => ({ gmailMessageId: id, subject: "s", text, readable });

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe("cleanBodies", () => {
  it("reduces a LinkedIn digest to its meaningful lines and persists the judgment once", async () => {
    mockJudge.mockImplementation(
      answerFor({
        "You have 1 new message": ["message", 0.99],
        "Marwene Amor": ["message", 0.98],
        "View message:": ["link_label", 0.0],
        "This email was intended": ["footer", 0.02],
        "Unsubscribe:": ["footer", 0.0],
        "© 2026 LinkedIn": ["footer", 0.0],
      })
    );

    const out = await cleanBodies(ORG, [msg("m1", LINKEDIN_DIGEST)], IDENTITY);

    expect(out.get("m1")).toEqual({
      text: "You have 1 new message\n\nMarwene Amor (Founder @ EmailToolsHub)",
      status: "cleaned",
    });
    // One Jev call for the message, on the caller's identity; no URL, no stray brace sent.
    expect(mockJudge).toHaveBeenCalledTimes(1);
    const [state, , identity] = mockJudge.mock.calls[0];
    expect(identity).toEqual(IDENTITY);
    expect(state).not.toContain("https://www.linkedin.com/comm");
    expect(state).not.toMatch(/^\[\d+\] \}$/m);

    const insert = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO gmail_message_clean_bodies"));
    expect(insert).toBeTruthy();
    const params = insert![1] as unknown[];
    expect(params.slice(0, 5)).toEqual([
      ORG,
      "m1",
      CLEANER_VERSION,
      "cleaned",
      "You have 1 new message\n\nMarwene Amor (Founder @ EmailToolsHub)",
    ]);
    expect(params[6]).toBe("jev-1.13.0");
    expect(params[7]).toBe(1234);
  });

  it("serves a stored judgment without calling Jev again (judged once, never per read)", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ gmail_message_id: "m1", status: "cleaned", clean_text: "Yes, send the deck." }],
    });

    const out = await cleanBodies(ORG, [msg("m1", "Yes, send the deck.\n\nBest,\nJane")], IDENTITY);

    expect(out.get("m1")).toEqual({ text: "Yes, send the deck.", status: "cleaned" });
    expect(mockJudge).not.toHaveBeenCalled();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("org_id = $1");
    expect(sql).toContain("cleaner_version = $3");
    expect(params).toEqual([ORG, ["m1"], CLEANER_VERSION]);
  });

  it("shows only the new reply text: quoted history cut structurally, signature judged out", async () => {
    mockJudge.mockImplementation(
      answerFor({
        "Thursday works for me.": ["message", 1],
        "Best,": ["message", 0.97],
        "Jane Doe | VP Sales": ["signature", 0.02],
        "+1 555 0100": ["signature", 0.0],
      })
    );
    const reply = [
      "Thursday works for me.",
      "",
      "Best,",
      "Jane Doe | VP Sales",
      "+1 555 0100",
      "",
      "On Mon, Oct 5, 2026 at 10:00 AM Kevin <kevin@x.com> wrote:",
      "> Would Thursday work?",
    ].join("\n");

    const out = await cleanBodies(ORG, [msg("m1", reply)], IDENTITY);

    expect(out.get("m1")).toEqual({ text: "Thursday works for me.\n\nBest,", status: "cleaned" });
    expect(mockJudge.mock.calls[0][0]).not.toContain("Would Thursday work?");
  });

  it("keeps a line the model is not reasonably sure is NOT the sender's words", async () => {
    mockJudge.mockImplementation(
      answerFor({ "Call me Monday.": ["message", 1], "Sent from my phone": ["footer", 0.35] })
    );
    const out = await cleanBodies(ORG, [msg("m1", "Call me Monday.\nSent from my phone")], IDENTITY);
    expect(out.get("m1")?.text).toBe("Call me Monday.\nSent from my phone");
  });

  it("never drops a message whose every line is judged non-message: original served, flagged", async () => {
    mockJudge.mockImplementation(answerFor({ "Unsubscribe": ["footer", 0.01], "Help": ["footer", 0.0] }));
    const original = "Unsubscribe\nHelp";

    const out = await cleanBodies(ORG, [msg("m1", original)], IDENTITY);

    expect(out.get("m1")).toEqual({ text: original, status: "nothing_kept" });
    const insert = mockQuery.mock.calls.find((c) => String(c[0]).includes("INSERT"));
    expect((insert![1] as unknown[])[3]).toBe("nothing_kept");
    expect((insert![1] as unknown[])[4]).toBeNull();
  });

  it("serves a stored nothing_kept judgment as the original, flagged", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ gmail_message_id: "m1", status: "nothing_kept", clean_text: null }] });
    const out = await cleanBodies(ORG, [msg("m1", "Unsubscribe\nHelp")], IDENTITY);
    expect(out.get("m1")).toEqual({ text: "Unsubscribe\nHelp", status: "nothing_kept" });
  });

  it("flags a message that is only quoted history as nothing_kept without a Jev call", async () => {
    const original = "On Mon, Jane <j@x.com> wrote:\n> hi";
    const out = await cleanBodies(ORG, [msg("m1", original)], IDENTITY);
    expect(out.get("m1")).toEqual({ text: original, status: "nothing_kept" });
    expect(mockJudge).not.toHaveBeenCalled();
  });

  it("flags judge_failed (structural clean only) and persists nothing when Jev fails", async () => {
    mockJudge.mockRejectedValue(new Error("chat-service judgments failed: 502"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const out = await cleanBodies(ORG, [msg("m1", "Yes please.\n-- \nJane")], IDENTITY);

    expect(out.get("m1")).toEqual({ text: "Yes please.", status: "judge_failed" });
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes("INSERT"))).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("judges at most MAX_JUDGED_PER_READ messages per read, newest first; the rest are pending", async () => {
    mockJudge.mockImplementation(async (_s: string, questions: Record<string, unknown>) => ({
      model: "jev",
      answers: Object.fromEntries(
        Object.keys(questions).map((k) => [k, { type: "choice", choice: "message", confidence: 1, probabilities: { message: 1 } }])
      ),
      usage: { inputTokens: 10, outputTokens: 0 },
    }));
    const total = MAX_JUDGED_PER_READ + 3;
    const inputs = Array.from({ length: total }, (_, i) => msg(`m${i}`, `Line ${i}\n--\nsig`)); // oldest first

    const out = await cleanBodies(ORG, inputs, IDENTITY);

    expect(mockJudge).toHaveBeenCalledTimes(MAX_JUDGED_PER_READ);
    expect([0, 1, 2].map((i) => out.get(`m${i}`))).toEqual([
      { text: "Line 0", status: "pending" },
      { text: "Line 1", status: "pending" },
      { text: "Line 2", status: "pending" },
    ]);
    expect(out.get(`m${total - 1}`)?.status).toBe("cleaned");
  });

  it("does not judge unreadable bodies", async () => {
    const out = await cleanBodies(ORG, [msg("m1", null, false), msg("m2", "", true)], IDENTITY);
    expect(out.get("m1")).toEqual({ text: null, status: "not_applicable" });
    expect(out.get("m2")).toEqual({ text: "", status: "not_applicable" });
    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("toUnits / buildJudgment", () => {
  it("asks one choice question per line, every kind offered, the line quoted in the question", () => {
    const units = toUnits(structureBody("Hi Jane,\nYes.\n\nBest,\nBob"));
    const { state, questions } = buildJudgment("Re: deck", units);
    expect(Object.keys(questions)).toEqual(["u1", "u2", "u3", "u4"]);
    expect(questions.u2.instructions).toContain('"Yes."');
    expect(questions.u2.criteria).toEqual(LINE_KINDS);
    expect(state).toContain("Email subject: Re: deck");
    expect(state).toContain("[4] Bob");
  });

  it("falls back to paragraphs, then merged paragraphs, to stay within MAX_UNITS questions", () => {
    const manyLines = Array.from({ length: MAX_UNITS + 5 }, (_, i) => `line ${i}`).join("\n");
    expect(toUnits(structureBody(manyLines))).toHaveLength(1); // one paragraph

    const manyParagraphs = Array.from({ length: MAX_UNITS * 2 + 1 }, (_, i) => `para ${i}\nmore ${i}`).join("\n\n");
    const units = toUnits(structureBody(manyParagraphs));
    expect(units.length).toBeLessThanOrEqual(MAX_UNITS);
    expect(units.flatMap((u) => u.lines)).toHaveLength((MAX_UNITS * 2 + 1) * 2);
  });
});
