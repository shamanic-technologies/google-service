import { AccountDisconnectedError } from "../lib/account-disconnected";
import { listOrgGoogleAccounts } from "./google-tokens";
import { ingestGmailForAccount, type GmailIngestResult } from "./gmail-ingest";
import {
  ingestOtherPeopleForAccount,
  ingestPeopleForAccount,
  type PeopleIngestResult,
} from "./people-ingest";
import type { CallerContext } from "./key-service";

export interface SyncSummary {
  accounts: number;
  gmail: { inserted: number; updated: number; unchanged: number };
  contacts: { inserted: number; updated: number; unchanged: number; deleted: number };
}

// Core sync for a single org: fan out Gmail + People + otherContacts ingest across
// every connected Google account and accumulate a summary. Shared by the async
// HTTP sync job (POST /orgs/google/sync) and the periodic cron auto-sync.
export const syncOrg = async (
  orgId: string,
  caller: CallerContext,
  runId?: string,
  featureSlug?: string,
  brandId?: string
): Promise<SyncSummary> => {
  const accounts = await listOrgGoogleAccounts(orgId);
  const summary: SyncSummary = {
    accounts: accounts.length,
    gmail: { inserted: 0, updated: 0, unchanged: 0 },
    contacts: { inserted: 0, updated: 0, unchanged: 0, deleted: 0 },
  };

  for (const account of accounts) {
    let results: [GmailIngestResult, PeopleIngestResult, PeopleIngestResult];
    try {
      results = await Promise.all([
        ingestGmailForAccount(account, caller, runId ?? "", featureSlug, brandId),
        ingestPeopleForAccount(account, caller, runId ?? "", featureSlug, brandId),
        ingestOtherPeopleForAccount(account, caller, runId ?? "", featureSlug, brandId),
      ]);
    } catch (err) {
      // Disconnected mid-sync: its mirror is being purged, the other mailboxes
      // of the org still sync.
      if (!(err instanceof AccountDisconnectedError)) throw err;
      console.warn(
        `[google-service] sync skipped account ${account.id} (org=${orgId}): disconnected mid-sync`
      );
      continue;
    }
    const [gmailResult, peopleResult, otherPeopleResult] = results;
    summary.gmail.inserted += gmailResult.inserted;
    summary.gmail.updated += gmailResult.updated;
    summary.gmail.unchanged += gmailResult.unchanged;
    summary.contacts.inserted += peopleResult.inserted + otherPeopleResult.inserted;
    summary.contacts.updated += peopleResult.updated + otherPeopleResult.updated;
    summary.contacts.unchanged += peopleResult.unchanged + otherPeopleResult.unchanged;
    summary.contacts.deleted += peopleResult.deleted + otherPeopleResult.deleted;
  }

  return summary;
};
