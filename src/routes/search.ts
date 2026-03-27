import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import {
  WebSearchBodySchema,
  NewsSearchBodySchema,
  BatchSearchBodySchema,
} from "../schemas";
import { searchWeb, searchNews } from "../services/serper";
import { getSerperApiKey, SerperKeyResult } from "../services/key-service";
import { authorizeCredits } from "../services/billing-client";
import { addCosts } from "../services/runs-service";
import { z } from "zod";

const router = Router();

const SERPER_COST_NAME = "serper-dev-search-query";

const resolveSerperKey = async (req: Request): Promise<SerperKeyResult> => {
  return getSerperApiKey(
    req.orgId!,
    req.userId!,
    { method: req.method, path: req.route?.path ?? req.path },
    req.runId,
    req.featureSlug
  );
};

const authorizeBilling = async (
  req: Request,
  quantity: number,
  description: string
): Promise<void> => {
  const result = await authorizeCredits(
    [{ costName: SERPER_COST_NAME, quantity }],
    description,
    req.orgId!,
    req.userId!,
    req.runId,
    req.featureSlug
  );
  if (!result.sufficient) {
    throw Object.assign(
      new Error(`Insufficient credits: need ${result.required_cents}¢, have ${result.balance_cents}¢`),
      { statusCode: 402 }
    );
  }
};

const reportCosts = (
  req: Request,
  quantity: number,
  costSource: "platform" | "org"
): void => {
  if (!req.runId || quantity === 0) return;
  addCosts(
    req.runId,
    [{ costName: SERPER_COST_NAME, quantity, costSource }],
    req.orgId!,
    req.userId!,
    req.featureSlug
  ).catch((err) => {
    console.error(`[google-service] Failed to report costs for run ${req.runId}:`, err);
  });
};

router.post(
  "/search/web",
  validateBody(WebSearchBodySchema),
  async (req: Request, res: Response) => {
    try {
      console.log(`[google-service] /search/web resolving Serper key orgId=${req.orgId}`);
      const { key: apiKey, keySource } = await resolveSerperKey(req);

      if (keySource === "app") {
        await authorizeBilling(req, 1, "serper-web-search");
      }

      const body = req.validatedBody as z.infer<typeof WebSearchBodySchema>;
      console.log(`[google-service] /search/web query="${body.query}" num=${body.num ?? 10}`);
      const results = await searchWeb(body, apiKey);
      console.log(`[google-service] /search/web returned ${results.length} results`);

      reportCosts(req, 1, keySource === "app" ? "platform" : "org");

      res.json({ results });
    } catch (err) {
      console.error(`[google-service] /search/web error:`, err);
      const error = err as Error & { statusCode?: number };
      res.status(error.statusCode ?? 502).json({ error: error.message });
    }
  }
);

router.post(
  "/search/news",
  validateBody(NewsSearchBodySchema),
  async (req: Request, res: Response) => {
    try {
      console.log(`[google-service] /search/news resolving Serper key orgId=${req.orgId}`);
      const { key: apiKey, keySource } = await resolveSerperKey(req);

      if (keySource === "app") {
        await authorizeBilling(req, 1, "serper-news-search");
      }

      const body = req.validatedBody as z.infer<typeof NewsSearchBodySchema>;
      console.log(`[google-service] /search/news query="${body.query}" num=${body.num ?? 10}`);
      const results = await searchNews(body, apiKey);
      console.log(`[google-service] /search/news returned ${results.length} results`);

      reportCosts(req, 1, keySource === "app" ? "platform" : "org");

      res.json({ results });
    } catch (err) {
      console.error(`[google-service] /search/news error:`, err);
      const error = err as Error & { statusCode?: number };
      res.status(error.statusCode ?? 502).json({ error: error.message });
    }
  }
);

router.post(
  "/search/batch",
  validateBody(BatchSearchBodySchema),
  async (req: Request, res: Response) => {
    try {
      console.log(`[google-service] /search/batch resolving Serper key orgId=${req.orgId}`);
      const { key: apiKey, keySource } = await resolveSerperKey(req);
      const body = req.validatedBody as z.infer<typeof BatchSearchBodySchema>;
      const queryCount = body.queries.length;

      if (keySource === "app") {
        await authorizeBilling(req, queryCount, `serper-batch-search x${queryCount}`);
      }

      console.log(`[google-service] /search/batch ${queryCount} queries`);
      const results = await Promise.all(
        body.queries.map(async ({ query, type, num, gl, hl }, i) => {
          console.log(`[google-service] /search/batch [${i + 1}/${queryCount}] type=${type} query="${query}"`);
          const searchResults =
            type === "web"
              ? await searchWeb({ query, num, gl, hl }, apiKey)
              : await searchNews({ query, num, gl, hl }, apiKey);
          console.log(`[google-service] /search/batch [${i + 1}/${queryCount}] returned ${searchResults.length} results`);
          return { query, type, results: searchResults };
        })
      );
      console.log(`[google-service] /search/batch completed all ${results.length} queries`);

      reportCosts(req, queryCount, keySource === "app" ? "platform" : "org");

      res.json({ results });
    } catch (err) {
      console.error(`[google-service] /search/batch error:`, err);
      const error = err as Error & { statusCode?: number };
      res.status(error.statusCode ?? 502).json({ error: error.message });
    }
  }
);

export default router;
