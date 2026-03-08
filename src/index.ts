import "dotenv/config";
import express from "express";
import { kycRouter } from "./routes/kyc.js";
import { jurisdictionRouter } from "./routes/jurisdiction.js";
import { retentionRouter } from "./routes/retention.js";
import { webhookRouter } from "./routes/webhook.js";
import { ensureDefaultPolicies } from "./services/retentionService.js";
import { seedDefaultJurisdictions } from "./services/jurisdictionService.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { prisma } from "./db/client.js";
import { getWebhookSecret } from "./middleware/webhookAuth.js";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(express.json());

// Webhook route uses raw body for signature verification
app.use("/api/kyc/webhook", express.raw({ type: "application/json" }), webhookRouter);

app.use("/api/kyc", kycRouter);
app.use("/api/jurisdiction", jurisdictionRouter);
app.use("/api/retention", retentionRouter);

app.get("/health", async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({
      status: "ok",
      database: "connected",
      webhookVerification: getWebhookSecret() ? "enabled" : "disabled",
    });
  } catch (e) {
    res.status(503).json({
      status: "degraded",
      database: "disconnected",
      error: (e as Error).message,
    });
  }
});

// 404 for unknown routes
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(errorHandler);

async function init() {
  await ensureDefaultPolicies();
  await seedDefaultJurisdictions();
}

app.listen(PORT, async () => {
  await init();
  console.log(`KYC integration API listening on http://localhost:${PORT}`);
});
