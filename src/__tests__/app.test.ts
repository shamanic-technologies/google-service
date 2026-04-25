import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Hoist all mocks so they're available in vi.mock factories
const {
  mockQuery,
  mockStoreRefreshToken,
  mockGetRefreshToken,
  mockGetGoogleCredentials,
  mockCreateRun,
  mockUpdateRun,
  mockAddCosts,
  mockAuthorizeCredits,
  mockExchangeCodeForTokens,
  mockListAccessibleAccounts,
  mockListCampaigns,
  mockGetCampaignDetail,
  mockGetCampaignPerformance,
  mockListConversionActions,
  mockCreateCampaign,
  mockUpdateCampaign,
  mockDuplicateCampaign,
  mockGetCustomer,
  mockSearchWeb,
  mockSearchNews,
  mockGetSerperApiKey,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockStoreRefreshToken: vi.fn(),
  mockGetRefreshToken: vi.fn(),
  mockGetGoogleCredentials: vi.fn(),
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
  mockAddCosts: vi.fn(),
  mockAuthorizeCredits: vi.fn(),
  mockExchangeCodeForTokens: vi.fn(),
  mockListAccessibleAccounts: vi.fn(),
  mockListCampaigns: vi.fn(),
  mockGetCampaignDetail: vi.fn(),
  mockGetCampaignPerformance: vi.fn(),
  mockListConversionActions: vi.fn(),
  mockCreateCampaign: vi.fn(),
  mockUpdateCampaign: vi.fn(),
  mockDuplicateCampaign: vi.fn(),
  mockGetCustomer: vi.fn(),
  mockSearchWeb: vi.fn(),
  mockSearchNews: vi.fn(),
  mockGetSerperApiKey: vi.fn(),
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
  },
}));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock("../services/key-service", () => ({
  storeRefreshToken: (...args: unknown[]) => mockStoreRefreshToken(...args),
  getRefreshToken: (...args: unknown[]) => mockGetRefreshToken(...args),
  getGoogleCredentials: (...args: unknown[]) => mockGetGoogleCredentials(...args),
  getSerperApiKey: (...args: unknown[]) => mockGetSerperApiKey(...args),
}));

vi.mock("../services/runs-service", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

vi.mock("../services/billing-client", () => ({
  authorizeCredits: (...args: unknown[]) => mockAuthorizeCredits(...args),
}));

vi.mock("../services/serper", () => ({
  searchWeb: (...args: unknown[]) => mockSearchWeb(...args),
  searchNews: (...args: unknown[]) => mockSearchNews(...args),
}));

vi.mock("../services/google-ads", () => ({
  createGoogleAdsClient: () => ({}),
  getCustomer: (...args: unknown[]) => mockGetCustomer(...args),
  listAccessibleAccounts: (...args: unknown[]) => mockListAccessibleAccounts(...args),
  exchangeCodeForTokens: (...args: unknown[]) => mockExchangeCodeForTokens(...args),
  listCampaigns: (...args: unknown[]) => mockListCampaigns(...args),
  getCampaignDetail: (...args: unknown[]) => mockGetCampaignDetail(...args),
  getCampaignPerformance: (...args: unknown[]) => mockGetCampaignPerformance(...args),
  listConversionActions: (...args: unknown[]) => mockListConversionActions(...args),
  createCampaign: (...args: unknown[]) => mockCreateCampaign(...args),
  updateCampaign: (...args: unknown[]) => mockUpdateCampaign(...args),
  duplicateCampaign: (...args: unknown[]) => mockDuplicateCampaign(...args),
}));

import { createApp } from "../app";

const app = createApp();

const TEST_ORG_ID = "00000000-0000-4000-a000-000000000001";
const TEST_USER_ID = "00000000-0000-4000-a000-000000000002";
const TEST_PARENT_RUN_ID = "00000000-0000-4000-a000-000000000003";
const TEST_CHILD_RUN_ID = "00000000-0000-4000-a000-000000000004";

const idHeaders = { "x-org-id": TEST_ORG_ID, "x-user-id": TEST_USER_ID, "x-run-id": TEST_PARENT_RUN_ID };

const TEST_GOOGLE_CREDS = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  developerToken: "test-dev-token",
  mccAccountId: "1234567890",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateRun.mockResolvedValue(TEST_CHILD_RUN_ID);
  mockUpdateRun.mockResolvedValue(undefined);
  mockAddCosts.mockResolvedValue(undefined);
  mockAuthorizeCredits.mockResolvedValue({ sufficient: true, balance_cents: 10000, required_cents: 100 });
  mockGetSerperApiKey.mockResolvedValue({ key: "test-serper-key", keySource: "app" });
  mockGetGoogleCredentials.mockResolvedValue(TEST_GOOGLE_CREDS);
});

