import { Router } from "express";
import { isMongoDBReady } from "../infrastructure/database/mongodb.js";

export const healthRouter = Router();

healthRouter.get("/live", (_req, res) => {
  res.status(200).json({
    data: {
      status: "ok",
      service: "non-custodial-crypto-invoicing-api",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    },
  });
});

healthRouter.get("/ready", async (_req, res) => {
  const mongoDBReady = await isMongoDBReady();

  if (!mongoDBReady) {
    res.status(503).json({
      data: {
        status: "not_ready",
        checks: {
          mongodb: "unavailable",
        },
        timestamp: new Date().toISOString(),
      },
    });

    return;
  }

  res.status(200).json({
    data: {
      status: "ready",
      checks: {
        mongodb: "available",
      },
      timestamp: new Date().toISOString(),
    },
  });
});
