// Google Search Console connection (GSC-CONNECTOR-1108).
//
// Owner 2026-11-08: « Google search click » is an outcome every client tracks on
// his dashboard, ours included. How we plug our own data is a connector every
// client can plug: any client connects Google Search Console from the dashboard
// Integrations page (its own consent, like the calendar), and every connected
// property's daily clicks become Units of the outcome `google_search_click` on
// the brand that owns the site.
//
// Layers:
//   bronze  google_search_console_days_raw   Google's raw answer per property x day
//   silver  google_search_console_page_days  one row per property x day x page
//   ledger  google_search_console_click_days which runs-service run holds the
//           current declaration of one property x day (one Unit = one click).
//
// Search Console data lags ~2-3 days and is revised: each pass re-reads the
// trailing days, and a day whose figures moved voids its old run and declares
// on a new one, so the ledger always equals Google's latest answer. A day Google
// does not list (not final yet) is never read as zero.
import { createHash } from "node:crypto";
import { env } from "../env";
import { query } from "../db/client";
import { getGoogleOAuthClient, type CallerContext } from "./key-service";
import { refreshAccessToken, SEARCH_CONSOLE_SCOPE } from "./google-oauth";
import type { AccessTokenProvider } from "./google-tokens";
import { apiFetch, GoogleApiError, withTokenRetry } from "./google-api";
import { listOrgBrands, type OrgBrand } from "./brand-service";
import { createRun, updateRun } from "./runs-service";

const WEBMASTERS_BASE = "https://www.googleapis.com/webmasters/v3";
const ACCESS_TOKEN_LEEWAY_MS = 60_000;
const ROW_LIMIT = 25_000;
const DECLARE_CHUNK = 1000;
const RUNS_TIMEOUT_MS = 30_000;

/** features-service catalogue step (created 2026-11-08 through POST /internal/catalogue/steps). */
export const GOOGLE_SEARCH_CLICK_OUTCOME = "google_search_click";
export const OUTCOME_SUBJECT_SERVICE = "google-service";
export const CLICK_PERFORMER = { kind: "organic", name: "google-search-console" } as const;
/** The service name our runs carry (`runs.service_name`). */
const RUN_SERVICE_NAME = "google";

export type PropertyStatus =
  | "pending"
  | "counting"
  | "no_brand"
  | "brand_ambiguous"
  | "covered"
  | "unverified"
  | "not_listed"
  | "disconnected";

// ─── Accounts ───

export interface SearchConsoleAccount {
  id: string;
  orgId: string;
  userId: string;
  googleAccountEmail: string;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string;
}

const ACCOUNT_COLUMNS = `id, org_id, user_id, google_account_email, refresh_token,
  access_token, access_token_expires_at, scopes`;

const rowToAccount = (row: Record<string, unknown>): SearchConsoleAccount => ({
  id: row.id as string,
  orgId: row.org_id as string,
  userId: row.user_id as string,
  googleAccountEmail: row.google_account_email as string,
  refreshToken: row.refresh_token as string,
  accessToken: (row.access_token as string | null) ?? null,
  accessTokenExpiresAt: (row.access_token_expires_at as Date | null) ?? null,
  scopes: row.scopes as string,
});

export const hasSearchConsoleScope = (scopes: string): boolean =>
  scopes.split(/\s+/).includes(SEARCH_CONSOLE_SCOPE);

export const upsertSearchConsoleAccount = async (params: {
  orgId: string;
  userId: string;
  googleAccountEmail: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  scopes: string;
}): Promise<SearchConsoleAccount> => {
  const result = await query(
    `INSERT INTO google_search_console_accounts
        (org_id, user_id, google_account_email, refresh_token, access_token,
         access_token_expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, google_account_email) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        refresh_token = EXCLUDED.refresh_token,
        access_token = EXCLUDED.access_token,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        scopes = EXCLUDED.scopes,
        last_sync_error = NULL,
        reconnect_required = FALSE,
        updated_at = NOW()
     RETURNING ${ACCOUNT_COLUMNS}`,
    [
      params.orgId,
      params.userId,
      params.googleAccountEmail,
      params.refreshToken,
      params.accessToken,
      params.accessTokenExpiresAt,
      params.scopes,
    ]
  );
  return rowToAccount(result.rows[0]);
};

