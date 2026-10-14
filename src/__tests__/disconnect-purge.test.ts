// GMAIL-DISCONNECT-HANGS-1014, on a REAL Postgres (PGlite, the real migration):
// a disconnect answers fast whatever the mailbox size, the mailbox leaves the
// accounts list at once, its mirror is purged in the background in batches
// (resumable after a restart), no ingest writes to it meanwhile, another org's
// and another mailbox's data are never touched, and reconnecting works.
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

const { mockRevokeGoogleToken } = vi.hoisted(() => ({ mockRevokeGoogleToken: vi.fn() }));

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
  return { ...actual, revokeGoogleToken: (...a: unknown[]) => mockRevokeGoogleToken(...a) };
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
import {
  awaitRunningPurges,
  purgeDisconnectedAccount,
  resetPurgeSchedulerForTests,
  resumePendingPurges,
} from "../services/account-purge";
import { upsertMessage } from "../services/gmail-ingest";
import { upsertGoogleToken } from "../services/google-tokens";
import { AccountDisconnectedError } from "../lib/account-disconnected";

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

const LARGE = 40_000;

const addAccount = async (org: string, email: string, messages: number, contacts: number) => {
  const res = await query(
    `INSERT INTO google_oauth_tokens
        (org_id, user_id, google_account_email, refresh_token, access_token, scopes, gmail_history_id)
     VALUES ($1, $2, $3, 'rt-' || $3, 'at', 'https://www.googleapis.com/auth/gmail.readonly', 42)
     RETURNING id`,
    [org, USER, email]
  );
  const id = res.rows[0].id as string;
  const prefix = `${email}-`;
  await query(
    `INSERT INTO gmail_messages_raw (org_id, google_account_id, gmail_message_id, thread_id, history_id, payload)
     SELECT $1, $2::uuid, $3 || g, 't' || g, g,
            jsonb_build_object('id', $3 || g, 'snippet', repeat('x', 300))
       FROM generate_series(1, $4::int) g`,
    [org, id, prefix, messages]
  );
  await query(
    `INSERT INTO gmail_messages_silver (org_id, google_account_id, gmail_message_id, thread_id, from_email, subject)
     SELECT org_id, google_account_id, gmail_message_id, thread_id, 'a@b.c', 'hello'
       FROM gmail_messages_raw WHERE google_account_id = $1::uuid`,
    [id]
  );
  await query(
    `INSERT INTO gmail_message_clean_bodies
        (org_id, gmail_message_id, cleaner_version, status, clean_text, verdicts, model, input_tokens)
     SELECT org_id, gmail_message_id, 1, 'cleaned', 'hi', '[]'::jsonb, 'm', 1
       FROM gmail_messages_raw WHERE google_account_id = $1::uuid LIMIT 500`,
    [id]
  );
  await query(
    `INSERT INTO google_contacts_raw (org_id, google_account_id, resource_name, etag, payload)
     SELECT $1, $2::uuid, 'people/' || $3 || g, 'e', '{}'::jsonb FROM generate_series(1, $4::int) g`,
    [org, id, prefix, contacts]
  );
  await query(
    `INSERT INTO google_contacts_silver (org_id, google_account_id, resource_name, primary_email)
     SELECT org_id, google_account_id, resource_name, 'p@q.r'
       FROM google_contacts_raw WHERE google_account_id = $1::uuid`,
    [id]
  );
  return id;
};

const mirrorCounts = async (accountId: string) => {
  const r = await query(
    `SELECT
       (SELECT count(*) FROM gmail_messages_raw WHERE google_account_id = $1::uuid)::int AS raw,
       (SELECT count(*) FROM gmail_messages_silver WHERE google_account_id = $1::uuid)::int AS silver,
       (SELECT count(*) FROM google_contacts_raw WHERE google_account_id = $1::uuid)::int AS craw,
       (SELECT count(*) FROM google_contacts_silver WHERE google_account_id = $1::uuid)::int AS csilver,
       (SELECT count(*) FROM gmail_message_clean_bodies c
          JOIN gmail_messages_raw r USING (org_id, gmail_message_id)
         WHERE r.google_account_id = $1::uuid)::int AS clean,
       (SELECT count(*) FROM google_oauth_tokens WHERE id = $1::uuid)::int AS token`,
    [accountId]
  );
  return r.rows[0] as Record<string, number>;
};

const listed = async (org = ORG) => {
  const res = await request(app).get("/orgs/google/accounts").set(headers(org));
  expect(res.status).toBe(200);
  return (res.body.accounts as { email: string }[]).map((a) => a.email);
};

beforeAll(async () => {
  await runMigrations();
}, 60_000);

beforeEach(async () => {
  resetPurgeSchedulerForTests();
  mockRevokeGoogleToken.mockReset();
  await query(`DELETE FROM google_oauth_tokens`, []);
  await query(`DELETE FROM gmail_messages_silver`, []);
  await query(`DELETE FROM google_contacts_silver`, []);
});

