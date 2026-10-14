import type { PoolClient } from "pg";
import { pool, query } from "../db/client";

// Background purge of a DISCONNECTED mailbox's mirror (GMAIL-DISCONNECT-HANGS-1014).
//
// DELETE /orgs/google/accounts/{email} used to delete the token row in the
// request and let ON DELETE CASCADE remove the mirror: ~682k messages (bronze,
// silver, cleaned bodies) in one statement, minutes long, racing the ingest
// that kept writing to the same mailbox. The request never answered and was
// cancelled, after the grant had already been revoked at Google.
//
// Now the request only marks the row (disconnected_at) and this module deletes
// the mirror in short batches:
//   - Every batch is one transaction that first locks the token row FOR NO KEY
//     UPDATE and re-checks it is still disconnected. A reconnect of the same
//     address (upsert on the row) waits for the in-flight batch, clears
//     disconnected_at, and the next batch stops: nothing it re-mirrors is purged.
//     The lock does not block FK KEY SHARE locks, so it never waits on an ingest.
//   - Every statement is scoped by org_id AND google_account_id: another org's
//     rows are never touched.
//   - Silver rows go in the same statement as their bronze row, by the silver
//     natural key (indexed), never a scan of a whole silver table.
//   - The token row goes LAST, so a restart mid-purge leaves a disconnected row
//     that `resumePendingPurges` (boot) picks up again. Its delete cascades over
//     whatever a late write left.
//   - A failure is logged and persisted on the row (purge_error), then retried
//     with backoff while the process lives, and on every boot.

export const PURGE_BATCH_SIZE = 2_000;
const PAUSE_BETWEEN_BATCHES_MS = 50;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export type PurgeOutcome =
  | { status: "purged"; messages: number; contacts: number }
  | { status: "reconnected" | "gone" }
  | { status: "interrupted"; messages: number; contacts: number };

