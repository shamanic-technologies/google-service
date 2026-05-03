import { query } from "../db/client";
import { listPeopleConnections, type PersonResource } from "./google-api";
import {
  ensureFreshAccessToken,
  updatePeopleSyncToken,
  type GoogleAccountToken,
} from "./google-tokens";
import type { CallerContext } from "./key-service";

export interface PeopleIngestResult {
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
}

const upsertContact = async (
  orgId: string,
  googleAccountId: string,
  person: PersonResource
): Promise<"inserted" | "updated" | "unchanged"> => {
  const result = await query(
    `INSERT INTO google_contacts_raw
        (org_id, google_account_id, resource_name, etag, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, resource_name) DO UPDATE SET
        etag = EXCLUDED.etag,
        payload = EXCLUDED.payload,
        fetched_at = NOW()
     WHERE google_contacts_raw.etag IS DISTINCT FROM EXCLUDED.etag
     RETURNING (xmax = 0) AS inserted`,
    [
      orgId,
      googleAccountId,
      person.resourceName,
      person.etag ?? null,
      person,
    ]
  );

  if (result.rows.length === 0) {
    return "unchanged";
  }
  return result.rows[0].inserted ? "inserted" : "updated";
};

const deleteContact = async (
  orgId: string,
  resourceName: string
): Promise<boolean> => {
  const result = await query(
    `DELETE FROM google_contacts_raw WHERE org_id = $1 AND resource_name = $2`,
    [orgId, resourceName]
  );
  return (result.rowCount ?? 0) > 0;
};

const isDeleted = (person: PersonResource): boolean => {
  const meta = person.metadata as { deleted?: boolean } | undefined;
  return Boolean(meta?.deleted);
};

export const ingestPeopleForAccount = async (
  account: GoogleAccountToken,
  caller: CallerContext,
  runId: string,
  featureSlug: string | undefined,
  brandId: string | undefined
): Promise<PeopleIngestResult> => {
  const accessToken = await ensureFreshAccessToken(account, caller, runId, featureSlug, brandId);
  const result: PeopleIngestResult = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };

  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  const useSyncToken = !!account.peopleSyncToken;

  do {
    const page = await listPeopleConnections(accessToken, {
      pageToken,
      syncToken: useSyncToken && !pageToken ? account.peopleSyncToken! : undefined,
      pageSize: 1000,
      requestSyncToken: !pageToken,
    });

    pageToken = page.nextPageToken;
    if (page.nextSyncToken) {
      nextSyncToken = page.nextSyncToken;
    }

    if (page.connections) {
      for (const person of page.connections) {
        if (isDeleted(person)) {
          if (await deleteContact(account.orgId, person.resourceName)) {
            result.deleted += 1;
          }
          continue;
        }
        const outcome = await upsertContact(account.orgId, account.id, person);
        result[outcome] += 1;
      }
    }
  } while (pageToken);

  if (nextSyncToken) {
    await updatePeopleSyncToken(account.orgId, account.id, nextSyncToken);
  }

  return result;
};
