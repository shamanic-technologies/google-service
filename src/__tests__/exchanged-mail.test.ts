// GMAIL-DRAFTS-AS-SENT-1022, on a REAL Postgres (PGlite, the real migration):
// the mirror holds a DRAFT, a SPAM and a TRASH message beside the SENT one to
// the same person; every read that serves a person's mail serves only the SENT
// one. The other rows stay stored.
import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "test-google-service-key",
    GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:8080/orgs/google/auth/callback",
    GOOGLE_GMAIL_BACKFILL_DAYS: 365,
  },
}));

vi.mock("../db/client", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const norm = (params: unknown[]) =>
    params.map((p) =>
      p !== null && typeof p === "object" && !(p instanceof Date) && !Array.isArray(p) ? JSON.stringify(p) : p
    );
  const query = async (sql: string, params?: unknown[]) => {
    if (!params || params.length === 0) {
      const rs = await db.exec(sql);
      const last = rs[rs.length - 1] ?? { rows: [], affectedRows: 0 };
      return { rows: last.rows as Record<string, unknown>[], rowCount: last.affectedRows ?? 0 };
    }
    const r = await db.query(sql, norm(params));
    return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool, query };
});

// The cleaner has its own suite; here it passes bodies through.
vi.mock("../services/body-clean", () => ({
  cleanBodies: async (_org: string, inputs: { gmailMessageId: string; text: string | null }[]) =>
    new Map(inputs.map((m) => [m.gmailMessageId, { text: m.text, status: "not_applicable" }])),
}));
vi.mock("../services/runs-service", () => ({
  createRun: vi.fn().mockResolvedValue("00000000-0000-4000-a000-000000000004"),
  updateRun: vi.fn().mockResolvedValue(undefined),
  addCosts: vi.fn(),
}));
vi.mock("../services/billing-client", () => ({ authorizeCredits: vi.fn() }));
vi.mock("../services/serper", () => ({ searchWeb: vi.fn(), searchNews: vi.fn() }));
vi.mock("../services/google-ads", () => ({ createGoogleAdsClient: () => ({}) }));

import { query } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createApp } from "../app";
import { upsertMessage } from "../services/gmail-ingest";
import { getConversation, getStaffConversation } from "../services/conversation";
import { getAddressedMessages } from "../services/addressed-messages";
import { getOrgAddressedMessages } from "../services/org-addressed-messages";
import { listCorrespondents } from "../services/correspondents";
import { findLatestThread } from "../services/thread-reply";

const app = createApp();

const ORG = "00000000-0000-4000-a000-000000000001";
const STAFF_ORG = "00000000-0000-4000-a000-0000000000f2";
const USER = "00000000-0000-4000-a000-000000000002";
const RUN = "00000000-0000-4000-a000-000000000003";
const IDENTITY = { orgId: ORG, userId: USER, runId: RUN };
const OWNER = "info@jarygo.com";
const STAFF = "kevin.lourd@gmail.com";
const PROSPECT = "callie@40volume.com";
const SENDING_DOMAIN = "growthagency.ch";
const SENDING = `k.lourd@${SENDING_DOMAIN}`;

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64url");

const addAccount = async (org: string, email: string) => {
  const res = await query(
    `INSERT INTO google_oauth_tokens
        (org_id, user_id, google_account_email, refresh_token, access_token, scopes, gmail_history_id)
     VALUES ($1, $2, $3, 'rt', 'at', 'https://www.googleapis.com/auth/gmail.readonly', 42)
     RETURNING id`,
    [org, USER, email]
  );
  return res.rows[0].id as string;
};

const message = (
  id: string,
  thread: string,
  from: string,
  to: string,
  labels: string[],
  at: string,
  text: string
) => ({
  id,
  threadId: thread,
  historyId: "1",
  payload: {
    id,
    threadId: thread,
    labelIds: labels,
    internalDate: String(Date.parse(at)),
    snippet: text,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: to },
        { name: "Subject", value: "Quick question" },
      ],
      body: { data: b64(text) },
    },
  },
});