export const listAllSearchConsoleAccounts = async (): Promise<SearchConsoleAccount[]> => {
  const result = await query(
    `SELECT ${ACCOUNT_COLUMNS} FROM google_search_console_accounts ORDER BY created_at ASC`
  );
  return result.rows.map(rowToAccount);
};

export interface SearchConsolePropertyView {
  siteUrl: string;
  permissionLevel: string | null;
  brandId: string | null;
  status: PropertyStatus;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

export interface SearchConsoleAccountView {
  email: string;
  status: "active" | "sync_failing" | "reconnect_required";
  connectedAt: string;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  properties: SearchConsolePropertyView[];
}

const iso = (d: unknown): string | null => (d ? (d as Date).toISOString() : null);

export const listOrgSearchConsoleAccounts = async (orgId: string): Promise<SearchConsoleAccountView[]> => {
  const accounts = await query(
    `SELECT id, google_account_email, created_at, last_synced_at, last_sync_error, reconnect_required
       FROM google_search_console_accounts
      WHERE org_id = $1
      ORDER BY created_at ASC`,
    [orgId]
  );
  const props = await query(
    `SELECT account_id, site_url, permission_level, brand_id, status, last_synced_at, last_sync_error
       FROM google_search_console_properties
      WHERE org_id = $1 AND account_id IS NOT NULL
      ORDER BY site_url ASC`,
    [orgId]
  );
  return accounts.rows.map((a) => ({
    email: a.google_account_email as string,
    status: a.reconnect_required
      ? ("reconnect_required" as const)
      : a.last_sync_error
        ? ("sync_failing" as const)
        : ("active" as const),
    connectedAt: (a.created_at as Date).toISOString(),
    lastSyncedAt: iso(a.last_synced_at),
    lastSyncError: (a.last_sync_error as string | null) ?? null,
    properties: props.rows
      .filter((p) => p.account_id === a.id)
      .map((p) => ({
        siteUrl: p.site_url as string,
        permissionLevel: (p.permission_level as string | null) ?? null,
        brandId: (p.brand_id as string | null) ?? null,
        status: p.status as PropertyStatus,
        lastSyncedAt: iso(p.last_synced_at),
        lastSyncError: (p.last_sync_error as string | null) ?? null,
      })),
  }));
};

const createTokenProvider = (account: SearchConsoleAccount, caller: CallerContext): AccessTokenProvider => {
  let current = account.accessToken;
  let expiresAt = account.accessTokenExpiresAt;
  const refresh = async (): Promise<string> => {
    const oauth = await getGoogleOAuthClient(caller);
    const refreshed = await refreshAccessToken({
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      refreshToken: account.refreshToken,
    });
    const exp = new Date(Date.now() + refreshed.expires_in * 1000);
    await query(
      `UPDATE google_search_console_accounts
          SET access_token = $2, access_token_expires_at = $3, updated_at = NOW()
        WHERE id = $1`,
      [account.id, refreshed.access_token, exp]
    );
    current = refreshed.access_token;
    expiresAt = exp;
    return refreshed.access_token;
  };
  return {
    async get() {
      if (current && expiresAt && expiresAt.getTime() - Date.now() > ACCESS_TOKEN_LEEWAY_MS) {
        return current;
      }
      return refresh();
    },
    forceRefresh: refresh,
  };
};

// ─── Google Search Console API ───

interface SiteEntry {
  siteUrl: string;
  permissionLevel?: string;
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
}

const postJson = async <T>(url: string, accessToken: string, body: unknown): Promise<T> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new GoogleApiError(res.status, url, await res.text());
  }
  return (await res.json()) as T;
};

const queryUrl = (siteUrl: string) =>
  `${WEBMASTERS_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

// ─── Property → brand ───

const stripWww = (h: string) => h.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

/** The host a property covers: `sc-domain:x.com` → x.com, `https://www.x.com/` → x.com. */
export const propertyHost = (siteUrl: string): string | null => {
  if (siteUrl.startsWith("sc-domain:")) return stripWww(siteUrl.slice("sc-domain:".length));
  try {
    return stripWww(new URL(siteUrl).hostname);
  } catch {
    return null;
  }
};

