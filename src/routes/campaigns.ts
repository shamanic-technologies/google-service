import { Router, Request, Response } from "express";
import { query } from "../db/client";
import { getRefreshToken, getGoogleCredentials, CallerContext } from "../services/key-service";
import {
  createGoogleAdsClient,
  getCustomer,
  listCampaigns,
  getCampaignDetail,
  getCampaignPerformance,
  listConversionActions,
  createCampaign,
  updateCampaign,
  duplicateCampaign,
} from "../services/google-ads";
import {
  validateQuery,
  validateBody,
  validateParams,
} from "../middleware/validate";
import { traceEvent } from "../lib/trace-event";
import {
  CampaignsQuerySchema,
  AccountIdParamSchema,
  CampaignIdParamSchema,
  PerformanceQuerySchema,
  CreateCampaignBodySchema,
  UpdateCampaignBodySchema,
  DuplicateCampaignBodySchema,
} from "../schemas";

const router = Router();

const resolveCustomer = async (orgId: string, userId: string, accountId: string, caller: CallerContext, runId?: string, featureSlug?: string, brandId?: string) => {
  const accountResult = await query(
    `SELECT refresh_token_provider FROM accounts WHERE org_id = $1 AND account_id = $2`,
    [orgId, accountId]
  );
  if (accountResult.rows.length === 0) {
    throw new Error("Account not found");
  }

  const [refreshToken, creds] = await Promise.all([
    getRefreshToken(orgId, userId, accountId, caller, runId, featureSlug, brandId),
    getGoogleCredentials(caller, runId, featureSlug, brandId),
  ]);
  const client = createGoogleAdsClient(creds);
  return getCustomer(client, refreshToken, accountId, creds.mccAccountId);
};

// GET /accounts/:accountId/campaigns
router.get(
  "/accounts/:accountId/campaigns",
  validateParams(AccountIdParamSchema),
  validateQuery(CampaignsQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.validatedParams as { accountId: string };
      const { status } = req.validatedQuery as { status?: string };

      traceEvent(req.runId!, { service: "google-service", event: "campaigns-list-start", detail: `accountId=${accountId}, status=${status ?? "all"}` }, req.headers).catch(() => {});
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, req.runId, req.featureSlug, req.brandId);
      const campaigns = await listCampaigns(customer, status);

      traceEvent(req.runId!, { service: "google-service", event: "campaigns-list-done", detail: `accountId=${accountId}, count=${campaigns.length}` }, req.headers).catch(() => {});
      res.json({ campaigns });
    } catch (err) {
      const message = (err as Error).message;
      const statusCode = message === "Account not found" ? 404 : 500;
      if (req.runId) {
        traceEvent(req.runId, { service: "google-service", event: "campaigns-list-error", detail: message, level: "error" }, req.headers).catch(() => {});
      }
      res.status(statusCode).json({ error: message });
    }
  }
);

// GET /accounts/:accountId/campaigns/:campaignId
router.get(
  "/accounts/:accountId/campaigns/:campaignId",
  validateParams(CampaignIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };

      traceEvent(req.runId!, { service: "google-service", event: "campaign-detail-start", detail: `accountId=${accountId}, campaignId=${campaignId}` }, req.headers).catch(() => {});
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, req.runId, req.featureSlug, req.brandId);
      const campaign = await getCampaignDetail(customer, campaignId);

      if (!campaign) {
        res.status(404).json({ error: "Campaign not found" });
        return;
      }

      traceEvent(req.runId!, { service: "google-service", event: "campaign-detail-done", detail: `campaignId=${campaignId}` }, req.headers).catch(() => {});
      res.json(campaign);
    } catch (err) {
      const message = (err as Error).message;
      const statusCode = message === "Account not found" ? 404 : 500;
      if (req.runId) {
        traceEvent(req.runId, { service: "google-service", event: "campaign-detail-error", detail: message, level: "error" }, req.headers).catch(() => {});
      }
      res.status(statusCode).json({ error: message });
    }
  }
);

// GET /accounts/:accountId/campaigns/:campaignId/performance
router.get(
  "/accounts/:accountId/campaigns/:campaignId/performance",
  validateParams(CampaignIdParamSchema),
  validateQuery(PerformanceQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };
      const { startDate, endDate } = req.validatedQuery as {
        startDate: string;
        endDate: string;
      };

      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, req.runId, req.featureSlug, req.brandId);
      const metrics = await getCampaignPerformance(customer, campaignId, startDate, endDate);

      res.json({
        campaignId,
        startDate,
        endDate,
        metrics,
      });
    } catch (err) {
      const message = (err as Error).message;
      const statusCode = message === "Account not found" ? 404 : 500;
      res.status(statusCode).json({ error: message });
    }
  }
);

