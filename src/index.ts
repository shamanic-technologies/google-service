import { createApp } from "./app";
import { env } from "./env";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`google-service listening on port ${env.PORT}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  server.close(() => process.exit(1));
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  server.close(() => process.exit(0));
});
