import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

const {
  mockQuery,
  mockGetGoogleOAuthClient,
  mockExchangeCodeForTokens,
  mockFetchGoogleUserEmail,
  mockListOrgGoogleAccounts,
  mockUpsertGoogleToken,
  mockIngestGmail,
  mockIngestPeople,
  mockCreateRun,
  mockUpdateRun,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetGoogleOAuthClient: vi.fn(),
  mockExchangeCodeForTokens: vi.fn(),
  mockFetchGoogleUserEmail: vi.fn(),
  mockListOrgGoogleAccounts: vi.fn(),
  mockUpsertGoogleToken: vi.fn(),
  mockIngestGmail: vi.fn(),
  mockIngestPeople: vi.fn(),
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
}));

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    GOOGLE_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_SERVICE_API_KEY: "test-google-service-key",
    KEY_SERVICE_URL: "http://localhost:3001",
    KEY_SERVICE_API_KEY: "test-key-service-key",
    RUNS_SERVICE_URL: "http://localhost:3002",
    RUNS_SERVICE_API_KEY: "test-runs-service-key",
    BILLING_SERVICE_URL: "http://localhost:3003",
    BILLING_SERVICE_API_KEY: "test-billing-service-key",
    GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:8080/orgs/google/auth/callback",
    GOOGLE_GMAIL_BACKFILL_DAYS: 365,
  },
}));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock("../services/key-service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/key-service");
  return {
    ...actual,
    getGoogleOAuthClient: (...args: unknown[]) => mockGetGoogleOAuthClient(...args),
    storeRefreshToken: vi.fn(),
    getRefreshToken: vi.fn(),
    getGoogleCredentials: vi.fn(),
    getSerperApiKey: vi.fn(),
  };
});

vi.mock("../services/google-oauth", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../services/google-oauth");
  return {
    ...actual,
    exchangeCodeForTokens: (...args: unknown[]) => mockExchangeCodeForTokens(...args),
    fetchGoogleUserEmail: (...args: unknown[]) => mockFetchGoogleUserEmail(...args),
  };
});

vi.mock("../services/google-tokens", () => ({
  listOrgGoogleAccounts: (...args: unknown[]) => mockListOrgGoogleAccounts(...args),
  upsertGoogleToken: (...args: unknown[]) => mockUpsertGoogleToken(...args),
}));

vi.mock("../services/gmail-ingest", () => ({
  ingestGmailForAccount: (...args: unknown[]) => mockIngestGmail(...args),
}));

vi.mock("../services/people-ingest", () => ({
  ingestPeopleForAccount: (...args: unknown[]) => mockIngestPeople(...args),
}));

vi.mock("../services/runs-service", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: vi.fn(),
}));

vi.mock("../services/billing-client", () => ({
  authorizeCredits: vi.fn(),
}));

vi.mock("../services/serper", () => ({
  searchWeb: vi.fn(),
  searchNews: vi.fn(),
}));

vi.mock("../services/google-ads", () => ({
  createGoogleAdsClient: () => ({}),
  getCustomer: vi.fn(),
  listAccessibleAccounts: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  listCampaigns: vi.fn(),
  getCampaignDetail: vi.fn(),
  getCampaignPerformance: vi.fn(),
  listConversionActions: vi.fn(),
  createCampaign: vi.fn(),
  updateCampaign: vi.fn(),
  duplicateCampaign: vi.fn(),
}));

import { createApp } from "../app";

const app = createApp();

const TEST_ORG_ID = "00000000-0000-4000-a000-000000000001";
const TEST_USER_ID = "00000000-0000-4000-a000-000000000002";
const TEST_RUN_ID = "00000000-0000-4000-a000-000000000003";
const TEST_CHILD_RUN_ID = "00000000-0000-4000-a000-000000000004";
const TEST_ACCOUNT_UUID = "00000000-0000-4000-a000-000000000099";

