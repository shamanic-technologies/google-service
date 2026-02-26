import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Hoist all mocks so they're available in vi.mock factories
const {
  mockQuery,
  mockStoreRefreshToken,
  mockGetRefreshToken,
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
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockStoreRefreshToken: vi.fn(),
  mockGetRefreshToken: vi.fn(),
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
}));

vi.mock("../env", () => ({
  env: {
    PORT: 8080,
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_DEVELOPER_TOKEN: "test-dev-token",
    GOOGLE_MCC_ACCOUNT_ID: "1234567890",
    KEY_SERVICE_URL: "http://localhost:3001",
    KEY_SERVICE_API_KEY: "test-key-service-key",
    API_REGISTRY_URL: "http://localhost:3000",
    API_REGISTRY_API_KEY: "test-registry-key",
  },
}));

vi.mock("../db/client", () => ({
  pool: { query: vi.fn() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock("../services/key-service", () => ({
  storeRefreshToken: (...args: unknown[]) => mockStoreRefreshToken(...args),
  getRefreshToken: (...args: unknown[]) => mockGetRefreshToken(...args),
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

const TEST_ORG_ID = "org-uuid-123";
const TEST_USER_ID = "user-uuid-456";

const idHeaders = { "x-org-id": TEST_ORG_ID, "x-user-id": TEST_USER_ID };

beforeEach(() => {
  vi.clearAllMocks();
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
      .get("/auth/url?appId=test-app")
      .set("x-user-id", TEST_USER_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-org-id");
  });

  it("returns 400 without x-user-id", async () => {
    const res = await request(app)
      .get("/auth/url?appId=test-app")
      .set("x-org-id", TEST_ORG_ID);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-user-id");
  });
});

// ─── Auth URL ───

describe("GET /auth/url", () => {
  it("returns 400 without appId", async () => {
    const res = await request(app).get("/auth/url").set(idHeaders);
    expect(res.status).toBe(400);
  });

  it("generates OAuth URL with valid appId", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/auth/url?appId=test-app").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("accounts.google.com");
    expect(res.body.url).toContain("test-client-id");
    expect(res.body.url).toContain("adwords");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO oauth_states"),
      expect.arrayContaining(["test-app", TEST_ORG_ID, TEST_USER_ID])
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
          app_id: "test-app",
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
    expect(mockStoreRefreshToken).toHaveBeenCalledWith("test-app", "111", "rt");
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO accounts"),
      expect.arrayContaining([TEST_ORG_ID, TEST_USER_ID])
    );
  });
});

// ─── Accounts ───

describe("GET /accounts", () => {
  it("returns 400 without appId", async () => {
    const res = await request(app).get("/accounts").set(idHeaders);
    expect(res.status).toBe(400);
  });

  it("returns accounts for valid appId", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "uuid-1",
          app_id: "test-app",
          org_id: TEST_ORG_ID,
          user_id: TEST_USER_ID,
          account_id: "111",
          mcc_id: "1234567890",
          created_at: new Date("2024-01-01"),
        },
      ],
    });

    const res = await request(app).get("/accounts?appId=test-app").set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].accountId).toBe("111");
    expect(res.body.accounts[0].orgId).toBe(TEST_ORG_ID);
    expect(res.body.accounts[0].userId).toBe(TEST_USER_ID);
  });
});

// ─── Campaigns List ───

describe("GET /accounts/:accountId/campaigns", () => {
  it("returns 400 without appId", async () => {
    const res = await request(app).get("/accounts/111/campaigns").set(idHeaders);
    expect(res.status).toBe(400);
  });

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
      .get("/accounts/111/campaigns?appId=test-app")
      .set(idHeaders);
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].name).toBe("Test Campaign");
    expect(mockGetRefreshToken).toHaveBeenCalledWith("test-app", "111", {
      method: "GET",
      path: "/accounts/:accountId/campaigns",
    });
  });

  it("filters by status", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ refresh_token_provider: "google-ads-refresh-111" }],
    });
    mockGetRefreshToken.mockResolvedValueOnce("fake-refresh-token");
    mockGetCustomer.mockReturnValueOnce({});
    mockListCampaigns.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/accounts/111/campaigns?appId=test-app&status=PAUSED")
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
      .get("/accounts/111/campaigns/123?appId=test-app")
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
      .get("/accounts/111/campaigns/999?appId=test-app")
      .set(idHeaders);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Campaign not found");
  });
});

// ─── Campaign Performance ───

describe("GET /accounts/:accountId/campaigns/:campaignId/performance", () => {
  it("returns 400 without date params", async () => {
    const res = await request(app)
      .get("/accounts/111/campaigns/123/performance?appId=test-app")
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
      .get("/accounts/111/campaigns/123/performance?appId=test-app&startDate=2024-01-01&endDate=2024-01-31")
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
      .get("/accounts/111/conversions?appId=test-app")
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
        appId: "test-app",
        name: "New Campaign",
        advertisingChannelType: "SEARCH",
        budgetAmountMicros: "5000000",
      });
    expect(mockGetRefreshToken).toHaveBeenCalledWith("test-app", "111", {
      method: "POST",
      path: "/accounts/:accountId/campaigns",
    });
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
        appId: "test-app",
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
  it("returns 400 without appId in body", async () => {
    const res = await request(app)
      .patch("/accounts/111/campaigns/123")
      .set(idHeaders)
      .send({ status: "PAUSED" });
    expect(res.status).toBe(400);
  });

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
      .send({ appId: "test-app", status: "PAUSED" });
    expect(res.status).toBe(200);
    expect(res.body.campaign.status).toBe("PAUSED");
    expect(res.body.message).toBe("Campaign updated successfully");
    expect(mockGetRefreshToken).toHaveBeenCalledWith("test-app", "111", {
      method: "PATCH",
      path: "/accounts/:accountId/campaigns/:campaignId",
    });
  });
});

// ─── Duplicate Campaign ───

describe("POST /accounts/:accountId/campaigns/:campaignId/duplicate", () => {
  it("returns 400 without appId", async () => {
    const res = await request(app)
      .post("/accounts/111/campaigns/123/duplicate")
      .set(idHeaders)
      .send({});
    expect(res.status).toBe(400);
  });

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
      .send({ appId: "test-app" });
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
      .send({ appId: "test-app", newName: "AB Test Variant B" });
    expect(res.status).toBe(201);
    expect(res.body.campaign.name).toBe("AB Test Variant B");
  });
});

// ─── Account not found ───

describe("Account not found error handling", () => {
  it("returns 404 when account is not in DB", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/accounts/999/campaigns?appId=test-app")
      .set(idHeaders);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Account not found");
  });
});

// ─── OpenAPI spec ───

describe("GET /openapi.json", () => {
  it("serves the OpenAPI spec or returns 404", async () => {
    const res = await request(app).get("/openapi.json");
    expect([200, 404]).toContain(res.status);
  });
});
