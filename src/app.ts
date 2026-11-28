import express from "express";
import healthRoutes from "./routes/health";
import authRoutes from "./routes/auth";
import accountsRoutes from "./routes/accounts";
import campaignsRoutes from "./routes/campaigns";
import servingRoutes from "./routes/serving";
import searchRoutes from "./routes/search";
import orgsGoogleRoutes from "./routes/orgs-google";
import internalStaffMailboxRoutes from "./routes/internal-staff-mailboxes";
import calendarRoutes from "./routes/calendar";
import searchConsoleRoutes from "./routes/search-console";
import connectorIntakeRoutes from "./routes/connector-intake";
import { errorHandler } from "./middleware/error-handler";
import { requireIdentityHeaders } from "./middleware/validate";
import { createRequestRun } from "./middleware/create-request-run";
import { requestLogger } from "./middleware/request-logger";
import { apiKeyAuth } from "./middleware/api-key-auth";

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

  // SEC-GOOGLE-KEY-1120: every route below requires x-api-key == GOOGLE_SERVICE_API_KEY,
  // checked BEFORE identity parsing and run creation (an unauthenticated call opens no run).
  // Only /health and /openapi.json above are public. There is no browser-facing route:
  // both OAuth callbacks are proxied server-side by api-service with the key.
  app.use(apiKeyAuth);

  // All routes below require x-org-id, x-user-id, and x-run-id headers
  app.use(requireIdentityHeaders);
  app.use(createRequestRun);
  app.use(authRoutes);
  app.use(accountsRoutes);
  app.use(campaignsRoutes);
  app.use(servingRoutes);
  app.use(searchRoutes);
  app.use(calendarRoutes);
  app.use(searchConsoleRoutes);
  app.use("/orgs/google", orgsGoogleRoutes);
  app.use(internalStaffMailboxRoutes);
  app.use(connectorIntakeRoutes);

  app.use(errorHandler);

  return app;
};
