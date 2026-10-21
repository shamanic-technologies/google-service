import { query } from "../db/client";
import { env } from "../env";
import { syncOrg } from "./sync";
import { ingestGmailForAccount } from "./gmail-ingest";
import { listGmailDeltaAccounts } from "./google-tokens";
import { listAllCalendarAccounts, syncCalendarAccount } from "./calendar";
import type { CallerContext } from "./key-service";

const CRON_CALLER: CallerContext = { method: "CRON", path: "/cron/auto-sync" };
const FRESH_CALLER: CallerContext = { method: "CRON", path: "/cron/gmail-fresh" };
// First fresh tick after boot. Deploys recreate the container far more often
// than a long interval fires, so the first tick must not wait a whole interval;
// it is delta-only, so firing soon after boot cannot become a backfill storm.
const FRESH_FIRST_TICK_MS = 60_000;

// One auto-sync pass: sync every org that has at least one connected Google
// account. Each org is isolated — one org's failure does not abort the rest.
// Uses the shared pool (a fresh connection is acquired per query), so no
// long-lived connection is held between ticks.
export const runAutoSyncOnce = async (): Promise<void> => {
  const res = await query(`SELECT DISTINCT org_id FROM google_oauth_tokens WHERE disconnected_at IS NULL`);
  const orgIds = res.rows.map((r) => r.org_id as string);
  console.log(`[google-service] auto-sync starting for ${orgIds.length} org(s)`);

  for (const orgId of orgIds) {
    try {
      const summary = await syncOrg(orgId, CRON_CALLER);
      console.log(
        `[google-service] auto-sync org=${orgId} done: ` +
          `gmail+${summary.gmail.inserted}/${summary.gmail.updated} ` +
          `contacts+${summary.contacts.inserted}/${summary.contacts.updated}`
      );
    } catch (err) {
      console.error(
        `[google-service] auto-sync failed for org=${orgId}: ${(err as Error).message}`
      );
    }
  }
};

// Schedule the periodic auto-sync. First tick fires after one interval (not at
// boot) to avoid a redeploy-triggered sync storm. Returns the timer for tests.
export const startAutoSync = (): NodeJS.Timeout => {
  const hours = env.GOOGLE_SYNC_INTERVAL_HOURS;
  const intervalMs = Math.round(hours * 60 * 60 * 1000);
  console.log(`[google-service] auto-sync scheduled every ${hours}h`);
  const timer = setInterval(() => {
    void runAutoSyncOnce().catch((err) =>
      console.error(`[google-service] auto-sync tick failed: ${(err as Error).message}`)
    );
  }, intervalMs);
  timer.unref();
  return timer;
};

// One Gmail fresh pass: a DELTA (Gmail history since the stored historyId) for
// every caught-up mailbox. Accounts with no historyId (never synced, or a
// backfill still in flight) are left to the full sync, so this tick never
// backfills. Each account is isolated: one failure does not skip the rest.
export const runGmailFreshOnce = async (): Promise<void> => {
  const accounts = await listGmailDeltaAccounts();
  for (const account of accounts) {
    try {
      const result = await ingestGmailForAccount(account, FRESH_CALLER, "", undefined, undefined);
      if (result.inserted + result.updated > 0) {
        console.log(
          `[google-service] gmail-fresh org=${account.orgId} account=${account.id}: ` +
            `+${result.inserted}/${result.updated}`
        );
      }
    } catch (err) {
      console.error(
        `[google-service] gmail-fresh failed for org=${account.orgId} account=${account.id}: ${(err as Error).message}`
      );
    }
  }
};

// Schedule the Gmail fresh pass: first tick ~60s after boot, then the next one
// `GOOGLE_GMAIL_FRESH_INTERVAL_MINUTES` after the previous one FINISHED. Chained
// timeouts, never setInterval: a slow pass can never overlap the next one.
export const startGmailFreshSync = (): void => {
  const minutes = env.GOOGLE_GMAIL_FRESH_INTERVAL_MINUTES;
  const intervalMs = Math.round(minutes * 60 * 1000);
  console.log(`[google-service] gmail-fresh scheduled every ${minutes}min`);
  const schedule = (delayMs: number) => {
    const timer = setTimeout(() => {
      void runGmailFreshOnce()
        .catch((err) =>
          console.error(`[google-service] gmail-fresh tick failed: ${(err as Error).message}`)
        )
        .finally(() => schedule(intervalMs));
    }, delayMs);
    timer.unref();
  };
  schedule(FRESH_FIRST_TICK_MS);
};

const CALENDAR_CALLER: CallerContext = { method: "CRON", path: "/cron/calendar-sync" };

// One pass over every connected Google Calendar. Each calendar is isolated: one
// failure (stored on its row as last_sync_error) does not skip the rest.
export const runCalendarSyncOnce = async (): Promise<void> => {
  const accounts = await listAllCalendarAccounts();
  for (const account of accounts) {
    try {
      const s = await syncCalendarAccount(account, CALENDAR_CALLER);
      if (s.inserted + s.updated + s.meetFound > 0) {
        console.log(
          `[google-service] calendar-sync org=${account.orgId} account=${account.id}: ` +
            `+${s.inserted}/${s.updated} meet ${s.meetFound}/${s.meetChecked}`
        );
      }
    } catch (err) {
      console.error(
        `[google-service] calendar-sync failed for org=${account.orgId} account=${account.id}: ${(err as Error).message}`
      );
    }
  }
};

// Same cadence model as the Gmail fresh pass: first tick ~60s after boot, then
// one interval after the previous pass FINISHED (chained, never overlapping).
export const startCalendarSync = (): void => {
  const minutes = env.GOOGLE_CALENDAR_SYNC_INTERVAL_MINUTES;
  const intervalMs = Math.round(minutes * 60 * 1000);
  console.log(`[google-service] calendar-sync scheduled every ${minutes}min`);
  const schedule = (delayMs: number) => {
    const timer = setTimeout(() => {
      void runCalendarSyncOnce()
        .catch((err) =>
          console.error(`[google-service] calendar-sync tick failed: ${(err as Error).message}`)
        )
        .finally(() => schedule(intervalMs));
    }, delayMs);
    timer.unref();
  };
  schedule(FRESH_FIRST_TICK_MS);
};