// GET /accounts/:accountId/conversions
router.get(
  "/accounts/:accountId/conversions",
  validateParams(AccountIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.validatedParams as { accountId: string };

      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, req.runId, req.featureSlug, req.brandId);
      const conversionActions = await listConversionActions(customer);

      res.json({ conversionActions });
    } catch (err) {
      const message = (err as Error).message;
      const statusCode = message === "Account not found" ? 404 : 500;
      res.status(statusCode).json({ error: message });
    }
  }
);

// POST /accounts/:accountId/campaigns
router.post(
  "/accounts/:accountId/campaigns",
  validateParams(AccountIdParamSchema),
  validateBody(CreateCampaignBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.validatedParams as { accountId: string };
      const body = req.validatedBody as {
        name: string;
        advertisingChannelType: string;
        status: string;
        budgetAmountMicros: string;
        biddingStrategy?: string;
        startDate?: string;
        endDate?: string;
      };

      traceEvent(req.runId!, { service: "google-service", event: "campaign-create-start", detail: `accountId=${accountId}, name=${body.name}` }, req.headers).catch(() => {});
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, req.runId, req.featureSlug, req.brandId);
      const campaign = await createCampaign(customer, body);

      traceEvent(req.runId!, { service: "google-service", event: "campaign-create-done", detail: `accountId=${accountId}, campaignId=${campaign.id}` }, req.headers).catch(() => {});
      res.status(201).json({
        campaign,
        message: "Campaign created successfully",
      });
    } catch (err) {
      const message = (err as Error).message;
      const statusCode = message === "Account not found" ? 404 : 500;
      if (req.runId) {
        traceEvent(req.runId, { service: "google-service", event: "campaign-create-error", detail: message, level: "error" }, req.headers).catch(() => {});
      }
      res.status(statusCode).json({ error: message });
    }
  }
);

// PATCH /accounts/:accountId/campaigns/:campaignId
router.patch(
  "/accounts/:accountId/campaigns/:campaignId",
  validateParams(CampaignIdParamSchema),
  validateBody(UpdateCampaignBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };
      const body = req.validatedBody as {
        status?: string;
        budgetAmountMicros?: string;
        biddingStrategy?: string;
        name?: string;
      };

      traceEvent(req.runId!, { service: "google-service", event: "campaign-update-start", detail: `accountId=${accountId}, campaignId=${campaignId}` }, req.headers).catch(() => {});
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, req.runId, req.featureSlug, req.brandId);
      const campaign = await updateCampaign(customer, campaignId, body);

      traceEvent(req.runId!, { service: "google-service", event: "campaign-update-done", detail: `campaignId=${campaignId}` }, req.headers).catch(() => {});
      res.json({
        campaign,
        message: "Campaign updated successfully",
      });
    } catch (err) {
      const message = (err as Error).message;
      const statusCode = message === "Account not found" ? 404 : 500;
      if (req.runId) {
        traceEvent(req.runId, { service: "google-service", event: "campaign-update-error", detail: message, level: "error" }, req.headers).catch(() => {});
      }
      res.status(statusCode).json({ error: message });
    }
  }
);

// POST /accounts/:accountId/campaigns/:campaignId/duplicate
router.post(
  "/accounts/:accountId/campaigns/:campaignId/duplicate",
  validateParams(CampaignIdParamSchema),
  validateBody(DuplicateCampaignBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };
      const body = req.validatedBody as { newName?: string };

      traceEvent(req.runId!, { service: "google-service", event: "campaign-duplicate-start", detail: `accountId=${accountId}, campaignId=${campaignId}` }, req.headers).catch(() => {});
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, req.runId, req.featureSlug, req.brandId);
      const campaign = await duplicateCampaign(customer, campaignId, body.newName);

      traceEvent(req.runId!, { service: "google-service", event: "campaign-duplicate-done", detail: `newCampaignId=${campaign.id}` }, req.headers).catch(() => {});
      res.status(201).json({
        campaign,
        message: "Campaign duplicated successfully",
      });
    } catch (err) {
      const message = (err as Error).message;
      const statusCode = message === "Account not found" ? 404 : 500;
      if (req.runId) {
        traceEvent(req.runId, { service: "google-service", event: "campaign-duplicate-error", detail: message, level: "error" }, req.headers).catch(() => {});
      }
      res.status(statusCode).json({ error: message });
    }
  }
);

export default router;
