import { Request, Response, NextFunction } from "express";
import { env } from "../env";

export const apiKeyAuth = (req: Request, res: Response, next: NextFunction): void => {
  const apiKey = req.headers["x-api-key"];

  if (!apiKey || apiKey !== env.GOOGLE_SERVICE_API_KEY) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }

  next();
};
