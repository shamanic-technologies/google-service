import { Request, Response, NextFunction } from "express";
import { z, ZodSchema } from "zod";

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
    }
  }
}
