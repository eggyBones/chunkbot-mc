// MB-FLOW-003-C12 continuation trigger (app-owned; local; inference-free).
// While a same-session owner job is HELD, a bounded local timer (and lifecycle
// nudges: respawn/ready) asks the GoalEngine whether the job may continue. The
// engine's readiness is code-owned and finite (deadline, continuation count,
// limits); the scheduler stops as soon as nothing is held. It works with
// survival, memory and autonomy disabled; it never consults the automatic
// progression latch. Explicit stop/new intake fence the checkpoints in the
// engine, so the scheduler then simply finds nothing held.
import type { ContinuationCheckpoint, ContinueResult, RunStore } from '../contracts/index.ts';

export interface ContinuationEngineLike {
  checkpoints(): ContinuationCheckpoint[];
  continueHeld(goalId: string, cause: 'respawn_ready' | 'recovery_concluded' | 'safety_clear' | 'scheduled'): Promise<ContinueResult>;
}

export class ContinuationScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private closed = false;
  private lastReason = new Map<string, string>();

  private readonly engine: ContinuationEngineLike;
  private readonly store: RunStore;
  private readonly intervalMs: number;

  constructor(engine: ContinuationEngineLike, store: RunStore, intervalMs = 2_000) {
    this.engine = engine;
    this.store = store;
    this.intervalMs = intervalMs;
  }

  /** Re-check now (lifecycle nudge or a checkpoint change) and keep a bounded timer while anything is held. */
  nudge(cause: 'respawn_ready' | 'recovery_concluded' | 'safety_clear' | 'scheduled' = 'scheduled'): void {
    if (this.closed) return;
    // Deferred: never re-enters the engine from inside its own synchronous hooks.
    setImmediate(() => void this.tick(cause));
  }

  private arm(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick('scheduled');
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async tick(cause: 'respawn_ready' | 'recovery_concluded' | 'safety_clear' | 'scheduled'): Promise<void> {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      const held = this.engine.checkpoints().filter((c) => c.state === 'held');
      for (const cp of held) {
        const r = await this.engine.continueHeld(cp.goalId, cause);
        const key = r.status === 'admitted' ? 'admitted' : `${r.status}:${r.reason}`;
        if (this.lastReason.get(cp.goalId) !== key) {
          this.lastReason.set(cp.goalId, key);
          this.store.record({ type: 'continuation_readiness', goalId: cp.goalId, cause, status: r.status, ...(r.status === 'admitted' ? { epoch: r.epoch, continuation: r.continuation } : { reason: r.reason, detail: r.detail.slice(0, 200) }) });
        }
        if (r.status === 'admitted') break; // one owner job at a time
      }
      if (this.engine.checkpoints().some((c) => c.state === 'held')) this.arm();
    } finally {
      this.running = false;
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
