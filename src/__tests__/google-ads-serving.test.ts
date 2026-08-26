import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GoogleAdsCustomer } from "../services/google-ads";
import {
  createAdGroup,
  addKeywords,
  addAdGroupNegativeKeywords,
  addCampaignNegativeKeywords,
  createResponsiveSearchAd,
  listResponsiveSearchAds,
  listKeywords,
  removeKeyword,
  updateAdStatus,
  getCampaignServingState,
  getCampaignStructure,
  createManagedClientAccount,
} from "../services/google-ads-serving";

const CUSTOMER_ID = "1234567890";

const makeCustomer = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    credentials: { customer_id: CUSTOMER_ID },
    query: vi.fn().mockResolvedValue([]),
    adGroups: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    adGroupCriteria: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    adGroupAds: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    campaignCriteria: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
    customers: { createCustomerClient: vi.fn() },
    ...overrides,
  }) as unknown as GoogleAdsCustomer;

beforeEach(() => vi.clearAllMocks());

describe("ad groups", () => {
  it("creates a SEARCH_STANDARD ad group under the campaign", async () => {
    const customer = makeCustomer();
    (customer.adGroups.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ resource_name: `customers/${CUSTOMER_ID}/adGroups/777` }],
    });

    const adGroup = await createAdGroup(customer, "42", {
      name: "Brand terms",
      cpcBidMicros: "1500000",
    });

    expect(customer.adGroups.create).toHaveBeenCalledWith([
      {
        name: "Brand terms",
        campaign: `customers/${CUSTOMER_ID}/campaigns/42`,
        status: "ENABLED",
        type: "SEARCH_STANDARD",
        cpc_bid_micros: 1500000,
      },
    ]);
    expect(adGroup).toMatchObject({ id: "777", campaignId: "42" });
  });
});

describe("keywords", () => {
  it("creates keywords with their match behaviour and returns their criterion ids", async () => {
    const customer = makeCustomer();
    (customer.adGroupCriteria.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [
        { resource_name: `customers/${CUSTOMER_ID}/adGroupCriteria/777~11` },
        { resource_name: `customers/${CUSTOMER_ID}/adGroupCriteria/777~12` },
      ],
    });

    const created = await addKeywords(customer, "777", [
      { text: "crm for plumbers", matchType: "PHRASE", cpcBidMicros: "900000" },
      { text: "plumber crm", matchType: "EXACT" },
    ]);

    expect(customer.adGroupCriteria.create).toHaveBeenCalledWith([
      {
        ad_group: `customers/${CUSTOMER_ID}/adGroups/777`,
        status: "ENABLED",
        keyword: { text: "crm for plumbers", match_type: "PHRASE" },
        cpc_bid_micros: 900000,
      },
      {
        ad_group: `customers/${CUSTOMER_ID}/adGroups/777`,
        status: "ENABLED",
        keyword: { text: "plumber crm", match_type: "EXACT" },
      },
    ]);
    expect(created.map((k) => k.criterionId)).toEqual(["11", "12"]);
  });

  it("flags ad-group negatives as negative criteria, with no bid", async () => {
    const customer = makeCustomer();
    (customer.adGroupCriteria.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ resource_name: `customers/${CUSTOMER_ID}/adGroupCriteria/777~13` }],
    });

    await addAdGroupNegativeKeywords(customer, "777", [
      { text: "free", matchType: "BROAD" },
    ]);

    expect(customer.adGroupCriteria.create).toHaveBeenCalledWith([
      {
        ad_group: `customers/${CUSTOMER_ID}/adGroups/777`,
        negative: true,
        keyword: { text: "free", match_type: "BROAD" },
      },
    ]);
  });

  it("puts campaign-level negatives on the campaign criterion", async () => {
    const customer = makeCustomer();
    (customer.campaignCriteria.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ resource_name: `customers/${CUSTOMER_ID}/campaignCriteria/42~99` }],
    });

    const created = await addCampaignNegativeKeywords(customer, "42", [
      { text: "jobs", matchType: "PHRASE" },
    ]);

    expect(customer.campaignCriteria.create).toHaveBeenCalledWith([
      {
        campaign: `customers/${CUSTOMER_ID}/campaigns/42`,
        negative: true,
        keyword: { text: "jobs", match_type: "PHRASE" },
      },
    ]);
    expect(created[0].criterionId).toBe("99");
  });

  it("reads back keywords for an ad group, separating negatives", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        ad_group_criterion: {
          criterion_id: 11,
          keyword: { text: "plumber crm", match_type: "EXACT" },
          status: "ENABLED",
          negative: false,
          cpc_bid_micros: 900000,
          resource_name: `customers/${CUSTOMER_ID}/adGroupCriteria/777~11`,
        },
        ad_group: { id: 777 },
      },
    ]);
    const keywords = await listKeywords(makeCustomer({ query }), {
      adGroupId: "777",
      negative: false,
    });

    expect(query.mock.calls[0][0]).toContain("ad_group_criterion.negative = FALSE");
    expect(keywords[0]).toMatchObject({
      criterionId: "11",
      adGroupId: "777",
      text: "plumber crm",
      matchType: "EXACT",
      negative: false,
    });
  });

  it("removes a keyword by its composite resource name", async () => {
    const customer = makeCustomer();
    await removeKeyword(customer, "777", "11");
    expect(customer.adGroupCriteria.remove).toHaveBeenCalledWith([
      `customers/${CUSTOMER_ID}/adGroupCriteria/777~11`,
    ]);
  });
});

