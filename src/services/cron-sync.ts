import { query } from "../db/client";
import { env } from "../env";
import { syncOrg } from "./sync";
import type { CallerContext } from "./key-service";

const CRON_CALLER: CallerContext = { method: "CRON", path: "/cron/auto-sync" };

// One auto-sync pass: sync every org that has at least one connected Google
// account. Each org is isolated — one org's failure does not abort the rest.
// Uses the shared pool (a fresh connection is acquired per query), so no
// long-lived connection is held between the 6-hourly ticks (Neon scale-to-zero
// stays effective).
export const runAutoSyncOnce = async (): Promise<void> => {
  const res = await query(`SELECT DISTINCT org_id FROM google_oauth_tokens`);
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
