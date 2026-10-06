// Typed usage projection for the dashboard.
//
// Sources (no terminal text, no log tailing):
// - SpendLedger.snapshot(): the authoritative per-run accounting (reserved,
//   reconciled, retained, released, refused, cap, remaining);
// - validated Jev evidence events through a store tee: `jev_request` (retries),
//   `jev_response` (validated usage), `jev_failure` (kind; trusted usage of a
//   charged-but-unusable answer when the adapter reports it);
// - planner evidence events `planner_turn_*` (per-turn usage; `null` usage or a
//   `null` breakdown field means NOT REPORTED) and CodexPlanner.totals (turn
//   counts).
//
// Cumulative ledger values reach the dated aggregates as deltas against a
// per-run cursor committed together with the delta (MB-UI-001-C2), so
// repeated or out-of-order observations never double count and never go
// backwards. Event-derived usage is deduplicated by identity. Costs always come
// from the ledger, never from event payloads (no double charge). The
// aggregates are display-only: nothing here can reserve, release or replenish
// spending allowance.
import { z } from 'zod';
import type { EvidenceEvent } from '../contracts/index.ts';
import { usdToNano, known, unknown, type DayJev, type DayPlanner, type JevSessionUsage, type Known, type PlannerSessionUsage } from '../contracts/dashboard.ts';

/** Structural copy of SpendLedger's snapshot (src/decision/spend.ts). */
export interface SpendSnapshotLike {
  capUsd: number;
  reconciledUsd: number;
  retainedUsd: number;
  outstandingUsd: number;
  remainingUsd: number;
  attempts: number;
  reconciled: number;
  retained: number;
  released: number;
  refused: number;
}

/** Structural slice of CodexPlanner.totals used for turn COUNTS only. */
export interface PlannerTotalsLike {
  turns: number;
  completedTurns: number;
  failedTurns: number;
}

const nn = z.number().int().nonnegative();
const reqId = z.string().min(1).max(64);
const attemptN = z.number().int().min(1).max(4);
const JevRequestEvent = z.object({ type: z.literal('jev_request'), requestId: reqId, attempt: attemptN }).passthrough();
const JevResponseEvent = z
  .object({ type: z.literal('jev_response'), requestId: reqId, attempt: attemptN, usage: z.object({ inputTokens: nn, outputTokens: nn, costUsd: z.number().finite().nonnegative() }).passthrough() })
  .passthrough();
/** Trusted usage of a charged failure: cost is in the ledger already; tokens may or may not be reported. */
const TrustedUsage = z.object({ inputTokens: nn.optional(), outputTokens: nn.optional(), costUsd: z.number().finite().nonnegative().optional() }).passthrough();
const JevFailureEvent = z
  .object({ type: z.literal('jev_failure'), requestId: reqId, attempt: attemptN, usage: TrustedUsage.nullable().optional(), usageTrusted: TrustedUsage.nullable().optional() })
  .passthrough();
