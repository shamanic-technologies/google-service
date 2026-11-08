// GSC-CONNECTOR-1108, on a REAL Postgres (PGlite, the real migration): a client
// connects Google Search Console on its own consent, each property is tied to
// the brand owning the site, every listed Google day lands in bronze + silver,
// and its clicks are declared as "Google search click" Units (one per click) on
// a run of that brand; a revised day voids its run and re-declares, a day Google
// does not list is never read as zero, overlapping properties never count twice.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  userEmail: vi.fn(),
  revoke: vi.fn(),
  createRun: vi.fn(),
}));

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "test-google-service-key",
    GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:8080/orgs/google/auth/callback",
    GOOGLE_GMAIL_BACKFILL_DAYS: 365,
    RUNS_SERVICE_URL: "http://runs.test",
    RUNS_SERVICE_API_KEY: "runs-key",
    BRAND_SERVICE_URL: "http://brand.test",
    BRAND_SERVICE_API_KEY: "brand-key",
    GOOGLE_SEARCH_CONSOLE_LOOKBACK_DAYS: 10,
    GOOGLE_SEARCH_CONSOLE_BACKFILL_DAYS: 30,
  },
}));

// pg-shaped facade over one in-memory PGlite. A transaction (pool.connect)
// holds the single connection until release, like a row lock would make a
// concurrent writer wait, so the purge's per-batch transactions interleave with
// requests exactly at batch boundaries.
vi.mock("../db/client", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  let tail: Promise<void> = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const prev = tail;
    tail = prev.then(() => mine);
    await prev;
    return release;
  };
  const norm = (params: unknown[]) =>
    params.map((p) =>
      p !== null && typeof p === "object" && !(p instanceof Date) && !Array.isArray(p)
        ? JSON.stringify(p)
        : p
    );
  const run = async (sql: string, params?: unknown[]) => {
    if (!params || params.length === 0) {
      const rs = await db.exec(sql);
      const last = rs[rs.length - 1] ?? { rows: [], affectedRows: 0 };
      return { rows: last.rows as Record<string, unknown>[], rowCount: last.affectedRows ?? 0 };
    }
    const r = await db.query(sql, norm(params));
    return { rows: r.rows as Record<string, unknown>[], rowCount: r.affectedRows ?? 0 };
  };
  const query = async (sql: string, params?: unknown[]) => {
    const release = await acquire();
    try {
      return await run(sql, params);
    } finally {
      release();
    }
  };
  const pool = {
    query,
    connect: async () => {
      const release = await acquire();
      return { query: run, release };
    },
  };
  return { pool, query };
});

vi.mock("../services/google-oauth", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-oauth");
  return {
    ...actual,
    exchangeCodeForTokens: (...a: unknown[]) => mocks.exchange(...a),
    fetchGoogleUserEmail: (...a: unknown[]) => mocks.userEmail(...a),
    revokeGoogleToken: (...a: unknown[]) => mocks.revoke(...a),
  };
});
vi.mock("../services/key-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/key-service");
  return { ...actual, getGoogleOAuthClient: vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "cs" }) };
});
vi.mock("../services/sync", () => ({ syncOrg: vi.fn().mockResolvedValue({}) }));
vi.mock("../services/runs-service", () => ({
  createRun: (...a: unknown[]) => mocks.createRun(...a),
  updateRun: vi.fn().mockResolvedValue(undefined),
  addCosts: vi.fn(),
}));
vi.mock("../services/billing-client", () => ({ authorizeCredits: vi.fn() }));
vi.mock("../services/serper", () => ({ searchWeb: vi.fn(), searchNews: vi.fn() }));
vi.mock("../services/google-ads", () => ({ createGoogleAdsClient: () => ({}) }));

import { query } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createApp } from "../app";
import { SEARCH_CONSOLE_SCOPE } from "../services/google-oauth";
import {
  assignStatuses,
  matchBrand,
  propertyCovers,
  syncSearchConsoleAccount,
  upsertSearchConsoleAccount,
  type SearchConsoleAccount,
} from "../services/search-console";

const app = createApp();

const ORG = "00000000-0000-4000-a000-000000000001";
const USER = "00000000-0000-4000-a000-000000000002";
const BRAND = "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb";
const headers = () => ({
  "x-api-key": "test-google-service-key",
  "x-org-id": ORG,
  "x-user-id": USER,
  "x-run-id": "00000000-0000-4000-a000-000000000003",
});
const CALLER = { method: "TEST", path: "/test" };
const NOW = new Date("2026-11-08T12:00:00Z");