const idHeaders = {
  "x-api-key": "test-google-service-key",
  "x-org-id": TEST_ORG_ID,
  "x-user-id": TEST_USER_ID,
  "x-run-id": TEST_RUN_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateRun.mockResolvedValue(TEST_CHILD_RUN_ID);
  mockUpdateRun.mockResolvedValue(undefined);
  mockGetGoogleOAuthClient.mockResolvedValue({
    clientId: "client-abc",
    clientSecret: "secret-abc",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── AC7: api-key + identity ───

describe("auth surface for /orgs/google/*", () => {
  it("rejects missing x-api-key with 401", async () => {
    const res = await request(app)
      .post("/orgs/google/auth/start")
      .set({ "x-org-id": TEST_ORG_ID, "x-user-id": TEST_USER_ID, "x-run-id": TEST_RUN_ID })
      .send({});
    expect(res.status).toBe(401);
  });

  it("rejects missing x-org-id with 400", async () => {
    const res = await request(app)
      .post("/orgs/google/auth/start")
      .set({ "x-api-key": "test-google-service-key", "x-user-id": TEST_USER_ID, "x-run-id": TEST_RUN_ID })
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });
});

// ─── AC2: auth/start ───

describe("POST /orgs/google/auth/start", () => {
  it("returns Google authorize URL with both readonly scopes and persists pending row", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/orgs/google/auth/start")
      .set(idHeaders)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.url).toContain("accounts.google.com");
    expect(res.body.url).toContain("client-abc");
    expect(res.body.url).toContain(encodeURIComponent("https://www.googleapis.com/auth/gmail.readonly"));
    expect(res.body.url).toContain(encodeURIComponent("https://www.googleapis.com/auth/contacts.readonly"));
    expect(res.body.url).toContain("code_challenge=");
    expect(res.body.url).toContain("code_challenge_method=S256");
    expect(res.body.state).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO google_oauth_pending"),
      expect.arrayContaining([TEST_ORG_ID, TEST_USER_ID])
    );
  });

  it("uses default redirectUri when body is empty", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/orgs/google/auth/start")
      .set(idHeaders)
      .send({});

    expect(res.body.url).toContain(
      encodeURIComponent("http://localhost:8080/orgs/google/auth/callback")
    );
  });
});

// ─── AC3 / AC11: auth/callback ───

describe("GET /orgs/google/auth/callback", () => {
  it("rejects invalid state with 400", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/orgs/google/auth/callback?code=abc&state=invalid")
      .set(idHeaders);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired");
  });

  it("exchanges code, stores token, returns 200", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            pkce_verifier: "verifier-x",
            redirect_uri: "http://localhost:8080/orgs/google/auth/callback",
            feature_slug: null,
            brand_id: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    mockExchangeCodeForTokens.mockResolvedValueOnce({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/contacts.readonly",
      token_type: "Bearer",
    });
    mockFetchGoogleUserEmail.mockResolvedValueOnce("alice@example.com");
    mockUpsertGoogleToken.mockResolvedValueOnce({
      id: TEST_ACCOUNT_UUID,
      googleAccountEmail: "alice@example.com",
    });

    const res = await request(app)
      .get("/orgs/google/auth/callback?code=valid&state=valid")
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.googleAccountId).toBe(TEST_ACCOUNT_UUID);
    expect(res.body.googleAccountEmail).toBe("alice@example.com");

    expect(mockExchangeCodeForTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "valid",
        pkceVerifier: "verifier-x",
        redirectUri: "http://localhost:8080/orgs/google/auth/callback",
      })
    );

    expect(mockUpsertGoogleToken).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: TEST_ORG_ID,
        googleAccountEmail: "alice@example.com",
        refreshToken: "rt",
      })
    );
  });
});

// ─── AC4 / AC5: sync ───

