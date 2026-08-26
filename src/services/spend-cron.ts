import { env } from "../env";
import { runSpendIngestOnce } from "./spend-ingest";

/**
 * The Google Ads spend read runs on its OWN schedule and is deliberately NOT
 * chained to anything that creates or mutates a campaign: Google publishes a
 * day's spend hours after the fact, so a read that follows a write in the same
 * job observes nothing and makes result latency silently equal the writing
 * job's interval. Both steps would still report success.
 *
 * It is also kept separate from the CRM auto-sync (`cron-sync.ts`) — that one is
 * low-frequency by design and reads a different provider surface entirely.
 * Neither timer exists to touch the database; each does work someone asked for,
 * and each query takes a fresh pool connection rather than holding one open.
 */
const FIRST_TICK_DELAY_MS = 5 * 60 * 1000;

export const startSpendSync = (): NodeJS.Timeout => {
  const hours = env.GOOGLE_ADS_SPEND_INTERVAL_HOURS;
  const intervalMs = Math.round(hours * 60 * 60 * 1000);
  console.log(
    `[google-service] ads-spend ingest scheduled every ${hours}h ` +
      `(lookback ${env.GOOGLE_ADS_SPEND_LOOKBACK_DAYS}d)`
  );

  const tick = () =>
    void runSpendIngestOnce().catch((err) =>
      console.error(`[google-service] ads-spend tick failed: ${(err as Error).message}`)
    );

  // First pass shortly after boot (not AT boot — the listen path stays clear),
  // then on its own interval. Waiting a full interval would mean a container
  // that restarts often never gets to a first pass.
  const first = setTimeout(tick, FIRST_TICK_DELAY_MS);
  first.unref();

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
};
