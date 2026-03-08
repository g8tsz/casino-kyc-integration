/**
 * Central error handling middleware. Ensures consistent API error shape and logs.
 */

import { Request, Response, NextFunction } from "express";

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
}

export function apiError(statusCode: number, message: string, code?: string): ApiError {
  const err = new Error(message) as ApiError;
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

export function errorHandler(
  err: Error & { statusCode?: number; code?: string },
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode ?? 500;
  const message = err.message || "Internal server error";
  const code = err.code;

  if (statusCode >= 500) {
    console.error("[KYC API Error]", err);
  }

  res.status(statusCode).json({
    error: message,
    ...(code && { code }),
  });
}
