import express from "express";
import healthRoutes from "./routes/health";
import authRoutes from "./routes/auth";
import accountsRoutes from "./routes/accounts";
import campaignsRoutes from "./routes/campaigns";
import { errorHandler } from "./middleware/error-handler";

export const createApp = () => {
  const app = express();

  app.use(express.json());

  app.use(healthRoutes);
  app.use(authRoutes);
  app.use(accountsRoutes);
  app.use(campaignsRoutes);

  // Serve OpenAPI spec
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

  app.use(errorHandler);

  return app;
};
