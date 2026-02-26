import { Router, Request, Response } from "express";
import { query } from "../db/client";
import { validateQuery } from "../middleware/validate";
import { AccountsQuerySchema } from "../schemas";

const router = Router();

router.get(
  "/accounts",
  validateQuery(AccountsQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const { appId } = req.validatedQuery as { appId: string };

      const result = await query(
        `SELECT id, app_id, org_id, user_id, account_id, mcc_id, created_at
         FROM accounts
         WHERE app_id = $1
         ORDER BY created_at DESC`,
        [appId]
      );

      res.json({
        accounts: result.rows.map((row) => ({
          id: row.id,
          appId: row.app_id,
          orgId: row.org_id,
          userId: row.user_id,
          accountId: row.account_id,
          mccId: row.mcc_id,
          createdAt: row.created_at.toISOString(),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

export default router;
