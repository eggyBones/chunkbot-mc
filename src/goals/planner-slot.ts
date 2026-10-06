// The single owned planner PROCESS (MB-FLOW-002). Goal turns, owner-instruction
// preparation and goal-owned window lookahead all start their planner turn
// through this slot: a turn starts only after the previous turn's process has
// settled (bounded wait), so there is never more than one planner process.
// Owner preparation takes priority over speculative lookahead: it aborts a
// lookahead turn in flight and then waits (bounded) for that process cleanup.
// If a previous process does not settle in time the next turn still starts and
// the adapter refuses it honestly (one turn in flight); nothing is bypassed.

export type PlannerSlotKind = 'goal' | 'preparation' | 'lookahead';

interface Holder {
  kind: PlannerSlotKind;
  abort: AbortController;
}

export interface SlotTicket {
  /** Bind the started turn: the slot is held until it settles (process cleanup done). */
  started(turn: Promise<unknown>): void;
  /** The owner did not start a turn after all (revoked while waiting). */
  skip(): void;
}

async function bounded(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work.then(() => true, () => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class PlannerSlot {
  private tail: Promise<void> = Promise.resolve();
  private holder: Holder | undefined;
  private readonly waitMs: number;
  private readonly onWaitTimeout: ((kind: PlannerSlotKind) => void) | undefined;

  constructor(waitMs: number, onWaitTimeout?: (kind: PlannerSlotKind) => void) {
    this.waitMs = waitMs;
    this.onWaitTimeout = onWaitTimeout;
  }

  /** Kind of the turn whose process currently holds the slot. */
  get busy(): PlannerSlotKind | undefined {
    return this.holder?.kind;
  }

  /** Aborts a speculative lookahead turn in flight (owner work takes priority). */
  preemptLookahead(reason: string): boolean {
    if (this.holder?.kind !== 'lookahead') return false;
    this.holder.abort.abort(new Error(reason));
    return true;
  }

  /** Waits until the previous turn's process settled (bounded), then hands out a ticket. */
  async acquire(kind: PlannerSlotKind, abort: AbortController): Promise<SlotTicket> {
    const previous = this.tail;
    const mine = Promise.withResolvers<void>();
    this.tail = mine.promise;
    if (kind === 'preparation') this.preemptLookahead('owner instruction preparation takes priority');
    const settled = await bounded(previous, this.waitMs);
    if (!settled) this.onWaitTimeout?.(kind);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      mine.resolve();
    };
    return {
      started: (turn) => {
        const holder: Holder = { kind, abort };
        this.holder = holder;
        void turn.then(
          () => undefined,
          () => undefined,
        ).finally(() => {
          if (this.holder === holder) this.holder = undefined;
          finish();
        });
      },
      skip: finish,
    };
  }
}