// ─── Health ───

describe("GET /health", () => {
  it("returns ok without identity headers", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("google-service");
    expect(res.body.timestamp).toBeDefined();
  });
});

// ─── Identity Headers ───

describe("Identity headers middleware", () => {
  it("returns 400 without x-org-id", async () => {
    const res = await request(app)
      .get("/auth/url")
      .set("x-user-id", TEST_USER_ID)
      .set("x-run-id", TEST_PARENT_RUN_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("returns 400 without x-user-id", async () => {
    const res = await request(app)
      .get("/auth/url")
      .set("x-org-id", TEST_ORG_ID)
      .set("x-run-id", TEST_PARENT_RUN_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-user-id");
  });

  it("returns 400 without x-run-id", async () => {
    const res = await request(app)
      .get("/auth/url")
      .set("x-org-id", TEST_ORG_ID)
      .set("x-user-id", TEST_USER_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-run-id");
  });

  it("returns 400 when x-org-id is not a valid UUID", async () => {
    const res = await request(app)
      .get("/auth/url")
      .set("x-org-id", "platform")
      .set("x-user-id", TEST_USER_ID)
      .set("x-run-id", TEST_PARENT_RUN_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("x-org-id must be a valid UUID");
  });

  it("returns 400 when x-user-id is not a valid UUID", async () => {
    const res = await request(app)
      .get("/auth/url")
      .set("x-org-id", TEST_ORG_ID)
      .set("x-user-id", "not-a-uuid")
      .set("x-run-id", TEST_PARENT_RUN_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("x-user-id must be a valid UUID");
  });

  it("returns 400 when x-run-id is not a valid UUID", async () => {
    const res = await request(app)
      .get("/auth/url")
      .set("x-org-id", TEST_ORG_ID)
      .set("x-user-id", TEST_USER_ID)
      .set("x-run-id", "bad-run-id");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("x-run-id must be a valid UUID");
  });
});

// ─── Feature Slug ───

describe("x-feature-slug header propagation", () => {
  it("passes featureSlug to createRun when header is present", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get("/auth/url")
      .set({ ...idHeaders, "x-feature-slug": "my-feature" });

    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: TEST_PARENT_RUN_ID,
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      service: "google",
      featureSlug: "my-feature",
      brandId: undefined,
    });
  });

  it("passes undefined featureSlug when header is absent", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/auth/url").set(idHeaders);

    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: TEST_PARENT_RUN_ID,
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      service: "google",
      featureSlug: undefined,
      brandId: undefined,
    });
  });
});

// ─── Brand ID ───

const TEST_BRAND_ID = "brand-uuid-aaa,brand-uuid-bbb";

describe("x-brand-id header propagation", () => {
  it("passes brandId to createRun when header is present", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get("/auth/url")
      .set({ ...idHeaders, "x-brand-id": TEST_BRAND_ID });

    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: TEST_PARENT_RUN_ID,
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      service: "google",
      featureSlug: undefined,
      brandId: TEST_BRAND_ID,
    });
  });

  it("passes undefined brandId when header is absent", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/auth/url").set(idHeaders);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ brandId: undefined })
    );
  });

  it("forwards brandId to updateRun when header is present", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "uuid-1",
        org_id: TEST_ORG_ID,
        user_id: TEST_USER_ID,
        account_id: "111",
        mcc_id: "1234567890",
        created_at: new Date("2024-01-01"),
      }],
    });

    const res = await request(app)
      .get("/accounts")
      .set({ ...idHeaders, "x-brand-id": TEST_BRAND_ID });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    expect(mockUpdateRun).toHaveBeenCalledWith(TEST_CHILD_RUN_ID, "completed", TEST_ORG_ID, TEST_USER_ID, undefined, TEST_BRAND_ID);
  });

  it("forwards brandId to authorizeCredits for search", async () => {
    mockSearchWeb.mockResolvedValueOnce([]);

    await request(app)
      .post("/search/web")
      .set({ ...idHeaders, "x-brand-id": TEST_BRAND_ID })
      .send({ query: "test" });

    expect(mockAuthorizeCredits).toHaveBeenCalledWith(
      [{ costName: "serper-dev-query", quantity: 1 }],
      "serper-dev-query",
      TEST_ORG_ID,
      TEST_USER_ID,
      TEST_CHILD_RUN_ID,
      undefined,
      TEST_BRAND_ID
    );
  });

  it("forwards brandId to addCosts for search", async () => {
    mockSearchWeb.mockResolvedValueOnce([]);

    await request(app)
      .post("/search/web")
      .set({ ...idHeaders, "x-brand-id": TEST_BRAND_ID })
      .send({ query: "test" });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockAddCosts).toHaveBeenCalledWith(
      TEST_CHILD_RUN_ID,
      [{ costName: "serper-dev-query", quantity: 1, costSource: "platform" }],
      TEST_ORG_ID,
      TEST_USER_ID,
      undefined,
      TEST_BRAND_ID
    );
  });

  it("forwards brandId to getSerperApiKey for search", async () => {
    mockSearchWeb.mockResolvedValueOnce([]);

    await request(app)
      .post("/search/web")
      .set({ ...idHeaders, "x-brand-id": TEST_BRAND_ID })
      .send({ query: "test" });

    expect(mockGetSerperApiKey).toHaveBeenCalledWith(
      TEST_ORG_ID,
      TEST_USER_ID,
      expect.objectContaining({ method: "POST" }),
      TEST_CHILD_RUN_ID,
      undefined,
      TEST_BRAND_ID
    );
  });

  it("forwards brandId to getRefreshToken for campaigns", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockListCampaigns.mockResolvedValueOnce([]);

    await request(app)
      .get("/accounts/111/campaigns")
      .set({ ...idHeaders, "x-brand-id": TEST_BRAND_ID });

    expect(mockGetRefreshToken).toHaveBeenCalledWith(
      TEST_ORG_ID, TEST_USER_ID, "111",
      expect.objectContaining({ method: "GET" }),
      TEST_CHILD_RUN_ID, undefined, TEST_BRAND_ID
    );
  });
});

