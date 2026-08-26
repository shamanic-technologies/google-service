/**
 * Everything below the campaign, plus the managed advertiser account and the
 * live bidding switch.
 *
 * A Google rejection — including a policy refusal — surfaces to the caller as a
 * 502 carrying Google's own message. Nothing is swallowed and nothing is
 * retried behind the caller's back.
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import { query } from "../db/client";
import { resolveCustomer, resolveManagerCustomer } from "../services/customer-resolver";
import { updateCampaign } from "../services/google-ads";
import {
  createAdGroup,
  listAdGroups,
  updateAdGroup,
  addKeywords,
  listKeywords,
  updateKeywordStatus,
  removeKeyword,
  addAdGroupNegativeKeywords,
  addCampaignNegativeKeywords,
  listCampaignNegativeKeywords,
  removeCampaignNegativeKeyword,
  createResponsiveSearchAd,
  listResponsiveSearchAds,
  updateAdStatus,
  removeAd,
  getCampaignServingState,
  getCampaignStructure,
  createManagedClientAccount,
} from "../services/google-ads-serving";
import { validateBody, validateParams } from "../middleware/validate";
import { traceEvent } from "../lib/trace-event";
import {
  AccountIdParamSchema,
  CampaignIdParamSchema,
  AdGroupIdParamSchema,
  AdGroupCriterionParamSchema,
  AdGroupAdParamSchema,
  CampaignCriterionParamSchema,
  CreateAdGroupBodySchema,
  UpdateAdGroupBodySchema,
  AddKeywordsBodySchema,
  AddNegativeKeywordsBodySchema,
  UpdateKeywordBodySchema,
  CreateResponsiveSearchAdBodySchema,
  UpdateAdBodySchema,
  UpdateBiddingBodySchema,
  CreateManagedAccountBodySchema,
} from "../schemas";

const router = Router();

const tracking = (req: Request) => ({
  runId: req.runId,
  featureSlug: req.featureSlug,
  brandId: req.brandId,
  audienceId: req.audienceId,
});

const caller = (req: Request) => ({ method: req.method, path: req.route.path });

const customerFor = (req: Request, accountId: string) =>
  resolveCustomer(req.orgId!, req.userId!, accountId, caller(req), tracking(req));

/**
 * "Account not found" is the org boundary (404). Everything else that reaches
 * here came back from Google, so it is a 502 with Google's own message — a
 * rejection or a policy refusal must be loud, never a silent partial success.
 */
const fail = (req: Request, res: Response, err: unknown, event: string) => {
  const message = (err as Error).message;
  const statusCode = message === "Account not found" ? 404 : 502;
  if (req.runId) {
    traceEvent(
      req.runId,
      { service: "google-service", event, detail: message, level: "error" },
      req.headers
    ).catch(() => {});
  }
  res.status(statusCode).json({ error: message });
};

// ─── Ad groups ───

router.post(
  "/accounts/:accountId/campaigns/:campaignId/ad-groups",
  validateParams(CampaignIdParamSchema),
  validateBody(CreateAdGroupBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };
      const body = req.validatedBody as z.infer<typeof CreateAdGroupBodySchema>;

      const customer = await customerFor(req, accountId);
      const adGroup = await createAdGroup(customer, campaignId, body);

      traceEvent(req.runId!, { service: "google-service", event: "ad-group-create-done", detail: `campaignId=${campaignId}, adGroupId=${adGroup.id}` }, req.headers).catch(() => {});
      res.status(201).json({ adGroup });
    } catch (err) {
      fail(req, res, err, "ad-group-create-error");
    }
  }
);

router.get(
  "/accounts/:accountId/campaigns/:campaignId/ad-groups",
  validateParams(CampaignIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };
      const customer = await customerFor(req, accountId);
      res.json({ adGroups: await listAdGroups(customer, campaignId) });
    } catch (err) {
      fail(req, res, err, "ad-group-list-error");
    }
  }
);

