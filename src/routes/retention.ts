import { Router } from "express";
import { getPolicies, ensureDefaultPolicies, runRetention } from "../services/retentionService.js";
import { prisma } from "../db/client.js";

export const retentionRouter = Router();

// Get retention policies
retentionRouter.get("/policies", async (_req, res) => {
  try {
    const policies = await getPolicies();
    return res.json({ policies });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Ensure default policies exist
retentionRouter.post("/policies/seed", async (_req, res) => {
  try {
    await ensureDefaultPolicies();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Update policy (admin)
retentionRouter.patch("/policies/:dataType", async (req, res) => {
  const body = req.body as { retainDays?: number; action?: string };
  const dataType = req.params.dataType;
  if (!["DOCUMENTS", "AUDIT", "PII"].includes(dataType)) {
    return res.status(400).json({ error: "Invalid dataType" });
  }
  try {
    const policy = await prisma.dataRetentionPolicy.update({
      where: { dataType },
      data: {
        ...(typeof body.retainDays === "number" && body.retainDays > 0 && { retainDays: body.retainDays }),
        ...((body.action === "DELETE" || body.action === "ANONYMIZE") ? { action: body.action } : {}),
      },
    });
    return res.json(policy);
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Run retention job (idempotent; call from cron or manually)
retentionRouter.post("/run", async (_req, res) => {
  try {
    const results = await runRetention();
    return res.json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});
