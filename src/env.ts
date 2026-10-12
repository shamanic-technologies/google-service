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
  // chat-service: Jev judgments (classification billed input-only) used to tell
  // the sender's own words from footers/signatures in conversation bodies.
  CHAT_SERVICE_URL: z.string().url(),
  CHAT_SERVICE_API_KEY: z.string().min(1),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_GMAIL_BACKFILL_DAYS: z.coerce.number().int().min(1).default(365),
  // Interval (hours) between the FULL background sync of all connected Google
  // accounts (Gmail + People + otherContacts, backfill when a mailbox has none).
  GOOGLE_SYNC_INTERVAL_HOURS: z.coerce.number().min(0.1).default(6),
  // Interval (minutes) between Gmail-only DELTA passes over every mailbox that
  // is already caught up. Keeps the mirror ~15 min fresh so an answer one of our
  // people sends from Gmail clears "Needs your call" quickly (owner 2026-10-12).
  GOOGLE_GMAIL_FRESH_INTERVAL_MINUTES: z.coerce.number().min(1).default(15),
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
