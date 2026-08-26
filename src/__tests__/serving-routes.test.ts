import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const {
  mockQuery,
  mockGetRefreshToken,
  mockGetManagerRefreshToken,
  mockGetGoogleCredentials,
  mockCreateRun,
  mockUpdateRun,
  mockGetCustomer,
  mockUpdateCampaign,
  mockCreateAdGroup,
  mockListAdGroups,
  mockUpdateAdGroup,
  mockAddKeywords,
  mockListKeywords,
  mockAddAdGroupNegativeKeywords,
  mockAddCampaignNegativeKeywords,
  mockListCampaignNegativeKeywords,
  mockRemoveCampaignNegativeKeyword,
  mockUpdateKeywordStatus,
  mockRemoveKeyword,
  mockCreateResponsiveSearchAd,
  mockListResponsiveSearchAds,
  mockUpdateAdStatus,
  mockRemoveAd,
  mockGetCampaignServingState,
  mockGetCampaignStructure,
  mockCreateManagedClientAccount,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetRefreshToken: vi.fn(),
  mockGetManagerRefreshToken: vi.fn(),
  mockGetGoogleCredentials: vi.fn(),
  mockCreateRun: vi.fn(),
  mockUpdateRun: vi.fn(),
  mockGetCustomer: vi.fn(),
  mockUpdateCampaign: vi.fn(),
  mockCreateAdGroup: vi.fn(),
  mockListAdGroups: vi.fn(),
  mockUpdateAdGroup: vi.fn(),
  mockAddKeywords: vi.fn(),
  mockListKeywords: vi.fn(),
  mockAddAdGroupNegativeKeywords: vi.fn(),
  mockAddCampaignNegativeKeywords: vi.fn(),
  mockListCampaignNegativeKeywords: vi.fn(),
  mockRemoveCampaignNegativeKeyword: vi.fn(),
  mockUpdateKeywordStatus: vi.fn(),
  mockRemoveKeyword: vi.fn(),
  mockCreateResponsiveSearchAd: vi.fn(),
  mockListResponsiveSearchAds: vi.fn(),
  mockUpdateAdStatus: vi.fn(),
  mockRemoveAd: vi.fn(),
  mockGetCampaignServingState: vi.fn(),
  mockGetCampaignStructure: vi.fn(),
  mockCreateManagedClientAccount: vi.fn(),
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
  getRefreshToken: (...args: unknown[]) => mockGetRefreshToken(...args),
  getManagerRefreshToken: (...args: unknown[]) => mockGetManagerRefreshToken(...args),
  getGoogleCredentials: (...args: unknown[]) => mockGetGoogleCredentials(...args),
  storeRefreshToken: vi.fn(),
  getSerperApiKey: vi.fn(),
}));

vi.mock("../services/runs-service", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: vi.fn(),
}));

vi.mock("../services/billing-client", () => ({ authorizeCredits: vi.fn() }));
vi.mock("../services/serper", () => ({ searchWeb: vi.fn(), searchNews: vi.fn() }));

vi.mock("../services/google-ads", () => ({
  createGoogleAdsClient: () => ({}),
  getCustomer: (...args: unknown[]) => mockGetCustomer(...args),
  updateCampaign: (...args: unknown[]) => mockUpdateCampaign(...args),
  listAccessibleAccounts: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  listCampaigns: vi.fn(),
  getCampaignDetail: vi.fn(),
  getCampaignPerformance: vi.fn(),
  listConversionActions: vi.fn(),
  createCampaign: vi.fn(),
  duplicateCampaign: vi.fn(),
  uploadClickConversions: vi.fn(),
  getCampaignSpendByDay: vi.fn(),
}));