describe("responsive search ads", () => {
  it("carries many variants and pins the ones that must hold a position", async () => {
    const customer = makeCustomer();
    (customer.adGroupAds.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      results: [{ resource_name: `customers/${CUSTOMER_ID}/adGroupAds/777~555` }],
    });

    const ad = await createResponsiveSearchAd(customer, "777", {
      headlines: [
        { text: "Acme CRM", pinnedField: "HEADLINE_1" },
        { text: "Built for plumbers" },
        { text: "Try it free" },
      ],
      descriptions: [{ text: "Win more jobs." }, { text: "Set up in a day." }],
      finalUrls: ["https://acme.test/crm"],
      path1: "crm",
    });

    expect(customer.adGroupAds.create).toHaveBeenCalledWith([
      {
        ad_group: `customers/${CUSTOMER_ID}/adGroups/777`,
        status: "ENABLED",
        ad: {
          final_urls: ["https://acme.test/crm"],
          responsive_search_ad: {
            headlines: [
              { text: "Acme CRM", pinned_field: "HEADLINE_1" },
              { text: "Built for plumbers" },
              { text: "Try it free" },
            ],
            descriptions: [{ text: "Win more jobs." }, { text: "Set up in a day." }],
            path1: "crm",
          },
        },
      },
    ]);
    expect(ad).toEqual({
      adId: "555",
      resourceName: `customers/${CUSTOMER_ID}/adGroupAds/777~555`,
    });
  });

  it("reads variants back and reports UNSPECIFIED as unpinned", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        ad_group_ad: {
          ad: {
            id: 555,
            final_urls: ["https://acme.test/crm"],
            responsive_search_ad: {
              headlines: [
                { text: "Acme CRM", pinned_field: "HEADLINE_1" },
                { text: "Built for plumbers", pinned_field: "UNSPECIFIED" },
              ],
              descriptions: [{ text: "Win more jobs." }],
              path1: "crm",
            },
          },
          status: "ENABLED",
          resource_name: `customers/${CUSTOMER_ID}/adGroupAds/777~555`,
        },
        ad_group: { id: 777 },
      },
    ]);

    const ads = await listResponsiveSearchAds(makeCustomer({ query }), { adGroupId: "777" });

    expect(ads[0].headlines).toEqual([
      { text: "Acme CRM", pinnedField: "HEADLINE_1" },
      { text: "Built for plumbers" },
    ]);
    expect(ads[0]).toMatchObject({ adId: "555", adGroupId: "777", path2: null });
  });

  it("pauses an ad by its composite resource name", async () => {
    const customer = makeCustomer();
    await updateAdStatus(customer, "777", "555", "PAUSED");
    expect(customer.adGroupAds.update).toHaveBeenCalledWith([
      { resource_name: `customers/${CUSTOMER_ID}/adGroupAds/777~555`, status: "PAUSED" },
    ]);
  });
});

