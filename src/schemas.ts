import { z } from "zod";

// ─── Health ───

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("google-service"),
  timestamp: z.string(),
});

// ─── Auth ───

export const AuthUrlQuerySchema = z.object({
  redirectUri: z.string().url().optional(),
});

export const AuthUrlResponseSchema = z.object({
  url: z.string().url(),
});

export const AuthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const AuthCallbackResponseSchema = z.object({
  success: z.boolean(),
  accountId: z.string(),
  message: z.string(),
});

// ─── Accounts ───

export const AccountSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string(),
  userId: z.string(),
  accountId: z.string(),
  mccId: z.string(),
  createdAt: z.string(),
});

export const AccountsResponseSchema = z.object({
  accounts: z.array(AccountSchema),
});

// ─── Campaign ───

export const CampaignStatusEnum = z.enum([
  "ENABLED",
  "PAUSED",
  "REMOVED",
]);

export const CampaignsQuerySchema = z.object({
  status: CampaignStatusEnum.optional(),
});

export const AccountIdParamSchema = z.object({
  accountId: z.string().min(1),
});

export const CampaignIdParamSchema = z.object({
  accountId: z.string().min(1),
  campaignId: z.string().min(1),
});

export const CampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: CampaignStatusEnum,
  advertisingChannelType: z.string(),
  biddingStrategy: z.string().optional(),
  budgetAmountMicros: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const CampaignsResponseSchema = z.object({
  campaigns: z.array(CampaignSchema),
});

export const CampaignDetailSchema = CampaignSchema.extend({
  resourceName: z.string(),
  urlCustomParameters: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
});

// ─── Performance ───

export const PerformanceQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const PerformanceMetricsSchema = z.object({
  impressions: z.number(),
  clicks: z.number(),
  conversions: z.number(),
  costMicros: z.string(),
  cpa: z.number().nullable(),
  roas: z.number().nullable(),
  ctr: z.number(),
  averageCpc: z.number().nullable(),
});

export const PerformanceResponseSchema = z.object({
  campaignId: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  metrics: PerformanceMetricsSchema,
});

// ─── Conversions ───

export const ConversionActionSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  status: z.string(),
  type: z.string(),
});

export const ConversionsResponseSchema = z.object({
  conversionActions: z.array(ConversionActionSchema),
});

// ─── Offline conversion upload (send the real outcome back to Google) ───

export const ClickConversionSchema = z
  .object({
    // At least one click identifier is required — it is what ties the outcome
    // back to the click that produced it.
    gclid: z.string().min(1).optional(),
    gbraid: z.string().min(1).optional(),
    wbraid: z.string().min(1).optional(),
    conversionActionId: z.string().min(1),
    // Google requires an explicit UTC offset: "yyyy-mm-dd hh:mm:ss+|-hh:mm".
    conversionDateTime: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, {
        message:
          "conversionDateTime must be 'yyyy-mm-dd hh:mm:ss+|-hh:mm' (explicit UTC offset)",
      }),
    conversionValue: z.number().nonnegative().optional(),
    currencyCode: z.string().length(3).optional(),
    orderId: z.string().min(1).optional(),
  })
  .refine((c) => Boolean(c.gclid || c.gbraid || c.wbraid), {
    message: "one of gclid, gbraid or wbraid is required",
  });

export const UploadConversionsBodySchema = z.object({
  conversions: z.array(ClickConversionSchema).min(1).max(2000),
  validateOnly: z.boolean().optional(),
});

export const UploadConversionsResponseSchema = z.object({
  requested: z.number(),
  uploaded: z.number(),
  partialFailureError: z.string().nullable(),
});

// ─── Ads spend (declared cost ledger, dated by Google's own day) ───

export const SpendQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const SpendDaySchema = z.object({
  campaignId: z.string(),
  date: z.string(),
  costMicros: z.string(),
  observedCents: z.number(),
  declaredCents: z.number(),
  runId: z.string().nullable(),
  lastSeenAt: z.string(),
  lastDeclaredAt: z.string().nullable(),
});

export const SpendResponseSchema = z.object({
  accountId: z.string(),
  days: z.array(SpendDaySchema),
});

// ─── Create Campaign ───

