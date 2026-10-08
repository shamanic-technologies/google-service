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

// The cleaner has its own suite (body-clean.test.ts); here it is a stand-in that
// marks each readable body cleaned, so the wiring is what is tested.
const { mockCleanBodies } = vi.hoisted(() => ({ mockCleanBodies: vi.fn() }));
vi.mock("../services/body-clean", () => ({
  cleanBodies: (...args: unknown[]) => mockCleanBodies(...args),
}));

import { getConversation, getStaffConversation } from "../services/conversation";

const IDENTITY = {
  orgId: "00000000-0000-4000-a000-000000000001",
  userId: "00000000-0000-4000-a000-000000000002",
  runId: "00000000-0000-4000-a000-000000000003",
};

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
  mockCleanBodies.mockImplementation(
    async (_org: string, inputs: { gmailMessageId: string; text: string | null; readable: boolean }[]) =>
      new Map(
        inputs.map((m) => [
          m.gmailMessageId,
          m.readable ? { text: `clean:${m.text}`, status: "cleaned" } : { text: m.text, status: "not_applicable" },
        ])
      )
  );
});

describe("getConversation", () => {
  it("returns no_google_account_connected when the org has connected no mailbox", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await getConversation(ORG, PROSPECT, IDENTITY);

    expect(res).toEqual({ found: false, reason: "no_google_account_connected" });
  });

  it("returns no_messages when nobody has this exchange", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] }) // accounts
      .mockResolvedValueOnce({ rows: [] }) // send-as aliases (SENT senders)
      .mockResolvedValueOnce({ rows: [] }); // silver participant match

    const res = await getConversation(ORG, PROSPECT, IDENTITY);

    expect(res).toEqual({ found: false, reason: "no_messages" });
  });

  it("returns the whole thread, both directions, oldest first, with readable bodies", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] }) // send-as aliases (SENT senders)
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

    const res = await getConversation(ORG, PROSPECT, IDENTITY);
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
    expect(msgs[1].bodyText).toBe("clean:Yes, send the deck.");
    expect(msgs[1].bodyTextOriginal).toBe("Yes, send the deck.");
    expect(msgs[1].bodyCleanStatus).toBe("cleaned");
    expect(msgs[1].bodyStatus).toBe("ok");
    // Cleaned for THIS org, billed on the caller's identity.
    expect(mockCleanBodies).toHaveBeenCalledTimes(1);
    expect(mockCleanBodies.mock.calls[0][0]).toBe(ORG);
    expect(mockCleanBodies.mock.calls[0][2]).toEqual(IDENTITY);
    expect(c.threads[0].firstMessageAt).toBe("2026-01-01T00:00:00.000Z");
    expect(c.threads[0].lastMessageAt).toBe("2026-01-03T00:00:00.000Z");
  });

  it("scopes every query to the caller's org", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] }) // send-as aliases (SENT senders)
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({ rows: [rawRow({})] });

    await getConversation(ORG, PROSPECT, IDENTITY);

    for (const call of mockQuery.mock.calls) {
      expect(call[0]).toContain("org_id = $1");
      expect((call[1] as unknown[])[0]).toBe(ORG);
      expect(call[1]).not.toContain(OTHER_ORG);
    }
  });

  it("marks the conversation unreadable when no message body can be read", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] }) // send-as aliases (SENT senders)
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({
        rows: [
          rawRow({
            payload: { payload: { mimeType: "text/plain", body: { attachmentId: "att-1" } } },
          }),
        ],
      });

    const res = await getConversation(ORG, PROSPECT, IDENTITY);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.conversation.status).toBe("unreadable");
    expect(res.conversation.threads[0].messages[0].bodyStatus).toBe("unavailable");
    expect(res.conversation.threads[0].messages[0].bodyText).toBeNull();
  });

  it("distinguishes an EMPTY message from an unreadable one", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] }) // send-as aliases (SENT senders)
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

    const res = await getConversation(ORG, PROSPECT, IDENTITY);
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
      .mockResolvedValueOnce({ rows: [] }) // send-as aliases (SENT senders)
      .mockResolvedValueOnce({ rows: [{ thread_id: "t7" }] })
      .mockResolvedValueOnce({ rows: [rawRow({ thread_id: "t7" })] });

    const res = await getConversation(ORG, PROSPECT, IDENTITY);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.conversation.threads[0].threadId).toBe("t7");
    expect(mockQuery.mock.calls[2][0]).toContain("cc_emails ? $2");
  });

  it("never scans the bronze payloads when nobody has the exchange", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] }) // send-as aliases (SENT senders)
      .mockResolvedValueOnce({ rows: [] });

    const res = await getConversation(ORG, PROSPECT, IDENTITY);

    expect(res).toEqual({ found: false, reason: "no_messages" });
    expect(mockQuery).toHaveBeenCalledTimes(3);
    for (const call of mockQuery.mock.calls) {
      expect(call[0]).not.toContain("payload::text ILIKE");
    }
  });

  it("keeps the most recent messages and flags truncation past the limit", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] }) // send-as aliases (SENT senders)
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({
        rows: [
          rawRow({ gmail_message_id: "new", sent_at: new Date("2026-01-05T00:00:00Z") }),
          rawRow({ gmail_message_id: "old", sent_at: new Date("2026-01-01T00:00:00Z") }),
        ],
      });

    const res = await getConversation(ORG, PROSPECT, IDENTITY, 1);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.conversation.truncated).toBe(true);
    expect(res.conversation.messageCount).toBe(1);
    expect(res.conversation.threads[0].messages[0].gmailMessageId).toBe("new");
  });

  it("groups several threads, oldest thread first", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] }) // send-as aliases (SENT senders)
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }, { thread_id: "t2" }] })
      .mockResolvedValueOnce({
        rows: [
          rawRow({ gmail_message_id: "b", thread_id: "t2", sent_at: new Date("2026-02-01T00:00:00Z") }),
          rawRow({ gmail_message_id: "a", thread_id: "t1", sent_at: new Date("2026-01-01T00:00:00Z") }),
        ],
      });

    const res = await getConversation(ORG, PROSPECT, IDENTITY);
    expect(res.found).toBe(true);
    if (!res.found) return;
    expect(res.conversation.threads.map((t) => t.threadId)).toEqual(["t1", "t2"]);
  });

  it("lowercases the requested address before matching", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] })
      .mockResolvedValueOnce({ rows: [] }) // send-as aliases (SENT senders)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await getConversation(ORG, "  Prospect@ACME.com ", IDENTITY);

    expect(mockQuery.mock.calls[2][1]).toEqual([ORG, PROSPECT]);
  });
  it("labels a reply sent from a send-as alias (a SENT sender) outbound, like the correspondents read", async () => {
    const ALIAS = "kevin@distribute.you";
    mockQuery.mockReset(); // an earlier test's unconsumed once-value must not leak in
    mockQuery
      .mockResolvedValueOnce({ rows: [{ email: OWNER }] }) // connected account
      .mockResolvedValueOnce({ rows: [{ email: ALIAS }] }) // send-as alias seen on SENT mail
      .mockResolvedValueOnce({ rows: [{ thread_id: "t1" }] })
      .mockResolvedValueOnce({
        rows: [
          rawRow({ gmail_message_id: "m3", from_email: "someone@else.com", sent_at: new Date("2026-01-03T00:00:00Z") }),
          rawRow({ gmail_message_id: "m2", from_email: "Kevin@Distribute.you", sent_at: new Date("2026-01-02T00:00:00Z") }),
          rawRow({ gmail_message_id: "m1", from_email: PROSPECT, to_emails: [ALIAS], labels: ["INBOX"], sent_at: new Date("2026-01-01T00:00:00Z") }),
        ],
      });

    const res = await getConversation(ORG, PROSPECT, IDENTITY);
    expect(res.found).toBe(true);
    if (!res.found) return;

    expect(res.conversation.threads[0].messages.map((m) => [m.gmailMessageId, m.direction])).toEqual([
      ["m1", "inbound"],
      ["m2", "outbound"],
      ["m3", "other"],
    ]);
    // The alias came from the SENT-labelled read of this org's silver.
    expect(mockQuery.mock.calls[1][0]).toContain("labels ? 'SENT'");
    expect(mockQuery.mock.calls[1][1]).toEqual([ORG]);
  });
});

