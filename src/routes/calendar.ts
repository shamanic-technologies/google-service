import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db/client";
import { apiKeyAuth } from "../middleware/api-key-auth";
import { validateParams, validateQuery } from "../middleware/validate";
import { traceEvent } from "../lib/trace-event";
import { CalendarEventChangesQuerySchema, GoogleAccountEmailParamSchema } from "../schemas";
import { revokeGoogleToken, type RevokeOutcome } from "../services/google-oauth";
import {
  CalendarCursorError,
  listCalendarEventChanges,
  listOrgCalendarAccounts,
} from "../services/calendar";

const router = Router();

router.use(apiKeyAuth);

// ─── GET /orgs/google/calendar/accounts ───
//
// The org's connected Google Calendars and their health. Connect = POST
// /orgs/google/auth/start with connection=calendar.
router.get(
  "/orgs/google/calendar/accounts",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ calendars: await listOrgCalendarAccounts(req.orgId!) });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /orgs/google/calendar/accounts/:email ───
//
// Stops reading one calendar and deletes what we mirrored of it (a few hundred
// events at most, deleted in the request by cascade). The Google grant is
// revoked, EXCEPT when the same Google account is also connected as a mailbox
// (any org): a revoke kills every token of the grant, so it would silently cut
// the mailbox too. A revoke failure keeps the calendar connected (502, retry).
router.delete(
  "/orgs/google/calendar/accounts/:email",
  validateParams(GoogleAccountEmailParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.orgId!;
      const { email } = req.validatedParams as { email: string };
      const found = await query(
        `SELECT id, google_account_email, refresh_token FROM google_calendar_accounts
          WHERE org_id = $1 AND lower(google_account_email) = lower($2)`,
        [orgId, email]
      );
      if (found.rows.length === 0) {
        res.status(404).json({
          error: `No connected Google Calendar ${email} for this org`,
          reason: "calendar_not_found",
        });
        return;
      }
      const row = found.rows[0] as { id: string; google_account_email: string; refresh_token: string };

      const mailbox = await query(
        `SELECT 1 FROM google_oauth_tokens
          WHERE lower(google_account_email) = lower($1) AND disconnected_at IS NULL
          LIMIT 1`,
        [row.google_account_email]
      );

      let grant: RevokeOutcome | "kept_for_mailbox" = "kept_for_mailbox";
      if (mailbox.rows.length === 0) {
        try {
          grant = await revokeGoogleToken(row.refresh_token);
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          console.error(`[google-service] calendar disconnect FAILED org=${orgId} account=${row.id}: ${message}`);
          res.status(502).json({
            error: `Google did not confirm the revoke of ${row.google_account_email}: ${message}. The calendar is still connected; retry the disconnect.`,
            reason: "google_revoke_failed",
          });
          return;
        }
      }

      await query(`DELETE FROM google_calendar_accounts WHERE org_id = $1 AND id = $2`, [orgId, row.id]);

      traceEvent(
        req.runId!,
        {
          service: "google-service",
          event: "google-calendar-disconnected",
          detail: `email=${row.google_account_email} grant=${grant}`,
        },
        req.headers
      ).catch(() => {});

      res.json({ disconnected: true, email: row.google_account_email, grant });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /internal/calendar/events ───
//
// Changes feed over every connected calendar, every org: each event whose
// served fields changed after the cursor (new booking, reschedule, cancel, Meet
// attendance read). Internal: the consumer (crm-service) turns events into
// meeting facts for the brand's leads. Keep the last nextCursor and come back.
router.get(
  "/internal/calendar/events",
  validateQuery(CalendarEventChangesQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.validatedQuery as { cursor?: string; limit?: number };
      res.json(await listCalendarEventChanges(q));
    } catch (err) {
      if (err instanceof CalendarCursorError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  }
);

export default router;
