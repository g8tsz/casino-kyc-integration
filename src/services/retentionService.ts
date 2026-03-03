import { prisma } from "../db/client.js";
import { writeAudit } from "./auditService.js";

/**
 * Data retention: purge or anonymize records past policy retainDays.
 * Run via cron: npm run retention:run
 */

export async function getPolicies() {
  return prisma.dataRetentionPolicy.findMany();
}

export async function ensureDefaultPolicies() {
  const defaults = [
    { dataType: "DOCUMENTS", retainDays: parseInt(process.env.RETENTION_DAYS_DOCUMENTS ?? "2555", 10), action: "ANONYMIZE" },
    { dataType: "AUDIT", retainDays: parseInt(process.env.RETENTION_DAYS_AUDIT ?? "2555", 10), action: "ANONYMIZE" },
    { dataType: "PII", retainDays: parseInt(process.env.RETENTION_DAYS_PII ?? "2555", 10), action: "ANONYMIZE" },
  ];
  for (const p of defaults) {
    await prisma.dataRetentionPolicy.upsert({
      where: { dataType: p.dataType },
      create: p,
      update: { retainDays: p.retainDays, action: p.action },
    });
  }
}

export async function runRetention() {
  const policies = await getPolicies();
  const cutoff = new Date();
  const results: { dataType: string; anonymized: number; deleted: number }[] = [];

  for (const policy of policies) {
    cutoff.setTime(Date.now());
    cutoff.setDate(cutoff.getDate() - policy.retainDays);

    let anonymized = 0;
    let deleted = 0;

    if (policy.dataType === "DOCUMENTS") {
      const docs = await prisma.documentSubmission.findMany({
        where: { retentionExpiresAt: { lt: cutoff } },
        select: { id: true, subjectId: true },
      });
      for (const d of docs) {
        await prisma.documentSubmission.update({
          where: { id: d.id },
          data: {
            storageRef: null,
            metadata: null,
            providerRef: null,
          },
        });
        anonymized++;
        await writeAudit({
          subjectId: d.subjectId,
          action: "RETENTION_ANONYMIZE",
          resource: d.id,
          newValue: JSON.stringify({ dataType: "DOCUMENTS" }),
          actorId: "system",
        });
      }
    }

    if (policy.dataType === "PII") {
      const profiles = await prisma.kycProfile.findMany({
        where: {
          OR: [
            { retentionExpiresAt: { lt: cutoff } },
            { retentionExpiresAt: null, updatedAt: { lt: cutoff } },
          ],
        },
        select: { id: true, subjectId: true },
      });
      for (const p of profiles) {
        await prisma.kycProfile.update({
          where: { id: p.id },
          data: {
            firstName: null,
            lastName: null,
            dateOfBirth: null,
          },
        });
        anonymized++;
        await writeAudit({
          subjectId: p.subjectId,
          action: "RETENTION_ANONYMIZE",
          resource: p.id,
          newValue: JSON.stringify({ dataType: "PII" }),
          actorId: "system",
        });
      }
    }

    if (policy.dataType === "AUDIT" && policy.action === "DELETE") {
      const deletedLogs = await prisma.auditLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });
      deleted = deletedLogs.count;
    }

    await prisma.dataRetentionPolicy.update({
      where: { id: policy.id },
      data: { lastRunAt: new Date() },
    });

    results.push({ dataType: policy.dataType, anonymized, deleted });
  }

  return results;
}