describe("getStaffConversation", () => {
  const STAFF = "kevin@distribute.you";
  const STAFF_ACCOUNT = "00000000-0000-4000-a000-0000000000aa";

  // clearAllMocks keeps queued once-values; an unconsumed one from an earlier test must not leak.
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("answers no_staff_mailbox_connected when no staff mailbox is mirrored", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    expect(await getStaffConversation(PROSPECT)).toEqual({
      found: false,
      reason: "no_staff_mailbox_connected",
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("reads ONLY staff mailboxes, looked up by their staff address", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getStaffConversation(PROSPECT);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("lower(google_account_email) = ANY($1::text[])");
    expect(params[0]).toEqual(["kevin.lourd@gmail.com", "kevin@distribute.you"]);
  });

  it("filters to messages BETWEEN staff and the person, in SQL, never the whole thread", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: STAFF_ACCOUNT, org_id: OTHER_ORG }] })
      .mockResolvedValueOnce({ rows: [] });

    expect(await getStaffConversation("  Prospect@Acme.com ")).toEqual({
      found: false,
      reason: "no_messages",
    });

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("s.google_account_id = ANY($2::uuid[])");
    expect(sql).toContain(
      "(lower(s.from_email) = ANY($3::text[]) AND (s.to_emails ? $4 OR s.cc_emails ? $4))"
    );
    expect(sql).toContain(
      "(lower(s.from_email) = $4 AND (s.to_emails ?| $3::text[] OR s.cc_emails ?| $3::text[]))"
    );
    // No thread expansion: the thread id is never used as a filter.
    expect(sql).not.toContain("thread_id = ANY");
    expect(sql).not.toContain("payload::text ILIKE");
    expect(params).toEqual([
      [OTHER_ORG],
      [STAFF_ACCOUNT],
      ["kevin.lourd@gmail.com", "kevin@distribute.you"],
      PROSPECT,
      201,
    ]);
  });

  it("labels staff messages outbound and the person's inbound, oldest first", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: STAFF_ACCOUNT, org_id: OTHER_ORG }] })
      .mockResolvedValueOnce({
        rows: [
          rawRow({
            gmail_message_id: "k2",
            from_email: STAFF,
            to_emails: [PROSPECT],
            sent_at: new Date("2026-09-21T19:07:27Z"),
            payload: { payload: { mimeType: "text/plain", body: { data: b64("(Ignore that last email)") } } },
          }),
          rawRow({
            gmail_message_id: "p1",
            from_email: PROSPECT,
            to_emails: [STAFF],
            sent_at: new Date("2026-09-21T16:00:00Z"),
          }),
          rawRow({
            gmail_message_id: "k1",
            from_email: "Kevin@Distribute.you",
            to_emails: [PROSPECT],
            sent_at: new Date("2026-09-21T15:40:41Z"),
            payload: { payload: { mimeType: "text/plain", body: { data: b64("Hi Jamie, Kevin taking over here.") } } },
          }),
        ],
      });

    const res = await getStaffConversation(PROSPECT);
    expect(res.found).toBe(true);
    if (!res.found) return;
    const msgs = res.conversation.threads[0].messages;
    expect(msgs.map((m) => m.gmailMessageId)).toEqual(["k1", "p1", "k2"]);
    expect(msgs.map((m) => m.direction)).toEqual(["outbound", "inbound", "outbound"]);
    expect(msgs[0].bodyText).toBe("Hi Jamie, Kevin taking over here.");
    // The staff read does not clean: no judgment, original served as is.
    expect(msgs[0].bodyTextOriginal).toBe("Hi Jamie, Kevin taking over here.");
    expect(msgs[0].bodyCleanStatus).toBe("not_cleaned");
    expect(mockCleanBodies).not.toHaveBeenCalled();
    expect(res.conversation.truncated).toBe(false);
  });
});
