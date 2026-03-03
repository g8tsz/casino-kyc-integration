import { prisma } from "../db/client.js";
import { getGeoFromIp, getClientIp, geoMatchesDocument, geoMatchesDocumentState } from "./geoService.js";
import { checkJurisdiction } from "./jurisdictionService.js";
import { runSanctionsCheck, type SanctionsRequest } from "./sanctionsService.js";
import { writeAudit, redactForAudit, type AuditAction } from "./auditService.js";
import type { IncomingHttpHeaders } from "http";

export interface CreateSubjectInput {
  externalId: string;
  ip?: string | null;
  headers?: IncomingHttpHeaders;
}

export async function getOrCreateSubject(externalId: string) {
  const normalized = externalId.trim().toLowerCase();
  let subject = await prisma.kycSubject.findUnique({
    where: { externalId: normalized },
    include: { profile: true },
  });
  if (!subject) {
    subject = await prisma.kycSubject.create({
      data: { externalId: normalized },
      include: { profile: true },
    });
  }
  return subject;
}

export async function createSubjectAndProfile(input: CreateSubjectInput) {
  const subject = await getOrCreateSubject(input.externalId);
  if (subject.profile) return { subject, profile: subject.profile };

  const ip = input.ip ?? getClientIp(input.headers as Record<string, string | string[] | undefined>);
  const geo = ip ? await getGeoFromIp(ip) : null;
  const jurisdiction = geo ? await checkJurisdiction(geo.countryCode, geo.stateCode ?? null, false) : null;

  const profile = await prisma.kycProfile.create({
    data: {
      subjectId: subject.id,
      status: "PENDING",
      countryCode: geo?.countryCode ?? null,
      stateCode: null,
      geoCountryCode: geo?.countryCode ?? null,
      geoStateCode: geo?.stateCode ?? null,
      geoCheckedAt: geo ? new Date() : null,
    },
  });

  await writeAudit({
    subjectId: subject.id,
    action: "PROFILE_CREATED",
    resource: profile.id,
    newValue: redactForAudit({
      geoCountry: geo?.countryCode,
      geoState: geo?.stateCode,
      allowed: jurisdiction?.allowed,
      kycRequired: jurisdiction?.kycRequired,
    }),
    ipAddress: ip ?? undefined,
  });

  if (jurisdiction && !jurisdiction.allowed) {
    await writeAudit({
      subjectId: subject.id,
      action: "JURISDICTION_CHECK",
      newValue: JSON.stringify({ result: "BLOCKED", country: geo?.countryCode, state: geo?.stateCode }),
    });
  }

  return { subject: { ...subject, profile }, profile };
}

/**
 * Cross-check geo (from current IP) with document country and optional state.
 * Updates profile geo fields and logs match/mismatch (country + state when both present).
 */
export async function crossCheckGeoWithDocument(
  subjectId: string,
  docCountryCode: string,
  docStateCode?: string | null,
  headers?: IncomingHttpHeaders
) {
  const ip = getClientIp(headers as Record<string, string | string[] | undefined>);
  const geo = ip ? await getGeoFromIp(ip) : null;
  const countryMatch = geoMatchesDocument(geo?.countryCode ?? null, docCountryCode);
  const stateMatch = geoMatchesDocumentState(
    geo?.countryCode ?? null,
    geo?.stateCode ?? null,
    docCountryCode,
    docStateCode ?? null
  );
  const matches = countryMatch && stateMatch;

  await prisma.kycProfile.updateMany({
    where: { subjectId },
    data: {
      geoCountryCode: geo?.countryCode ?? undefined,
      geoStateCode: geo?.stateCode ?? undefined,
      geoCheckedAt: new Date(),
    },
  });

  await writeAudit({
    subjectId,
    action: matches ? "GEO_CHECK" : "GEO_MISMATCH",
    newValue: JSON.stringify({
      geoCountry: geo?.countryCode,
      geoState: geo?.stateCode,
      docCountry: docCountryCode,
      docState: docStateCode ?? null,
      countryMatch,
      stateMatch,
      matches,
    }),
    ipAddress: ip ?? undefined,
  });

  return {
    matches,
    countryMatch,
    stateMatch,
    geoCountry: geo?.countryCode,
    geoState: geo?.stateCode,
  };
}

/**
 * Run sanctions check and persist result + audit.
 */
