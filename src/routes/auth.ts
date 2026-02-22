import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { query } from "../db/client";
import { env } from "../env";
import { storeRefreshToken } from "../services/key-service";
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
      const { appId, redirectUri } = req.validatedQuery as { appId: string; redirectUri?: string };
      const state = uuidv4();

      const callbackUri =
        redirectUri || `${req.protocol}://${req.get("host")}/auth/callback`;

      await query(
        `INSERT INTO oauth_states (state, app_id, redirect_uri) VALUES ($1, $2, $3)`,
        [state, appId, callbackUri]
      );

      const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
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
        `SELECT app_id, redirect_uri FROM oauth_states
         WHERE state = $1 AND expires_at > NOW()`,
        [state]
      );

      if (stateResult.rows.length === 0) {
        res.status(400).json({ error: "Invalid or expired OAuth state" });
        return;
      }

      const { app_id: appId, redirect_uri: redirectUri } = stateResult.rows[0];

      await query(`DELETE FROM oauth_states WHERE state = $1`, [state]);

      const tokens = await exchangeCodeForTokens(code, redirectUri);

      const client = createGoogleAdsClient();
      const accounts = await listAccessibleAccounts(client, tokens.refresh_token);

      if (accounts.length === 0) {
        res.status(400).json({ error: "No accessible Google Ads accounts found" });
        return;
      }

      for (const account of accounts) {
        await storeRefreshToken(appId, account.id, tokens.refresh_token);

        await query(
          `INSERT INTO accounts (app_id, account_id, refresh_token_provider, mcc_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (app_id, account_id) DO UPDATE
           SET refresh_token_provider = $3, mcc_id = $4`,
          [appId, account.id, `google-ads-refresh-${account.id}`, env.GOOGLE_MCC_ACCOUNT_ID]
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
