import { query } from "../db/client";
import { env } from "../env";
import {
  GoogleApiError,
  getGmailMessage,
  getGmailProfile,
  listGmailHistory,
  listGmailMessages,
  withTokenRetry,
} from "./google-api";
import {
  createAccessTokenProvider,
  updateGmailHistoryId,
  type AccessTokenProvider,
  type GoogleAccountToken,
} from "./google-tokens";
import type { CallerContext } from "./key-service";
import type { GmailMessage } from "./google-api";
import { parseMessageSilver, upsertMessageSilver } from "./silver";

export interface GmailIngestResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

const upsertMessage = async (
  orgId: string,
  googleAccountId: string,
  message: { id: string; threadId: string; historyId: string; payload: unknown }
): Promise<"inserted" | "updated" | "unchanged"> => {
  const result = await query(
    `INSERT INTO gmail_messages_raw
        (org_id, google_account_id, gmail_message_id, thread_id, history_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id, gmail_message_id) DO UPDATE SET
        history_id = EXCLUDED.history_id,
        thread_id = EXCLUDED.thread_id,
        payload = EXCLUDED.payload,
        fetched_at = NOW()
     WHERE gmail_messages_raw.history_id IS DISTINCT FROM EXCLUDED.history_id
     RETURNING id, (xmax = 0) AS inserted`,
    [
      orgId,
      googleAccountId,
      message.id,
      message.threadId,
      message.historyId,
      message.payload,
    ]
  );

  if (result.rows.length === 0) {
    return "unchanged";
  }

  // Silver projection: parse the bronze payload into typed columns. Only on an
  // inserted/updated bronze row — an unchanged row already has correct silver.
  const bronzeRowId = result.rows[0].id as string;
  await upsertMessageSilver(
    orgId,
    googleAccountId,
    bronzeRowId,
    message.id,
    message.threadId,
    parseMessageSilver(message.payload as GmailMessage)
  );

  return result.rows[0].inserted ? "inserted" : "updated";
};

export const ingestGmailForAccount = async (
  account: GoogleAccountToken,
  caller: CallerContext,
  runId: string,
  featureSlug: string | undefined,
  brandId: string | undefined
): Promise<GmailIngestResult> => {
  const provider = createAccessTokenProvider(account, caller, runId, featureSlug, brandId);
  const result: GmailIngestResult = { inserted: 0, updated: 0, unchanged: 0 };

  const profile = await withTokenRetry(provider, (t) => getGmailProfile(t));
  const latestHistoryId = profile.historyId;

  if (account.gmailHistoryId) {
    await ingestDelta(account, provider, result);
  } else {
    await ingestBackfill(account, provider, result);
  }

  // Persist the pre-loop historyId so the NEXT sync runs a cheap delta instead
  // of a full backfill. Captured before the loop so any message that arrives
  // during a long backfill is still covered by the next delta (idempotent
  // re-fetch at worst). Only reached when the loop completes without throwing.
  await updateGmailHistoryId(account.orgId, account.id, latestHistoryId);
  return result;
};

const ingestBackfill = async (
  account: GoogleAccountToken,
  provider: AccessTokenProvider,
  result: GmailIngestResult
): Promise<void> => {
  const after = Math.floor(
    (Date.now() - env.GOOGLE_GMAIL_BACKFILL_DAYS * 24 * 60 * 60 * 1000) / 1000
  );
  const q = `after:${after}`;

  // Resumability: a full backfill of a large mailbox may be interrupted (Railway
  // restart) before it completes and persists gmail_history_id. Load the ids we
  // already stored so a resumed run skips the expensive per-message getMessage
  // fetch for everything already ingested — the loop converges instead of
  // re-scanning the whole mailbox from zero on every run.
  const existing = await query(
    `SELECT gmail_message_id FROM gmail_messages_raw
       WHERE org_id = $1 AND google_account_id = $2`,
    [account.orgId, account.id]
  );
  const alreadyStored = new Set<string>(
    existing.rows.map((r) => r.gmail_message_id as string)
  );

  let pageToken: string | undefined;
  do {
    const page = await withTokenRetry(provider, (t) =>
      listGmailMessages(t, { q, pageToken, maxResults: 100 })
    );
    pageToken = page.nextPageToken;
    if (!page.messages) continue;
    for (const ref of page.messages) {
      if (alreadyStored.has(ref.id)) {
        result.unchanged += 1;
        continue;
      }
      const full = await withTokenRetry(provider, (t) => getGmailMessage(t, ref.id));
      const outcome = await upsertMessage(account.orgId, account.id, {
        id: full.id,
        threadId: full.threadId,
        historyId: full.historyId,
        payload: full,
      });
      result[outcome] += 1;
      alreadyStored.add(ref.id);
    }
  } while (pageToken);
};

const ingestDelta = async (
  account: GoogleAccountToken,
  provider: AccessTokenProvider,
  result: GmailIngestResult
): Promise<void> => {
  let pageToken: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await withTokenRetry(provider, (t) =>
      listGmailHistory(t, {
        startHistoryId: account.gmailHistoryId!,
        pageToken,
      })
    );
    pageToken = page.nextPageToken;
    if (!page.history) continue;
    for (const item of page.history) {
      const refs = item.messagesAdded ?? [];
      for (const wrap of refs) {
        if (seen.has(wrap.message.id)) continue;
        seen.add(wrap.message.id);
        try {
          const full = await withTokenRetry(provider, (t) =>
            getGmailMessage(t, wrap.message.id)
          );
          const outcome = await upsertMessage(account.orgId, account.id, {
            id: full.id,
            threadId: full.threadId,
            historyId: full.historyId,
            payload: full,
          });
          result[outcome] += 1;
        } catch (err) {
          if (err instanceof GoogleApiError && err.status === 404) continue;
          throw err;
        }
      }
    }
  } while (pageToken);
};