export interface PurgeOptions {
  batchSize?: number;
  pauseMs?: number;
  // Stop after this many batches (tests simulate a restart mid-purge with it).
  maxBatches?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STOP = Symbol("stop");

// One transaction holding the token row lock. Returns STOP when the row is gone
// or reconnected.
const inLockedTx = async <T>(
  orgId: string,
  accountId: string,
  work: (client: PoolClient) => Promise<T>
): Promise<T | typeof STOP> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query(
      `SELECT 1 FROM google_oauth_tokens
        WHERE org_id = $1 AND id = $2 AND disconnected_at IS NOT NULL
        FOR NO KEY UPDATE`,
      [orgId, accountId]
    );
    if (lock.rows.length === 0) {
      await client.query("ROLLBACK");
      return STOP;
    }
    const out = await work(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

const deleteMessageBatch = async (
  client: PoolClient,
  orgId: string,
  accountId: string,
  limit: number
): Promise<number> => {
  // Cleaned bodies cascade from their bronze row (FK on the natural key).
  const res = await client.query(
    `WITH batch AS (
       SELECT org_id, gmail_message_id FROM gmail_messages_raw
        WHERE org_id = $1 AND google_account_id = $2
        LIMIT $3
     ),
     silver AS (
       DELETE FROM gmail_messages_silver s USING batch b
        WHERE s.org_id = b.org_id AND s.gmail_message_id = b.gmail_message_id
          AND s.google_account_id = $2
     )
     DELETE FROM gmail_messages_raw r USING batch b
      WHERE r.org_id = b.org_id AND r.gmail_message_id = b.gmail_message_id
        AND r.google_account_id = $2`,
    [orgId, accountId, limit]
  );
  return res.rowCount ?? 0;
};

const deleteContactBatch = async (
  client: PoolClient,
  orgId: string,
  accountId: string,
  limit: number
): Promise<number> => {
  const res = await client.query(
    `WITH batch AS (
       SELECT org_id, resource_name FROM google_contacts_raw
        WHERE org_id = $1 AND google_account_id = $2
        LIMIT $3
     ),
     silver AS (
       DELETE FROM google_contacts_silver s USING batch b
        WHERE s.org_id = b.org_id AND s.resource_name = b.resource_name
          AND s.google_account_id = $2
     )
     DELETE FROM google_contacts_raw r USING batch b
      WHERE r.org_id = b.org_id AND r.resource_name = b.resource_name
        AND r.google_account_id = $2`,
    [orgId, accountId, limit]
  );
  return res.rowCount ?? 0;
};

export const purgeDisconnectedAccount = async (
  orgId: string,
  accountId: string,
  opts: PurgeOptions = {}
): Promise<PurgeOutcome> => {
  const batchSize = opts.batchSize ?? PURGE_BATCH_SIZE;
  const pauseMs = opts.pauseMs ?? PAUSE_BETWEEN_BATCHES_MS;
  let batches = 0;
  const counts = { messages: 0, contacts: 0 };

  const steps: Array<[keyof typeof counts, typeof deleteMessageBatch]> = [
    ["messages", deleteMessageBatch],
    ["contacts", deleteContactBatch],
  ];
  for (const [key, step] of steps) {
    for (;;) {
      if (opts.maxBatches !== undefined && batches >= opts.maxBatches) {
        return { status: "interrupted", ...counts };
      }
      const n = await inLockedTx(orgId, accountId, (c) => step(c, orgId, accountId, batchSize));
      batches += 1;
      if (n === STOP) return await stoppedOutcome(orgId, accountId);
      counts[key] += n;
      if (n === 0) break;
      if (pauseMs > 0) await sleep(pauseMs);
    }
  }

  // Last: silver rows with no bronze left (a write that landed between batches),
  // then the row itself (its cascade covers anything later still).
  const done = await inLockedTx(orgId, accountId, async (c) => {
    await c.query(
      `DELETE FROM gmail_messages_silver WHERE org_id = $1 AND google_account_id = $2`,
      [orgId, accountId]
    );
    await c.query(
      `DELETE FROM google_contacts_silver WHERE org_id = $1 AND google_account_id = $2`,
      [orgId, accountId]
    );
    await c.query(
      `DELETE FROM google_oauth_tokens
        WHERE org_id = $1 AND id = $2 AND disconnected_at IS NOT NULL`,
      [orgId, accountId]
    );
    return true;
  });
  if (done === STOP) return await stoppedOutcome(orgId, accountId);
  return { status: "purged", ...counts };
};

const stoppedOutcome = async (orgId: string, accountId: string): Promise<PurgeOutcome> => {
  const row = await query(`SELECT 1 FROM google_oauth_tokens WHERE org_id = $1 AND id = $2`, [
    orgId,
    accountId,
  ]);
  return { status: row.rows.length > 0 ? "reconnected" : "gone" };
};

// ─── Scheduling: one purge per account per process, retried on failure ───

const running = new Map<string, Promise<void>>();
const retryTimers = new Map<string, NodeJS.Timeout>();

const runPurge = async (orgId: string, accountId: string, attempt: number): Promise<void> => {
  const startedAt = Date.now();
  try {
    const out = await purgeDisconnectedAccount(orgId, accountId);
    console.log(
      `[google-service] account purge org=${orgId} account=${accountId}: ${out.status}` +
        ("messages" in out ? ` messages=${out.messages} contacts=${out.contacts}` : "") +
        ` in ${Date.now() - startedAt}ms`
    );
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    console.error(
      `[google-service] account purge FAILED org=${orgId} account=${accountId} (attempt ${attempt + 1}), retrying in ${Math.round(delay / 1000)}s: ${message}`
    );
    await query(
      `UPDATE google_oauth_tokens SET purge_error = $3
        WHERE org_id = $1 AND id = $2 AND disconnected_at IS NOT NULL`,
      [orgId, accountId, message.slice(0, 2000)]
    ).catch((e) =>
      console.error(`[google-service] could not record purge_error for ${accountId}:`, e)
    );
    const timer = setTimeout(() => {
      retryTimers.delete(accountId);
      schedulePurge(orgId, accountId, attempt + 1);
    }, delay);
    timer.unref();
    retryTimers.set(accountId, timer);
  }
};

// Starts the purge of one disconnected account in the background (no-op if one
// is already running or waiting to retry in this process).
export const schedulePurge = (orgId: string, accountId: string, attempt = 0): Promise<void> => {
  const existing = running.get(accountId);
  if (existing) return existing;
  if (retryTimers.has(accountId) && attempt === 0) return Promise.resolve();
  const p = runPurge(orgId, accountId, attempt).finally(() => running.delete(accountId));
  running.set(accountId, p);
  return p;
};

// Boot: every account left disconnected by a previous process (restart mid-purge,
// failed purge) is purged again. Post-listen, fire-and-forget.
export const resumePendingPurges = async (): Promise<number> => {
  const res = await query(
    `SELECT org_id, id FROM google_oauth_tokens
      WHERE disconnected_at IS NOT NULL
      ORDER BY disconnected_at ASC`
  );
  for (const row of res.rows) {
    void schedulePurge(row.org_id as string, row.id as string);
  }
  if (res.rows.length > 0) {
    console.log(`[google-service] resuming ${res.rows.length} disconnected mailbox purge(s)`);
  }
  return res.rows.length;
};

// Tests: wait for every purge running in this process.
export const awaitRunningPurges = async (): Promise<void> => {
  while (running.size > 0) {
    await Promise.all([...running.values()]);
  }
};

export const resetPurgeSchedulerForTests = (): void => {
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
  running.clear();
};
