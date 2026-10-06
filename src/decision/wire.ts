// Raw HTTP wire contract for the OpenRouter Decisions route, frozen from the
// verified G-02 evidence (docs/reviews/g-02-jev-wire.json, g-02-jev-price.json).
//
//   POST https://openrouter.ai/api/alpha/decisions
//   { model, state, questions: { <key>: { type: "choice", instructions, criteria } },
//     provider: { allow_fallbacks: false, max_price: { prompt, completion, request } } }
//   -> { model, answers: { <key>: { type: "choice", choice, probabilities, confidence } },
//        usage: { input_tokens, output_tokens, cost }, id, provider }
//
// Raw HTTP uses these snake_case fields directly; there is no SDK
// `decisionsRequest` wrapper. The question key is bookkeeping only, so its
// `instructions` carry the complete question.
import { z } from 'zod';
import type { DecisionFailureKind, JsonValue } from '../contracts/index.ts';
import { JEV_MAX_PRICE, maxCostForTokens, type VerifiedDecisionProfile } from './pricing.ts';

export const DEFAULT_JEV_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const QUESTION_KEY = 'next_action';

export interface WireRequestBody {
  model: string;
  state: JsonValue;
  questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }>;
  provider: { allow_fallbacks: false; max_price: { prompt: number; completion: number; request: number } };
}

export function buildRequestBody(model: string, state: JsonValue, instructions: string, criteria: Record<string, string>, maxPrice: WireRequestBody['provider']['max_price'] = JEV_MAX_PRICE): WireRequestBody {
  return {
    model,
    state,
    questions: { [QUESTION_KEY]: { type: 'choice', instructions, criteria } },
    provider: { allow_fallbacks: false, max_price: { ...maxPrice } },
  };
}

const finite01 = z.number().finite().min(0).max(1);

const ResponseSchema = z.object({
  model: z.string().min(1).max(200),
  provider: z.string().min(1).max(100),
  id: z.string().max(200).optional(),
  answers: z.object({
    [QUESTION_KEY]: z.object({
      type: z.literal('choice'),
      choice: z.string().min(1).max(64),
      probabilities: z.record(z.string().max(64), finite01),
      confidence: finite01,
    }),
  }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost: z.number().finite().nonnegative(),
  }),
});

export interface ValidatedDecision {
  model: string;
  provider: string;
  generationId?: string;
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** Evidence only (never used as proof of world success). */
  choiceIsArgmax: boolean;
  omittedOptions: number;
}

/** Usage of a response whose envelope, model, provider and price checks passed (trusted even when the answer is unusable). */
export interface TrustedUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
export type ValidationResult = { ok: true; value: ValidatedDecision } | { ok: false; kind: DecisionFailureKind; detail: string; usageTrusted?: TrustedUsage };

/** A dated snapshot of the requested model (`typesafe/jev-1.13-20260917`) or the exact requested id. */
export function modelMatches(requested: string, actual: string): boolean {
  if (actual === requested) return true;
  if (!actual.startsWith(`${requested}-`)) return false;
  return /^\d{8}$/.test(actual.slice(requested.length + 1));
}

export interface ValidationContext {
  requestedModel: string;
  criteriaKeys: readonly string[];
  /** Expected serving provider (fails closed on a route change); undefined accepts any. */
  expectedProvider: string | undefined;
  /** Verified route profile: serving context and price ceiling bound the reported usage. */
  profile: VerifiedDecisionProfile;
}

/**
 * Validates a parsed 200 response against the frozen envelope, the admitted
 * candidate IDs, a finite bounded complete probability distribution, the
 * requested model/provider and the pre-dispatch price/token bound.
 */
