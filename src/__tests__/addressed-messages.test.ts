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

import {
  getAddressedMessages,
  normalizeFilter,
  parseMessageIdList,
  encodeCursor,
  AddressedMessagesInputError,
} from "../services/addressed-messages";

const STAFF_ACCOUNT = "00000000-0000-4000-a000-0000000000aa";
const STAFF_ORG = "00000000-0000-4000-a000-0000000000ff";
const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

const silverRow = (over: Record<string, unknown>) => ({
  id: "10000000-0000-4000-a000-000000000001",
  google_account_id: STAFF_ACCOUNT,
  org_id: STAFF_ORG,
  gmail_message_id: "g1",
  thread_id: "t1",
  from_email: "laura@fusionmedcare.com",
  from_name: "Laura",
  to_emails: ["klourd@pressbeat.ai"],
  cc_emails: [],
  subject: "Re: Shockwave equipment costs",
  sent_at: new Date("2026-08-18T16:42:16Z"),
  labels: ["INBOX"],
  ...over,
});

const payload = (headers: Record<string, string>, text: string) => ({
  id: "g1",
  payload: {
    mimeType: "text/plain",
    headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
    body: { data: b64(text) },
  },
});

beforeEach(() => {
  mockQuery.mockReset();
});

describe("normalizeFilter", () => {
  it("lower-cases, trims, dedupes, and strips a leading @ from domains", () => {
    expect(normalizeFilter({ addresses: [" KLourd@Pressbeat.ai", "klourd@pressbeat.ai"], domains: ["@GrowthAgency.ch"] })).toEqual({
      addresses: ["klourd@pressbeat.ai"],
      domains: ["growthagency.ch"],
    });
  });

  it("refuses an empty filter, a staff address, and a staff mailbox domain (never a general mailbox search)", () => {
    expect(() => normalizeFilter({})).toThrow(AddressedMessagesInputError);
    expect(() => normalizeFilter({ addresses: ["kevin.lourd@gmail.com"] })).toThrow(/staff address/);
    expect(() => normalizeFilter({ domains: ["gmail.com"] })).toThrow(/staff mailbox domain/);
    expect(() => normalizeFilter({ domains: ["distribute.you"] })).toThrow(/staff mailbox domain/);
  });
});

describe("parseMessageIdList", () => {
  it("extracts bracketed ids from a folded References header", () => {
    expect(parseMessageIdList("<a@x.com>\r\n <b@y.com> <c@z>")).toEqual(["<a@x.com>", "<b@y.com>", "<c@z>"]);
    expect(parseMessageIdList(null)).toEqual([]);
    expect(parseMessageIdList("bare@id")).toEqual(["bare@id"]);
  });
});

