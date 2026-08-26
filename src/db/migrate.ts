import { pool } from "./client";

const migration = `
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  refresh_token_provider TEXT NOT NULL,
  mcc_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, account_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_accounts_org_id ON accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state);

-- Migration: drop app_id if it exists (idempotent)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'app_id') THEN
    ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_app_id_account_id_key;
    DROP INDEX IF EXISTS idx_accounts_app_id;
    ALTER TABLE accounts DROP COLUMN app_id;
    ALTER TABLE accounts ADD CONSTRAINT accounts_org_id_account_id_key UNIQUE (org_id, account_id);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'oauth_states' AND column_name = 'app_id') THEN
    ALTER TABLE oauth_states DROP COLUMN app_id;
  END IF;
END $$;

-- Migration: add feature_slug columns (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'feature_slug') THEN
    ALTER TABLE accounts ADD COLUMN feature_slug TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'oauth_states' AND column_name = 'feature_slug') THEN
    ALTER TABLE oauth_states ADD COLUMN feature_slug TEXT;
  END IF;
END $$;

-- ─── Google CRM bronze tables ───

CREATE TABLE IF NOT EXISTS google_oauth_pending (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL UNIQUE,
  pkce_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  feature_slug TEXT,
  brand_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
);
CREATE INDEX IF NOT EXISTS idx_google_oauth_pending_state ON google_oauth_pending(state);
CREATE INDEX IF NOT EXISTS idx_google_oauth_pending_org_id ON google_oauth_pending(org_id);

CREATE TABLE IF NOT EXISTS google_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  google_account_email TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  scopes TEXT NOT NULL,
  gmail_history_id BIGINT,
  people_sync_token TEXT,
  feature_slug TEXT,
  brand_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, google_account_email)
);
CREATE INDEX IF NOT EXISTS idx_google_oauth_tokens_org_id ON google_oauth_tokens(org_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'google_oauth_tokens' AND column_name = 'other_contacts_sync_token') THEN
    ALTER TABLE google_oauth_tokens ADD COLUMN other_contacts_sync_token TEXT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gmail_messages_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  google_account_id UUID NOT NULL REFERENCES google_oauth_tokens(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  history_id BIGINT NOT NULL,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, gmail_message_id)
);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_raw_org_id ON gmail_messages_raw(org_id);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_raw_account ON gmail_messages_raw(google_account_id);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_raw_thread ON gmail_messages_raw(thread_id);

CREATE TABLE IF NOT EXISTS google_contacts_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  google_account_id UUID NOT NULL REFERENCES google_oauth_tokens(id) ON DELETE CASCADE,
  resource_name TEXT NOT NULL,
  etag TEXT,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, resource_name)
);
CREATE INDEX IF NOT EXISTS idx_google_contacts_raw_org_id ON google_contacts_raw(org_id);
CREATE INDEX IF NOT EXISTS idx_google_contacts_raw_account ON google_contacts_raw(google_account_id);

-- ─── Async sync job tracking ───
-- POST /orgs/google/sync inserts a row with status='running' and returns 202+jobId
-- The HTTP handler returns immediately; a detached promise updates the row to
-- 'succeeded' (with summary) or 'failed' (with error) when ingest completes.
-- Caveat: a Railway redeploy mid-sync leaves the row stuck in 'running'.
CREATE TABLE IF NOT EXISTS google_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  summary JSONB,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_google_sync_jobs_org_started ON google_sync_jobs(org_id, started_at DESC);

-- ─── Google CRM silver tables (typed projections of the bronze *_raw payloads) ───
-- Populated at ingest (parsed from the bronze payload) and idempotently backfilled
-- from existing bronze on boot. Bronze remains the source of truth; silver is a
-- rebuildable view keyed on the same natural key as its bronze source.

CREATE TABLE IF NOT EXISTS google_contacts_silver (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  google_account_id UUID NOT NULL REFERENCES google_oauth_tokens(id) ON DELETE CASCADE,
  resource_name TEXT NOT NULL,
  etag TEXT,
  display_name TEXT,
  primary_email TEXT,
  emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  phones JSONB NOT NULL DEFAULT '[]'::jsonb,
  organization TEXT,
  job_title TEXT,
  photo_url TEXT,
  updated_at TIMESTAMPTZ,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  source_row_id UUID,
  last_rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, resource_name)
);
CREATE INDEX IF NOT EXISTS idx_google_contacts_silver_org ON google_contacts_silver(org_id);
CREATE INDEX IF NOT EXISTS idx_google_contacts_silver_email ON google_contacts_silver(org_id, lower(primary_email));

CREATE TABLE IF NOT EXISTS gmail_messages_silver (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  google_account_id UUID NOT NULL REFERENCES google_oauth_tokens(id) ON DELETE CASCADE,
  gmail_message_id TEXT NOT NULL,
  thread_id TEXT,
  from_email TEXT,
  from_name TEXT,
  to_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT,
  snippet TEXT,
  sent_at TIMESTAMPTZ,
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  history_id BIGINT,
  source_row_id UUID,
  last_rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, gmail_message_id)
);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_silver_org ON gmail_messages_silver(org_id);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_silver_sent ON gmail_messages_silver(org_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_gmail_messages_silver_thread ON gmail_messages_silver(thread_id);

-- ─── Per-contact CRM links (org/brand/feature tagging + reserved status) ───
-- One row per (org, Google contact resourceName). LEFT-JOINed onto
-- GET /orgs/google/contacts; upserted via PUT /orgs/google/contact-links.
-- resourceName lives in the request BODY (never the path) because Google
-- resourceNames contain "/". status is reserved (unused for now).
CREATE TABLE IF NOT EXISTS google_contact_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  linked_org_ids TEXT[] NOT NULL DEFAULT '{}',
  linked_brand_ids TEXT[] NOT NULL DEFAULT '{}',
  linked_feature_slugs TEXT[] NOT NULL DEFAULT '{}',
  status TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, resource_name)
);
CREATE INDEX IF NOT EXISTS idx_google_contact_links_org_id ON google_contact_links(org_id);

-- ─── Google Ads spend ledger (per campaign, per Google-reported day) ───
-- One row per (org, Ads account, campaign, spend_date). cost_micros/observed_cents
-- are what Google reports NOW; declared_cents is how much of it has already been
-- declared to runs-service. Google restates a day's cost, so each pass declares
-- only the DELTA (observed - declared) and never re-declares what it already did.
-- spend_date is GOOGLE's day (segments.date), never our poll day.
CREATE TABLE IF NOT EXISTS google_ads_spend_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  spend_date DATE NOT NULL,
  cost_micros BIGINT NOT NULL,
  observed_cents BIGINT NOT NULL,
  declared_cents BIGINT NOT NULL DEFAULT 0,
  run_id UUID,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_declared_at TIMESTAMPTZ,
  UNIQUE(org_id, account_id, campaign_id, spend_date)
);
CREATE INDEX IF NOT EXISTS idx_google_ads_spend_daily_org_date ON google_ads_spend_daily(org_id, spend_date DESC);
CREATE INDEX IF NOT EXISTS idx_google_ads_spend_daily_account ON google_ads_spend_daily(org_id, account_id, spend_date DESC);

-- ─── Managed advertiser accounts (created under OUR manager account) ───
-- The managed path advertises from the platform's own manager account: the
-- client supplies NO Google credential and never opens the Google Ads UI.
-- One row per Google Ads client account we created for an org. brand_id is
-- optional; when set it is unique per org so re-provisioning a brand returns
-- the account that already exists instead of creating a second one.
CREATE TABLE IF NOT EXISTS google_ads_managed_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  brand_id TEXT,
  account_id TEXT NOT NULL,
  manager_account_id TEXT NOT NULL,
  descriptive_name TEXT NOT NULL,
  currency_code TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_google_ads_managed_accounts_org ON google_ads_managed_accounts(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_ads_managed_accounts_org_brand
  ON google_ads_managed_accounts(org_id, brand_id) WHERE brand_id IS NOT NULL;
`;

export const runMigrations = async (): Promise<void> => {
  console.log("[google-service] Running migrations...");
  await pool.query(migration);
  console.log("[google-service] Migrations complete.");
};