export async function performSanctionsCheck(
  subjectId: string,
  req: SanctionsRequest,
  headers?: IncomingHttpHeaders
) {
  const result = await runSanctionsCheck(req);
  const ip = getClientIp(headers as Record<string, string | string[] | undefined>);

  await prisma.sanctionsCheck.create({
    data: {
      subjectId,
      provider: result.provider,
      result: result.result,
      listNames: result.listNames ? JSON.stringify(result.listNames) : null,
      refId: result.refId ?? null,
      rawResponse: result.rawResponse ?? null,
    },
  });

  await writeAudit({
    subjectId,
    action: "SANCTIONS_CHECK",
    newValue: JSON.stringify({
      result: result.result,
      provider: result.provider,
      listNames: result.listNames,
    }),
    ipAddress: ip ?? undefined,
  });

  return result;
}

/**
 * Submit document (metadata only; actual file stored elsewhere). Optionally run geo cross-check.
 */
export async function submitDocument(
  subjectId: string,
  data: {
    type: string;
    providerRef?: string;
    providerName?: string;
    storageRef?: string;
    metadata?: Record<string, unknown>;
  },
  headers?: IncomingHttpHeaders
) {
  const subject = await prisma.kycSubject.findUnique({
    where: { id: subjectId },
    include: { profile: true },
  });
  if (!subject) throw new Error("Subject not found");

  let profileId = subject.profile?.id;
  if (!profileId) {
    const { profile } = await createSubjectAndProfile({
      externalId: subject.externalId,
      headers: headers as IncomingHttpHeaders,
    });
    profileId = profile.id;
  }

  const retentionDays = parseInt(process.env.RETENTION_DAYS_DOCUMENTS ?? "2555", 10);
  const retentionExpiresAt = new Date();
  retentionExpiresAt.setDate(retentionExpiresAt.getDate() + retentionDays);

  const doc = await prisma.documentSubmission.create({
    data: {
      subjectId,
      profileId,
      type: data.type,
      status: "PENDING",
      providerRef: data.providerRef ?? null,
      providerName: data.providerName ?? null,
      storageRef: data.storageRef ?? null,
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      retentionExpiresAt,
    },
  });

  await writeAudit({
    subjectId,
    action: "DOC_SUBMITTED",
    resource: doc.id,
    newValue: JSON.stringify({ type: data.type, provider: data.providerName }),
    ipAddress: getClientIp(headers as Record<string, string | string[] | undefined>) ?? undefined,
  });

  return doc;
}

/**
 * Update document status (e.g. from provider webhook) and optionally profile status.
 */
export async function updateDocumentStatus(
  documentId: string,
  status: "APPROVED" | "REJECTED",
  extra?: { countryCode?: string; stateCode?: string | null; dateOfBirth?: string; firstName?: string; lastName?: string }
) {
  const doc = await prisma.documentSubmission.findUnique({
    where: { id: documentId },
    include: { subject: true, profile: true },
  });
  if (!doc) throw new Error("Document not found");

  const oldStatus = doc.status;
  await prisma.documentSubmission.update({
    where: { id: documentId },
    data: {
      status,
      reviewedAt: new Date(),
    },
  });

  const action: AuditAction = status === "APPROVED" ? "DOC_APPROVED" : "DOC_REJECTED";
  await writeAudit({
    subjectId: doc.subjectId,
    action,
    resource: documentId,
    oldValue: oldStatus,
    newValue: status,
  });

  if (status === "APPROVED" && doc.profileId && extra) {
    const update: Record<string, string | null> = {};
    if (extra.countryCode) update.countryCode = extra.countryCode;
    if (extra.stateCode !== undefined) update.stateCode = extra.stateCode ?? null;
    if (extra.dateOfBirth) update.dateOfBirth = extra.dateOfBirth;
    if (extra.firstName) update.firstName = extra.firstName;
    if (extra.lastName) update.lastName = extra.lastName;
    if (Object.keys(update).length > 0) {
      await prisma.kycProfile.update({
        where: { id: doc.profileId },
        data: update,
      });
      await writeAudit({
        subjectId: doc.subjectId,
        action: "PROFILE_UPDATED",
        resource: doc.profileId,
        newValue: redactForAudit(extra),
      });
    }
  }

  return doc;
}

/**
 * Set profile KYC status (e.g. after all checks pass).
 */
export async function setProfileStatus(
  subjectId: string,
  status: "PENDING" | "IN_REVIEW" | "APPROVED" | "REJECTED",
  actorId?: string
) {
  const profile = await prisma.kycProfile.findFirst({ where: { subjectId } });
  if (!profile) throw new Error("Profile not found");
  const oldStatus = profile.status;
  await prisma.kycProfile.update({
    where: { id: profile.id },
    data: { status },
  });
  await writeAudit({
    subjectId,
    action: "STATUS_CHANGED",
    resource: profile.id,
    oldValue: oldStatus,
    newValue: status,
    actorId,
  });
  return profile;
}
