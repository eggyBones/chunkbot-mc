// Skill executor: revalidates a grounded candidate against current ownership
// and connection, acquires the single actuator lease, runs the registered
// skill's fenced executor, and returns a verified SkillOutcome.
//
// Cancellation: aborting the caller's signal (stop/replacement/lifecycle) or an
// ownership change revokes the lease synchronously (controls cleared, owned
// interfaces closed) BEFORE the returned promise settles. Partial effects that
// the skill confirmed are reported; Minecraft changes are never rolled back.
import {
  SkillOutcomeSchema,
  type ActionCandidate,
  type ExecutionOwner,
  type JsonValue,
  type Readiness,
  type RunStore,
  type SkillExecutor,
  type SkillOutcome,
} from '../contracts/index.ts';
import type { GameSession } from '../game/connection.ts';
import type { SkillServices } from '../skills/definition.ts';
import { removalScopeAllows } from '../skills/common.ts';
import { Actuator, InterfaceBusyError, sleepAbortable } from './actuator.ts';
import { interfaceGate } from './interface-gate.ts';
import { LeaseBusyError, LeaseRevokedError, type ActuatorLeases } from './lease.ts';
import type { SkillRegistry } from './registry.ts';

type Bot = GameSession['bot'];

/** Synchronously stops shared actuation on the bot (path goal, movement, dig, item use). */
export function clearSharedControls(bot: Bot | undefined): { steps: string[]; errors: string[] } {
  const steps: string[] = [];
  const errors: string[] = [];
  if (!bot) return { steps, errors };
  const attempt = (name: string, fn: () => void) => {
    try {
      fn();
      steps.push(name);
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const pf = (bot as unknown as { pathfinder?: { setGoal(g: null): void } }).pathfinder;
  if (pf) attempt('path_goal_cleared', () => pf.setGoal(null));
  attempt('controls_cleared', () => bot.clearControlStates());
  if ((bot as unknown as { targetDigBlock?: unknown }).targetDigBlock) attempt('dig_stopped', () => bot.stopDigging());
  if ((bot as unknown as { usingHeldItem?: boolean }).usingHeldItem) attempt('item_use_released', () => (bot as unknown as { deactivateItem(): void }).deactivateItem());
  attempt('horizontal_velocity_zeroed', () => {
    if (bot.entity?.velocity) {
      bot.entity.velocity.x = 0;
      bot.entity.velocity.z = 0;
    }
  });
  return { steps, errors };
}

/** Bounds arbitrary evidence to the shared JsonValue contract (strings, list lengths, depth). */
export function boundJson(value: unknown, depth = 0): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 1_000 ? `${value.slice(0, 997)}...` : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth >= 5) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 32).map((v) => boundJson(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 48)) out[k.slice(0, 64)] = boundJson(v, depth + 1);
    return out;
  }
  return String(value).slice(0, 200);
}

export interface ExecutorDeps {
  registry: SkillRegistry;
  leases: ActuatorLeases;
  session: () => GameSession | undefined;
  services: SkillServices;
  /** Current goal epoch (goal-owned candidates must match). */
  goalEpoch: () => number;
  store: RunStore;
  /** Quiet period after a revocation for passive (packet-only) partial-effect evidence. */
  settleMs?: number;
  /**
   * Observer for every finished outcome (e.g. MB-MEM-001 memory recording of
   * server-confirmed effects). Called after the outcome is recorded; failures are
   * contained and recorded, never changing the outcome.
   */
  onOutcome?: (outcome: SkillOutcome) => void;
}

export class SkillExecutorImpl implements SkillExecutor {
  private readonly deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  readiness(): Readiness {
    const n = this.deps.registry.all().length;
    const session = this.deps.session();
    if (session) {
      const unresolved = interfaceGate(session, this.deps.services.clock).unresolved();
      if (unresolved.length > 0) {
        return { ready: false, detail: `${unresolved.length} interface request(s) unanswered for >5s; interface state unknown until the server acknowledges or the connection is renewed` };
      }
    }
    return { ready: n > 0, detail: `${n} registered skills; one actuator lease${session ? '' : '; waiting for a ready connection'}` };
  }

