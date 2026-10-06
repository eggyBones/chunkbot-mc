// Typed decision failures. Every failure is explicit: there is no provider,
// model or billing fallback, and a failure never becomes a fabricated choice.
import type { DecisionFailure, DecisionFailureKind } from '../contracts/index.ts';

export class DecisionError extends Error {
  readonly failure: DecisionFailure;
  constructor(kind: DecisionFailureKind, detail: string, extra: Partial<Omit<DecisionFailure, 'kind' | 'detail'>> = {}) {
    super(`jev ${kind}: ${detail}`);
    this.name = 'DecisionError';
    this.failure = { kind, detail: detail.slice(0, 300), attempts: extra.attempts ?? 0, ...(extra.requestId ? { requestId: extra.requestId } : {}), ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}) };
  }
}

export function isDecisionError(error: unknown): error is DecisionError {
  return error instanceof DecisionError || (typeof error === 'object' && error !== null && 'failure' in error && typeof (error as { failure?: { kind?: unknown } }).failure?.kind === 'string');
}

/** Transient kinds receive at most one retry (if limits still allow). */
export const TRANSIENT_KINDS: ReadonlySet<DecisionFailureKind> = new Set(['rate_limited', 'transient', 'timeout']);

/**
 * Failures that mean the configured provider route cannot be trusted or used
 * for the rest of this application run (silent model/provider/price change,
 * unusable credentials or billing). The adapter refuses further calls.
 */
export const STICKY_KINDS: ReadonlySet<DecisionFailureKind> = new Set(['auth', 'payment', 'model_mismatch', 'route_changed', 'pricing_changed']);

/** Failures that leave the decision adapter unusable for the task (planner sees `decision_not_ready`). */
export const NOT_READY_KINDS: ReadonlySet<DecisionFailureKind> = new Set([
  'not_configured',
  'auth',
  'payment',
  'model_unavailable',
  'model_mismatch',
  'route_changed',
  'pricing_changed',
]);

/** Allowance/limit failures (planner sees `limit_exhausted`). */
export const LIMIT_KINDS: ReadonlySet<DecisionFailureKind> = new Set(['spend_cap', 'attempt_limit']);