// ─── Run Creation ───

describe("Run creation middleware", () => {
  it("calls createRun with parent run ID, orgId, userId, and service", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/auth/url").set(idHeaders);

    expect(mockCreateRun).toHaveBeenCalledWith({
      parentRunId: TEST_PARENT_RUN_ID,
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      service: "google",
      featureSlug: undefined,
      brandId: undefined,
    });
  });

  it("returns 502 when runs-service is unavailable", async () => {
    mockCreateRun.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await request(app).get("/auth/url").set(idHeaders);
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("run tracking");
  });
});

// ─── Run Closing ───

describe("Run closing on response finish", () => {
  it("closes run as completed on successful response", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "uuid-1",
        org_id: TEST_ORG_ID,
        user_id: TEST_USER_ID,
        account_id: "111",
        mcc_id: "1234567890",
        created_at: new Date("2024-01-01"),
      }],
    });

    const res = await request(app).get("/accounts").set(idHeaders);
    expect(res.status).toBe(200);

    // Wait for async finish handler
    await new Promise((r) => setTimeout(r, 50));
    expect(mockUpdateRun).toHaveBeenCalledWith(TEST_CHILD_RUN_ID, "completed", TEST_ORG_ID, TEST_USER_ID, undefined, undefined);
  });

  it("closes run as failed on error response", async () => {
    mockQuery.mockRejectedValueOnce(new Error("DB error"));

    const res = await request(app).get("/accounts").set(idHeaders);
    expect(res.status).toBe(500);

    await new Promise((r) => setTimeout(r, 50));
    expect(mockUpdateRun).toHaveBeenCalledWith(TEST_CHILD_RUN_ID, "failed", TEST_ORG_ID, TEST_USER_ID, undefined, undefined);
  });

  it("forwards featureSlug to updateRun when header is present", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "uuid-1",
        org_id: TEST_ORG_ID,
        user_id: TEST_USER_ID,
        account_id: "111",
        mcc_id: "1234567890",
        created_at: new Date("2024-01-01"),
      }],
    });

    const res = await request(app)
      .get("/accounts")
      .set({ ...idHeaders, "x-feature-slug": "my-feature" });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    expect(mockUpdateRun).toHaveBeenCalledWith(TEST_CHILD_RUN_ID, "completed", TEST_ORG_ID, TEST_USER_ID, "my-feature", undefined);
  });
});

