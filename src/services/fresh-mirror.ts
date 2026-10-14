import { ingestGmailForAccount } from "./gmail-ingest";
import { AccountDisconnectedError } from "../lib/account-disconnected";
import { listOrgGoogleAccounts } from "./google-tokens";
import type { CallerContext } from "./key-service";

// A read asked to be FRESH (`fresh=true`) must see mail the org's mailboxes sent
// or received seconds ago (RIGHT-MOMENT-OR-LATER-1014): every AI writer reads the
// person's thread right before writing and must hold back when the owner just
// answered by hand. The periodic fresh pass runs every 15 minutes, so the mirror
// alone can be that stale. This brings ONE org's mailboxes up to date with the
// same Gmail history delta the periodic pass runs, before the mirror is read.
//
// Coalescing: concurrent fresh reads for the same org share one refresh, and a
// refresh that STARTED at most FRESH_MAX_AGE_MS before a read began satisfies it
// (it already saw everything Google held when it started). A refresh that
// started earlier than that is never reused: the read waits for it to settle and
// then starts its own.
export const FRESH_MAX_AGE_MS = 5_000;

export class FreshMirrorError extends Error {
  constructor(
    message: string,
    readonly reason: "gmail_refresh_failed" | "gmail_mirror_not_caught_up"
  ) {
    super(message);
    this.name = "FreshMirrorError";
  }
}

interface Refresh {
  startedAt: number;
  promise: Promise<void>;
}

const inflight = new Map<string, Refresh>();
const lastSuccessStartedAt = new Map<string, number>();

// One delta per caught-up mailbox of the org. A mailbox without Gmail is skipped
// (there is nothing in it to miss). A mailbox with no historyId has never
// finished its first sync: its mirror is incomplete, so a fresh read cannot be
// vouched for and fails rather than answering from a partial mirror. A backfill
// is never started from a read.
const refreshOrg = async (orgId: string, caller: CallerContext, runId: string): Promise<void> => {
  const accounts = await listOrgGoogleAccounts(orgId);
  const failures: string[] = [];
  let notCaughtUp = false;
  await Promise.all(
    accounts.map(async (account) => {
      if (account.gmailUnavailableAt) return;
      if (!account.gmailHistoryId) {
        notCaughtUp = true;
        failures.push(`${account.googleAccountEmail}: first sync not finished`);
        return;
      }
      try {
        await ingestGmailForAccount(account, caller, runId, undefined, undefined);
      } catch (err) {
        // Disconnected while refreshing: the mailbox left, nothing to vouch for.
        if (err instanceof AccountDisconnectedError) return;
        failures.push(`${account.googleAccountEmail}: ${(err as Error).message}`);
      }
    })
  );
  if (failures.length > 0) {
    throw new FreshMirrorError(
      `Gmail mirror could not be brought up to date: ${failures.join("; ")}`,
      notCaughtUp && failures.length === 1 ? "gmail_mirror_not_caught_up" : "gmail_refresh_failed"
    );
  }
};

const startRefresh = (orgId: string, caller: CallerContext, runId: string): Refresh => {
  const startedAt = Date.now();
  const promise = refreshOrg(orgId, caller, runId).then(() => {
    const prev = lastSuccessStartedAt.get(orgId) ?? 0;
    if (startedAt > prev) lastSuccessStartedAt.set(orgId, startedAt);
  });
  const refresh: Refresh = { startedAt, promise };
  inflight.set(orgId, refresh);
  // Clear the slot once settled (whatever the outcome), unless replaced.
  void promise
    .catch(() => undefined)
    .finally(() => {
      if (inflight.get(orgId) === refresh) inflight.delete(orgId);
    });
  return refresh;
};

// Bring the org's Gmail mirror up to date as of (about) now. Throws a
// FreshMirrorError when any mailbox could not be refreshed: the caller must
// answer an error, never the stale mirror as if it were complete.
export const ensureFreshGmailMirror = async (
  orgId: string,
  caller: CallerContext,
  runId: string
): Promise<void> => {
  const requestedAt = Date.now();
  const floor = requestedAt - FRESH_MAX_AGE_MS;
  for (;;) {
    if ((lastSuccessStartedAt.get(orgId) ?? 0) >= floor) return;
    const current = inflight.get(orgId);
    if (current && current.startedAt >= floor) {
      try {
        await current.promise;
        return;
      } catch (err) {
        if (err instanceof FreshMirrorError) throw err;
        throw new FreshMirrorError(
          `Gmail mirror could not be brought up to date: ${(err as Error).message}`,
          "gmail_refresh_failed"
        );
      }
    }
    if (current) {
      // Too old to vouch for this read: let it settle, then start our own.
      await current.promise.catch(() => undefined);
      continue;
    }
    startRefresh(orgId, caller, runId);
  }
};

// Test hook.
export const resetFreshMirrorState = (): void => {
  inflight.clear();
  lastSuccessStartedAt.clear();
};
