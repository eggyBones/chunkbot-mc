// MB-FLOW-001 x MB-FLOW-003-C5 owned admission barrier for automatic recovery.
//
// After a death-recovery support goal is admitted (attempt recorded by
// survival at admission) and BEFORE its first planner turn or task, the
// survival recovery authority must be durable: the attempt is in a complete
// survival revision and the exact memory death fact is durable. Pending saves
// get a short, bounded, abortable wait; failed or unknown durability ends the
// goal before any model call or action. Never used on capture/revocation; a
// stop aborts the wait immediately. Pure code: no inference, no actuation.
import type { GoalSource, TerminalReasonCode } from '../contracts/index.ts';

export interface RecoveryAuthority {
  recoveryTarget(fence: { goalEpoch: number; connectionEpoch: number; dimension: string }): { episodeId: string } | { error: string; detail: string };
}

export interface RecoveryBarrierOptions {
  survival: RecoveryAuthority | undefined;
  connection: () => { connectionEpoch: number; dimension: string } | null;
  /** Bounded wait for pending durable writes (default 5 s). */
  waitMs?: number;
  pollMs?: number;
  record?: (event: { type: string } & Record<string, unknown>) => void;
}

const PENDING = new Set(['attempt_write_pending', 'incident_write_pending']);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function recoveryAdmissionBarrier(o: RecoveryBarrierOptions) {
  const waitMs = Number.isFinite(o.waitMs) ? Math.min(5_000, Math.max(0, o.waitMs!)) : 5_000;
  const pollMs = Number.isFinite(o.pollMs) ? Math.min(1_000, Math.max(1, o.pollMs!)) : 100;
  return async (admission: { goalId: string; epoch: number; source: GoalSource | undefined }, signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: TerminalReasonCode; detail: string }> => {
    const s = admission.source;
    if (!s || s.kind !== 'support' || s.routine !== 'death_recovery') return { ok: true };
    if (!o.survival) return { ok: false, reason: 'capability_not_ready', detail: 'recovery authority is not installed' };
    const started = performance.now();
    const admittedConnection = o.connection();
    let last: { error: string; detail: string } | undefined;
    while (!signal.aborted) {
      const conn = o.connection();
      if (!conn) return { ok: false, reason: 'cannot_execute', detail: 'not connected: recovery authority cannot be confirmed' };
      if (!admittedConnection || conn.connectionEpoch !== admittedConnection.connectionEpoch || conn.dimension !== admittedConnection.dimension) {
        last = { error: 'connection_changed', detail: 'recovery admission belongs to a different connection or dimension' };
        break;
      }
      const r = o.survival.recoveryTarget({ goalEpoch: admission.epoch, connectionEpoch: conn.connectionEpoch, dimension: conn.dimension });
      if (!('error' in r)) {
        if (s.episodeId && r.episodeId !== s.episodeId) {
          last = { error: 'episode_mismatch', detail: 'durable recovery authority belongs to a different incident' };
          break;
        }
        o.record?.({ type: 'recovery_barrier_passed', goalId: admission.goalId, waitedMs: Math.round(performance.now() - started) });
        return { ok: true };
      }
      last = r;
      if (!PENDING.has(r.error)) break;
      const left = waitMs - (performance.now() - started);
      if (left <= 0) break;
      await sleep(Math.min(pollMs, left), signal);
    }
    const detail = last ? `recovery authority not durable (${last.error}): ${last.detail}` : 'recovery barrier cancelled';
    o.record?.({ type: 'recovery_barrier_refused', goalId: admission.goalId, error: last?.error ?? 'aborted', waitedMs: Math.round(performance.now() - started) });
    return { ok: false, reason: 'cannot_execute', detail };
  };
}
