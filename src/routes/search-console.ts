import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db/client";
import { apiKeyAuth } from "../middleware/api-key-auth";
import { validateParams, validateQuery } from "../middleware/validate";
import { traceEvent } from "../lib/trace-event";
import { GoogleAccountEmailParamSchema, SearchConsoleClicksQuerySchema } from "../schemas";
import { revokeGoogleToken, type RevokeOutcome } from "../services/google-oauth";
import { listOrgClickDays, listOrgSearchConsoleAccounts } from "../services/search-console";

// Google Search Console connection (GSC-CONNECTOR-1108). Connect = POST
// /orgs/google/auth/start with connection=search_console.
const router = Router();

router.use(apiKeyAuth);

// ─── GET /orgs/google/search-console/accounts ───
// The org's connected Search Console accounts, each with its properties: which
// brand each one counts for, or why it does not count.
router.get("/orgs/google/search-console/accounts", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ accounts: await listOrgSearchConsoleAccounts(req.orgId!) });
  } catch (err) {
    next(err);
  }
});

// ─── GET /orgs/google/search-console/clicks ───
// Declared "Google search click" Units per property x Google day (the same
// figures runs-service holds), optional brandId / since / until.
router.get(
  "/orgs/google/search-console/clicks",
  validateQuery(SearchConsoleClicksQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.validatedQuery as { brandId?: string; since?: string; until?: string };
      const days = await listOrgClickDays(req.orgId!, q);
      res.json({
        outcomeKey: "google_search_click",
        days,
        totalClicks: days.reduce((n, d) => n + d.clicks, 0),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── DELETE /orgs/google/search-console/accounts/:email ───
// Stops reading the account. Clicks already counted stay counted (they
// happened); the properties stay known so a reconnect never counts a day twice.
// The Google grant is revoked unless the same Google account is also connected
// as a mailbox or a calendar (a revoke kills every token of the grant).
router.delete(
  "/orgs/google/search-console/accounts/:email",
  validateParams(GoogleAccountEmailParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orgId = req.orgId!;
      const { email } = req.validatedParams as { email: string };
      const found = await query(
        `SELECT id, google_account_email, refresh_token FROM google_search_console_accounts
          WHERE org_id = $1 AND lower(google_account_email) = lower($2)`,
        [orgId, email]
      );
      if (found.rows.length === 0) {
        res.status(404).json({
          error: `No connected Google Search Console account ${email} for this org`,
          reason: "search_console_not_found",
        });
        return;
      }
      const row = found.rows[0] as { id: string; google_account_email: string; refresh_token: string };

      const shared = await query(
        `SELECT 1 FROM google_oauth_tokens
          WHERE lower(google_account_email) = lower($1) AND disconnected_at IS NULL
         UNION ALL
         SELECT 1 FROM google_calendar_accounts WHERE lower(google_account_email) = lower($1)
         LIMIT 1`,
        [row.google_account_email]
      );

      let grant: RevokeOutcome | "kept_for_other_connection" = "kept_for_other_connection";
      if (shared.rows.length === 0) {
        try {
          grant = await revokeGoogleToken(row.refresh_token);
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          res.status(502).json({
            error: `Google did not confirm the revoke of ${row.google_account_email}: ${message}. Search Console is still connected; retry the disconnect.`,
            reason: "google_revoke_failed",
          });
          return;
        }
      }

      await query(
        `UPDATE google_search_console_properties SET status = 'disconnected', updated_at = NOW()
          WHERE org_id = $1 AND account_id = $2`,
        [orgId, row.id]
      );
      await query(`DELETE FROM google_search_console_accounts WHERE org_id = $1 AND id = $2`, [orgId, row.id]);

      traceEvent(
        req.runId!,
        {
          service: "google-service",
          event: "google-search-console-disconnected",
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

export default router;
