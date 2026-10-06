// Composition of the MB-V1-02 adapters: perception, version knowledge, the
// skill registry/catalog, candidate generation, predicate evaluation, the
// evidence ledger, the single actuator lease and the skill executor. Installed
// into ChunkbotApp through AppDeps.adapters (same ports the foundation defined).
import type { Clock, DecisionPort, ExecutionOwner, GameLifecycleEvent, IdSource, PriorResultRef, RunStore } from '../contracts/index.ts';
import { NotReadyDecision } from '../goals/not-ready.ts';
import { TaskRuntime } from '../tasks/task-runtime.ts';
import type { ChunkbotConfig } from '../config/schema.ts';
import { TaskCandidateGenerator } from '../execution/candidates.ts';
import { SkillExecutorImpl, clearSharedControls } from '../execution/executor.ts';
import { EvidenceLedger } from '../execution/ledger.ts';
import { interfaceGate } from '../execution/interface-gate.ts';
import { ActuatorLeases } from '../execution/lease.ts';
import { PredicateEngine } from '../execution/predicates.ts';
import { SkillRegistry } from '../execution/registry.ts';
import type { GameSession } from '../game/connection.ts';
import { ownerPolicyFromConfig } from '../game/identity.ts';
import { VersionKnowledge } from '../knowledge/knowledge.ts';
import { PerceptionService } from '../perception/perception.ts';
import type { SkillServices } from '../skills/definition.ts';
import { allSkills } from '../skills/index.ts';
import type { AppAdapters } from './app.ts';

export interface SkillRuntimeOptions {
  config: ChunkbotConfig;
  session: () => GameSession | undefined;
  connectionEpoch: () => number;
  /** Current goal epoch from the goal engine (resolved lazily). */
  goalEpoch: () => number;
  /** Whether a diagnostic owner id is still the current diagnostic. */
  diagnosticCurrent: (id: string) => boolean;
  /** Connection identity facts (online-mode verification) for the owner policy. */
  admission: () => { serverOnlineMode: boolean };
  store: RunStore;
  clock: Clock;
  ids: IdSource;
  /** Jev decision adapter (MB-V1-03). Without it the task runtime reports decision not-ready. */
  decision?: DecisionPort & { attemptsForGoal?(goalId: string): number; readonly model?: string };
  /** Remaining per-run OpenRouter spend (model-visible context only). */
  spendRemainingUsd?: () => number | null;
  /** Operator-visible task controller events. */
  emitTask?: (kind: string, data: Record<string, unknown>) => void;
}

export class SkillRuntime {
  readonly perception: PerceptionService;
  readonly knowledge: VersionKnowledge;
  readonly registry: SkillRegistry;
  readonly ledger: EvidenceLedger;
  readonly leases: ActuatorLeases;
  readonly executor: SkillExecutorImpl;
  readonly candidates: TaskCandidateGenerator;
  readonly predicates: PredicateEngine;
  readonly services: SkillServices;
  readonly tasks: TaskRuntime;
  readonly decision: DecisionPort;
  private readonly options: SkillRuntimeOptions;

