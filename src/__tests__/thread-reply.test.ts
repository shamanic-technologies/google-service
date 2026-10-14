import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQuery, mockGetAccount, mockSend, mockSendAs, mockGetMessage, mockUpsert } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetAccount: vi.fn(),
  mockSend: vi.fn(),
  mockSendAs: vi.fn(),
  mockGetMessage: vi.fn(),
  mockUpsert: vi.fn(),
}));

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

vi.mock("../services/google-tokens", () => ({
  getGoogleAccountById: (...args: unknown[]) => mockGetAccount(...args),
  createAccessTokenProvider: () => ({ get: async () => "tok", forceRefresh: async () => "tok2" }),
}));

vi.mock("../services/google-api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-api");
  return {
    ...actual,
    sendGmailMessage: (...args: unknown[]) => mockSend(...args),
    listGmailSendAs: (...args: unknown[]) => mockSendAs(...args),
    getGmailMessage: (...args: unknown[]) => mockGetMessage(...args),
  };
});

vi.mock("../services/gmail-ingest", () => ({
  upsertMessage: (...args: unknown[]) => mockUpsert(...args),
}));

import {
  answeringAddress,
  buildRawReply,
  findLatestThread,
  replyInThread,
  replySubject,
  ReplyRefusal,
} from "../services/thread-reply";
import { GoogleApiError } from "../services/google-api";

const ORG = "00000000-0000-4000-a000-0000000000c1";
const ACC = "00000000-0000-4000-a000-0000000000a1";
const MAILBOX = "kevin.lourd@gmail.com";
const ALIAS = "kevin@ourbrand.test";
const SUPPORT = "support@ourbrand.test";
const PERSON = "client@clientco.test";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const READ = "https://www.googleapis.com/auth/gmail.readonly";

const msg = (over: Record<string, unknown>) => ({
  google_account_id: ACC,
  thread_id: "T1",
  gmail_message_id: "m1",
  from_email: PERSON,
  to_emails: [SUPPORT],
  cc_emails: [],
  subject: "Question about invoices",
  sent_at: new Date("2026-10-13T09:00:00Z"),
  labels: ["INBOX"],
  ...over,
});

// accounts, then the thread messages (newest first), then send-as aliases seen on SENT mail.
const mirror = (scopes: string, messages: Record<string, unknown>[], aliases: string[] = [ALIAS, SUPPORT]) =>
  mockQuery
    .mockResolvedValueOnce({ rows: [{ id: ACC, email: MAILBOX, scopes }] })
    .mockResolvedValueOnce({ rows: messages })
    .mockResolvedValueOnce({ rows: aliases.map((email) => ({ google_account_id: ACC, email })) });

const caller = { method: "POST", path: "/orgs/google/thread-replies" };

beforeEach(() => {
  mockQuery.mockReset();
  mockGetAccount.mockReset().mockResolvedValue({ id: ACC, orgId: ORG, googleAccountEmail: MAILBOX });
  mockSend.mockReset().mockResolvedValue({ id: "sent1", threadId: "T1" });
  mockSendAs.mockReset().mockResolvedValue([
    { sendAsEmail: MAILBOX, isPrimary: true },
    { sendAsEmail: ALIAS, verificationStatus: "accepted" },
  ]);
  mockGetMessage.mockReset().mockResolvedValue({ id: "sent1", threadId: "T1", historyId: "9", payload: {} });
  mockUpsert.mockReset().mockResolvedValue("inserted");
});

describe("answeringAddress", () => {
  const owner = new Set([MAILBOX, ALIAS, SUPPORT]);
  it("takes our newest sender (the address that answered them)", () => {
    expect(
      answeringAddress([msg({ from_email: ALIAS, to_emails: [PERSON] }), msg({})], PERSON, owner)
    ).toBe(ALIAS);
  });
  it("takes the owner address they wrote to when their message is newest", () => {
    expect(answeringAddress([msg({})], PERSON, owner)).toBe(SUPPORT);
  });
  it("is null when no owner address took part (mail forwarded in from another mailbox)", () => {
    expect(answeringAddress([msg({ to_emails: ["cold@sender.test"] })], PERSON, owner)).toBeNull();
  });
});

describe("findLatestThread", () => {
  it("serves the thread of the newest exchange and the address that answered", async () => {
    mirror(`${READ} ${SEND}`, [
      msg({ gmail_message_id: "m2", from_email: ALIAS, to_emails: [PERSON], subject: "Re: Question about invoices", sent_at: new Date("2026-10-14T08:00:00Z") }),
      msg({}),
    ]);
    const res = await findLatestThread(ORG, " Client@ClientCo.test ");
    expect(res).toEqual({
      found: true,
      thread: {
        threadId: "T1",
        googleAccountId: ACC,
        mailbox: MAILBOX,
        fromAddress: ALIAS,
        lastMessageAt: "2026-10-14T08:00:00.000Z",
        lastMessageDirection: "outbound",
        subject: "Re: Question about invoices",
        sendPermission: true,
      },
    });
    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("WHERE org_id = $1");
    expect(sql).toContain("NOT (s.labels ?| $4::text[])");
    expect(params[0]).toBe(ORG);
    expect(params[1]).toBe(PERSON);
    expect(params[3]).toEqual(["DRAFT", "SPAM", "TRASH"]);
  });

  it("skips a newer thread nobody of ours took part in", async () => {
    mirror(`${READ}`, [
      msg({ thread_id: "T9", gmail_message_id: "m9", to_emails: ["cold@sender.test"], sent_at: new Date("2026-10-14T10:00:00Z") }),
      msg({}),
    ]);
    const res = await findLatestThread(ORG, PERSON);
    expect(res.found && res.thread.threadId).toBe("T1");
    expect(res.found && res.thread.sendPermission).toBe(false);
  });

  it("names the two empty answers apart", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await findLatestThread(ORG, PERSON)).toEqual({ found: false, reason: "no_google_account_connected" });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: ACC, email: MAILBOX, scopes: READ }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await findLatestThread(ORG, PERSON)).toEqual({ found: false, reason: "no_messages" });
  });
});