router.patch(
  "/accounts/:accountId/ad-groups/:adGroupId",
  validateParams(AdGroupIdParamSchema),
  validateBody(UpdateAdGroupBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
      };
      const body = req.validatedBody as z.infer<typeof UpdateAdGroupBodySchema>;

      const customer = await customerFor(req, accountId);
      await updateAdGroup(customer, adGroupId, body);
      const [adGroup] = await listAdGroups(customer).then((groups) =>
        groups.filter((g) => g.id === adGroupId)
      );
      res.json({ adGroup: adGroup ?? null });
    } catch (err) {
      fail(req, res, err, "ad-group-update-error");
    }
  }
);

// ─── Keywords ───

router.post(
  "/accounts/:accountId/ad-groups/:adGroupId/keywords",
  validateParams(AdGroupIdParamSchema),
  validateBody(AddKeywordsBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
      };
      const body = req.validatedBody as z.infer<typeof AddKeywordsBodySchema>;

      const customer = await customerFor(req, accountId);
      const keywords = await addKeywords(customer, adGroupId, body.keywords);

      traceEvent(req.runId!, { service: "google-service", event: "keywords-add-done", detail: `adGroupId=${adGroupId}, count=${keywords.length}` }, req.headers).catch(() => {});
      res.status(201).json({ keywords });
    } catch (err) {
      fail(req, res, err, "keywords-add-error");
    }
  }
);

router.get(
  "/accounts/:accountId/ad-groups/:adGroupId/keywords",
  validateParams(AdGroupIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
      };
      const customer = await customerFor(req, accountId);
      res.json({ keywords: await listKeywords(customer, { adGroupId }) });
    } catch (err) {
      fail(req, res, err, "keywords-list-error");
    }
  }
);

router.patch(
  "/accounts/:accountId/ad-groups/:adGroupId/keywords/:criterionId",
  validateParams(AdGroupCriterionParamSchema),
  validateBody(UpdateKeywordBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId, criterionId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
        criterionId: string;
      };
      const body = req.validatedBody as z.infer<typeof UpdateKeywordBodySchema>;

      const customer = await customerFor(req, accountId);
      await updateKeywordStatus(customer, adGroupId, criterionId, body.status);
      res.json({ criterionId, status: body.status });
    } catch (err) {
      fail(req, res, err, "keyword-update-error");
    }
  }
);

router.delete(
  "/accounts/:accountId/ad-groups/:adGroupId/keywords/:criterionId",
  validateParams(AdGroupCriterionParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId, criterionId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
        criterionId: string;
      };
      const customer = await customerFor(req, accountId);
      await removeKeyword(customer, adGroupId, criterionId);
      res.json({ criterionId, removed: true });
    } catch (err) {
      fail(req, res, err, "keyword-remove-error");
    }
  }
);

// ─── Negative keywords (what the campaign must never bid on) ───

router.post(
  "/accounts/:accountId/ad-groups/:adGroupId/negative-keywords",
  validateParams(AdGroupIdParamSchema),
  validateBody(AddNegativeKeywordsBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
      };
      const body = req.validatedBody as z.infer<typeof AddNegativeKeywordsBodySchema>;

      const customer = await customerFor(req, accountId);
      const keywords = await addAdGroupNegativeKeywords(customer, adGroupId, body.keywords);
      res.status(201).json({ keywords });
    } catch (err) {
      fail(req, res, err, "ad-group-negatives-add-error");
    }
  }
);

router.get(
  "/accounts/:accountId/ad-groups/:adGroupId/negative-keywords",
  validateParams(AdGroupIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
      };
      const customer = await customerFor(req, accountId);
      res.json({ keywords: await listKeywords(customer, { adGroupId, negative: true }) });
    } catch (err) {
      fail(req, res, err, "ad-group-negatives-list-error");
    }
  }
);

