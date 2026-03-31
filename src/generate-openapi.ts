import { zodToJsonSchema } from "zod-to-json-schema";
import * as fs from "fs";
import * as path from "path";
import * as schemas from "./schemas";

const toSchema = (zodSchema: Parameters<typeof zodToJsonSchema>[0]) =>
  zodToJsonSchema(zodSchema, { target: "openApi3" });

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
    },
  },
  paths: {
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
    "/accounts/{accountId}/conversions": {
      get: {
        summary: "List conversion actions for an account",
        parameters: [
          { $ref: "#/components/parameters/OrgId" },
          { $ref: "#/components/parameters/UserId" },
          { $ref: "#/components/parameters/RunId" },
          { $ref: "#/components/parameters/FeatureSlug" },
          { $ref: "#/components/parameters/BrandId" },
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
