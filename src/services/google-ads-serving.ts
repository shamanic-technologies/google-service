/**
 * Everything BELOW the campaign.
 *
 * A Google Search campaign with nothing under it serves zero impressions: it
 * needs at least one ad group, keywords to bid on, and an ad to show. This
 * module owns that layer — the grouping level, the search terms and their
 * match behaviour, the terms the campaign must never bid on, and the
 * many-variant responsive search ad.
 *
 * Every call goes straight to Google and every Google rejection (including a
 * policy refusal) propagates to the caller. Nothing here is swallowed.
 */
import type { GoogleAdsCustomer } from "./google-ads";

/**
 * Last segment of a Google resource name. Criterion and ad resource names are
 * composite ("<parentId>~<id>"), so the id is what follows the tilde.
 */
const idFromResourceName = (resourceName: string): string => {
  const segment = resourceName.split("/").pop() ?? resourceName;
  return segment.includes("~") ? segment.slice(segment.lastIndexOf("~") + 1) : segment;
};

const campaignResource = (customer: GoogleAdsCustomer, campaignId: string) =>
  `customers/${customer.credentials.customer_id}/campaigns/${campaignId}`;

const adGroupResource = (customer: GoogleAdsCustomer, adGroupId: string) =>
  `customers/${customer.credentials.customer_id}/adGroups/${adGroupId}`;

// ─── Ad groups (the grouping level beneath a campaign) ───

export const AD_GROUP_STATUSES = ["ENABLED", "PAUSED", "REMOVED"] as const;
export type AdGroupStatus = (typeof AD_GROUP_STATUSES)[number];

export interface CreateAdGroupInput {
  name: string;
  status?: AdGroupStatus;
  /** Manual/ECPC default bid. Ignored by Google under automated bidding. */
  cpcBidMicros?: string;
}

export interface AdGroup {
  id: string;
  name: string;
  status: string;
  campaignId: string;
  cpcBidMicros: string | null;
  resourceName: string;
}

export const createAdGroup = async (
  customer: GoogleAdsCustomer,
  campaignId: string,
  input: CreateAdGroupInput
): Promise<AdGroup> => {
  const data: Record<string, unknown> = {
    name: input.name,
    campaign: campaignResource(customer, campaignId),
    status: input.status ?? "ENABLED",
    // The only ad group type a Search campaign can serve text ads from.
    type: "SEARCH_STANDARD",
  };
  if (input.cpcBidMicros) data.cpc_bid_micros = Number(input.cpcBidMicros);

  const result = await customer.adGroups.create([data]);
  const resourceName = result.results[0].resource_name;

  return {
    id: idFromResourceName(resourceName),
    name: input.name,
    status: input.status ?? "ENABLED",
    campaignId,
    cpcBidMicros: input.cpcBidMicros ?? null,
    resourceName,
  };
};

export const listAdGroups = async (
  customer: GoogleAdsCustomer,
  campaignId?: string
): Promise<AdGroup[]> => {
  const where = campaignId ? `WHERE campaign.id = ${Number(campaignId)}` : "";
  const rows = await customer.query(`
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.cpc_bid_micros,
      ad_group.resource_name,
      campaign.id
    FROM ad_group
    ${where}
    ORDER BY ad_group.name
  `);

  return rows.map((row) => {
    const g = row.ad_group as Record<string, unknown>;
    const c = row.campaign as Record<string, unknown> | undefined;
    return {
      id: String(g.id),
      name: String(g.name),
      status: String(g.status),
      campaignId: c?.id ? String(c.id) : (campaignId ?? ""),
      cpcBidMicros: g.cpc_bid_micros != null ? String(g.cpc_bid_micros) : null,
      resourceName: String(g.resource_name),
    };
  });
};

export const updateAdGroup = async (
  customer: GoogleAdsCustomer,
  adGroupId: string,
  updates: { name?: string; status?: AdGroupStatus; cpcBidMicros?: string }
): Promise<void> => {
  const data: Record<string, unknown> = {
    resource_name: adGroupResource(customer, adGroupId),
  };
  if (updates.name) data.name = updates.name;
  if (updates.status) data.status = updates.status;
  if (updates.cpcBidMicros) data.cpc_bid_micros = Number(updates.cpcBidMicros);

  if (Object.keys(data).length === 1) {
    throw new Error("No ad group fields to update");
  }
  await customer.adGroups.update([data]);
};