describe("disconnect on a large mailbox", () => {
  it("answers fast, unlists the mailbox at once, then purges only that mailbox in the background", async () => {
    const big = await addAccount(ORG, "kevin@example.com", LARGE, 3_000);
    const sibling = await addAccount(ORG, "other@example.com", 300, 30);
    const otherOrg = await addAccount(OTHER_ORG, "kevin@example.com", 500, 50);
    mockRevokeGoogleToken.mockResolvedValue("revoked");

    const started = Date.now();
    const res = await request(app)
      .delete(`/orgs/google/accounts/${encodeURIComponent("Kevin@Example.com")}`)
      .set(headers());
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      disconnected: true,
      email: "kevin@example.com",
      grant: "revoked",
      mirror: "deleting",
    });
    expect(elapsed).toBeLessThan(2_000);
    expect(mockRevokeGoogleToken).toHaveBeenCalledWith("rt-kevin@example.com");

    // Gone from the list immediately, while its mirror is still being deleted.
    expect(await listed()).toEqual(["other@example.com"]);
    expect((await mirrorCounts(big)).raw).toBeGreaterThan(0);
    // The dead grant is not kept on the row.
    const tok = await query(`SELECT refresh_token, access_token FROM google_oauth_tokens WHERE id = $1`, [big]);
    expect(tok.rows[0]).toEqual({ refresh_token: "", access_token: null });

    await awaitRunningPurges();

    expect(await mirrorCounts(big)).toEqual({ raw: 0, silver: 0, craw: 0, csilver: 0, clean: 0, token: 0 });
    const orphanBodies = await query(
      `SELECT count(*)::int AS n FROM gmail_message_clean_bodies WHERE gmail_message_id LIKE 'kevin@example.com-%' AND org_id = $1`,
      [ORG]
    );
    expect(orphanBodies.rows[0].n).toBe(0);
    // Same address in another org, and another mailbox of the same org: untouched.
    expect(await mirrorCounts(otherOrg)).toEqual({ raw: 500, silver: 500, craw: 50, csilver: 50, clean: 500, token: 1 });
    expect(await mirrorCounts(sibling)).toEqual({ raw: 300, silver: 300, craw: 30, csilver: 30, clean: 300, token: 1 });
    expect(await listed(OTHER_ORG)).toEqual(["kevin@example.com"]);
  }, 120_000);

  it("never reaches another org's mailbox by address", async () => {
    const otherOrg = await addAccount(OTHER_ORG, "kevin@example.com", 10, 1);
    const res = await request(app).delete("/orgs/google/accounts/kevin%40example.com").set(headers());
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("account_not_found");
    expect(mockRevokeGoogleToken).not.toHaveBeenCalled();
    expect((await mirrorCounts(otherOrg)).raw).toBe(10);
  });

  it("a failed Google revoke keeps the mailbox connected, lists why, and a retry disconnects", async () => {
    const id = await addAccount(ORG, "kevin@example.com", 50, 5);
    mockRevokeGoogleToken.mockRejectedValueOnce(new Error("Google token revoke failed: 503 down"));

    const failed = await request(app).delete("/orgs/google/accounts/kevin%40example.com").set(headers());
    expect(failed.status).toBe(502);
    expect(failed.body.reason).toBe("google_revoke_failed");
    const list = await request(app).get("/orgs/google/accounts").set(headers());
    expect(list.body.accounts).toHaveLength(1);
    expect(list.body.accounts[0].disconnectError).toMatch(/google_revoke_failed: .*503/);
    expect((await mirrorCounts(id)).raw).toBe(50);

    mockRevokeGoogleToken.mockResolvedValueOnce("already_revoked");
    const retry = await request(app).delete("/orgs/google/accounts/kevin%40example.com").set(headers());
    expect(retry.status).toBe(200);
    expect(retry.body.grant).toBe("already_revoked");
    expect(await listed()).toEqual([]);
    await awaitRunningPurges();
    expect((await mirrorCounts(id)).token).toBe(0);
  });

  it("a second disconnect while purging answers 200 without calling Google again", async () => {
    await addAccount(ORG, "kevin@example.com", 5_000, 5);
    mockRevokeGoogleToken.mockResolvedValueOnce("revoked");
    await request(app).delete("/orgs/google/accounts/kevin%40example.com").set(headers()).expect(200);
    const again = await request(app).delete("/orgs/google/accounts/kevin%40example.com").set(headers());
    // Either still purging (200) or already gone (404): never a hang, never a 5xx.
    expect([200, 404]).toContain(again.status);
    expect(mockRevokeGoogleToken).toHaveBeenCalledTimes(1);
    await awaitRunningPurges();
  });
});

