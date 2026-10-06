// Conservative pre-dispatch charge bound for Jev decisions (MB-JEV-001).
//
// Only a VERIFIED route/model profile may be used. For the supported route the
// evidence is: G-02 and the price probe (docs/reviews/g-02-jev-wire.md,
// g-02-jev-price.json), plus the public endpoint listing
// GET https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints
// (read 2026-10-05). It shows exactly one endpoint, TypeSafe
// `typesafe/jev-1.13-20260917`, with prompt USD 0.000000042/token (0.042 per
// million), completion 0 and a serving context of 32,000 tokens. The Decisions
// route honors `provider.max_price` with fallbacks disabled: a zero prompt
// ceiling returned 404 (no eligible endpoint) and the admitted ceiling returned
// 200. Every request carries that ceiling, so a price increase or route change
// fails closed (404) before inference.
//
// Maximum charge for ONE attempt (the reservation):
//   serving context tokens * admitted prompt price + admitted request price
//   = 32,000 * 0.000000042 + 0 = USD 0.001344
// Provider templating overhead is not caller-controlled, so it is not
// estimated: no request, however the provider expands it, can bill more input
// than the serving context at more than the admitted per-token ceiling.
// Completion and per-request ceilings are zero, so output tokens cannot be
// billed through this route. The coordinator decision (MB-JEV-001) is to use
// this proven ceiling rather than an inferred overhead estimate.
//
// The serialized request body stays independently bounded (MAX_REQUEST_BYTES),
// far inside the context. After a response, usage above the context or a cost
// above tokens * ceiling is a pricing/route change: it fails closed for the
// run. Such a post-response check cannot undo a charge; only the pre-dispatch
// reservation guarantees the cap.

export interface VerifiedDecisionProfile {
  /** Requested model id this profile was verified for. */
  model: string;
  /** Serving provider verified for the route. */
  provider: string;
  /** Advertised serving context of the only eligible endpoint (tokens). */
  contextTokens: number;
  /** `provider.max_price` sent with every request (USD per million tokens; request in USD). */
  maxPrice: { prompt: number; completion: number; request: number };
  evidence: string;
}

/** The only verified route/model profiles. A configured model outside this table is refused. */
export const VERIFIED_DECISION_PROFILES: Readonly<Record<string, VerifiedDecisionProfile>> = {
  'typesafe/jev-1.13': {
    model: 'typesafe/jev-1.13',
    provider: 'TypeSafe',
    contextTokens: 32_000,
    maxPrice: { prompt: 0.042, completion: 0, request: 0 },
    evidence: 'G-02 wire + price probe (2026-10-05); public endpoint listing: TypeSafe typesafe/jev-1.13-20260917, context 32000, prompt 0.000000042/token, completion 0',
  },
};

export function verifiedProfile(model: string): VerifiedDecisionProfile | undefined {
  return Object.hasOwn(VERIFIED_DECISION_PROFILES, model) ? VERIFIED_DECISION_PROFILES[model] : undefined;
}

const SUPPORTED = VERIFIED_DECISION_PROFILES['typesafe/jev-1.13']!;
/** Price ceiling of the supported route (kept for callers and evidence). */
export const JEV_MAX_PRICE = SUPPORTED.maxPrice;
export const PROMPT_USD_PER_TOKEN = SUPPORTED.maxPrice.prompt / 1_000_000;
/** Serving context of the supported route. */
export const JEV_CONTEXT_TOKENS = SUPPORTED.contextTokens;
/** Largest serialized request body we dispatch (independent of the charge bound). */
export const MAX_REQUEST_BYTES = 16_384;
/** Largest response body we read and parse. */
export const MAX_RESPONSE_BYTES = 65_536;

/** USD per prompt token for a profile. */
export function promptUsdPerToken(profile: VerifiedDecisionProfile): number {
  return profile.maxPrice.prompt / 1_000_000;
}

/** The conservative maximum one attempt can be billed on this route: full serving context at the admitted ceiling. */
export function maxAttemptChargeUsd(profile: VerifiedDecisionProfile = SUPPORTED): number {
  return profile.contextTokens * promptUsdPerToken(profile) + profile.maxPrice.request;
}

/** The most a response with `inputTokens` may cost under the price ceiling (plus float tolerance). */
export function maxCostForTokens(inputTokens: number, profile: VerifiedDecisionProfile = SUPPORTED): number {
  return inputTokens * promptUsdPerToken(profile) * (1 + 1e-6) + profile.maxPrice.request + 1e-9;
}

// Our own content (bytes >= tokens for byte-level/byte-fallback tokenizers) stays far inside the context.
if (MAX_REQUEST_BYTES >= SUPPORTED.contextTokens) throw new Error('MAX_REQUEST_BYTES must stay inside the serving context');