vi.mock("../services/google-ads-serving", () => ({
  createAdGroup: (...a: unknown[]) => mockCreateAdGroup(...a),
  listAdGroups: (...a: unknown[]) => mockListAdGroups(...a),
  updateAdGroup: (...a: unknown[]) => mockUpdateAdGroup(...a),
  addKeywords: (...a: unknown[]) => mockAddKeywords(...a),
  listKeywords: (...a: unknown[]) => mockListKeywords(...a),
  addAdGroupNegativeKeywords: (...a: unknown[]) => mockAddAdGroupNegativeKeywords(...a),
  addCampaignNegativeKeywords: (...a: unknown[]) => mockAddCampaignNegativeKeywords(...a),
  listCampaignNegativeKeywords: (...a: unknown[]) => mockListCampaignNegativeKeywords(...a),
  removeCampaignNegativeKeyword: (...a: unknown[]) => mockRemoveCampaignNegativeKeyword(...a),
  updateKeywordStatus: (...a: unknown[]) => mockUpdateKeywordStatus(...a),
  removeKeyword: (...a: unknown[]) => mockRemoveKeyword(...a),
  createResponsiveSearchAd: (...a: unknown[]) => mockCreateResponsiveSearchAd(...a),
  listResponsiveSearchAds: (...a: unknown[]) => mockListResponsiveSearchAds(...a),
  updateAdStatus: (...a: unknown[]) => mockUpdateAdStatus(...a),
  removeAd: (...a: unknown[]) => mockRemoveAd(...a),
  getCampaignServingState: (...a: unknown[]) => mockGetCampaignServingState(...a),
  getCampaignStructure: (...a: unknown[]) => mockGetCampaignStructure(...a),
  createManagedClientAccount: (...a: unknown[]) => mockCreateManagedClientAccount(...a),
}));

import { createApp } from "../app";

const app = createApp();

const ORG = "00000000-0000-4000-a000-000000000001";
const USER = "00000000-0000-4000-a000-000000000002";
const RUN = "00000000-0000-4000-a000-000000000003";
const CHILD_RUN = "00000000-0000-4000-a000-000000000004";
const idHeaders = { "x-org-id": ORG, "x-user-id": USER, "x-run-id": RUN };

/** No row in `accounts`, one row in `google_ads_managed_accounts`. */
const managedAccount = () => {
  mockQuery.mockResolvedValueOnce({ rows: [] });
  mockQuery.mockResolvedValueOnce({ rows: [{ account_id: "9998887776" }] });
};

/** Legacy path: the org connected its own Google account. */
const connectedAccount = () => {
  mockQuery.mockResolvedValueOnce({ rows: [{ refresh_token_provider: "google-ads-refresh-111" }] });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateRun.mockResolvedValue(CHILD_RUN);
  mockUpdateRun.mockResolvedValue(undefined);
  mockGetGoogleCredentials.mockResolvedValue({
    clientId: "id",
    clientSecret: "secret",
    developerToken: "dev",
    mccAccountId: "1234567890",
  });
  mockGetManagerRefreshToken.mockResolvedValue("manager-refresh-token");
  mockGetRefreshToken.mockResolvedValue("per-org-refresh-token");
  mockGetCustomer.mockReturnValue({ credentials: { customer_id: "9998887776" } });
});

describe("managed advertiser path (no customer-supplied Google credential)", () => {
  it("drives a managed account with OUR manager credential and never asks for the org's", async () => {
    managedAccount();
    mockListAdGroups.mockResolvedValueOnce([]);

    const res = await request(app)
      .get("/accounts/9998887776/campaigns/42/ad-groups")
      .set(idHeaders);

    expect(res.status).toBe(200);
    expect(mockGetManagerRefreshToken).toHaveBeenCalled();
    expect(mockGetRefreshToken).not.toHaveBeenCalled();
    // login_customer_id is always our manager account.
    expect(mockGetCustomer).toHaveBeenCalledWith({}, "manager-refresh-token", "9998887776", "1234567890");
  });

  it("still uses the org's own credential when it connected a Google account", async () => {
    connectedAccount();
    mockListAdGroups.mockResolvedValueOnce([]);

    const res = await request(app).get("/accounts/111/campaigns/42/ad-groups").set(idHeaders);

    expect(res.status).toBe(200);
    expect(mockGetRefreshToken).toHaveBeenCalled();
    expect(mockGetManagerRefreshToken).not.toHaveBeenCalled();
  });

  it("404s when the org owns neither a connected nor a managed account", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/accounts/555/campaigns/42/ad-groups").set(idHeaders);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Account not found");
  });
});

