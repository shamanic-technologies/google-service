import { Router, Request, Response, NextFunction } from "express";
import { validateQuery } from "../middleware/validate";
import { ConnectorIntakeQuerySchema } from "../schemas";
import { getConnectorIntake } from "../services/connector-health";

const router = Router();

// ─── GET /internal/connector-intake (GMAIL-SYNC-STALL-1128) ───
//
// Staff, service-to-service: every Google connection (Gmail mailbox, Calendar,
// Search Console), when it was last read, why it fails, and the records per
// day. Consumer: crm-service's connector intake (Monitoring > Connected tools).
router.get(
  "/internal/connector-intake",
  validateQuery(ConnectorIntakeQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.validatedQuery as { days?: number };
      res.json(await getConnectorIntake(q.days ?? 30));
    } catch (err) {
      next(err);
    }
  }
);

export default router;
