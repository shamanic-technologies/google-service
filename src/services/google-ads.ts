/* eslint-disable @typescript-eslint/no-require-imports */
import type { GoogleCredentials } from "./key-service";

// Use lightweight interfaces instead of importing the massive protobuf types
// from google-ads-api which causes tsc OOM
export interface GoogleAdsClient {
  Customer: (opts: {
    customer_id: string;
    login_customer_id: string;
    refresh_token: string;
  }) => GoogleAdsCustomer;
}

export interface GoogleAdsCustomer {
  credentials: { customer_id: string };
  query: (gaql: string) => Promise<Array<Record<string, unknown>>>;
  campaigns: {
    create: (data: unknown[]) => Promise<{ results: Array<{ resource_name: string }> }>;
    update: (data: unknown[]) => Promise<unknown>;
  };
  campaignBudgets: {
    create: (data: unknown[]) => Promise<{ results: Array<{ resource_name: string }> }>;
    update: (data: unknown[]) => Promise<unknown>;
  };
  conversionUploads: {
    uploadClickConversions: (request: Record<string, unknown>) => Promise<{
      results?: Array<Record<string, unknown>>;
      partial_failure_error?: { message?: string; code?: number } | null;
    }>;
  };
}

// Lazy-load the heavy module at runtime, not at type-check time
let _GoogleAdsApi: new (opts: {
  client_id: string;
  client_secret: string;
  developer_token: string;
}) => GoogleAdsClient;

const getGoogleAdsApiClass = () => {
  if (!_GoogleAdsApi) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _GoogleAdsApi = require("google-ads-api").GoogleAdsApi;
  }
  return _GoogleAdsApi;
};

export const createGoogleAdsClient = (creds: GoogleCredentials): GoogleAdsClient =>
  new (getGoogleAdsApiClass())({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    developer_token: creds.developerToken,
  });

export const getCustomer = (
  client: GoogleAdsClient,
  refreshToken: string,
  customerId: string,
  mccAccountId: string
): GoogleAdsCustomer =>
  client.Customer({
    customer_id: customerId,
    login_customer_id: mccAccountId,
    refresh_token: refreshToken,
  });

export const listAccessibleAccounts = async (
  client: GoogleAdsClient,
  refreshToken: string,
  mccAccountId: string
): Promise<Array<{ id: string; name: string; descriptiveName: string }>> => {
  const customer = client.Customer({
    customer_id: mccAccountId,
    login_customer_id: mccAccountId,
    refresh_token: refreshToken,
  });

  const results = await customer.query(`
    SELECT
      customer_client.id,
      customer_client.descriptive_name,
      customer_client.resource_name
    FROM customer_client
    WHERE customer_client.manager = false
  `);

  return results.map((row) => {
    const cc = row.customer_client as { id: string; descriptive_name: string; resource_name: string };
    return {
      id: String(cc.id),
      name: cc.resource_name,
      descriptiveName: cc.descriptive_name,
    };
  });
};

export const listCampaigns = async (
  customer: GoogleAdsCustomer,
  status?: string
): Promise<Array<Record<string, unknown>>> => {
  let gaql = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      campaign.campaign_budget,
      campaign.start_date,
      campaign.end_date
    FROM campaign
  `;
  if (status) {
    gaql += ` WHERE campaign.status = '${status}'`;
  }
  gaql += ` ORDER BY campaign.name`;

  const results = await customer.query(gaql);
  return results.map((row) => {
    const c = row.campaign as Record<string, unknown>;
    return {
      id: String(c.id),
      name: String(c.name),
      status: String(c.status),
      advertisingChannelType: String(c.advertising_channel_type),
      biddingStrategy: c.bidding_strategy_type ? String(c.bidding_strategy_type) : undefined,
      startDate: c.start_date ? String(c.start_date) : undefined,
      endDate: c.end_date ? String(c.end_date) : undefined,
    };
  });
};

export const getCampaignDetail = async (
  customer: GoogleAdsCustomer,
  campaignId: string
): Promise<Record<string, unknown> | null> => {
  const results = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      campaign.campaign_budget,
      campaign.start_date,
      campaign.end_date,
      campaign.resource_name,
      campaign.url_custom_parameters
    FROM campaign
    WHERE campaign.id = ${campaignId}
  `);

  if (results.length === 0) return null;

  const c = results[0].campaign as Record<string, unknown>;
  return {
    id: String(c.id),
    name: String(c.name),
    status: String(c.status),
    advertisingChannelType: String(c.advertising_channel_type),
    biddingStrategy: c.bidding_strategy_type ? String(c.bidding_strategy_type) : undefined,
    budgetAmountMicros: c.campaign_budget ? String(c.campaign_budget) : undefined,
    startDate: c.start_date ? String(c.start_date) : undefined,
    endDate: c.end_date ? String(c.end_date) : undefined,
    resourceName: String(c.resource_name),
    urlCustomParameters: c.url_custom_parameters || [],
    campaignBudget: c.campaign_budget ? String(c.campaign_budget) : undefined,
  };
};

