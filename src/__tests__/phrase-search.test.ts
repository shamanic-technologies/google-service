// BRAND-PROOF-LOGOS-1121, on a REAL Postgres (PGlite, the real migration):
// an org searches its own Gmail mirror by the words of the mail.
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
import { searchOrgMessages, likePattern, MAX_BODY_CHARS } from "../services/phrase-search";
import { extractMessageLinks } from "../services/message-links";

const app = createApp();

const ORG = "00000000-0000-4000-a000-000000000001";
const OTHER_ORG = "00000000-0000-4000-a000-0000000000f2";
const EMPTY_ORG = "00000000-0000-4000-a000-0000000000e3";
const USER = "00000000-0000-4000-a000-000000000002";
const RUN = "00000000-0000-4000-a000-000000000003";
const OWNER = "kevin@brand.com";
const HEADERS = { "x-api-key": "test-google-service-key", "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN };

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

const message = (o: {
  id: string;
  subject: string;
  snippet: string;
  at: string;
  labels?: string[];
  html?: string;
  text?: string;
}) => ({
  id: o.id,
  threadId: `t-${o.id}`,
  historyId: "1",
  payload: {
    id: o.id,
    threadId: `t-${o.id}`,
    labelIds: o.labels ?? ["INBOX"],
    internalDate: String(Date.parse(o.at)),
    snippet: o.snippet,
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Press Desk <desk@press-platform.io>" },
        { name: "To", value: OWNER },
        { name: "Subject", value: o.subject },
      ],
      parts: [
        ...(o.text !== undefined ? [{ mimeType: "text/plain", body: { data: b64(o.text) } }] : []),
        ...(o.html !== undefined ? [{ mimeType: "text/html", body: { data: b64(o.html) } }] : []),
      ],
    },
  },
});

const LIVE_HTML =
  '<p>Great news!</p><p><a href="https://track.press-platform.io/c?u=https%3A%2F%2Ftechdaily.com%2Fa&amp;x=1">Read your feature on <b>Tech Daily</b></a></p>' +
  '<a href="https://techdaily.com/"><img src="logo.png" alt="Tech Daily logo"></a><a href="mailto:desk@press-platform.io">Mail us</a>';

beforeAll(async () => {
  await runMigrations();
  const account = await addAccount(ORG, OWNER);
  await upsertMessage(ORG, account, message({
    id: "live-1", subject: "Your insights are now live on Tech Daily", snippet: "Great news! Read your feature", at: "2026-10-30T10:00:00Z",
    html: LIVE_HTML, text: "Great news!\nRead your feature on Tech Daily: https://techdaily.com/a.\n",
  }));
  await upsertMessage(ORG, account, message({
    id: "live-2", subject: "Update", snippet: "Your quote is NOW LIVE ON Biz Weekly", at: "2026-09-01T10:00:00Z",
    text: "Your quote is now live on Biz Weekly <https://bizweekly.com/q>",
  }));
  await upsertMessage(ORG, account, message({
    id: "live-3", subject: "Featured in Startup News", snippet: "Hello", at: "2026-06-01T10:00:00Z", text: "x".repeat(MAX_BODY_CHARS + 10),
  }));
  await upsertMessage(ORG, account, message({ id: "noise", subject: "Lunch?", snippet: "are you free", at: "2026-10-31T10:00:00Z", text: "hi" }));
  await upsertMessage(ORG, account, message({ id: "spam", subject: "Now live on Spam Outlet", snippet: "", at: "2026-10-29T10:00:00Z", labels: ["SPAM"], text: "s" }));
  await upsertMessage(ORG, account, message({ id: "draft", subject: "now live on Draft", snippet: "", at: "2026-10-29T11:00:00Z", labels: ["DRAFT"], text: "d" }));
  await upsertMessage(ORG, account, message({ id: "pct", subject: "Grew 100% now", snippet: "", at: "2026-10-01T10:00:00Z", text: "p" }));
  const other = await addAccount(OTHER_ORG, "someone@other.com");
  await upsertMessage(OTHER_ORG, other, message({ id: "other-live", subject: "Now live on Other Outlet", snippet: "", at: "2026-10-30T12:00:00Z", text: "o" }));
}, 60_000);

