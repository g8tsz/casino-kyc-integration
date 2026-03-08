/**
 * Webhook signature verification for KYC provider callbacks (Sumsub, Jumio, Onfido).
 * Uses HMAC-SHA256: compare X-Webhook-Signature or X-Signature header with HMAC(secret, rawBody).
 */

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const DEFAULT_HEADER = "x-webhook-signature";
const ALT_HEADERS = ["x-signature", "x-hub-signature-256", "x-sumsub-signature"];

export function getWebhookSecret(): string | undefined {
  return process.env.KYC_WEBHOOK_SECRET?.trim() || undefined;
}

/**
 * Verify webhook signature. Expects req.rawBody to be the raw request body (Buffer).
 * If KYC_WEBHOOK_SECRET is not set, skips verification (dev mode).
 */
export function verifyWebhookSignature(req: Request & { rawBody?: Buffer }, res: Response, next: NextFunction): void {
  const secret = getWebhookSecret();
  if (!secret) {
    return next();
  }

  const rawBody = req.rawBody ?? (req.body instanceof Buffer ? req.body : null);
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    res.status(400).json({ error: "Webhook body required for signature verification" });
    return;
  }

  const signatureHeader =
    req.headers[DEFAULT_HEADER] ??
    req.headers["x-signature"] ??
    req.headers["x-hub-signature-256"] ??
    req.headers["x-sumsub-signature"];
  const received = typeof signatureHeader === "string" ? signatureHeader : signatureHeader?.[0];
  if (!received) {
    res.status(401).json({ error: "Missing webhook signature header" });
    return;
  }

  // Support "sha256=hex" prefix (e.g. GitHub, Sumsub) or raw hex
  const expectedHex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedWithPrefix = `sha256=${expectedHex}`;
  const valid = received === expectedHex || received === expectedWithPrefix;

  if (!valid) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  next();
}
