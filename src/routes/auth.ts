import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { query } from "../db/client";
import { storeRefreshToken, getGoogleCredentials } from "../services/key-service";
import {
  exchangeCodeForTokens,
  createGoogleAdsClient,
  listAccessibleAccounts,
} from "../services/google-ads";
import { validateQuery } from "../middleware/validate";
import { AuthUrlQuerySchema, AuthCallbackQuerySchema } from "../schemas";

const router = Router();

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = "https://www.googleapis.com/auth/adwords";

router.get(
  "/auth/url",
  validateQuery(AuthUrlQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const { redirectUri } = req.validatedQuery as { redirectUri?: string };
      const orgId = req.orgId!;
      const userId = req.userId!;
      const state = uuidv4();

      const callbackUri =
        redirectUri || `${req.protocol}://${req.get("host")}/auth/callback`;

      const creds = await getGoogleCredentials({ method: req.method, path: req.route.path }, req.runId);

      await query(
        `INSERT INTO oauth_states (state, org_id, user_id, redirect_uri) VALUES ($1, $2, $3, $4)`,
        [state, orgId, userId, callbackUri]
      );

      const params = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: callbackUri,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
        state,
      });

      res.json({ url: `${GOOGLE_AUTH_URL}?${params.toString()}` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

router.get(
  "/auth/callback",
  validateQuery(AuthCallbackQuerySchema),
  async (req: Request, res: Response) => {
    try {
      const { code, state } = req.validatedQuery as {
        code: string;
        state: string;
      };

      const stateResult = await query(
        `SELECT org_id, user_id, redirect_uri FROM oauth_states
         WHERE state = $1 AND expires_at > NOW()`,
        [state]
      );

      if (stateResult.rows.length === 0) {
        res.status(400).json({ error: "Invalid or expired OAuth state" });
        return;
      }

      const { org_id: orgId, user_id: userId, redirect_uri: redirectUri } = stateResult.rows[0];

      await query(`DELETE FROM oauth_states WHERE state = $1`, [state]);

      const creds = await getGoogleCredentials({ method: req.method, path: req.route.path }, req.runId);
      const tokens = await exchangeCodeForTokens(code, redirectUri, creds);

      const client = createGoogleAdsClient(creds);
      const accounts = await listAccessibleAccounts(client, tokens.refresh_token, creds.mccAccountId);

      if (accounts.length === 0) {
        res.status(400).json({ error: "No accessible Google Ads accounts found" });
        return;
      }

      for (const account of accounts) {
        await storeRefreshToken(orgId, account.id, tokens.refresh_token, req.runId);

        await query(
          `INSERT INTO accounts (org_id, user_id, account_id, refresh_token_provider, mcc_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (org_id, account_id) DO UPDATE
           SET refresh_token_provider = $4, mcc_id = $5, user_id = $2`,
          [orgId, userId, account.id, `google-ads-refresh-${account.id}`, creds.mccAccountId]
        );
      }

      res.json({
        success: true,
        accountId: accounts[0].id,
        message: `Successfully linked ${accounts.length} account(s)`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }
);

export default router;
