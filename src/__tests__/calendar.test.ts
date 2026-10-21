// GOOGLE-CALENDAR-INTEGRATION-1021, on a REAL Postgres (PGlite, the real migration):
// a calendar connects on its own consent into its own table, its events are
// mirrored and served as a changes feed, Meet attendance is read only from the
// Meet participant list, and a disconnect never cuts a mailbox on the same grant.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  userEmail: vi.fn(),
  revoke: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "test-google-service-key",
    GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:8080/orgs/google/auth/callback",
    GOOGLE_GMAIL_BACKFILL_DAYS: 365,
  },
}));

// pg-shaped facade over one in-memory PGlite. A transaction (pool.connect)
// holds the single connection until release, like a row lock would make a
// concurrent writer wait, so the purge's per-batch transactions interleave with
// requests exactly at batch boundaries.
vi.mock("../db/client", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  let tail: Promise<void> = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const prev = tail;
    tail = prev.then(() => mine);
    await prev;
    return release;
  };
  const norm = (params: unknown[]) =>
    params.map((p) =>
      p !== null && typeof p === "object" && !(p instanceof Date) && !Array.isArray(p)
        ? JSON.stringify(p)
        : p
    );
  const run = async (sql: string, params?: unknown[]) => {
    if (!params || params.length === 0) {
      const rs = await db.exec(sql);
      const last = rs[rs.length - 1] ?? { rows: [], affectedRows: 0 };
      return { rows: last.rows as Record<string, unknown>[], rowCount: last.affectedRows ?? 0 };
    }
    const r = await db.query(sql, norm(params));
    return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? 0 };
  };
  const query = async (sql: string, params?: unknown[]) => {
    const release = await acquire();
    try {
      return await run(sql, params);
    } finally {
      release();
    }
  };
  const pool = {
    query,
    connect: async () => {
      const release = await acquire();
      return { query: run, release };
    },
  };
  return { pool, query };
});

vi.mock("../services/google-oauth", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-oauth");
  return {
    ...actual,
    exchangeCodeForTokens: (...a: unknown[]) => mocks.exchange(...a),
    fetchGoogleUserEmail: (...a: unknown[]) => mocks.userEmail(...a),
    revokeGoogleToken: (...a: unknown[]) => mocks.revoke(...a),
    refreshAccessToken: (...a: unknown[]) => mocks.refresh(...a),
  };
});
vi.mock("../services/key-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/key-service");
  return { ...actual, getGoogleOAuthClient: vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "cs" }) };
});
vi.mock("../services/sync", () => ({ syncOrg: vi.fn().mockResolvedValue({}) }));
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
import {
  CALENDAR_EVENTS_SCOPE,
  MEET_READ_SCOPE,
} from "../services/google-oauth";
import { syncCalendarAccount, upsertCalendarAccount, type CalendarAccount } from "../services/calendar";

const app = createApp();

const ORG = "00000000-0000-4000-a000-000000000001";
const OTHER_ORG = "00000000-0000-4000-a000-0000000000f2";
const USER = "00000000-0000-4000-a000-000000000002";
const headers = (org = ORG) => ({
  "x-api-key": "test-google-service-key",
  "x-org-id": org,
  "x-user-id": USER,
  "x-run-id": "00000000-0000-4000-a000-000000000003",
});
const CALLER = { method: "TEST", path: "/test" };
const BOTH = `${CALENDAR_EVENTS_SCOPE} ${MEET_READ_SCOPE} https://www.googleapis.com/auth/userinfo.email`;
const NOW = new Date("2026-10-21T12:00:00Z");

const addCalendar = (email: string, scopes = BOTH, org = ORG): Promise<CalendarAccount> =>
  upsertCalendarAccount({
    orgId: org,
    userId: USER,
    googleAccountEmail: email,
    refreshToken: `rt-${email}`,
    accessToken: "at",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    scopes,
  });

const event = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  etag: `"${id}-1"`,
  status: "confirmed",
  summary: "Intro call with John Smith",
  start: { dateTime: "2026-10-20T14:00:00Z" },
  end: { dateTime: "2026-10-20T14:30:00Z" },
  created: "2026-10-15T09:00:00Z",
  updated: "2026-10-15T09:00:00Z",
  organizer: { email: "Owner@Jarygo.com" },
  attendees: [
    { email: "owner@jarygo.com", organizer: true, self: true, responseStatus: "accepted" },
    { email: "John.Perso@Gmail.com", displayName: "John Smith", responseStatus: "accepted" },
  ],
  conferenceData: { conferenceId: `${id}-meet`, conferenceSolution: { key: { type: "hangoutsMeet" } } },
  ...over,
});