const addAccount = (email = "owner@distribute.you"): Promise<SearchConsoleAccount> =>
  upsertSearchConsoleAccount({
    orgId: ORG,
    userId: USER,
    googleAccountEmail: email,
    refreshToken: `rt-${email}`,
    accessToken: "at",
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    scopes: `${SEARCH_CONSOLE_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
  });

// Google's state: listed properties, and per property per date the page rows.
let sites: { siteUrl: string; permissionLevel: string }[] = [];
let data: Record<string, Record<string, Record<string, number>>> = {};
let brands: { id: string; domain: string | null; brandUrl: string | null }[] = [];
let declared: { runId: string; occurredAt: string; produced: { subjectId: string; outcomeKey: string; performer: unknown }[] }[] = [];
let voided: string[] = [];
let runSeq = 0;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === "https://www.googleapis.com/webmasters/v3/sites") return json(200, { siteEntry: sites });
  const m = url.match(/webmasters\/v3\/sites\/(.+)\/searchAnalytics\/query$/);
  if (m) {
    const site = decodeURIComponent(m[1]);
    const body = JSON.parse(String(init?.body));
    const byDate = data[site] ?? {};
    if (body.dimensions[0] === "date") {
      const rows = Object.keys(byDate)
        .filter((d) => d >= body.startDate && d <= body.endDate)
        .map((d) => ({ keys: [d], clicks: Object.values(byDate[d]).reduce((a, b) => a + b, 0), impressions: 100 }));
      return json(200, { rows });
    }
    const pages = byDate[body.startDate] ?? {};
    return json(200, {
      rows: Object.entries(pages).map(([page, clicks]) => ({ keys: [page], clicks, impressions: clicks * 10, ctr: 0.1, position: 4.2 })),
      responseAggregationType: "byPage",
    });
  }
  if (url === "http://brand.test/orgs/brands") return json(200, { brands });
  if (url === "http://runs.test/v1/platform-runs/outcomes/batch") {
    const body = JSON.parse(String(init?.body));
    declared.push(...body.runs);
    return json(200, { runs: [] });
  }
  const v = url.match(/^http:\/\/runs\.test\/v1\/platform-runs\/(.+)\/outcomes\/void$/);
  if (v) {
    voided.push(v[1]);
    return json(200, { status: "voided" });
  }
  throw new Error(`unexpected fetch ${url}`);
});

// Runs opened for click days (the request middleware opens its own runs too).
const clickRunCalls = () =>
  mocks.createRun.mock.calls.map((c) => c[0] as Record<string, any>).filter((p) => String(p.taskName ?? "").startsWith("google-search-clicks:"));

const unitsByRun = () => {
  const out = new Map<string, number>();
  for (const d of declared) out.set(d.runId, (out.get(d.runId) ?? 0) + d.produced.length);
  return out;
};
const liveUnits = () => [...unitsByRun().entries()].filter(([id]) => !voided.includes(id)).reduce((n, [, c]) => n + c, 0);

beforeAll(async () => {
  await runMigrations();
}, 60_000);

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  for (const m of Object.values(mocks)) m.mockReset();
  runSeq = 0;
  mocks.createRun.mockImplementation(async () => `00000000-0000-4000-b000-${String(++runSeq).padStart(12, "0")}`);
  sites = [];
  data = {};
  brands = [{ id: BRAND, domain: "distribute.you", brandUrl: "https://distribute.you" }];
  declared = [];
  voided = [];
  await query(`DELETE FROM google_search_console_properties`, []);
  await query(`DELETE FROM google_search_console_accounts`, []);
  await query(`DELETE FROM google_oauth_pending`, []);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("property -> brand", () => {
  it("ties a domain or URL-prefix property to the brand of that domain, the most specific wins", () => {
    const b = [
      { id: "a", domain: "distribute.you", brandUrl: null },
      { id: "b", domain: "blog.distribute.you", brandUrl: null },
    ];
    expect(matchBrand("sc-domain:distribute.you", b)).toEqual({ brandId: "a", status: "counting" });
    expect(matchBrand("https://www.distribute.you/", b)).toEqual({ brandId: "a", status: "counting" });
    expect(matchBrand("https://blog.distribute.you/", b)).toEqual({ brandId: "b", status: "counting" });
    expect(matchBrand("https://notdistribute.you/", b).status).toBe("no_brand");
    expect(matchBrand("https://x.com/", [...b, { id: "c", domain: "x.com", brandUrl: null }, { id: "d", domain: "www.x.com", brandUrl: null }]).status).toBe(
      "brand_ambiguous"
    );
  });

  it("a property covered by another of the same brand never counts", () => {
    expect(propertyCovers("sc-domain:distribute.you", "https://www.distribute.you/")).toBe(true);
    expect(propertyCovers("https://distribute.you/", "https://distribute.you/blog/")).toBe(true);
    expect(propertyCovers("https://distribute.you/blog/", "https://distribute.you/")).toBe(false);
    expect(propertyCovers("https://distribute.you/", "sc-domain:distribute.you")).toBe(false);
    const s = assignStatuses(
      [
        { id: "1", siteUrl: "sc-domain:distribute.you", permissionLevel: "siteOwner", listed: true },
        { id: "2", siteUrl: "https://distribute.you/", permissionLevel: "siteOwner", listed: true },
        { id: "3", siteUrl: "https://other.com/", permissionLevel: "siteOwner", listed: true },
        { id: "4", siteUrl: "https://blog.distribute.you/", permissionLevel: "siteUnverifiedUser", listed: true },
      ],
      [{ id: BRAND, domain: "distribute.you", brandUrl: null }]
    );
    expect(Object.fromEntries([...s].map(([k, v]) => [k, v.status]))).toEqual({
      "1": "counting",
      "2": "covered",
      "3": "no_brand",
      "4": "unverified",
    });
  });
});

describe("daily clicks -> Units", () => {
  it("declares one Unit per click, per Google day, on a run of the brand, once", async () => {
    sites = [
      { siteUrl: "sc-domain:distribute.you", permissionLevel: "siteOwner" },
      { siteUrl: "https://distribute.you/", permissionLevel: "siteOwner" },
      { siteUrl: "https://other.com/", permissionLevel: "siteOwner" },
    ];
    data["sc-domain:distribute.you"] = {
      "2026-11-03": { "https://distribute.you/": 3, "https://distribute.you/blog/a": 2, "https://distribute.you/x": 0 },
      "2026-11-04": { "https://distribute.you/": 1 },
    };
    data["https://distribute.you/"] = { "2026-11-03": { "https://distribute.you/": 3 } };
    const account = await addAccount();
    const s = await syncSearchConsoleAccount(account, CALLER, NOW);
    expect(s).toMatchObject({ properties: 3, counting: 1, declared: 2 });

    // one run per Google day, of the brand, dated by that day
    expect(clickRunCalls()).toHaveLength(2);
    expect(clickRunCalls()[0]).toMatchObject({ orgId: ORG, service: "google", brandId: BRAND, taskName: "google-search-clicks:2026-11-03" });
    expect(declared.map((d) => d.occurredAt).sort()).toEqual(["2026-11-03T12:00:00.000Z", "2026-11-04T12:00:00.000Z"]);
    expect(liveUnits()).toBe(6);
    expect(new Set(declared.flatMap((d) => d.produced.map((p) => p.subjectId))).size).toBe(6);
    expect(declared[0].produced[0]).toMatchObject({ outcomeKey: "google_search_click", performer: { kind: "organic", name: "google-search-console" } });

    // bronze + silver
    const raw = await query(`SELECT count(*)::int AS n FROM google_search_console_days_raw`, []);
    expect(raw.rows[0].n).toBe(2);
    const silver = await query(`SELECT sum(clicks)::int AS c, count(*)::int AS n FROM google_search_console_page_days`, []);
    expect(silver.rows[0]).toEqual({ c: 6, n: 4 });

    // statuses served
    const res = await request(app).get("/orgs/google/search-console/accounts").set(headers());
    expect(res.status).toBe(200);
    const props = Object.fromEntries(res.body.accounts[0].properties.map((p: any) => [p.siteUrl, p.status]));
    expect(props).toEqual({ "sc-domain:distribute.you": "counting", "https://distribute.you/": "covered", "https://other.com/": "no_brand" });

    const clicks = await request(app).get(`/orgs/google/search-console/clicks?brandId=${BRAND}`).set(headers());
    expect(clicks.body.totalClicks).toBe(6);
    expect(clicks.body.days.map((d: any) => [d.date, d.clicks])).toEqual([["2026-11-03", 5], ["2026-11-04", 1]]);

    // a second pass with the same figures declares nothing
    await syncSearchConsoleAccount(account, CALLER, NOW);
    expect(clickRunCalls()).toHaveLength(2);
    expect(voided).toEqual([]);
  });

  it("a revised day voids its run and re-declares on a new one; an unlisted day stays", async () => {
    sites = [{ siteUrl: "sc-domain:distribute.you", permissionLevel: "siteOwner" }];
    data["sc-domain:distribute.you"] = {
      "2026-11-03": { "https://distribute.you/": 3 },
      "2026-11-04": { "https://distribute.you/": 1 },
    };
    const account = await addAccount();
    await syncSearchConsoleAccount(account, CALLER, NOW);
    expect(liveUnits()).toBe(4);
    const firstRun03 = declared.find((d) => d.occurredAt.startsWith("2026-11-03"))!.runId;

    data["sc-domain:distribute.you"]["2026-11-03"] = { "https://distribute.you/": 4, "https://distribute.you/b": 1 };
    delete data["sc-domain:distribute.you"]["2026-11-04"]; // Google stops listing it
    await syncSearchConsoleAccount(account, CALLER, NOW);
    expect(voided).toEqual([firstRun03]);
    expect(clickRunCalls()[2].idempotencyKey).toMatch(/:2026-11-03:r1$/);
    expect(liveUnits()).toBe(6);
    const clicks = await request(app).get("/orgs/google/search-console/clicks").set(headers());
    expect(clicks.body.days.map((d: any) => [d.date, d.clicks])).toEqual([["2026-11-03", 5], ["2026-11-04", 1]]);
  });

  it("a property that stops counting takes its Units back", async () => {
    sites = [{ siteUrl: "https://distribute.you/", permissionLevel: "siteOwner" }];
    data["https://distribute.you/"] = { "2026-11-03": { "https://distribute.you/": 2 } };
    data["sc-domain:distribute.you"] = { "2026-11-03": { "https://distribute.you/": 2 } };
    const account = await addAccount();
    await syncSearchConsoleAccount(account, CALLER, NOW);
    expect(liveUnits()).toBe(2);

    // the client adds the domain property: the URL-prefix one is now covered
    sites.push({ siteUrl: "sc-domain:distribute.you", permissionLevel: "siteOwner" });
    await syncSearchConsoleAccount(account, CALLER, NOW);
    expect(voided).toHaveLength(1);
    expect(liveUnits()).toBe(2);
  });

  it("no brand for the site = stored as such, nothing declared", async () => {
    brands = [];
    sites = [{ siteUrl: "sc-domain:distribute.you", permissionLevel: "siteOwner" }];
    data["sc-domain:distribute.you"] = { "2026-11-03": { "https://distribute.you/": 2 } };
    const account = await addAccount();
    await syncSearchConsoleAccount(account, CALLER, NOW);
    expect(declared).toEqual([]);
    const res = await request(app).get("/orgs/google/search-console/accounts").set(headers());
    expect(res.body.accounts[0].properties[0]).toMatchObject({ status: "no_brand", brandId: null });
  });
});

describe("connect + disconnect", () => {
  it("connects on its own consent into its own table", async () => {
    const start = await request(app).post("/orgs/google/auth/start").set(headers()).send({ connection: "search_console" });
    expect(start.status).toBe(200);
    expect(decodeURIComponent(start.body.url)).toContain(SEARCH_CONSOLE_SCOPE);
    mocks.exchange.mockResolvedValue({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: SEARCH_CONSOLE_SCOPE, token_type: "Bearer" });
    mocks.userEmail.mockResolvedValue("owner@distribute.you");
    const cb = await request(app).get(`/orgs/google/auth/callback?code=c&state=${start.body.state}`).set(headers());
    expect(cb.status).toBe(200);
    expect(cb.body).toMatchObject({ connection: "search_console", googleAccountEmail: "owner@distribute.you", syncJobId: null });
    const mailbox = await query(`SELECT count(*)::int AS n FROM google_oauth_tokens`, []);
    expect(mailbox.rows[0].n).toBe(0);
  });

  it("refuses a consent without the Search Console box ticked", async () => {
    const start = await request(app).post("/orgs/google/auth/start").set(headers()).send({ connection: "search_console" });
    mocks.exchange.mockResolvedValue({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "openid email", token_type: "Bearer" });
    mocks.userEmail.mockResolvedValue("owner@distribute.you");
    const cb = await request(app).get(`/orgs/google/auth/callback?code=c&state=${start.body.state}`).set(headers());
    expect(cb.status).toBe(400);
    expect(cb.body.reason).toBe("search_console_permission_missing");
  });

  it("disconnect revokes, keeps counted days and the properties", async () => {
    sites = [{ siteUrl: "sc-domain:distribute.you", permissionLevel: "siteOwner" }];
    data["sc-domain:distribute.you"] = { "2026-11-03": { "https://distribute.you/": 2 } };
    const account = await addAccount();
    await syncSearchConsoleAccount(account, CALLER, NOW);
    mocks.revoke.mockResolvedValue("revoked");
    const del = await request(app).delete("/orgs/google/search-console/accounts/owner%40distribute.you").set(headers());
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ disconnected: true, grant: "revoked" });
    const kept = await query(`SELECT count(*)::int AS n FROM google_search_console_click_days WHERE run_id IS NOT NULL`, []);
    expect(kept.rows[0].n).toBe(1);
    // reconnecting finds the same day already declared: nothing twice
    const again = await addAccount();
    await syncSearchConsoleAccount(again, CALLER, NOW);
    expect(clickRunCalls()).toHaveLength(1);
  });
});
