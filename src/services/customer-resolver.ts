/**
 * Which Google Ads customer a request acts as, and with whose credential.
 *
 * Two paths, both driven from OUR manager account (login_customer_id is always
 * the MCC):
 *
 *   managed  — the account was created by us under our manager account. The
 *              client supplies NO Google credential; we use the manager's own
 *              refresh token. This is the product path.
 *   per-org  — the org connected its own Google account long ago and we hold a
 *              per-org refresh token for it. Kept working, and it WINS when a
 *              row exists, so nothing that works today changes.
 */
import { query } from "../db/client";
import {
  getGoogleCredentials,
  getRefreshToken,
  getManagerRefreshToken,
  type CallerContext,
} from "./key-service";
import { createGoogleAdsClient, getCustomer, type GoogleAdsCustomer } from "./google-ads";

export interface Tracking {
  runId?: string;
  featureSlug?: string;
  brandId?: string;
  audienceId?: string;
}

export type AdvertiserPath = "managed" | "per-org";

export const resolveAdvertiserPath = async (
  orgId: string,
  accountId: string
): Promise<AdvertiserPath | null> => {
  const connected = await query(
    `SELECT 1 FROM accounts WHERE org_id = $1 AND account_id = $2`,
    [orgId, accountId]
  );
  if (connected.rows.length > 0) return "per-org";

  const managed = await query(
    `SELECT 1 FROM google_ads_managed_accounts WHERE org_id = $1 AND account_id = $2`,
    [orgId, accountId]
  );
  if (managed.rows.length > 0) return "managed";

  return null;
};

/**
 * Resolves the Google Ads customer for an account this org is allowed to act
 * on. Throws "Account not found" (surfaced as 404) when the org owns neither a
 * connected nor a managed account with that id — an org may never drive an
 * account it does not own.
 */
export const resolveCustomer = async (
  orgId: string,
  userId: string,
  accountId: string,
  caller: CallerContext,
  tracking: Tracking = {}
): Promise<GoogleAdsCustomer> => {
  const { runId, featureSlug, brandId, audienceId } = tracking;

  const path = await resolveAdvertiserPath(orgId, accountId);
  if (!path) throw new Error("Account not found");

  const creds = await getGoogleCredentials(caller, runId, featureSlug, brandId, audienceId);
  const refreshToken =
    path === "per-org"
      ? await getRefreshToken(orgId, userId, accountId, caller, runId, featureSlug, brandId, audienceId)
      : await getManagerRefreshToken(caller, runId, featureSlug, brandId, audienceId);

  const client = createGoogleAdsClient(creds);
  return getCustomer(client, refreshToken, accountId, creds.mccAccountId);
};

/**
 * The manager account itself — used to create client accounts under it. Always
 * the platform credential; there is no per-org variant of this.
 */
export const resolveManagerCustomer = async (
  caller: CallerContext,
  tracking: Tracking = {}
): Promise<{ customer: GoogleAdsCustomer; managerAccountId: string }> => {
  const { runId, featureSlug, brandId, audienceId } = tracking;
  const [creds, refreshToken] = await Promise.all([
    getGoogleCredentials(caller, runId, featureSlug, brandId, audienceId),
    getManagerRefreshToken(caller, runId, featureSlug, brandId, audienceId),
  ]);
  const client = createGoogleAdsClient(creds);
  return {
    customer: getCustomer(client, refreshToken, creds.mccAccountId, creds.mccAccountId),
    managerAccountId: creds.mccAccountId,
  };
};
