import { query } from "../db/client";
import { getGoogleOAuthClient, type CallerContext } from "./key-service";
import { refreshAccessToken } from "./google-oauth";

export interface GoogleAccountToken {
  id: string;
  orgId: string;
  userId: string;
  googleAccountEmail: string;
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string;
  gmailHistoryId: string | null;
  peopleSyncToken: string | null;
}

const ACCESS_TOKEN_LEEWAY_MS = 60_000;

export const listOrgGoogleAccounts = async (
  orgId: string
): Promise<GoogleAccountToken[]> => {
  const result = await query(
    `SELECT id, org_id, user_id, google_account_email, refresh_token,
            access_token, access_token_expires_at, scopes,
            gmail_history_id, people_sync_token
       FROM google_oauth_tokens
       WHERE org_id = $1
       ORDER BY created_at ASC`,
    [orgId]
  );
  return result.rows.map(rowToToken);
};

export const getGoogleAccountById = async (
  orgId: string,
  id: string
): Promise<GoogleAccountToken | null> => {
  const result = await query(
    `SELECT id, org_id, user_id, google_account_email, refresh_token,
            access_token, access_token_expires_at, scopes,
            gmail_history_id, people_sync_token
       FROM google_oauth_tokens
       WHERE org_id = $1 AND id = $2`,
    [orgId, id]
  );
  if (result.rows.length === 0) return null;
  return rowToToken(result.rows[0]);
};

const rowToToken = (row: Record<string, unknown>): GoogleAccountToken => ({
  id: row.id as string,
  orgId: row.org_id as string,
  userId: row.user_id as string,
  googleAccountEmail: row.google_account_email as string,
  refreshToken: row.refresh_token as string,
  accessToken: (row.access_token as string | null) ?? null,
  accessTokenExpiresAt: (row.access_token_expires_at as Date | null) ?? null,
  scopes: row.scopes as string,
  gmailHistoryId: row.gmail_history_id == null ? null : String(row.gmail_history_id),
  peopleSyncToken: (row.people_sync_token as string | null) ?? null,
});

export const upsertGoogleToken = async (params: {
  orgId: string;
  userId: string;
  googleAccountEmail: string;
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  scopes: string;
  featureSlug?: string;
  brandId?: string;
}): Promise<GoogleAccountToken> => {
  const result = await query(
    `INSERT INTO google_oauth_tokens
        (org_id, user_id, google_account_email, refresh_token, access_token,
         access_token_expires_at, scopes, feature_slug, brand_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id, google_account_email) DO UPDATE SET
        refresh_token = EXCLUDED.refresh_token,
        access_token = EXCLUDED.access_token,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        scopes = EXCLUDED.scopes,
        feature_slug = EXCLUDED.feature_slug,
        brand_id = EXCLUDED.brand_id,
        user_id = EXCLUDED.user_id,
        updated_at = NOW()
     RETURNING id, org_id, user_id, google_account_email, refresh_token,
               access_token, access_token_expires_at, scopes,
               gmail_history_id, people_sync_token`,
    [
      params.orgId,
      params.userId,
      params.googleAccountEmail,
      params.refreshToken,
      params.accessToken,
      params.accessTokenExpiresAt,
      params.scopes,
      params.featureSlug ?? null,
      params.brandId ?? null,
    ]
  );
  return rowToToken(result.rows[0]);
};

export const updateGmailHistoryId = async (
  orgId: string,
  id: string,
  historyId: string
): Promise<void> => {
  await query(
    `UPDATE google_oauth_tokens
       SET gmail_history_id = $3, updated_at = NOW()
       WHERE org_id = $1 AND id = $2`,
    [orgId, id, historyId]
  );
};

export const updatePeopleSyncToken = async (
  orgId: string,
  id: string,
  syncToken: string
): Promise<void> => {
  await query(
    `UPDATE google_oauth_tokens
       SET people_sync_token = $3, updated_at = NOW()
       WHERE org_id = $1 AND id = $2`,
    [orgId, id, syncToken]
  );
};

export const updateAccessToken = async (
  orgId: string,
  id: string,
  accessToken: string,
  expiresAt: Date
): Promise<void> => {
  await query(
    `UPDATE google_oauth_tokens
       SET access_token = $3, access_token_expires_at = $4, updated_at = NOW()
       WHERE org_id = $1 AND id = $2`,
    [orgId, id, accessToken, expiresAt]
  );
};

export const ensureFreshAccessToken = async (
  account: GoogleAccountToken,
  caller: CallerContext,
  runId?: string,
  featureSlug?: string,
  brandId?: string
): Promise<string> => {
  if (
    account.accessToken &&
    account.accessTokenExpiresAt &&
    account.accessTokenExpiresAt.getTime() - Date.now() > ACCESS_TOKEN_LEEWAY_MS
  ) {
    return account.accessToken;
  }

  const oauth = await getGoogleOAuthClient(caller, runId, featureSlug, brandId);
  const refreshed = await refreshAccessToken({
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
    refreshToken: account.refreshToken,
  });
  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
  await updateAccessToken(account.orgId, account.id, refreshed.access_token, expiresAt);
  return refreshed.access_token;
};
