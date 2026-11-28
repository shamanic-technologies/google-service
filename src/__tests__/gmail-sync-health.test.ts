// GMAIL-SYNC-STALL-1128, on a REAL Postgres (PGlite, the real migration).
// 2026-11-27 18:20 UTC the four Gmail grants were revoked at Google; every pass
// then failed with invalid_grant for 23 h while GET /orgs/google/accounts said
// "active" and nothing was red anywhere. Now: each read's outcome is stored, a
// dead grant reads reconnect_required (and leaves the scheduled reads), a
// reconnect clears it, and the staff connector feed is red on it.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

const { mockRefresh, mockProfile, mockHistory, mockSendAs } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockProfile: vi.fn(),
  mockHistory: vi.fn(),
  mockSendAs: vi.fn(),
}));

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "test-google-service-key",
    GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:8080/orgs/google/auth/callback",
    GOOGLE_GMAIL_BACKFILL_DAYS: 365,
    GOOGLE_GMAIL_FRESH_INTERVAL_MINUTES: 15,
    GOOGLE_CALENDAR_SYNC_INTERVAL_MINUTES: 15,
    GOOGLE_SEARCH_CONSOLE_SYNC_INTERVAL_HOURS: 12,
    GOOGLE_SYNC_INTERVAL_HOURS: 6,
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
  return { ...actual, refreshAccessToken: (...a: unknown[]) => mockRefresh(...a) };
});
vi.mock("../services/google-api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-api");
  return {
    ...actual,
    getGmailProfile: (...a: unknown[]) => mockProfile(...a),
    listGmailHistory: (...a: unknown[]) => mockHistory(...a),
    listGmailSendAs: (...a: unknown[]) => mockSendAs(...a),
  };
});
vi.mock("../services/people-ingest", () => {
  const zero = async () => ({ inserted: 0, updated: 0, unchanged: 0, deleted: 0 });
  return { ingestPeopleForAccount: zero, ingestOtherPeopleForAccount: zero };
});
vi.mock("../services/key-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/key-service");
  return { ...actual, getGoogleOAuthClient: vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "cs" }) };
});
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
import { runGmailFreshOnce } from "../services/cron-sync";
import { syncOrg } from "../services/sync";
import { listGmailDeltaAccounts, upsertGoogleToken } from "../services/google-tokens";
import { judgeConnection, quietFigures } from "../services/connector-health";
import { encryptToken } from "../lib/token-crypto";

const app = createApp();
const ORG = "00000000-0000-4000-a000-000000000001";
const USER = "00000000-0000-4000-a000-000000000002";
const headers = () => ({
  "x-api-key": "test-google-service-key",
  "x-org-id": ORG,
  "x-user-id": USER,
  "x-run-id": "00000000-0000-4000-a000-000000000003",
});
const DEAD = new Error(
  'Google token refresh failed: 400 {\n  "error": "invalid_grant",\n  "error_description": "Token has been expired or revoked."\n}'
);

// An expired access token, so every read must refresh first.
const addMailbox = async (email: string) => {
  const res = await query(
    `INSERT INTO google_oauth_tokens
        (org_id, user_id, google_account_email, refresh_token, access_token, access_token_expires_at, scopes, gmail_history_id)
     VALUES ($1, $2, $3, $4, $5, NOW() - interval '1 hour', 'https://www.googleapis.com/auth/gmail.readonly', 42)
     RETURNING id`,
    [ORG, USER, email, encryptToken(`rt-${email}`), encryptToken("at")]
  );
  return res.rows[0].id as string;
};

const row = async (email: string) =>
  (
    await query(
      `SELECT last_synced_at, last_sync_error, reconnect_required FROM google_oauth_tokens WHERE google_account_email = $1`,
      [email]
    )
  ).rows[0];

beforeAll(async () => {
  await runMigrations();
});

beforeEach(async () => {
  await query(`DELETE FROM google_oauth_tokens`);
  mockRefresh.mockReset();
  mockProfile.mockReset().mockResolvedValue({ historyId: "50", emailAddress: "x" });
  mockHistory.mockReset().mockResolvedValue({ history: [] });
  mockSendAs.mockReset().mockResolvedValue([]);
});