// ─── Keywords (what the campaign bids on, and how) ───

export const KEYWORD_MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"] as const;
export type KeywordMatchType = (typeof KEYWORD_MATCH_TYPES)[number];

export interface KeywordInput {
  text: string;
  matchType: KeywordMatchType;
  cpcBidMicros?: string;
  status?: AdGroupStatus;
}

export interface Keyword {
  criterionId: string;
  adGroupId: string;
  text: string;
  matchType: string;
  status: string;
  negative: boolean;
  cpcBidMicros: string | null;
  resourceName: string;
}

export const addKeywords = async (
  customer: GoogleAdsCustomer,
  adGroupId: string,
  keywords: KeywordInput[]
): Promise<Array<{ criterionId: string; text: string; matchType: string; resourceName: string }>> => {
  const adGroup = adGroupResource(customer, adGroupId);
  const operations = keywords.map((k) => {
    const data: Record<string, unknown> = {
      ad_group: adGroup,
      status: k.status ?? "ENABLED",
      keyword: { text: k.text, match_type: k.matchType },
    };
    if (k.cpcBidMicros) data.cpc_bid_micros = Number(k.cpcBidMicros);
    return data;
  });

  const result = await customer.adGroupCriteria.create(operations);
  return result.results.map((r, i) => ({
    criterionId: idFromResourceName(r.resource_name),
    text: keywords[i].text,
    matchType: keywords[i].matchType,
    resourceName: r.resource_name,
  }));
};

/**
 * Terms the ad group must never bid on. Same criterion resource as a positive
 * keyword, flagged negative — a negative criterion carries no bid and no status
 * of its own.
 */
export const addAdGroupNegativeKeywords = async (
  customer: GoogleAdsCustomer,
  adGroupId: string,
  keywords: Array<{ text: string; matchType: KeywordMatchType }>
): Promise<Array<{ criterionId: string; text: string; matchType: string; resourceName: string }>> => {
  const adGroup = adGroupResource(customer, adGroupId);
  const result = await customer.adGroupCriteria.create(
    keywords.map((k) => ({
      ad_group: adGroup,
      negative: true,
      keyword: { text: k.text, match_type: k.matchType },
    }))
  );
  return result.results.map((r, i) => ({
    criterionId: idFromResourceName(r.resource_name),
    text: keywords[i].text,
    matchType: keywords[i].matchType,
    resourceName: r.resource_name,
  }));
};

export const listKeywords = async (
  customer: GoogleAdsCustomer,
  opts: { adGroupId?: string; campaignId?: string; negative?: boolean } = {}
): Promise<Keyword[]> => {
  const conditions = ["ad_group_criterion.type = 'KEYWORD'"];
  if (opts.adGroupId) conditions.push(`ad_group.id = ${Number(opts.adGroupId)}`);
  if (opts.campaignId) conditions.push(`campaign.id = ${Number(opts.campaignId)}`);
  if (opts.negative !== undefined) {
    conditions.push(`ad_group_criterion.negative = ${opts.negative ? "TRUE" : "FALSE"}`);
  }

  const rows = await customer.query(`
    SELECT
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.negative,
      ad_group_criterion.cpc_bid_micros,
      ad_group_criterion.resource_name,
      ad_group.id
    FROM ad_group_criterion
    WHERE ${conditions.join(" AND ")}
  `);

  return rows.map((row) => {
    const c = row.ad_group_criterion as Record<string, unknown>;
    const g = row.ad_group as Record<string, unknown> | undefined;
    const keyword = (c.keyword ?? {}) as Record<string, unknown>;
    return {
      criterionId: String(c.criterion_id),
      adGroupId: g?.id ? String(g.id) : (opts.adGroupId ?? ""),
      text: String(keyword.text ?? ""),
      matchType: String(keyword.match_type ?? ""),
      status: String(c.status ?? ""),
      negative: Boolean(c.negative),
      cpcBidMicros: c.cpc_bid_micros != null ? String(c.cpc_bid_micros) : null,
      resourceName: String(c.resource_name),
    };
  });
};

