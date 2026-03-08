/**
 * KYC provider webhook endpoints (document status callbacks).
 * Uses raw body for signature verification, then parses JSON.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { verifyWebhookSignature } from "../middleware/webhookAuth.js";
import { updateDocumentStatus } from "../services/kycService.js";

export const webhookRouter = Router();

const webhookBodySchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  countryCode: z.string().length(2).optional(),
  stateCode: z.string().max(10).optional().nullable(),
  dateOfBirth: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  rejectionReason: z.string().max(2000).optional(),
});

// Raw body is set by express.raw() when this router is mounted
webhookRouter.post(
  "/document/:documentId/status",
  verifyWebhookSignature,
  async (req: Request & { body: Buffer }, res: Response) => {
    let body: unknown;
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
    const parsed = webhookBodySchema.safeParse(body);
    if (!parsed.success) {
      return res.status(400).json({ error: "status (APPROVED|REJECTED) required", details: parsed.error.flatten() });
    }
    const { documentId } = req.params;
    try {
      const doc = await updateDocumentStatus(
        documentId,
        parsed.data.status,
        {
          countryCode: parsed.data.countryCode,
          stateCode: parsed.data.stateCode,
          dateOfBirth: parsed.data.dateOfBirth,
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
        },
        parsed.data.rejectionReason
      );
      return res.json({ documentId: doc.id, status: doc.status, rejectionReason: doc.rejectionReason ?? undefined });
    } catch (e) {
      return res.status(404).json({ error: (e as Error).message });
    }
  }
);
