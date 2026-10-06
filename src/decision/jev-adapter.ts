// Real raw-HTTP OpenRouter Jev adapter (DecisionPort).
//
// Per decision: one request in flight; a minimum interval between attempt
// starts; every attempt (including a transient retry and ambiguous requests)
// counts toward the per-goal allowance; a conservative charge is reserved in
// the per-run SpendLedger before dispatch and the call is refused if the cap
// cannot be guaranteed; attempts are abortable (owner revocation) and timed
// out; at most ONE retry for timeout/429/5xx when limits still allow; auth,
// payment, missing model/route, request and schema errors are explicit. Model,
// provider or price drift fails closed for the rest of the run. The API key is
// read from the configured environment variable at call time and never enters
// evidence, errors, prompts or source.
import type { Clock, DecisionChoice, DecisionFailureKind, DecisionPort, DecisionRequest, Readiness, RunStore } from '../contracts/index.ts';
import { bodyFor } from './context.ts';
import { DecisionError, STICKY_KINDS, TRANSIENT_KINDS } from './errors.ts';
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, maxAttemptChargeUsd, verifiedProfile, type VerifiedDecisionProfile } from './pricing.ts';
import type { SpendLedger, SpendReservation } from './spend.ts';
import { DEFAULT_JEV_ENDPOINT, classifyHttp, validateResponse } from './wire.ts';

