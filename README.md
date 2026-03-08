# Casino KYC Integration

KYC/AML integration for online casinos: **document verification**, **sanctions screening**, **jurisdiction rules**, **geo-location cross-check**, **audit logs**, and **data retention policies**.

## Features

- **Document verification** – Submit ID/passport/selfie/proof-of-address; track status (PENDING/APPROVED/REJECTED) and **rejection reason**; **HMAC-signed webhook** for provider callbacks (Sumsub, Jumio, Onfido); manual status update via `PATCH /documents/:documentId`.
- **Sanctions / AML checks** – Screen name (and DOB, country) against lists; pluggable provider (ComplyAdvantage, Chainalysis, or mock).
- **Jurisdiction rules** – Allow/block by country and state; require KYC level (NONE/BASIC/FULL) and min age per jurisdiction; seed defaults (US 50 states + DC, GB, DE, FR, AU, CA, NL, ES, IT, restricted list).
- **Geo cross-check** – Resolve country (and US state) from IP; compare with document-derived country/state; log match/mismatch for audit.
- **KYC readiness** – `GET /api/kyc/subject/:subjectId/readiness` returns a compliance checklist: jurisdiction allowed, sanctions clear, required documents (ID/PASSPORT + SELFIE + POA), geo match, age ≥ min; lists **missing** and **blocking** items for UI.
- **Audit logs** – Immutable log for every KYC action (IP, User-Agent, actor); PII redacted in log payloads.
- **Data retention** – Configurable policies per data type (DOCUMENTS, AUDIT, PII); anonymize or delete after retain days; run via API or cron (`npm run retention:run`).

## Data model

- **KycSubject** – External identity (e.g. wallet address).
- **KycProfile** – Status, tier, country, **stateCode** (from doc), **geoCountryCode**, **geoStateCode** (from IP), retention expiry.
- **DocumentSubmission** – Type, status, **rejectionReason**, provider ref, storage ref, retention expiry.
- **SanctionsCheck** – Provider, result (CLEAR/HIT/ERROR), list names, timestamp.
- **JurisdictionRule** – **countryCode + stateCode** (unique). US: all 50 states + DC; stateCode `""` = country-level. Per-state per country for others (e.g. AU NSW, CA ON).
- **AuditLog** – action, resource, old/new value (redacted), IP, actor.
- **DataRetentionPolicy** – dataType, retainDays, action (ANONYMIZE/DELETE).

## Setup

```bash
cp .env.example .env
# Optional: GEO_API_KEY, KYC_WEBHOOK_SECRET, SANCTIONS_API_KEY, SANCTIONS_API_URL, RETENTION_DAYS_*

npm install
npx prisma generate
npx prisma db push
```

## Run

```bash
npm run dev
# or
npm run build && npm start
```

API base: `http://localhost:3001`

## Typical KYC flow

1. **Create subject** – `POST /api/kyc/subject` with `externalId` (e.g. user or wallet id). Response includes geo + jurisdiction (allowed, kycRequired, minAge).
2. **Submit documents** – `POST /api/kyc/subject/:subjectId/documents` for ID/PASSPORT, SELFIE, PROOF_OF_ADDRESS. Upload files to your storage; pass `storageRef` and optional `providerRef`/`providerName`.
3. **Provider callback** – When Sumsub/Jumio/Onfido completes verification, they call your `POST /api/kyc/webhook/document/:documentId/status` with signature. Send `status`, optional `rejectionReason`, and profile fields (countryCode, stateCode, dateOfBirth, firstName, lastName).
4. **Sanctions** – `POST /api/kyc/subject/:subjectId/sanctions` with name, DOB, country. Must be CLEAR for approval.
5. **Geo cross-check** – `POST /api/kyc/subject/:subjectId/geo-check` with document country/state; mismatch is logged and can block readiness.
6. **Readiness** – `GET /api/kyc/subject/:subjectId/readiness` shows whether the subject meets all checks (jurisdiction, sanctions, docs, geo, age) and lists missing/blocking items.
7. **Approve** – `PATCH /api/kyc/subject/:subjectId/status` with `"status": "APPROVED"` when all checks pass.

## API overview

### KYC subjects and geo

- `GET /api/kyc/subject/:externalId` – Get or create subject; returns subject + profile summary.
- `POST /api/kyc/subject` – Create subject and profile; runs geo + jurisdiction check from request IP.
- `GET /api/kyc/geo` – Current geo from request IP (country + **stateCode** for US) + jurisdiction result (for UI).
- `POST /api/kyc/subject/:subjectId/geo-check` – Body: `{ "docCountryCode": "US", "docStateCode?": "CA" }`. Cross-check IP country/state vs document; log match/mismatch.

### Documents and verification