describe("background purge survives a restart", () => {
  it("an interrupted purge is resumed on boot and completes", async () => {
    const id = await addAccount(ORG, "kevin@example.com", 10_000, 1_500);
    const keep = await addAccount(OTHER_ORG, "x@example.com", 100, 10);
    // State a process left behind when it died right after the disconnect answered.
    await query(
      `UPDATE google_oauth_tokens SET disconnected_at = NOW(), refresh_token = '' WHERE id = $1`,
      [id]
    );

    const partial = await purgeDisconnectedAccount(ORG, id, { batchSize: 1_000, maxBatches: 3, pauseMs: 0 });
    expect(partial).toEqual({ status: "interrupted", messages: 3_000, contacts: 0 });
    expect((await mirrorCounts(id)).raw).toBe(7_000);
    expect(await listed()).toEqual([]);

    // "Restart": a fresh scheduler, the boot hook.
    resetPurgeSchedulerForTests();
    expect(await resumePendingPurges()).toBe(1);
    await awaitRunningPurges();

    expect(await mirrorCounts(id)).toEqual({ raw: 0, silver: 0, craw: 0, csilver: 0, clean: 0, token: 0 });
    expect(await mirrorCounts(keep)).toEqual({ raw: 100, silver: 100, craw: 10, csilver: 10, clean: 100, token: 1 });
    expect(await resumePendingPurges()).toBe(0);
  }, 120_000);
});

describe("no ingest writes to a disconnecting mailbox", () => {
  it("refuses the bronze write (and so its silver) once disconnected, while a connected mailbox still writes", async () => {
    const id = await addAccount(ORG, "kevin@example.com", 10, 1);
    const other = await addAccount(ORG, "other@example.com", 0, 0);
    await query(`UPDATE google_oauth_tokens SET disconnected_at = NOW() WHERE id = $1`, [id]);

    const msg = { id: "late-1", threadId: "t-late", historyId: "77", payload: { id: "late-1", payload: { headers: [] } } };
    await expect(upsertMessage(ORG, id, msg)).rejects.toBeInstanceOf(AccountDisconnectedError);
    const none = await query(`SELECT count(*)::int AS n FROM gmail_messages_raw WHERE gmail_message_id = 'late-1'`, []);
    expect(none.rows[0].n).toBe(0);

    await expect(upsertMessage(ORG, other, msg)).resolves.toBe("inserted");
    const silver = await query(
      `SELECT google_account_id FROM gmail_messages_silver WHERE gmail_message_id = 'late-1'`,
      []
    );
    expect(silver.rows).toEqual([{ google_account_id: other }]);
  });

  it("an update of an already-mirrored message is refused too", async () => {
    const id = await addAccount(ORG, "kevin@example.com", 3, 0);
    await query(`UPDATE google_oauth_tokens SET disconnected_at = NOW() WHERE id = $1`, [id]);
    const msg = { id: "kevin@example.com-1", threadId: "t1", historyId: "999", payload: { id: "x" } };
    await expect(upsertMessage(ORG, id, msg)).rejects.toBeInstanceOf(AccountDisconnectedError);
    const row = await query(`SELECT history_id::text AS h FROM gmail_messages_raw WHERE gmail_message_id = $1`, [msg.id]);
    expect(row.rows[0].h).toBe("1");
  });
});

describe("reconnecting the same address", () => {
  const reconnect = () =>
    upsertGoogleToken({
      orgId: ORG,
      userId: USER,
      googleAccountEmail: "kevin@example.com",
      refreshToken: "rt-new",
      accessToken: "at-new",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
    });

  it("while the purge runs: takes the row back, the purge stops, sync state resets for a full re-mirror", async () => {
    const id = await addAccount(ORG, "kevin@example.com", 5_000, 10);
    await query(`UPDATE google_oauth_tokens SET disconnected_at = NOW(), refresh_token = '' WHERE id = $1`, [id]);
    await purgeDisconnectedAccount(ORG, id, { batchSize: 1_000, maxBatches: 2, pauseMs: 0 });

    const token = await reconnect();
    expect(token.id).toBe(id);
    expect(token.gmailHistoryId).toBeNull();
    expect(token.refreshToken).toBe("rt-new");
    expect(await listed()).toEqual(["kevin@example.com"]);

    const out = await purgeDisconnectedAccount(ORG, id, { pauseMs: 0 });
    expect(out).toEqual({ status: "reconnected" });
    expect((await mirrorCounts(id)).raw).toBe(3_000);
    // Writes are accepted again.
    await expect(
      upsertMessage(ORG, id, { id: "new-1", threadId: "t", historyId: "5", payload: { id: "new-1" } })
    ).resolves.toBe("inserted");
  });

  it("after the purge finished: a clean new connection", async () => {
    const id = await addAccount(ORG, "kevin@example.com", 100, 10);
    mockRevokeGoogleToken.mockResolvedValueOnce("revoked");
    await request(app).delete("/orgs/google/accounts/kevin%40example.com").set(headers()).expect(200);
    await awaitRunningPurges();

    const token = await reconnect();
    expect(token.id).not.toBe(id);
    expect(token.gmailHistoryId).toBeNull();
    expect(await listed()).toEqual(["kevin@example.com"]);
    expect((await mirrorCounts(token.id)).raw).toBe(0);
  });

  it("a connected address reconnects in place and keeps its mirror and sync state", async () => {
    const id = await addAccount(ORG, "kevin@example.com", 20, 2);
    const token = await reconnect();
    expect(token.id).toBe(id);
    expect(token.gmailHistoryId).toBe("42");
    expect((await mirrorCounts(id)).raw).toBe(20);
  });
});
