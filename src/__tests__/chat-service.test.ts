import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../env", () => ({
  env: { CHAT_SERVICE_URL: "http://chat.test", CHAT_SERVICE_API_KEY: "chat-key" },
}));

import { judgeChoices } from "../services/chat-service";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const Q = { u1: { type: "choice" as const, instructions: "What is line 1?", criteria: { message: "m", footer: "f" } } };
const ID = { orgId: "o", userId: "u", runId: "r", brandId: "b", featureSlug: "f" };

describe("judgeChoices", () => {
  it("calls the org-billed judgments route with the caller's identity and tracking headers", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "jev",
          answers: { u1: { type: "choice", choice: "message", confidence: 1, probabilities: { message: 1, footer: 0 } } },
          usage: { inputTokens: 5, outputTokens: 1 },
        }),
        { status: 200 }
      )
    );

    const res = await judgeChoices("state", Q, ID);

    expect(res.answers.u1.choice).toBe("message");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://chat.test/orgs/judgments");
    expect(init.headers).toMatchObject({
      "x-api-key": "chat-key",
      "x-org-id": "o",
      "x-user-id": "u",
      "x-run-id": "r",
      "x-brand-id": "b",
      "x-feature-slug": "f",
    });
    expect(JSON.parse(init.body)).toEqual({ state: "state", questions: Q });
  });

  it("fails loud on a non-2xx answer", async () => {
    fetchMock.mockResolvedValue(new Response("insufficient balance", { status: 402 }));
    await expect(judgeChoices("state", Q, ID)).rejects.toThrow(/402 insufficient balance/);
  });

  it("fails loud when an asked question has no answer", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ model: "jev", answers: {}, usage: { inputTokens: 1, outputTokens: 0 } }), { status: 200 })
    );
    await expect(judgeChoices("state", Q, ID)).rejects.toThrow(/u1/);
  });
});
