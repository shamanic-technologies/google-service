import { Pool } from "pg";
import { env } from "../env";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

export const query = (text: string, params?: unknown[]) =>
  pool.query(text, params);
