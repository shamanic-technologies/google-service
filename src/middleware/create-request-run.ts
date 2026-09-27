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
      audienceId: req.audienceId,
    });

    req.runId = runId;
    console.log(`[google-service] Run created: runId=${runId} parentRunId=${parentRunId ?? "none"}`);

    res.on("finish", () => {
      // A route that answered with one of its own DOCUMENTED outcomes (e.g. the
      // conversation read's 404 "nobody has this exchange") did its job: that is a
      // completed run, not a failed one. Routes mark it via res.locals.documentedAnswer.
      const status =
        res.statusCode < 400 || res.locals.documentedAnswer === true ? "completed" : "failed";
      updateRun(runId, status, req.orgId!, req.userId!, req.featureSlug, req.brandId, req.audienceId).catch((err) => {
        console.error(`[google-service] Failed to close run ${runId} as ${status}:`, err);
      });
    });

    next();
  } catch (err) {
    console.error("[google-service] Failed to create request run:", err);
    res.status(502).json({ error: "Failed to initialize run tracking" });
  }
};