// ─── Auth URL ───

describe("GET /auth/url", () => {
  it("generates OAuth URL", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/auth/url").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("accounts.google.com");
    expect(res.body.url).toContain("test-client-id");
    expect(res.body.url).toContain("adwords");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO oauth_states"),
      expect.arrayContaining([TEST_ORG_ID, TEST_USER_ID])
    );
  });
});

// ─── Auth Callback ───

describe("GET /auth/callback", () => {
  it("returns 400 without code or state", async () => {
    const res = await request(app).get("/auth/callback").set(idHeaders);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid/expired state", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/auth/callback?code=abc&state=invalid")
      .set(idHeaders);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid or expired");
  });

  it("successfully links accounts on valid callback", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          org_id: TEST_ORG_ID,
          user_id: TEST_USER_ID,
          redirect_uri: "http://localhost:8080/auth/callback",
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // DELETE oauth_states
      .mockResolvedValueOnce({ rows: [] }); // INSERT accounts

    mockExchangeCodeForTokens.mockResolvedValueOnce({
      access_token: "at",
      refresh_token: "rt",
    });

    mockListAccessibleAccounts.mockResolvedValueOnce([
      { id: "111", name: "customers/111", descriptiveName: "Test Account" },
    ]);

    mockStoreRefreshToken.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .get("/auth/callback?code=validcode&state=validstate")
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.accountId).toBe("111");
    expect(mockStoreRefreshToken).toHaveBeenCalledWith(TEST_ORG_ID, "111", "rt", TEST_CHILD_RUN_ID, undefined, undefined);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO accounts"),
      expect.arrayContaining([TEST_ORG_ID, TEST_USER_ID])
    );
  });
});

// ─── Accounts ───

describe("GET /accounts", () => {
  it("returns accounts for org", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "uuid-1",
          org_id: TEST_ORG_ID,
          user_id: TEST_USER_ID,
          account_id: "111",
          mcc_id: "1234567890",
          created_at: new Date("2024-01-01"),
        },
      ],
    });

    const res = await request(app).get("/accounts").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].accountId).toBe("111");
    expect(res.body.accounts[0].orgId).toBe(TEST_ORG_ID);
    expect(res.body.accounts[0].userId).toBe(TEST_USER_ID);
  });
});

// ─── Campaigns List ───

describe("GET /accounts/:accountId/campaigns", () => {
  it("returns campaigns list", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockListCampaigns.mockResolvedValueOnce([
      {
        id: "123",
        name: "Test Campaign",
        status: "ENABLED",
        advertisingChannelType: "SEARCH",
      },
    ]);

    const res = await request(app)
      .get("/accounts/111/campaigns")
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].name).toBe("Test Campaign");
    expect(mockGetRefreshToken).toHaveBeenCalledWith(TEST_ORG_ID, TEST_USER_ID, "111", {
      method: "GET",
      path: "/accounts/:accountId/campaigns",
    }, TEST_CHILD_RUN_ID, undefined, undefined);
  });

  it("filters by status", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockListCampaigns.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/accounts/111/campaigns?status=PAUSED")
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(mockListCampaigns).toHaveBeenCalledWith({}, "PAUSED");
  });
});

// ─── Campaign Detail ───

