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
    req.orgId!,
    req.userId!,
    { method: req.method, path: req.route?.path ?? req.path },
    req.runId
  );
};

router.post(
  "/search/web",
  validateBody(WebSearchBodySchema),
  async (req: Request, res: Response) => {
    try {
      const apiKey = await resolveSerperKey(req);
      const body = req.validatedBody as z.infer<typeof WebSearchBodySchema>;
      const results = await searchWeb(body, apiKey);
      res.json({ results });
    } catch (err) {
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
      const apiKey = await resolveSerperKey(req);
      const body = req.validatedBody as z.infer<typeof NewsSearchBodySchema>;
      const results = await searchNews(body, apiKey);
      res.json({ results });
    } catch (err) {
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
      const apiKey = await resolveSerperKey(req);
      const body = req.validatedBody as z.infer<typeof BatchSearchBodySchema>;
      const results = await Promise.all(
        body.queries.map(async ({ query, type, num, gl, hl }) => {
          const searchResults =
            type === "web"
              ? await searchWeb({ query, num, gl, hl }, apiKey)
              : await searchNews({ query, num, gl, hl }, apiKey);
          return { query, type, results: searchResults };
        })
      );
      res.json({ results });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }
);

export default router;
