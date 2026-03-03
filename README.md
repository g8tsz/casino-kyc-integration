# Casino KYC Integration

KYC/AML integration for online casinos: **document verification**, **sanctions screening**, **jurisdiction rules**, **geo-location cross-check**, **audit logs**, and **data retention policies**.

## Features

- **Document verification** – Submit ID/passport/selfie/proof-of-address; track status (PENDING/APPROVED/REJECTED); webhook for provider callbacks (Sumsub, Jumio, Onfido).
- **Sanctions / AML checks** – Screen name (and DOB, country) against lists; pluggable provider (ComplyAdvantage, Chainalysis, or mock).
- **Jurisdiction rules** – Allow/block by country; require KYC level (NONE/BASIC/FULL) and min age per jurisdiction; seed defaults (US, GB, DE, restricted countries).
- **Geo cross-check** – Resolve country from IP; compare with document-derived country; log mismatch for review.
- **Audit logs** – Immutable log for every KYC action (doc submit/approve/reject, sanctions, geo check, status change, retention purge); PII redacted in logs.
- **Data retention** – Configurable policies per data type (DOCUMENTS, AUDIT, PII); anonymize or delete after retain days; run via API or cron (`npm run retention:run`).

## Data model

- **KycSubject** – External identity (e.g. wallet address).
- **KycProfile** – Status, tier, country, **stateCode** (from doc), **geoCountryCode**, **geoStateCode** (from IP), retention expiry.
- **DocumentSubmission** – Type, status, provider ref, storage ref, retention expiry.
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

## API overview

### KYC subjects and geo

- `GET /api/kyc/subject/:externalId` – Get or create subject; returns subject + profile summary.
- `POST /api/kyc/subject` – Create subject and profile; runs geo + jurisdiction check from request IP.
- `GET /api/kyc/geo` – Current geo from request IP (country + **stateCode** for US) + jurisdiction result (for UI).
- `POST /api/kyc/subject/:subjectId/geo-check` – Body: `{ "docCountryCode": "US", "docStateCode?": "CA" }`. Cross-check IP country/state vs document; log match/mismatch.

### Documents and verification

- `POST /api/kyc/subject/:subjectId/documents` – Body: `{ "type": "PASSPORT"|"ID_CARD"|"SELFIE"|"PROOF_OF_ADDRESS", "providerRef?", "providerName?", "storageRef?", "metadata?" }`. Submit document (metadata only; store file elsewhere).
- `POST /api/kyc/webhook/document/:documentId/status` – Body: `{ "status": "APPROVED"|"REJECTED", "countryCode?", "stateCode?", "dateOfBirth?", "firstName?", "lastName?" }`. Update doc status (e.g. from provider webhook); optionally update profile (including state for US).
- `GET /api/kyc/subject/:subjectId/documents` – List documents for subject.
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

- `GET /health` – `{ "status": "ok" }`.

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

- Verify webhook signatures (e.g. `KYC_WEBHOOK_SECRET`) before applying document status updates.
- Authenticate admin endpoints (jurisdiction, retention, status changes); restrict by IP or API key.
- Store document files in secure, access-controlled storage; only store references in DB.
- Use HTTPS in production; consider rate limiting and PII encryption at rest.
