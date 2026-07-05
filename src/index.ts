import { createApp } from "./app";
import { env } from "./env";
import { runMigrations } from "./db/migrate";
import { backfillSilver } from "./services/backfill-silver";
import { startAutoSync } from "./services/cron-sync";

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
  startAutoSync();

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
