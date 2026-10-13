import { Router, Request, Response, NextFunction } from "express";
import { apiKeyAuth } from "../middleware/api-key-auth";
import { validateBody, validateQuery } from "../middleware/validate";
import { GoogleConversationQuerySchema, StaffAddressedMessagesBodySchema } from "../schemas";
import { getStaffConversation } from "../services/conversation";
import {
  getAddressedMessages,
  AddressedMessagesInputError,
  type AddressedMessagesInput,
} from "../services/addressed-messages";

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

// ─── POST /internal/staff-mailboxes/addressed-messages ───
//
// Every message in the STAFF Gmail mirrors sent TO (To/Cc) or FROM one of the
// requested sending addresses / domains (see addressed-messages.ts). Exists to
// recover prospect replies that a mailbox-level forward drained into staff Gmail.
// Keyset-paged: pass back nextCursor until it is null.
//
//   400                                    — no filter, a staff address/domain, bad cursor
//   404 reason=no_staff_mailbox_connected  — no staff mailbox is mirrored at all
//   200 {mailboxes, messages, nextCursor}  — a page (possibly empty)
router.post(
  "/internal/staff-mailboxes/addressed-messages",
  validateBody(StaffAddressedMessagesBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getAddressedMessages(req.validatedBody as AddressedMessagesInput);
      if (!result.found) {
        res.locals.documentedAnswer = true;
        res.status(404).json({ error: "No staff mailbox is mirrored", reason: result.reason });
        return;
      }
      res.json(result.page);
    } catch (err) {
      if (err instanceof AddressedMessagesInputError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

export default router;
