import { query } from "../db/client";
import { env } from "../env";
import {
  getGmailMessage,
  getGmailProfile,
  listGmailHistory,
  listGmailMessages,
} from "./google-api";
import {
  ensureFreshAccessToken,
  updateGmailHistoryId,
  type GoogleAccountToken,
} from "./google-tokens";
import type { CallerContext } from "./key-service";

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
     RETURNING (xmax = 0) AS inserted`,
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
  return result.rows[0].inserted ? "inserted" : "updated";
};

export const ingestGmailForAccount = async (
  account: GoogleAccountToken,
  caller: CallerContext,
  runId: string,
  featureSlug: string | undefined,
  brandId: string | undefined
): Promise<GmailIngestResult> => {
  const accessToken = await ensureFreshAccessToken(account, caller, runId, featureSlug, brandId);
  const result: GmailIngestResult = { inserted: 0, updated: 0, unchanged: 0 };

  const profile = await getGmailProfile(accessToken);
  const latestHistoryId = profile.historyId;

  if (account.gmailHistoryId) {
    await ingestDelta(account, accessToken, result);
  } else {
    await ingestBackfill(account, accessToken, result);
  }

  await updateGmailHistoryId(account.orgId, account.id, latestHistoryId);
  return result;
};

const ingestBackfill = async (
  account: GoogleAccountToken,
  accessToken: string,
  result: GmailIngestResult
): Promise<void> => {
  const after = Math.floor(
    (Date.now() - env.GOOGLE_GMAIL_BACKFILL_DAYS * 24 * 60 * 60 * 1000) / 1000
  );
  const q = `after:${after}`;

  let pageToken: string | undefined;
  do {
    const page = await listGmailMessages(accessToken, { q, pageToken, maxResults: 100 });
    pageToken = page.nextPageToken;
    if (!page.messages) continue;
    for (const ref of page.messages) {
      const full = await getGmailMessage(accessToken, ref.id);
      const outcome = await upsertMessage(account.orgId, account.id, {
        id: full.id,
        threadId: full.threadId,
        historyId: full.historyId,
        payload: full,
      });
      result[outcome] += 1;
    }
  } while (pageToken);
};

const ingestDelta = async (
  account: GoogleAccountToken,
  accessToken: string,
  result: GmailIngestResult
): Promise<void> => {
  let pageToken: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await listGmailHistory(accessToken, {
      startHistoryId: account.gmailHistoryId!,
      pageToken,
    });
    pageToken = page.nextPageToken;
    if (!page.history) continue;
    for (const item of page.history) {
      const refs = item.messagesAdded ?? [];
      for (const wrap of refs) {
        if (seen.has(wrap.message.id)) continue;
        seen.add(wrap.message.id);
        try {
          const full = await getGmailMessage(accessToken, wrap.message.id);
          const outcome = await upsertMessage(account.orgId, account.id, {
            id: full.id,
            threadId: full.threadId,
            historyId: full.historyId,
            payload: full,
          });
          result[outcome] += 1;
        } catch (err) {
          if ((err as Error).message.includes("404")) continue;
          throw err;
        }
      }
    }
  } while (pageToken);
};