export const updateKeywordStatus = async (
  customer: GoogleAdsCustomer,
  adGroupId: string,
  criterionId: string,
  status: AdGroupStatus
): Promise<void> => {
  await customer.adGroupCriteria.update([
    {
      resource_name: `customers/${customer.credentials.customer_id}/adGroupCriteria/${adGroupId}~${criterionId}`,
      status,
    },
  ]);
};

export const removeKeyword = async (
  customer: GoogleAdsCustomer,
  adGroupId: string,
  criterionId: string
): Promise<void> => {
  await customer.adGroupCriteria.remove([
    `customers/${customer.credentials.customer_id}/adGroupCriteria/${adGroupId}~${criterionId}`,
  ]);
};

// ─── Campaign-level negative keywords ───

export const addCampaignNegativeKeywords = async (
  customer: GoogleAdsCustomer,
  campaignId: string,
  keywords: Array<{ text: string; matchType: KeywordMatchType }>
): Promise<Array<{ criterionId: string; text: string; matchType: string; resourceName: string }>> => {
  const campaign = campaignResource(customer, campaignId);
  const result = await customer.campaignCriteria.create(
    keywords.map((k) => ({
      campaign,
      negative: true,
      keyword: { text: k.text, match_type: k.matchType },
    }))
  );
  return result.results.map((r, i) => ({
    criterionId: idFromResourceName(r.resource_name),
    text: keywords[i].text,
    matchType: keywords[i].matchType,
    resourceName: r.resource_name,
  }));
};

export interface CampaignNegativeKeyword {
  criterionId: string;
  campaignId: string;
  text: string;
  matchType: string;
  resourceName: string;
}

export const listCampaignNegativeKeywords = async (
  customer: GoogleAdsCustomer,
  campaignId: string
): Promise<CampaignNegativeKeyword[]> => {
  const rows = await customer.query(`
    SELECT
      campaign_criterion.criterion_id,
      campaign_criterion.keyword.text,
      campaign_criterion.keyword.match_type,
      campaign_criterion.resource_name,
      campaign.id
    FROM campaign_criterion
    WHERE campaign.id = ${Number(campaignId)}
      AND campaign_criterion.type = 'KEYWORD'
      AND campaign_criterion.negative = TRUE
  `);

  return rows.map((row) => {
    const c = row.campaign_criterion as Record<string, unknown>;
    const keyword = (c.keyword ?? {}) as Record<string, unknown>;
    return {
      criterionId: String(c.criterion_id),
      campaignId,
      text: String(keyword.text ?? ""),
      matchType: String(keyword.match_type ?? ""),
      resourceName: String(c.resource_name),
    };
  });
};

export const removeCampaignNegativeKeyword = async (
  customer: GoogleAdsCustomer,
  campaignId: string,
  criterionId: string
): Promise<void> => {
  await customer.campaignCriteria.remove([
    `customers/${customer.credentials.customer_id}/campaignCriteria/${campaignId}~${criterionId}`,
  ]);
};

// ─── Responsive search ad (the ad itself, many variants) ───

/**
 * Google composes the ad at serve time from the variants that exist, so
 * choosing which variants exist IS writing the ad. A variant can be PINNED to
 * a fixed position — needed for a compliance or brand line that must always
 * show — while every unpinned variant stays free for Google to test.
 */
export const HEADLINE_PIN_POSITIONS = ["HEADLINE_1", "HEADLINE_2", "HEADLINE_3"] as const;
export const DESCRIPTION_PIN_POSITIONS = ["DESCRIPTION_1", "DESCRIPTION_2"] as const;

export interface AdTextAsset {
  text: string;
  /** Fixed serving position. Omit to leave the variant free for Google. */
  pinnedField?: string;
}

export interface CreateResponsiveSearchAdInput {
  headlines: AdTextAsset[];
  descriptions: AdTextAsset[];
  finalUrls: string[];
  path1?: string;
  path2?: string;
  status?: AdGroupStatus;
}

