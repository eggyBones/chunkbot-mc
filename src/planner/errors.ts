// Typed planner failures (no planner model, provider or billing fallback).
import type { PlannerFailure, PlannerFailureKind } from '../contracts/index.ts';

export class PlannerError extends Error {
  readonly failure: PlannerFailure;
  constructor(kind: PlannerFailureKind, detail: string, problems?: string[]) {
    super(`${kind}: ${detail}`);
    this.name = 'PlannerError';
    this.failure = { kind, detail, ...(problems ? { problems } : {}) };
  }
}

export function isPlannerError(e: unknown): e is PlannerError {
  return e instanceof PlannerError || (Boolean(e) && typeof e === 'object' && (e as { name?: string }).name === 'PlannerError' && 'failure' in (e as object));
}

/**
 * Classifies a CLI/stream error message. Subscription limits and sign-in
 * problems are reported with actionable text; they never trigger a fallback.
 */
export function classifyPlannerMessage(message: string): PlannerFailureKind {
  const m = message.toLowerCase();
  if (/model rerouted|rerouted to|fallback model/.test(m)) return 'model_mismatch';
  if (/usage limit|rate limit|quota|too many requests|\b429\b|limit reached|exceeded your|plan limit|credits/.test(m)) return 'quota';
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|not logged in|log ?in again|sign[ -]?in|authenticat|expired (access )?token|refresh token|codex login/.test(m)) return 'auth';
  if (/model[^.]{0,60}(not found|not supported|unsupported|unavailable|does not exist|not available)|unknown model|\b404\b/.test(m)) return 'model_unavailable';
  if (/timed? ?out|timeout/.test(m)) return 'timeout';
  return 'process_error';
}

/** Actionable owner/operator text for a planner failure (never suggests paid fallbacks). */
export function plannerFailureAdvice(kind: PlannerFailureKind): string {
  switch (kind) {
    case 'auth':
      return 'the Codex subscription sign-in is missing or expired; the operator must sign in with `codex login` (ChatGPT) — no API-key or other planner is used instead';
    case 'quota':
      return 'the Codex subscription usage limit was reached; wait for the limit to reset — no paid or alternative planner is used instead';
    case 'model_unavailable':
      return 'the selected planner model is not available to this subscription; no other model is substituted';
    case 'model_mismatch':
      return 'the CLI reported a model reroute/fallback; the planner is disabled for this run (no fallback model is accepted)';
    case 'prohibited_event':
      return 'the planner turn emitted a tool/agent event despite the isolation profile; the planner is disabled for this run';
    case 'not_ready':
      return 'the planner isolation gate did not pass (see doctor)';
    default:
      return 'bounded planner failure';
  }
}
