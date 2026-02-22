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
      ErrorResponse: toSchema(schemas.ErrorResponseSchema),
    },
    parameters: {},
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
          { name: "appId", in: "query", required: true, schema: { type: "string" } },
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
        summary: "List linked Google Ads accounts for an app",
        parameters: [
          { name: "appId", in: "query", required: true, schema: { type: "string" } },
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
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          { name: "appId", in: "query", required: true, schema: { type: "string" } },
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
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          { name: "campaignId", in: "path", required: true, schema: { type: "string" } },
          { name: "appId", in: "query", required: true, schema: { type: "string" } },
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
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          { name: "campaignId", in: "path", required: true, schema: { type: "string" } },
          { name: "appId", in: "query", required: true, schema: { type: "string" } },
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
          { name: "accountId", in: "path", required: true, schema: { type: "string" } },
          { name: "appId", in: "query", required: true, schema: { type: "string" } },
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
  },
};

const outPath = path.resolve(__dirname, "../openapi.json");
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`OpenAPI spec written to ${outPath}`);