  async execute(candidate: ActionCandidate, signal: AbortSignal, ownerArg?: ExecutionOwner): Promise<SkillOutcome> {
    const { clock } = this.deps.services;
    const started = clock.now();
    const owner: ExecutionOwner = ownerArg ?? { kind: 'goal', goalEpoch: candidate.goalEpoch, goalId: '', taskId: '' };
    const base = {
      actionId: candidate.id,
      owner: owner.kind,
      capability: candidate.capability,
      connectionEpoch: candidate.connectionEpoch,
      goalEpoch: candidate.goalEpoch,
      ...(owner.kind === 'goal' && owner.goalId ? { goalId: owner.goalId } : {}),
      ...(owner.kind === 'goal' && owner.taskId ? { taskId: owner.taskId } : {}),
    };
    const finish = (o: { status: SkillOutcome['status']; effect: string; reason?: string; confirmation?: SkillOutcome['confirmation']; evidence?: Record<string, unknown> }): SkillOutcome => {
      const outcome = SkillOutcomeSchema.parse({
        ...base,
        status: o.status,
        elapsedMs: Math.max(0, Math.round(clock.now() - started)),
        effect: o.effect.slice(0, 1_000),
        ...(o.reason ? { reason: o.reason } : {}),
        confirmation: o.confirmation ?? 'none',
        evidence: boundJson(o.evidence ?? {}) as Record<string, JsonValue>,
      });
      this.deps.store.record({ type: 'skill_outcome', ...outcome });
      if (this.deps.onOutcome) {
        try {
          this.deps.onOutcome(outcome);
        } catch (error) {
          this.deps.store.record({ type: 'outcome_observer_error', actionId: outcome.actionId, message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
        }
      }
      return outcome;
    };

    const def = this.deps.registry.get(candidate.capability);
    if (!def) return finish({ status: 'precondition_failed', reason: 'unknown_capability', effect: `capability ${candidate.capability} is not registered` });
    const parsed = def.params.safeParse(candidate.parameters);
    if (!parsed.success) {
      return finish({ status: 'precondition_failed', reason: 'invalid_parameters', effect: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const session = this.deps.session();
    if (!session) return finish({ status: 'precondition_failed', reason: 'not_connected', effect: 'no ready game connection' });
    if (candidate.connectionEpoch !== session.connectionEpoch) {
      return finish({ status: 'precondition_failed', reason: 'stale_candidate', effect: 'candidate belongs to an earlier connection' });
    }
    if (owner.kind === 'goal' && candidate.goalEpoch !== this.deps.goalEpoch()) {
      return finish({ status: 'precondition_failed', reason: 'stale_goal_epoch', effect: 'candidate belongs to a goal that no longer owns control' });
    }
    // A safety dispatch is fenced by its own finite grant (displacement/time/action bounds of the
    // safety service) and never by a goal epoch or goal travel anchor.
    // Goal-anchored travel bounds: the anchor is captured at goal ADMISSION
    // (SkillRuntime.onGoalAdmitted) and never set or moved by execution. A goal
    // action whose epoch does not own the current anchor is refused.
    if (owner.kind === 'goal') {
      if (owner.requiresOwnerDirection && candidate.capability === 'explore_frontier') return finish({ status: 'precondition_failed', reason: 'owner_direction_required', effect: 'owner seeking cannot dispatch undirected exploration; no command was issued' });
      if (candidate.capability === 'mine_block' && owner.destructiveScope !== undefined && !removalScopeAllows(this.deps.services, candidate.parameters['target'], owner.destructiveScope, String(session.bot.game.dimension))) {
        return finish({ status: 'precondition_failed', reason: 'destructive_target_conflict', effect: 'block is outside the original bound removal target; no command was issued' });
      }
      const anchorEpoch = this.deps.services.perception.travelAnchorGoalEpoch();
      if (anchorEpoch !== owner.goalEpoch) {
        return finish({
          status: 'precondition_failed',
          reason: 'travel_anchor_not_admitted',
          effect: `no travel anchor was admitted for goal epoch ${owner.goalEpoch}${anchorEpoch !== undefined ? ` (the anchor belongs to epoch ${anchorEpoch})` : ''}; no command was issued`,
        });
      }
    }
    if (signal.aborted) return finish({ status: 'cancelled', reason: 'cancelled_before_start', effect: 'cancelled before any command was issued' });

    let lease;
    try {
      lease = this.deps.leases.acquire(owner);
    } catch (error) {
      if (error instanceof LeaseBusyError) return finish({ status: 'precondition_failed', reason: 'actuator_busy', effect: error.message });
      throw error;
    }
    const act = new Actuator(session, lease, clock);
    let revokedAtMs: number | undefined;
    const onAbort = () => {
      revokedAtMs = clock.now();
      this.deps.leases.revoke(lease, 'owner_stop');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    lease.signal.addEventListener('abort', () => (revokedAtMs ??= clock.now()), { once: true });
    const progress: Record<string, JsonValue> = {};
    const localProgress: Record<string, JsonValue> = {};
    let serverProvenance: 'server_packet' | 'server_sync' | undefined;
    let lastConfirmedAtMs: number | undefined;
    let lastConfirmedCommands = 0;
    const recordProgress = (e: Record<string, JsonValue>, provenance: 'server_packet' | 'server_sync' | 'local' = 'local') => {
      if (provenance === 'local') {
        Object.assign(localProgress, e);
        return;
      }
      Object.assign(progress, e);
      lastConfirmedAtMs = clock.now();
      lastConfirmedCommands = act.issued;
      if (provenance === 'server_sync' || !serverProvenance) serverProvenance = provenance;
    };
    this.deps.store.record({ type: 'skill_started', actionId: candidate.id, capability: candidate.capability, owner: owner.kind, leaseId: lease.id });
    try {
      const result = await def.execute(
        { act, session, services: this.deps.services, candidate, owner, progress: recordProgress },
        parsed.data,
      );
      lease.fence(); // a result produced after revocation is reported as cancelled below
      const trace = result.status === 'succeeded' ? {} : { commandTrace: act.commands.slice(-24).map((c) => `${c.atMs - started}ms ${c.command}`) };
      return finish({
        status: result.status,
        effect: result.effect,
        ...(result.reason ? { reason: result.reason } : {}),
        confirmation: result.confirmation,
        evidence: { ...localProgress, ...progress, ...(result.evidence ?? {}), commandsIssued: act.issued, ...trace },
      });
    } catch (error) {
      if (error instanceof LeaseRevokedError || lease.revocation !== undefined) {
        // Passive settle: only listen for server packets; the old action issues nothing.
        const settleFrom = session.evidence.seq;
        await sleepAbortable(this.deps.settleMs ?? 300, new AbortController().signal);
        const report = this.deps.leases.lastClear?.leaseId === lease.id ? this.deps.leases.lastClear : undefined;
        // Commands written after the last server-confirmed progress (and before revocation): their effects are unknown.
        const afterRevokeAll = act.commands.filter((c) => revokedAtMs !== undefined && c.atMs > revokedAtMs).length;
        const unconfirmedCommands = Math.max(0, act.issued - lastConfirmedCommands - afterRevokeAll);
        const afterRevoke = act.commands.filter((c) => revokedAtMs !== undefined && c.atMs > revokedAtMs && !/revoked\)$/.test(c.command));
        const inventoryPackets = session.evidence.since(settleFrom, 'set_slot').length + session.evidence.since(settleFrom, 'window_items').length;
        return finish({
          status: 'cancelled',
          reason: lease.revocation ?? 'cancelled',
          effect: `cancelled; controls cleared${report ? ` in ${report.clearMs}ms` : ''}; confirmed partial effects: ${Object.keys(progress).length ? JSON.stringify(progress).slice(0, 160) : 'none'}; ${
            unconfirmedCommands > 0 ? `${unconfirmedCommands} game command(s) after the last confirmation have UNKNOWN effects` : 'no game command after the last confirmation'
          }; nothing is rolled back`,
          // Only server-stated partial effects confirm anything; local samples are labeled.
          confirmation: serverProvenance ?? 'none',
          evidence: {
            ...progress,
            ...(Object.keys(localProgress).length ? { localProgress: { ...localProgress, provenance: 'client model / local samples (not server-confirmed)' } } : {}),
            partialEffects: {
              confirmed: Object.keys(progress).length > 0 ? (serverProvenance ?? 'none') : 'none',
              confirmedAtMs: lastConfirmedAtMs !== undefined ? lastConfirmedAtMs - started : null,
              additional: unconfirmedCommands > 0 ? 'unknown' : 'none_sent',
              commandsAfterLastConfirmation: unconfirmedCommands,
            },
            cleanup: report ? { clearMs: report.clearMs, steps: report.steps, errors: report.errors, clearedShared: report.clearedShared } : null,
            commandsAfterRevoke: afterRevoke.length,
            serverInventoryPacketsDuringSettle: inventoryPackets,
            commandTrace: act.commands.slice(-16).map((c) => `${c.atMs - started}ms ${c.command}`),
            revokedAtMs: revokedAtMs !== undefined ? revokedAtMs - started : null,
            interfaceAfterSettle: {
              currentWindow: (session.bot.currentWindow as unknown as { id: number } | null)?.id ?? null,
              pendingRequests: interfaceGate(session, clock).pending().length,
              log: interfaceGate(session, clock).log.slice(-6).map((l) => l.event),
            },
          },
        });
      }
      if (error instanceof InterfaceBusyError) {
        const gate = interfaceGate(session, clock);
        return finish({
          status: 'precondition_failed',
          reason: 'interface_reply_pending',
          effect: error.message,
          evidence: { ...progress, ...(Object.keys(localProgress).length ? { localProgress } : {}), pendingRequests: error.pending, interfaceLog: gate.log.slice(-6).map((l) => l.event) },
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return finish({ status: 'failed', reason: 'runtime_error', effect: message.slice(0, 300), evidence: { ...progress, ...(Object.keys(localProgress).length ? { localProgress } : {}) } });
    } finally {
      signal.removeEventListener('abort', onAbort);
      // Normal completion releases the lease: controls cleared only if it is still current.
      this.deps.leases.revoke(lease, 'completed');
    }
  }
}
