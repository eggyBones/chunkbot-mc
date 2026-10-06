// Typed usage projection for the dashboard.
//
// Sources (no terminal text, no log tailing):
// - SpendLedger.snapshot(): the authoritative per-run accounting (reserved,
//   reconciled, retained, released, refused, cap, remaining);
// - validated Jev evidence events (`jev_request`, `jev_response`,
//   `jev_failure`) observed through a store tee: token usage, retries;
// - planner evidence events (`planner_turn_*`) and CodexPlanner.totals.
//
// Cumulative ledger values are applied to dated aggregates as deltas against a
// per-run cursor, so repeated or out-of-order observations never double count
// and never go backwards. Token usage events are deduplicated by identity. The
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

/** Structural copy of CodexPlanner.totals (src/planner/codex-planner.ts). */
export interface PlannerTotalsLike {
  turns: number;
  completedTurns: number;
  failedTurns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

const nn = z.number().int().nonnegative();
const reqId = z.string().min(1).max(64);
const JevRequestEvent = z.object({ type: z.literal('jev_request'), requestId: reqId, attempt: z.number().int().min(1).max(4) }).passthrough();
const JevResponseEvent = z
  .object({
    type: z.literal('jev_response'),
    requestId: reqId,
    attempt: z.number().int().min(1).max(4),
    usage: z.object({ inputTokens: nn, outputTokens: nn, costUsd: z.number().finite().nonnegative() }).passthrough(),
  })
  .passthrough();
const PlannerStarted = z.object({ type: z.literal('planner_turn_started'), requestId: reqId, turn: nn }).passthrough();
const PlannerCompleted = z
  .object({
    type: z.literal('planner_turn_completed'),
    requestId: reqId,
    turn: nn,
    usage: z.object({ inputTokens: nn, cachedInputTokens: nn, outputTokens: nn, reasoningOutputTokens: nn }).passthrough().nullable(),
  })
  .passthrough();
const PlannerFailed = z.object({ type: z.literal('planner_turn_failed'), requestId: reqId, turn: nn, kind: z.string().max(64) }).passthrough();

export interface JevDayDelta extends Partial<DayJev> {}
export interface PlannerDayDelta extends Partial<DayPlanner> {}

/** Delta sink (the durable history); called synchronously as usage is observed. */
export interface UsageSink {
  jev(delta: JevDayDelta, atMs: number): void;
  planner(delta: PlannerDayDelta, atMs: number): void;
  /** Cumulative ledger state already applied for this run (restart-safe cursor). */
  cursor(): LedgerCursor;
  setCursor(c: LedgerCursor): void;
  /** Event identity already counted for this run? Marks it counted when not. */
  firstTime(id: string): boolean;
}

export interface LedgerCursor {
  attempts: number;
  reconciledNanoUsd: number;
  retainedNanoUsd: number;
  reconciled: number;
  retained: number;
  released: number;
}

export const ZERO_CURSOR: LedgerCursor = { attempts: 0, reconciledNanoUsd: 0, retainedNanoUsd: 0, reconciled: 0, retained: 0, released: 0 };

export interface UsageAccumulatorOptions {
  spend?: () => SpendSnapshotLike;
  planner?: () => PlannerTotalsLike;
  sink?: UsageSink;
  now: () => number;
}

const SEEN_CAP = 4_096;

export class UsageAccumulator {
  private readonly o: UsageAccumulatorOptions;
  private readonly seen = new Set<string>();
  private jevValidated = 0;
  private jevRetries = 0;
  private jevIn = 0;
  private jevOut = 0;
  private plannerUsageKnown = 0;
  /** Charged failures already applied to the dated aggregates (this process). */
  private chargedApplied = 0;
  private plannerEv = { turns: 0, completed: 0, failed: 0, input: 0, cached: 0, output: 0, reasoning: 0, usageUnknown: 0 };
  private lastChange = 0;

  constructor(options: UsageAccumulatorOptions) {
    this.o = options;
  }

