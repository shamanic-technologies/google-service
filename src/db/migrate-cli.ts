import { pool } from "./client";
import { runMigrations } from "./migrate";

runMigrations()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[google-service] Migration failed:", err);
    process.exit(1);
  });
