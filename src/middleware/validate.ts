import { Request, Response, NextFunction } from "express";
import { z, ZodSchema } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const requireIdentityHeaders = (req: Request, res: Response, next: NextFunction): void => {
  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];
  const runId = req.headers["x-run-id"];

  if (!orgId || typeof orgId !== "string") {
    res.status(400).json({ error: "Missing required header: x-org-id" });
    return;
  }
  if (!UUID_RE.test(orgId)) {
    res.status(400).json({ error: "x-org-id must be a valid UUID" });
    return;
  }
  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: "Missing required header: x-user-id" });
    return;
  }
  if (!UUID_RE.test(userId)) {
    res.status(400).json({ error: "x-user-id must be a valid UUID" });
    return;
  }
  if (!runId || typeof runId !== "string") {
    res.status(400).json({ error: "Missing required header: x-run-id" });
    return;
  }
  if (!UUID_RE.test(runId)) {
    res.status(400).json({ error: "x-run-id must be a valid UUID" });
    return;
  }

  const featureSlug = req.headers["x-feature-slug"];
  const brandId = req.headers["x-brand-id"];

  req.orgId = orgId;
  req.userId = userId;
  req.featureSlug = typeof featureSlug === "string" ? featureSlug : undefined;
  req.brandId = typeof brandId === "string" ? brandId : undefined;
  next();
};

export const validateQuery =
  <T extends ZodSchema>(schema: T) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      res.status(400).json({ error: result.error.issues.map((i) => i.message).join(", ") });
      return;
    }
    req.validatedQuery = result.data;
    next();
  };

export const validateBody =
  <T extends ZodSchema>(schema: T) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: result.error.issues.map((i) => i.message).join(", ") });
      return;
    }
    req.validatedBody = result.data;
    next();
  };

export const validateParams =
  <T extends ZodSchema>(schema: T) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      res.status(400).json({ error: result.error.issues.map((i) => i.message).join(", ") });
      return;
    }
    req.validatedParams = result.data;
    next();
  };

declare global {
  namespace Express {
    interface Request {
      validatedQuery?: unknown;
      validatedBody?: unknown;
      validatedParams?: unknown;
      orgId?: string;
      userId?: string;
      runId?: string;
      featureSlug?: string;
      brandId?: string;
    }
  }
}