describe("GET /accounts/:accountId/campaigns/:campaignId", () => {
  it("returns campaign detail", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockGetCampaignDetail.mockResolvedValueOnce({
      id: "123",
      name: "Test Campaign",
      status: "ENABLED",
      advertisingChannelType: "SEARCH",
      resourceName: "customers/111/campaigns/123",
    });

    const res = await request(app)
      .get("/accounts/111/campaigns/123")
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("123");
    expect(res.body.resourceName).toBe("customers/111/campaigns/123");
  });

  it("returns 404 for non-existent campaign", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockGetCampaignDetail.mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/accounts/111/campaigns/999")
      .set(idHeaders);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Campaign not found");
  });
});

// ─── Campaign Performance ───

describe("GET /accounts/:accountId/campaigns/:campaignId/performance", () => {
  it("returns 400 without date params", async () => {
    const res = await request(app)
      .get("/accounts/111/campaigns/123/performance")
      .set(idHeaders);
    expect(res.status).toBe(400);
  });

  it("returns performance metrics", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockGetCampaignPerformance.mockResolvedValueOnce({
      impressions: 10000,
      clicks: 500,
      conversions: 50,
      costMicros: "5000000000",
      cpa: 100,
      roas: 0.01,
      ctr: 0.05,
      averageCpc: 10,
    });

    const res = await request(app)
      .get("/accounts/111/campaigns/123/performance?startDate=2024-01-01&endDate=2024-01-31")
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe("123");
    expect(res.body.metrics.impressions).toBe(10000);
    expect(res.body.metrics.clicks).toBe(500);
    expect(res.body.metrics.cpa).toBe(100);
  });
});

// ─── Conversions ───

describe("GET /accounts/:accountId/conversions", () => {
  it("returns conversion actions", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockListConversionActions.mockResolvedValueOnce([
      {
        id: "456",
        name: "Purchase",
        category: "PURCHASE",
        status: "ENABLED",
        type: "WEBPAGE",
      },
    ]);

    const res = await request(app)
      .get("/accounts/111/conversions")
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.conversionActions).toHaveLength(1);
    expect(res.body.conversionActions[0].name).toBe("Purchase");
  });
});

// ─── Create Campaign ───

describe("POST /accounts/:accountId/campaigns", () => {
  it("returns 400 with invalid body", async () => {
    const res = await request(app)
      .post("/accounts/111/campaigns")
      .set(idHeaders)
      .send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("passes correct caller context to getRefreshToken", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockCreateCampaign.mockResolvedValueOnce({
      id: "789",
      name: "New Campaign",
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
      budgetAmountMicros: "5000000",
    });

    await request(app)
      .post("/accounts/111/campaigns")
      .set(idHeaders)
      .send({
        name: "New Campaign",
        advertisingChannelType: "SEARCH",
        budgetAmountMicros: "5000000",
      });
    expect(mockGetRefreshToken).toHaveBeenCalledWith(TEST_ORG_ID, TEST_USER_ID, "111", {
      method: "POST",
      path: "/accounts/:accountId/campaigns",
    }, TEST_CHILD_RUN_ID, undefined, undefined);
  });

  it("creates a campaign", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockCreateCampaign.mockResolvedValueOnce({
      id: "789",
      name: "New Campaign",
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
      budgetAmountMicros: "5000000",
    });

    const res = await request(app)
      .post("/accounts/111/campaigns")
      .set(idHeaders)
      .send({
        name: "New Campaign",
        advertisingChannelType: "SEARCH",
        budgetAmountMicros: "5000000",
      });
    expect(res.status).toBe(201);
    expect(res.body.campaign.id).toBe("789");
    expect(res.body.message).toBe("Campaign created successfully");
  });
});

// ─── Update Campaign ───

