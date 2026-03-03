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
`;

async function migrate() {
  console.log("Running migrations...");
  await pool.query(migration);
  console.log("Migrations complete.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
