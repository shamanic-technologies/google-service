import { listOrgGoogleAccounts } from "./google-tokens";
import { ingestGmailForAccount } from "./gmail-ingest";
import {
  ingestOtherPeopleForAccount,
  ingestPeopleForAccount,
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
    const [gmailResult, peopleResult, otherPeopleResult] = await Promise.all([
      ingestGmailForAccount(account, caller, runId ?? "", featureSlug, brandId),
      ingestPeopleForAccount(account, caller, runId ?? "", featureSlug, brandId),
      ingestOtherPeopleForAccount(account, caller, runId ?? "", featureSlug, brandId),
    ]);
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
