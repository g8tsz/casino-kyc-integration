/**
 * Sanctions / AML screening: check name (and optional DOB, country) against lists.
 * Implementations: ComplyAdvantage, Chainalysis, Dow Jones, or mock for dev.
 */

export interface SanctionsRequest {
  firstName: string;
  lastName: string;
  dateOfBirth?: string;  // YYYY-MM-DD
  countryCode?: string;
}

export interface SanctionsResult {
  result: "CLEAR" | "HIT" | "ERROR";
  listNames?: string[];
  refId?: string;
  rawResponse?: string;  // redacted
  provider: string;
}

const MOCK_HIT_NAMES = new Set(["test hit", "hit test", "sanctions test"]);

/**
 * Run sanctions check. Uses mock if SANCTIONS_API_KEY not set; otherwise call external API.
 */
export async function runSanctionsCheck(
  req: SanctionsRequest,
  providerOverride?: string
): Promise<SanctionsResult> {
  const apiKey = process.env.SANCTIONS_API_KEY;
  const apiUrl = process.env.SANCTIONS_API_URL;

  if (apiKey && apiUrl) {
    try {
      const result = await callSanctionsProvider(apiUrl, apiKey, req);
      return { ...result, provider: providerOverride ?? "COMPLY_ADVANTAGE" };
    } catch (e) {
      return {
        result: "ERROR",
        provider: providerOverride ?? "EXTERNAL",
        rawResponse: (e as Error).message?.slice(0, 200),
      };
    }
  }

  return mockSanctionsCheck(req);
}

async function callSanctionsProvider(
  baseUrl: string,
  apiKey: string,
  req: SanctionsRequest
): Promise<Omit<SanctionsResult, "provider">> {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      first_name: req.firstName,
      last_name: req.lastName,
      date_of_birth: req.dateOfBirth,
      country: req.countryCode,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = (await res.json()) as { result?: string; matches?: { list?: string }[]; id?: string };
  const result = (data.result ?? (data as { clear?: boolean }).clear === true ? "CLEAR" : "HIT") as "CLEAR" | "HIT";
  const listNames = data.matches?.map((m) => m.list).filter(Boolean) as string[] | undefined;
  return {
    result: res.ok ? result : "ERROR",
    listNames,
    refId: (data as { id?: string }).id,
    rawResponse: undefined,
  };
}

function mockSanctionsCheck(req: SanctionsRequest): SanctionsResult {
  const full = `${(req.firstName + " " + req.lastName).toLowerCase()}`;
  const hit = MOCK_HIT_NAMES.has(full) || full.includes("hit");
  return {
    result: hit ? "HIT" : "CLEAR",
    listNames: hit ? ["MOCK_LIST"] : undefined,
    refId: "mock-" + Date.now(),
    provider: "MOCK",
  };
}