describe("POST /orgs/google/messages/search", () => {
  it("returns this org's matching messages newest first, with body and links", async () => {
    const res = await request(app).post("/orgs/google/messages/search").set(HEADERS).send({ phrases: ["now live on"] });
    expect(res.status).toBe(200);
    expect(res.body.reason).toBeNull();
    expect(res.body.mailboxes).toEqual([OWNER]);
    expect(res.body.messages.map((m: { gmailMessageId: string }) => m.gmailMessageId)).toEqual(["live-1", "live-2"]);
    const first = res.body.messages[0];
    expect(first).toMatchObject({
      id: `${OWNER}:live-1`,
      threadId: "t-live-1",
      fromEmail: "desk@press-platform.io",
      to: [OWNER],
      subject: "Your insights are now live on Tech Daily",
      sentAt: "2026-10-30T10:00:00.000Z",
      matchedPhrases: ["now live on"],
      bodyStatus: "ok",
      bodyTruncated: false,
    });
    expect(first.bodyText).toContain("Read your feature on Tech Daily");
    expect(first.links).toEqual([
      { url: "https://track.press-platform.io/c?u=https%3A%2F%2Ftechdaily.com%2Fa&x=1", text: "Read your feature on Tech Daily" },
      { url: "https://techdaily.com/", text: "Tech Daily logo" },
      { url: "https://techdaily.com/a", text: null },
    ]);
    expect(res.body.messages[1].links).toEqual([{ url: "https://bizweekly.com/q", text: null }]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("pages with an opaque cursor, no row twice, and honours since", async () => {
    const p1 = await request(app).post("/orgs/google/messages/search").set(HEADERS).send({ phrases: ["now live on", "featured in"], limit: 2 });
    expect(p1.body.messages.map((m: { gmailMessageId: string }) => m.gmailMessageId)).toEqual(["live-1", "live-2"]);
    expect(p1.body.nextCursor).toEqual(expect.any(String));
    const p2 = await request(app).post("/orgs/google/messages/search").set(HEADERS).send({ phrases: ["now live on", "featured in"], limit: 2, cursor: p1.body.nextCursor });
    expect(p2.body.messages.map((m: { gmailMessageId: string }) => m.gmailMessageId)).toEqual(["live-3"]);
    expect(p2.body.messages[0]).toMatchObject({ matchedPhrases: ["featured in"], bodyTruncated: true });
    expect(p2.body.messages[0].bodyText).toHaveLength(MAX_BODY_CHARS);
    expect(p2.body.nextCursor).toBeNull();

    const since = await searchOrgMessages(ORG, { phrases: ["now live on", "featured in"], since: "2026-09-15T00:00:00Z" });
    expect(since.messages.map((m) => m.gmailMessageId)).toEqual(["live-1"]);
  });

  it("serves spam only on includeSpam, drafts never", async () => {
    const res = await searchOrgMessages(ORG, { phrases: ["now live on"], includeSpam: true });
    expect(res.messages.map((m) => m.gmailMessageId)).toEqual(["live-1", "spam", "live-2"]);
  });

  it("treats % and _ as plain characters", async () => {
    expect(likePattern("100%_x\\")).toBe("%100\\%\\_x\\\\%");
    const res = await searchOrgMessages(ORG, { phrases: ["100% now"] });
    expect(res.messages.map((m) => m.gmailMessageId)).toEqual(["pct"]);
    expect((await searchOrgMessages(ORG, { phrases: ["1_0"] })).messages).toEqual([]);
  });

  it("answers an empty page with a reason when the org connected no mailbox", async () => {
    const res = await request(app)
      .post("/orgs/google/messages/search")
      .set({ ...HEADERS, "x-org-id": EMPTY_ORG })
      .send({ phrases: ["now live on"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mailboxes: [], reason: "no_google_account_connected", messages: [], nextCursor: null });
  });

  it("refuses an empty phrase list, a too-short phrase and a bad cursor", async () => {
    for (const body of [{ phrases: [] }, { phrases: ["ab"] }, { phrases: ["now live on"], cursor: "nope" }]) {
      const res = await request(app).post("/orgs/google/messages/search").set(HEADERS).send(body);
      expect(res.status).toBe(400);
    }
  });
});

describe("extractMessageLinks", () => {
  it("keeps anchors with their text, then bare plain-text URLs not already served", () => {
    expect(
      extractMessageLinks(
        `<a class="x" href='https://a.com/1'>One</a><a href=https://b.com/2>  </a><a href="#top">Top</a>`,
        "see https://a.com/1 and (https://c.com/3), done"
      )
    ).toEqual([
      { url: "https://a.com/1", text: "One" },
      { url: "https://b.com/2", text: null },
      { url: "https://c.com/3", text: null },
    ]);
  });
});
