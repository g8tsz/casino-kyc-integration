import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { seedDefaultJurisdictions } from "../services/jurisdictionService.js";

export const jurisdictionRouter = Router();

// List all jurisdiction rules; optional filter by countryCode
jurisdictionRouter.get("/rules", async (req, res) => {
  const countryCode = req.query.countryCode as string | undefined;
  try {
    const rules = await prisma.jurisdictionRule.findMany({
      where: countryCode ? { countryCode: countryCode.toUpperCase() } : undefined,
      orderBy: [{ countryCode: "asc" }, { stateCode: "asc" }],
    });
    return res.json({ rules });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Get one rule by country (and optional state). For US use ?stateCode=CA
jurisdictionRouter.get("/rules/:countryCode", async (req, res) => {
  const code = req.params.countryCode?.toUpperCase();
  const stateCode = (req.query.stateCode as string)?.trim().toUpperCase() || "";
  if (!code || code.length !== 2) return res.status(400).json({ error: "Invalid countryCode" });
  try {
    const rule = await prisma.jurisdictionRule.findFirst({
      where: {
        countryCode: code,
        OR: stateCode ? [{ stateCode }, { stateCode: "" }] : [{ stateCode: "" }],
      },
      orderBy: { stateCode: "desc" },
    });
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    return res.json({ ...rule, stateCode: rule.stateCode || null });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Create or update rule (admin). Use stateCode for US states / per-state per country.
jurisdictionRouter.put("/rules", async (req, res) => {
  const body = z
    .object({
      countryCode: z.string().length(2),
      stateCode: z.string().max(10).optional().nullable(),
      allowed: z.boolean(),
      kycRequired: z.enum(["NONE", "BASIC", "FULL"]),
      minAge: z.number().int().min(1).max(120),
      notes: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  const countryCode = body.data.countryCode.toUpperCase();
  const stateCode = (body.data.stateCode?.trim().toUpperCase() ?? "").slice(0, 10);
  try {
    const rule = await prisma.jurisdictionRule.upsert({
      where: {
        countryCode_stateCode: { countryCode, stateCode: stateCode || "" },
      },
      create: {
        countryCode,
        stateCode: stateCode || "",
        allowed: body.data.allowed,
        kycRequired: body.data.kycRequired,
        minAge: body.data.minAge,
        notes: body.data.notes ?? null,
      },
      update: {
        allowed: body.data.allowed,
        kycRequired: body.data.kycRequired,
        minAge: body.data.minAge,
        notes: body.data.notes ?? null,
      },
    });
    return res.json({ ...rule, stateCode: rule.stateCode || null });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Seed default jurisdictions (all 50 US states + country-level for others)
jurisdictionRouter.post("/seed", async (_req, res) => {
  try {
    await seedDefaultJurisdictions();
    return res.json({ ok: true, message: "Default jurisdictions seeded (US 50 states + country-level)" });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});
