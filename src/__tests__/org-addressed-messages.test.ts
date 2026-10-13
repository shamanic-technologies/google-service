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

import { getOrgAddressedMessages } from "../services/org-addressed-messages";
import { encodeCursor } from "../services/addressed-messages";

const ORG = "00000000-0000-4000-a000-0000000000c1";
const ACCOUNT = "00000000-0000-4000-a000-0000000000a1";
const OWNER = "jane@clientco.com";
const ALIAS = "sales@clientco.com";
const PROSPECT = "bob@prospect.io";
const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

const silverRow = (over: Record<string, unknown>) => ({
  id: "20000000-0000-4000-a000-000000000001",
  google_account_id: ACCOUNT,
  org_id: ORG,
  gmail_message_id: "g1",
  thread_id: "t1",
  from_email: PROSPECT,
  from_name: "Bob",
  to_emails: [OWNER],
  cc_emails: [],
  subject: "Re: intro",
  sent_at: new Date("2026-10-12T10:00:00Z"),
  labels: ["INBOX"],
  ...over,
});

const connected = () =>
  mockQuery
    .mockResolvedValueOnce({ rows: [{ id: ACCOUNT, email: OWNER }] }) // org accounts
    .mockResolvedValueOnce({ rows: [{ email: OWNER }] }) // owner: accounts
    .mockResolvedValueOnce({ rows: [{ email: ALIAS }] }); // owner: send-as aliases

beforeEach(() => mockQuery.mockReset());

describe("getOrgAddressedMessages", () => {
  it("answers no_google_account_connected when the org connected no mailbox", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getOrgAddressedMessages(ORG, { addresses: [PROSPECT] })).toEqual({
      found: false,
      reason: "no_google_account_connected",
    });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE org_id = $1");
    expect(params).toEqual([ORG]);
  });

  it("scopes the read to the caller's org in SQL, index-carried, with since", async () => {
    connected().mockResolvedValueOnce({ rows: [] });
    const res = await getOrgAddressedMessages(ORG, { addresses: [" Bob@Prospect.io "], since: "2026-10-01T00:00:00Z" });
    expect(res).toEqual({
      found: true,
      page: { mailboxes: [OWNER], ownerAddresses: [OWNER, ALIAS].sort(), ignoredAddresses: [], messages: [], nextCursor: null },
    });
    const [sql, params] = mockQuery.mock.calls[3] as [string, unknown[]];
    expect(sql).toContain("s.org_id = $1");
    expect(sql).toContain("s.from_email = ANY($2::text[]) OR s.to_emails ?| $2::text[] OR s.cc_emails ?| $2::text[]");
    expect(sql).toContain("s.sent_at >= $4::timestamptz");
    expect(sql).not.toContain("payload");
    expect(params).toEqual([ORG, [PROSPECT], null, "2026-10-01T00:00:00Z", null, 201]);
  });

  it("drops a requested address that is one of the org's own (never the whole mailbox)", async () => {
    connected();
    const res = await getOrgAddressedMessages(ORG, { addresses: [OWNER.toUpperCase(), ALIAS] });
    if (!res.found) throw new Error("expected found");
    expect(res.page.ignoredAddresses).toEqual([OWNER, ALIAS]);
    expect(res.page.messages).toEqual([]);
    // No message query was ever run.
    expect(mockQuery).toHaveBeenCalledTimes(3);

    connected().mockResolvedValueOnce({ rows: [] });
    await getOrgAddressedMessages(ORG, { addresses: [ALIAS, PROSPECT] });
    expect((mockQuery.mock.calls[6] as [string, unknown[]])[1][1]).toEqual([PROSPECT]);
  });

  it("labels both directions, serves RFC ids + automation + body, and pages with a cursor", async () => {
    const inbound = silverRow({});
    const outbound = silverRow({
      id: "20000000-0000-4000-a000-000000000002",
      gmail_message_id: "g2",
      from_email: ALIAS,
      to_emails: [PROSPECT],
      labels: ["SENT"],
    });
    const third = silverRow({ id: "20000000-0000-4000-a000-000000000003", gmail_message_id: "g3" });
    connected()
      .mockResolvedValueOnce({ rows: [inbound, outbound, third] })
      .mockResolvedValueOnce({
        rows: [
          {
            org_id: ORG,
            gmail_message_id: "g1",
            payload: {
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "Message-ID", value: "<r1@prospect.io>" },
                  { name: "In-Reply-To", value: "<o1@clientco.com>" },
                  { name: "References", value: "<o0@clientco.com> <o1@clientco.com>" },
                  { name: "Auto-Submitted", value: "auto-replied" },
                ],
                body: { data: b64("Out of office") },
              },
            },
          },
        ],
      });

    const res = await getOrgAddressedMessages(ORG, { addresses: [PROSPECT], limit: 2 });
    if (!res.found) throw new Error("expected found");
    const [m1, m2] = res.page.messages;
    expect(res.page.messages).toHaveLength(2);
    expect(res.page.nextCursor).toBe(encodeCursor(outbound.id));
    expect(m1).toMatchObject({
      id: `${OWNER}:g1`,
      mailbox: OWNER,
      direction: "inbound",
      messageId: "<r1@prospect.io>",
      inReplyTo: "<o1@clientco.com>",
      references: ["<o0@clientco.com>", "<o1@clientco.com>"],
      matchedAddresses: [PROSPECT],
      matchedRecipients: [],
      bodyText: "Out of office",
      bodyStatus: "ok",
    });
    expect(m1.automation.autoSubmitted).toBe("auto-replied");
    expect(m2).toMatchObject({ direction: "outbound", matchedAddresses: [PROSPECT], matchedRecipients: [PROSPECT] });

    connected().mockResolvedValueOnce({ rows: [] });
    await getOrgAddressedMessages(ORG, { addresses: [PROSPECT], cursor: res.page.nextCursor! });
    expect((mockQuery.mock.calls[8] as [string, unknown[]])[1][2]).toBe(outbound.id);
  });

  it("labels a third party writing with the prospect in Cc as other", async () => {
    connected()
      .mockResolvedValueOnce({ rows: [silverRow({ from_email: "assistant@prospect.io", to_emails: [OWNER], cc_emails: [PROSPECT] })] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await getOrgAddressedMessages(ORG, { addresses: [PROSPECT] });
    if (!res.found) throw new Error("expected found");
    expect(res.page.messages[0]).toMatchObject({ direction: "other", matchedAddresses: [PROSPECT], bodyStatus: expect.any(String) });
  });
});
