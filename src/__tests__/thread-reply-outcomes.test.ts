// LEDGER-HISTORY-1024, on a REAL Postgres (PGlite, the real migration): a Gmail
// thread reply we sent is recorded once and declared to runs-service as ONE
// message_sent of its lead (consuming message_written + email_checked), dated
// when it was sent, on the run that sent it. A reply without a lead id is never
// declared. Replays write nothing twice.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../env", () => ({
  env: { RUNS_SERVICE_URL: "http://runs.test", RUNS_SERVICE_API_KEY: "r" },
}));

vi.mock("../db/client", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const query = async (sql: string, params?: unknown[]) => {
    if (!params || params.length === 0) {
      const rs = await db.exec(sql);
      const last = rs[rs.length - 1] ?? { rows: [], affectedRows: 0 };
      return { rows: last.rows as Record<string, unknown>[], rowCount: last.affectedRows ?? 0 };
    }
    const r = await db.query(sql, params);
    return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool, query };
});

import { runMigrations } from "../db/migrate";
import { query } from "../db/client";
import {
  recordThreadReplySend,
  declarePendingThreadReplyOutcomes,
  classifyBatchAnswer,
} from "../services/thread-reply-outcomes";

const ORG = "f0420eb5-8f72-4f0a-a150-f473746df1e6";
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const RUN_C = "33333333-3333-4333-8333-333333333333";
const LEAD = "8c1f0b7e-2f43-4c3e-9a51-6f7b1f2d9e10";

const send = (gmailMessageId: string, runId: string, leadId: string | null, sentAt: string) =>
  recordThreadReplySend({
    orgId: ORG,
    gmailMessageId,
    threadId: "t1",
    mailbox: "kevin.lourd@gmail.com",
    from: "kevin.lourd@gmail.com",
    to: "p@x.com",
    runId,
    leadId,
    sentAt: new Date(sentAt),
  });

const fetchMock = vi.fn();

beforeAll(async () => {
  await runMigrations();
  vi.stubGlobal("fetch", fetchMock);
}, 60_000);

beforeEach(async () => {
  fetchMock.mockReset();
  await query("DELETE FROM gmail_thread_reply_sends");
});

describe("thread-reply outcomes", () => {
  it("declares one message_sent per reply on its run, dated when it was sent, and never twice", async () => {
    await send("m1", RUN_A, LEAD, "2026-10-16T13:17:19.000Z");
    await send("m1", RUN_A, LEAD, "2026-10-16T13:17:19.000Z"); // replay: one row
    await send("m2", RUN_B, null, "2026-10-17T10:00:00.000Z"); // no lead: never declared
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ recordedCount: 3 }), { status: 201 }));

    const s = await declarePendingThreadReplyOutcomes();
    expect(s).toMatchObject({ pending: 1, declared: 1, retry: 0 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://runs.test/v1/platform-runs/outcomes/batch");
    expect(init.headers["x-service-name"]).toBe("google");
    const subject = { subjectService: "lead-service", subjectId: LEAD };
    expect(JSON.parse(init.body)).toEqual({
      runs: [
        {
          runId: RUN_A,
          produced: [{ outcomeKey: "message_sent", ...subject }],
          consumed: [
            { outcomeKey: "message_written", ...subject },
            { outcomeKey: "email_checked", ...subject },
          ],
          occurredAt: "2026-10-16T13:17:19.000Z",
        },
      ],
    });

    const again = await declarePendingThreadReplyOutcomes();
    expect(again.pending).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const rows = await query("SELECT gmail_message_id, outcomes_declaration FROM gmail_thread_reply_sends ORDER BY 1");
    expect(rows.rows).toEqual([
      { gmail_message_id: "m1", outcomes_declaration: "declared" },
      { gmail_message_id: "m2", outcomes_declaration: null },
    ]);
  });

  it("a runs-service outage leaves the rows to the next tick", async () => {
    await send("m3", RUN_C, LEAD, "2026-10-18T09:00:00.000Z");
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    expect(await declarePendingThreadReplyOutcomes()).toMatchObject({ pending: 1, retry: 1, declared: 0 });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await declarePendingThreadReplyOutcomes()).toMatchObject({ pending: 1, declared: 1 });
  });

  it("422 invalid_runs: a gone run is marked, a refused run is marked, an unlisted run retries", () => {
    const body = JSON.stringify({
      error: "invalid_runs",
      details: { invalid: [{ runId: RUN_A, reason: "run_not_found" }, { runId: RUN_B, reason: "run_outcomes_voided" }] },
    });
    const m = classifyBatchAnswer(422, body, [RUN_A, RUN_B, RUN_C]);
    expect(Object.fromEntries(m)).toEqual({ [RUN_A]: "run_gone", [RUN_B]: "refused", [RUN_C]: "retry" });
    expect(classifyBatchAnswer(400, '{"error":"unknown_outcome_key"}', [RUN_A]).get(RUN_A)).toBe("retry");
  });
});