export interface ResponsiveSearchAd {
  adId: string;
  adGroupId: string;
  status: string;
  headlines: AdTextAsset[];
  descriptions: AdTextAsset[];
  finalUrls: string[];
  path1: string | null;
  path2: string | null;
  resourceName: string;
}

const toTextAsset = (asset: AdTextAsset): Record<string, unknown> => {
  const out: Record<string, unknown> = { text: asset.text };
  if (asset.pinnedField) out.pinned_field = asset.pinnedField;
  return out;
};

export const createResponsiveSearchAd = async (
  customer: GoogleAdsCustomer,
  adGroupId: string,
  input: CreateResponsiveSearchAdInput
): Promise<{ adId: string; resourceName: string }> => {
  const responsiveSearchAd: Record<string, unknown> = {
    headlines: input.headlines.map(toTextAsset),
    descriptions: input.descriptions.map(toTextAsset),
  };
  if (input.path1) responsiveSearchAd.path1 = input.path1;
  if (input.path2) responsiveSearchAd.path2 = input.path2;

  const result = await customer.adGroupAds.create([
    {
      ad_group: adGroupResource(customer, adGroupId),
      status: input.status ?? "ENABLED",
      ad: {
        final_urls: input.finalUrls,
        responsive_search_ad: responsiveSearchAd,
      },
    },
  ]);

  const resourceName = result.results[0].resource_name;
  // "customers/X/adGroupAds/<adGroupId>~<adId>" — the ad id is after the tilde.
  return { adId: idFromResourceName(resourceName), resourceName };
};

const readTextAssets = (raw: unknown): AdTextAsset[] => {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const asset = entry as Record<string, unknown>;
    const out: AdTextAsset = { text: String(asset.text ?? "") };
    const pinned = asset.pinned_field;
    // Google returns UNSPECIFIED for an unpinned asset; that is not a position.
    if (pinned && String(pinned) !== "UNSPECIFIED" && String(pinned) !== "0") {
      out.pinnedField = String(pinned);
    }
    return out;
  });
};

export const listResponsiveSearchAds = async (
  customer: GoogleAdsCustomer,
  opts: { adGroupId?: string; campaignId?: string } = {}
): Promise<ResponsiveSearchAd[]> => {
  const conditions = ["ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'"];
  if (opts.adGroupId) conditions.push(`ad_group.id = ${Number(opts.adGroupId)}`);
  if (opts.campaignId) conditions.push(`campaign.id = ${Number(opts.campaignId)}`);

  const rows = await customer.query(`
    SELECT
      ad_group_ad.ad.id,
      ad_group_ad.ad.final_urls,
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions,
      ad_group_ad.ad.responsive_search_ad.path1,
      ad_group_ad.ad.responsive_search_ad.path2,
      ad_group_ad.status,
      ad_group_ad.resource_name,
      ad_group.id
    FROM ad_group_ad
    WHERE ${conditions.join(" AND ")}
  `);

  return rows.map((row) => {
    const adGroupAd = row.ad_group_ad as Record<string, unknown>;
    const ad = (adGroupAd.ad ?? {}) as Record<string, unknown>;
    const rsa = (ad.responsive_search_ad ?? {}) as Record<string, unknown>;
    const g = row.ad_group as Record<string, unknown> | undefined;
    return {
      adId: String(ad.id ?? ""),
      adGroupId: g?.id ? String(g.id) : (opts.adGroupId ?? ""),
      status: String(adGroupAd.status ?? ""),
      headlines: readTextAssets(rsa.headlines),
      descriptions: readTextAssets(rsa.descriptions),
      finalUrls: Array.isArray(ad.final_urls) ? ad.final_urls.map(String) : [],
      path1: rsa.path1 ? String(rsa.path1) : null,
      path2: rsa.path2 ? String(rsa.path2) : null,
      resourceName: String(adGroupAd.resource_name),
    };
  });
};

export const updateAdStatus = async (
  customer: GoogleAdsCustomer,
  adGroupId: string,
  adId: string,
  status: AdGroupStatus
): Promise<void> => {
  await customer.adGroupAds.update([
    {
      resource_name: `customers/${customer.credentials.customer_id}/adGroupAds/${adGroupId}~${adId}`,
      status,
    },
  ]);
};