export function validateResponse(raw: unknown, ctx: ValidationContext): ValidationResult {
  const parsed = ResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, kind: 'invalid_response', detail: `envelope: ${issue ? `${issue.path.join('.') || '(root)'} ${issue.message}` : 'invalid'}` };
  }
  const r = parsed.data;
  if (!modelMatches(ctx.requestedModel, r.model)) {
    return { ok: false, kind: 'model_mismatch', detail: `requested ${ctx.requestedModel} but the response model is ${r.model.slice(0, 80)}` };
  }
  if (ctx.expectedProvider && r.provider !== ctx.expectedProvider) {
    return { ok: false, kind: 'route_changed', detail: `expected provider ${ctx.expectedProvider} but the response came from ${r.provider.slice(0, 60)}` };
  }
  const usage = { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, costUsd: r.usage.cost };
  if (usage.inputTokens > ctx.profile.contextTokens) {
    return { ok: false, kind: 'pricing_changed', detail: `reported ${usage.inputTokens} input tokens exceeds the verified serving context ${ctx.profile.contextTokens}` };
  }
  if (usage.costUsd > maxCostForTokens(usage.inputTokens, ctx.profile)) {
    return { ok: false, kind: 'pricing_changed', detail: `reported cost ${usage.costUsd} exceeds the price ceiling for ${usage.inputTokens} input tokens` };
  }
  const answer = r.answers[QUESTION_KEY];
  const admitted = new Set(ctx.criteriaKeys);
  // From here usage is trustworthy even if the answer is unusable.
  const trusted: TrustedUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd };
  if (!admitted.has(answer.choice)) return { ok: false, kind: 'invalid_response', detail: `choice ${answer.choice.slice(0, 40)} is not an offered option`, usageTrusted: trusted };
  const keys = Object.keys(answer.probabilities);
  const foreign = keys.filter((k) => !admitted.has(k));
  if (foreign.length > 0) return { ok: false, kind: 'invalid_response', detail: `probabilities name ${foreign.length} option(s) that were not offered`, usageTrusted: trusted };
  const sum = keys.reduce((n, k) => n + (answer.probabilities[k] ?? 0), 0);
  if (Math.abs(sum - 1) > 0.01) return { ok: false, kind: 'invalid_response', detail: `probabilities sum to ${sum.toFixed(4)}, not 1 (incomplete distribution)`, usageTrusted: trusted };
  const probabilities: Record<string, number> = {};
  for (const k of ctx.criteriaKeys) probabilities[k] = answer.probabilities[k] ?? 0;
  const max = Math.max(...Object.values(probabilities));
  const value: ValidatedDecision = {
    model: r.model,
    provider: r.provider,
    ...(r.id ? { generationId: r.id } : {}),
    choice: answer.choice,
    probabilities,
    confidence: answer.confidence,
    usage,
    choiceIsArgmax: (probabilities[answer.choice] ?? 0) >= max - 1e-9,
    omittedOptions: ctx.criteriaKeys.length - keys.length,
  };
  return { ok: true, value };
}

export interface HttpClassification {
  kind: DecisionFailureKind;
  detail: string;
  /** Whether the provider certainly ran no inference (reservation can be released). */
  noCharge: boolean;
}

/** Maps a non-200 status (or an error body) to an explicit failure kind. */
export function classifyHttp(status: number, bodyText: string): HttpClassification {
  let message = '';
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: unknown; code?: unknown } };
    if (j && typeof j.error?.message === 'string') message = j.error.message;
  } catch {
    // non-JSON error body
  }
  const said = message ? `: ${message.replace(/\s+/g, ' ').slice(0, 160)}` : '';
  switch (true) {
    case status === 401:
      return { kind: 'auth', detail: `HTTP 401 unauthorized${said}`, noCharge: true };
    case status === 403:
      return { kind: 'auth', detail: `HTTP 403 forbidden${said}`, noCharge: true };
    case status === 402:
      return { kind: 'payment', detail: `HTTP 402 payment required (no credits are purchased automatically)${said}`, noCharge: true };
    case status === 404:
      return { kind: 'model_unavailable', detail: `HTTP 404: no eligible endpoint for the requested model within the price ceiling, or the route is gone${said}`, noCharge: true };
    case status === 408:
      return { kind: 'timeout', detail: `HTTP 408 request timeout${said}`, noCharge: false };
    case status === 413:
      return { kind: 'request_too_large', detail: `HTTP 413 request too large${said}`, noCharge: true };
    case status === 400 || status === 422:
      return { kind: 'request_rejected', detail: `HTTP ${status} request rejected${said}`, noCharge: true };
    case status === 429:
      return { kind: 'rate_limited', detail: `HTTP 429 rate limited${said}`, noCharge: true };
    case status >= 500 && status <= 599:
      return { kind: 'transient', detail: `HTTP ${status} provider error${said}`, noCharge: false };
    default:
      return { kind: 'invalid_response', detail: `unexpected HTTP ${status}${said}`, noCharge: false };
  }
}
