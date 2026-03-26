import { Request, Response, NextFunction } from "express";

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now();
  const orgId = req.headers["x-org-id"] as string | undefined;
  const runId = req.headers["x-run-id"] as string | undefined;

  console.log(`[google-service] → ${req.method} ${req.path} orgId=${orgId ?? "none"} runId=${runId ?? "none"}`);

  res.on("finish", () => {
    const duration = Date.now() - start;
    const log = `[google-service] ← ${req.method} ${req.path} ${res.statusCode} ${duration}ms`;

    if (res.statusCode >= 500) {
      console.error(log);
    } else if (res.statusCode >= 400) {
      console.warn(log);
    } else {
      console.log(log);
    }
  });

  next();
};
