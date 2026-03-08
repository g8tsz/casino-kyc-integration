import { prisma } from "../db/client.js";
import { getGeoFromIp, getClientIp, getClientUserAgent, geoMatchesDocument, geoMatchesDocumentState } from "./geoService.js";
import { checkJurisdiction } from "./jurisdictionService.js";
import { runSanctionsCheck, type SanctionsRequest } from "./sanctionsService.js";
import { writeAudit, redactForAudit, type AuditAction } from "./auditService.js";
import { DEFAULT_REQUIRED_DOC_TYPES_FULL } from "../constants/kyc.js";
import type { IncomingHttpHeaders } from "http";

export interface KycReadinessResult {
  ready: boolean;
  status: string;
  checks: {
    jurisdiction: { allowed: boolean; kycRequired: string; minAge: number; message?: string };
    sanctions: { clear: boolean; lastResult?: string; lastCheckedAt?: Date | null };
    documents: { satisfied: boolean; required: string[]; submitted: { type: string; status: string }[]; missing: string[] };
    geo: { match: boolean | null; docCountry?: string | null; geoCountry?: string | null };
    age: { valid: boolean | null; dateOfBirth?: string | null; minAge: number };
  };
  missing: string[];
  blocking: string[];
}

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
    userAgent: input.headers ? getClientUserAgent(input.headers as Record<string, string | string[] | undefined>) : undefined,
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
    userAgent: headers ? getClientUserAgent(headers as Record<string, string | string[] | undefined>) : undefined,
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
    userAgent: headers ? getClientUserAgent(headers as Record<string, string | string[] | undefined>) : undefined,
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
    userAgent: headers ? getClientUserAgent(headers as Record<string, string | string[] | undefined>) : undefined,
  });

  return doc;
}

/**
 * Update document status (e.g. from provider webhook) and optionally profile status.
 */