export const removeAd = async (
  customer: GoogleAdsCustomer,
  adGroupId: string,
  adId: string
): Promise<void> => {
  await customer.adGroupAds.remove([
    `customers/${customer.credentials.customer_id}/adGroupAds/${adGroupId}~${adId}`,
  ]);
};

// ─── Serving eligibility + full readback ───

export interface CampaignServingState {
  campaignId: string;
  status: string;
  servingStatus: string;
  /** Google's own primary reason a campaign is not serving, when it says one. */
  primaryStatus: string | null;
  primaryStatusReasons: string[];
}

/**
 * What GOOGLE says about whether this campaign can serve — never our own guess.
 * `campaign.primary_status` is Google's verdict; the reasons name what is
 * missing (no ad group, no ad, budget, policy).
 */
export const getCampaignServingState = async (
  customer: GoogleAdsCustomer,
  campaignId: string
): Promise<CampaignServingState | null> => {
  const rows = await customer.query(`
    SELECT
      campaign.id,
      campaign.status,
      campaign.serving_status,
      campaign.primary_status,
      campaign.primary_status_reasons
    FROM campaign
    WHERE campaign.id = ${Number(campaignId)}
  `);
  if (rows.length === 0) return null;

  const c = rows[0].campaign as Record<string, unknown>;
  return {
    campaignId: String(c.id),
    status: String(c.status ?? ""),
    servingStatus: String(c.serving_status ?? ""),
    primaryStatus: c.primary_status ? String(c.primary_status) : null,
    primaryStatusReasons: Array.isArray(c.primary_status_reasons)
      ? c.primary_status_reasons.map(String)
      : [],
  };
};

export interface CampaignStructure {
  campaignId: string;
  serving: CampaignServingState | null;
  adGroups: Array<
    AdGroup & {
      keywords: Keyword[];
      negativeKeywords: Keyword[];
      ads: ResponsiveSearchAd[];
    }
  >;
  campaignNegativeKeywords: CampaignNegativeKeyword[];
}

/**
 * Everything this service created for a campaign, in one read — so a later
 * workflow run can see what already exists and adjust it instead of building
 * a second copy of it.
 */
export const getCampaignStructure = async (
  customer: GoogleAdsCustomer,
  campaignId: string
): Promise<CampaignStructure> => {
  const [serving, adGroups, keywords, negatives, ads, campaignNegatives] = await Promise.all([
    getCampaignServingState(customer, campaignId),
    listAdGroups(customer, campaignId),
    listKeywords(customer, { campaignId, negative: false }),
    listKeywords(customer, { campaignId, negative: true }),
    listResponsiveSearchAds(customer, { campaignId }),
    listCampaignNegativeKeywords(customer, campaignId),
  ]);

  return {
    campaignId,
    serving,
    adGroups: adGroups.map((group) => ({
      ...group,
      keywords: keywords.filter((k) => k.adGroupId === group.id),
      negativeKeywords: negatives.filter((k) => k.adGroupId === group.id),
      ads: ads.filter((a) => a.adGroupId === group.id),
    })),
    campaignNegativeKeywords: campaignNegatives,
  };
};

// ─── Managed advertiser account (created under OUR manager account) ───

export interface CreateManagedAccountInput {
  descriptiveName: string;
  currencyCode: string;
  timeZone: string;
}

/**
 * Creates a client account under our own manager account. The client supplies
 * no Google credential and never opens the Google Ads UI — we advertise on
 * their behalf from our agency manager account.
 */
export const createManagedClientAccount = async (
  customer: GoogleAdsCustomer,
  managerAccountId: string,
  input: CreateManagedAccountInput
): Promise<{ accountId: string; resourceName: string }> => {
  const response = await customer.customers.createCustomerClient({
    customer_id: managerAccountId,
    customer_client: {
      descriptive_name: input.descriptiveName,
      currency_code: input.currencyCode,
      time_zone: input.timeZone,
    },
  });

  const resourceName = response.resource_name ?? response.resourceName;
  if (!resourceName) {
    throw new Error("Google returned no resource name for the created client account");
  }
  const accountId = resourceName.split("/").pop() ?? resourceName;
  return { accountId, resourceName };
};
