// GOOGLE-TOKENS-AT-REST-1127, on a REAL Postgres (PGlite, the real migration):
// a full read of the database never yields a usable Google credential. Every
// refresh/access token (mailbox, calendar, Search Console) is stored as
// AES-256-GCM ciphertext with a key that lives only in the env; the read and
// refresh paths decrypt it; rows written in clear before this change are
// encrypted in place at boot; a missing key fails the boot.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "test-google-service-key",
    GOOGLE_GMAIL_BACKFILL_DAYS: 365,
  },
}));

vi.mock("../db/client", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const query = async (sql: string, params?: unknown[]) => {
    if (!params || params.length === 0) {
      const rs = await db.exec(sql);
      const last = rs[rs.length - 1] ?? { rows: [], affectedRows: 0 };
      return { rows: last.rows as Record<string, unknown>[], rowCount: last.affectedRows ?? 0 };
    }
    const r = await db.query(sql, params);
    return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? 0 };
  };
  return { pool: { query }, query };
});

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../services/google-oauth", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-oauth");
  return { ...actual, refreshAccessToken: (...a: unknown[]) => mocks.refresh(...a) };
});
vi.mock("../services/key-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/key-service");
  return { ...actual, getGoogleOAuthClient: vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "cs" }) };
});

import { query } from "../db/client";
import { runMigrations } from "../db/migrate";
import {
  ENCRYPTION_KEY_ENV,
  EncryptionKeyMissingError,
  assertEncryptionKey,
  decryptToken,
  encryptToken,
} from "../lib/token-crypto";
import { encryptStoredTokens } from "../services/encrypt-tokens-at-rest";
import {
  ensureFreshAccessToken,
  listOrgGoogleAccounts,
  upsertGoogleToken,
} from "../services/google-tokens";
import { listAllCalendarAccounts, upsertCalendarAccount } from "../services/calendar";
import { listAllSearchConsoleAccounts, upsertSearchConsoleAccount } from "../services/search-console";

const ORG = "00000000-0000-4000-a000-000000000001";
const USER = "00000000-0000-4000-a000-000000000002";
const RT = "1//refresh-token-PLAINTEXT";
const AT = "ya29.access-token-PLAINTEXT";
const TABLES = ["google_oauth_tokens", "google_calendar_accounts", "google_search_console_accounts"];

/** Every token cell of every table, as the database holds it (what a dump would show). */
const rawTokenCells = async (): Promise<string[]> => {
  const cells: string[] = [];
  for (const t of TABLES) {
    const r = await query(`SELECT refresh_token, access_token FROM ${t}`);
    for (const row of r.rows) {
      cells.push(row.refresh_token as string);
      if (row.access_token != null) cells.push(row.access_token as string);
    }
  }
  return cells;
};

beforeAll(async () => {
  await runMigrations();
}, 60_000);

beforeEach(async () => {
  for (const t of TABLES) await query(`DELETE FROM ${t}`);
  mocks.refresh.mockReset();
});