export interface JevAdapterOptions {
  endpoint?: string;
  model: string;
  /** Environment variable NAME holding the key (the value is read per call, never stored). */
  apiKeyEnv: string;
  env: () => Record<string, string | undefined>;
  /** Fail closed when a response comes from another provider (default TypeSafe). */
  expectedProvider: string | undefined;
  spend: SpendLedger;
  store: RunStore;
  clock: Clock;
  timeoutMs: number;
  minIntervalMs: number;
  attemptsPerGoal: number;
  /** Longest Retry-After honored for the single transient retry. */
  maxRetryAfterMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface JevAdapterStats {
  attempts: number;
  decisions: number;
  failures: Partial<Record<DecisionFailureKind, number>>;
  lastModel?: string;
  lastProvider?: string;
  lastLatencyMs?: number;
  sticky?: { kind: DecisionFailureKind; detail: string };
  inFlight: boolean;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type AttemptResult =
  | { ok: true; choice: DecisionChoice }
  | { ok: false; kind: DecisionFailureKind; detail: string; httpStatus?: number; retryAfterMs?: number };

export class JevDecisionAdapter implements DecisionPort {
  private readonly o: JevAdapterOptions;
  private readonly endpoint: string;
  /** Verified pricing/context profile for the configured route; undefined refuses every call. */
  private readonly profile: VerifiedDecisionProfile | undefined;
  private inFlight = false;
  private lastAttemptStartMs: number | undefined;
  private readonly perGoal = new Map<string, number>();
  private sticky: { kind: DecisionFailureKind; detail: string } | undefined;
  private readonly stats: JevAdapterStats = { attempts: 0, decisions: 0, failures: {}, inFlight: false };

  constructor(options: JevAdapterOptions) {
    this.o = options;
    this.endpoint = options.endpoint ?? DEFAULT_JEV_ENDPOINT;
    const profile = verifiedProfile(options.model);
    // The charge bound applies only to the verified route: same model AND the verified serving provider.
    this.profile = profile && options.expectedProvider === profile.provider ? profile : undefined;
  }

  /** Conservative maximum charge reserved before every attempt (undefined: unverified route). */
  get maxAttemptChargeUsd(): number | undefined {
    return this.profile ? maxAttemptChargeUsd(this.profile) : undefined;
  }

  private unverifiedDetail(): string {
    return `no verified pricing/context profile for model ${this.o.model} with provider ${this.o.expectedProvider ?? '(any)'}; the pre-dispatch charge bound cannot be guaranteed, so no request is sent`;
  }

  get model(): string {
    return this.o.model;
  }

  private keyPresent(): boolean {
    return Boolean(this.o.env()[this.o.apiKeyEnv]);
  }

  readiness(): Readiness {
    if (this.sticky) return { ready: false, detail: `Jev disabled for this run after ${this.sticky.kind}: ${this.sticky.detail}` };
    if (!this.profile) return { ready: false, detail: this.unverifiedDetail() };
    if (!this.keyPresent()) return { ready: false, detail: `Jev adapter installed (${this.o.model}) but ${this.o.apiKeyEnv} is not set; no decisions can be made` };
    const remaining = this.o.spend.remainingUsd();
    if (remaining < maxAttemptChargeUsd(this.profile)) {
      return { ready: false, detail: `OpenRouter spend cap USD ${this.o.spend.capUsd} for this run cannot cover another request (remaining ${remaining.toFixed(6)})` };
    }
    return { ready: true, detail: `Jev ${this.o.model} via ${this.endpoint === DEFAULT_JEV_ENDPOINT ? 'OpenRouter' : `fault-fixture endpoint ${this.endpoint}`}; spend remaining USD ${remaining.toFixed(6)} of ${this.o.spend.capUsd}` };
  }

  snapshotStats(): JevAdapterStats {
    return { ...this.stats, failures: { ...this.stats.failures }, ...(this.sticky ? { sticky: { ...this.sticky } } : {}), inFlight: this.inFlight };
  }

  attemptsForGoal(goalId: string): number {
    return this.perGoal.get(goalId) ?? 0;
  }

  private fail(kind: DecisionFailureKind, detail: string, request: DecisionRequest, attempts: number, httpStatus?: number): DecisionError {
    this.stats.failures[kind] = (this.stats.failures[kind] ?? 0) + 1;
    if (STICKY_KINDS.has(kind) && !this.sticky) {
      this.sticky = { kind, detail: detail.slice(0, 200) };
      this.o.store.record({ type: 'jev_disabled_for_run', kind, detail: this.sticky.detail });
    }
    return new DecisionError(kind, detail, { attempts, requestId: request.requestId, ...(httpStatus !== undefined ? { httpStatus } : {}) });
  }

  async choose(request: DecisionRequest, signal: AbortSignal): Promise<DecisionChoice> {
    if (this.inFlight) throw new DecisionError('busy', 'another Jev request is already in flight (one at a time)', { requestId: request.requestId });
    this.inFlight = true;
    let attempts = 0;
    try {
      if (this.sticky) throw this.fail(this.sticky.kind, `adapter disabled for this run: ${this.sticky.detail}`, request, 0);
      const profile = this.profile;
      if (!profile) throw this.fail('not_configured', this.unverifiedDetail(), request, 0);
      const key = this.o.env()[this.o.apiKeyEnv];
      if (!key) throw this.fail('not_configured', `${this.o.apiKeyEnv} is not set`, request, 0);
      if (request.candidates.length === 0) throw this.fail('request_rejected', 'no candidates to choose from', request, 0);
      const body = JSON.stringify(bodyFor(this.o.model, request, profile.maxPrice));
      const bytes = Buffer.byteLength(body, 'utf8');
      const maxBytes = this.o.maxRequestBytes ?? MAX_REQUEST_BYTES;
      if (bytes > maxBytes) throw this.fail('request_too_large', `serialized request is ${bytes} bytes; the bound is ${maxBytes}`, request, 0);
      // MB-JEV-001: reserve the full serving-context charge at the admitted ceiling before EVERY attempt.
      const maxCharge = maxAttemptChargeUsd(profile);
      const criteriaKeys = request.candidates.map((c) => c.id);
      let retryAfterMs = 0;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (signal.aborted) throw this.fail('aborted', 'owning task was revoked before dispatch', request, attempts);
        const used = this.perGoal.get(request.goalId) ?? 0;
        if (used >= this.o.attemptsPerGoal) throw this.fail('attempt_limit', `goal used all ${this.o.attemptsPerGoal} Jev attempts`, request, attempts);
        // Minimum interval between attempt starts (and any honored Retry-After).
        const now = this.o.clock.now();
        const wait = Math.max(this.lastAttemptStartMs === undefined ? 0 : this.lastAttemptStartMs + this.o.minIntervalMs - now, retryAfterMs);
        if (wait > 0) {
          try {
            await (this.o.sleep ?? defaultSleep)(wait, signal);
          } catch {
            throw this.fail('aborted', 'owning task was revoked while waiting for the request interval', request, attempts);
          }
        }
        const reservation = this.o.spend.reserve(maxCharge, request.requestId);
        if (!reservation) {
          const snap = this.o.spend.snapshot();
          throw this.fail('spend_cap', `OpenRouter spend cap USD ${snap.capUsd} for this run cannot guarantee another request (remaining ${snap.remainingUsd.toFixed(6)}, needs the full serving-context maximum ${maxCharge.toFixed(6)})`, request, attempts);
        }
        attempts += 1;
        this.stats.attempts += 1;
        this.perGoal.set(request.goalId, used + 1);
        if (this.perGoal.size > 32) this.perGoal.delete(this.perGoal.keys().next().value as string);
        this.lastAttemptStartMs = this.o.clock.now();
        this.o.store.record({
          type: 'jev_request',
          requestId: request.requestId,
          attempt,
          goalId: request.goalId,
          goalEpoch: request.goalEpoch,
          taskId: request.taskId,
          connectionEpoch: request.connectionEpoch,
          snapshotId: request.snapshotId,
          requestedModel: this.o.model,
          endpoint: this.endpoint === DEFAULT_JEV_ENDPOINT ? 'openrouter' : 'fault_fixture',
          options: request.candidates.map((c) => ({ id: c.id, capability: c.capability, description: c.description.slice(0, 120) })),
          requestBytes: bytes,
          contextTokens: profile.contextTokens,
          reservationUsd: reservation.amountUsd,
          reservationBasis: 'serving_context_x_admitted_prompt_price',
        });
        const result = await this.attempt(body, key, request, reservation, criteriaKeys, profile, attempt, signal);
        if (result.ok) {
          this.stats.decisions += 1;
          return { ...result.choice, attempts };
        }
        const retryable = TRANSIENT_KINDS.has(result.kind) && attempt === 1 && !signal.aborted && (result.retryAfterMs ?? 0) <= (this.o.maxRetryAfterMs ?? 5_000);
        this.o.store.record({ type: 'jev_failure', requestId: request.requestId, attempt, kind: result.kind, detail: result.detail, httpStatus: result.httpStatus ?? null, willRetry: retryable, spend: this.o.spend.snapshot() });
        if (!retryable) throw this.fail(result.kind, result.detail, request, attempts, result.httpStatus);
        retryAfterMs = result.retryAfterMs ?? 0;
      }
      throw this.fail('transient', 'retry budget exhausted', request, attempts);
    } finally {
      this.inFlight = false;
    }
  }

  /** One HTTP attempt; settles the reservation (reconcile / release / retain) before returning. */
  private async attempt(body: string, key: string, request: DecisionRequest, reservation: SpendReservation, criteriaKeys: string[], profile: VerifiedDecisionProfile, attempt: number, signal: AbortSignal): Promise<AttemptResult> {
    const started = this.o.clock.now();
    const local = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      local.abort(new Error('timeout'));
    }, this.o.timeoutMs);
    const onAbort = () => local.abort(new Error('revoked'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const elapsed = () => Math.max(0, this.o.clock.now() - started);
    const ambiguous = (kind: DecisionFailureKind, detail: string, httpStatus?: number): AttemptResult => {
      this.o.spend.retain(reservation);
      return { ok: false, kind, detail: `${detail} (charge ambiguous: reservation USD ${reservation.amountUsd.toFixed(6)} retained)`, ...(httpStatus !== undefined ? { httpStatus } : {}) };
    };
    try {
      let response: Response;
      try {
        response = await (this.o.fetch ?? fetch)(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
          body,
          signal: local.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (signal.aborted) return ambiguous('aborted', 'owning task was revoked during the request');
        if (timedOut) return ambiguous('timeout', `no response within ${this.o.timeoutMs}ms`);
        return ambiguous('transient', `network error: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`);
      }
      let text: string;
      try {
        text = await readBounded(response, this.o.maxResponseBytes ?? MAX_RESPONSE_BYTES);
      } catch (error) {
        if (signal.aborted) return ambiguous('aborted', 'owning task was revoked while reading the response', response.status);
        if (timedOut) return ambiguous('timeout', `response body not complete within ${this.o.timeoutMs}ms`, response.status);
        return ambiguous('invalid_response', error instanceof Error ? error.message.slice(0, 160) : 'response read failed', response.status);
      }
      const latencyMs = elapsed();
      if (signal.aborted) return ambiguous('aborted', 'owning task was revoked before the response could be used', response.status);
      if (response.status !== 200) {
        const c = classifyHttp(response.status, text);
        if (c.noCharge) this.o.spend.release(reservation);
        else this.o.spend.retain(reservation);
        const ra = Number(response.headers.get('retry-after'));
        return { ok: false, kind: c.kind, detail: `${c.detail}${c.noCharge ? '' : ' (charge ambiguous: reservation retained)'}`, httpStatus: response.status, ...(Number.isFinite(ra) && ra > 0 ? { retryAfterMs: ra * 1000 } : {}) };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return ambiguous('invalid_response', 'HTTP 200 body is not JSON', 200);
      }
      if (raw && typeof raw === 'object' && 'error' in raw && !('answers' in raw)) {
        const c = classifyHttp(Number((raw as { error?: { code?: unknown } }).error?.code) || 500, text);
        return ambiguous(c.kind, `HTTP 200 with error body: ${c.detail}`, 200);
      }
      const v = validateResponse(raw, { requestedModel: this.o.model, criteriaKeys, expectedProvider: this.o.expectedProvider, profile });
      if (!v.ok) {
        if (v.usageTrusted) this.o.spend.reconcile(reservation, v.usageTrusted.costUsd);
        else this.o.spend.retain(reservation);
        return { ok: false, kind: v.kind, detail: v.detail, httpStatus: 200 };
      }
      this.o.spend.reconcile(reservation, v.value.usage.costUsd);
      this.stats.lastModel = v.value.model;
      this.stats.lastProvider = v.value.provider;
      this.stats.lastLatencyMs = latencyMs;
      this.o.store.record({
        type: 'jev_response',
        requestId: request.requestId,
        attempt,
        httpStatus: 200,
        latencyMs,
        requestedModel: this.o.model,
        model: v.value.model,
        provider: v.value.provider,
        generationId: v.value.generationId ?? null,
        choice: v.value.choice,
        probabilities: v.value.probabilities,
        confidence: v.value.confidence,
        choiceIsArgmax: v.value.choiceIsArgmax,
        omittedOptions: v.value.omittedOptions,
        usage: v.value.usage,
        spend: this.o.spend.snapshot(),
      });
      return {
        ok: true,
        choice: {
          requestId: request.requestId,
          candidateId: v.value.choice,
          confidence: v.value.confidence,
          probabilities: v.value.probabilities,
          requestedModel: this.o.model,
          model: v.value.model,
          provider: v.value.provider,
          ...(v.value.generationId ? { generationId: v.value.generationId } : {}),
          usage: v.value.usage,
          latencyMs,
          attempts: attempt,
        },
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

/** Reads at most `max` bytes; larger bodies are cancelled and rejected. */
export async function readBounded(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`response body declares ${declared} bytes; the bound is ${max}`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response body exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