describe("POST /orgs/google/sync", () => {
  it("returns zeros when no connected accounts", async () => {
    mockListOrgGoogleAccounts.mockResolvedValueOnce([]);

    const res = await request(app).post("/orgs/google/sync").set(idHeaders).send({});
    expect(res.status).toBe(200);
    expect(res.body.accounts).toBe(0);
    expect(res.body.gmail).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
    expect(res.body.contacts).toEqual({
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
    });
  });

  it("aggregates gmail + people results across multiple accounts", async () => {
    const acct = (id: string) => ({ id, orgId: TEST_ORG_ID, userId: TEST_USER_ID, googleAccountEmail: `${id}@x.com`, refreshToken: "rt", accessToken: null, accessTokenExpiresAt: null, scopes: "", gmailHistoryId: null, peopleSyncToken: null });
    mockListOrgGoogleAccounts.mockResolvedValueOnce([acct("a-1"), acct("a-2")]);
    mockIngestGmail.mockResolvedValue({ inserted: 5, updated: 1, unchanged: 0 });
    mockIngestPeople.mockResolvedValue({ inserted: 3, updated: 0, unchanged: 0, deleted: 0 });

    const res = await request(app).post("/orgs/google/sync").set(idHeaders).send({});
    expect(res.status).toBe(200);
    expect(res.body.accounts).toBe(2);
    expect(res.body.gmail.inserted).toBe(10);
    expect(res.body.gmail.updated).toBe(2);
    expect(res.body.contacts.inserted).toBe(6);
  });
});

// ─── AC6: read endpoints ───

describe("GET /orgs/google/messages", () => {
  it("returns paginated raw messages with cursor", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: Array.from({ length: 51 }, (_, i) => ({
        id: `00000000-0000-4000-a000-${String(100 + i).padStart(12, "0")}`,
        google_account_id: TEST_ACCOUNT_UUID,
        gmail_message_id: `m-${i}`,
        thread_id: `t-${i}`,
        history_id: 12345 + i,
        payload: { snippet: `hello ${i}` },
        fetched_at: new Date(Date.now() - i * 1000),
      })),
    });

    const res = await request(app).get("/orgs/google/messages?limit=50").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(50);
    expect(res.body.items[0].payload.snippet).toBe("hello 0");
    expect(res.body.items[0].historyId).toBe("12345");
    expect(res.body.nextCursor).toBeTruthy();
  });

  it("filters by org_id in SQL", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/orgs/google/messages").set(idHeaders);
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("org_id = $1");
    expect(params[0]).toBe(TEST_ORG_ID);
  });

  it("filters by thread_id when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/orgs/google/messages?thread_id=tt-9").set(idHeaders);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain("tt-9");
  });
});

describe("GET /orgs/google/accounts", () => {
  it("rejects missing x-org-id with 400", async () => {
    const res = await request(app)
      .get("/orgs/google/accounts")
      .set({ "x-api-key": "test-google-service-key", "x-user-id": TEST_USER_ID, "x-run-id": TEST_RUN_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("returns empty list when org has no connected accounts", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/orgs/google/accounts").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accounts: [] });
  });

  it("returns accounts with mapped fields, scoped to org_id", async () => {
    const connectedAt = new Date("2026-05-01T12:00:00.000Z");
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          google_account_email: "alice@example.com",
          scopes: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/contacts.readonly",
          created_at: connectedAt,
        },
        {
          google_account_email: "bob@example.com",
          scopes: "https://www.googleapis.com/auth/gmail.readonly",
          created_at: new Date("2026-05-02T12:00:00.000Z"),
        },
      ],
    });

    const res = await request(app).get("/orgs/google/accounts").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(2);
    expect(res.body.accounts[0]).toEqual({
      email: "alice@example.com",
      status: "active",
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/contacts.readonly",
      ],
      connectedAt: "2026-05-01T12:00:00.000Z",
    });

    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("WHERE org_id = $1");
    expect(params).toEqual([TEST_ORG_ID]);
  });
});

describe("GET /orgs/google/contacts", () => {
  it("filters by query string via ILIKE on payload::text", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/orgs/google/contacts?query=alice").set(idHeaders);
    const sql = mockQuery.mock.calls[0][0] as string;
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(sql).toContain("ILIKE");
    expect(params).toContain("%alice%");
  });

  it("returns items with raw payloads", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: TEST_ACCOUNT_UUID,
          google_account_id: TEST_ACCOUNT_UUID,
          resource_name: "people/c1",
          etag: "abc",
          payload: { names: [{ displayName: "Alice" }] },
          fetched_at: new Date(),
        },
      ],
    });
    const res = await request(app).get("/orgs/google/contacts").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.items[0].resourceName).toBe("people/c1");
    expect(res.body.items[0].payload.names[0].displayName).toBe("Alice");
  });
});
