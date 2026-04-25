import { Router, Request, Response } from "express";
import { apiKeyAuth } from "../middleware/api-key-auth";
import { validateBody } from "../middleware/validate";
import { TransferBrandBodySchema } from "../schemas";

const router = Router();

router.post(
  "/internal/transfer-brand",
  apiKeyAuth,
  validateBody(TransferBrandBodySchema),
  (_req: Request, res: Response) => {
    // Google Ads accounts are org-level OAuth connections, not brand-scoped.
    // The accounts table has no brand_id column, so there is nothing to transfer.
    res.json({ updatedTables: [] });
  }
);

export default router;