  /** True only the first time an identity is seen in this process. */
  private once(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > SEEN_CAP) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  /** Observes one evidence event (from the store tee). Unknown event types are ignored. */
  observe(event: EvidenceEvent): void {
    const now = this.o.now();
    switch (event.type) {
      case 'jev_request': {
        const e = JevRequestEvent.safeParse(event);
        if (!e.success || !this.once(`jreq:${e.data.requestId}:${e.data.attempt}`)) return;
        if (e.data.attempt > 1) this.jevRetries += 1;
        this.lastChange = now;
        break;
      }
      case 'jev_response': {
        const e = JevResponseEvent.safeParse(event);
        const id = e.success ? `jres:${e.data.requestId}:${e.data.attempt}` : '';
        if (!e.success || !this.once(id)) return;
        this.jevValidated += 1;
        this.jevIn += e.data.usage.inputTokens;
        this.jevOut += e.data.usage.outputTokens;
        this.lastChange = now;
        if (this.o.sink?.firstTime(id)) this.o.sink.jev({ validatedResponses: 1, inputTokens: e.data.usage.inputTokens, outputTokens: e.data.usage.outputTokens }, now);
        break;
      }
      case 'jev_failure':
        this.lastChange = now;
        break;
      case 'planner_turn_started': {
        const e = PlannerStarted.safeParse(event);
        const id = e.success ? `pstart:${e.data.requestId}:${e.data.turn}` : '';
        if (!e.success || !this.once(id)) return;
        this.plannerEv.turns += 1;
        this.lastChange = now;
        if (this.o.sink?.firstTime(id)) this.o.sink.planner({ turns: 1 }, now);
        break;
      }
      case 'planner_turn_completed': {
        const e = PlannerCompleted.safeParse(event);
        const id = e.success ? `pdone:${e.data.requestId}:${e.data.turn}` : '';
        if (!e.success || !this.once(id)) return;
        this.plannerEv.completed += 1;
        const u = e.data.usage;
        if (u) {
          this.plannerUsageKnown += 1;
          this.plannerEv.input += u.inputTokens;
          this.plannerEv.cached += u.cachedInputTokens;
          this.plannerEv.output += u.outputTokens;
          this.plannerEv.reasoning += u.reasoningOutputTokens;
        } else this.plannerEv.usageUnknown += 1;
        this.lastChange = now;
        if (this.o.sink?.firstTime(id)) {
          this.o.sink.planner(
            u
              ? { completedTurns: 1, inputTokens: u.inputTokens, cachedInputTokens: u.cachedInputTokens, outputTokens: u.outputTokens, reasoningOutputTokens: u.reasoningOutputTokens }
              : { completedTurns: 1, usageUnknownTurns: 1 },
            now,
          );
        }
        break;
      }
      case 'planner_turn_failed': {
        const e = PlannerFailed.safeParse(event);
        const id = e.success ? `pfail:${e.data.requestId}:${e.data.turn}` : '';
        if (!e.success || !this.once(id)) return;
        this.plannerEv.failed += 1;
        this.plannerEv.usageUnknown += 1;
        this.lastChange = now;
        if (this.o.sink?.firstTime(id)) this.o.sink.planner({ failedTurns: 1, usageUnknownTurns: 1 }, now);
        break;
      }
      default:
        return;
    }
    this.syncLedger();
  }

  /**
   * Applies cumulative ledger growth since the cursor to the dated aggregates.
   * Called on every observed event and every publish tick. Never negative.
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
    // Reconciled without a validated response = charged with a trusted cost but an unusable answer.
    // Counted only when no reservation is outstanding: the adapter records a validated response
    // synchronously after reconciling, so R and V are consistent at every quiescent point.
    let chargedFailures = 0;
    if (spend.outstandingUsd === 0 && spend.attempts === spend.reconciled + spend.retained + spend.released) {
      const chargedNow = Math.max(0, spend.reconciled - this.jevValidated);
      if (chargedNow > this.chargedApplied) {
        chargedFailures = chargedNow - this.chargedApplied;
        this.chargedApplied = chargedNow;
      }
    }
    if (chargedFailures === 0 && Object.values(d).every((v) => v === 0)) return;
    sink.setCursor(next);
    sink.jev(
      {
        attempts: d.attempts,
        confirmedNanoUsd: d.confirmedNanoUsd,
        retainedNanoUsd: d.retainedNanoUsd,
        retainedAttempts: d.retainedAttempts,
        releasedAttempts: d.releasedAttempts,
        chargedFailures,
        // Token counts are unknown for charged failures and for retained (ambiguous) attempts.
        tokensUnknownAttempts: chargedFailures + d.retainedAttempts,
      },
      this.o.now(),
    );
  }

  get changedAtMs(): number {
    return this.lastChange;
  }

  jev(): Known<JevSessionUsage> {
    const spend = this.o.spend?.();
    if (!spend) return unknown('no spend ledger installed in this run');
    const now = this.o.now();
    const chargedFailures = Math.max(0, spend.reconciled - this.jevValidated);
    const cap = usdToNano(spend.capUsd);
    const confirmed = usdToNano(spend.reconciledUsd);
    const retained = usdToNano(spend.retainedUsd);
    const pending = usdToNano(spend.outstandingUsd);
    return known(
      {
        attempts: spend.attempts,
        retries: this.jevRetries,
        validatedResponses: this.jevValidated,
        chargedFailures,
        retainedAttempts: spend.retained,
        releasedAttempts: spend.released,
        refused: spend.refused,
        inputTokens: this.jevIn,
        outputTokens: this.jevOut,
        tokensKnownAttempts: this.jevValidated,
        tokensUnknownAttempts: chargedFailures + spend.retained,
        confirmedNanoUsd: confirmed,
        retainedNanoUsd: retained,
        pendingNanoUsd: pending,
        capNanoUsd: cap,
        remainingNanoUsd: cap - confirmed - retained - pending,
      },
      'app_accounting',
      now,
    );
  }

  planner(): Known<PlannerSessionUsage> {
    const totals = this.o.planner?.();
    if (!totals) return unknown('the Codex planner is not installed in this run (disabled profile or not composed)');
    const ev = this.plannerEv;
    // CodexPlanner.totals is authoritative for counts and token sums; events tell which turns lacked usage.
    const inFlight = Math.max(0, totals.turns - totals.completedTurns - totals.failedTurns);
    const usageUnknownTurns = Math.max(ev.usageUnknown, totals.failedTurns + Math.max(0, totals.completedTurns - this.plannerUsageKnown));
    return known(
      {
        turns: totals.turns,
        completedTurns: totals.completedTurns,
        failedTurns: totals.failedTurns,
        usageKnownTurns: Math.min(this.plannerUsageKnown, totals.completedTurns),
        usageUnknownTurns: Math.min(usageUnknownTurns, Math.max(0, totals.turns - inFlight)),
        inputTokens: totals.inputTokens,
        cachedInputTokens: totals.cachedInputTokens,
        outputTokens: totals.outputTokens,
        reasoningOutputTokens: totals.reasoningOutputTokens,
      },
      'provider_reported',
      this.o.now(),
    );
  }
}