describe("serving state and readback", () => {
  it("reports GOOGLE's own verdict on whether the campaign can serve", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        campaign: {
          id: 42,
          status: "ENABLED",
          serving_status: "SERVING",
          primary_status: "ELIGIBLE",
          primary_status_reasons: [],
        },
      },
    ]);
    const state = await getCampaignServingState(makeCustomer({ query }), "42");
    expect(state).toEqual({
      campaignId: "42",
      status: "ENABLED",
      servingStatus: "SERVING",
      primaryStatus: "ELIGIBLE",
      primaryStatusReasons: [],
    });
  });

  it("returns null for a campaign that does not exist", async () => {
    expect(await getCampaignServingState(makeCustomer(), "42")).toBeNull();
  });

  it("nests keywords, negatives and ads under their own ad group", async () => {
    const query = vi.fn(async (gaql: string) => {
      if (gaql.includes("FROM campaign\n")) {
        return [
          {
            campaign: {
              id: 42,
              status: "ENABLED",
              serving_status: "SERVING",
              primary_status: "ELIGIBLE",
              primary_status_reasons: [],
            },
          },
        ];
      }
      if (gaql.includes("FROM ad_group\n")) {
        return [
          {
            ad_group: {
              id: 777,
              name: "Brand terms",
              status: "ENABLED",
              cpc_bid_micros: 900000,
              resource_name: `customers/${CUSTOMER_ID}/adGroups/777`,
            },
            campaign: { id: 42 },
          },
        ];
      }
      if (gaql.includes("FROM ad_group_criterion")) {
        const negative = gaql.includes("negative = TRUE");
        return [
          {
            ad_group_criterion: {
              criterion_id: negative ? 13 : 11,
              keyword: { text: negative ? "free" : "plumber crm", match_type: "EXACT" },
              status: "ENABLED",
              negative,
              resource_name: "x",
            },
            ad_group: { id: 777 },
          },
        ];
      }
      if (gaql.includes("FROM ad_group_ad")) {
        return [
          {
            ad_group_ad: {
              ad: { id: 555, final_urls: [], responsive_search_ad: {} },
              status: "ENABLED",
              resource_name: "y",
            },
            ad_group: { id: 777 },
          },
        ];
      }
      if (gaql.includes("FROM campaign_criterion")) {
        return [
          {
            campaign_criterion: {
              criterion_id: 99,
              keyword: { text: "jobs", match_type: "PHRASE" },
              resource_name: "z",
            },
          },
        ];
      }
      return [];
    });

    const structure = await getCampaignStructure(makeCustomer({ query }), "42");

    expect(structure.serving?.primaryStatus).toBe("ELIGIBLE");
    expect(structure.adGroups).toHaveLength(1);
    expect(structure.adGroups[0].keywords.map((k) => k.text)).toEqual(["plumber crm"]);
    expect(structure.adGroups[0].negativeKeywords.map((k) => k.text)).toEqual(["free"]);
    expect(structure.adGroups[0].ads.map((a) => a.adId)).toEqual(["555"]);
    expect(structure.campaignNegativeKeywords.map((k) => k.text)).toEqual(["jobs"]);
  });
});

describe("managed client account", () => {
  it("creates the advertiser under OUR manager account", async () => {
    const customer = makeCustomer();
    (customer.customers.createCustomerClient as ReturnType<typeof vi.fn>).mockResolvedValue({
      resource_name: "customers/9998887776",
    });

    const created = await createManagedClientAccount(customer, "1234567890", {
      descriptiveName: "Acme Plumbing",
      currencyCode: "USD",
      timeZone: "America/New_York",
    });

    expect(customer.customers.createCustomerClient).toHaveBeenCalledWith({
      customer_id: "1234567890",
      customer_client: {
        descriptive_name: "Acme Plumbing",
        currency_code: "USD",
        time_zone: "America/New_York",
      },
    });
    expect(created).toEqual({
      accountId: "9998887776",
      resourceName: "customers/9998887776",
    });
  });

  it("fails loud when Google returns no resource name", async () => {
    const customer = makeCustomer();
    (customer.customers.createCustomerClient as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await expect(
      createManagedClientAccount(customer, "1234567890", {
        descriptiveName: "Acme",
        currencyCode: "USD",
        timeZone: "UTC",
      })
    ).rejects.toThrow("no resource name");
  });
});