describe("token cipher", () => {
  const saved = process.env[ENCRYPTION_KEY_ENV];
  afterEach(() => {
    process.env[ENCRYPTION_KEY_ENV] = saved;
  });

  it("round-trips, never contains the plaintext, and uses a fresh IV per write", () => {
    const a = encryptToken(RT);
    const b = encryptToken(RT);
    expect(a).toMatch(/^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(a).not.toContain(RT);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(RT);
  });

  it("refuses a value that is not ciphertext instead of returning it", () => {
    expect(() => decryptToken(RT)).toThrow(/not encrypted/);
  });

  it("refuses a ciphertext that was tampered with or written under another key", () => {
    const enc = encryptToken(RT);
    process.env[ENCRYPTION_KEY_ENV] = "f".repeat(64);
    expect(() => decryptToken(enc)).toThrow();
  });

  it("a missing or malformed key fails loud", () => {
    delete process.env[ENCRYPTION_KEY_ENV];
    expect(() => assertEncryptionKey()).toThrow(EncryptionKeyMissingError);
    expect(() => encryptToken(RT)).toThrow(EncryptionKeyMissingError);
    process.env[ENCRYPTION_KEY_ENV] = "not-hex";
    expect(() => assertEncryptionKey()).toThrow(EncryptionKeyMissingError);
  });
});

describe("stored rows hold ciphertext only; read paths decrypt", () => {
  it("mailbox: connect, read, refresh", async () => {
    const stored = await upsertGoogleToken({
      orgId: ORG,
      userId: USER,
      googleAccountEmail: "kevin@example.com",
      refreshToken: RT,
      accessToken: AT,
      accessTokenExpiresAt: new Date(Date.now() - 1000), // expired: forces a refresh
      scopes: "https://www.googleapis.com/auth/gmail.readonly",
    });
    expect(stored.refreshToken).toBe(RT);
    expect(stored.accessToken).toBe(AT);

    const [account] = await listOrgGoogleAccounts(ORG);
    expect(account.refreshToken).toBe(RT);
    expect(account.accessToken).toBe(AT);

    mocks.refresh.mockResolvedValueOnce({ access_token: "ya29.REFRESHED-PLAINTEXT", expires_in: 3600 });
    const fresh = await ensureFreshAccessToken(account, { orgId: ORG, userId: USER, runId: "r" } as never);
    expect(fresh).toBe("ya29.REFRESHED-PLAINTEXT");
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: RT }));

    const cells = await rawTokenCells();
    expect(cells).toHaveLength(2);
    for (const c of cells) {
      expect(c.startsWith("enc:v1:")).toBe(true);
      expect(c).not.toContain("PLAINTEXT");
    }
    expect((await listOrgGoogleAccounts(ORG))[0].accessToken).toBe("ya29.REFRESHED-PLAINTEXT");
  });

  it("calendar and Search Console", async () => {
    const params = {
      orgId: ORG,
      userId: USER,
      googleAccountEmail: "kevin@example.com",
      refreshToken: RT,
      accessToken: AT,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: "s",
    };
    await upsertCalendarAccount(params);
    await upsertSearchConsoleAccount(params);

    const [cal] = await listAllCalendarAccounts();
    const [gsc] = await listAllSearchConsoleAccounts();
    expect([cal.refreshToken, cal.accessToken, gsc.refreshToken, gsc.accessToken]).toEqual([RT, AT, RT, AT]);

    const cells = await rawTokenCells();
    expect(cells).toHaveLength(4);
    for (const c of cells) expect(c).not.toContain("PLAINTEXT");
  });
});

describe("boot migration of rows written in clear", () => {
  it("encrypts every plaintext token in place, skips wiped ones, and is idempotent", async () => {
    await query(
      `INSERT INTO google_oauth_tokens (org_id, user_id, google_account_email, refresh_token, access_token, scopes, disconnected_at)
       VALUES ($1, $2, 'a@example.com', $3, $4, 's', NULL),
              ($1, $2, 'gone@example.com', '', NULL, 's', NOW())`,
      [ORG, USER, RT, AT]
    );
    await query(
      `INSERT INTO google_calendar_accounts (org_id, user_id, google_account_email, refresh_token, access_token, scopes)
       VALUES ($1, $2, 'a@example.com', $3, NULL, 's')`,
      [ORG, USER, RT]
    );
    await query(
      `INSERT INTO google_search_console_accounts (org_id, user_id, google_account_email, refresh_token, access_token, scopes)
       VALUES ($1, $2, 'a@example.com', $3, $4, 's')`,
      [ORG, USER, RT, AT]
    );

    const first = await encryptStoredTokens();
    expect(first.encrypted).toEqual({
      "google_oauth_tokens.refresh_token": 1,
      "google_oauth_tokens.access_token": 1,
      "google_calendar_accounts.refresh_token": 1,
      "google_calendar_accounts.access_token": 0,
      "google_search_console_accounts.refresh_token": 1,
      "google_search_console_accounts.access_token": 1,
    });

    const cells = await rawTokenCells();
    expect(cells.filter((c) => c === "")).toHaveLength(1); // the disconnected mailbox stays wiped
    for (const c of cells.filter((c) => c !== "")) {
      expect(c.startsWith("enc:v1:")).toBe(true);
      expect(c).not.toContain("PLAINTEXT");
    }

    const second = await encryptStoredTokens();
    expect(Object.values(second.encrypted).every((n) => n === 0)).toBe(true);

    const [mailbox] = await listOrgGoogleAccounts(ORG);
    expect([mailbox.refreshToken, mailbox.accessToken]).toEqual([RT, AT]);
    expect((await listAllCalendarAccounts())[0].refreshToken).toBe(RT);
    expect((await listAllSearchConsoleAccounts())[0].accessToken).toBe(AT);
  });
});
