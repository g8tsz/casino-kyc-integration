/**
 * All 50 US states + DC and territories for jurisdiction rules.
 * stateCode: ISO 3166-2 or common 2-letter code.
 */
export const US_STATE_CODES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA",
  "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX",
  "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

/** States where online gambling is typically restricted (operator must verify local law) */
export const US_STATES_RESTRICTED_BY_DEFAULT = ["WA", "UT", "KY", "LA", "TX"] as const;

export type UsStateCode = (typeof US_STATE_CODES)[number];
