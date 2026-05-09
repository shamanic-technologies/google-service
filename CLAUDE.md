# google-service

Google Ads API v23 wrapper for MCC agency management, plus Google CRM bronze ingestion (Gmail + People readonly) feeding the dashboard CRM at `/orgs/{orgId}/services/crm`.

## Identity

All endpoints require `x-org-id` and `x-user-id` headers (UUIDs from client-service).
These are the internal org/user identifiers — never use Clerk IDs (clerkOrgId/clerkUserId).
The client-service is the source of truth for identity resolution.

## Stack

See global CLAUDE.md for shared stack details (TypeScript strict, Zod, Vitest+Supertest, Railway).

## Cold start (instrumentation.ts)

`src/instrumentation.ts` runs once at boot from `src/index.ts`. It reads `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` from the environment and registers them as platform keys via `POST /platform-keys` against key-service (providers `google-oauth-client-id`, `google-oauth-client-secret`).

**Do not read `GOOGLE_OAUTH_CLIENT_SECRET` from env anywhere else.** Business logic must call `getGoogleOAuthClient()` in `src/services/key-service.ts`, which decrypts via key-service at runtime.

## Migrations

`src/db/migrate.ts` exports `runMigrations()` which is awaited from `src/index.ts` **before** `app.listen()`. Every Railway deploy runs the migration; missing tables block startup so a bad migration triggers Railway's restart loop loudly instead of serving 500s.

Schema changes: edit the inline `migration` SQL in `src/db/migrate.ts`. Use `CREATE TABLE IF NOT EXISTS` / `DO $$ ... IF NOT EXISTS ... END $$` so the same migration runs cleanly on every boot.

Manual one-off run still available via `pnpm migrate` (CLI guard via `require.main === module`).

## Data layering

This service owns **bronze** for Google CRM data. Silver/gold are out of scope (see triggers below).

### Bronze tables

| Table | Natural key | Source | Notes |
|-------|-------------|--------|-------|
| `google_oauth_pending` | `(org_id, state)` | OAuth start | 10 min TTL, stores PKCE verifier |
| `google_oauth_tokens` | `(org_id, google_account_email)` | OAuth callback | One row per (org, Gmail account). Stores refresh token, last access token, `gmail_history_id`, `people_sync_token` |
| `gmail_messages_raw` | `(org_id, gmail_message_id)` | Gmail `messages.get format=full` | Full JSON payload in `payload jsonb` |
| `google_contacts_raw` | `(org_id, resource_name)` | People `connections.list` | Full JSON payload in `payload jsonb` |

All bronze tables are `org_id`-scoped. Every SQL query in `/orgs/google/*` includes `WHERE org_id = $N`.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/orgs/google/auth/start` | Build authorize URL (PKCE), persist pending state |
| `GET` | `/orgs/google/auth/callback` | Exchange code, store tokens. Browser callback is proxied by the dashboard server-side so identity headers are present. |
| `POST` | `/orgs/google/sync` | Backfill on first sync (last `GOOGLE_GMAIL_BACKFILL_DAYS` for Gmail), delta thereafter (Gmail `historyId`, People `syncToken`). Fan-out per connected Google account. |
| `GET` | `/orgs/google/messages` | Cursor-paginated raw Gmail messages |
| `GET` | `/orgs/google/contacts` | Cursor-paginated raw Google contacts (text `query` matches `payload::text ILIKE`) |

### Idempotency strategy: upsert-when-different

Sync re-runs produce no duplicate rows because each bronze table has a `UNIQUE` constraint on its natural key:

- `gmail_messages_raw`: `ON CONFLICT (org_id, gmail_message_id) DO UPDATE … WHERE history_id IS DISTINCT FROM EXCLUDED.history_id` — re-fetched messages with the same `historyId` are no-ops; mutations bump `payload` and `fetched_at`.
- `google_contacts_raw`: same pattern keyed on `etag`.

Append-only is preserved in spirit: we never mutate audit metadata; we only refresh `payload + fetched_at` when the upstream artefact changes.

### Sync model: synchronous in v1

The `/orgs/google/sync` endpoint runs synchronously inside the request. **Trade-off**: the request blocks until the full backfill or delta completes; on first sync against a busy mailbox this can exceed 30s.

**Trigger to queue**: when the average sync exceeds 30s (or the p95 exceeds 60s), introduce a worker queue (BullMQ / pgmq) and have `/sync` enqueue a job + return `202 Accepted`. The response shape will need a `jobId` and a polling endpoint.

### Future silver trigger

Build a silver `messages` / `contacts` / `humans` projection only when one of the following is true:

1. The dashboard CRM UI demands faceted search, cross-source joins, or typed filters that Postgres views over `jsonb` cannot satisfy efficiently.
2. A second source (LinkedIn, Apollo, manual import) feeds the same canonical `Human` and merging is required.
3. Multiple consumers query the same projection and bronze re-projection is too expensive each time.

Until then, the dashboard reads bronze directly via `/orgs/google/messages` and `/orgs/google/contacts`.

## OAuth flow

```
dashboard → POST /orgs/google/auth/start  → { url, state }
browser   → Google                         (user consents)
Google    → dashboard /services/crm/oauth/callback?code&state
dashboard → GET /orgs/google/auth/callback?code&state  (server-side, with identity headers)
google-service → google_oauth_tokens row (refresh + access)
```

The dashboard proxies the Google → service hop so the identity headers (`x-api-key`, `x-org-id`, `x-user-id`, `x-run-id`) can be attached.