describe("a Gmail grant Google refuses (invalid_grant)", () => {
  it("is stored as reconnect_required, shown on the accounts list, leaves the scheduled reads, and red on the staff feed", async () => {
    await addMailbox("kevin@example.com");
    mockRefresh.mockRejectedValue(DEAD);

    await runGmailFreshOnce();
    const r = await row("kevin@example.com");
    expect(r.reconnect_required).toBe(true);
    expect(r.last_sync_error).toContain("invalid_grant");

    const list = await request(app).get("/orgs/google/accounts").set(headers());
    expect(list.status).toBe(200);
    expect(list.body.accounts[0]).toMatchObject({ status: "reconnect_required", lastSyncedAt: null });
    expect(list.body.accounts[0].lastSyncError).toContain("invalid_grant");

    // Out of the 15-min pass: Google is not asked again until a reconnect.
    expect(await listGmailDeltaAccounts()).toHaveLength(0);
    await runGmailFreshOnce();
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    const feed = await request(app).get("/internal/connector-intake?days=7").set(headers());
    expect(feed.status).toBe(200);
    expect(feed.body.status).toBe("red");
    const c = feed.body.connections.find((x: { account: string }) => x.account === "kevin@example.com");
    expect(c).toMatchObject({ source: "gmail", status: "red", syncStatus: "reconnect_required" });
    expect(c.reasons.map((x: { code: string }) => x.code)).toEqual(["reconnect_required"]);
    expect(c.byDay).toHaveLength(7);
  });

  it("is cleared by a reconnect (the same mailbox signs in again)", async () => {
    await addMailbox("kevin@example.com");
    mockRefresh.mockRejectedValue(DEAD);
    await runGmailFreshOnce();

    await upsertGoogleToken({
      orgId: ORG,
      userId: USER,
      googleAccountEmail: "kevin@example.com",
      refreshToken: "rt-new",
      accessToken: "at-new",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
    });
    const r = await row("kevin@example.com");
    expect(r.reconnect_required).toBe(false);
    expect(r.last_sync_error).toBeNull();
    expect(await listGmailDeltaAccounts()).toHaveLength(1);

    await runGmailFreshOnce();
    expect((await row("kevin@example.com")).last_synced_at).not.toBeNull();
    const list = await request(app).get("/orgs/google/accounts").set(headers());
    expect(list.body.accounts[0].status).toBe("active");
  });

  it("never aborts the org's other mailboxes in the full sync", async () => {
    await addMailbox("dead@example.com");
    await addMailbox("alive@example.com");
    mockRefresh.mockImplementation(async (p: { refreshToken: string }) => {
      if (p.refreshToken === "rt-dead@example.com") throw DEAD;
      return { access_token: "fresh", expires_in: 3600 };
    });

    const summary = await syncOrg(ORG, { method: "CRON", path: "/test" });
    expect(summary.accounts).toBe(2);
    expect((await row("dead@example.com")).reconnect_required).toBe(true);
    expect((await row("alive@example.com")).last_synced_at).not.toBeNull();
  });

  it("another failure stays active with its error, cleared by the next good read", async () => {
    await addMailbox("kevin@example.com");
    mockRefresh.mockResolvedValue({ access_token: "fresh", expires_in: 3600 });
    mockProfile.mockRejectedValueOnce(new Error("socket hang up"));

    await runGmailFreshOnce();
    let list = await request(app).get("/orgs/google/accounts").set(headers());
    expect(list.body.accounts[0]).toMatchObject({ status: "active", lastSyncError: "socket hang up" });
    expect((await row("kevin@example.com")).reconnect_required).toBe(false);

    await runGmailFreshOnce();
    list = await request(app).get("/orgs/google/accounts").set(headers());
    expect(list.body.accounts[0]).toMatchObject({ status: "active", lastSyncError: null });
  });
});

describe("connector verdict (pure)", () => {
  const now = new Date("2026-11-28T17:00:00Z");
  const base = {
    source: "gmail" as const,
    id: "a",
    orgId: ORG,
    brandId: null,
    account: "k@x.com",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    lastSyncedAt: new Date("2026-11-28T16:50:00Z"),
    lastError: null,
    reconnectRequired: false,
    paused: false,
  };
  const booted = new Date("2026-11-28T10:00:00Z");

  it("a recent good read is ok", () => {
    expect(judgeConnection(base, new Map(), 3, now, booted).status).toBe("ok");
  });

  it("no good read for an hour is red sync_late (the 23 h stall)", () => {
    const c = judgeConnection({ ...base, lastSyncedAt: new Date("2026-11-27T18:18:54Z") }, new Map(), 3, now, booted);
    expect(c.status).toBe("red");
    expect(c.reasons[0].code).toBe("sync_late");
  });

  it("never read yet right after a deploy is not red", () => {
    const c = judgeConnection({ ...base, lastSyncedAt: null }, new Map(), 3, now, new Date("2026-11-28T16:58:00Z"));
    expect(c.status).toBe("ok");
  });

  it("a mailbox with no Gmail is paused, never red", () => {
    expect(judgeConnection({ ...base, paused: true, lastSyncedAt: null }, new Map(), 3, now, booted).status).toBe("paused");
  });

  it("mail stopping for longer than its own longest gap is red quiet_unusual", () => {
    const days = new Map<string, number>();
    for (let i = 5; i < 40; i++) days.set(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10), 3);
    const c = judgeConnection(base, days, 7, now, booted);
    expect(c.quietDays).toBe(5);
    expect(c.usualLongestQuietDays).toBe(0);
    expect(c.reasons.map((r) => r.code)).toEqual(["quiet_unusual"]);
  });

  it("quietFigures reads the newest day and the longest gap", () => {
    expect(quietFigures(["2026-11-20", "2026-11-24", "2026-11-25"], "2026-11-28")).toEqual({
      newest: "2026-11-25",
      quietDays: 3,
      usualLongest: 3,
    });
  });
});
