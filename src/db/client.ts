import { Pool } from "pg";
import { env } from "../env";
import { withLibpqCompat } from "./ssl";

export const pool = new Pool({
  connectionString: withLibpqCompat(env.GOOGLE_SERVICE_DATABASE_URL),
  max: 10,
});

export const query = (text: string, params?: unknown[]) =>
  pool.query(text, params);
