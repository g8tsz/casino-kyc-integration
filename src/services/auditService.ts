import { prisma } from "../db/client.js";

export type AuditAction =
  | "DOC_SUBMITTED"
  | "DOC_APPROVED"
  | "DOC_REJECTED"
  | "SANCTIONS_CHECK"
  | "GEO_CHECK"
  | "GEO_MISMATCH"
  | "STATUS_CHANGED"
  | "PROFILE_CREATED"
  | "PROFILE_UPDATED"
  | "JURISDICTION_CHECK"
  | "RETENTION_PURGE"
  | "RETENTION_ANONYMIZE";

export interface AuditEntry {
  subjectId: string | null;
  action: AuditAction;
  resource?: string;
  oldValue?: string;
  newValue?: string;
  ipAddress?: string;
  userAgent?: string;
  actorId?: string;
}

/**
 * Append to immutable audit log. Redact PII in oldValue/newValue (e.g. mask names).
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      subjectId: entry.subjectId,
      action: entry.action,
      resource: entry.resource ?? null,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
      actorId: entry.actorId ?? null,
    },
  });
}

export function redactForAudit(obj: Record<string, unknown>): string {
  const copy = { ...obj };
  const mask = (v: unknown) => (typeof v === "string" && v.length > 2 ? v.slice(0, 2) + "***" : v);
  if (copy.firstName !== undefined) copy.firstName = mask(copy.firstName);
  if (copy.lastName !== undefined) copy.lastName = mask(copy.lastName);
  if (copy.dateOfBirth !== undefined) copy.dateOfBirth = "****-**-**";
  return JSON.stringify(copy);
}
