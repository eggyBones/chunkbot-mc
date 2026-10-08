// Composition helpers for the shared writer (P). Nothing here edits shared
// modules; it adapts the EXISTING single ActuatorLeases/SkillExecutorImpl and
// session/perception/knowledge into the safety ports.
//
// Integration (P owns the shared files):
//   const safety = createSafetyRuntime({ config: config.safety, session, perception, knowledge,
//     authority: () => <explicit SafetyAuthority from GoalEngine/latch/connection/lifecycle>,
//     actuation: leaseActuation(leases, executor), clock, ids, record });
//   registry: [...allSkills(), ..., ...safetySkills(safety.service)]
//   leases ownerCurrent: owner.kind === 'safety' ? safety.service.grantCurrent(owner.grantId) : ...
//   onBotCreated: safety.service.attachConnection(bot._client, { connectionEpoch, registry: () => bot.registry })
//   onLifecycle (BEFORE lease/ledger invalidation): safety.service.onLifecycle(event)
//   stop / resume / owner goal admitted / goal terminal: safety.service.onAuthorityChanged(cause)
//   after composition: safety.service.start(); shutdown: await safety.service.close()
//   conservativeMovements (navigation): applyDeepWaterAvoidance(movements, () => safety.reader.world())
//   TaskRuntime/route runner: await safety.service.waitClear(task.signal) before EVERY dispatch;
//     outcome reason `safety_preempt` = suspension (not a failure; wait, then re-observe).
import type { ActionCandidate, Clock, IdSource, SkillOutcome } from '../contracts/index.ts';
import type { SafetyActuationPort, SafetyAuthority, SafetyConfigInput, SafetyExecutionOwner } from '../contracts/safety.ts';
import type { GameSession } from '../game/connection.ts';
import type { PerceptionService } from '../perception/perception.ts';
import { registryFactsOf, SessionSafetyReader } from './adapter.ts';
import { SafetyService, type SafetyTimers } from './service.ts';
import { SafetyTracker } from './tracker.ts';

/** Minimal structural views of the shared execution objects (no edits to them). */
export interface LeaseView {
  readonly current: { readonly owner: { kind: string } } | undefined;
  revoke(lease: never, reason: string): { clearMs: number } | undefined;
}
export interface ExecutorView {
  execute(candidate: ActionCandidate, signal: AbortSignal, owner?: never): Promise<SkillOutcome>;
}

/**
 * Actuation over the existing single lease and executor. Preemption revokes
 * only a NON-safety current lease (synchronously: invalidate, abort, owned
 * interfaces closed, shared controls cleared). Execution passes the actual
 * safety owner; the executor/leases must verify it (ownerCurrent ->
 * grantCurrent) — requires the shared `ExecutionOwner` safety variant.
 */
export function leaseActuation(leases: LeaseView, executor: ExecutorView): SafetyActuationPort {
  return {
    preemptCurrent(reason) {
      const cur = leases.current;
      if (!cur || cur.owner.kind === 'safety') return { revoked: false, holder: cur ? 'safety' : null, clearMs: null };
      const holder = cur.owner.kind;
      const report = leases.revoke(cur as never, reason);
      return { revoked: Boolean(report), holder, clearMs: report?.clearMs ?? null };
    },
    execute(candidate: ActionCandidate, signal: AbortSignal, owner: SafetyExecutionOwner) {
      return executor.execute(candidate, signal, owner as never);
    },
  };
}

export interface SafetyRuntimeOptions {
  config: SafetyConfigInput | undefined;
  session: () => GameSession | undefined;
  perception: Pick<PerceptionService, 'isOwnerEntity'>;
  /** Exact-version item tag membership (VersionKnowledge recipes book `matches`). */
  inTag(tag: '#minecraft:swords' | '#minecraft:axes', key: string): boolean;
  authority(): SafetyAuthority;
  actuation: SafetyActuationPort;
  clock: Clock;
  ids: IdSource;
  record(event: Record<string, unknown> & { type: string }): void;
  timers?: SafetyTimers;
}

export function createSafetyRuntime(o: SafetyRuntimeOptions): { service: SafetyService; reader: SessionSafetyReader } {
  const tracker = new SafetyTracker();
  const reader = new SessionSafetyReader({ session: o.session, perception: o.perception, tracker, now: () => o.clock.now() });
  const service = new SafetyService({
    tracker,
    ...(o.config !== undefined ? { config: o.config } : {}),
    authority: o.authority,
    actuation: o.actuation,
    reader,
    inTag: o.inTag,
    registry: (raw) => (raw ? registryFactsOf(raw) : undefined),
    category: (name) => {
      const s = o.session();
      return s ? registryFactsOf(s.bot.registry).category(name) : undefined;
    },
    now: () => o.clock.now(),
    ids: o.ids,
    record: o.record,
    ...(o.timers ? { timers: o.timers } : {}),
  });
  return { service, reader };
}
