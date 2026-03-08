/**
 * Central KYC/AML constants for document types, statuses, and compliance.
 */

export const DOCUMENT_TYPES = [
  "ID_CARD",
  "PASSPORT",
  "SELFIE",
  "PROOF_OF_ADDRESS",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const PROFILE_STATUSES = ["PENDING", "IN_REVIEW", "APPROVED", "REJECTED"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const KYC_TIERS = ["NONE", "BASIC", "FULL"] as const;
export type KycTier = (typeof KYC_TIERS)[number];

/** Document types typically required for FULL KYC (configurable per jurisdiction) */
export const DEFAULT_REQUIRED_DOC_TYPES_FULL: DocumentType[] = [
  "ID_CARD", // or PASSPORT
  "SELFIE",
  "PROOF_OF_ADDRESS",
];

export const SANCTIONS_RESULTS = ["CLEAR", "HIT", "ERROR"] as const;
export type SanctionsResult = (typeof SANCTIONS_RESULTS)[number];