export const getCampaignPerformance = async (
  customer: GoogleAdsCustomer,
  campaignId: string,
  startDate: string,
  endDate: string
): Promise<Record<string, unknown>> => {
  const results = await customer.query(`
    SELECT
      campaign.id,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.cost_micros,
      metrics.cost_per_conversion,
      metrics.conversions_from_interactions_rate,
      metrics.ctr,
      metrics.average_cpc
    FROM campaign
    WHERE campaign.id = ${campaignId}
      AND segments.date BETWEEN '${startDate}' AND '${endDate}'
  `);

  let impressions = 0;
  let clicks = 0;
  let conversions = 0;
  let costMicros = BigInt(0);

  for (const row of results) {
    const m = row.metrics as Record<string, unknown>;
    impressions += Number(m.impressions || 0);
    clicks += Number(m.clicks || 0);
    conversions += Number(m.conversions || 0);
    costMicros += BigInt(String(m.cost_micros || 0));
  }

  const cpa = conversions > 0 ? Number(costMicros) / 1_000_000 / conversions : null;
  const roas = conversions > 0 ? conversions / (Number(costMicros) / 1_000_000) : null;
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const averageCpc = clicks > 0 ? Number(costMicros) / 1_000_000 / clicks : null;

  return {
    impressions,
    clicks,
    conversions,
    costMicros: costMicros.toString(),
    cpa,
    roas,
    ctr,
    averageCpc,
  };
};

export const listConversionActions = async (
  customer: GoogleAdsCustomer
): Promise<Array<Record<string, unknown>>> => {
  const results = await customer.query(`
    SELECT
      conversion_action.id,
      conversion_action.name,
      conversion_action.category,
      conversion_action.status,
      conversion_action.type
    FROM conversion_action
    ORDER BY conversion_action.name
  `);

  return results.map((row) => {
    const ca = row.conversion_action as Record<string, unknown>;
    return {
      id: String(ca.id),
      name: String(ca.name),
      category: String(ca.category),
      status: String(ca.status),
      type: String(ca.type),
    };
  });
};

// ─── Spend (money Google actually charged) ───

export interface CampaignDaySpend {
  campaignId: string;
  /** GOOGLE's day for this spend (segments.date, YYYY-MM-DD) — never our poll day. */
  date: string;
  costMicros: string;
}

/**
 * Per-campaign, per-day cost for a date range, keyed on Google's own reporting
 * day. Segmented by date on purpose: an un-segmented total could only ever be
 * dated by when we read it, which shifts every downstream daily chart by a day.
 */
export const getCampaignSpendByDay = async (
  customer: GoogleAdsCustomer,
  startDate: string,
  endDate: string
): Promise<CampaignDaySpend[]> => {
  const results = await customer.query(`
    SELECT
      campaign.id,
      segments.date,
      metrics.cost_micros
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
  `);

  const spend: CampaignDaySpend[] = [];
  for (const row of results) {
    const c = row.campaign as Record<string, unknown> | undefined;
    const segments = row.segments as Record<string, unknown> | undefined;
    const m = row.metrics as Record<string, unknown> | undefined;
    if (!c?.id || !segments?.date) continue;
    spend.push({
      campaignId: String(c.id),
      date: String(segments.date),
      costMicros: String(m?.cost_micros ?? 0),
    });
  }
  return spend;
};

// ─── Offline conversion upload (send the real outcome back to Google) ───

export interface ClickConversionInput {
  /** Google click id. One of gclid / gbraid / wbraid is required. */
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  /** Conversion action id (from GET /accounts/:accountId/conversions). */
  conversionActionId: string;
  /** "yyyy-mm-dd hh:mm:ss+|-hh:mm" — Google rejects anything without an offset. */
  conversionDateTime: string;
  conversionValue?: number;
  currencyCode?: string;
  orderId?: string;
}

export interface UploadClickConversionsResult {
  requested: number;
  uploaded: number;
  /** Google's partial-failure message when SOME rows were rejected, else null. */
  partialFailureError: string | null;
}

