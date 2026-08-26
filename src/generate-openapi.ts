import { zodToJsonSchema } from "zod-to-json-schema";
import * as fs from "fs";
import * as path from "path";
import * as schemas from "./schemas";

const toSchema = (zodSchema: Parameters<typeof zodToJsonSchema>[0]) =>
  zodToJsonSchema(zodSchema, { target: "openApi3" });

// ─── Serving stack paths (ad groups, keywords, negatives, ads, bidding) ───
// Everything below the campaign, plus the managed advertiser account and the
// live bidding switch. Identity headers are the same on every route.

const identityParams = [
  { $ref: "#/components/parameters/OrgId" },
  { $ref: "#/components/parameters/UserId" },
  { $ref: "#/components/parameters/RunId" },
  { $ref: "#/components/parameters/FeatureSlug" },
  { $ref: "#/components/parameters/BrandId" },
  { $ref: "#/components/parameters/AudienceId" },
];

const pathParam = (name: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});

const jsonBody = (ref: string) => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } },
});

const jsonResponse = (description: string, ref?: string) => ({
  description,
  ...(ref
    ? { content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } }
    : {}),
});

const servingPaths = {
  "/accounts/{accountId}/campaigns/{campaignId}/ad-groups": {
    post: {
      summary: "Create an ad group under a campaign",
      description:
        "The grouping level beneath a campaign. A Search campaign with no ad group serves zero impressions.",
      parameters: [...identityParams, pathParam("accountId"), pathParam("campaignId")],
      requestBody: jsonBody("CreateAdGroupBody"),
      responses: {
        "201": jsonResponse("Ad group created"),
        "404": jsonResponse("Org owns no such account"),
        "502": jsonResponse("Google rejected the request"),
      },
    },
    get: {
      summary: "List the campaign's ad groups",
      parameters: [...identityParams, pathParam("accountId"), pathParam("campaignId")],
      responses: { "200": jsonResponse("Ad groups", "AdGroupsResponse") },
    },
  },
  "/accounts/{accountId}/ad-groups/{adGroupId}": {
    patch: {
      summary: "Update an ad group (name, status, default bid)",
      parameters: [...identityParams, pathParam("accountId"), pathParam("adGroupId")],
      requestBody: jsonBody("UpdateAdGroupBody"),
      responses: { "200": jsonResponse("Updated ad group") },
    },
  },
  "/accounts/{accountId}/ad-groups/{adGroupId}/keywords": {
    post: {
      summary: "Add the search terms the ad group bids on",
      description: "Each keyword carries its match behaviour (EXACT, PHRASE, BROAD).",
      parameters: [...identityParams, pathParam("accountId"), pathParam("adGroupId")],
      requestBody: jsonBody("AddKeywordsBody"),
      responses: {
        "201": jsonResponse("Keywords created", "CreatedCriteriaResponse"),
        "502": jsonResponse("Google rejected the request"),
      },
    },
    get: {
      summary: "List the ad group's keywords",
      parameters: [...identityParams, pathParam("accountId"), pathParam("adGroupId")],
      responses: { "200": jsonResponse("Keywords", "KeywordsResponse") },
    },
  },
  "/accounts/{accountId}/ad-groups/{adGroupId}/keywords/{criterionId}": {
    patch: {
      summary: "Pause or enable one keyword",
      parameters: [
        ...identityParams,
        pathParam("accountId"),
        pathParam("adGroupId"),
        pathParam("criterionId"),
      ],
      requestBody: jsonBody("UpdateKeywordBody"),
      responses: { "200": jsonResponse("Keyword updated") },
    },
    delete: {
      summary: "Remove one keyword",
      parameters: [
        ...identityParams,
        pathParam("accountId"),
        pathParam("adGroupId"),
        pathParam("criterionId"),
      ],
      responses: { "200": jsonResponse("Keyword removed") },
    },
  },
  "/accounts/{accountId}/ad-groups/{adGroupId}/negative-keywords": {
    post: {
      summary: "Add terms this ad group must never bid on",
      parameters: [...identityParams, pathParam("accountId"), pathParam("adGroupId")],
      requestBody: jsonBody("AddNegativeKeywordsBody"),
      responses: { "201": jsonResponse("Negative keywords created", "CreatedCriteriaResponse") },
    },
    get: {
      summary: "List the ad group's negative keywords",
      parameters: [...identityParams, pathParam("accountId"), pathParam("adGroupId")],
      responses: { "200": jsonResponse("Negative keywords", "KeywordsResponse") },
    },
  },
  "/accounts/{accountId}/campaigns/{campaignId}/negative-keywords": {
    post: {
      summary: "Add terms the whole campaign must never bid on",
      parameters: [...identityParams, pathParam("accountId"), pathParam("campaignId")],
      requestBody: jsonBody("AddNegativeKeywordsBody"),
      responses: { "201": jsonResponse("Negative keywords created", "CreatedCriteriaResponse") },
    },
    get: {
      summary: "List the campaign's negative keywords",
      parameters: [...identityParams, pathParam("accountId"), pathParam("campaignId")],
      responses: {
        "200": jsonResponse("Negative keywords", "CampaignNegativeKeywordsResponse"),
      },
    },
  },
  "/accounts/{accountId}/campaigns/{campaignId}/negative-keywords/{criterionId}": {
    delete: {
      summary: "Remove one campaign-level negative keyword",
      parameters: [
        ...identityParams,
        pathParam("accountId"),
        pathParam("campaignId"),
        pathParam("criterionId"),
      ],
      responses: { "200": jsonResponse("Negative keyword removed") },
    },
  },
  "/accounts/{accountId}/ad-groups/{adGroupId}/ads": {
    post: {
      summary: "Create the responsive search ad",
      description:
        "Google composes the ad at serve time from the headline and description variants that exist, so choosing the variants IS writing the ad. A variant may be pinned to a fixed position (compliance or brand lines) while the rest stay free for Google to test.",
      parameters: [...identityParams, pathParam("accountId"), pathParam("adGroupId")],
      requestBody: jsonBody("CreateResponsiveSearchAdBody"),
      responses: {
        "201": jsonResponse("Ad created"),
        "502": jsonResponse("Google rejected the ad (including a policy refusal)"),
      },
    },
    get: {
      summary: "List the ad group's responsive search ads",
      parameters: [...identityParams, pathParam("accountId"), pathParam("adGroupId")],
      responses: { "200": jsonResponse("Ads", "AdsResponse") },
    },
  },
  "/accounts/{accountId}/ad-groups/{adGroupId}/ads/{adId}": {
    patch: {
      summary: "Pause or enable one ad",
      parameters: [
        ...identityParams,
        pathParam("accountId"),
        pathParam("adGroupId"),
        pathParam("adId"),
      ],
      requestBody: jsonBody("UpdateAdBody"),
      responses: { "200": jsonResponse("Ad updated") },
    },
    delete: {
      summary: "Remove one ad",
      parameters: [
        ...identityParams,
        pathParam("accountId"),
        pathParam("adGroupId"),
        pathParam("adId"),
      ],
      responses: { "200": jsonResponse("Ad removed") },
    },
  },
  "/accounts/{accountId}/campaigns/{campaignId}/bidding": {
    put: {
      summary: "Change the bidding approach on a live campaign",
      description:
        "A new campaign launches click-based or manual because it has no conversion history, and graduates to conversion-based bidding once conversions have accrued. The campaign is never recreated: it keeps its id, its structure and its history.",
      parameters: [...identityParams, pathParam("accountId"), pathParam("campaignId")],
      requestBody: jsonBody("UpdateBiddingBody"),
      responses: {
        "200": jsonResponse("Bidding strategy changed"),
        "502": jsonResponse("Google rejected the change"),
      },
    },
  },
  "/accounts/{accountId}/campaigns/{campaignId}/structure": {
    get: {
      summary: "Read back everything created for this campaign",
      description:
        "Campaign serving state plus every ad group with its keywords, negatives and ads — so a later run can adjust what exists instead of duplicating it.",
      parameters: [...identityParams, pathParam("accountId"), pathParam("campaignId")],
      responses: {
        "200": jsonResponse("Campaign structure", "CampaignStructureResponse"),
      },
    },
  },
  "/accounts/{accountId}/campaigns/{campaignId}/serving-state": {
    get: {
      summary: "Google's own verdict on whether the campaign can serve",
      parameters: [...identityParams, pathParam("accountId"), pathParam("campaignId")],
      responses: {
        "200": jsonResponse("Serving state", "CampaignServingState"),
        "404": jsonResponse("Campaign not found"),
      },
    },
  },
  "/orgs/google-ads/managed-accounts": {
    post: {
      summary: "Provision a managed advertiser account under our manager account",
      description:
        "The managed path: the client supplies NO Google credential and never opens the Google Ads UI. Idempotent per brand — a second call for the same brandId returns the account that already exists (200, created=false).",
      parameters: identityParams,
      requestBody: jsonBody("CreateManagedAccountBody"),
      responses: {
        "200": jsonResponse("Account already existed", "CreateManagedAccountResponse"),
        "201": jsonResponse("Account created", "CreateManagedAccountResponse"),
        "502": jsonResponse("Google rejected the account creation"),
      },
    },
    get: {
      summary: "List the org's managed advertiser accounts",
      parameters: identityParams,
      responses: { "200": jsonResponse("Managed accounts", "ManagedAccountsResponse") },
    },
  },
};

