import { Router, Request, Response } from "express";
import { query } from "../db/client";
import { resolveCustomer } from "../services/customer-resolver";
import {
  listCampaigns,
  getCampaignDetail,
  getCampaignPerformance,
  listConversionActions,
  createCampaign,
  updateCampaign,
  duplicateCampaign,
  uploadClickConversions,
} from "../services/google-ads";
import {
  validateQuery,
  validateBody,
  validateParams,
} from "../middleware/validate";
import { traceEvent } from "../lib/trace-event";
import { z } from "zod";
import {
  CampaignsQuerySchema,
  AccountIdParamSchema,
  CampaignIdParamSchema,
  PerformanceQuerySchema,
  CreateCampaignBodySchema,
  UpdateCampaignBodySchema,
  DuplicateCampaignBodySchema,
  UploadConversionsBodySchema,
  SpendQuerySchema,
} from "../schemas";

const router = Router();

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
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, { runId: req.runId, featureSlug: req.featureSlug, brandId: req.brandId, audienceId: req.audienceId });
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
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, { runId: req.runId, featureSlug: req.featureSlug, brandId: req.brandId, audienceId: req.audienceId });
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

      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, { runId: req.runId, featureSlug: req.featureSlug, brandId: req.brandId, audienceId: req.audienceId });
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

      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, { runId: req.runId, featureSlug: req.featureSlug, brandId: req.brandId, audienceId: req.audienceId });
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
      const body = req.validatedBody as z.infer<typeof CreateCampaignBodySchema>;

      traceEvent(req.runId!, { service: "google-service", event: "campaign-create-start", detail: `accountId=${accountId}, name=${body.name}` }, req.headers).catch(() => {});
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, { runId: req.runId, featureSlug: req.featureSlug, brandId: req.brandId, audienceId: req.audienceId });
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
      const body = req.validatedBody as z.infer<typeof UpdateCampaignBodySchema>;

      traceEvent(req.runId!, { service: "google-service", event: "campaign-update-start", detail: `accountId=${accountId}, campaignId=${campaignId}` }, req.headers).catch(() => {});
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, { runId: req.runId, featureSlug: req.featureSlug, brandId: req.brandId, audienceId: req.audienceId });
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
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, { runId: req.runId, featureSlug: req.featureSlug, brandId: req.brandId, audienceId: req.audienceId });
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

// POST /accounts/:accountId/conversions/upload
// Sends a measured outcome (a paid client) back to Google as an offline click
// conversion, attributed to the click that produced it. Google's bidding can
// only optimise against conversions it has been told about.
router.post(
  "/accounts/:accountId/conversions/upload",
  validateParams(AccountIdParamSchema),
  validateBody(UploadConversionsBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.validatedParams as { accountId: string };
      const body = req.validatedBody as z.infer<typeof UploadConversionsBodySchema>;

      traceEvent(req.runId!, { service: "google-service", event: "conversions-upload-start", detail: `accountId=${accountId}, count=${body.conversions.length}` }, req.headers).catch(() => {});
      const customer = await resolveCustomer(req.orgId!, req.userId!, accountId, { method: req.method, path: req.route.path }, { runId: req.runId, featureSlug: req.featureSlug, brandId: req.brandId, audienceId: req.audienceId });
      const result = await uploadClickConversions(customer, body.conversions, {
        validateOnly: body.validateOnly,
      });

      traceEvent(req.runId!, { service: "google-service", event: "conversions-upload-done", detail: `accountId=${accountId}, uploaded=${result.uploaded}/${result.requested}` }, req.headers).catch(() => {});
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      const statusCode = message === "Account not found" ? 404 : 502;
      if (req.runId) {
        traceEvent(req.runId, { service: "google-service", event: "conversions-upload-error", detail: message, level: "error" }, req.headers).catch(() => {});
      }
      res.status(statusCode).json({ error: message });
    }
  }
);

// GET /accounts/:accountId/spend
// The declared-spend ledger, dated by GOOGLE's reporting day (spend_date), not
// by the day we polled. Written by the independent spend-ingest cron.
router.get(
  "/accounts/:accountId/spend",
  validateParams(AccountIdParamSchema),
  validateQuery(SpendQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId } = req.validatedParams as { accountId: string };
      const { startDate, endDate } = req.validatedQuery as {
        startDate?: string;
        endDate?: string;
      };

      const conditions = ["org_id = $1", "account_id = $2"];
      const params: unknown[] = [req.orgId!, accountId];
      if (startDate) {
        params.push(startDate);
        conditions.push(`spend_date >= $${params.length}`);
      }
      if (endDate) {
        params.push(endDate);
        conditions.push(`spend_date <= $${params.length}`);
      }

      const result = await query(
        `SELECT campaign_id, spend_date, cost_micros, observed_cents, declared_cents,
                run_id, last_seen_at, last_declared_at
           FROM google_ads_spend_daily
          WHERE ${conditions.join(" AND ")}
          ORDER BY spend_date DESC, campaign_id ASC`,
        params
      );

      res.json({
        accountId,
        days: result.rows.map((row) => ({
          campaignId: row.campaign_id as string,
          date: new Date(row.spend_date as string | Date).toISOString().slice(0, 10),
          costMicros: String(row.cost_micros),
          observedCents: Number(row.observed_cents),
          declaredCents: Number(row.declared_cents),
          runId: (row.run_id as string | null) ?? null,
          lastSeenAt: new Date(row.last_seen_at as string | Date).toISOString(),
          lastDeclaredAt: row.last_declared_at
            ? new Date(row.last_declared_at as string | Date).toISOString()
            : null,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

export default router;
