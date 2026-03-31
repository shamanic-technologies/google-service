import { Request, Response, NextFunction } from "express";
import { createRun, updateRun } from "../services/runs-service";

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
      brandId: req.brandId,
    });

    req.runId = runId;
    console.log(`[google-service] Run created: runId=${runId} parentRunId=${parentRunId ?? "none"}`);

    res.on("finish", () => {
      const status = res.statusCode < 400 ? "completed" : "failed";
      updateRun(runId, status, req.orgId!, req.userId!, req.featureSlug, req.brandId).catch((err) => {
        console.error(`[google-service] Failed to close run ${runId} as ${status}:`, err);
      });
    });

    next();
  } catch (err) {
    console.error("[google-service] Failed to create request run:", err);
    res.status(502).json({ error: "Failed to initialize run tracking" });
  }
};