const PlannerStarted = z.object({ type: z.literal('planner_turn_started'), requestId: reqId, turn: nn }).passthrough();
const PlannerCompleted = z
  .object({
    type: z.literal('planner_turn_completed'),
    requestId: reqId,
    turn: nn,
    usage: z
      .object({ inputTokens: nn, outputTokens: nn, cachedInputTokens: nn.nullable().optional(), reasoningOutputTokens: nn.nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
const PlannerFailed = z.object({ type: z.literal('planner_turn_failed'), requestId: reqId, turn: nn }).passthrough();

export interface JevDayDelta extends Partial<DayJev> {}
export interface PlannerDayDelta extends Partial<DayPlanner> {}

export interface LedgerCursor {
  attempts: number;
  reconciledNanoUsd: number;
  retainedNanoUsd: number;
  reconciled: number;
  retained: number;
  released: number;
}

export const ZERO_CURSOR: LedgerCursor = { attempts: 0, reconciledNanoUsd: 0, retainedNanoUsd: 0, reconciled: 0, retained: 0, released: 0 };

/** Delta sink (the durable history). */
export interface UsageSink {
  /** Applies an identified event delta at most once per run. Returns false for a duplicate. */
  applyEvent(id: string, delta: { jev?: JevDayDelta; planner?: PlannerDayDelta }, atMs: number): boolean;
  /** Advances the ledger cursor and applies its dated delta in ONE commit (no write in between). */
  commitLedger(next: LedgerCursor, delta: JevDayDelta, atMs: number): void;
  cursor(): LedgerCursor;
}

export interface UsageAccumulatorOptions {
  spend?: () => SpendSnapshotLike;
  planner?: () => PlannerTotalsLike;
  sink?: UsageSink;
  now: () => number;
}

const SEEN_CAP = 8_192;

export class UsageAccumulator {
  private readonly o: UsageAccumulatorOptions;
  private readonly seen = new Set<string>();
  private jev = { validated: 0, retries: 0, inTok: 0, outTok: 0, cfKnown: 0, cfIn: 0, cfOut: 0 };
  private plan = { usageKnown: 0, usageUnknown: 0, input: 0, output: 0, cached: 0, cachedKnown: 0, reasoning: 0, reasoningKnown: 0 };
  /** Charged failures already applied to the dated aggregates (this process). */
  private chargedApplied = 0;
  /** Charged failures whose tokens were reported but not yet matched to ledger growth. */
  private cfKnownApplied = 0;
  private lastChange = 0;

  constructor(options: UsageAccumulatorOptions) {
    this.o = options;
  }

  private once(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  /** Observes one evidence event (from the store tee). Unknown event types are ignored. */
  observe(event: EvidenceEvent): void {
    const now = this.o.now();
    const sink = this.o.sink;
    switch (event.type) {
      case 'jev_request': {
        const e = JevRequestEvent.safeParse(event);
        if (!e.success || !this.once(`jreq:${e.data.requestId}:${e.data.attempt}`)) return;
        if (e.data.attempt > 1) this.jev.retries += 1;
        break;
      }
      case 'jev_response': {
        const e = JevResponseEvent.safeParse(event);
        if (!e.success) return;
        const id = `jres:${e.data.requestId}:${e.data.attempt}`;
        if (!this.once(id)) return;
        this.jev.validated += 1;
        this.jev.inTok += e.data.usage.inputTokens;
        this.jev.outTok += e.data.usage.outputTokens;
        sink?.applyEvent(id, { jev: { validatedResponses: 1, inputTokens: e.data.usage.inputTokens, outputTokens: e.data.usage.outputTokens } }, now);
        break;
      }
      case 'jev_failure': {
        const e = JevFailureEvent.safeParse(event);
        if (!e.success) return;
        const id = `jfail:${e.data.requestId}:${e.data.attempt}`;
        if (!this.once(id)) return;
        const u = e.data.usageTrusted ?? e.data.usage;
        // Only a charged failure with BOTH token counts reported has known tokens. Its cost is already in the ledger.
        if (u && typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number') {
          this.jev.cfKnown += 1;
          this.jev.cfIn += u.inputTokens;
          this.jev.cfOut += u.outputTokens;
          sink?.applyEvent(id, { jev: { chargedFailureInputTokens: u.inputTokens, chargedFailureOutputTokens: u.outputTokens } }, now);
        }
        break;
      }
      case 'planner_turn_started': {
        const e = PlannerStarted.safeParse(event);
        if (!e.success) return;
        const id = `pstart:${e.data.requestId}:${e.data.turn}`;
        if (!this.once(id)) return;
        sink?.applyEvent(id, { planner: { turns: 1 } }, now);
        break;
      }
      case 'planner_turn_completed': {
        const e = PlannerCompleted.safeParse(event);
        if (!e.success) return;
        const id = `pdone:${e.data.requestId}:${e.data.turn}`;
        if (!this.once(id)) return;
        const u = e.data.usage;
        const delta: PlannerDayDelta = { completedTurns: 1 };
        if (u) {
          this.plan.usageKnown += 1;
          this.plan.input += u.inputTokens;
          this.plan.output += u.outputTokens;
          delta.inputTokens = u.inputTokens;
          delta.outputTokens = u.outputTokens;
          if (typeof u.cachedInputTokens === 'number') {
            this.plan.cached += u.cachedInputTokens;
            this.plan.cachedKnown += 1;
            delta.cachedInputTokens = u.cachedInputTokens;
            delta.cachedKnownTurns = 1;
          }
          if (typeof u.reasoningOutputTokens === 'number') {
            this.plan.reasoning += u.reasoningOutputTokens;
            this.plan.reasoningKnown += 1;
            delta.reasoningOutputTokens = u.reasoningOutputTokens;
            delta.reasoningKnownTurns = 1;
          }
        } else {
          this.plan.usageUnknown += 1;
          delta.usageUnknownTurns = 1;
        }
        sink?.applyEvent(id, { planner: delta }, now);
        break;
      }
      case 'planner_turn_failed': {
        const e = PlannerFailed.safeParse(event);
        if (!e.success) return;
        const id = `pfail:${e.data.requestId}:${e.data.turn}`;
        if (!this.once(id)) return;
        this.plan.usageUnknown += 1;
        sink?.applyEvent(id, { planner: { failedTurns: 1, usageUnknownTurns: 1 } }, now);
        break;
      }
      default:
        return;
    }
    this.lastChange = now;
    this.syncLedger();
  }

  /**
   * Applies cumulative ledger growth since the cursor to the dated aggregates,
   * committing cursor and delta together. Called on every observed event and
   * publish tick. Never negative.
   */
  syncLedger(): void {
    const sink = this.o.sink;
    const spend = this.o.spend?.();
    if (!sink || !spend) return;
    const c = sink.cursor();
    const next: LedgerCursor = {
      attempts: Math.max(c.attempts, spend.attempts),
      reconciledNanoUsd: Math.max(c.reconciledNanoUsd, usdToNano(spend.reconciledUsd)),
      retainedNanoUsd: Math.max(c.retainedNanoUsd, usdToNano(spend.retainedUsd)),
      reconciled: Math.max(c.reconciled, spend.reconciled),
      retained: Math.max(c.retained, spend.retained),
      released: Math.max(c.released, spend.released),
    };
    const d = {
      attempts: next.attempts - c.attempts,
      confirmedNanoUsd: next.reconciledNanoUsd - c.reconciledNanoUsd,
      retainedNanoUsd: next.retainedNanoUsd - c.retainedNanoUsd,
      reconciled: next.reconciled - c.reconciled,
      retainedAttempts: next.retained - c.retained,
      releasedAttempts: next.released - c.released,
    };
    // Charged failure = reconciled without a validated response. Counted only at a quiescent ledger
    // point: the adapter records the validated response synchronously after reconciling.
    let chargedFailures = 0;
    let cfKnownDelta = 0;
    if (spend.outstandingUsd === 0 && spend.attempts === spend.reconciled + spend.retained + spend.released) {
      const chargedNow = Math.max(0, spend.reconciled - this.jev.validated);
      if (chargedNow > this.chargedApplied) {
        chargedFailures = chargedNow - this.chargedApplied;
        this.chargedApplied = chargedNow;
      }
      const knownNow = Math.min(this.jev.cfKnown, this.chargedApplied);
      if (knownNow > this.cfKnownApplied) {
        cfKnownDelta = knownNow - this.cfKnownApplied;
        this.cfKnownApplied = knownNow;
      }
    }
    if (chargedFailures === 0 && cfKnownDelta === 0 && Object.values(d).every((v) => v === 0)) return;
    sink.commitLedger(
      next,
      {
        attempts: d.attempts,
        confirmedNanoUsd: d.confirmedNanoUsd,
        retainedNanoUsd: d.retainedNanoUsd,
        retainedAttempts: d.retainedAttempts,
        releasedAttempts: d.releasedAttempts,
        chargedFailures,
        chargedFailuresTokensKnown: cfKnownDelta,
        // Unknown tokens: charged failures without reported tokens, and every retained (ambiguous) attempt.
        tokensUnknownAttempts: Math.max(0, chargedFailures - cfKnownDelta) + d.retainedAttempts,
      },
      this.o.now(),
    );
  }

  get changedAtMs(): number {
    return this.lastChange;
  }

  jevUsage(): Known<JevSessionUsage> {
    const spend = this.o.spend?.();
    if (!spend) return unknown('no spend ledger installed in this run');
    const chargedFailures = Math.max(0, spend.reconciled - this.jev.validated);
    const cfKnown = Math.min(this.jev.cfKnown, chargedFailures);
    const cap = usdToNano(spend.capUsd);
    const confirmed = usdToNano(spend.reconciledUsd);
    const retained = usdToNano(spend.retainedUsd);
    const pending = usdToNano(spend.outstandingUsd);
    return known(
      {
        attempts: spend.attempts,
        retries: this.jev.retries,
        validatedResponses: this.jev.validated,
        chargedFailures,
        retainedAttempts: spend.retained,
        releasedAttempts: spend.released,
        refused: spend.refused,
        inputTokens: this.jev.inTok,
        outputTokens: this.jev.outTok,
        tokensKnownAttempts: this.jev.validated,
        chargedFailuresTokensKnown: cfKnown,
        chargedFailureInputTokens: this.jev.cfIn,
        chargedFailureOutputTokens: this.jev.cfOut,
        tokensUnknownAttempts: chargedFailures - cfKnown + spend.retained,
        confirmedNanoUsd: confirmed,
        retainedNanoUsd: retained,
        pendingNanoUsd: pending,
        capNanoUsd: cap,
        remainingNanoUsd: cap - confirmed - retained - pending,
      },
      'app_accounting',
      this.o.now(),
    );
  }

  plannerUsage(): Known<PlannerSessionUsage> {
    const totals = this.o.planner?.();
    if (!totals) return unknown('the Codex planner is not installed in this run (disabled profile or not composed)');
    const p = this.plan;
    // Token sums come only from turns that REPORTED usage (events); totals give the turn counts.
    const inFlight = Math.max(0, totals.turns - totals.completedTurns - totals.failedTurns);
    const settled = Math.max(0, totals.turns - inFlight);
    const usageKnownTurns = Math.min(p.usageKnown, totals.completedTurns);
    return known(
      {
        turns: totals.turns,
        completedTurns: totals.completedTurns,
        failedTurns: totals.failedTurns,
        usageKnownTurns,
        usageUnknownTurns: Math.max(0, settled - usageKnownTurns),
        inputTokens: p.input,
        outputTokens: p.output,
        cachedInputTokens: p.cached,
        cachedKnownTurns: Math.min(p.cachedKnown, usageKnownTurns),
        reasoningOutputTokens: p.reasoning,
        reasoningKnownTurns: Math.min(p.reasoningKnown, usageKnownTurns),
      },
      'provider_reported',
      this.o.now(),
    );
  }
}