export const CreateCampaignBodySchema = z.object({
  name: z.string().min(1),
  advertisingChannelType: z.string().min(1),
  status: CampaignStatusEnum.default("PAUSED"),
  budgetAmountMicros: z.string().min(1),
  biddingStrategy: z.string().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const CreateCampaignResponseSchema = z.object({
  campaign: CampaignSchema,
  message: z.string(),
});

// ─── Update Campaign ───

export const UpdateCampaignBodySchema = z.object({
  status: CampaignStatusEnum.optional(),
  budgetAmountMicros: z.string().optional(),
  biddingStrategy: z.string().optional(),
  name: z.string().optional(),
});

export const UpdateCampaignResponseSchema = z.object({
  campaign: CampaignSchema,
  message: z.string(),
});

// ─── Duplicate Campaign ───

export const DuplicateCampaignBodySchema = z.object({
  newName: z.string().min(1).optional(),
});

export const DuplicateCampaignResponseSchema = z.object({
  campaign: CampaignSchema,
  message: z.string(),
});

// ─── Search ───

export const WebSearchBodySchema = z.object({
  query: z.string().min(1),
  num: z.number().int().min(1).max(100).optional(),
  gl: z.string().length(2).optional(),
  hl: z.string().min(2).max(5).optional(),
});

export const WebSearchResultSchema = z.object({
  title: z.string(),
  link: z.string(),
  snippet: z.string(),
  domain: z.string(),
  position: z.number(),
});

export const WebSearchResponseSchema = z.object({
  results: z.array(WebSearchResultSchema),
});

export const NewsSearchBodySchema = z.object({
  query: z.string().min(1),
  num: z.number().int().min(1).max(100).optional(),
  gl: z.string().length(2).optional(),
  hl: z.string().min(2).max(5).optional(),
  tbs: z.string().optional(),
});

export const NewsSearchResultSchema = z.object({
  title: z.string(),
  link: z.string(),
  snippet: z.string(),
  source: z.string(),
  date: z.string(),
  domain: z.string(),
});

export const NewsSearchResponseSchema = z.object({
  results: z.array(NewsSearchResultSchema),
});

export const BatchSearchQuerySchema = z.object({
  query: z.string().min(1),
  type: z.enum(["web", "news"]),
  num: z.number().int().min(1).max(100).optional(),
  gl: z.string().length(2).optional(),
  hl: z.string().min(2).max(5).optional(),
});

export const BatchSearchBodySchema = z.object({
  queries: z.array(BatchSearchQuerySchema).min(1).max(50),
});

export const BatchSearchResultItemSchema = z.object({
  query: z.string(),
  type: z.enum(["web", "news"]),
  results: z.array(z.union([WebSearchResultSchema, NewsSearchResultSchema])),
});

export const BatchSearchResponseSchema = z.object({
  results: z.array(BatchSearchResultItemSchema),
});


// ─── Google CRM (Gmail + People bronze) ───

export const GoogleAuthStartBodySchema = z.object({
  redirectUri: z.string().url().optional(),
});

export const GoogleAuthStartResponseSchema = z.object({
  url: z.string().url(),
  state: z.string(),
});

export const GoogleAuthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const GoogleAuthCallbackResponseSchema = z.object({
  success: z.boolean(),
  googleAccountId: z.string().uuid(),
  googleAccountEmail: z.string(),
});

export const GoogleSyncSummarySchema = z.object({
  accounts: z.number().int(),
  gmail: z.object({
    inserted: z.number().int(),
    updated: z.number().int(),
    unchanged: z.number().int(),
  }),
  contacts: z.object({
    inserted: z.number().int(),
    updated: z.number().int(),
    unchanged: z.number().int(),
    deleted: z.number().int(),
  }),
});

export const GoogleSyncJobStatusEnum = z.enum(["running", "succeeded", "failed"]);

export const GoogleSyncStartResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: GoogleSyncJobStatusEnum,
});

export const GoogleSyncJobIdParamSchema = z.object({
  jobId: z.string().uuid(),
});

export const GoogleSyncJobResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: GoogleSyncJobStatusEnum,
  summary: GoogleSyncSummarySchema.nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export const GoogleMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  account_id: z.string().uuid().optional(),
  thread_id: z.string().optional(),
  participant: z.string().optional(),
});

export const GoogleMessageItemSchema = z.object({
  id: z.string().uuid(),
  googleAccountId: z.string().uuid(),
  gmailMessageId: z.string(),
  threadId: z.string(),
  historyId: z.string(),
  payload: z.unknown(),
  fetchedAt: z.string(),
  // Typed silver fields (additive; legacy fields incl payload preserved above).
  fromEmail: z.string().nullable(),
  fromName: z.string().nullable(),
  to: z.array(z.string()),
  subject: z.string().nullable(),
  snippet: z.string().nullable(),
  sentAt: z.string().nullable(),
  labels: z.array(z.string()),
});

export const GoogleMessagesResponseSchema = z.object({
  items: z.array(GoogleMessageItemSchema),
  nextCursor: z.string().nullable(),
});

export const GoogleContactsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  account_id: z.string().uuid().optional(),
  query: z.string().optional(),
});

export const GoogleContactLinksSchema = z.object({
  orgIds: z.array(z.string()),
  brandIds: z.array(z.string()),
  featureSlugs: z.array(z.string()),
  status: z.string().nullable(),
});

export const GoogleContactItemSchema = z.object({
  id: z.string().uuid(),
  googleAccountId: z.string().uuid(),
  resourceName: z.string(),
  etag: z.string().nullable(),
  payload: z.unknown(),
  fetchedAt: z.string(),
  // Typed silver fields (additive; legacy fields incl payload preserved above).
  displayName: z.string().nullable(),
  primaryEmail: z.string().nullable(),
  emails: z.array(z.string()),
  phones: z.array(z.string()),
  organization: z.string().nullable(),
  jobTitle: z.string().nullable(),
  photoUrl: z.string().nullable(),
  updatedAt: z.string().nullable(),
  deleted: z.boolean(),
  links: GoogleContactLinksSchema,
});

export const GoogleContactLinkPutBodySchema = z.object({
  resourceName: z.string().min(1),
  orgIds: z.array(z.string()),
  brandIds: z.array(z.string()),
  featureSlugs: z.array(z.string()),
  status: z.string().nullable().optional(),
});

export const GoogleContactLinkResponseSchema = z.object({
  resourceName: z.string(),
  orgIds: z.array(z.string()),
  brandIds: z.array(z.string()),
  featureSlugs: z.array(z.string()),
  status: z.string().nullable(),
});

export const GoogleContactsResponseSchema = z.object({
  items: z.array(GoogleContactItemSchema),
  nextCursor: z.string().nullable(),
});

export const GoogleAccountSummarySchema = z.object({
  email: z.string(),
  status: z.literal("active"),
  scopes: z.array(z.string()),
  connectedAt: z.string(),
});

export const GoogleAccountsListResponseSchema = z.object({
  accounts: z.array(GoogleAccountSummarySchema),
});

// ─── Error ───

export const ErrorResponseSchema = z.object({
  error: z.string(),
});
