/**
 * Geo-location service: resolve country (and optional region) from IP.
 * Cross-check with document-derived country for KYC consistency.
 * Plug in MaxMind, ipinfo.io, or ip-api.com in production.
 */

const FWD_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] as const;

export interface GeoResult {
  countryCode: string;  // ISO 3166-1 alpha-2
  stateCode?: string;   // state/region code (e.g. US: CA, TX; AU: NSW)
  region?: string;      // full region name (e.g. "California")
  city?: string;
  source: "header" | "api" | "mock";
}

/**
 * Extract client IP from request (respects proxies).
 */
export function getClientIp(headers: Record<string, string | string[] | undefined>): string | null {
  for (const h of FWD_HEADERS) {
    const v = headers[h];
    if (typeof v === "string") {
      const ip = v.split(",")[0]?.trim();
      if (ip) return ip;
    }
    if (Array.isArray(v) && v[0]) return String(v[0]).split(",")[0]?.trim() ?? null;
  }
  return null;
}

/**
 * Resolve country from IP. Uses free ip-api.com (no key) or mock for localhost/private IPs.
 * For production, set GEO_API_KEY and use a paid provider (MaxMind, ipinfo, etc.).
 */
export async function getGeoFromIp(ip: string | null): Promise<GeoResult | null> {
  if (!ip || isPrivateOrLocal(ip)) {
    return { countryCode: "XX", source: "mock" };
  }
  const apiKey = process.env.GEO_API_KEY;
  if (apiKey && process.env.GEO_API_URL) {
    return fetchGeoFromProvider(process.env.GEO_API_URL, ip, apiKey);
  }
  return fetchFromIpApi(ip);
}

function isPrivateOrLocal(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("172.")) return true;
  return false;
}

// US state/territory name → 2-letter code (ip-api returns regionName; some APIs return name)
const US_STATE_NAME_TO_CODE: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO",
  Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY",
  Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN",
  Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH",
  "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
  Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA",
  Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  Guam: "GU", "Puerto Rico": "PR", "Virgin Islands": "VI",
};

function normalizeStateCode(countryCode: string, regionCode?: string | null, regionName?: string | null): string | undefined {
  const code = (regionCode ?? "").trim().toUpperCase();
  if (code.length >= 2 && code.length <= 3) return code; // e.g. CA, NSW
  if (countryCode === "US" && regionName) {
    const mapped = US_STATE_NAME_TO_CODE[regionName.trim()];
    if (mapped) return mapped;
  }
  return undefined;
}

async function fetchFromIpApi(ip: string): Promise<GeoResult | null> {
  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=countryCode,region,regionName,city`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { countryCode?: string; region?: string; regionName?: string; city?: string };
    if (data.countryCode) {
      const countryCode = data.countryCode;
      const stateCode = normalizeStateCode(countryCode, data.region, data.regionName);
      return {
        countryCode,
        stateCode: stateCode ?? undefined,
        region: data.regionName ?? data.region,
        city: data.city,
        source: "api",
      };
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchGeoFromProvider(
  baseUrl: string,
  ip: string,
  apiKey: string
): Promise<GeoResult | null> {
  try {
    const url = baseUrl.includes("?") ? `${baseUrl}&ip=${encodeURIComponent(ip)}` : `${baseUrl}?ip=${encodeURIComponent(ip)}`;
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${apiKey}`, "X-API-Key": apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { country_code?: string; countryCode?: string; region?: string; region_code?: string; state?: string; city?: string };
    const code = data.country_code ?? data.countryCode;
    const stateCode = data.region_code ?? data.state ?? data.region;
    if (code) {
      const countryCode = typeof code === "string" ? code.toUpperCase() : code;
      return {
        countryCode,
        stateCode: stateCode ? String(stateCode).trim().toUpperCase().slice(0, 10) : undefined,
        region: data.region ?? data.state,
        city: data.city,
        source: "api",
      };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Cross-check: document country vs geo country. Mismatch can trigger review.
 */
export function geoMatchesDocument(geoCountry: string | null, docCountry: string | null): boolean {
  if (!geoCountry || !docCountry) return true; // no claim to compare
  return geoCountry.toUpperCase() === docCountry.toUpperCase();
}

/**
 * Cross-check state/region when both sides have it (e.g. US state, AU state).
 */
export function geoMatchesDocumentState(
  geoCountry: string | null,
  geoState: string | null,
  docCountry: string | null,
  docState: string | null
): boolean {
  if (!geoCountry || !docCountry || geoCountry.toUpperCase() !== docCountry.toUpperCase()) return false;
  if (!geoState || !docState) return true; // no state to compare
  return geoState.toUpperCase() === docState.toUpperCase();
}