describe("replyInThread", () => {
  const input = { to: PERSON, threadId: "T1", bodyHtml: "<p>Hello again</p>" };

  it("replies in the thread from the address that answered, threading headers kept, and records it", async () => {
    mirror(`${READ} ${SEND}`, [msg({ gmail_message_id: "m2", from_email: ALIAS, to_emails: [PERSON], subject: "Re: Question about invoices" })]);
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          payload: {
            payload: {
              headers: [
                { name: "Message-ID", value: "<m2@mail.gmail.com>" },
                { name: "References", value: "<m1@clientco.test>" },
              ],
            },
          },
        },
      ],
    });

    const res = await replyInThread(ORG, input, caller);
    expect(res).toMatchObject({
      sent: true,
      gmailMessageId: "sent1",
      threadId: "T1",
      mailbox: MAILBOX,
      from: ALIAS,
      to: PERSON,
      subject: "Re: Question about invoices",
      inReplyTo: "<m2@mail.gmail.com>",
      recorded: true,
    });
    const [token, sendArgs] = mockSend.mock.calls[0] as [string, { raw: string; threadId: string }];
    expect(token).toBe("tok");
    expect(sendArgs.threadId).toBe("T1");
    const mime = Buffer.from(sendArgs.raw, "base64url").toString("utf-8");
    expect(mime).toContain(`From: ${ALIAS}`);
    expect(mime).toContain(`To: ${PERSON}`);
    expect(mime).toContain("Subject: Re: Question about invoices");
    expect(mime).toContain("In-Reply-To: <m2@mail.gmail.com>");
    expect(mime).toContain("References: <m1@clientco.test> <m2@mail.gmail.com>");
    expect(mockUpsert).toHaveBeenCalledWith(ORG, ACC, expect.objectContaining({ id: "sent1", threadId: "T1" }));
  });

  it("refuses google_send_permission_missing when the grant lacks gmail.send, nothing sent", async () => {
    mirror(READ, [msg({})]);
    const err = await replyInThread(ORG, input, caller).catch((e) => e);
    expect(err).toBeInstanceOf(ReplyRefusal);
    expect(err.status).toBe(403);
    expect(err.code).toBe("google_send_permission_missing");
    expect(err.message).toContain("must reconnect Google");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("maps Google's insufficient-scope 403 on the send to the same named refusal", async () => {
    mirror(`${READ} ${SEND}`, [msg({ from_email: ALIAS, to_emails: [PERSON] })]);
    mockQuery.mockResolvedValueOnce({ rows: [{ payload: {} }] });
    mockSend.mockRejectedValueOnce(
      new GoogleApiError(403, "send", '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}')
    );
    const err = await replyInThread(ORG, input, caller).catch((e) => e);
    expect(err.code).toBe("google_send_permission_missing");
  });

  it("refuses from_address_not_send_as rather than letting Gmail rewrite the sender", async () => {
    mirror(`${READ} ${SEND}`, [msg({})]); // they wrote to support@, not a send-as of this mailbox
    const err = await replyInThread(ORG, input, caller).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.code).toBe("from_address_not_send_as");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("refuses thread_not_found for a thread the person is not in", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: ACC, email: MAILBOX, scopes: `${READ} ${SEND}` }] })
      .mockResolvedValueOnce({ rows: [] });
    const err = await replyInThread(ORG, input, caller).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe("thread_not_found");
    const [, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(params[2]).toBe("T1");
  });

  it("still answers sent when the mirror record fails after the email left", async () => {
    mirror(`${READ} ${SEND}`, [msg({ from_email: ALIAS, to_emails: [PERSON] })]);
    mockQuery.mockResolvedValueOnce({ rows: [{ payload: {} }] });
    mockUpsert.mockRejectedValueOnce(new Error("db down"));
    const res = await replyInThread(ORG, input, caller);
    expect(res.sent).toBe(true);
    expect(res.recorded).toBe(false);
  });
});

describe("message building", () => {
  it("prefixes one Re: whatever the thread subject carried", () => {
    expect(replySubject("Re: RE: Fwd: hello")).toBe("Re: hello");
    expect(replySubject("hello")).toBe("Re: hello");
  });
  it("encodes a non-ASCII subject and carries both parts", () => {
    const raw = buildRawReply({
      from: ALIAS,
      to: PERSON,
      subject: "Re: Café",
      inReplyTo: null,
      references: [],
      bodyHtml: "<p>hi</p>",
      bodyText: "hi",
      boundary: "B",
    });
    const mime = Buffer.from(raw, "base64url").toString("utf-8");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).not.toContain("In-Reply-To");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain('Content-Type: text/html; charset="UTF-8"');
  });
});
