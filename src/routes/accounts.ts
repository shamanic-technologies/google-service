import { Router, Request, Response } from "express";
import { query } from "../db/client";

const router = Router();

router.get(
  "/accounts",
  async (req: Request, res: Response) => {
    try {
      const result = await query(
        `SELECT id, org_id, user_id, account_id, mcc_id, created_at
         FROM accounts
         WHERE org_id = $1
         ORDER BY created_at DESC`,
        [req.orgId!]
      );

      res.json({
        accounts: result.rows.map((row) => ({
          id: row.id,
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