const brandDomain = (b: OrgBrand): string | null => {
  if (b.domain) return stripWww(b.domain);
  if (b.brandUrl) {
    try {
      return stripWww(new URL(b.brandUrl.includes("://") ? b.brandUrl : `https://${b.brandUrl}`).hostname);
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * The brand of the org whose domain the property's host is (or a subdomain of).
 * The most specific domain wins; two brands on that same domain = ambiguous,
 * never guessed.
 */
export const matchBrand = (
  siteUrl: string,
  brands: OrgBrand[]
): { brandId: string | null; status: "counting" | "no_brand" | "brand_ambiguous" } => {
  const host = propertyHost(siteUrl);
  if (!host) return { brandId: null, status: "no_brand" };
  let best: { len: number; ids: Set<string> } | null = null;
  for (const b of brands) {
    const d = brandDomain(b);
    if (!d || !(host === d || host.endsWith(`.${d}`))) continue;
    if (!best || d.length > best.len) best = { len: d.length, ids: new Set([b.id]) };
    else if (d.length === best.len) best.ids.add(b.id);
  }
  if (!best) return { brandId: null, status: "no_brand" };
  if (best.ids.size > 1) return { brandId: null, status: "brand_ambiguous" };
  return { brandId: [...best.ids][0], status: "counting" };
};

/**
 * Does property `a` already count every click of property `b`? A domain
 * property counts its whole domain (subdomains, http and https); a URL-prefix
 * property counts the URLs under its prefix.
 */
export const propertyCovers = (a: string, b: string): boolean => {
  if (a === b) return false;
  if (a.startsWith("sc-domain:")) {
    const d = stripWww(a.slice("sc-domain:".length));
    const h = propertyHost(b);
    return !!h && (h === d || h.endsWith(`.${d}`));
  }
  if (b.startsWith("sc-domain:")) return false;
  return b.startsWith(a);
};

interface PropertyRow {
  id: string;
  orgId: string;
  accountId: string | null;
  siteUrl: string;
  permissionLevel: string | null;
  brandId: string | null;
  status: PropertyStatus;
  backfilledAt: Date | null;
}

const rowToProperty = (r: Record<string, unknown>): PropertyRow => ({
  id: r.id as string,
  orgId: r.org_id as string,
  accountId: (r.account_id as string | null) ?? null,
  siteUrl: r.site_url as string,
  permissionLevel: (r.permission_level as string | null) ?? null,
  brandId: (r.brand_id as string | null) ?? null,
  status: r.status as PropertyStatus,
  backfilledAt: (r.backfilled_at as Date | null) ?? null,
});

/**
 * Each listed property's status for the org: which ones count clicks. Two
 * properties of one brand that overlap (sc-domain:x.com and https://x.com/)
 * would count the same click twice: the covering one counts, the other is
 * `covered`.
 */
export const assignStatuses = (
  props: { id: string; siteUrl: string; permissionLevel: string | null; listed: boolean }[],
  brands: OrgBrand[]
): Map<string, { status: PropertyStatus; brandId: string | null }> => {
  const out = new Map<string, { status: PropertyStatus; brandId: string | null }>();
  for (const p of props) {
    if (!p.listed) {
      out.set(p.id, { status: "not_listed", brandId: null });
      continue;
    }
    if (p.permissionLevel === "siteUnverifiedUser") {
      out.set(p.id, { status: "unverified", brandId: null });
      continue;
    }
    const m = matchBrand(p.siteUrl, brands);
    out.set(p.id, { status: m.status, brandId: m.brandId });
  }
  const counting = props.filter((p) => out.get(p.id)!.status === "counting");
  for (const p of counting) {
    const brandId = out.get(p.id)!.brandId;
    const coveredBy = counting.find(
      (q) => q.id !== p.id && out.get(q.id)!.brandId === brandId && propertyCovers(q.siteUrl, p.siteUrl)
    );
    if (coveredBy) out.set(p.id, { status: "covered", brandId });
  }
  return out;
};

// ─── Ledger (runs-service) ───

const runsHeaders = () => ({
  "Content-Type": "application/json",
  "x-api-key": env.RUNS_SERVICE_API_KEY,
  "x-service-name": RUN_SERVICE_NAME,
});

/** Take back one run's whole declaration (owner door). Idempotent at runs-service. */
export const voidClickRun = async (runId: string, reason: string): Promise<void> => {
  const res = await fetch(`${env.RUNS_SERVICE_URL}/v1/platform-runs/${runId}/outcomes/void`, {
    method: "POST",
    headers: runsHeaders(),
    body: JSON.stringify({ reason, voidedBy: "google-service GSC-CONNECTOR-1108" }),
    signal: AbortSignal.timeout(RUNS_TIMEOUT_MS),
  });
  if (res.ok) return;
  const body = await res.text();
  // A run that never recorded a declaration has nothing to take back.
  if (res.status === 404) return;
  throw new Error(`runs-service void of run ${runId} failed: ${res.status} ${body.slice(0, 500)}`);
};

export interface ClickOccurrence {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  performer: typeof CLICK_PERFORMER;
}

/** One Unit per click: N clicks on a page that day = N occurrences of the page-day row. */
export const buildClickOccurrences = (rows: { id: string; clicks: number }[]): ClickOccurrence[] => {
  const out: ClickOccurrence[] = [];
  for (const r of rows) {
    for (let i = 1; i <= r.clicks; i++) {
      out.push({
        outcomeKey: GOOGLE_SEARCH_CLICK_OUTCOME,
        subjectService: OUTCOME_SUBJECT_SERVICE,
        subjectId: `search-console-page-day:${r.id}:${i}`,
        performer: CLICK_PERFORMER,
      });
    }
  }
  return out;
};

const declareClicks = async (runId: string, date: string, occurrences: ClickOccurrence[]): Promise<void> => {
  const occurredAt = `${date}T12:00:00.000Z`;
  for (let i = 0; i < occurrences.length; i += DECLARE_CHUNK) {
    const res = await fetch(`${env.RUNS_SERVICE_URL}/v1/platform-runs/outcomes/batch`, {
      method: "POST",
      headers: runsHeaders(),
      body: JSON.stringify({
        runs: [{ runId, produced: occurrences.slice(i, i + DECLARE_CHUNK), occurredAt }],
      }),
      signal: AbortSignal.timeout(RUNS_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`runs-service declare on run ${runId} failed: ${res.status} ${body.slice(0, 500)}`);
    }
  }
};

export const dayFingerprint = (brandId: string | null, rows: { page: string; clicks: number }[]): string =>
  createHash("sha256")
    .update(
      `${brandId ?? ""}\n` +
        rows
          .filter((r) => r.clicks > 0)
          .map((r) => `${r.page}\t${r.clicks}`)
          .sort()
          .join("\n")
    )
    .digest("hex");

/**
 * Bring one property x day's declaration to its silver figures. Unchanged =
 * nothing. Changed = void the run holding the old figures, then declare the new
 * ones on a NEW run (revision + 1). Every step is recorded before the next one,
 * so a pass that dies half-way is finished by the next pass, never doubled.
 */
export const declarePropertyDay = async (
  property: { id: string; orgId: string; brandId: string | null },
  userId: string,
  date: string
): Promise<"unchanged" | "declared" | "withdrawn"> => {
  const silver = await query(
    `SELECT id, page, clicks FROM google_search_console_page_days
      WHERE property_id = $1 AND search_date = $2 AND clicks > 0
      ORDER BY page ASC`,
    [property.id, date]
  );
  const rows = silver.rows.map((r) => ({ id: r.id as string, page: r.page as string, clicks: Number(r.clicks) }));
  const fingerprint = dayFingerprint(property.brandId, rows);
  const existing = (
    await query(
      `SELECT fingerprint, run_id, revision FROM google_search_console_click_days
        WHERE property_id = $1 AND search_date = $2`,
      [property.id, date]
    )
  ).rows[0] as { fingerprint: string; run_id: string | null; revision: number } | undefined;
  const total = rows.reduce((n, r) => n + r.clicks, 0);
  if (existing?.fingerprint === fingerprint) return "unchanged";
  if (!existing && total === 0) return "unchanged";

  if (existing?.run_id) {
    await voidClickRun(existing.run_id, `Search Console revised ${date}: re-declared on a new run`);
    await query(
      `UPDATE google_search_console_click_days
          SET run_id = NULL, fingerprint = 'voided', clicks = 0, declared_at = NOW()
        WHERE property_id = $1 AND search_date = $2`,
      [property.id, date]
    );
  }
  if (total === 0) {
    await query(
      `UPDATE google_search_console_click_days
          SET fingerprint = $3, clicks = 0, brand_id = $4, declared_at = NOW()
        WHERE property_id = $1 AND search_date = $2`,
      [property.id, date, fingerprint, property.brandId]
    );
    return "withdrawn";
  }

  const revision = existing ? existing.revision + 1 : 0;
  const runId = await createRun({
    orgId: property.orgId,
    userId,
    service: RUN_SERVICE_NAME,
    brandId: property.brandId ?? undefined,
    taskName: `google-search-clicks:${date}`,
    idempotencyKey: `google-service:search-console-clicks:${property.id}:${date}:r${revision}`,
  });
  await query(
    `INSERT INTO google_search_console_click_days
        (org_id, property_id, search_date, brand_id, fingerprint, clicks, run_id, revision)
     VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6)
     ON CONFLICT (property_id, search_date) DO UPDATE SET
        brand_id = EXCLUDED.brand_id, fingerprint = 'pending', clicks = 0,
        run_id = EXCLUDED.run_id, revision = EXCLUDED.revision, declared_at = NOW()`,
    [property.orgId, property.id, date, property.brandId, runId, revision]
  );
  await declareClicks(runId, date, buildClickOccurrences(rows));
  await updateRun(runId, "completed", property.orgId, userId, undefined, property.brandId ?? undefined).catch(
    (err) => console.error(`[google-service] failed to close search-click run ${runId}: ${(err as Error).message}`)
  );
  await query(
    `UPDATE google_search_console_click_days
        SET fingerprint = $3, clicks = $4, declared_at = NOW()
      WHERE property_id = $1 AND search_date = $2`,
    [property.id, date, fingerprint, total]
  );
  return "declared";
};

/** A property that stopped counting (covered, brand gone, not listed) takes its Units back. */
export const withdrawProperty = async (propertyId: string, reason: string): Promise<number> => {
  const held = await query(
    `SELECT search_date::text AS d, run_id FROM google_search_console_click_days
      WHERE property_id = $1 AND (run_id IS NOT NULL OR fingerprint = 'pending')`,
    [propertyId]
  );
  for (const r of held.rows) {
    if (r.run_id) await voidClickRun(r.run_id as string, reason);
    await query(
      `UPDATE google_search_console_click_days
          SET run_id = NULL, fingerprint = 'withdrawn', clicks = 0, declared_at = NOW()
        WHERE property_id = $1 AND search_date = $2`,
      [propertyId, r.d]
    );
  }
  return held.rows.length;
};

// ─── Ingest ───

/** YYYY-MM-DD, `daysAgo` days before `now` (UTC). */
export const isoDay = (now: Date, daysAgo = 0): string =>
  new Date(now.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);

export interface PropertySyncSummary {
  datesListed: number;
  declared: number;
  withdrawn: number;
  unchanged: number;
}

/**
 * Read the property's window, store bronze + silver per listed day, declare.
 * The window's per-date read says which days Google has; a day it does not
 * list keeps whatever was declared for it.
 */
export const syncProperty = async (
  property: PropertyRow,
  userId: string,
  provider: AccessTokenProvider,
  now: Date = new Date()
): Promise<PropertySyncSummary> => {
  const summary: PropertySyncSummary = { datesListed: 0, declared: 0, withdrawn: 0, unchanged: 0 };
  const days = property.backfilledAt ? env.GOOGLE_SEARCH_CONSOLE_LOOKBACK_DAYS : env.GOOGLE_SEARCH_CONSOLE_BACKFILL_DAYS;
  const startDate = isoDay(now, days);
  const endDate = isoDay(now, 1);
  const byDate = await withTokenRetry(provider, (t) =>
    postJson<SearchAnalyticsResponse>(queryUrl(property.siteUrl), t, {
      startDate,
      endDate,
      dimensions: ["date"],
      rowLimit: ROW_LIMIT,
    })
  );
  const dates = (byDate.rows ?? []).map((r) => r.keys?.[0]).filter((d): d is string => !!d).sort();
  summary.datesListed = dates.length;

  for (const date of dates) {
    const responses: SearchAnalyticsResponse[] = [];
    const request = { startDate: date, endDate: date, dimensions: ["page"], rowLimit: ROW_LIMIT };
    for (let startRow = 0; ; startRow += ROW_LIMIT) {
      const page = await withTokenRetry(provider, (t) =>
        postJson<SearchAnalyticsResponse>(queryUrl(property.siteUrl), t, { ...request, startRow })
      );
      responses.push(page);
      if ((page.rows ?? []).length < ROW_LIMIT) break;
    }
    await query(
      `INSERT INTO google_search_console_days_raw (org_id, property_id, search_date, request, responses)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (property_id, search_date) DO UPDATE SET
          request = EXCLUDED.request,
          responses = EXCLUDED.responses,
          fetched_at = NOW(),
          changed_at = CASE WHEN google_search_console_days_raw.responses IS DISTINCT FROM EXCLUDED.responses
                            THEN NOW() ELSE google_search_console_days_raw.changed_at END`,
      [property.orgId, property.id, date, JSON.stringify(request), JSON.stringify(responses)]
    );

    const pages = new Map<string, SearchAnalyticsRow>();
    for (const r of responses.flatMap((x) => x.rows ?? [])) {
      const p = r.keys?.[0];
      if (p) pages.set(p, r);
    }
    const list = [...pages.entries()];
    for (let i = 0; i < list.length; i += 1000) {
      const chunk = list.slice(i, i + 1000);
      await query(
        `INSERT INTO google_search_console_page_days
            (org_id, property_id, search_date, page, clicks, impressions, ctr, position)
         SELECT $1, $2, $3::date, u.page, u.clicks, u.impressions, u.ctr, u.position
           FROM unnest($4::text[], $5::int[], $6::int[], $7::float8[], $8::float8[])
                AS u(page, clicks, impressions, ctr, position)
         ON CONFLICT (property_id, search_date, page) DO UPDATE SET
            clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
            ctr = EXCLUDED.ctr, position = EXCLUDED.position, updated_at = NOW()
         WHERE (google_search_console_page_days.clicks, google_search_console_page_days.impressions,
                google_search_console_page_days.ctr, google_search_console_page_days.position)
               IS DISTINCT FROM (EXCLUDED.clicks, EXCLUDED.impressions, EXCLUDED.ctr, EXCLUDED.position)`,
        [
          property.orgId,
          property.id,
          date,
          chunk.map(([page]) => page),
          chunk.map(([, r]) => Math.round(r.clicks ?? 0)),
          chunk.map(([, r]) => Math.round(r.impressions ?? 0)),
          chunk.map(([, r]) => r.ctr ?? null),
          chunk.map(([, r]) => r.position ?? null),
        ]
      );
    }
    await query(
      `DELETE FROM google_search_console_page_days
        WHERE property_id = $1 AND search_date = $2 AND NOT (page = ANY($3::text[]))`,
      [property.id, date, [...pages.keys()]]
    );

    summary[await declarePropertyDay(property, userId, date)]++;
  }

  await query(
    `UPDATE google_search_console_properties
        SET backfilled_at = COALESCE(backfilled_at, NOW()), last_synced_at = NOW(),
            last_sync_error = NULL, updated_at = NOW()
      WHERE id = $1`,
    [property.id]
  );
  return summary;
};

const running = new Set<string>();

export interface AccountSyncSummary {
  properties: number;
  counting: number;
  declared: number;
  withdrawn: number;
}

const isDeadGrant = (message: string) => message.includes("invalid_grant");

/**
 * One pass over one connected account: list its properties, tie each to its
 * brand, then read + declare every property that counts. One property failing
 * is recorded on it and the others go on.
 */
export const syncSearchConsoleAccount = async (
  account: SearchConsoleAccount,
  caller: CallerContext,
  now: Date = new Date()
): Promise<AccountSyncSummary | null> => {
  if (running.has(account.id)) return null;
  running.add(account.id);
  const provider = createTokenProvider(account, caller);
  const summary: AccountSyncSummary = { properties: 0, counting: 0, declared: 0, withdrawn: 0 };
  try {
    const sites = await withTokenRetry(provider, (t) =>
      apiFetch<{ siteEntry?: SiteEntry[] }>(`${WEBMASTERS_BASE}/sites`, t)
    );
    const entries = sites.siteEntry ?? [];
    summary.properties = entries.length;
    for (const e of entries) {
      await query(
        `INSERT INTO google_search_console_properties (org_id, account_id, site_url, permission_level)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, site_url) DO UPDATE SET
            account_id = EXCLUDED.account_id, permission_level = EXCLUDED.permission_level, updated_at = NOW()`,
        [account.orgId, account.id, e.siteUrl, e.permissionLevel ?? null]
      );
    }
    const listedUrls = entries.map((e) => e.siteUrl);
    // A property this account no longer lists stops counting.
    await query(
      `UPDATE google_search_console_properties
          SET account_id = NULL, updated_at = NOW()
        WHERE org_id = $1 AND account_id = $2 AND NOT (site_url = ANY($3::text[]))`,
      [account.orgId, account.id, listedUrls]
    );

    const brands = await listOrgBrands(account.orgId);
    const all = (
      await query(
        `SELECT id, org_id, account_id, site_url, permission_level, brand_id, status, backfilled_at
           FROM google_search_console_properties WHERE org_id = $1`,
        [account.orgId]
      )
    ).rows.map(rowToProperty);
    const statuses = assignStatuses(
      all.map((p) => ({ id: p.id, siteUrl: p.siteUrl, permissionLevel: p.permissionLevel, listed: p.accountId !== null })),
      brands
    );
    for (const p of all) {
      const s = statuses.get(p.id)!;
      const status: PropertyStatus = p.status === "disconnected" && p.accountId === null ? "disconnected" : s.status;
      if (status !== "counting") {
        summary.withdrawn += await withdrawProperty(p.id, `Search Console property ${p.siteUrl} stopped counting: ${status}`);
      }
      await query(
        `UPDATE google_search_console_properties SET status = $2, brand_id = $3, updated_at = NOW() WHERE id = $1`,
        [p.id, status, s.brandId]
      );
      p.status = status;
      p.brandId = s.brandId;
    }

    for (const p of all.filter((x) => x.status === "counting" && x.accountId === account.id)) {
      summary.counting++;
      try {
        const s = await syncProperty(p, account.userId, provider, now);
        summary.declared += s.declared;
        summary.withdrawn += s.withdrawn;
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        console.error(`[google-service] search-console property ${p.siteUrl} org=${p.orgId} failed: ${message}`);
        await query(
          `UPDATE google_search_console_properties SET last_sync_error = $2, updated_at = NOW() WHERE id = $1`,
          [p.id, message.slice(0, 2000)]
        );
        if (isDeadGrant(message)) throw err;
      }
    }

    await query(
      `UPDATE google_search_console_accounts
          SET last_synced_at = NOW(), last_sync_error = NULL, reconnect_required = FALSE, updated_at = NOW()
        WHERE id = $1`,
      [account.id]
    );
    return summary;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    await query(
      `UPDATE google_search_console_accounts
          SET last_sync_error = $2, reconnect_required = $3, updated_at = NOW()
        WHERE id = $1`,
      [account.id, message.slice(0, 2000), isDeadGrant(message)]
    );
    throw err;
  } finally {
    running.delete(account.id);
  }
};

/** First read right after a connect: the clicks show without waiting for the next tick. */
export const syncSearchConsoleInBackground = (account: SearchConsoleAccount, caller: CallerContext): void => {
  void syncSearchConsoleAccount(account, caller).catch((err) =>
    console.error(
      `[google-service] search-console first sync failed org=${account.orgId} account=${account.id}: ${(err as Error).message}`
    )
  );
};

// ─── Gold read ───

export interface ClickDayView {
  siteUrl: string;
  brandId: string | null;
  date: string;
  clicks: number;
}

/** Declared clicks per property x day for the org (what the ledger holds). */
export const listOrgClickDays = async (
  orgId: string,
  input: { brandId?: string; since?: string; until?: string }
): Promise<ClickDayView[]> => {
  const result = await query(
    `SELECT p.site_url, c.brand_id, c.search_date::text AS d, c.clicks
       FROM google_search_console_click_days c
       JOIN google_search_console_properties p ON p.id = c.property_id
      WHERE c.org_id = $1
        AND c.run_id IS NOT NULL AND c.fingerprint NOT IN ('pending', 'voided', 'withdrawn')
        AND ($2::text IS NULL OR c.brand_id = $2)
        AND ($3::date IS NULL OR c.search_date >= $3::date)
        AND ($4::date IS NULL OR c.search_date <= $4::date)
      ORDER BY c.search_date ASC, p.site_url ASC`,
    [orgId, input.brandId ?? null, input.since ?? null, input.until ?? null]
  );
  return result.rows.map((r) => ({
    siteUrl: r.site_url as string,
    brandId: (r.brand_id as string | null) ?? null,
    date: r.d as string,
    clicks: Number(r.clicks),
  }));
};
