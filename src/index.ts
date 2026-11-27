import { createApp } from "./app";
import { env } from "./env";
import { runMigrations } from "./db/migrate";
import { backfillSilver } from "./services/backfill-silver";
import { startAutoSync, startCalendarSync, startGmailFreshSync, startSearchConsoleSync } from "./services/cron-sync";
import { startSpendSync } from "./services/spend-cron";
import { startThreadReplyOutcomes } from "./services/thread-reply-outcomes";
import { resumePendingPurges } from "./services/account-purge";
import { ensurePhraseSearchIndex } from "./services/search-index";
import { assertEncryptionKey } from "./lib/token-crypto";
import { encryptStoredTokens } from "./services/encrypt-tokens-at-rest";

const main = async () => {
  // Google OAuth tokens are encrypted at rest (GOOGLE-TOKENS-AT-REST-1127): no
  // key = no deploy, never a service that 500s on every sync.
  assertEncryptionKey();
  await runMigrations();
  // Rows written before encryption-at-write are encrypted in place (tiny N).
  const atRest = await encryptStoredTokens();
  console.log("[google-service] tokens encrypted at rest:", JSON.stringify(atRest.encrypted));

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    console.log(`[google-service] listening on port ${env.PORT}`);
  });

  // Post-listen (never in the boot window): backfill silver from existing bronze
  // and schedule the periodic auto-sync. Both are fire-and-forget so a slow/large
  // backfill never blocks serving.
  backfillSilver().catch((err) =>
    console.error("[google-service] silver backfill failed:", err)
  );
  // Mailboxes disconnected before a restart finish deleting their mirror.
  resumePendingPurges().catch((err) =>
    console.error("[google-service] resuming disconnected mailbox purges failed:", err)
  );
  // Trigram index for the phrase search; the search answers without it (slower).
  ensurePhraseSearchIndex().catch((err) =>
    console.error("[google-service] phrase search index build failed:", err)
  );
  startAutoSync();
  // Gmail-only deltas every ~15 min so the mirror sees an answer we just sent.
  startGmailFreshSync();
  // Connected Google Calendars: booked meetings + Meet attendance.
  startCalendarSync();
  // Connected Google Search Console properties: daily clicks as "Google search click" Units.
  startSearchConsoleSync();
  // Google Ads spend ingestion — its own schedule, never chained to campaign work.
  startSpendSync();
  // Declares every Gmail thread reply we sent as its lead's message_sent (LEDGER-HISTORY-1024).
  startThreadReplyOutcomes();

  process.on("unhandledRejection", (reason) => {
    console.error("[google-service] Unhandled rejection:", reason);
  });

  process.on("uncaughtException", (err) => {
    console.error("[google-service] Uncaught exception:", err);
    server.close(() => process.exit(1));
  });

  process.on("SIGTERM", () => {
    console.log("[google-service] SIGTERM received, shutting down gracefully");
    server.close(() => process.exit(0));
  });
};

main().catch((err) => {
  console.error("[google-service] Fatal startup error:", err);
  process.exit(1);
});
