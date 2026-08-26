# google-service

Google Ads API v23 wrapper for MCC agency management (campaigns, spend cost declaration, offline conversion upload), plus Google CRM bronze→silver ingestion (Gmail + People readonly) feeding the dashboard CRM at `/orgs/{orgId}/services/crm`.

## Identity

All endpoints require `x-org-id` and `x-user-id` headers (UUIDs from client-service).
These are the internal org/user identifiers — never use Clerk IDs (clerkOrgId/clerkUserId).
The client-service is the source of truth for identity resolution.

### Tracking / cost-attribution headers

Inbound `x-run-id` (required), `x-feature-slug`, `x-brand-id`, **`x-audience-id`** (all optional) are the tracking block. They are read in `requireIdentityHeaders` (`src/middleware/validate.ts`) onto `req`, then forwarded to every **internal** sibling call (runs-service, billing-service, key-service) via the `trackingHeaders()` allowlist builder in `src/lib/tracking-headers.ts` — never cherry-picked per field. `x-audience-id` (the campaign's priority audience) tags `runs.audience_id` on `createRun` and the cost row on `addCosts`, which is how per-audience cost attribution works (`COALESCE(runs_costs.audience_id, runs.audience_id)` in runs-service). Metered costs: `serper-dev-query` (`/search/*`) and `google-ads-spend` (declared by the spend cron, see below). **Egress safety**: `trackingHeaders()` is imported ONLY by the internal clients; external vendor calls (Serper, Gmail/People, Google Ads, Google OAuth) build their own provider-auth headers and MUST never receive the tracking block.

## Stack

See global CLAUDE.md for shared stack details (TypeScript strict, Zod, Vitest+Supertest). Deploys: the service runs as a Docker container on the Hetzner box, redeployed by a 5-minute cron that runs `./deploy.sh --all` with a health check and automatic rollback. Env vars live in `/root/distribute/env/google-service.env` on the box, not in a hosting-provider dashboard (Railway is gone). First wired into the fleet on 2026-08-26 (it was tagged and released for months while running NOWHERE — no container, no env file, no compose entry): clone at `repos/google-service`, compose entry in `docker-compose.override.yml` (the base `docker-compose.yml` is generated from the old Railway bundle and says not to hand-edit it), `google.distribute.you` in the `Caddyfile` → `google-service:8080`, DB `google_service` provisioned by `./provision-db.sh google-service`, and `GOOGLE_SERVICE_URL`/`GOOGLE_SERVICE_API_KEY` added to `env/api-registry-service.env` so the registry lists it. A repo can be green, tagged and promoted and still be deployed nowhere — check `docker compose config --services` on the box before assuming a release is live.

**Package manager: npm.** Lockfile is `package-lock.json`; the Dockerfile runs `npm ci`. Use `npm install` / `npm test` / `npm run build` locally. Do NOT run `pnpm install` here — it creates a stray `pnpm-lock.yaml` that diverges from the lockfile the Docker build actually reads.

## OAuth client credentials

The Google OAuth client (Client ID + Secret) is the **same** for the Google Ads Developer Console and the Gmail/People consent flow — one Google Cloud project, one OAuth client. It is registered as platform keys `google-client-id` / `google-client-secret` by the dashboard (`apps/dashboard/src/instrumentation.ts`), not by this service.

Business logic must call `getGoogleOAuthClient()` in `src/services/key-service.ts` to fetch the OAuth client at runtime; never read `GOOGLE_*` env vars directly. If `getGoogleOAuthClient()` returns 404, the dashboard side has not yet registered the providers — fix it there, not here.

## Migrations

`src/db/migrate.ts` exports `runMigrations()` which is awaited from `src/index.ts` **before** `app.listen()`. Every deploy runs the migration; missing tables block startup, so a bad migration fails the deploy health check and gets rolled back loudly instead of serving 500s.

Schema changes: edit the inline `migration` SQL in `src/db/migrate.ts`. Use `CREATE TABLE IF NOT EXISTS` / `DO $$ ... IF NOT EXISTS ... END $$` so the same migration runs cleanly on every boot.

Manual one-off run still available via `pnpm migrate`, which runs `src/db/migrate-cli.ts`. The CLI runner lives in a **separate file** from `migrate.ts` because `esbuild --bundle --format=cjs` inlines every imported file into `dist/index.js`, and at runtime `require.main === module` evaluates **true** for the bundled entry — so a CLI guard inside `migrate.ts` would fire at boot and call `pool.end()` after migrations, crashing every subsequent request with `Cannot use a pool after calling end on the pool`. Reference: hotfix v0.19.1.

## Data layering

This service owns **bronze** and **silver** for Google CRM data. Gold is served as an additive read projection over bronze+silver (no separate gold table yet).

**Silver tables** (`google_contacts_silver`, `gmail_messages_silver`) are typed projections of the bronze `*_raw` payloads, keyed on the SAME natural key as their bronze source (`(org_id, resource_name)` / `(org_id, gmail_message_id)`). They are:
- **Populated at ingest** — `people-ingest`/`gmail-ingest` parse the payload via `src/services/silver.ts` (`parseContactSilver` / `parseMessageSilver`) and upsert silver right after the bronze upsert (only on inserted/updated bronze rows; deletes cascade to silver via `deleteContactSilver`).
- **Backfilled from bronze on boot** — `src/services/backfill-silver.ts` runs AFTER `app.listen()` (never in the boot window) with `.catch(console.error)`, keyset-paginated + idempotent (upsert), so re-runs and silver schema changes are safe without re-fetching Google.

Bronze stays the source of truth; silver is a rebuildable view. Contact silver columns: `display_name, primary_email, emails[], phones[], organization, job_title, photo_url, updated_at, deleted`. Message silver columns: `from_email, from_name, to_emails[], subject, snippet, sent_at, labels[], history_id`.

### Read endpoints are ADDITIVE (gold)

`GET /orgs/google/messages` and `/contacts` LEFT JOIN silver onto bronze and return the typed fields **alongside** every legacy field (incl `payload`) — the change is non-breaking, so it ships to prod before the dashboard consumer switches. Locked byte-equal contract with distribute.you admin — do NOT rename: messages add `fromEmail, fromName, to[], subject, snippet, sentAt, labels[]`; contacts add `displayName, primaryEmail, emails[], phones[], organization, jobTitle, photoUrl, updatedAt, deleted`. Messages sorted `sent_at` desc (fallback `fetched_at`); contacts deduped by `primary_email` (rows without an email key on `resource_name`, never dropped).

### Cron auto-sync

`src/services/cron-sync.ts` `startAutoSync()` (scheduled from `index.ts` after listen) runs `syncOrg` for every distinct org in `google_oauth_tokens` every `GOOGLE_SYNC_INTERVAL_HOURS` (default 6). First tick fires after one interval (no boot-storm). Low-frequency by design — keep it that way: a high-frequency loop would do no work anyone asked for beyond what a 6-hourly sync already covers, and the long-lived idle connections it holds are exactly the sockets that get closed underneath you and throw. Take a fresh pool connection per query; never add a timer whose only job is to touch the DB. (The original reason written here was Neon scale-to-zero. Neon is gone — every DB is now one Postgres container on the Hetzner box, which does not autosuspend — but the rule stands on its own.) Google People/Gmail calls use the user's own OAuth token (no metered platform cost → no cost declaration). `src/services/sync.ts` `syncOrg` is the shared core used by both the async HTTP sync job and the cron.

### Bronze tables

| Table | Natural key | Source | Notes |
|-------|-------------|--------|-------|
| `google_oauth_pending` | `(org_id, state)` | OAuth start | 10 min TTL, stores PKCE verifier |
| `google_oauth_tokens` | `(org_id, google_account_email)` | OAuth callback | One row per (org, Gmail account). Stores refresh token, last access token, `gmail_history_id`, `people_sync_token`, `other_contacts_sync_token` |
| `gmail_messages_raw` | `(org_id, gmail_message_id)` | Gmail `messages.get format=full` | Full JSON payload in `payload jsonb` |
| `google_contacts_raw` | `(org_id, resource_name)` | People `connections.list` AND `otherContacts.list` | Full JSON payload in `payload jsonb`. `resource_name` namespace distinguishes sources: `people/c...` = address book, `otherContacts/c...` = Gmail-collected. |
| `google_sync_jobs` | `id` (UUID) | `POST /orgs/google/sync` | One row per sync request. `status` ∈ `running` \| `succeeded` \| `failed`; `summary` jsonb on success, `error` text on failure. Org-scoped lookups (`WHERE org_id = $1 AND id = $2`). |
| `google_contact_links` | `(org_id, resource_name)` | `PUT /orgs/google/contact-links` | Per-contact CRM tagging (NOT bronze — app state). `linked_org_ids`/`linked_brand_ids`/`linked_feature_slugs` TEXT[] default `'{}'`, `status` TEXT NULL (reserved). LEFT-JOINed onto `GET /orgs/google/contacts` as `links{}`; a contact with no row returns empty arrays + null status. `resource_name` lives in the request BODY, never the path (Google resourceNames contain `/`). |

All bronze tables (and `google_sync_jobs`, `google_contact_links`) are `org_id`-scoped. Every SQL query in `/orgs/google/*` includes `WHERE org_id = $N`.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/orgs/google/auth/start` | Build authorize URL (PKCE), persist pending state |
| `GET` | `/orgs/google/auth/callback` | Exchange code, store tokens. Browser callback is proxied by the dashboard server-side so identity headers are present. |
| `POST` | `/orgs/google/sync` | Start an async sync. Inserts a `google_sync_jobs` row, fires ingest in a detached promise, returns `202 {jobId, status:"running"}` immediately. Backfill on first run (last `GOOGLE_GMAIL_BACKFILL_DAYS` for Gmail), delta thereafter (Gmail `historyId`, People `syncToken`). Fan-out per connected Google account. |
| `GET` | `/orgs/google/sync/{jobId}` | Poll job status. Returns `{jobId, status, summary, error, startedAt, finishedAt}`. Org-scoped: 404 if `jobId` belongs to another org. |
| `GET` | `/orgs/google/messages` | Cursor-paginated Gmail messages: bronze payload + typed silver fields, ordered by silver `sent_at` desc (fallback `fetched_at`). Optional `?participant=<email>` filters to one contact's thread (From/To/Cc participant via `payload::text ILIKE`), ordered by the message's own email date (`internalDate`) newest-first. |
| `GET` | `/orgs/google/contacts` | Cursor-paginated Google contacts: bronze payload + typed silver fields, deduped by `primary_email` (text `query` matches `payload::text ILIKE`). Each item also carries `links{orgIds,brandIds,featureSlugs,status}` from `google_contact_links` (LEFT JOIN, unconditional). |
| `PUT` | `/orgs/google/contact-links` | Upsert per-contact links on `(org, resourceName)`. Body `{resourceName, orgIds, brandIds, featureSlugs, status?}`; `resourceName` in the BODY (never path). Returns the persisted `{resourceName, orgIds, brandIds, featureSlugs, status}`. |

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

**Why async** — the dashboard was on Vercel at the time, whose proxy capped function invocations at 300 s (Pro plan). First-sync backfills against busy mailboxes blew past that and surfaced as `FUNCTION_INVOCATION_TIMEOUT sin1::...`. The dashboard has since moved off Vercel, but the 202 design stays: it keeps the proxy round-trip short regardless of mailbox size, and a multi-minute request is fragile under any proxy or deploy restart.

**Restart caveat (v1 trade-off)** — there is no queue and no worker. If the service container restarts mid-sync (deploy cron, box restart), the row stays `running` forever. Acceptable while sync is user-driven (the user can simply re-click sync); revisit when sync becomes scheduled or volume grows. The next iteration is `pgmq` with a reaper that flips long-stale `running` rows to `failed`.

**Large-mailbox reliability (do NOT regress) — a Gmail access token lives ~1h; a full backfill of a 15k+ message mailbox fetches one message at a time and EXCEEDS that window.** So the ingest loop MUST NOT mint one access token at the top and thread it through the loop (that was the original bug: every fetch past the hour 401'd → the whole job threw → `gmail_history_id` never persisted → next sync ran a full backfill from scratch → infinite full-rescan, 0 successful syncs ever). Invariants, all in `gmail-ingest.ts` / `people-ingest.ts` / `google-tokens.ts`:
- Thread an `AccessTokenProvider` (`createAccessTokenProvider`), never a bare token string. Every Google call runs through `withTokenRetry(provider, t => …)` which lazily re-mints on near-expiry and **force-refreshes + retries once on a 401**.
- Backfill is **resumable**: load the `gmail_message_id`s already in bronze and skip them before the per-message `getMessage`, so an interrupted run converges instead of re-scanning from zero. `gmail_history_id` is persisted only on successful completion (captured pre-loop) → next sync is a delta.
- Google People expires syncTokens: on `GoogleApiError` `400` with body `EXPIRED_SYNC_TOKEN` (`isExpiredSyncTokenError`), clear the stored sync token and retry a full list once. Applies to BOTH `people_sync_token` and `other_contacts_sync_token`.
- Match Google failures on `GoogleApiError.status`, never `.message.includes("…")` substrings.

## Google Ads spend → declared cost (PASS-THROUGH)

The money Google charges an org's campaigns becomes that org's declared cost. Catalogue line `google-ads-spend` in costs-service: `pricingBasis: pass-through`, **unit = ONE USD cent of platform spend, price 1.0 cent/unit**, so the declared quantity is literally the number of cents Google charged. **Never mark it up** — the org pays exactly the platform price, by decision of the owner.

- `src/services/spend-ingest.ts` — `ingestSpendForAccount()` reads `getCampaignSpendByDay()` (GAQL segmented on `segments.date`) over the lookback window, upserts `google_ads_spend_daily`, and declares the undeclared part.
- **Dated by GOOGLE's day, never our poll day.** The GAQL is segmented on `segments.date` on purpose: an un-segmented total could only be dated by when we read it, which shifts every downstream daily chart by a day. One run per `(org, account, spend_date)`, `taskName: google-ads-spend:<YYYY-MM-DD>`, run `idempotencyKey` namespaced on that triple so a re-read of the same day reuses the SAME run.
- **ACTUALISED, never provisioned.** The money is already spent when we read it, so there is nothing to hold ahead of a call and nothing to authorise against (an after-the-fact charge cannot be refused). `costSource: "platform"` — the platform's Google Ads account is what was charged.
- **Delta declaration.** Google restates a day's cost for a few days, so each pass declares `observed_cents − declared_cents` and never re-declares. A DOWNWARD restatement keeps `declared_cents` and logs a warning (declared cost rows are not rewritten retroactively). Per-cost `idempotencyKey` is `<campaignId>:<observedCents>`, so a retry after a failed DB write cannot double-charge.
- **Fail loud, no silent fallback.** A (campaign, day) whose cost could not be declared keeps its old `declared_cents` and the error propagates; the next pass re-declares the delta. A spend figure we could not read is NEVER treated as zero. Accounts are isolated at the cron level — one account's failure does not abort the rest.

### Spend cron — its OWN schedule (do NOT chain it to campaign work)

`src/services/spend-cron.ts` `startSpendSync()` (scheduled from `index.ts` after listen) runs `runSpendIngestOnce()` every `GOOGLE_ADS_SPEND_INTERVAL_HOURS` (default 12), first tick 5 min after boot (never AT boot), lookback `GOOGLE_ADS_SPEND_LOOKBACK_DAYS` (default 7).

**Never fold the spend read into a job that creates or updates a campaign.** Google publishes a day's spend hours after the fact, so a read chained to a write observes nothing — and both steps still report success, so nothing looks broken while result latency silently equals the WRITING job's interval instead of the data's real availability. Same reason it is kept out of the CRM auto-sync (different provider surface, deliberately low-frequency). Neither timer exists to touch the DB; each query takes a fresh pool connection.

`google_ads_spend_daily` — key `(org_id, account_id, campaign_id, spend_date)`; `cost_micros`, `observed_cents` (what Google reports now), `declared_cents` (what has been declared), `run_id`, `last_seen_at`, `last_declared_at`. Readable via `GET /accounts/{accountId}/spend`.

## Advertiser resolution: managed by default, per-org OAuth still works

We run the advertising ourselves, from our own agency manager account. **The managed path requires no customer-supplied Google credential** — the client never connects a Google account and never opens the Google Ads UI.

`src/services/customer-resolver.ts` `resolveCustomer()` is the single place a request turns into a Google Ads customer. `login_customer_id` is ALWAYS the MCC; only the refresh token differs:

| Path | When | Credential |
|------|------|-----------|
| `per-org` | a row exists in `accounts` for `(org, accountId)` | the org's own refresh token (`google-ads-refresh-<accountId>` in key-service) |
| `managed` | a row exists in `google_ads_managed_accounts` for `(org, accountId)` | **platform key `google-mcc-refresh-token`** — our manager account's own token |

Per-org WINS when both exist, so nothing that works today changes. An org that owns neither gets `Account not found` (404) — an org may never drive an account it does not own.

`google-mcc-refresh-token` is a NEW platform key, alongside the existing `google-client-id` / `google-client-secret` / `google-developer-token` / `google-mcc-account-id`. Without it the managed path cannot resolve a credential and fails loud; the per-org path is unaffected.

`POST /orgs/google-ads/managed-accounts` provisions a client account under our manager account (`CustomerService.CreateCustomerClient`) and records it in `google_ads_managed_accounts`. **Idempotent per brand**: a second call with the same `brandId` returns the existing account with `created: false` instead of minting a second one under the manager (partial unique index on `(org_id, brand_id) WHERE brand_id IS NOT NULL`).

## The serving stack (everything BELOW the campaign)

A Google Search campaign with nothing under it serves zero impressions. `src/services/google-ads-serving.ts` + `src/routes/serving.ts` own the layer that makes a campaign deliverable: the grouping level, the search terms it bids on and their match behaviour, the terms it must never bid on, and the ad itself.

| Method | Path | Purpose |
|--------|------|---------|
| `POST`/`GET` | `/accounts/{accountId}/campaigns/{campaignId}/ad-groups` | Ad groups (created `SEARCH_STANDARD` — the only type a Search campaign serves text ads from) |
| `PATCH` | `/accounts/{accountId}/ad-groups/{adGroupId}` | Name / status / default CPC bid |
| `POST`/`GET` | `/accounts/{accountId}/ad-groups/{adGroupId}/keywords` | Search terms + match type (`EXACT` \| `PHRASE` \| `BROAD`), batched |
| `PATCH`/`DELETE` | `.../keywords/{criterionId}` | Pause / remove one keyword |
| `POST`/`GET` | `.../ad-groups/{adGroupId}/negative-keywords` | Terms this ad group must never bid on |
| `POST`/`GET`/`DELETE` | `.../campaigns/{campaignId}/negative-keywords[/{criterionId}]` | Campaign-wide negatives |
| `POST`/`GET` | `.../ad-groups/{adGroupId}/ads` | Responsive search ad (3–15 headlines, 2–4 descriptions) |
| `PATCH`/`DELETE` | `.../ads/{adId}` | Pause / remove one ad |
| `PUT` | `/accounts/{accountId}/campaigns/{campaignId}/bidding` | Change the bidding approach on a LIVE campaign |
| `GET` | `.../campaigns/{campaignId}/structure` | Read back EVERYTHING created for the campaign |
| `GET` | `.../campaigns/{campaignId}/serving-state` | Google's own verdict on whether it can serve |

**The ad is multi-asset by nature.** Google composes it at serve time from the variants that exist, so *picking which variants exist is how the ad is written*. A variant may carry `pinnedField` (`HEADLINE_1..3`, `DESCRIPTION_1..2`) to force a fixed position — needed for compliance and brand lines — while every unpinned variant stays free for Google to test. On readback, Google's `UNSPECIFIED` is reported as *unpinned*, never as a position.

**Criterion and ad ids are composite.** Resource names are `customers/X/adGroupCriteria/<adGroupId>~<criterionId>` and `customers/X/adGroupAds/<adGroupId>~<adId>` — the id is what follows the tilde, which is why the parent id sits in the path on every update/delete route.

**Readback is the anti-duplication mechanism.** `GET .../structure` returns the campaign's serving state plus each ad group with its keywords, its negatives and its ads, so a later workflow run sees what already exists and adjusts it rather than building a second copy.

**Every Google rejection surfaces as a 502 carrying Google's own message** — including a policy refusal on ad copy. `Account not found` is the only 404. Nothing is swallowed, nothing is retried behind the caller's back, and a batch Google partially rejected is never reported as fully applied.

**No spend is declared here.** The spend cron (below) remains the ONLY place Google spend becomes an org cost.

### Bidding: settable at creation, changeable on a live campaign

`src/services/bidding.ts` maps our strategy input onto Google's campaign bidding-scheme fields. Supported: `MANUAL_CPC`, `MAXIMIZE_CLICKS` (Google's `target_spend`), `MAXIMIZE_CONVERSIONS`, `MAXIMIZE_CONVERSION_VALUE`, `TARGET_CPA`, `TARGET_ROAS`.

This is load-bearing, not a nicety: a new campaign has NO conversion history, so it launches click-based or manual and graduates to conversion-based bidding once enough conversions have accrued. Both the initial pick (`POST /accounts/{id}/campaigns` body `bidding`) and the later switch (`PUT .../bidding`) go through this service, and the switch never recreates the campaign — setting the new scheme field IS the switch, so the campaign keeps its id, its structure and its history.

A strategy whose required companion value is missing (`TARGET_CPA` without `targetCpaMicros`, `TARGET_ROAS` without `targetRoas`) is rejected — a silently-dropped target would leave the campaign bidding on something the caller never asked for.

A `SEARCH` campaign is created with explicit network settings (Google Search on, search partners on by default via `targetSearchNetwork`, display and partner-search off), so it never ends up opted into networks nobody asked for.

## Offline conversion upload (outcome → Google)

`POST /accounts/{accountId}/conversions/upload` reports a measured outcome (a paid client) back to Google as a click conversion, attributed to the click that produced it — Smart Bidding can only optimise against conversions it has been told about. `uploadClickConversions()` in `src/services/google-ads.ts` wraps `ConversionUploadService.uploadClickConversions`.

- One of `gclid` / `gbraid` / `wbraid` is required (that IS the attribution to the originating click).
- `conversionDateTime` must carry an explicit UTC offset: `yyyy-mm-dd hh:mm:ss+|-hh:mm`. Google rejects anything else; the Zod schema enforces it before the call.
- Google requires exactly one of `partial_failure` / `validate_only`. Normal upload → `partial_failure: true`; `validateOnly: true` → dry run.
- `uploaded` counts only the entries Google actually ACCEPTED (a rejected row comes back as an empty result entry). A batch Google accepted nothing from throws → the route answers 502. Never report the requested count as uploaded.
- `GET /accounts/{accountId}/conversions` (conversion-action list) is the neighbouring read half — it is where the `conversionActionId` comes from.

### Future gold / canonical-Human trigger

Silver (`google_contacts_silver` / `gmail_messages_silver`) exists (see Data layering above). Promote further — a canonical `Human` entity or a materialized gold table — only when one of:

1. A second source (LinkedIn, Apollo, manual import) feeds the same canonical `Human` and cross-source merging is required (silver here is single-source per resource).
2. The read projection (bronze+silver LEFT JOIN + dedup) becomes too expensive per request and needs a materialized gold table.
3. Manual user edits must coexist with derived data (needs a `*_overrides` table winning over silver).

## OAuth flow

```
dashboard → POST /orgs/google/auth/start  → { url, state }
browser   → Google                         (user consents)
Google    → dashboard /services/crm/oauth/callback?code&state
dashboard → GET /orgs/google/auth/callback?code&state  (server-side, with identity headers)
google-service → google_oauth_tokens row (refresh + access)
```

The dashboard proxies the Google → service hop so the identity headers (`x-api-key`, `x-org-id`, `x-user-id`, `x-run-id`) can be attached.
