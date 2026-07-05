import net from "node:net";
import { Pool } from "pg";
import { env } from "../env";
import { withLibpqCompat } from "./ssl";
import { withConnectRetry } from "./retry";

// Neon scale-to-zero parks the compute after ~5 min idle; the first connection
// after that triggers a cold resume that can take several seconds. Node 20's
// happy-eyeballs gives each candidate address only 250ms, so the first query
// after idle fails with AggregateError [ETIMEDOUT] before the compute wakes.
// Widen the per-address attempt window to cover a cold resume.
net.setDefaultAutoSelectFamilyAttemptTimeout(5000);

export const pool = new Pool({
  connectionString: withLibpqCompat(env.GOOGLE_SERVICE_DATABASE_URL),
  max: 10,
  // Bound the connect wait so a genuinely dead host fails loud instead of
  // hanging forever — the post-TCP startup phase is not covered by the
  // happy-eyeballs attempt timeout above.
  connectionTimeoutMillis: 15_000,
});

// Retry only connection-ACQUISITION failures (cold Neon resume). Every db call
// in this service goes through pool.query (no transactions / pool.connect),
// including the boot migration, so wrapping pool.query is the single chokepoint
// covering all of them. The query has not been dispatched when these errors
// fire, so the retry is safe for writes too.
/* eslint-disable @typescript-eslint/no-explicit-any */
const baseQuery = pool.query.bind(pool) as (...args: any[]) => any;
pool.query = function retryingQuery(...args: any[]): any {
  // pg's callback form (last arg is a function) is not used here; only the
  // promise form is retryable.
  if (typeof args[args.length - 1] === "function") {
    return baseQuery(...args);
  }
  return withConnectRetry(() => baseQuery(...args), {
    onRetry: (attempt, delayMs, err) => {
      const detail = (err as { code?: string }).code ?? (err as Error)?.message;
      console.warn(
        `[google-service] DB connection failed (attempt ${attempt}), retrying in ${delayMs}ms: ${detail}`,
      );
    },
  });
} as typeof pool.query;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const query = (text: string, params?: unknown[]) =>
  pool.query(text, params);
