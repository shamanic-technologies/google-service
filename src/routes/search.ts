import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import {
  WebSearchBodySchema,
  NewsSearchBodySchema,
  BatchSearchBodySchema,
} from "../schemas";
import { searchWeb, searchNews } from "../services/serper";
import { getSerperApiKey } from "../services/key-service";
import { z } from "zod";

const router = Router();

const resolveSerperKey = async (req: Request): Promise<string> => {
  return getSerperApiKey(
    { method: req.method, path: req.route?.path ?? req.path },
    req.runId,
    req.featureSlug
  );
};

router.post(
  "/search/web",
  validateBody(WebSearchBodySchema),
  async (req: Request, res: Response) => {
    try {
      console.log(`[google-service] /search/web resolving Serper key orgId=${req.orgId}`);
      const apiKey = await resolveSerperKey(req);
      const body = req.validatedBody as z.infer<typeof WebSearchBodySchema>;
      console.log(`[google-service] /search/web query="${body.query}" num=${body.num ?? 10}`);
      const results = await searchWeb(body, apiKey);
      console.log(`[google-service] /search/web returned ${results.length} results`);
      res.json({ results });
    } catch (err) {
      console.error(`[google-service] /search/web error:`, err);
      const msg = (err as Error).message;
      const status = msg.includes("Failed to get Serper API key") ? 502 : 502;
      res.status(status).json({ error: msg });
    }
  }
);

router.post(
  "/search/news",
  validateBody(NewsSearchBodySchema),
  async (req: Request, res: Response) => {
    try {
      console.log(`[google-service] /search/news resolving Serper key orgId=${req.orgId}`);
      const apiKey = await resolveSerperKey(req);
      const body = req.validatedBody as z.infer<typeof NewsSearchBodySchema>;
      console.log(`[google-service] /search/news query="${body.query}" num=${body.num ?? 10}`);
      const results = await searchNews(body, apiKey);
      console.log(`[google-service] /search/news returned ${results.length} results`);
      res.json({ results });
    } catch (err) {
      console.error(`[google-service] /search/news error:`, err);
      const msg = (err as Error).message;
      res.status(502).json({ error: msg });
    }
  }
);

router.post(
  "/search/batch",
  validateBody(BatchSearchBodySchema),
  async (req: Request, res: Response) => {
    try {
      console.log(`[google-service] /search/batch resolving Serper key orgId=${req.orgId}`);
      const apiKey = await resolveSerperKey(req);
      const body = req.validatedBody as z.infer<typeof BatchSearchBodySchema>;
      console.log(`[google-service] /search/batch ${body.queries.length} queries`);
      const results = await Promise.all(
        body.queries.map(async ({ query, type, num, gl, hl }, i) => {
          console.log(`[google-service] /search/batch [${i + 1}/${body.queries.length}] type=${type} query="${query}"`);
          const searchResults =
            type === "web"
              ? await searchWeb({ query, num, gl, hl }, apiKey)
              : await searchNews({ query, num, gl, hl }, apiKey);
          console.log(`[google-service] /search/batch [${i + 1}/${body.queries.length}] returned ${searchResults.length} results`);
          return { query, type, results: searchResults };
        })
      );
      console.log(`[google-service] /search/batch completed all ${results.length} queries`);
      res.json({ results });
    } catch (err) {
      console.error(`[google-service] /search/batch error:`, err);
      res.status(502).json({ error: (err as Error).message });
    }
  }
);

export default router;
