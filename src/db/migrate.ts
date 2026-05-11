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
`;

export const runMigrations = async (): Promise<void> => {
  console.log("[google-service] Running migrations...");
  await pool.query(migration);
  console.log("[google-service] Migrations complete.");
};