describe("getAddressedMessages", () => {
  it("answers no_staff_mailbox_connected when no staff mailbox is mirrored", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getAddressedMessages({ domains: ["pressbeat.ai"] })).toEqual({
      found: false,
      reason: "no_staff_mailbox_connected",
    });
  });

  it("reads only staff mailboxes and filters To/Cc OR From on the requested set, in SQL", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: STAFF_ACCOUNT, org_id: STAFF_ORG, email: "kevin.lourd@gmail.com" }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await getAddressedMessages({
      addresses: ["klourd@pressbeat.ai"],
      domains: ["growthagency.ch"],
      since: "2026-08-01T00:00:00Z",
    });
    expect(res).toEqual({ found: true, page: { mailboxes: ["kevin.lourd@gmail.com"], messages: [], nextCursor: null } });

    const [accSql, accParams] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(accSql).toContain("lower(google_account_email) = ANY($1::text[])");
    expect(accParams[0]).toEqual(["kevin.lourd@gmail.com", "kevin@distribute.you"]);

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("s.google_account_id = ANY($2::uuid[])");
    expect(sql).toContain("s.from_email = ANY($3::text[])");
    expect(sql).toContain("jsonb_array_elements_text(s.to_emails || s.cc_emails)");
    expect(sql).toContain("ORDER BY s.id");
    expect(sql).not.toContain("payload");
    expect(params).toEqual([
      [STAFF_ORG],
      [STAFF_ACCOUNT],
      ["klourd@pressbeat.ai"],
      ["growthagency.ch"],
      null,
      "2026-08-01T00:00:00Z",
      null,
      201,
    ]);
  });

  it("serves threading ids, automation markers, direction and text; pages with an opaque cursor", async () => {
    const r1 = silverRow({});
    const r2 = silverRow({
      id: "10000000-0000-4000-a000-000000000002",
      gmail_message_id: "g2",
      from_email: "klourd@pressbeat.ai",
      to_emails: ["laura@fusionmedcare.com"],
    });
    const r3 = silverRow({ id: "10000000-0000-4000-a000-000000000003", gmail_message_id: "g3" });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: STAFF_ACCOUNT, org_id: STAFF_ORG, email: "kevin.lourd@gmail.com" }] })
      .mockResolvedValueOnce({ rows: [r1, r2, r3] })
      .mockResolvedValueOnce({
        rows: [
          {
            org_id: STAFF_ORG,
            gmail_message_id: "g1",
            payload: payload(
              {
                "Message-ID": "<reply-1@mail.fusionmedcare.com>",
                "In-Reply-To": "<ours-1@pressbeat.ai>",
                References: "<ours-0@pressbeat.ai>\r\n <ours-1@pressbeat.ai>",
                "Auto-Submitted": "no",
              },
              "Open to learn more"
            ),
          },
          { org_id: STAFF_ORG, gmail_message_id: "g2", payload: payload({ "Message-ID": "<ans@pressbeat.ai>" }, "Great") },
        ],
      });

    const res = await getAddressedMessages({ domains: ["pressbeat.ai"], limit: 2 });
    if (!res.found) throw new Error("expected found");
    const [m1, m2] = res.page.messages;

    expect(res.page.messages).toHaveLength(2);
    expect(res.page.nextCursor).toBe(encodeCursor(r2.id));
    expect(m1).toMatchObject({
      id: "kevin.lourd@gmail.com:g1",
      mailbox: "kevin.lourd@gmail.com",
      direction: "inbound",
      messageId: "<reply-1@mail.fusionmedcare.com>",
      inReplyTo: "<ours-1@pressbeat.ai>",
      references: ["<ours-0@pressbeat.ai>", "<ours-1@pressbeat.ai>"],
      matchedRecipients: ["klourd@pressbeat.ai"],
      sentAt: "2026-08-18T16:42:16.000Z",
      bodyText: "Open to learn more",
      bodyStatus: "ok",
      mimeType: "text/plain",
    });
    expect(m1.automation.autoSubmitted).toBe("no");
    expect(m1.automation.precedence).toBeNull();
    expect(m2.direction).toBe("outbound");
    expect(m2.inReplyTo).toBeNull();

    // The payload read is bounded to the served page.
    const [, rawParams] = mockQuery.mock.calls[2] as [string, unknown[]];
    expect(rawParams).toEqual([[STAFF_ORG, STAFF_ORG], ["g1", "g2"]]);

    // Next page resumes after the cursor.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: STAFF_ACCOUNT, org_id: STAFF_ORG, email: "kevin.lourd@gmail.com" }] })
      .mockResolvedValueOnce({ rows: [] });
    await getAddressedMessages({ domains: ["pressbeat.ai"], cursor: res.page.nextCursor! });
    expect((mockQuery.mock.calls[4] as [string, unknown[]])[1][4]).toBe(r2.id);
  });

  it("rejects a forged cursor", async () => {
    await expect(getAddressedMessages({ domains: ["pressbeat.ai"], cursor: "bm9wZQ" })).rejects.toThrow(/invalid cursor/);
  });
});