const spec = {
  openapi: "3.0.0",
  info: {
    title: "Google Ads Service",
    description:
      "Wraps the Google Ads API (v23) for MCC agency management. Handles OAuth, account linking, campaign CRUD, and performance reporting.",
    version: "1.0.0",
  },
  servers: [{ url: "http://localhost:8080" }],
  components: {
    securitySchemes: {
      serviceKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "Service-to-service API key",
      },
    },
    schemas: {
      HealthResponse: toSchema(schemas.HealthResponseSchema),
      AuthUrlResponse: toSchema(schemas.AuthUrlResponseSchema),
      AuthCallbackResponse: toSchema(schemas.AuthCallbackResponseSchema),
      AccountsResponse: toSchema(schemas.AccountsResponseSchema),
      Account: toSchema(schemas.AccountSchema),
      CampaignsResponse: toSchema(schemas.CampaignsResponseSchema),
      Campaign: toSchema(schemas.CampaignSchema),
      CampaignDetail: toSchema(schemas.CampaignDetailSchema),
      PerformanceResponse: toSchema(schemas.PerformanceResponseSchema),
      PerformanceMetrics: toSchema(schemas.PerformanceMetricsSchema),
      ConversionsResponse: toSchema(schemas.ConversionsResponseSchema),
      UploadConversionsBody: toSchema(schemas.UploadConversionsBodySchema),
      UploadConversionsResponse: toSchema(schemas.UploadConversionsResponseSchema),
      SpendResponse: toSchema(schemas.SpendResponseSchema),
      BiddingStrategy: toSchema(schemas.BiddingStrategySchema),
      UpdateBiddingBody: toSchema(schemas.UpdateBiddingBodySchema),
      CreateAdGroupBody: toSchema(schemas.CreateAdGroupBodySchema),
      UpdateAdGroupBody: toSchema(schemas.UpdateAdGroupBodySchema),
      AdGroup: toSchema(schemas.AdGroupSchema),
      AdGroupsResponse: toSchema(schemas.AdGroupsResponseSchema),
      AddKeywordsBody: toSchema(schemas.AddKeywordsBodySchema),
      AddNegativeKeywordsBody: toSchema(schemas.AddNegativeKeywordsBodySchema),
      UpdateKeywordBody: toSchema(schemas.UpdateKeywordBodySchema),
      CreatedCriteriaResponse: toSchema(schemas.CreatedCriteriaResponseSchema),
      Keyword: toSchema(schemas.KeywordSchema),
      KeywordsResponse: toSchema(schemas.KeywordsResponseSchema),
      CampaignNegativeKeywordsResponse: toSchema(schemas.CampaignNegativeKeywordsResponseSchema),
      CreateResponsiveSearchAdBody: toSchema(schemas.CreateResponsiveSearchAdBodySchema),
      UpdateAdBody: toSchema(schemas.UpdateAdBodySchema),
      ResponsiveSearchAd: toSchema(schemas.ResponsiveSearchAdSchema),
      AdsResponse: toSchema(schemas.AdsResponseSchema),
      CampaignServingState: toSchema(schemas.CampaignServingStateSchema),
      CampaignStructureResponse: toSchema(schemas.CampaignStructureResponseSchema),
      CreateManagedAccountBody: toSchema(schemas.CreateManagedAccountBodySchema),
      CreateManagedAccountResponse: toSchema(schemas.CreateManagedAccountResponseSchema),
      ManagedAccountsResponse: toSchema(schemas.ManagedAccountsResponseSchema),
      SpendDay: toSchema(schemas.SpendDaySchema),
      ConversionAction: toSchema(schemas.ConversionActionSchema),
      CreateCampaignBody: toSchema(schemas.CreateCampaignBodySchema),
      CreateCampaignResponse: toSchema(schemas.CreateCampaignResponseSchema),
      UpdateCampaignBody: toSchema(schemas.UpdateCampaignBodySchema),
      UpdateCampaignResponse: toSchema(schemas.UpdateCampaignResponseSchema),
      DuplicateCampaignBody: toSchema(schemas.DuplicateCampaignBodySchema),
      DuplicateCampaignResponse: toSchema(schemas.DuplicateCampaignResponseSchema),
      WebSearchBody: toSchema(schemas.WebSearchBodySchema),
      WebSearchResult: toSchema(schemas.WebSearchResultSchema),
      WebSearchResponse: toSchema(schemas.WebSearchResponseSchema),
      NewsSearchBody: toSchema(schemas.NewsSearchBodySchema),
      NewsSearchResult: toSchema(schemas.NewsSearchResultSchema),
      NewsSearchResponse: toSchema(schemas.NewsSearchResponseSchema),
      BatchSearchBody: toSchema(schemas.BatchSearchBodySchema),
      BatchSearchResultItem: toSchema(schemas.BatchSearchResultItemSchema),
      BatchSearchResponse: toSchema(schemas.BatchSearchResponseSchema),
      GoogleAuthStartBody: toSchema(schemas.GoogleAuthStartBodySchema),
      GoogleAuthStartResponse: toSchema(schemas.GoogleAuthStartResponseSchema),
      GoogleAuthCallbackResponse: toSchema(schemas.GoogleAuthCallbackResponseSchema),
      GoogleSyncSummary: toSchema(schemas.GoogleSyncSummarySchema),
      GoogleSyncStartResponse: toSchema(schemas.GoogleSyncStartResponseSchema),
      GoogleSyncJobResponse: toSchema(schemas.GoogleSyncJobResponseSchema),
      GoogleMessageItem: toSchema(schemas.GoogleMessageItemSchema),
      GoogleMessagesResponse: toSchema(schemas.GoogleMessagesResponseSchema),
      GoogleContactLinks: toSchema(schemas.GoogleContactLinksSchema),
      GoogleContactItem: toSchema(schemas.GoogleContactItemSchema),
      GoogleContactsResponse: toSchema(schemas.GoogleContactsResponseSchema),
      GoogleContactLinkPutBody: toSchema(schemas.GoogleContactLinkPutBodySchema),
      GoogleContactLinkResponse: toSchema(schemas.GoogleContactLinkResponseSchema),
      GoogleAccountSummary: toSchema(schemas.GoogleAccountSummarySchema),
      GoogleAccountsListResponse: toSchema(schemas.GoogleAccountsListResponseSchema),
      ErrorResponse: toSchema(schemas.ErrorResponseSchema),
    },
    parameters: {
      OrgId: {
        name: "x-org-id",
        in: "header",
        required: true,
        schema: { type: "string" },
        description: "Internal org UUID from client-service",
      },
      UserId: {
        name: "x-user-id",
        in: "header",
        required: true,
        schema: { type: "string" },
        description: "Internal user UUID from client-service",
      },
      RunId: {
        name: "x-run-id",
        in: "header",
        required: true,
        schema: { type: "string" },
        description: "Caller's run ID from runs-service (used as parentRunId when creating a child run)",
      },
      FeatureSlug: {
        name: "x-feature-slug",
        in: "header",
        required: false,
        schema: { type: "string" },
        description: "Feature slug for tracking which feature triggered the request",
      },
      BrandId: {
        name: "x-brand-id",
        in: "header",
        required: false,
        schema: { type: "string" },
        description: "Comma-separated list of brand UUIDs (e.g. \"uuid1,uuid2,uuid3\"). Forwarded to all downstream service calls.",
        example: "550e8400-e29b-41d4-a716-446655440000,6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      },
      AudienceId: {
        name: "x-audience-id",
        in: "header",
        required: false,
        schema: { type: "string", format: "uuid" },
        description: "Audience attribution UUID (the campaign's priority audience). Present on campaign-run node calls; forwarded to runs/billing/key cost declarations for per-audience cost attribution. Omitted outside the campaign flow.",
        example: "7f9e6c2a-3b4d-4e5f-8a1b-2c3d4e5f6a7b",
      },
    },
  },
  paths: {
    ...servingPaths,
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthResponse" },
              },
            },
          },
        },
      },
    },
    "/auth/url": {
      get: {
        summary: "Generate Google OAuth2 URL for Google Ads scope",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "redirectUri", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "OAuth URL generated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AuthUrlResponse" },
              },
            },
          },
          "400": {
            description: "Invalid request",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/auth/callback": {
      get: {
        summary: "OAuth2 callback — exchanges code for refresh token and links accounts",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "code", in: "query", required: true, schema: { type: "string" } },
          { name: "state", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Account linked successfully",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AuthCallbackResponse" },
              },
            },
          },
          "400": {
            description: "Invalid or expired state",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/accounts": {
      get: {
        summary: "List linked Google Ads accounts for an org",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
        ],
        responses: {
          "200": {
            description: "List of accounts",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AccountsResponse" },
              },
            },
          },
        },
      },
    },
    "/accounts/{accountId}/campaigns": {
      get: {
        summary: "List campaigns for a Google Ads account",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["ENABLED", "PAUSED", "REMOVED"] },
          },
        ],
        responses: {
          "200": {
            description: "List of campaigns",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CampaignsResponse" },
              },
            },
          },
        },
      },
      post: {
        summary: "Create a new campaign",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreateCampaignBody" },
            },
          },
        },
        responses: {
          "201": {
            description: "Campaign created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateCampaignResponse" },
              },
            },
          },
        },
      },
    },
    "/accounts/{accountId}/campaigns/{campaignId}": {
      get: {
        summary: "Get campaign details",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          { name: "campaignId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Campaign details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CampaignDetail" },
              },
            },
          },
          "404": {
            description: "Campaign not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
      patch: {
        summary: "Update campaign (budget, bids, status)",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          { name: "campaignId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdateCampaignBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Campaign updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdateCampaignResponse" },
              },
            },
          },
        },
      },
    },
    "/accounts/{accountId}/campaigns/{campaignId}/performance": {
      get: {
        summary:
          "Get campaign performance metrics (impressions, clicks, conversions, CPA, ROAS)",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          { name: "campaignId", in: "path", required: true, schema: { type: "string" } },
          {
            name: "startDate",
            in: "query",
            required: true,
            schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
          {
            name: "endDate",
            in: "query",
            required: true,
            schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
        ],
        responses: {
          "200": {
            description: "Performance metrics",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PerformanceResponse" },
              },
            },
          },
        },
      },
    },
    "/accounts/{accountId}/campaigns/{campaignId}/duplicate": {
      post: {
        summary: "Duplicate a campaign for A/B testing",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          { name: "campaignId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DuplicateCampaignBody" },
            },
          },
        },
        responses: {
          "201": {
            description: "Campaign duplicated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DuplicateCampaignResponse" },
              },
            },
          },
        },
      },
    },
    "/accounts/{accountId}/conversions/upload": {
      post: {
        summary: "Upload offline click conversions (send a measured outcome back to Google)",
        description:
          "Reports an outcome to Google as a conversion attributed to the click that produced it (gclid/gbraid/wbraid), so Smart Bidding optimises on the real answer instead of a proxy. conversionDateTime must carry an explicit UTC offset. Set validateOnly to dry-run without uploading.",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UploadConversionsBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Upload result (uploaded counts only the rows Google accepted)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UploadConversionsResponse" },
              },
            },
          },
        },
      },
    },
    "/accounts/{accountId}/spend": {
      get: {
        summary: "Google Ads spend ledger, dated by Google's own reporting day",
        description:
          "Per-campaign, per-day spend observed from Google and how much of it has been declared as the org's cost (pass-through: 1 unit = 1 USD cent). Written by the independent spend-ingest cron, never by campaign create/update.",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          { name: "startDate", in: "query", required: false, schema: { type: "string" } },
          { name: "endDate", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Daily spend rows",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SpendResponse" },
              },
            },
          },
        },
      },
    },
    "/accounts/{accountId}/conversions": {
      get: {
        summary: "List conversion actions for an account",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "List of conversion actions",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ConversionsResponse" },
              },
            },
          },
        },
      },
    },
    "/search/web": {
      post: {
        summary: "Web search via Serper.dev (Google index)",
        description:
          "Performs a web search using the Serper.dev API and returns organic results from Google's index.",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/WebSearchBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Search results",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/WebSearchResponse" },
              },
            },
          },
          "400": {
            description: "Invalid request body",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "502": {
            description: "Serper API error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/search/news": {
      post: {
        summary: "News search via Serper.dev (Google News index)",
        description:
          "Performs a news search using the Serper.dev API and returns news results from Google's index.",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NewsSearchBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "News search results",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NewsSearchResponse" },
              },
            },
          },
          "400": {
            description: "Invalid request body",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "502": {
            description: "Serper API error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/orgs/google/accounts": {
      get: {
        summary: "List connected Google accounts for the org",
        description:
          "Returns the set of Google (Gmail) accounts the org has connected via OAuth. Sourced from google_oauth_tokens, scoped by x-org-id.",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
        ],
        responses: {
          "200": {
            description: "Connected Google accounts",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GoogleAccountsListResponse" },
              },
            },
          },
        },
      },
    },
    "/orgs/google/auth/start": {
      post: {
        summary: "Start Google CRM OAuth (Gmail + People readonly)",
        description:
          "Generates a Google authorize URL with PKCE for the Gmail readonly + Contacts readonly scopes. Persists state + verifier in google_oauth_pending (10 minute TTL).",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GoogleAuthStartBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Authorize URL",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GoogleAuthStartResponse" },
              },
            },
          },
        },
      },
    },
    "/orgs/google/auth/callback": {
      get: {
        summary: "Google CRM OAuth callback (Gmail + People readonly)",
        description:
          "Exchanges code+PKCE for tokens, stores refresh token in google_oauth_tokens (one row per (org_id, google_account_email)).",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "code", in: "query", required: true, schema: { type: "string" } },
          { name: "state", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Token stored",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GoogleAuthCallbackResponse" },
              },
            },
          },
          "400": {
            description: "Invalid or expired state",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/orgs/google/sync": {
      post: {
        summary: "Start an async Gmail + People sync for all connected Google accounts of the org",
        description:
          "Backfill (last GOOGLE_GMAIL_BACKFILL_DAYS for Gmail; full People connections) on first sync, delta thereafter using Gmail historyId and People syncToken. Idempotent: re-runs produce no duplicate rows. Returns 202 immediately with a jobId; the caller must poll GET /orgs/google/sync/{jobId} until status != 'running'.",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
        ],
        responses: {
          "202": {
            description: "Sync job accepted",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GoogleSyncStartResponse" },
              },
            },
          },
        },
      },
    },
    "/orgs/google/sync/{jobId}": {
      get: {
        summary: "Get the status of an async sync job",
        description:
          "Returns the current status (running | succeeded | failed) of a sync job. On success, summary is populated; on failure, error contains the error message. Lookup is org-scoped: jobs from other orgs return 404.",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": {
            description: "Sync job status",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GoogleSyncJobResponse" },
              },
            },
          },
          "400": {
            description: "Invalid jobId (not a UUID)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "404": {
            description: "Sync job not found for this org",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/orgs/google/messages": {
      get: {
        summary: "List raw Gmail messages (bronze) for the org",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "account_id", in: "query", required: false, schema: { type: "string", format: "uuid" } },
          { name: "thread_id", in: "query", required: false, schema: { type: "string" } },
          { name: "participant", in: "query", required: false, schema: { type: "string" }, description: "Filter to one contact's email thread: only messages where this email appears as a From/To/Cc participant. Ordered by the message's own email date (newest first)." },
        ],
        responses: {
          "200": {
            description: "Paginated raw Gmail messages",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GoogleMessagesResponse" },
              },
            },
          },
        },
      },
    },
    "/orgs/google/contacts": {
      get: {
        summary: "List raw Google contacts (bronze) for the org",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } },
          { name: "cursor", in: "query", required: false, schema: { type: "string" } },
          { name: "account_id", in: "query", required: false, schema: { type: "string", format: "uuid" } },
          { name: "query", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Paginated raw Google contacts",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GoogleContactsResponse" },
              },
            },
          },
        },
      },
    },
    "/orgs/google/contact-links": {
      put: {
        summary: "Upsert per-contact CRM links (org/brand/feature tags + reserved status)",
        description:
          "Persists platform org/brand/feature links (and a reserved status) for one Google contact. resourceName is carried in the body, never the path, because Google resourceNames contain \"/\". Upserts on (org, resourceName).",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GoogleContactLinkPutBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Persisted contact link",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GoogleContactLinkResponse" },
              },
            },
          },
        },
      },
    },
    "/search/batch": {
      post: {
        summary: "Batch search — multiple queries in one call",
        description:
          "Performs multiple web and/or news searches in parallel and returns all results.",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
          { $ref: "#/components/parameters/AudienceId" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BatchSearchBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Batch search results",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BatchSearchResponse" },
              },
            },
          },
          "400": {
            description: "Invalid request body",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "502": {
            description: "Serper API error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
  },
};

const outPath = path.resolve(__dirname, "../openapi.json");
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec written to ${outPath}`);
