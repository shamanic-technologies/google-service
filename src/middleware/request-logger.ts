import { Request, Response, NextFunction } from "express";

// Patterns that indicate automated vulnerability scanners probing for secrets/config files.
// These requests are never legitimate API calls — skip logging to reduce noise.
const SCANNER_PATH_PATTERNS = [
  /\.env/,
  /\.git\//,
  /\.git$/,
  /\.bak$/,
  /\.old$/,
  /\.save$/,
  /\.backup$/,
  /\.example$/,
  /\/actuator\//,
  /\/debug\//,
  /\/wp-admin/,
  /\/wp-login/,
  /\/wp-content/,
  /\/phpinfo/,
  /\/phpmyadmin/i,
  /\/\.well-known\/(?!openid-configuration)/,
  /\/admin\/?$/,
  /\/config\//,
  /\/cgi-bin\//,
];

function isScannerRequest(path: string): boolean {
  return SCANNER_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  if (isScannerRequest(req.path)) {
    next();
    return;
  }

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
