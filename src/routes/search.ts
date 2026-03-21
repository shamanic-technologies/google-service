import { Router, Request, Response } from "express";
import { validateBody } from "../middleware/validate";
import {
  WebSearchBodySchema,
  NewsSearchBodySchema,
  BatchSearchBodySchema,
} from "../schemas";
import { searchWeb, searchNews } from "../services/serper";
import { z } from "zod";

const router = Router();

router.post(
  "/search/web",
  validateBody(WebSearchBodySchema),
  async (req: Request, res: Response) => {
    try {
      const body = req.validatedBody as z.infer<typeof WebSearchBodySchema>;
      const results = await searchWeb(body);
      res.json({ results });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }
);

router.post(
  "/search/news",
  validateBody(NewsSearchBodySchema),
  async (req: Request, res: Response) => {
    try {
      const body = req.validatedBody as z.infer<typeof NewsSearchBodySchema>;
      const results = await searchNews(body);
      res.json({ results });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }
);

router.post(
  "/search/batch",
  validateBody(BatchSearchBodySchema),
  async (req: Request, res: Response) => {
    try {
      const body = req.validatedBody as z.infer<typeof BatchSearchBodySchema>;
      const results = await Promise.all(
        body.queries.map(async ({ query, type, num, gl, hl }) => {
          const searchResults =
            type === "web"
              ? await searchWeb({ query, num, gl, hl })
              : await searchNews({ query, num, gl, hl });
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
