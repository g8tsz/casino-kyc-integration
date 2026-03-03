import "dotenv/config";
import express from "express";
import { kycRouter } from "./routes/kyc.js";
import { jurisdictionRouter } from "./routes/jurisdiction.js";
import { retentionRouter } from "./routes/retention.js";
import { ensureDefaultPolicies } from "./services/retentionService.js";
import { seedDefaultJurisdictions } from "./services/jurisdictionService.js";

const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(express.json());

app.use("/api/kyc", kycRouter);
app.use("/api/jurisdiction", jurisdictionRouter);
app.use("/api/retention", retentionRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

async function init() {
  await ensureDefaultPolicies();
  await seedDefaultJurisdictions();
}

app.listen(PORT, async () => {
  await init();
  console.log(`KYC integration API listening on http://localhost:${PORT}`);
});
