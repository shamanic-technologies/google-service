import { Router, Request, Response, NextFunction } from "express";
import { apiKeyAuth } from "../middleware/api-key-auth";
import { validateQuery } from "../middleware/validate";
import { GoogleConversationQuerySchema } from "../schemas";
import { getStaffConversation } from "../services/conversation";

const router = Router();

router.use(apiKeyAuth);

// ─── GET /internal/staff-mailboxes/conversation ───
//
// The exchange between one person and our STAFF, out of the staff's own Gmail
// mirrors (see getStaffConversation). Internal: service-to-service only, never
// proxied by the gateway — the caller (lead-service) decides which org may see it.
//
//   404 reason=no_staff_mailbox_connected — no staff mailbox is mirrored at all
//   404 reason=no_messages                — staff never exchanged with this address
//   200 status=ok|partial|unreadable      — same contract as /orgs/google/conversation
router.get(
  "/internal/staff-mailboxes/conversation",
  validateQuery(GoogleConversationQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.validatedQuery as { email: string; limit?: number };
      const result = await getStaffConversation(q.email, q.limit);

      if (!result.found) {
        res.locals.documentedAnswer = true;
        res.status(404).json({
          error:
            result.reason === "no_staff_mailbox_connected"
              ? "No staff mailbox is mirrored"
              : "No exchange between staff and this address in the Gmail mirror",
          reason: result.reason,
        });
        return;
      }

      res.json(result.conversation);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
