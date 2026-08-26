import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  GOOGLE_SERVICE_DATABASE_URL: z.string().min(1),
  GOOGLE_SERVICE_API_KEY: z.string().min(1),
  KEY_SERVICE_URL: z.string().url(),
  KEY_SERVICE_API_KEY: z.string().min(1),
  RUNS_SERVICE_URL: z.string().url(),
  RUNS_SERVICE_API_KEY: z.string().min(1),
  BILLING_SERVICE_URL: z.string().url(),
  BILLING_SERVICE_API_KEY: z.string().min(1),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_GMAIL_BACKFILL_DAYS: z.coerce.number().int().min(1).default(365),
  // Interval (hours) between automatic background syncs of all connected
  // Google accounts. Low-frequency by design so Neon scale-to-zero is respected.
  GOOGLE_SYNC_INTERVAL_HOURS: z.coerce.number().min(0.1).default(6),
  // Interval (hours) between Google Ads spend ingestion passes. Deliberately on
  // its OWN schedule, never chained to campaign create/update: Google publishes
  // a day's spend well after the fact, so a read that follows a write in the
  // same job always observes nothing and silently makes result latency equal
  // the writing job's interval.
  GOOGLE_ADS_SPEND_INTERVAL_HOURS: z.coerce.number().min(0.1).default(12),
  // How many days back each spend pass re-reads. Google restates a day's cost
  // for up to ~3 days (and conversions longer), so a window wider than one day
  // is what lets a restatement be picked up and declared as a delta.
  GOOGLE_ADS_SPEND_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(90).default(7),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