// Google's answers, keyed on the URL the code asks.
let calendarItems: unknown[] = [];
let meet: Record<string, { status: number; body: unknown }> = {};
const fetchMock = vi.fn(async (url: string) => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.startsWith("https://www.googleapis.com/calendar/v3/")) return json(200, { items: calendarItems });
  if (url.startsWith("https://meet.googleapis.com/v2/conferenceRecords?")) {
    const code = decodeURIComponent(url).match(/meeting_code = "([^"]+)"/)?.[1] ?? "";
    const hit = meet[code];
    if (!hit) return json(200, {});
    return json(hit.status, hit.body);
  }
  if (url.includes("/participants")) {
    return json(200, {
      participants: [
        { signedinUser: { user: "users/1", displayName: "Owner" }, earliestStartTime: "2026-10-20T14:00:10Z" },
        { anonymousUser: { displayName: "John Smith" }, earliestStartTime: "2026-10-20T14:01:00Z", latestEndTime: "2026-10-20T14:29:00Z" },
      ],
    });
  }
  throw new Error(`unexpected fetch ${url}`);
});

const feed = async (cursor?: string) => {
  const res = await request(app)
    .get(`/internal/calendar/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)
    .set(headers());
  expect(res.status).toBe(200);
  return res.body as { events: Record<string, any>[]; nextCursor: string | null; hasMore: boolean };
};

beforeAll(async () => {
  await runMigrations();
}, 60_000);

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  calendarItems = [];
  meet = {};
  for (const m of Object.values(mocks)) m.mockReset();
  await query(`DELETE FROM google_calendar_accounts`, []);
  await query(`DELETE FROM google_oauth_tokens`, []);
  await query(`DELETE FROM google_oauth_pending`, []);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connect", () => {
  it("asks the calendar consent alone, and the mailbox one stays the default", async () => {
    const cal = await request(app)
      .post("/orgs/google/auth/start")
      .set(headers())
      .send({ redirectUri: "https://dashboard.distribute.you/services/crm/oauth/callback", connection: "calendar" });
    expect(cal.status).toBe(200);
    const scope = new URL(cal.body.url).searchParams.get("scope")!.split(" ");
    expect(scope).toContain(CALENDAR_EVENTS_SCOPE);
    expect(scope).toContain(MEET_READ_SCOPE);
    expect(scope.some((s) => s.includes("gmail"))).toBe(false);

    const mail = await request(app).post("/orgs/google/auth/start").set(headers()).send({});
    const mailScope = new URL(mail.body.url).searchParams.get("scope")!;
    expect(mailScope).toContain("gmail.readonly");
    expect(mailScope).not.toContain("calendar");

    const pending = await query(`SELECT state, connection FROM google_oauth_pending ORDER BY created_at`, []);
    expect(pending.rows.map((r) => r.connection).sort()).toEqual(["calendar", "mailbox"]);
  });

  it("the callback stores a calendar, never a mailbox, and reads it at once", async () => {
    calendarItems = [event("e1")];
    const start = await request(app).post("/orgs/google/auth/start").set(headers()).send({ connection: "calendar" });
    mocks.exchange.mockResolvedValue({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: BOTH, token_type: "Bearer" });
    mocks.userEmail.mockResolvedValue("owner@jarygo.com");

    const cb = await request(app)
      .get(`/orgs/google/auth/callback?code=c&state=${encodeURIComponent(start.body.state)}`)
      .set(headers());
    expect(cb.status).toBe(200);
    expect(cb.body).toMatchObject({ success: true, connection: "calendar", googleAccountEmail: "owner@jarygo.com", syncJobId: null });

    const mailboxes = await query(`SELECT count(*)::int AS n FROM google_oauth_tokens`, []);
    expect(mailboxes.rows[0].n).toBe(0);
    const listed = await request(app).get("/orgs/google/calendar/accounts").set(headers());
    expect(listed.body.calendars).toEqual([
      expect.objectContaining({ email: "owner@jarygo.com", status: "active", attendance: "meet" }),
    ]);
    await vi.waitFor(async () => expect((await feed()).events).toHaveLength(1));
  });

  it("refuses a consent where the calendar box was unticked", async () => {
    const start = await request(app).post("/orgs/google/auth/start").set(headers()).send({ connection: "calendar" });
    mocks.exchange.mockResolvedValue({
      access_token: "at", refresh_token: "rt", expires_in: 3600,
      scope: "https://www.googleapis.com/auth/userinfo.email", token_type: "Bearer",
    });
    mocks.userEmail.mockResolvedValue("owner@jarygo.com");
    const cb = await request(app)
      .get(`/orgs/google/auth/callback?code=c&state=${encodeURIComponent(start.body.state)}`)
      .set(headers());
    expect(cb.status).toBe(400);
    expect(cb.body.reason).toBe("calendar_permission_missing");
    const n = await query(`SELECT count(*)::int AS n FROM google_calendar_accounts`, []);
    expect(n.rows[0].n).toBe(0);
  });
});

describe("events feed", () => {
  it("serves each booked event once with its attendees, and again only when Google changed it", async () => {
    const acc = await addCalendar("owner@jarygo.com");
    calendarItems = [event("e1"), event("e2", { conferenceData: undefined, summary: "Zoom call" })];
    const first = await syncCalendarAccount(acc, CALLER, NOW);
    expect(first).toMatchObject({ inserted: 2, updated: 0 });

    const page = await feed();
    expect(page.events).toHaveLength(2);
    const e1 = page.events.find((e) => e.googleEventId === "e1")!;
    expect(e1).toMatchObject({
      orgId: ORG,
      calendarEmail: "owner@jarygo.com",
      status: "confirmed",
      title: "Intro call with John Smith",
      bookedAt: "2026-10-15T09:00:00.000Z",
      organizerEmail: "owner@jarygo.com",
    });
    expect(e1.attendees).toContainEqual({
      email: "john.perso@gmail.com", displayName: "John Smith", responseStatus: "accepted", organizer: false, self: false,
    });
    expect(page.events.find((e) => e.googleEventId === "e2")!.meet.status).toBe("not_meet");

    // Nothing changed at Google: nothing new in the feed.
    const again = await syncCalendarAccount(acc, CALLER, NOW);
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect((await feed(page.nextCursor!)).events).toHaveLength(0);

    // The prospect cancels: the event comes back, cancelled.
    calendarItems = [event("e1", { etag: '"e1-2"', status: "cancelled" }), event("e2", { conferenceData: undefined, summary: "Zoom call" })];
    await syncCalendarAccount(acc, CALLER, NOW);
    const after = await feed(page.nextCursor!);
    expect(after.events.map((e) => [e.googleEventId, e.status])).toEqual([["e1", "cancelled"]]);
  });

  it("pages with hasMore and a cursor that resumes exactly where it stopped", async () => {
    const acc = await addCalendar("owner@jarygo.com");
    calendarItems = ["a", "b", "c"].map((id) => event(id));
    await syncCalendarAccount(acc, CALLER, NOW);
    const res = await request(app).get("/internal/calendar/events?limit=2").set(headers());
    expect(res.body.events).toHaveLength(2);
    expect(res.body.hasMore).toBe(true);
    const rest = await feed(res.body.nextCursor);
    expect(rest.events).toHaveLength(1);
    expect(rest.hasMore).toBe(false);
    const ids = [...res.body.events, ...rest.events].map((e: { googleEventId: string }) => e.googleEventId).sort();
    expect(ids).toEqual(["a", "b", "c"]);

    const bad = await request(app).get("/internal/calendar/events?cursor=nope").set(headers());
    expect(bad.status).toBe(400);
  });
});

describe("Meet attendance", () => {
  it("reads who joined from the Meet participant list once the call ended", async () => {
    const acc = await addCalendar("owner@jarygo.com");
    calendarItems = [event("e1")];
    meet["e1-meet"] = { status: 200, body: { conferenceRecords: [{ name: "conferenceRecords/r1" }] } };
    const s = await syncCalendarAccount(acc, CALLER, NOW);
    expect(s).toMatchObject({ meetChecked: 1, meetFound: 1 });
    const e1 = (await feed()).events[0];
    expect(e1.meet.status).toBe("record_found");
    expect(e1.meet.participants).toContainEqual({
      displayName: "John Smith", kind: "anonymous", joinedAt: "2026-10-20T14:01:00Z", leftAt: "2026-10-20T14:29:00Z",
    });
  });

  it("never reads a future call, and never says nobody came: no record stays pending, then no_record after 24h", async () => {
    const acc = await addCalendar("owner@jarygo.com");
    calendarItems = [event("future", { start: { dateTime: "2026-10-25T14:00:00Z" }, end: { dateTime: "2026-10-25T14:30:00Z" } }), event("e1")];
    await syncCalendarAccount(acc, CALLER, NOW);
    const meetCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("meet.googleapis.com"));
    expect(meetCalls.map(([u]) => decodeURIComponent(String(u)))).toEqual([expect.stringContaining("e1-meet")]);
    let page = await feed();
    expect(Object.fromEntries(page.events.map((e) => [e.googleEventId, e.meet.status]))).toEqual({ future: "pending", e1: "pending" });

    await syncCalendarAccount(acc, CALLER, new Date("2026-10-21T15:00:00Z"));
    page = await feed();
    expect(page.events.find((e) => e.googleEventId === "e1")!.meet.status).toBe("no_record");
  });

  it("marks attendance unavailable when Google refuses the Meet read, or the permission was not granted", async () => {
    const acc = await addCalendar("owner@jarygo.com");
    calendarItems = [event("e1")];
    meet["e1-meet"] = { status: 403, body: { error: { message: "Meet API not available" } } };
    await syncCalendarAccount(acc, CALLER, NOW);
    const e1 = (await feed()).events[0];
    expect(e1.meet.status).toBe("unavailable");
    expect(e1.meet.error).toContain("403");

    const noMeet = await addCalendar("other@jarygo.com", CALENDAR_EVENTS_SCOPE, OTHER_ORG);
    calendarItems = [event("e9")];
    await syncCalendarAccount(noMeet, CALLER, NOW);
    const e9 = (await feed()).events.find((e) => e.googleEventId === "e9")!;
    expect(e9.meet).toMatchObject({ status: "unavailable", error: "meet_permission_missing" });
    const listed = await request(app).get("/orgs/google/calendar/accounts").set(headers(OTHER_ORG));
    expect(listed.body.calendars[0].attendance).toBe("meet_permission_missing");
  });

  it("a rescheduled call is checked again for its new time", async () => {
    const acc = await addCalendar("owner@jarygo.com");
    calendarItems = [event("e1")];
    await syncCalendarAccount(acc, CALLER, new Date("2026-10-22T15:00:00Z"));
    expect((await feed()).events[0].meet.status).toBe("no_record");
    calendarItems = [event("e1", { etag: '"e1-2"', start: { dateTime: "2026-10-23T14:00:00Z" }, end: { dateTime: "2026-10-23T14:30:00Z" } })];
    await syncCalendarAccount(acc, CALLER, new Date("2026-10-22T16:00:00Z"));
    expect((await feed()).events[0].meet.status).toBe("pending");
  });

  it("a failed read is stored on the calendar and listed", async () => {
    const acc = await addCalendar("owner@jarygo.com");
    fetchMock.mockImplementationOnce(async () => new Response("boom", { status: 500 }));
    await expect(syncCalendarAccount(acc, CALLER, NOW)).rejects.toThrow();
    const listed = await request(app).get("/orgs/google/calendar/accounts").set(headers());
    expect(listed.body.calendars[0]).toMatchObject({ status: "sync_failing", lastSyncError: expect.stringContaining("500") });
  });
});

describe("disconnect", () => {
  it("revokes the grant and deletes the mirrored events", async () => {
    const acc = await addCalendar("owner@jarygo.com");
    calendarItems = [event("e1")];
    await syncCalendarAccount(acc, CALLER, NOW);
    mocks.revoke.mockResolvedValue("revoked");
    const res = await request(app)
      .delete(`/orgs/google/calendar/accounts/${encodeURIComponent("Owner@Jarygo.com")}`)
      .set(headers());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ disconnected: true, email: "owner@jarygo.com", grant: "revoked" });
    expect(mocks.revoke).toHaveBeenCalledWith("rt-owner@jarygo.com");
    const n = await query(`SELECT count(*)::int AS n FROM google_calendar_events`, []);
    expect(n.rows[0].n).toBe(0);
  });

  it("keeps the Google grant when the same account is also connected as a mailbox", async () => {
    await addCalendar("owner@jarygo.com");
    await query(
      `INSERT INTO google_oauth_tokens (org_id, user_id, google_account_email, refresh_token, scopes)
       VALUES ($1, $2, 'owner@jarygo.com', 'rt-mail', 'gmail')`,
      [OTHER_ORG, USER]
    );
    const res = await request(app)
      .delete(`/orgs/google/calendar/accounts/${encodeURIComponent("owner@jarygo.com")}`)
      .set(headers());
    expect(res.body.grant).toBe("kept_for_mailbox");
    expect(mocks.revoke).not.toHaveBeenCalled();
    const mailboxes = await query(`SELECT count(*)::int AS n FROM google_oauth_tokens`, []);
    expect(mailboxes.rows[0].n).toBe(1);
  });

  it("keeps the calendar connected when Google does not confirm the revoke, and 404s an unknown one", async () => {
    await addCalendar("owner@jarygo.com");
    mocks.revoke.mockRejectedValue(new Error("timeout"));
    const res = await request(app)
      .delete(`/orgs/google/calendar/accounts/${encodeURIComponent("owner@jarygo.com")}`)
      .set(headers());
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("google_revoke_failed");
    const listed = await request(app).get("/orgs/google/calendar/accounts").set(headers());
    expect(listed.body.calendars).toHaveLength(1);

    const other = await request(app)
      .delete(`/orgs/google/calendar/accounts/${encodeURIComponent("owner@jarygo.com")}`)
      .set(headers(OTHER_ORG));
    expect(other.status).toBe(404);
    expect(other.body.reason).toBe("calendar_not_found");
  });
});
