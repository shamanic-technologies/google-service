import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "test-google-service-key",
  },
}));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

import { getConversation } from "../services/conversation";

const ORG = "00000000-0000-4000-a000-000000000001";
const OTHER_ORG = "00000000-0000-4000-a000-0000000000ff";
const PROSPECT = "prospect@acme.com";
const OWNER = "owner@ourbrand.com";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

const rawRow = (over: Record<string, unknown>) => ({
  gmail_message_id: "m1",
  thread_id: "t1",
  payload: { payload: { mimeType: "text/plain", body: { data: b64("hello") } } },
  fetched_at: new Date("2026-01-01T00:00:00Z"),
  from_email: OWNER,
  from_name: "Owner",
  to_emails: [PROSPECT],
  subject: "Quick question",
  snippet: "hello",
  sent_at: new Date("2026-01-01T00:00:00Z"),
  labels: ["SENT"],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getConversation", () => {
  it("returns no_google_account_connected when the org has connected no mailbox", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await getConversation(ORG, PROSPECT);

    expect(res).toEqual({ found: false, reason: "no_google_account_connected" });
  });

  it("returns no_messages when nobody has this exchange", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] }) // accounts
      .mockResolvedValueOnce({ rows: [] }); // silver participant match

    const res = await getConversation(ORG, PROSPECT);

    expect(res).toEqual({ found: false, reason: "no_messages" });
  });

  it("returns the whole thread, both directions, oldest first, with readable bodies", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({
        // Query returns newest-first; the service reverses to oldest-first.
        rows: [
          rawRow({
            gmail_message_id: "m3",
            sent_at: new Date("2026-01-03T00:00:00Z"),
            payload: { payload: { mimeType: "text/plain", body: { data: b64("Sending it now.") } } },
          }),
          rawRow({
            gmail_message_id: "m2",
            from_email: PROSPECT,
            to_emails: [OWNER],
            sent_at: new Date("2026-01-02T00:00:00Z"),
            payload: { payload: { mimeType: "text/plain", body: { data: b64("Yes, send the deck.") } } },
          }),
          rawRow({
            gmail_message_id: "m1",
            sent_at: new Date("2026-01-01T00:00:00Z"),
            payload: { payload: { mimeType: "text/plain", body: { data: b64("Are you the right person?") } } },
          }),
        ],
      });

    const res = await getConversation(ORG, PROSPECT);
    expect(res.found).toBe(true);
    if (!res.found) return;

    const c = res.conversation;
    expect(c.address).toBe(PROSPECT);
    expect(c.status).toBe("ok");
    expect(c.threadCount).toBe(1);
    expect(c.messageCount).toBe(3);
    expect(c.truncated).toBe(false);

    const msgs = c.threads[0].messages;
    expect(msgs.map((m) => m.gmailMessageId)).toEqual(["m1", "m2", "m3"]);
    expect(msgs.map((m) => m.direction)).toEqual(["outbound", "inbound", "outbound"]);
    expect(msgs[1].bodyText).toBe("Yes, send the deck.");
    expect(msgs[1].bodyStatus).toBe("ok");
    expect(c.threads[0].firstMessageAt).toBe("2026-01-01T00:00:00.000Z");
    expect(c.threads[0].lastMessageAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("scopes every query to the caller's org", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({ rows: [rawRow({})] });

    await getConversation(ORG, PROSPECT);

    for (const call of mockQuery.mock.calls) {
      expect(call[0]).toContain("org_id = $1");
      expect((call[1] as unknown[])[0]).toBe(ORG);
      expect(call[1]).not.toContain(OTHER_ORG);
    }
  });

  it("marks the conversation unreadable when no message body can be read", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({
        rows: [
          rawRow({
            payload: { payload: { mimeType: "text/plain", body: { attachmentId: "att-1" } } },
          }),
        ],
      });

    const res = await getConversation(ORG, PROSPECT);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.conversation.status).toBe("unreadable");
    expect(res.conversation.threads[0].messages[0].bodyStatus).toBe("unavailable");
    expect(res.conversation.threads[0].messages[0].bodyText).toBeNull();
  });

  it("distinguishes an EMPTY message from an unreadable one", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({
        rows: [
          rawRow({
            gmail_message_id: "m1",
            payload: { payload: { mimeType: "text/plain", body: { data: b64("") } } },
          }),
          rawRow({
            gmail_message_id: "m2",
            sent_at: new Date("2026-01-02T00:00:00Z"),
            payload: { payload: { mimeType: "text/plain", body: { attachmentId: "a" } } },
          }),
        ],
      });

    const res = await getConversation(ORG, PROSPECT);
    expect(res.found).toBe(true);
    if (!res.found) return;
    const statuses = res.conversation.threads[0].messages.map((m) => m.bodyStatus);
    expect(statuses).toContain("empty");
    expect(statuses).toContain("unavailable");
    expect(res.conversation.status).toBe("partial");
  });

  it("matches a Cc-only correspondent from the index, never by scanning bronze payloads", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [{ thread_id: "t7" }] })
      .mockResolvedValueOnce({ rows: [rawRow({ thread_id: "t7" })] });

    const res = await getConversation(ORG, PROSPECT);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.conversation.threads[0].threadId).toBe("t7");
    expect(mockQuery.mock.calls[1][0]).toContain("cc_emails ? $2");
  });

  it("never scans the bronze payloads when nobody has the exchange", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await getConversation(ORG, PROSPECT);

    expect(res).toEqual({ found: false, reason: "no_messages" });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    for (const call of mockQuery.mock.calls) {
      expect(call[0]).not.toContain("payload::text ILIKE");
    }
  });

  it("keeps the most recent messages and flags truncation past the limit", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({
        rows: [
          rawRow({ gmail_message_id: "new", sent_at: new Date("2026-01-05T00:00:00Z") }),
          rawRow({ gmail_message_id: "old", sent_at: new Date("2026-01-01T00:00:00Z") }),
        ],
      });

    const res = await getConversation(ORG, PROSPECT, 1);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.conversation.truncated).toBe(true);
    expect(res.conversation.messageCount).toBe(1);
    expect(res.conversation.threads[0].messages[0].gmailMessageId).toBe("new");
  });

  it("groups several threads, oldest thread first", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }, { thread_id: "t2" }] })
      .mockResolvedValueOnce({
        rows: [
          rawRow({ gmail_message_id: "b", thread_id: "t2", sent_at: new Date("2026-02-01T00:00:00Z") }),
          rawRow({ gmail_message_id: "a", thread_id: "t1", sent_at: new Date("2026-01-01T00:00:00Z") }),
        ],
      });

    const res = await getConversation(ORG, PROSPECT);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.conversation.threads.map((t) => t.threadId)).toEqual(["t1", "t2"]);
  });

  it("lowercases the requested address before matching", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await getConversation(ORG, "  Prospect@ACME.com ");

    expect(mockQuery.mock.calls[1][1]).toEqual([ORG, PROSPECT]);
  });
});