router.post(
  "/accounts/:accountId/campaigns/:campaignId/negative-keywords",
  validateParams(CampaignIdParamSchema),
  validateBody(AddNegativeKeywordsBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };
      const body = req.validatedBody as z.infer<typeof AddNegativeKeywordsBodySchema>;

      const customer = await customerFor(req, accountId);
      const keywords = await addCampaignNegativeKeywords(customer, campaignId, body.keywords);
      res.status(201).json({ keywords });
    } catch (err) {
      fail(req, res, err, "campaign-negatives-add-error");
    }
  }
);

router.get(
  "/accounts/:accountId/campaigns/:campaignId/negative-keywords",
  validateParams(CampaignIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };
      const customer = await customerFor(req, accountId);
      res.json({ keywords: await listCampaignNegativeKeywords(customer, campaignId) });
    } catch (err) {
      fail(req, res, err, "campaign-negatives-list-error");
    }
  }
);

router.delete(
  "/accounts/:accountId/campaigns/:campaignId/negative-keywords/:criterionId",
  validateParams(CampaignCriterionParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId, criterionId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
        criterionId: string;
      };
      const customer = await customerFor(req, accountId);
      await removeCampaignNegativeKeyword(customer, campaignId, criterionId);
      res.json({ criterionId, removed: true });
    } catch (err) {
      fail(req, res, err, "campaign-negatives-remove-error");
    }
  }
);

// ─── Responsive search ads ───

router.post(
  "/accounts/:accountId/ad-groups/:adGroupId/ads",
  validateParams(AdGroupIdParamSchema),
  validateBody(CreateResponsiveSearchAdBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
      };
      const body = req.validatedBody as z.infer<typeof CreateResponsiveSearchAdBodySchema>;

      const customer = await customerFor(req, accountId);
      const ad = await createResponsiveSearchAd(customer, adGroupId, body);

      traceEvent(req.runId!, { service: "google-service", event: "ad-create-done", detail: `adGroupId=${adGroupId}, adId=${ad.adId}, headlines=${body.headlines.length}, descriptions=${body.descriptions.length}` }, req.headers).catch(() => {});
      res.status(201).json({ ad: { ...ad, adGroupId } });
    } catch (err) {
      fail(req, res, err, "ad-create-error");
    }
  }
);

router.get(
  "/accounts/:accountId/ad-groups/:adGroupId/ads",
  validateParams(AdGroupIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
      };
      const customer = await customerFor(req, accountId);
      res.json({ ads: await listResponsiveSearchAds(customer, { adGroupId }) });
    } catch (err) {
      fail(req, res, err, "ad-list-error");
    }
  }
);

router.patch(
  "/accounts/:accountId/ad-groups/:adGroupId/ads/:adId",
  validateParams(AdGroupAdParamSchema),
  validateBody(UpdateAdBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId, adId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
        adId: string;
      };
      const body = req.validatedBody as z.infer<typeof UpdateAdBodySchema>;

      const customer = await customerFor(req, accountId);
      await updateAdStatus(customer, adGroupId, adId, body.status);
      res.json({ adId, status: body.status });
    } catch (err) {
      fail(req, res, err, "ad-update-error");
    }
  }
);

router.delete(
  "/accounts/:accountId/ad-groups/:adGroupId/ads/:adId",
  validateParams(AdGroupAdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, adGroupId, adId } = req.validatedParams as {
        accountId: string;
        adGroupId: string;
        adId: string;
      };
      const customer = await customerFor(req, accountId);
      await removeAd(customer, adGroupId, adId);
      res.json({ adId, removed: true });
    } catch (err) {
      fail(req, res, err, "ad-remove-error");
    }
  }
);

// ─── Bidding: change the approach on a LIVE campaign, no recreation ───