export async function updateDocumentStatus(
  documentId: string,
  status: "APPROVED" | "REJECTED",
  extra?: { countryCode?: string; stateCode?: string | null; dateOfBirth?: string; firstName?: string; lastName?: string },
  rejectionReason?: string | null
) {
  const doc = await prisma.documentSubmission.findUnique({
    where: { id: documentId },
    include: { subject: true, profile: true },
  });
  if (!doc) throw new Error("Document not found");

  const oldStatus = doc.status;
  const updated = await prisma.documentSubmission.update({
    where: { id: documentId },
    data: {
      status,
      reviewedAt: new Date(),
      ...(rejectionReason !== undefined && { rejectionReason }),
    },
  });

  const action: AuditAction = status === "APPROVED" ? "DOC_APPROVED" : "DOC_REJECTED";
  await writeAudit({
    subjectId: doc.subjectId,
    action,
    resource: documentId,
    oldValue: oldStatus,
    newValue: status + (rejectionReason ? ` | ${rejectionReason.slice(0, 200)}` : ""),
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

  return updated;
}

/**
 * Evaluate KYC readiness: jurisdiction, sanctions, required documents, geo match, age.
 * Returns a structured result for UI or compliance dashboards.
 */
export async function getKycReadiness(subjectId: string): Promise<KycReadinessResult> {
  const subject = await prisma.kycSubject.findUnique({
    where: { id: subjectId },
    include: {
      profile: true,
      documents: { orderBy: { submittedAt: "desc" } },
      sanctionsChecks: { orderBy: { checkedAt: "desc" }, take: 1 },
    },
  });
  if (!subject) throw new Error("Subject not found");

  const profile = subject.profile;
  const blocking: string[] = [];
  const missing: string[] = [];

  // Jurisdiction: use profile country/state or default to strict
  const countryCode = profile?.countryCode ?? profile?.geoCountryCode ?? "XX";
  const stateCode = profile?.stateCode ?? profile?.geoStateCode ?? null;
  const jurisdiction = await checkJurisdiction(countryCode, stateCode, false);
  if (!jurisdiction.allowed) blocking.push("Jurisdiction not allowed");
  if (jurisdiction.kycRequired === "NONE" && jurisdiction.allowed) {
    return {
      ready: true,
      status: profile?.status ?? "PENDING",
      checks: {
        jurisdiction: { allowed: jurisdiction.allowed, kycRequired: jurisdiction.kycRequired, minAge: jurisdiction.minAge, message: jurisdiction.message },
        sanctions: { clear: true, lastResult: undefined, lastCheckedAt: null },
        documents: { satisfied: true, required: [], submitted: [], missing: [] },
        geo: { match: null, docCountry: null, geoCountry: null },
        age: { valid: null, dateOfBirth: null, minAge: jurisdiction.minAge },
      },
      missing: [],
      blocking: [],
    };
  }

  // Sanctions: must have at least one CLEAR (or no checks yet = need to run)
  const latestSanctions = subject.sanctionsChecks[0];
  const sanctionsClear = latestSanctions ? latestSanctions.result === "CLEAR" : false;
  if (latestSanctions && latestSanctions.result === "HIT") blocking.push("Sanctions hit; review required");
  if (!latestSanctions && jurisdiction.kycRequired !== "NONE") missing.push("Run sanctions check");

  // Required documents for FULL: ID or PASSPORT, SELFIE, PROOF_OF_ADDRESS
  const requiredTypes = [...DEFAULT_REQUIRED_DOC_TYPES_FULL];
  const submittedByType = new Map<string, { type: string; status: string }>();
  for (const d of subject.documents) {
    const key = d.type === "ID_CARD" || d.type === "PASSPORT" ? "ID_OR_PASSPORT" : d.type;
    if (!submittedByType.has(key) || d.status === "APPROVED")
      submittedByType.set(key, { type: d.type, status: d.status });
  }
  const hasIdOrPassportApproved = subject.documents.some(
    (d) => (d.type === "ID_CARD" || d.type === "PASSPORT") && d.status === "APPROVED"
  );
  const docsMissing: string[] = [];
  if (jurisdiction.kycRequired === "FULL") {
    if (!hasIdOrPassportApproved) docsMissing.push("ID_CARD or PASSPORT (approved)");
    if (!submittedByType.get("SELFIE")?.status || submittedByType.get("SELFIE")?.status !== "APPROVED")
      docsMissing.push("SELFIE (approved)");
    if (
      !submittedByType.get("PROOF_OF_ADDRESS")?.status ||
      submittedByType.get("PROOF_OF_ADDRESS")?.status !== "APPROVED"
    )
      docsMissing.push("PROOF_OF_ADDRESS (approved)");
  }
  const documentsSatisfied = docsMissing.length === 0;
  if (docsMissing.length) missing.push(...docsMissing);

  // Geo: match if we have both doc and geo and they match
  let geoMatch: boolean | null = null;
  if (profile?.countryCode && profile?.geoCountryCode) {
    geoMatch = geoMatchesDocument(profile.geoCountryCode, profile.countryCode);
    if (!geoMatch) blocking.push("Document country does not match IP country");
  }

  // Age: need DOB and minAge from jurisdiction
  const minAge = jurisdiction.minAge;
  let ageValid: boolean | null = null;
  if (profile?.dateOfBirth) {
    const dob = new Date(profile.dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
    ageValid = age >= minAge;
    if (!ageValid) blocking.push(`Age below minimum (${minAge})`);
  } else if (jurisdiction.kycRequired !== "NONE") {
    missing.push("Date of birth required");
  }

  const ready =
    jurisdiction.allowed &&
    sanctionsClear &&
    documentsSatisfied &&
    (geoMatch !== false) &&
    (ageValid !== false);

  return {
    ready,
    status: profile?.status ?? "PENDING",
    checks: {
      jurisdiction: {
        allowed: jurisdiction.allowed,
        kycRequired: jurisdiction.kycRequired,
        minAge: jurisdiction.minAge,
        message: jurisdiction.message,
      },
      sanctions: {
        clear: sanctionsClear,
        lastResult: latestSanctions?.result ?? undefined,
        lastCheckedAt: latestSanctions?.checkedAt ?? null,
      },
      documents: {
        satisfied: documentsSatisfied,
        required: Array.from(new Set(requiredTypes as unknown as string[])),
        submitted: subject.documents.map((d) => ({ type: d.type, status: d.status })),
        missing: docsMissing,
      },
      geo: {
        match: geoMatch,
        docCountry: profile?.countryCode ?? null,
        geoCountry: profile?.geoCountryCode ?? null,
      },
      age: { valid: ageValid, dateOfBirth: profile?.dateOfBirth ?? null, minAge },
    },
    missing,
    blocking,
  };
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
