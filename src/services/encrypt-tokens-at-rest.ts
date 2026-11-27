// GOOGLE-TOKENS-AT-REST-1127: encrypts, in place, every Google OAuth token a row
// still holds in clear (rows written before tokens were encrypted at write).
//
// Runs on every boot BEFORE listen: the readers decrypt and refuse plaintext, so
// a row left in clear would fail its sync. Safe in the boot window: N = connected
// Google accounts (a handful of rows across three tables), and once every row is
// encrypted the pass is three index-free SELECTs returning nothing. Idempotent:
// a value already `enc:v1:` is never touched, and each UPDATE is a compare-and-set
// on the old value so a concurrent write (a reconnect) is never overwritten.
// Disconnected mailboxes hold refresh_token = '' (wiped): nothing to encrypt.
import { query } from "../db/client";
import { ENCRYPTED_PREFIX, encryptToken } from "../lib/token-crypto";

const TABLES = ["google_oauth_tokens", "google_calendar_accounts", "google_search_console_accounts"] as const;
const COLUMNS = ["refresh_token", "access_token"] as const;

export interface EncryptAtRestSummary {
  encrypted: Record<string, number>;
}

export const encryptStoredTokens = async (): Promise<EncryptAtRestSummary> => {
  const encrypted: Record<string, number> = {};
  for (const table of TABLES) {
    for (const column of COLUMNS) {
      const rows = await query(
        `SELECT id, ${column} AS value FROM ${table}
          WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${column} NOT LIKE $1`,
        [`${ENCRYPTED_PREFIX}%`]
      );
      let n = 0;
      for (const row of rows.rows as Array<{ id: string; value: string }>) {
        const res = await query(
          `UPDATE ${table} SET ${column} = $3 WHERE id = $1 AND ${column} = $2`,
          [row.id, row.value, encryptToken(row.value)]
        );
        n += res.rowCount ?? 0;
      }
      encrypted[`${table}.${column}`] = n;
    }
  }
  return { encrypted };
};
