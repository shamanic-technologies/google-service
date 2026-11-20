// SEC-GOOGLE-KEY-1120: every route except /health and /openapi.json requires
// x-api-key == GOOGLE_SERVICE_API_KEY, checked BEFORE identity parsing and run
// creation. One case per route family, each with no key, a bogus key and the
// right key.
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const { mockQuery, mockCreateRun, mockUpdateRun } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
}));

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "the-real-google-service-key",
    KEY_SERVICE_URL: "http://localhost:3001",
    KEY_SERVICE_API_KEY: "k",
    RUNS_SERVICE_URL: "http://localhost:3002",
    RUNS_SERVICE_API_KEY: "k",
    BILLING_SERVICE_URL: "http://localhost:3003",
    BILLING_SERVICE_API_KEY: "k",
    CHAT_SERVICE_URL: "http://localhost:3004",
    CHAT_SERVICE_API_KEY: "k",
    BRAND_SERVICE_URL: "http://localhost:3005",
    BRAND_SERVICE_API_KEY: "k",
    GOOGLE_GMAIL_BACKFILL_DAYS: 365,
  },
}));

vi.mock("../db/client", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args), connect: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock("../services/runs-service", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: vi.fn(),
}));

import { createApp } from "../app";
import { isValidServiceKey } from "../middleware/api-key-auth";

const app = createApp();

const RIGHT_KEY = "the-real-google-service-key";
const identity = {
  "x-org-id": "00000000-0000-4000-a000-000000000001",
  "x-user-id": "00000000-0000-4000-a000-000000000002",
  "x-run-id": "00000000-0000-4000-a000-000000000003",
};

type Method = "get" | "post" | "put" | "patch" | "delete";
const ROUTES: Array<[string, Method, string]> = [
  ["Google Ads OAuth (auth.ts)", "get", "/auth/url"],
  ["Google Ads OAuth callback (auth.ts)", "get", "/auth/callback?code=c&state=s"],
  ["Google Ads accounts (accounts.ts)", "get", "/accounts"],
  ["Google Ads campaigns read (campaigns.ts)", "get", "/accounts/123/campaigns"],
  ["Google Ads campaigns create (campaigns.ts)", "post", "/accounts/123/campaigns"],
  ["Google Ads campaigns update (campaigns.ts)", "patch", "/accounts/123/campaigns/1"],
  ["Google Ads conversion upload (campaigns.ts)", "post", "/accounts/123/conversions/upload"],
  ["Google Ads spend (campaigns.ts)", "get", "/accounts/123/spend"],
  ["Google Ads serving (serving.ts)", "get", "/accounts/123/campaigns/1/ad-groups"],
  ["Google Ads managed accounts (serving.ts)", "post", "/orgs/google-ads/managed-accounts"],
  ["Serper search web (search.ts)", "post", "/search/web"],
  ["Serper search batch (search.ts)", "post", "/search/batch"],
  ["Gmail OAuth start (orgs-google.ts)", "post", "/orgs/google/auth/start"],
  ["Gmail messages (orgs-google.ts)", "get", "/orgs/google/messages"],
  ["Gmail thread reply (orgs-google.ts)", "post", "/orgs/google/thread-replies"],
  ["Calendar (calendar.ts)", "get", "/orgs/google/calendar/accounts"],
  ["Calendar internal feed (calendar.ts)", "get", "/internal/calendar/events"],
  ["Search Console (search-console.ts)", "get", "/orgs/google/search-console/accounts"],
  ["Staff mailboxes (internal-staff-mailboxes.ts)", "get", "/internal/staff-mailboxes/conversation?email=a@b.co"],
  ["Unknown path", "get", "/does-not-exist"],
];

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateRun.mockResolvedValue("00000000-0000-4000-a000-000000000009");
  mockUpdateRun.mockResolvedValue(undefined);
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("service key gate (SEC-GOOGLE-KEY-1120)", () => {
  describe.each(ROUTES)("%s", (_family, method, path) => {
    it("401 with NO key, no run opened, no DB read", async () => {
      const res = await request(app)[method](path).set(identity).send({});
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid or missing API key" });
      expect(mockCreateRun).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("401 with a BOGUS key, no run opened, no DB read", async () => {
      const res = await request(app)[method](path).set({ ...identity, "x-api-key": "bogus" }).send({});
      expect(res.status).toBe(401);
      expect(mockCreateRun).not.toHaveBeenCalled();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("passes the gate with the RIGHT key", async () => {
      const res = await request(app)[method](path).set({ ...identity, "x-api-key": RIGHT_KEY }).send({});
      expect(res.status).not.toBe(401);
      expect(mockCreateRun).toHaveBeenCalledTimes(1);
    });
  });

  it("401 before identity validation: no key and no identity is 401, not 400", async () => {
    const res = await request(app).get("/accounts");
    expect(res.status).toBe(401);
  });

  it("a key that is a prefix or extension of the real one is refused", async () => {
    for (const k of [RIGHT_KEY.slice(0, -1), `${RIGHT_KEY}x`, RIGHT_KEY.toUpperCase(), ""]) {
      const res = await request(app).get("/accounts").set({ ...identity, "x-api-key": k });
      expect(res.status).toBe(401);
    }
  });

  it("isValidServiceKey refuses non-strings (repeated header arrives as an array)", () => {
    expect(isValidServiceKey(undefined)).toBe(false);
    expect(isValidServiceKey([RIGHT_KEY, RIGHT_KEY])).toBe(false);
    expect(isValidServiceKey(RIGHT_KEY)).toBe(true);
  });

  it("/health and /openapi.json stay public", async () => {
    expect((await request(app).get("/health")).status).toBe(200);
    expect((await request(app).get("/openapi.json")).status).not.toBe(401);
  });
});
