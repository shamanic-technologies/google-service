import { createApp } from "./app";
import { env } from "./env";
import { runMigrations } from "./db/migrate";
import { backfillSilver } from "./services/backfill-silver";
import { startAutoSync, startGmailFreshSync } from "./services/cron-sync";
import { startSpendSync } from "./services/spend-cron";
import { resumePendingPurges } from "./services/account-purge";

const main = async () => {
  await runMigrations();

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
  startAutoSync();
  // Gmail-only deltas every ~15 min so the mirror sees an answer we just sent.
  startGmailFreshSync();
  // Google Ads spend ingestion — its own schedule, never chained to campaign work.
  startSpendSync();

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
