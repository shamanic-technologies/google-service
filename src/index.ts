import { createApp } from "./app";
import { env } from "./env";
import { registerPlatformKeys } from "./services/key-service";

const app = createApp();

const server = app.listen(env.PORT, async () => {
  console.log(`[google-service] listening on port ${env.PORT}`);
  try {
    await registerPlatformKeys();
    console.log("[google-service] Platform keys registered successfully");
  } catch (err) {
    console.error("[google-service] Failed to register platform keys:", err);
  }
});

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
