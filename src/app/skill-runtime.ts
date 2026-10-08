// Composition of the MB-V1-02 adapters: perception, version knowledge, the
// skill registry/catalog, candidate generation, predicate evaluation, the
// evidence ledger, the single actuator lease and the skill executor. Installed
// into ChunkbotApp through AppDeps.adapters (same ports the foundation defined).
import type { Clock, DecisionPort, ExecutionOwner, GameLifecycleEvent, IdSource, PriorResultRef, RunStore } from '../contracts/index.ts';
import { NotReadyDecision } from '../goals/not-ready.ts';
import { TaskRuntime } from '../tasks/task-runtime.ts';
import { TaskMotionProgress } from '../tasks/motion-progress.ts';
import { currentMotionGuidance } from '../tasks/motion-guidance.ts';
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
import { MemoryService, memoryRoot } from '../memory/service.ts';
import { installedMemoryWorld } from '../memory/world.ts';
import { memorySkills } from '../skills/memory.ts';
import type { AutonomyControl } from '../autonomy/control.ts';
import { HomeProjectService } from '../autonomy/home.ts';
import { ShelterInspector, constructionSkills, evaluateStructure } from '../skills/construction.ts';
import type { GoalSource, RouteCarry, RouteGoalSource, SurvivalConfigInput } from '../contracts/index.ts';
import type { SafetyActuationPort, SafetyAuthority } from '../contracts/safety.ts';
import { createSafetyRuntime } from '../safety/wiring.ts';
import type { SafetyService } from '../safety/service.ts';
import { safetySkills } from '../skills/safety.ts';
import { countFor } from '../goals/continuation.ts';
import { safetyWorld } from '../safety/adapter.ts';
import { bindNavigationWorld } from '../skills/navigation.ts';
import { DEFAULT_LOCATOR_CONFIG, LocatorConfigSchema } from '../contracts/locator.ts';
import { LocatorService } from '../locator/service.ts';
import { RouteController } from '../locator/routes.ts';
import { locatorSkills } from '../skills/locator.ts';
import type { SurvivalService } from '../survival/service.ts';
import { createSurvivalService } from '../survival/wiring.ts';
import { survivalSkills } from '../skills/survival.ts';
import { verifyShelter } from '../autonomy/blueprint.ts';

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
  /** Ignored runtime storage root (LoadedConfig.dataDir); required for MB-MEM-001 memory (absent: memory off). */
  dataDir?: string;
  /** Application RUN identity, also used by survival's display-only checkpoints. */
  sessionId?: string;
  safetyAuthority?: () => SafetyAuthority;
  /**
   * Batch002 companion features (absent: none composed — existing harness
   * compositions are unchanged).
   * - `locator`: owner locator hints + code-owned route legs (MB-LOC-001).
   * - `survival`: survival policy/recovery/allowance + skills (MB-FLOW-003), using the explicit scope.
   * - `home`: home construction skills/predicate on the autonomy durable scope (MB-FLOW-001).
   */
  features?: {
    safety?: boolean;
    locator?: boolean;
    survival?: { config: SurvivalConfigInput | undefined; scope: { worldProfile: string; worldRevision: number; botProfile: string } | undefined };
    home?: { control: AutonomyControl; interior: 2 | 3; maxSiteDistance: number };
  };
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
  /** MB-MEM-001 memory; undefined when not configured (or disabled): no memory capability, view or hook. */
  readonly memory: MemoryService | undefined;
  /** MB-LOC-001 (when composed). */
  readonly locator: LocatorService | undefined;
  readonly routes: RouteController | undefined;
  /** MB-FLOW-003 (when composed). */
  readonly survival: SurvivalService | undefined;
  readonly safety: SafetyService | undefined;
  private readonly safetySettlements = new Set<Promise<unknown>>();
  /** MB-FLOW-001 home construction (when composed). */
  readonly home: HomeProjectService | undefined;
  readonly inspector: ShelterInspector | undefined;
  private detachMovement: (() => void) | undefined;
  private readonly options: SkillRuntimeOptions;

  constructor(options: SkillRuntimeOptions) {
    this.options = options;
    const { config, clock, ids, store } = options;
    const memoryConfig = config.memory?.enabled ? config.memory : undefined;
    this.memory = memoryConfig && options.dataDir
      ? new MemoryService({ config: memoryConfig, rootDir: memoryRoot(options.dataDir, memoryConfig), endpoint: `${config.minecraft.host}:${config.minecraft.port}`, clock, record: (event) => store.record(event) })
      : undefined;
    const features = options.features ?? {};
    // MB-LOC-001 route controller first: perception polls its effectiveTravel on every bounds query.
    const locatorConfig = features.locator ? (config.locator ? LocatorConfigSchema.parse(config.locator) : DEFAULT_LOCATOR_CONFIG) : undefined;
    let survivalRef: SurvivalService | undefined;
    this.routes = locatorConfig
      ? new RouteController({
          policy: locatorConfig.routes,
          clock,
          record: (e) => store.record(e),
          // Survival's own-incident destination (code-owned; provenance own_incident).
          ownDeath: {
            kind: 'own_death',
            current: (ctx) => {
              const d = survivalRef?.current(ctx);
              return d ? { ...d, provenance: 'own_incident' as const } : undefined;
            },
          },
        })
      : undefined;
    this.knowledge = new VersionKnowledge({
      version: config.minecraft.version,
      catalog: () => this.registry.catalog(),
      execution: { crafting: 'craft_item', cooking: ['furnace_insert', 'furnace_wait', 'furnace_take'] },
    });
    const routes = this.routes;
    this.perception = new PerceptionService({
      session: options.session,
      clock,
      ids,
      observationRadius: config.limits.observationRadius,
      travelRadius: config.limits.travelRadius,
      ownerPolicy: ownerPolicyFromConfig(config),
      admission: options.admission,
      ...(routes ? { effectiveTravel: (proof: Parameters<RouteController['effectiveTravel']>[0]) => routes.effectiveTravel(proof) } : {}),
    });
    this.locator = locatorConfig
      ? new LocatorService({ config: locatorConfig, version: config.minecraft.version, ownerPolicy: ownerPolicyFromConfig(config), admission: options.admission, session: options.session, clock, record: (e) => store.record(e) })
      : undefined;
    this.ledger = new EvidenceLedger(clock, options.connectionEpoch);
    // MB-FLOW-003 survival (explicit scope; same as autonomy/memory scope; never derived from the endpoint).
    this.survival = features.survival
      ? createSurvivalService({
          survival: features.survival.config ?? {},
          scope: features.survival.scope,
          dataDir: options.dataDir,
          minecraftVersion: config.minecraft.version,
          limits: { lowHealth: config.limits.lowHealth, travelRadius: config.limits.travelRadius },
          now: () => clock.now(),
          record: (e) => store.record(e),
          ...(this.memory ? { memory: this.memory } : {}),
          latestSnapshot: () => this.perception.latest(),
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(routes ? { farRoute: () => (routes.policy.enabled && (routes.policy.destinations as readonly string[]).includes('own_death') ? 'locator_route_legs' : undefined) } : {}),
        })
      : undefined;
    survivalRef = this.survival;
    this.services = {
      perception: this.perception,
      knowledge: this.knowledge,
      ledger: this.ledger,
      clock,
      limits: { observationRadius: config.limits.observationRadius, travelRadius: config.limits.travelRadius, ownerLossMs: config.limits.ownerLossMs },
    };
    this.safety = features.safety ? createSafetyRuntime({
      config: config.safety,
      session: options.session,
      perception: this.perception,
      inTag: (tag, key) => Boolean(this.knowledge.recipes?.matches(tag, key)),
      authority: () => options.safetyAuthority?.() ?? { basis: 'none', detail: 'application authority unavailable', connection: null, alive: false, goal: null, travel: null },
      actuation: this.safetyActuation(),
      clock, ids, record: (e) => store.record(e),
    }).service : undefined;
    if (this.safety) this.installSafetyGrantCheck((id) => this.safety!.grantCurrent(id));
    // MB-FLOW-001 home construction on the autonomy durable scope.
    if (features.home) {
      this.home = new HomeProjectService({ control: features.home.control, clock, record: (e) => store.record(e) });
      this.inspector = new ShelterInspector(options.session, this.services);
    } else {
      this.home = undefined;
      this.inspector = undefined;
    }
    this.registry = new SkillRegistry([
      ...allSkills(),
      ...memorySkills(this.memory),
      ...(this.home && this.inspector && features.home ? constructionSkills({ home: this.home, inspector: this.inspector, interior: features.home.interior, maxSiteDistance: features.home.maxSiteDistance }) : []),
      ...survivalSkills(this.survival),
      ...(this.safety ? safetySkills(this.safety) : []),
      ...(this.routes ? locatorSkills({ ...(this.locator ? { locator: this.locator } : {}), routes: this.routes }) : []),
    ]);
    this.leases = new ActuatorLeases({
      clock,
      ownerCurrent: (owner: ExecutionOwner) => (owner.kind === 'goal' ? owner.goalEpoch === options.goalEpoch() : owner.kind === 'diagnostic' ? options.diagnosticCurrent(owner.diagnosticId) : this.safetyGrantCurrent(owner.grantId)),
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
      ...(this.memory ? { onOutcome: (outcome) => this.memory?.recordOutcome(outcome) } : {}),
    });
    this.candidates = new TaskCandidateGenerator({ registry: this.registry, services: this.services, session: options.session, ids });
    const home = this.home;
    const inspector = this.inspector;
    this.predicates = new PredicateEngine({
      services: this.services,
      session: options.session,
      leases: this.leases,
      ...(this.memory ? { memory: this.memory } : {}),
      ...(home && inspector ? { structures: { evaluateStructure: (expect: 'site_approved' | 'enclosed' | 'complete') => evaluateStructure(home, inspector, options.session, expect) } } : {}),
      ...(this.survival ? { survival: this.survival } : {}),
      incidentReturns: (incidentId, selector) => {
        const r = this.survival?.incidentReturns(incidentId);
        if (!r || r.attribution !== 'server_attributed') return null;
        const matches = (sel: string, key: string) => sel.startsWith('#') ? Boolean(this.knowledge.recipes?.matches(sel, key)) : sel === key;
        return countFor(r.regained, selector, matches) + countFor(r.retained, selector, matches);
      },
    });
    if (this.memory) {
      this.memory.attachWorld(installedMemoryWorld({ session: options.session, perception: this.perception, ledger: this.ledger, clock }));
      this.memory.open();
    }
    const decision = options.decision ?? new NotReadyDecision();
    this.decision = decision;
    const limits = config.limits;
    const locator = this.locator;
    const motionProgress = routes && locator ? new TaskMotionProgress({
      executor: this.executor,
      guidance: (task, candidate, sample) => currentMotionGuidance({
        descriptor: (capability) => this.registry.get(capability)?.descriptor,
        routes, locator,
        admissionBounds: () => this.perception.admissionBounds(),
        goalEpoch: options.goalEpoch, connectionEpoch: options.connectionEpoch,
        held: () => Boolean(this.safety?.hold()),
      }, task, candidate, sample),
    }) : undefined;
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
      ...(this.survival ? { lowHealthAllowance: this.survival } : {}),
      ...(this.safety ? { safety: this.safety } : {}),
      ...(motionProgress ? { motionProgress } : {}),
    });
  }

  /**
   * Connection creation hook (before login): the survival packet tracker and
   * the locator waypoint listener see join-time packets of THIS epoch.
   */
  onBotCreated(bot: { _client?: unknown; registry?: unknown; entity?: { position?: { x: number; y: number; z: number } }; game?: { dimension?: unknown } }, connectionEpoch: number): void {
    const client = bot._client as (import('node:events').EventEmitter & { on(e: string, l: (p: never) => void): unknown }) | undefined;
    if (!client || typeof client.on !== 'function') return;
    bindNavigationWorld(bot as GameSession['bot'], () => {
      const s = this.options.session();
      return s && s.bot === bot && s.connectionEpoch === connectionEpoch ? safetyWorld(s) : undefined;
    });
    this.safety?.attachConnection(client as never, { connectionEpoch, registry: () => bot.registry });
    if (this.survival) {
      try {
        this.survival.attachConnection(client as never, {
          connectionEpoch,
          selfPosition: () => {
            const p = bot.entity?.position;
            return p && bot.game?.dimension !== undefined ? { dimension: String(bot.game.dimension), at: { x: p.x, y: p.y, z: p.z } } : undefined;
          },
        });
      } catch (error) {
        this.options.store.record({ type: 'survival_attach_error', message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.locator) {
      try {
        this.locator.attach(client as never, connectionEpoch);
      } catch (error) {
        this.options.store.record({ type: 'locator_attach_error', message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** Read-only views for the goal engine (planner request route context / locator hint). */
  routeView(goalEpoch: number): { authorized: boolean; destinations: readonly ('owner' | 'owner_destination' | 'own_death')[]; ownDeathAvailable: boolean; state: import('../contracts/index.ts').RouteState | null; status: import('../contracts/index.ts').RouteStatus | null; admission: { anchor: { x: number; y: number; z: number }; radius: number } | null } | undefined {
    const routes = this.routes;
    const s = this.options.session();
    if (!routes || !s) return undefined;
    const ctx = { goalEpoch, connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension) };
    const proof = this.perception.admissionBounds();
    return { ...routes.proposalContext(ctx), status: routes.status(goalEpoch), admission: proof && proof.goalEpoch === goalEpoch ? { anchor: { ...proof.anchor }, radius: proof.radius } : null };
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
      ...(this.memory ? { memory: this.memory } : {}),
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
  onGoalAdmitted(admission: { goalId: string; epoch: number; admittedAtMs: number; instruction?: string; source?: GoalSource; deadlineAtMs?: number; ownerCoordinates?: Array<{ x: number; y: number; z: number; source: 'instruction' | 'answer' }>; continuation?: { number: number; anchor: { dimension: string; at: { x: number; y: number; z: number }; radius: number } | null; route: RouteCarry | null | undefined } }): void {
    // MB-MEM-001: keep the owner's words for grounding designations (synchronous, no I/O).
    if (this.memory && admission.instruction !== undefined) {
      try {
        this.memory.beginGoal({ goalId: admission.goalId, epoch: admission.epoch, instruction: admission.instruction });
      } catch (error) {
        this.options.store.record({ type: 'memory_hook_error', hook: 'beginGoal', message: error instanceof Error ? error.message : String(error) });
      }
    }
    // MB-FLOW-003-C12: a continuation installs the job's ORIGINAL admission anchor (never the respawn position);
    // without one, goal actions stay refused (no re-anchoring).
    const cont = admission.continuation;
    const ok = cont ? (cont.anchor ? this.perception.admitTravelAnchor(admission.epoch, cont.anchor.at, cont.anchor.dimension) : false) : this.perception.admitTravelAnchor(admission.epoch);
    const proof = this.perception.admissionBounds();
    this.options.store.record({ type: 'goal_travel_anchor', goalId: admission.goalId, epoch: admission.epoch, admitted: ok, anchor: proof ? { x: Math.round(proof.anchor.x * 10) / 10, y: Math.round(proof.anchor.y * 10) / 10, z: Math.round(proof.anchor.z * 10) / 10 } : null, radius: proof?.radius ?? null });
    // MB-LOC-001: route authorization for THIS goal epoch from operator policy (synchronous; one admission per epoch).
    if (this.routes && proof && proof.goalEpoch === admission.epoch && cont) {
      // C12 route lineage: only the cumulative authorization transfers (L's RouteController); no refill, no old leg.
      if (cont.route) {
        try {
          this.routes.admitContinuation(cont.route, { goalId: admission.goalId, goalEpoch: admission.epoch, admittedAtMs: admission.admittedAtMs, source: 'owner', goalDeadlineMs: admission.deadlineAtMs ?? admission.admittedAtMs, connectionEpoch: proof.connectionEpoch, dimension: proof.dimension, admissionAnchor: { ...proof.anchor }, admissionRadius: proof.radius, ownerCoordinates: (admission.ownerCoordinates ?? []).map((c) => ({ x: c.x, y: c.y, z: c.z, source: c.source })) });
        } catch (error) {
          this.options.store.record({ type: 'route_admission_error', goalId: admission.goalId, message: error instanceof Error ? error.message : String(error) });
        }
      } else this.options.store.record({ type: 'route_continuation_not_granted', goalId: admission.goalId, epoch: admission.epoch, reason: cont.route === null ? 'the job had no route authorization' : cont.route === undefined ? 'the route lineage could not be exported' : 'route continuation admission is not installed' });
    } else if (this.routes && proof && proof.goalEpoch === admission.epoch) {
      const source: RouteGoalSource = admission.source ? admission.source.kind : 'diagnostic';
      try {
        this.routes.admit({
          goalId: admission.goalId,
          goalEpoch: admission.epoch,
          admittedAtMs: admission.admittedAtMs,
          source,
          goalDeadlineMs: admission.deadlineAtMs ?? admission.admittedAtMs + this.options.config.limits.goalDeadlineMs,
          connectionEpoch: proof.connectionEpoch,
          dimension: proof.dimension,
          admissionAnchor: { ...proof.anchor },
          admissionRadius: proof.radius,
          ownerCoordinates: (admission.ownerCoordinates ?? []).map((c) => ({ x: c.x, y: c.y, z: c.z, source: c.source })),
        });
      } catch (error) {
        this.options.store.record({ type: 'route_admission_error', goalId: admission.goalId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  // ------------------------------------------------------------ MB-FLOW-003-C11/C13 shared safety seams (structural)

  /** Installed by the immediate-safety service composition (W's SafetyPort.grantCurrent); absent: every safety owner is refused. */
  private grantCheck: ((grantId: string) => boolean) | undefined;

  installSafetyGrantCheck(check: ((grantId: string) => boolean) | undefined): void {
    this.grantCheck = check;
  }

  /** Lease fence for `{ kind: 'safety' }` owners: fail closed without an installed, current grant. */
  safetyGrantCurrent(grantId: string): boolean {
    try {
      return this.grantCheck?.(grantId) ?? false;
    } catch {
      return false;
    }
  }

  /**
   * SafetyActuationPort over the existing single lease and executor (no second
   * controller): synchronous preemption of a non-safety lease (the goal stays
   * admitted) and execution of ONE code-built safety candidate.
   */
  safetyActuation(): SafetyActuationPort {
    return {
      preemptCurrent: (reason) => this.leases.preemptForSafety(reason),
      execute: (candidate, signal, owner) => {
        const running = this.executor.execute(candidate, signal, owner);
        this.safetySettlements.add(running);
        void running.then(() => this.safetySettlements.delete(running), () => this.safetySettlements.delete(running));
        return running;
      },
    };
  }

  /** MB-FLOW-003-C12 (synchronous, before lifecycle invalidation): the ORIGINAL admission anchor of a goal epoch. */
  continuationAnchor(goalEpoch: number): { dimension: string; at: { x: number; y: number; z: number }; radius: number } | undefined {
    const proof = this.perception.admissionBounds();
    return proof && proof.goalEpoch === goalEpoch ? { dimension: proof.dimension, at: { ...proof.anchor }, radius: proof.radius } : undefined;
  }

  /** MB-FLOW-003-C12: atomically export the canonical route lineage then revoke it. */
  continuationRoute(goalEpoch: number): RouteCarry | null | undefined {
    if (!this.routes) return null;
    return this.routes.revokeWithCarry('continuation_capture', goalEpoch);
  }

  /** Starts only after the app authority host has been installed. */
  startSafety(): void { this.safety?.start(); }

  /** Abort synchronously, then wait bounded for every owned executor settlement. */
  async closeSafety(): Promise<void> {
    let closeError: unknown;
    try { await this.safety?.close(); } catch (error) { closeError = error; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      Promise.allSettled([...this.safetySettlements]).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.options.config.limits.cleanupTimeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    this.options.store.record({ type: 'safety_cleanup', settled: settled && !closeError, pending: this.safetySettlements.size, ...(closeError ? { error: closeError instanceof Error ? closeError.message : String(closeError) } : {}) });
    if (closeError) throw closeError;
    if (!settled) throw new Error('owned safety executor cleanup did not settle within its bound');
  }

  /** Goal terminal (MB-MEM-001): verified outcomes become milestones; refs are released. Never throws. */
  onGoalTerminal(end: { goalId: string; epoch?: number; kind: string; reason: string; detail: string; interpretation?: string; source?: GoalSource; state?: string }): void {
    if (this.routes) this.routes.revoke(`goal_${end.reason}`, end.epoch);
    this.homeOnTerminal(end);
    if (!this.memory) return;
    try {
      this.memory.onGoalTerminal({ goalId: end.goalId, reason: end.reason, detail: end.detail, kind: end.kind, ...(end.interpretation ? { interpretation: end.interpretation } : {}) });
    } catch (error) {
      this.options.store.record({ type: 'memory_hook_error', hook: 'onGoalTerminal', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Home project bookkeeping after a goal ends: a fresh inspection is stored;
   * a code-verified complete shelter is recorded in memory; an unfinished
   * build is marked interrupted with any remaining temporary aid reported as a
   * partial effect (cleanup never mines/places after ownership is lost).
   */
  private homeOnTerminal(end: { goalId: string; reason: string; detail: string }): void {
    const home = this.home;
    const inspector = this.inspector;
    const project = home?.project();
    const s = this.options.session();
    if (!home || !inspector || !project || !s || String(s.bot.game.dimension) !== project.dimension) return;
    try {
      const { verdicts, verdict } = inspector.inspect(project);
      void home.verified(verdict).then((p) => {
        if (verdict.status === 'complete' && p && this.memory) {
          const outer = project.size.outerX;
          void this.memory.recordVerifiedHome({ location: { dimension: project.dimension, at: { x: project.origin.x + Math.floor(outer / 2), y: project.origin.y, z: project.origin.z + Math.floor(outer / 2) } }, detail: verdict.detail, goalId: end.goalId });
          return;
        }
        if (verdict.status !== 'complete' && project.checkpoints.length > 0 && end.reason !== 'outcome_verified') {
          const aid = verdicts.find((v) => v.cell.role === 'aid' && v.status === 'missing');
          void home.interrupted(`${end.reason}${aid ? `; the temporary construction aid remains at ${aid.cell.at.x},${aid.cell.at.y},${aid.cell.at.z} (partial effect)` : ''}`);
        }
      });
    } catch (error) {
      this.options.store.record({ type: 'home_hook_error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Lifecycle interruptions revoke actuation immediately (handles become stale by epoch). */
  // Order (C1-approved, after the engine's synchronous revocation prefix):
  // (1) survival consumes its packet-frozen last-alive capture (no I/O);
  // (2) memory records EXACTLY that capture and survival links it by captureId ->
  //     memory fact id (no time matching; a missing link blocks recovery);
  // (3) route/locator/inspector void connection-scoped state;
  // (4) lease, ledger, perception and interface invalidation.
  onLifecycle(event: GameLifecycleEvent): void {
    this.safety?.onLifecycle(event);
    let survivalDeath: ReturnType<SurvivalService['deathContext']> | undefined;
    if (this.survival) {
      try {
        this.survival.onLifecycle(event);
        if (event.type === 'death') survivalDeath = this.survival.deathContext();
      } catch (error) {
        this.options.store.record({ type: 'survival_hook_error', hook: 'onLifecycle', message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.memory) {
      try {
        const { captureId, ...ctx } = survivalDeath ?? { captureId: undefined };
        const fact = this.memory.onLifecycle(event, survivalDeath ? (ctx as Parameters<MemoryService['onLifecycle']>[1]) : undefined);
        if (event.type === 'death' && this.survival && captureId) {
          if (fact) this.survival.linkIncident(captureId, fact.id);
          else this.options.store.record({ type: 'survival_incident_unlinked', captureId, reason: 'memory did not record the capture (disabled, read-only or conflicted); recovery stays blocked' });
        }
      } catch (error) {
        this.options.store.record({ type: 'memory_hook_error', hook: 'onLifecycle', message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.locator) {
      try {
        this.locator.onLifecycle(event);
      } catch (error) {
        this.options.store.record({ type: 'locator_hook_error', message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.routes && (event.type === 'death' || event.type === 'dimension_change' || event.type === 'ended' || event.type === 'respawn')) this.routes.revoke(`lifecycle_${event.type}`);
    if (event.type === 'ended') {
      this.detachMovement?.();
      this.detachMovement = undefined;
    }
    if (event.type === 'ready' && this.routes) {
      const session = this.options.session();
      if (session) this.detachMovement = this.routes.attachMovement(session, () => this.options.goalEpoch());
    }
    if (event.type === 'death' || event.type === 'dimension_change' || event.type === 'ended' || event.type === 'respawn') this.inspector?.reset();
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