describe("PATCH /accounts/:accountId/campaigns/:campaignId", () => {
  it("updates a campaign", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockUpdateCampaign.mockResolvedValueOnce({
      id: "123",
      name: "Test Campaign",
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
    });

    const res = await request(app)
      .patch("/accounts/111/campaigns/123")
      .set(idHeaders)
      .send({ status: "PAUSED" });
    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe("PAUSED");
    expect(res.body.message).toBe("Campaign updated successfully");
    expect(mockGetRefreshToken).toHaveBeenCalledWith(TEST_ORG_ID, TEST_USER_ID, "111", {
      method: "PATCH",
      path: "/accounts/:accountId/campaigns/:campaignId",
    }, TEST_CHILD_RUN_ID, undefined, undefined);
  });
});

// ─── Duplicate Campaign ───

describe("POST /accounts/:accountId/campaigns/:campaignId/duplicate", () => {
  it("duplicates a campaign", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockDuplicateCampaign.mockResolvedValueOnce({
      id: "999",
      name: "Test Campaign (copy)",
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
    });

    const res = await request(app)
      .post("/accounts/111/campaigns/123/duplicate")
      .set(idHeaders)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.campaign.id).toBe("999");
    expect(res.body.message).toBe("Campaign duplicated successfully");
  });

  it("duplicates with custom name", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockDuplicateCampaign.mockResolvedValueOnce({
      id: "1000",
      name: "AB Test Variant B",
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
    });

    const res = await request(app)
      .post("/accounts/111/campaigns/123/duplicate")
      .set(idHeaders)
      .send({ newName: "AB Test Variant B" });
    expect(res.status).toBe(201);
    expect(res.body.campaign.name).toBe("AB Test Variant B");
  });
});

// ─── Account not found ───

describe("Account not found error handling", () => {
  it("returns 404 when account is not in DB", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/accounts/999/campaigns")
      .set(idHeaders);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Account not found");
  });
});

// ─── Search Web ───

