import { Request, Response, NextFunction } from "express";
import { createRun } from "../services/runs-service";

export const createRequestRun = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const parentRunId = req.headers["x-run-id"] as string;

    const runId = await createRun({
      parentRunId,
      orgId: req.orgId!,
      userId: req.userId!,
      service: "google",
      featureSlug: req.featureSlug,
    });

    req.runId = runId;
    next();
  } catch (err) {
    console.error("Failed to create request run:", err);
    res.status(502).json({ error: "Failed to initialize run tracking" });
  }
};
