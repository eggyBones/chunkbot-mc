// The single owned planner PROCESS (MB-FLOW-002). Goal turns, owner-instruction
// preparation and goal-owned window lookahead all start their planner turn
// through this slot.
//
// Serialization is strict (MB-FLOW-002-C1): the slot's tail is chained so that
// every ticket's successor waits for the ACTUAL settlement of every earlier
// turn. A caller whose wait exceeds the bound (or whose owner is revoked while
// waiting) gets a bounded FAILURE and starts nothing; its skipped ticket never
// releases later work past a still-running earlier turn. Owner preparation
// takes priority over speculative lookahead: it aborts a lookahead turn in
// flight, then waits (bounded) for that process to settle.

export type PlannerSlotKind = 'goal' | 'preparation' | 'lookahead';

interface Holder {
  kind: PlannerSlotKind;
  abort: AbortController;
}

export interface SlotTicket {
  /** Bind the started turn: the slot is held until it settles (process cleanup done). */
  started(turn: Promise<unknown>): void;
  /** No turn will be started (owner revoked after acquisition): releases this ticket only. */
  skip(): void;
}

export type SlotAcquisition =
  | { ok: true; ticket: SlotTicket }
  /** Nothing was started. `timeout`: an earlier planner process is still running after the bound. */
  | { ok: false; reason: 'timeout' | 'aborted' };

/** Resolves 'settled' when `work` settles, 'timeout' after `ms`, 'aborted' when any signal aborts. */
function waitBounded(work: Promise<unknown>, ms: number, signals: readonly AbortSignal[]): Promise<'settled' | 'timeout' | 'aborted'> {
  if (signals.some((s) => s.aborted)) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: 'settled' | 'timeout' | 'aborted') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of signals) s.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = () => finish('aborted');
    const timer = setTimeout(() => finish('timeout'), ms);
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
    void work.then(
      () => finish('settled'),
      () => finish('settled'),
    );
  });
}

export class PlannerSlot {
  /** Settles only after every turn handed out so far has settled (or was never started). */
  private tail: Promise<void> = Promise.resolve();
  private holder: Holder | undefined;
  private readonly waitMs: number;
  private readonly onWaitTimeout: ((kind: PlannerSlotKind) => void) | undefined;
  /** Turns currently running (started and not settled); never above 1. */
  running = 0;
  maxRunning = 0;
  pendingTickets = 0;

  constructor(waitMs: number, onWaitTimeout?: (kind: PlannerSlotKind) => void) {
    this.waitMs = waitMs;
    this.onWaitTimeout = onWaitTimeout;
  }

  /** Kind of the turn whose process currently holds the slot. */
  get busy(): PlannerSlotKind | undefined {
    return this.holder?.kind;
  }

  /** Actual settlement tail, including skipped/timed-out tickets (release drain). */
  settlement(): Promise<void> {
    return this.tail;
  }

  /** Aborts a speculative lookahead turn in flight (owner work takes priority). */
  preemptLookahead(reason: string): boolean {
    if (this.holder?.kind !== 'lookahead') return false;
    this.holder.abort.abort(new Error(reason));
    return true;
  }

  /**
   * Waits until every earlier turn's process settled (bounded by `waitMs`, or
   * until `abort`/`owner` aborts). Only then may the caller start its turn.
   */
  async acquire(kind: PlannerSlotKind, abort: AbortController, owner?: AbortSignal): Promise<SlotAcquisition> {
    const previous = this.tail;
    const mine = Promise.withResolvers<void>();
    this.pendingTickets += 1;
    void mine.promise.then(() => { this.pendingTickets -= 1; });
    // The successor waits for the earlier turns AND this one: skipping this
    // ticket can never release later work past a still-running earlier turn.
    this.tail = previous.then(() => mine.promise);
    if (kind === 'preparation') this.preemptLookahead('owner instruction preparation takes priority');
    const waited = await waitBounded(previous, this.waitMs, owner ? [abort.signal, owner] : [abort.signal]);
    if (waited !== 'settled') {
      mine.resolve();
      if (waited === 'timeout') this.onWaitTimeout?.(kind);
      return { ok: false, reason: waited };
    }
    let started = false;
    return {
      ok: true,
      ticket: {
        started: (turn) => {
          if (started) return;
          started = true;
          const holder: Holder = { kind, abort };
          this.holder = holder;
          this.running += 1;
          this.maxRunning = Math.max(this.maxRunning, this.running);
          void turn
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => {
              this.running -= 1;
              if (this.holder === holder) this.holder = undefined;
              mine.resolve();
            });
        },
        skip: () => {
          if (started) return;
          started = true;
          mine.resolve();
        },
      },
    };
  }
}
