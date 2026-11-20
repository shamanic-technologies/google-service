import { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../env";

// SEC-GOOGLE-KEY-1120: the ONE service-key gate. Mounted app-wide in `createApp`
// right after /health and /openapi.json, BEFORE identity parsing and
// createRequestRun, so an unauthenticated call is refused before any run is
// opened, any DB row read or any vendor (Google Ads, Serper) is called.
// Never mount it per-router again: per-router mounting is how most routes
// ended up open.
const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Constant-time compare: both sides hashed to 32 bytes, so neither length nor content leaks timing. */
export const isValidServiceKey = (presented: unknown): boolean => {
  if (typeof presented !== "string" || presented.length === 0) return false;
  return timingSafeEqual(digest(presented), digest(env.GOOGLE_SERVICE_API_KEY));
};

export const apiKeyAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (!isValidServiceKey(req.headers["x-api-key"])) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }
  next();
};