  constructor(options: SkillRuntimeOptions) {
    this.options = options;
    const { config, clock, ids, store } = options;
    this.registry = new SkillRegistry(allSkills());
    this.knowledge = new VersionKnowledge({
      version: config.minecraft.version,
      catalog: () => this.registry.catalog(),
      execution: { crafting: 'craft_item', cooking: ['furnace_insert', 'furnace_wait', 'furnace_take'] },
    });
    this.perception = new PerceptionService({
      session: options.session,
      clock,
      ids,
      observationRadius: config.limits.observationRadius,
      travelRadius: config.limits.travelRadius,
      ownerPolicy: ownerPolicyFromConfig(config),
      admission: options.admission,
    });
    this.ledger = new EvidenceLedger(clock, options.connectionEpoch);
    this.services = {
      perception: this.perception,
      knowledge: this.knowledge,
      ledger: this.ledger,
      clock,
      limits: { observationRadius: config.limits.observationRadius, travelRadius: config.limits.travelRadius, ownerLossMs: config.limits.ownerLossMs },
    };
    this.leases = new ActuatorLeases({
      clock,
      ownerCurrent: (owner: ExecutionOwner) => (owner.kind === 'goal' ? owner.goalEpoch === options.goalEpoch() : options.diagnosticCurrent(owner.diagnosticId)),
      connectionEpoch: options.connectionEpoch,
      clearShared: () => clearSharedControls(options.session()?.bot),
      record: (event) => store.record({ ...event, type: String(event['type'] ?? 'lease_event') }),
    });
    this.executor = new SkillExecutorImpl({
      registry: this.registry,
      leases: this.leases,
      session: options.session,
      services: this.services,
      goalEpoch: options.goalEpoch,
      store,
    });
    this.candidates = new TaskCandidateGenerator({ registry: this.registry, services: this.services, session: options.session, ids });
    this.predicates = new PredicateEngine({ services: this.services, session: options.session, leases: this.leases });
    const decision = options.decision ?? new NotReadyDecision();
    this.decision = decision;
    const limits = config.limits;
    this.tasks = new TaskRuntime({
      perception: this.perception,
      candidates: this.candidates,
      executor: this.executor,
      predicates: this.predicates,
      decision,
      sustained: (capability) => this.registry.get(capability)?.sustained,
      catalogVersion: () => this.registry.catalog().catalogVersion,
      mechanicsVersion: config.minecraft.version,
      connectionEpoch: options.connectionEpoch,
      decisionsRemaining: (goalId) => limits.decisionRequestsPerGoal - (options.decision?.attemptsForGoal?.(goalId) ?? 0),
      spendRemainingUsd: options.spendRemainingUsd ?? (() => null),
      model: options.decision?.model ?? config.models.decision.model,
      store,
      clock,
      ids,
      limits: { maxOptions: limits.decisionMaxOptions, noProgressMs: limits.noProgressMs, perTargetRetries: limits.perTargetRetries, lowHealth: limits.lowHealth },
      ...(options.emitTask ? { emit: options.emitTask } : {}),
    });
  }

  /** Port adapters for ChunkbotApp (task runtime, outcome evaluator, Jev, registry facts, verified prior results). The planner is composed separately (cli.ts). */
  adapters(): Partial<AppAdapters> {
    return {
      knowledge: this.knowledge,
      observation: this.perception,
      capabilities: this.registry,
      executor: this.executor,
      tasks: this.tasks,
      outcomes: this.predicates,
      decision: this.decision,
      registry: this.knowledge,
      priorResults: (ids) => this.priorResults(ids),
    };
  }

  /** Verified prior results (ledger-confirmed positions of this connection/lifecycle generation). */
  priorResults(actionIds: readonly string[]): PriorResultRef[] {
    const out: PriorResultRef[] = [];
    for (const actionId of actionIds) {
      const r = this.ledger.result(actionId);
      if (r) out.push({ actionId, key: r.key, at: { x: r.x, y: r.y, z: r.z }, dimension: r.dimension });
    }
    return out;
  }

  /**
   * Goal admission ownership (called by the goal engine before planning): the
   * goal's travel anchor is captured at the bot's position NOW and owned by the
   * goal epoch. Execution never re-anchors; only the next admission replaces it.
   */
  onGoalAdmitted(admission: { goalId: string; epoch: number; admittedAtMs: number }): void {
    const ok = this.perception.admitTravelAnchor(admission.epoch);
    const bounds = this.perception.travelBounds();
    this.options.store.record({ type: 'goal_travel_anchor', goalId: admission.goalId, epoch: admission.epoch, admitted: ok, anchor: bounds ? { x: Math.round(bounds.anchor.x * 10) / 10, y: Math.round(bounds.anchor.y * 10) / 10, z: Math.round(bounds.anchor.z * 10) / 10 } : null, radius: bounds?.radius ?? null });
  }

  /** Lifecycle interruptions revoke actuation immediately (handles become stale by epoch). */
  onLifecycle(event: GameLifecycleEvent): void {
    if (event.type === 'death' || event.type === 'dimension_change' || event.type === 'ended') {
      this.leases.revokeCurrent(`lifecycle_${event.type}`);
      this.ledger.invalidate(`lifecycle_${event.type}`);
      this.perception.invalidate(`lifecycle_${event.type}`);
      // Window ids restart on respawn/dimension change: in-flight interface requests are void.
      const session = this.options.session();
      if (session) interfaceGate(session, this.options.clock).clear(`lifecycle_${event.type}`);
    }
    // A fresh connection starts with a diagnostic (untagged) anchor; goals get theirs at admission.
    if (event.type === 'ready' && this.perception.travelAnchorGoalEpoch() === undefined) this.perception.setTravelAnchor(undefined);
  }
}