router.put(
  "/accounts/:accountId/campaigns/:campaignId/bidding",
  validateParams(CampaignIdParamSchema),
  validateBody(UpdateBiddingBodySchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };
      const body = req.validatedBody as z.infer<typeof UpdateBiddingBodySchema>;

      const customer = await customerFor(req, accountId);
      const campaign = await updateCampaign(customer, campaignId, { bidding: body.bidding });

      traceEvent(req.runId!, { service: "google-service", event: "campaign-bidding-change-done", detail: `campaignId=${campaignId}, type=${body.bidding.type}` }, req.headers).catch(() => {});
      res.json({ campaign, biddingStrategy: body.bidding.type });
    } catch (err) {
      fail(req, res, err, "campaign-bidding-change-error");
    }
  }
);

// ─── Readback: what already exists for this campaign ───

router.get(
  "/accounts/:accountId/campaigns/:campaignId/structure",
  validateParams(CampaignIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };
      const customer = await customerFor(req, accountId);
      res.json(await getCampaignStructure(customer, campaignId));
    } catch (err) {
      fail(req, res, err, "campaign-structure-error");
    }
  }
);

// Google's own verdict on whether this campaign can serve.
router.get(
  "/accounts/:accountId/campaigns/:campaignId/serving-state",
  validateParams(CampaignIdParamSchema),
  async (req: Request, res: Response) => {
    try {
      const { accountId, campaignId } = req.validatedParams as {
        accountId: string;
        campaignId: string;
      };
      const customer = await customerFor(req, accountId);
      const serving = await getCampaignServingState(customer, campaignId);
      if (!serving) {
        res.status(404).json({ error: "Campaign not found" });
        return;
      }
      res.json(serving);
    } catch (err) {
      fail(req, res, err, "campaign-serving-state-error");
    }
  }
);

// ─── Managed advertiser accounts (client supplies no Google credential) ───

const managedAccountRow = (row: Record<string, unknown>) => ({
  accountId: String(row.account_id),
  orgId: String(row.org_id),
  brandId: (row.brand_id as string | null) ?? null,
  managerAccountId: String(row.manager_account_id),
  descriptiveName: String(row.descriptive_name),
  currencyCode: String(row.currency_code),
  timeZone: String(row.time_zone),
  createdAt: new Date(row.created_at as string | Date).toISOString(),
});

router.post(
  "/orgs/google-ads/managed-accounts",
  validateBody(CreateManagedAccountBodySchema),
  async (req: Request, res: Response) => {
    try {
      const body = req.validatedBody as z.infer<typeof CreateManagedAccountBodySchema>;

      // Idempotent per brand: a second run for the same brand gets the account
      // that already exists rather than a second one under our manager.
      if (body.brandId) {
        const existing = await query(
          `SELECT * FROM google_ads_managed_accounts WHERE org_id = $1 AND brand_id = $2`,
          [req.orgId!, body.brandId]
        );
        if (existing.rows.length > 0) {
          res.status(200).json({ account: managedAccountRow(existing.rows[0]), created: false });
          return;
        }
      }

      const { customer, managerAccountId } = await resolveManagerCustomer(
        caller(req),
        tracking(req)
      );
      const created = await createManagedClientAccount(customer, managerAccountId, body);

      const inserted = await query(
        `INSERT INTO google_ads_managed_accounts
           (org_id, brand_id, account_id, manager_account_id, descriptive_name, currency_code, time_zone)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          req.orgId!,
          body.brandId ?? null,
          created.accountId,
          managerAccountId,
          body.descriptiveName,
          body.currencyCode,
          body.timeZone,
        ]
      );

      traceEvent(req.runId!, { service: "google-service", event: "managed-account-create-done", detail: `accountId=${created.accountId}` }, req.headers).catch(() => {});
      res.status(201).json({ account: managedAccountRow(inserted.rows[0]), created: true });
    } catch (err) {
      fail(req, res, err, "managed-account-create-error");
    }
  }
);

router.get("/orgs/google-ads/managed-accounts", async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT * FROM google_ads_managed_accounts WHERE org_id = $1 ORDER BY created_at DESC`,
      [req.orgId!]
    );
    res.json({ accounts: result.rows.map(managedAccountRow) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
