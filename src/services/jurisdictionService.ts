import { prisma } from "../db/client.js";
import { US_STATE_CODES, US_STATES_RESTRICTED_BY_DEFAULT } from "../data/usStates.js";

export interface JurisdictionCheck {
  allowed: boolean;
  kycRequired: "NONE" | "BASIC" | "FULL";
  minAge: number;
  ruleId: string | null;
  countryCode: string;
  stateCode: string | null;
  message?: string;
}

/**
 * Check jurisdiction by country and optional state/region.
 * For US: pass stateCode (e.g. CA, TX) for state-level rule; otherwise falls back to country-level.
 * For other countries: stateCode null = country-level; or pass state/region code (e.g. AU NSW) if rules exist.
 */
export async function checkJurisdiction(
  countryCode: string,
  stateCode: string | null | undefined,
  defaultAllowed = false
): Promise<JurisdictionCheck> {
  const code = countryCode.trim().toUpperCase();
  const state = (stateCode?.trim().toUpperCase() || "").slice(0, 10);
  if (code.length !== 2) {
    return {
      allowed: false,
      kycRequired: "FULL",
      minAge: 18,
      ruleId: null,
      countryCode: code,
      stateCode: state || null,
      message: "Invalid country code",
    };
  }

  // Prefer state-specific rule, then country-level (stateCode "")
  const rule = await prisma.jurisdictionRule.findFirst({
    where: {
      countryCode: code,
      OR: state ? [{ stateCode: state }, { stateCode: "" }] : [{ stateCode: "" }],
    },
    orderBy: { stateCode: "desc" }, // non-empty stateCode first (e.g. "CA" before "")
  });

  if (rule) {
    return {
      allowed: rule.allowed,
      kycRequired: rule.kycRequired as "NONE" | "BASIC" | "FULL",
      minAge: rule.minAge,
      ruleId: rule.id,
      countryCode: code,
      stateCode: rule.stateCode || null,
      message: rule.notes ?? undefined,
    };
  }

  return {
    allowed: defaultAllowed,
    kycRequired: "FULL",
    minAge: code === "US" ? 21 : 18,
    ruleId: null,
    countryCode: code,
    stateCode: state || null,
    message: "No rule for country/state; using default",
  };
}

/**
 * Seed jurisdiction rules: all 50 US states + DC, plus country-level for others.
 * US: minAge 21, state-specific allowed/restricted; non-US: country-level with stateCode null.
 */
export async function seedDefaultJurisdictions() {
  const restrictedSet = new Set(US_STATES_RESTRICTED_BY_DEFAULT);

  // US country-level fallback when state is unknown (e.g. geo didn't return state)
  await prisma.jurisdictionRule.upsert({
    where: {
      countryCode_stateCode: { countryCode: "US", stateCode: "" },
    },
    create: {
      countryCode: "US",
      stateCode: "",
      allowed: true,
      kycRequired: "FULL",
      minAge: 21,
      notes: "US fallback when state unknown",
    },
    update: {
      allowed: true,
      kycRequired: "FULL",
      minAge: 21,
      notes: "US fallback when state unknown",
    },
  });

  for (const stateCode of US_STATE_CODES) {
    const allowed = !restrictedSet.has(stateCode as typeof US_STATES_RESTRICTED_BY_DEFAULT[number]);
    await prisma.jurisdictionRule.upsert({
      where: {
        countryCode_stateCode: { countryCode: "US", stateCode },
      },
      create: {
        countryCode: "US",
        stateCode,
        allowed,
        kycRequired: "FULL",
        minAge: 21,
        notes: allowed ? `US state: ${stateCode}` : `US state: ${stateCode} (restricted by default; verify local law)`,
      },
      update: {
        allowed,
        kycRequired: "FULL",
        minAge: 21,
        notes: allowed ? `US state: ${stateCode}` : `US state: ${stateCode} (restricted by default; verify local law)`,
      },
    });
  }

  const countryLevelDefaults = [
    { countryCode: "GB", stateCode: "", allowed: true, kycRequired: "FULL" as const, minAge: 18, notes: "United Kingdom" },
    { countryCode: "DE", stateCode: "", allowed: true, kycRequired: "FULL", minAge: 18, notes: "Germany" },
    { countryCode: "FR", stateCode: "", allowed: true, kycRequired: "FULL", minAge: 18, notes: "France" },
    { countryCode: "AU", stateCode: "", allowed: true, kycRequired: "FULL", minAge: 18, notes: "Australia (country-level; add stateCode for NSW, VIC, etc. if needed)" },
    { countryCode: "CA", stateCode: "", allowed: true, kycRequired: "FULL", minAge: 18, notes: "Canada (country-level; add stateCode for ON, QC, etc. if needed)" },
    { countryCode: "NL", stateCode: "", allowed: true, kycRequired: "FULL", minAge: 18, notes: "Netherlands" },
    { countryCode: "ES", stateCode: "", allowed: true, kycRequired: "FULL", minAge: 18, notes: "Spain" },
    { countryCode: "IT", stateCode: "", allowed: true, kycRequired: "FULL", minAge: 18, notes: "Italy" },
    { countryCode: "KP", stateCode: "", allowed: false, kycRequired: "NONE", minAge: 18, notes: "Restricted" },
    { countryCode: "IR", stateCode: "", allowed: false, kycRequired: "NONE", minAge: 18, notes: "Restricted" },
    { countryCode: "CU", stateCode: "", allowed: false, kycRequired: "NONE", minAge: 18, notes: "Restricted" },
    { countryCode: "SY", stateCode: "", allowed: false, kycRequired: "NONE", minAge: 18, notes: "Restricted" },
  ];

  for (const r of countryLevelDefaults) {
    await prisma.jurisdictionRule.upsert({
      where: {
        countryCode_stateCode: { countryCode: r.countryCode, stateCode: r.stateCode },
      },
      create: {
        countryCode: r.countryCode,
        stateCode: r.stateCode,
        allowed: r.allowed,
        kycRequired: r.kycRequired,
        minAge: r.minAge,
        notes: r.notes ?? null,
      },
      update: {
        allowed: r.allowed,
        kycRequired: r.kycRequired,
        minAge: r.minAge,
        notes: r.notes ?? null,
      },
    });
  }
}