// One thread, as in prod: the draft saved at 19:13, the real send at 19:38.
// Plus a spam and a trash message with the same person, each in its own thread.
const seedMailbox = async (org: string, accountId: string, owner: string, person: string, prefix: string) => {
  await upsertMessage(org, accountId, message(`${prefix}draft`, `${prefix}t1`, owner, person, ["DRAFT"], "2026-10-21T19:13:00Z", ""));
  await upsertMessage(org, accountId, message(`${prefix}sent`, `${prefix}t1`, owner, person, ["SENT"], "2026-10-21T19:38:00Z", "Hi Callie"));
  await upsertMessage(org, accountId, message(`${prefix}spam`, `${prefix}t2`, person, owner, ["SPAM"], "2026-10-21T20:00:00Z", "spam"));
  await upsertMessage(org, accountId, message(`${prefix}trash`, `${prefix}t3`, owner, person, ["TRASH"], "2026-10-21T21:00:00Z", "deleted"));
};

beforeAll(async () => {
  await runMigrations();
  const orgAccount = await addAccount(ORG, OWNER);
  await seedMailbox(ORG, orgAccount, OWNER, PROSPECT, "o-");
  const staffAccount = await addAccount(STAFF_ORG, STAFF);
  await seedMailbox(STAFF_ORG, staffAccount, STAFF, PROSPECT, "s-");
  // A staff mailbox answering from a sending address (addressed read keys on it).
  await seedMailbox(STAFF_ORG, staffAccount, SENDING, PROSPECT, "d-");
}, 60_000);

describe("GMAIL-DRAFTS-AS-SENT-1022: a person's mail never includes a draft, spam or trash", () => {
  it("conversation (org) serves only the SENT message", async () => {
    const res = await getConversation(ORG, PROSPECT, IDENTITY);
    if (!res.found) throw new Error(`expected a conversation, got ${res.reason}`);
    const ids = res.conversation.threads.flatMap((t) => t.messages.map((m) => m.gmailMessageId));
    expect(ids).toEqual(["o-sent"]);
    expect(res.conversation.threadCount).toBe(1);
  });

  it("conversation (staff) serves only the SENT message", async () => {
    const res = await getStaffConversation(PROSPECT);
    if (!res.found) throw new Error(`expected a conversation, got ${res.reason}`);
    const ids = res.conversation.threads.flatMap((t) => t.messages.map((m) => m.gmailMessageId));
    expect(ids).toEqual(["s-sent"]);
  });

  it("org addressed messages serve only the SENT message", async () => {
    const res = await getOrgAddressedMessages(ORG, { addresses: [PROSPECT] });
    if (!res.found) throw new Error("expected found");
    expect(res.page.messages.map((m) => m.labels)).toEqual([["SENT"]]);
  });

  it("staff addressed messages serve only the SENT message", async () => {
    const res = await getAddressedMessages({ domains: [SENDING_DOMAIN] });
    if (!res.found) throw new Error("expected found");
    expect(res.page.messages.map((m) => m.labels)).toEqual([["SENT"]]);
  });

  it("a participant's thread in /orgs/google/messages serves only the SENT message", async () => {
    const res = await request(app)
      .get(`/orgs/google/messages?participant=${encodeURIComponent(PROSPECT)}`)
      .set({ "x-api-key": "test-google-service-key", "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN });
    expect(res.status).toBe(200);
    expect(res.body.items.map((m: { gmailMessageId: string }) => m.gmailMessageId)).toEqual(["o-sent"]);
  });

  it("correspondents count only the SENT message as written to them", async () => {
    const res = await listCorrespondents(ORG);
    if (!res.connected) throw new Error("expected connected");
    const callie = res.page.correspondents.find((c) => c.email === PROSPECT);
    expect(callie?.outboundMessages).toBe(1);
  });

  it("the reply-thread picker answers in the SENT thread", async () => {
    const res = await findLatestThread(ORG, PROSPECT);
    if (!res.found) throw new Error(`expected a thread, got ${res.reason}`);
    expect(res.thread.threadId).toBe("o-t1");
  });

  it("keeps the draft, spam and trash rows stored", async () => {
    const rows = await query(
      `SELECT gmail_message_id FROM gmail_messages_raw WHERE org_id = $1 ORDER BY gmail_message_id`,
      [ORG]
    );
    expect(rows.rows.map((r) => r.gmail_message_id)).toEqual(["o-draft", "o-sent", "o-spam", "o-trash"]);
  });
});