describe("POST /search/web", () => {
  it("returns 400 with empty query", async () => {
    const res = await request(app)
      .post("/search/web")
      .set(idHeaders)
      .send({ query: "" });
    expect(res.status).toBe(400);
  });

  it("returns web search results", async () => {
    mockSearchWeb.mockResolvedValueOnce([
      {
        title: "TechCrunch",
        link: "https://techcrunch.com",
        snippet: "Tech news",
        domain: "techcrunch.com",
        position: 1,
      },
    ]);

    const res = await request(app)
      .post("/search/web")
      .set(idHeaders)
      .send({ query: "best tech publications" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].title).toBe("TechCrunch");
    expect(res.body.results[0].domain).toBe("techcrunch.com");
    expect(mockSearchWeb).toHaveBeenCalledWith(
      { query: "best tech publications" },
      "test-serper-key"
    );
  });

  it("authorizes billing before platform-key search", async () => {
    mockSearchWeb.mockResolvedValueOnce([]);

    await request(app)
      .post("/search/web")
      .set(idHeaders)
      .send({ query: "test" });

    expect(mockAuthorizeCredits).toHaveBeenCalledWith(
      [{ costName: "serper-dev-query", quantity: 1 }],
      "serper-dev-query",
      TEST_ORG_ID,
      TEST_USER_ID,
      TEST_CHILD_RUN_ID,
      undefined,
      undefined
    );
  });

  it("skips billing for BYOK key", async () => {
    mockGetSerperApiKey.mockResolvedValueOnce({ key: "user-key", keySource: "byok" });
    mockSearchWeb.mockResolvedValueOnce([]);

    await request(app)
      .post("/search/web")
      .set(idHeaders)
      .send({ query: "test" });

    expect(mockAuthorizeCredits).not.toHaveBeenCalled();
  });

  it("reports costs after successful search", async () => {
    mockSearchWeb.mockResolvedValueOnce([]);

    await request(app)
      .post("/search/web")
      .set(idHeaders)
      .send({ query: "test" });

    // Wait for async cost reporting
    await new Promise((r) => setTimeout(r, 50));
    expect(mockAddCosts).toHaveBeenCalledWith(
      TEST_CHILD_RUN_ID,
      [{ costName: "serper-dev-query", quantity: 1, costSource: "platform" }],
      TEST_ORG_ID,
      TEST_USER_ID,
      undefined,
      undefined
    );
  });

  it("reports costs as org for BYOK", async () => {
    mockGetSerperApiKey.mockResolvedValueOnce({ key: "user-key", keySource: "byok" });
    mockSearchWeb.mockResolvedValueOnce([]);

    await request(app)
      .post("/search/web")
      .set(idHeaders)
      .send({ query: "test" });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockAddCosts).toHaveBeenCalledWith(
      TEST_CHILD_RUN_ID,
      [{ costName: "serper-dev-query", quantity: 1, costSource: "org" }],
      TEST_ORG_ID,
      TEST_USER_ID,
      undefined,
      undefined
    );
  });

  it("returns 402 when credits are insufficient", async () => {
    mockAuthorizeCredits.mockResolvedValueOnce({ sufficient: false, balance_cents: 5, required_cents: 100 });

    const res = await request(app)
      .post("/search/web")
      .set(idHeaders)
      .send({ query: "test" });
    expect(res.status).toBe(402);
    expect(res.body.error).toContain("Insufficient credits");
  });

  it("passes optional params to serper", async () => {
    mockSearchWeb.mockResolvedValueOnce([]);

    await request(app)
      .post("/search/web")
      .set(idHeaders)
      .send({ query: "startups", num: 5, gl: "us", hl: "en" });
    expect(mockSearchWeb).toHaveBeenCalledWith(
      { query: "startups", num: 5, gl: "us", hl: "en" },
      "test-serper-key"
    );
  });

  it("returns 502 when serper fails", async () => {
    mockSearchWeb.mockRejectedValueOnce(new Error("Serper web search failed: 500"));

    const res = await request(app)
      .post("/search/web")
      .set(idHeaders)
      .send({ query: "test" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Serper");
  });

  it("returns 502 when Serper API key is not found", async () => {
    mockGetSerperApiKey.mockRejectedValueOnce(new Error("Failed to get Serper API key: 404"));

    const res = await request(app)
      .post("/search/web")
      .set(idHeaders)
      .send({ query: "test" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Serper API key");
  });
});

// ─── Search News ───

describe("POST /search/news", () => {
  it("returns 400 with empty query", async () => {
    const res = await request(app)
      .post("/search/news")
      .set(idHeaders)
      .send({ query: "" });
    expect(res.status).toBe(400);
  });

  it("returns news search results", async () => {
    mockSearchNews.mockResolvedValueOnce([
      {
        title: "Startup raises $10M",
        link: "https://techcrunch.com/article",
        snippet: "A startup raised funding",
        source: "TechCrunch",
        date: "2 hours ago",
        domain: "techcrunch.com",
      },
    ]);

    const res = await request(app)
      .post("/search/news")
      .set(idHeaders)
      .send({ query: "startup funding", tbs: "qdr:w" });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].source).toBe("TechCrunch");
    expect(mockSearchNews).toHaveBeenCalledWith(
      { query: "startup funding", tbs: "qdr:w" },
      "test-serper-key"
    );
  });

  it("authorizes billing before platform-key search", async () => {
    mockSearchNews.mockResolvedValueOnce([]);

    await request(app)
      .post("/search/news")
      .set(idHeaders)
      .send({ query: "test" });

    expect(mockAuthorizeCredits).toHaveBeenCalledWith(
      [{ costName: "serper-dev-query", quantity: 1 }],
      "serper-dev-query",
      TEST_ORG_ID,
      TEST_USER_ID,
      TEST_CHILD_RUN_ID,
      undefined,
      undefined
    );
  });

  it("returns 502 when serper fails", async () => {
    mockSearchNews.mockRejectedValueOnce(new Error("Serper news search failed: 500"));

    const res = await request(app)
      .post("/search/news")
      .set(idHeaders)
      .send({ query: "test" });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Serper");
  });
});

// ─── Search Batch ───

describe("POST /search/batch", () => {
  it("returns 400 with empty queries array", async () => {
    const res = await request(app)
      .post("/search/batch")
      .set(idHeaders)
      .send({ queries: [] });
    expect(res.status).toBe(400);
  });

  it("authorizes billing for batch quantity", async () => {
    mockSearchWeb.mockResolvedValueOnce([]);
    mockSearchNews.mockResolvedValueOnce([]);

    await request(app)
      .post("/search/batch")
      .set(idHeaders)
      .send({
        queries: [
          { query: "web query", type: "web" },
          { query: "news query", type: "news" },
        ],
      });

    expect(mockAuthorizeCredits).toHaveBeenCalledWith(
      [{ costName: "serper-dev-query", quantity: 2 }],
      "serper-dev-query",
      TEST_ORG_ID,
      TEST_USER_ID,
      TEST_CHILD_RUN_ID,
      undefined,
      undefined
    );
  });

  it("returns batch results for mixed web and news queries", async () => {
    mockSearchWeb.mockResolvedValueOnce([
      {
        title: "Result 1",
        link: "https://example.com",
        snippet: "Snippet 1",
        domain: "example.com",
        position: 1,
      },
    ]);
    mockSearchNews.mockResolvedValueOnce([
      {
        title: "News 1",
        link: "https://news.example.com",
        snippet: "News snippet",
        source: "Example News",
        date: "1 day ago",
        domain: "news.example.com",
      },
    ]);

    const res = await request(app)
      .post("/search/batch")
      .set(idHeaders)
      .send({
        queries: [
          { query: "web query", type: "web" },
          { query: "news query", type: "news" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].type).toBe("web");
    expect(res.body.results[0].results).toHaveLength(1);
    expect(res.body.results[1].type).toBe("news");
    expect(res.body.results[1].results).toHaveLength(1);
  });

  it("reports batch costs with correct quantity", async () => {
    mockSearchWeb.mockResolvedValue([]);
    mockSearchNews.mockResolvedValue([]);

    await request(app)
      .post("/search/batch")
      .set(idHeaders)
      .send({
        queries: [
          { query: "q1", type: "web" },
          { query: "q2", type: "web" },
          { query: "q3", type: "news" },
        ],
      });

    await new Promise((r) => setTimeout(r, 50));
    expect(mockAddCosts).toHaveBeenCalledWith(
      TEST_CHILD_RUN_ID,
      [{ costName: "serper-dev-query", quantity: 3, costSource: "platform" }],
      TEST_ORG_ID,
      TEST_USER_ID,
      undefined,
      undefined
    );
  });

  it("returns 502 when any search fails", async () => {
    mockSearchWeb.mockRejectedValueOnce(new Error("Serper web search failed: 500"));

    const res = await request(app)
      .post("/search/batch")
      .set(idHeaders)
      .send({
        queries: [{ query: "failing query", type: "web" }],
      });
    expect(res.status).toBe(502);
  });
});

// ─── OpenAPI spec ───

describe("GET /openapi.json", () => {
  it("serves the OpenAPI spec or returns 404", async () => {
    const res = await request(app).get("/openapi.json");
    expect([200, 404]).toContain(res.status);
  });
});


// ─── Scanner/bot request logging suppression ───

describe("vulnerability scanner requests", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  const scannerPaths = [
    "/.env",
    "/.env.backup",
    "/.env.bak",
    "/.env.old",
    "/.env.example",
    "/.env.save",
    "/core/.env",
    "/api/.env",
    "/backend/.env",
    "/.git/config",
    "/actuator/env",
    "/debug/default/view",
    "/wp-admin",
    "/wp-login.php",
    "/wp-content/uploads",
    "/phpinfo.php",
    "/phpmyadmin",
    "/cgi-bin/test",
    "/config/.env",
    "/.vercel/.env.production.local",
  ];

  it.each(scannerPaths)("does NOT log scanner request to %s", async (path) => {
    consoleSpy.mockClear();
    await request(app).get(path);

    const logCalls = consoleSpy.mock.calls
      .map((args) => args.join(" "))
      .filter((msg) => msg.includes(`→ GET ${path}`));

    expect(logCalls).toHaveLength(0);
  });

  it("still logs legitimate API requests", async () => {
    consoleSpy.mockClear();
    await request(app).get("/health");

    const logCalls = consoleSpy.mock.calls
      .map((args) => args.join(" "))
      .filter((msg) => msg.includes("→ GET /health"));

    expect(logCalls).toHaveLength(1);
  });
});