export const uploadClickConversions = async (
  customer: GoogleAdsCustomer,
  conversions: ClickConversionInput[],
  opts: { validateOnly?: boolean } = {}
): Promise<UploadClickConversionsResult> => {
  const customerId = customer.credentials.customer_id;

  const payload = conversions.map((c) => {
    const conversion: Record<string, unknown> = {
      conversion_action: `customers/${customerId}/conversionActions/${c.conversionActionId}`,
      conversion_date_time: c.conversionDateTime,
    };
    if (c.gclid) conversion.gclid = c.gclid;
    if (c.gbraid) conversion.gbraid = c.gbraid;
    if (c.wbraid) conversion.wbraid = c.wbraid;
    if (c.conversionValue !== undefined) conversion.conversion_value = c.conversionValue;
    if (c.currencyCode) conversion.currency_code = c.currencyCode;
    if (c.orderId) conversion.order_id = c.orderId;
    return conversion;
  });

  const validateOnly = opts.validateOnly === true;
  const response = await customer.conversionUploads.uploadClickConversions({
    customer_id: customerId,
    conversions: payload,
    // Google requires exactly one of these to be true.
    partial_failure: !validateOnly,
    validate_only: validateOnly,
  });

  // A rejected row comes back as an empty result entry, so count only the
  // entries Google actually accepted — never report the requested count as
  // uploaded (that would silently swallow a whole failed batch).
  const results = response.results ?? [];
  const uploaded = results.filter((r) => r && Object.keys(r).length > 0).length;
  const partialFailureError = response.partial_failure_error?.message ?? null;

  if (uploaded === 0 && conversions.length > 0 && !validateOnly) {
    throw new Error(
      `Google accepted 0 of ${conversions.length} conversions` +
        (partialFailureError ? `: ${partialFailureError}` : "")
    );
  }

  return { requested: conversions.length, uploaded, partialFailureError };
};

export interface CreateCampaignInput {
  name: string;
  advertisingChannelType: string;
  status: string;
  budgetAmountMicros: string;
  biddingStrategy?: string;
  startDate?: string;
  endDate?: string;
}

export const createCampaign = async (
  customer: GoogleAdsCustomer,
  input: CreateCampaignInput
): Promise<Record<string, unknown>> => {
  const budget = await customer.campaignBudgets.create([
    {
      name: `Budget for ${input.name} - ${Date.now()}`,
      amount_micros: Number(input.budgetAmountMicros),
      delivery_method: 2, // STANDARD
    },
  ]);

  const budgetResourceName = budget.results[0].resource_name;

  const campaignData: Record<string, unknown> = {
    name: input.name,
    advertising_channel_type: input.advertisingChannelType,
    status: input.status,
    campaign_budget: budgetResourceName,
  };

  if (input.startDate) campaignData.start_date = input.startDate;
  if (input.endDate) campaignData.end_date = input.endDate;

  const result = await customer.campaigns.create([campaignData]);
  const resourceName = result.results[0].resource_name;
  const idMatch = resourceName.match(/\/(\d+)$/);
  const campaignId = idMatch ? idMatch[1] : resourceName;

  return {
    id: campaignId,
    name: input.name,
    status: input.status,
    advertisingChannelType: input.advertisingChannelType,
    biddingStrategy: input.biddingStrategy,
    budgetAmountMicros: input.budgetAmountMicros,
    startDate: input.startDate,
    endDate: input.endDate,
  };
};

export const updateCampaign = async (
  customer: GoogleAdsCustomer,
  campaignId: string,
  updates: {
    status?: string;
    budgetAmountMicros?: string;
    name?: string;
  }
): Promise<Record<string, unknown>> => {
  const campaignUpdates: Record<string, unknown> = {
    resource_name: `customers/${customer.credentials.customer_id}/campaigns/${campaignId}`,
  };

  if (updates.status) campaignUpdates.status = updates.status;
  if (updates.name) campaignUpdates.name = updates.name;

  if (Object.keys(campaignUpdates).length > 1) {
    await customer.campaigns.update([campaignUpdates]);
  }

  if (updates.budgetAmountMicros) {
    const detail = await getCampaignDetail(customer, campaignId);
    if (detail?.campaignBudget) {
      await customer.campaignBudgets.update([
        {
          resource_name: String(detail.campaignBudget),
          amount_micros: Number(updates.budgetAmountMicros),
        },
      ]);
    }
  }

  const updated = await getCampaignDetail(customer, campaignId);
  return updated || {};
};

export const duplicateCampaign = async (
  customer: GoogleAdsCustomer,
  campaignId: string,
  newName?: string
): Promise<Record<string, unknown>> => {
  const original = await getCampaignDetail(customer, campaignId);
  if (!original) throw new Error(`Campaign ${campaignId} not found`);

  const name = newName || `${original.name} (copy)`;

  return createCampaign(customer, {
    name,
    advertisingChannelType: String(original.advertisingChannelType),
    status: "PAUSED",
    budgetAmountMicros: String(original.budgetAmountMicros || "1000000"),
    startDate: original.startDate ? String(original.startDate) : undefined,
    endDate: original.endDate ? String(original.endDate) : undefined,
  });
};

export const exchangeCodeForTokens = async (
  code: string,
  redirectUri: string,
  creds: GoogleCredentials
): Promise<{ access_token: string; refresh_token: string }> => {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  return res.json() as Promise<{ access_token: string; refresh_token: string }>;
};
