import express from "express";
import healthRoutes from "./routes/health";
import authRoutes from "./routes/auth";
import accountsRoutes from "./routes/accounts";
import campaignsRoutes from "./routes/campaigns";
import searchRoutes from "./routes/search";
import { errorHandler } from "./middleware/error-handler";
import { requireIdentityHeaders } from "./middleware/validate";
import { createRequestRun } from "./middleware/create-request-run";
import { requestLogger } from "./middleware/request-logger";

export const createApp = () => {
  const app = express();

  app.use(express.json());
  app.use(requestLogger);

  app.use(healthRoutes);

  // Serve OpenAPI spec (no auth required)
  app.get("/openapi.json", (_req, res) => {
    try {
      const fs = require("fs");
      const path = require("path");
      const specPath = path.resolve(__dirname, "../openapi.json");
      const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
      res.json(spec);
    } catch {
      res.status(404).json({ error: "OpenAPI spec not generated yet. Run npm run generate-openapi" });
    }
  });

  // All routes below require x-org-id, x-user-id, and x-run-id headers
  app.use(requireIdentityHeaders);
  app.use(createRequestRun);
  app.use(authRoutes);
  app.use(accountsRoutes);
  app.use(campaignsRoutes);
  app.use(searchRoutes);

  app.use(errorHandler);

  return app;
};