- `POST /api/kyc/subject/:subjectId/documents` – Body: `{ "type": "PASSPORT"|"ID_CARD"|"SELFIE"|"PROOF_OF_ADDRESS", "providerRef?", "providerName?", "storageRef?", "metadata?" }`. Submit document (metadata only; store file elsewhere).
- **Webhook (verified)** – `POST /api/kyc/webhook/document/:documentId/status` – Raw JSON body; **signature verified** when `KYC_WEBHOOK_SECRET` is set (header `X-Webhook-Signature` or `X-Signature`: `sha256=<HMAC-SHA256(secret, rawBody)>`). Body: `{ "status": "APPROVED"|"REJECTED", "countryCode?", "stateCode?", "dateOfBirth?", "firstName?", "lastName?", "rejectionReason?" }`. Updates doc and optionally profile.
- **Manual (admin)** – `PATCH /api/kyc/documents/:documentId` – Body: same as webhook (status, rejectionReason, profile fields). For staff review without provider callback.
- `GET /api/kyc/subject/:subjectId/documents` – List documents (includes `rejectionReason` when rejected).
- `GET /api/kyc/subject/:subjectId/readiness` – **KYC readiness**: returns `ready`, `checks` (jurisdiction, sanctions, documents, geo, age), `missing[]`, `blocking[]`.
- `PATCH /api/kyc/subject/:subjectId/status` – Body: `{ "status": "PENDING"|"IN_REVIEW"|"APPROVED"|"REJECTED", "actorId?" }`. Set profile KYC status.

### Sanctions

- `POST /api/kyc/subject/:subjectId/sanctions` – Body: `{ "firstName", "lastName", "dateOfBirth?", "countryCode?" }`. Run sanctions check; persist result and audit.
- `GET /api/kyc/subject/:subjectId/sanctions` – List sanctions checks for subject.

### Audit

- `GET /api/kyc/subject/:subjectId/audit` – Query: `limit`, `offset`. List audit log for subject.

### Jurisdiction (per country + state)

- `GET /api/jurisdiction/rules` – List all rules; optional `?countryCode=US` to filter.
- `GET /api/jurisdiction/rules/:countryCode` – Get rule; use `?stateCode=CA` for US state (or other country state).
- `PUT /api/jurisdiction/rules` – Body: `{ "countryCode", "stateCode?" (e.g. "CA", "" for country-level), "allowed", "kycRequired", "minAge", "notes?" }`. Create or update rule.
- `POST /api/jurisdiction/seed` – Seed all 50 US states + DC + country-level for GB, DE, FR, AU, CA, NL, ES, IT, and restricted list. US states WA, UT, KY, LA, TX are restricted by default (verify local law).

### Data retention

- `GET /api/retention/policies` – List retention policies.
- `POST /api/retention/policies/seed` – Ensure default policies (DOCUMENTS, AUDIT, PII).
- `PATCH /api/retention/policies/:dataType` – Body: `{ "retainDays?", "action?" }`. Update policy.
- `POST /api/retention/run` – Run retention job (anonymize/delete per policy).

### Health

- `GET /health` – Returns `{ "status": "ok", "database": "connected", "webhookVerification": "enabled"|"disabled" }` or `503` with `status: "degraded"` if DB is down.

## Geo and sanctions providers

- **Geo**: Uses free ip-api.com by default. Set `GEO_API_KEY` and `GEO_API_URL` for a paid provider (MaxMind, ipinfo, etc.).
- **Sanctions**: Mock if `SANCTIONS_API_KEY` not set. Set `SANCTIONS_API_KEY` and `SANCTIONS_API_URL` to call your provider (e.g. ComplyAdvantage); request body shape may need to match provider.

## Data retention cron

Run periodically to anonymize/delete old data:

```bash
npm run retention:run
```

Or call `POST /api/retention/run`. Configure retention days in `.env` or via `PATCH /api/retention/policies/:dataType`.

## Pushing to GitHub

Repo: [lorddummy/casino-kyc-integration](https://github.com/lorddummy/casino-kyc-integration)

```bash
git init
git add .
git commit -m "KYC/AML integration: doc verification, sanctions, jurisdiction, geo cross-check, audit, retention"
git remote add origin https://github.com/lorddummy/casino-kyc-integration.git
git branch -M main
git push -u origin main
```

## Security notes

- **Webhook signatures** – When `KYC_WEBHOOK_SECRET` is set, `POST /api/kyc/webhook/document/:documentId/status` requires header `X-Webhook-Signature` (or `X-Signature`, `X-Hub-Signature-256`, `X-Sumsub-Signature`) with value `sha256=<HMAC-SHA256(secret, raw JSON body)>`. If unset, verification is skipped (dev only).
- **Admin endpoints** – Authenticate jurisdiction, retention, and status-change endpoints (e.g. API key middleware or IP allowlist); restrict `PATCH /documents/:documentId` and `PATCH /subject/:subjectId/status` to staff.
- Store document files in secure, access-controlled storage; only store references in DB.
- Use HTTPS in production; add rate limiting and PII encryption at rest as required by your jurisdiction.