describe("ad groups", () => {
  it("creates an ad group under a campaign", async () => {
    managedAccount();
    mockCreateAdGroup.mockResolvedValueOnce({
      id: "777",
      name: "Brand terms",
      status: "ENABLED",
      campaignId: "42",
      cpcBidMicros: null,
      resourceName: "customers/9998887776/adGroups/777",
    });

    const res = await request(app)
      .post("/accounts/9998887776/campaigns/42/ad-groups")
      .set(idHeaders)
      .send({ name: "Brand terms" });

    expect(res.status).toBe(201);
    expect(res.body.adGroup.id).toBe("777");
    expect(mockCreateAdGroup).toHaveBeenCalledWith(expect.anything(), "42", {
      name: "Brand terms",
    });
  });

  it("rejects an update with no fields", async () => {
    const res = await request(app)
      .patch("/accounts/9998887776/ad-groups/777")
      .set(idHeaders)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("keywords and negatives", () => {
  it("adds keywords with their match behaviour", async () => {
    managedAccount();
    mockAddKeywords.mockResolvedValueOnce([
      { criterionId: "11", text: "plumber crm", matchType: "EXACT", resourceName: "x" },
    ]);

    const res = await request(app)
      .post("/accounts/9998887776/ad-groups/777/keywords")
      .set(idHeaders)
      .send({ keywords: [{ text: "plumber crm", matchType: "EXACT" }] });

    expect(res.status).toBe(201);
    expect(res.body.keywords[0].criterionId).toBe("11");
  });

  it("rejects an unknown match type", async () => {
    const res = await request(app)
      .post("/accounts/9998887776/ad-groups/777/keywords")
      .set(idHeaders)
      .send({ keywords: [{ text: "plumber crm", matchType: "SEMI_BROAD" }] });
    expect(res.status).toBe(400);
  });

  it("adds campaign-level negatives", async () => {
    managedAccount();
    mockAddCampaignNegativeKeywords.mockResolvedValueOnce([
      { criterionId: "99", text: "jobs", matchType: "PHRASE", resourceName: "z" },
    ]);

    const res = await request(app)
      .post("/accounts/9998887776/campaigns/42/negative-keywords")
      .set(idHeaders)
      .send({ keywords: [{ text: "jobs", matchType: "PHRASE" }] });

    expect(res.status).toBe(201);
    expect(res.body.keywords[0].criterionId).toBe("99");
  });

  it("removes a campaign-level negative", async () => {
    managedAccount();
    mockRemoveCampaignNegativeKeyword.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .delete("/accounts/9998887776/campaigns/42/negative-keywords/99")
      .set(idHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ criterionId: "99", removed: true });
  });
});

describe("responsive search ads", () => {
  it("creates a many-variant ad, pins included", async () => {
    managedAccount();
    mockCreateResponsiveSearchAd.mockResolvedValueOnce({
      adId: "555",
      resourceName: "customers/9998887776/adGroupAds/777~555",
    });

    const res = await request(app)
      .post("/accounts/9998887776/ad-groups/777/ads")
      .set(idHeaders)
      .send({
        headlines: [
          { text: "Acme CRM", pinnedField: "HEADLINE_1" },
          { text: "Built for plumbers" },
          { text: "Try it free" },
        ],
        descriptions: [{ text: "Win more jobs." }, { text: "Set up in a day." }],
        finalUrls: ["https://acme.test/crm"],
      });

    expect(res.status).toBe(201);
    expect(res.body.ad).toMatchObject({ adId: "555", adGroupId: "777" });
  });

  it("rejects an ad below Google's variant minimums", async () => {
    const res = await request(app)
      .post("/accounts/9998887776/ad-groups/777/ads")
      .set(idHeaders)
      .send({
        headlines: [{ text: "Only one" }],
        descriptions: [{ text: "One" }, { text: "Two" }],
        finalUrls: ["https://acme.test/crm"],
      });
    expect(res.status).toBe(400);
  });

  it("rejects a pin onto a position that does not exist", async () => {
    const res = await request(app)
      .post("/accounts/9998887776/ad-groups/777/ads")
      .set(idHeaders)
      .send({
        headlines: [
          { text: "One", pinnedField: "HEADLINE_9" },
          { text: "Two" },
          { text: "Three" },
        ],
        descriptions: [{ text: "One" }, { text: "Two" }],
        finalUrls: ["https://acme.test/crm"],
      });
    expect(res.status).toBe(400);
  });
});

describe("bidding on a live campaign", () => {
  it("switches the strategy without recreating the campaign", async () => {
    managedAccount();
    mockUpdateCampaign.mockResolvedValueOnce({ id: "42", biddingStrategy: "TARGET_CPA" });

    const res = await request(app)
      .put("/accounts/9998887776/campaigns/42/bidding")
      .set(idHeaders)
      .send({ bidding: { type: "TARGET_CPA", targetCpaMicros: "40000000" } });

    expect(res.status).toBe(200);
    expect(res.body.biddingStrategy).toBe("TARGET_CPA");
    expect(mockUpdateCampaign).toHaveBeenCalledWith(expect.anything(), "42", {
      bidding: { type: "TARGET_CPA", targetCpaMicros: "40000000" },
    });
  });

  it("rejects TARGET_CPA with no target", async () => {
    const res = await request(app)
      .put("/accounts/9998887776/campaigns/42/bidding")
      .set(idHeaders)
      .send({ bidding: { type: "TARGET_CPA" } });
    expect(res.status).toBe(400);
  });
});

describe("readback", () => {
  it("returns everything created for the campaign", async () => {
    managedAccount();
    mockGetCampaignStructure.mockResolvedValueOnce({
      campaignId: "42",
      serving: {
        campaignId: "42",
        status: "ENABLED",
        servingStatus: "SERVING",
        primaryStatus: "ELIGIBLE",
        primaryStatusReasons: [],
      },
      adGroups: [],
      campaignNegativeKeywords: [],
    });

    const res = await request(app)
      .get("/accounts/9998887776/campaigns/42/structure")
      .set(idHeaders);

    expect(res.status).toBe(200);
    expect(res.body.serving.primaryStatus).toBe("ELIGIBLE");
  });

  it("404s a serving-state read for a campaign Google does not have", async () => {
    managedAccount();
    mockGetCampaignServingState.mockResolvedValueOnce(null);

    const res = await request(app)
      .get("/accounts/9998887776/campaigns/42/serving-state")
      .set(idHeaders);

    expect(res.status).toBe(404);
  });
});

describe("Google rejections surface loudly", () => {
  it("returns 502 carrying Google's own message on a policy refusal", async () => {
    managedAccount();
    mockCreateResponsiveSearchAd.mockRejectedValueOnce(
      new Error("POLICY_FINDING: ad text is not allowed")
    );

    const res = await request(app)
      .post("/accounts/9998887776/ad-groups/777/ads")
      .set(idHeaders)
      .send({
        headlines: [{ text: "One" }, { text: "Two" }, { text: "Three" }],
        descriptions: [{ text: "One" }, { text: "Two" }],
        finalUrls: ["https://acme.test/crm"],
      });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("POLICY_FINDING: ad text is not allowed");
  });
});

describe("managed accounts", () => {
  it("provisions a client account under our manager account", async () => {
    mockCreateManagedClientAccount.mockResolvedValueOnce({
      accountId: "9998887776",
      resourceName: "customers/9998887776",
    });
    // no existing brand row, then the INSERT
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          account_id: "9998887776",
          org_id: ORG,
          brand_id: "brand-1",
          manager_account_id: "1234567890",
          descriptive_name: "Acme Plumbing",
          currency_code: "USD",
          time_zone: "America/New_York",
          created_at: new Date("2026-08-26T00:00:00Z"),
        },
      ],
    });

    const res = await request(app)
      .post("/orgs/google-ads/managed-accounts")
      .set(idHeaders)
      .send({
        descriptiveName: "Acme Plumbing",
        currencyCode: "USD",
        timeZone: "America/New_York",
        brandId: "brand-1",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true });
    expect(res.body.account.accountId).toBe("9998887776");
    expect(mockGetManagerRefreshToken).toHaveBeenCalled();
    expect(mockGetRefreshToken).not.toHaveBeenCalled();
  });

  it("returns the brand's existing account instead of creating a second one", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          account_id: "9998887776",
          org_id: ORG,
          brand_id: "brand-1",
          manager_account_id: "1234567890",
          descriptive_name: "Acme Plumbing",
          currency_code: "USD",
          time_zone: "America/New_York",
          created_at: new Date("2026-08-26T00:00:00Z"),
        },
      ],
    });

    const res = await request(app)
      .post("/orgs/google-ads/managed-accounts")
      .set(idHeaders)
      .send({
        descriptiveName: "Acme Plumbing",
        currencyCode: "USD",
        timeZone: "America/New_York",
        brandId: "brand-1",
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(mockCreateManagedClientAccount).not.toHaveBeenCalled();
  });

  it("lists the org's managed accounts", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          account_id: "9998887776",
          org_id: ORG,
          brand_id: null,
          manager_account_id: "1234567890",
          descriptive_name: "Acme Plumbing",
          currency_code: "USD",
          time_zone: "UTC",
          created_at: new Date("2026-08-26T00:00:00Z"),
        },
      ],
    });

    const res = await request(app).get("/orgs/google-ads/managed-accounts").set(idHeaders);

    expect(res.status).toBe(200);
    expect(res.body.accounts[0]).toMatchObject({ accountId: "9998887776", brandId: null });
  });
});
