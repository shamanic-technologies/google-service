import { query } from "../db/client";
import { env } from "../env";
import {
  createGoogleAdsClient,
  getCustomer,
  getCampaignSpendByDay,
} from "./google-ads";
import { getGoogleCredentials, getRefreshToken, CallerContext } from "./key-service";
import { addCosts, createRun, updateRun } from "./runs-service";

/**
 * Catalogue line in costs-service. PASS-THROUGH: the unit is ONE USD cent of
 * platform Google Ads spend, so the declared quantity is the number of cents
 * Google charged and there is no markup to apply here.
 */
export const GOOGLE_ADS_SPEND_COST_NAME = "google-ads-spend";

export interface SpendIngestSummary {
  accountId: string;
  /** Google-reported (campaign, day) pairs read in this pass. */
  daysRead: number;
  /** Rows whose observed spend exceeded what was already declared. */
  daysDeclared: number;
  /** Cents newly declared to runs-service in this pass. */
  centsDeclared: number;
}

export interface SpendAccount {
  orgId: string;
  userId: string;
  accountId: string;
}

/** micros → USD cents. 1 cent = 10 000 micros. */
export const microsToCents = (micros: string | number | bigint): number =>
  Math.round(Number(BigInt(String(micros))) / 10_000);

/** YYYY-MM-DD in UTC, `daysAgo` days before `now`. */
export const isoDay = (now: Date, daysAgo = 0): string => {
  const d = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
};

const SPEND_CALLER: CallerContext = { method: "CRON", path: "/cron/ads-spend" };

/**
 * One run per (org, Ads account, Google spend day). The idempotency key is
 * namespaced on that triple so a re-read of the same day — the normal case,
 * since the lookback window overlaps — reuses the SAME run instead of minting a
 * new one, and any later restatement lands as an extra cost item on the run
 * that already carries that day.
 */
const runForSpendDay = async (
  account: SpendAccount,
  spendDate: string
): Promise<string> =>
  createRun({
    orgId: account.orgId,
    userId: account.userId,
    service: "google",
    taskName: `google-ads-spend:${spendDate}`,
    idempotencyKey: `google-ads-spend:${account.orgId}:${account.accountId}:${spendDate}`,
  });

/**
 * Read what Google charged an account over the lookback window and declare the
 * undeclared part of it as that org's cost.
 *
 * - Spend is dated by GOOGLE's day (`segments.date`), never by our poll day.
 * - Money is already spent when we read it, so every cost is ACTUALISED; there
 *   is nothing to provision ahead of, and nothing to authorise against (an
 *   after-the-fact charge cannot be refused).
 * - Google restates a day's cost for a few days, so each pass declares only the
 *   DELTA over what was already declared for that (campaign, day).
 * - Fail loud: a (campaign, day) whose cost could not be declared keeps its old
 *   `declared_cents` and the error propagates. A spend figure we could not read
 *   or could not declare is never treated as zero.
 */
export const ingestSpendForAccount = async (
  account: SpendAccount,
  now: Date = new Date()
): Promise<SpendIngestSummary> => {
  const endDate = isoDay(now);
  const startDate = isoDay(now, env.GOOGLE_ADS_SPEND_LOOKBACK_DAYS - 1);

  const [refreshToken, creds] = await Promise.all([
    getRefreshToken(account.orgId, account.userId, account.accountId, SPEND_CALLER),
    getGoogleCredentials(SPEND_CALLER),
  ]);
  const customer = getCustomer(
    createGoogleAdsClient(creds),
    refreshToken,
    account.accountId,
    creds.mccAccountId
  );

  const rows = await getCampaignSpendByDay(customer, startDate, endDate);

  const summary: SpendIngestSummary = {
    accountId: account.accountId,
    daysRead: rows.length,
    daysDeclared: 0,
    centsDeclared: 0,
  };

  // One run per spend day, shared by every campaign that spent on that day.
  const runByDay = new Map<string, string>();

  for (const row of rows) {
    const observedCents = microsToCents(row.costMicros);

    const upserted = await query(
      `INSERT INTO google_ads_spend_daily
         (org_id, account_id, campaign_id, spend_date, cost_micros, observed_cents)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, account_id, campaign_id, spend_date) DO UPDATE
         SET cost_micros = EXCLUDED.cost_micros,
             observed_cents = EXCLUDED.observed_cents,
             last_seen_at = NOW()
       RETURNING id, declared_cents`,
      [
        account.orgId,
        account.accountId,
        row.campaignId,
        row.date,
        row.costMicros,
        observedCents,
      ]
    );

    const declaredCents = Number(upserted.rows[0].declared_cents);
    const delta = observedCents - declaredCents;

    if (delta === 0) continue;
    if (delta < 0) {
      // Google revised a day DOWN. Declared cost rows are not retroactively
      // rewritten, so leave declared_cents where it is and surface it instead
      // of silently under- or over-declaring.
      console.warn(
        `[google-service] ads-spend downward restatement org=${account.orgId} ` +
          `account=${account.accountId} campaign=${row.campaignId} date=${row.date}: ` +
          `observed=${observedCents}c declared=${declaredCents}c (kept declared)`
      );
      continue;
    }

    let runId = runByDay.get(row.date);
    if (!runId) {
      runId = await runForSpendDay(account, row.date);
      runByDay.set(row.date, runId);
    }

    await addCosts(
      runId,
      [
        {
          costName: GOOGLE_ADS_SPEND_COST_NAME,
          quantity: delta,
          costSource: "platform",
          // Per-run key: the campaign plus the running total it declares up to,
          // so a retry after a failed DB write cannot double-charge.
          idempotencyKey: `${row.campaignId}:${observedCents}`,
        },
      ],
      account.orgId,
      account.userId
    );

    await query(
      `UPDATE google_ads_spend_daily
         SET declared_cents = $1, run_id = $2, last_declared_at = NOW()
       WHERE id = $3`,
      [observedCents, runId, upserted.rows[0].id]
    );

    summary.daysDeclared += 1;
    summary.centsDeclared += delta;
  }

  for (const runId of runByDay.values()) {
    await updateRun(runId, "completed", account.orgId, account.userId).catch((err) =>
      console.error(
        `[google-service] failed to close ads-spend run ${runId}: ${(err as Error).message}`
      )
    );
  }

  return summary;
};

/** Every linked Google Ads account, across all orgs. */
export const listSpendAccounts = async (): Promise<SpendAccount[]> => {
  const res = await query(
    `SELECT org_id, user_id, account_id FROM accounts ORDER BY created_at ASC`
  );
  return res.rows.map((r) => ({
    orgId: r.org_id as string,
    userId: r.user_id as string,
    accountId: r.account_id as string,
  }));
};

/**
 * One spend-ingestion pass over every linked account. Accounts are isolated:
 * one account's failure never aborts the rest, and a failed account simply
 * keeps its previous declared_cents so the next pass re-declares the delta.
 */
export const runSpendIngestOnce = async (now: Date = new Date()): Promise<void> => {
  const accounts = await listSpendAccounts();
  console.log(`[google-service] ads-spend ingest starting for ${accounts.length} account(s)`);

  for (const account of accounts) {
    try {
      const summary = await ingestSpendForAccount(account, now);
      console.log(
        `[google-service] ads-spend org=${account.orgId} account=${account.accountId} ` +
          `read=${summary.daysRead} declared=${summary.daysDeclared} (+${summary.centsDeclared}c)`
      );
    } catch (err) {
      console.error(
        `[google-service] ads-spend ingest failed for account=${account.accountId}: ` +
          `${(err as Error).message}`
      );
    }
  }
};
