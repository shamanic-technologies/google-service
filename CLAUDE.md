# google-service

Google Ads API v23 wrapper for MCC agency management, plus Google CRM bronze ingestion (Gmail + People readonly) feeding the dashboard CRM at `/orgs/{orgId}/services/crm`.

## Identity

All endpoints require `x-org-id` and `x-user-id` headers (UUIDs from client-service).
These are the internal org/user identifiers — never use Clerk IDs (clerkOrgId/clerkUserId).
The client-service is the source of truth for identity resolution.

## Stack

See global CLAUDE.md for shared stack details (TypeScript strict, Zod, Vitest+Supertest, Railway).

**Package manager: npm.** Lockfile is `package-lock.json`; the Dockerfile runs `npm ci`. Use `npm install` / `npm test` / `npm run build` locally. Do NOT run `pnpm install` here — it creates a stray `pnpm-lock.yaml` that diverges from the lockfile Railway actually reads.

## OAuth client credentials

The Google OAuth client (Client ID + Secret) is the **same** for the Google Ads Developer Console and the Gmail/People consent flow — one Google Cloud project, one OAuth client. It is registered as platform keys `google-client-id` / `google-client-secret` by the dashboard (`apps/dashboard/src/instrumentation.ts`), not by this service.

Business logic must call `getGoogleOAuthClient()` in `src/services/key-service.ts` to fetch the OAuth client at runtime; never read `GOOGLE_*` env vars directly. If `getGoogleOAuthClient()` returns 404, the dashboard side has not yet registered the providers — fix it there, not here.

## Migrations

`src/db/migrate.ts` exports `runMigrations()` which is awaited from `src/index.ts` **before** `app.listen()`. Every Railway deploy runs the migration; missing tables block startup so a bad migration triggers Railway's restart loop loudly instead of serving 500s.

Schema changes: edit the inline `migration` SQL in `src/db/migrate.ts`. Use `CREATE TABLE IF NOT EXISTS` / `DO $$ ... IF NOT EXISTS ... END $$` so the same migration runs cleanly on every boot.

Manual one-off run still available via `pnpm migrate`, which runs `src/db/migrate-cli.ts`. The CLI runner lives in a **separate file** from `migrate.ts` because `esbuild --bundle --format=cjs` inlines every imported file into `dist/index.js`, and at runtime `require.main === module` evaluates **true** for the bundled entry — so a CLI guard inside `migrate.ts` would fire at boot and call `pool.end()` after migrations, crashing every subsequent request with `Cannot use a pool after calling end on the pool`. Reference: hotfix v0.19.1.

## Data layering

This service owns **bronze** for Google CRM data. Silver/gold are out of scope (see triggers below).

### Bronze tables

| Table | Natural key | Source | Notes |
|-------|-------------|--------|-------|
| `google_oauth_pending` | `(org_id, state)` | OAuth start | 10 min TTL, stores PKCE verifier |
| `google_oauth_tokens` | `(org_id, google_account_email)` | OAuth callback | One row per (org, Gmail account). Stores refresh token, last access token, `gmail_history_id`, `people_sync_token`, `other_contacts_sync_token` |
| `gmail_messages_raw` | `(org_id, gmail_message_id)` | Gmail `messages.get format=full` | Full JSON payload in `payload jsonb` |
| `google_contacts_raw` | `(org_id, resource_name)` | People `connections.list` AND `otherContacts.list` | Full JSON payload in `payload jsonb`. `resource_name` namespace distinguishes sources: `people/c...` = address book, `otherContacts/c...` = Gmail-collected. |
| `google_sync_jobs` | `id` (UUID) | `POST /orgs/google/sync` | One row per sync request. `status` ∈ `running` \| `succeeded` \| `failed`; `summary` jsonb on success, `error` text on failure. Org-scoped lookups (`WHERE org_id = $1 AND id = $2`). |

All bronze tables (and `google_sync_jobs`) are `org_id`-scoped. Every SQL query in `/orgs/google/*` includes `WHERE org_id = $N`.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/orgs/google/auth/start` | Build authorize URL (PKCE), persist pending state |
| `GET` | `/orgs/google/auth/callback` | Exchange code, store tokens. Browser callback is proxied by the dashboard server-side so identity headers are present. |
| `POST` | `/orgs/google/sync` | Start an async sync. Inserts a `google_sync_jobs` row, fires ingest in a detached promise, returns `202 {jobId, status:"running"}` immediately. Backfill on first run (last `GOOGLE_GMAIL_BACKFILL_DAYS` for Gmail), delta thereafter (Gmail `historyId`, People `syncToken`). Fan-out per connected Google account. |
| `GET` | `/orgs/google/sync/{jobId}` | Poll job status. Returns `{jobId, status, summary, error, startedAt, finishedAt}`. Org-scoped: 404 if `jobId` belongs to another org. |
| `GET` | `/orgs/google/messages` | Cursor-paginated raw Gmail messages |
| `GET` | `/orgs/google/contacts` | Cursor-paginated raw Google contacts (text `query` matches `payload::text ILIKE`) |

### Idempotency strategy: upsert-when-different

Sync re-runs produce no duplicate rows because each bronze table has a `UNIQUE` constraint on its natural key:

- `gmail_messages_raw`: `ON CONFLICT (org_id, gmail_message_id) DO UPDATE … WHERE history_id IS DISTINCT FROM EXCLUDED.history_id` — re-fetched messages with the same `historyId` are no-ops; mutations bump `payload` and `fetched_at`.
- `google_contacts_raw`: same pattern keyed on `etag`.

Append-only is preserved in spirit: we never mutate audit metadata; we only refresh `payload + fetched_at` when the upstream artefact changes.

### Sync model: fire-and-forget + status table

`POST /orgs/google/sync` is async. The handler:

1. Inserts a `google_sync_jobs` row with `status='running'`.
2. Calls `runSyncInBackground({ jobId, orgId, ... })` which kicks off a detached promise (`void runSync(...).catch(...)`) — the HTTP handler does NOT await it.
3. Returns `202 {jobId, status:"running"}` immediately.

The detached promise updates the row to `succeeded` (with `summary` jsonb) or `failed` (with `error` text) once Gmail + People (`connections.list` + `otherContacts.list`) ingest finishes. Callers poll `GET /orgs/google/sync/{jobId}` until `status != 'running'`. People connections (address book) and otherContacts (Gmail-collected) results are summed into a single `summary.contacts` accumulator — the UI does not distinguish the two sources. Tokens minted before the `contacts.other.readonly` scope was added skip the `otherContacts.list` call with a `console.warn`; the user must reauth to receive Gmail-collected contacts.

**Why async** — the dashboard's Vercel proxy caps function invocations at 300 s (Pro plan). First-sync backfills against busy mailboxes blew past that and surfaced as `FUNCTION_INVOCATION_TIMEOUT sin1::...`. Returning 202 keeps the proxy round-trip well under the cap regardless of mailbox size.

**Restart caveat (v1 trade-off)** — there is no queue and no worker. If the Railway service restarts mid-sync, the row stays `running` forever. Acceptable while sync is user-driven (the user can simply re-click sync); revisit when sync becomes scheduled or volume grows. The next iteration is `pgmq` with a reaper that flips long-stale `running` rows to `failed`.

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
