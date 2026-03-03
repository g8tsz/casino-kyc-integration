import { Router } from "express";
import { z } from "zod";
import {
  getOrCreateSubject,
  createSubjectAndProfile,
  crossCheckGeoWithDocument,
  performSanctionsCheck,
  submitDocument,
  updateDocumentStatus,
  setProfileStatus,
} from "../services/kycService.js";
import { getGeoFromIp, getClientIp } from "../services/geoService.js";
import { checkJurisdiction } from "../services/jurisdictionService.js";
import { prisma } from "../db/client.js";

export const kycRouter = Router();

const externalIdSchema = z.string().min(1).max(256);
const docTypeSchema = z.enum(["ID_CARD", "PASSPORT", "SELFIE", "PROOF_OF_ADDRESS"]);

// Get or create KYC subject by external id (e.g. wallet)
kycRouter.get("/subject/:externalId", async (req, res) => {
  const parsed = externalIdSchema.safeParse(req.params.externalId);
  if (!parsed.success) return res.status(400).json({ error: "Invalid externalId" });
  try {
    const subject = await getOrCreateSubject(parsed.data);
    const profile = subject.profile
      ? {
          id: subject.profile.id,
          status: subject.profile.status,
          tier: subject.profile.tier,
          countryCode: subject.profile.countryCode,
          stateCode: subject.profile.stateCode,
          geoCountryCode: subject.profile.geoCountryCode,
          geoStateCode: subject.profile.geoStateCode,
          geoCheckedAt: subject.profile.geoCheckedAt,
        }
      : null;
    return res.json({
      subjectId: subject.id,
      externalId: subject.externalId,
      profile,
    });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Create subject and profile; run geo + jurisdiction check
kycRouter.post("/subject", async (req, res) => {
  const body = z.object({ externalId: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "externalId required" });
  try {
    const ip = getClientIp(req.headers as Record<string, string | string[] | undefined>);
    const { subject, profile } = await createSubjectAndProfile({
      externalId: body.data.externalId,
      ip: ip ?? undefined,
      headers: req.headers,
    });
    const jurisdiction = profile.geoCountryCode
      ? await checkJurisdiction(profile.geoCountryCode, profile.geoStateCode ?? null, false)
      : null;
    return res.json({
      subjectId: subject.id,
      profileId: profile.id,
      status: profile.status,
      geoCountryCode: profile.geoCountryCode,
      geoStateCode: profile.geoStateCode,
      jurisdiction: jurisdiction
        ? {
            allowed: jurisdiction.allowed,
            kycRequired: jurisdiction.kycRequired,
            minAge: jurisdiction.minAge,
            stateCode: jurisdiction.stateCode,
          }
        : null,
    });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Get current geo from request IP (for cross-check)
kycRouter.get("/geo", async (req, res) => {
  const ip = getClientIp(req.headers as Record<string, string | string[] | undefined>);
  const geo = ip ? await getGeoFromIp(ip) : null;
  if (!geo) return res.status(503).json({ error: "Could not resolve geo" });
  const jurisdiction = await checkJurisdiction(geo.countryCode, geo.stateCode ?? null, false);
  return res.json({
    countryCode: geo.countryCode,
    stateCode: geo.stateCode,
    region: geo.region,
    city: geo.city,
    source: geo.source,
    jurisdiction: {
      allowed: jurisdiction.allowed,
      kycRequired: jurisdiction.kycRequired,
      minAge: jurisdiction.minAge,
      stateCode: jurisdiction.stateCode,
    },
  });
});

// Cross-check geo with document country (and state when provided, e.g. US state)
kycRouter.post("/subject/:subjectId/geo-check", async (req, res) => {
  const subjectId = req.params.subjectId;
  const body = z
    .object({
      docCountryCode: z.string().length(2),
      docStateCode: z.string().max(10).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "docCountryCode (2-letter) required" });
  try {
    const result = await crossCheckGeoWithDocument(
      subjectId,
      body.data.docCountryCode.toUpperCase(),
      body.data.docStateCode?.trim().toUpperCase(),
      req.headers as Record<string, string | string[] | undefined>
    );
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Sanctions check
kycRouter.post("/subject/:subjectId/sanctions", async (req, res) => {
  const body = z
    .object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      dateOfBirth: z.string().optional(),
      countryCode: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "firstName, lastName required" });
  try {
    const result = await performSanctionsCheck(
      req.params.subjectId,
      body.data,
      req.headers as Record<string, string | string[] | undefined>
    );
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Submit document (metadata; file upload handled elsewhere)
kycRouter.post("/subject/:subjectId/documents", async (req, res) => {
  const body = z
    .object({
      type: docTypeSchema,
      providerRef: z.string().optional(),
      providerName: z.string().optional(),
      storageRef: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.flatten() });
  try {
    const doc = await submitDocument(req.params.subjectId, body.data, req.headers as Record<string, string | string[] | undefined>);
    return res.json({
      documentId: doc.id,
      type: doc.type,
      status: doc.status,
      retentionExpiresAt: doc.retentionExpiresAt,
    });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Webhook/callback: update document status (e.g. from Sumsub/Jumio)
kycRouter.post("/webhook/document/:documentId/status", async (req, res) => {
  const body = z
    .object({
      status: z.enum(["APPROVED", "REJECTED"]),
      countryCode: z.string().optional(),
      stateCode: z.string().max(10).optional().nullable(),
      dateOfBirth: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "status APPROVED|REJECTED required" });
  try {
    const doc = await updateDocumentStatus(req.params.documentId, body.data.status, {
      countryCode: body.data.countryCode,
      stateCode: body.data.stateCode,
      dateOfBirth: body.data.dateOfBirth,
      firstName: body.data.firstName,
      lastName: body.data.lastName,
    });
    return res.json({ documentId: doc.id, status: doc.status });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Set profile KYC status (admin or after all checks)
kycRouter.patch("/subject/:subjectId/status", async (req, res) => {
  const body = z
    .object({
      status: z.enum(["PENDING", "IN_REVIEW", "APPROVED", "REJECTED"]),
      actorId: z.string().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "status required" });
  try {
    await setProfileStatus(req.params.subjectId, body.data.status, body.data.actorId);
    return res.json({ status: body.data.status });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Audit log for subject
kycRouter.get("/subject/:subjectId/audit", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Number(req.query.offset) || 0;
  try {
    const logs = await prisma.auditLog.findMany({
      where: { subjectId: req.params.subjectId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
    return res.json({ auditLogs: logs });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Documents for subject
kycRouter.get("/subject/:subjectId/documents", async (req, res) => {
  try {
    const docs = await prisma.documentSubmission.findMany({
      where: { subjectId: req.params.subjectId },
      orderBy: { submittedAt: "desc" },
      select: {
        id: true,
        type: true,
        status: true,
        providerName: true,
        submittedAt: true,
        reviewedAt: true,
        retentionExpiresAt: true,
      },
    });
    return res.json({ documents: docs });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});

// Sanctions history for subject
kycRouter.get("/subject/:subjectId/sanctions", async (req, res) => {
  try {
    const checks = await prisma.sanctionsCheck.findMany({
      where: { subjectId: req.params.subjectId },
      orderBy: { checkedAt: "desc" },
      select: {
        id: true,
        provider: true,
        result: true,
        listNames: true,
        checkedAt: true,
      },
    });
    return res.json({ sanctionsChecks: checks });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message });
  }
});
