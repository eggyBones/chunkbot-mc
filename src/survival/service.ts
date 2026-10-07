// SurvivalService: the single survival object the application composes. It
// implements the canonical SurvivalPolicyPort (supervisor), LowHealthAllowancePort
// (task runtime), SurvivalPredicatePort (predicate engine), SurvivalLifecyclePort
// (connection/lifecycle/memory) and the own-death destination provider
// (locator route port, structurally identical), plus the read-only skill
// support API used by src/skills/survival.ts.
//
// It never actuates, never calls a model and never owns a goal. Everything it
// proposes is admitted (or not) by the progression supervisor through the one
// GoalEngine path. Stale proposals, callbacks and incident references cannot
// revive work: every binding is checked against the current goal id/epoch,
// connection epoch and dimension.
import { join } from 'node:path';
import type { EvidenceEvent, GameLifecycleEvent } from '../contracts/ports.ts';
import type { MemoryFact, MemoryScope } from '../contracts/memory.ts';
import type { ObservationSnapshot } from '../contracts/observation.ts';
import {
  GATED_LATER_SLICES,
  type AllowanceTaskRef,
  type InterruptedDirective,
  type InventoryFacts,
  type LowHealthAllowanceGrant,
  type LowHealthAllowancePort,
  type LowHealthCheck,
  type OwnDeathDestinationProvider,
  type OwnerGoalEnd,
  type PreparationSignature,
  type RecoveryEpisode,
  type SupportAdmission,
  type SupportTerminal,
  type SurvivalAssessmentInput,
  type SurvivalConfig,
  type SurvivalDeathContext,
  type SurvivalDecision,
  type SurvivalLifecyclePort,
  type SurvivalPacketSource,
  type SurvivalPolicyPort,
  type SurvivalPredicatePort,
  type SurvivalProposal,
  type SurvivalRoutine,
  type SurvivalStateEvaluation,
  type SurvivalStatePredicate,
  type SurvivalStatus,
  type SurvivalStoreState,
  type Vitals,
} from '../contracts/survival.ts';
import { AllowanceBook } from './allowance.ts';
import { EpisodeBook, countedAttempts, distance, isOpen, preparationSignature, UNCOUNTED_OUTCOMES } from './episodes.ts';
import { safeFoods, type SurvivalItemRegistry } from './items.ts';
import { ROUTINE_ORDER, evalEat, evalInventoryRoom, evalRecovery, evalResupply, evalRest, evalToolUpkeep, freeSlots, reserveCount, wornTools, type DesignatedStorage, type PolicyContext, type RoutineEval } from './policy.ts';
import { SurvivalFileStore, survivalScopeDirectory } from './store.ts';
import { SurvivalTracker, type CapturedDeathRecord, type TrackerEvent } from './tracker.ts';

/** Subset of MemoryService survival uses (designated storage, recovery updates). */
export interface SurvivalMemoryPort {
  facts(): readonly MemoryFact[];
  updateDeathRecovery(factId: string, update: { regained?: Array<{ key: string; count: number }>; status?: 'abandoned'; detail?: string }, evidence: { detail: string; actionId?: string; capability?: string }): Promise<{ ok: boolean; detail: string }>;
}

export interface SurvivalServiceOptions {
  /** Undefined or `enabled: false`: survival is disabled (no proposals, no skills' candidates). */
  config: SurvivalConfig | undefined;
  /** Explicit operator scope (the memory scope). Undefined: recovery is blocked `durable_scope_unavailable`. */
  scope: MemoryScope | undefined;
  /** `<dataDir>/<config.dir>`; undefined: no durable store. */
  rootDir: string | undefined;
  registry: SurvivalItemRegistry;
  now: () => number;
  limits: { lowHealth: number; travelRadius: number };
  record?: (event: EvidenceEvent) => void;
  memory?: SurvivalMemoryPort;
  /** Latest filtered snapshot (predicate evaluation of the bounded site search). */
  latestSnapshot?: () => ObservationSnapshot | undefined;
  /** Far own-death routing (locator route port integration); undefined: far recovery stays blocked. */
  farRoute?: () => string | undefined;
  /** Store test seams. */
  store?: { pid?: number; isAlive?: (pid: number) => boolean; beforeRename?: (tmp: string) => void | Promise<void> };
}

interface Pending {
  proposal: SurvivalProposal;
  connectionEpoch: number;
  reserveKey?: string;
  /** Recovery: preparation/route signature measured from the SAME fresh facts the proposal used. */
  preparation?: PreparationSignature;
}

interface ActiveSupport {
  proposalId: string;
  routine: SurvivalRoutine;
  goalId: string;
  goalEpoch: number;
  connectionEpoch: number;
  dimension: string;
  admittedAtMs: number;
  signature: string;
  episodeId?: string;
  reserveKey?: string;
  allowanceId?: string;
  arrivedAtMs?: number;
  searchDone?: boolean;
}

interface RoutineBlock {
  signature: string;
  reason: string;
  detail: string;
  transient: boolean;
  atMs: number;
  untilMs?: number;
}

const INTERRUPT_REASONS = new Set(['death', 'low_health', 'dimension_change', 'disconnected', 'kicked']);
const TRANSIENT_END = new Set(['planner_not_ready', 'decision_not_ready', 'planner_error', 'decision_error', 'runtime_error', 'limit_exhausted']);
const clip = (s: string, n = 200) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export class SurvivalService implements SurvivalPolicyPort, LowHealthAllowancePort, SurvivalPredicatePort, SurvivalLifecyclePort, OwnDeathDestinationProvider {
  readonly enabled: boolean;
  readonly kind = 'own_death' as const;
  readonly tracker = new SurvivalTracker();
  private readonly options: SurvivalServiceOptions;
  private readonly cfg: SurvivalConfig | undefined;
  private store: SurvivalFileStore | undefined;
  private book: EpisodeBook | undefined;
  private storeState: SurvivalStoreState;
  private storeDetail: string;
  private persistedVersion = -1;
  private persistQueued = false;
  private readonly allowances: AllowanceBook;
  private readonly pending = new Map<string, Pending>();
  private active: ActiveSupport | undefined;
  private readonly blocks = new Map<SurvivalRoutine, RoutineBlock>();
  private readonly cooldowns = new Map<string, number>();
  private readonly admissions: number[] = [];
  private lastDecision: SurvivalStatus['lastDecision'];
  /** captureId -> episode id (this process). */
  private readonly captures = new Map<string, { episodeId: string; related: boolean }>();
  private lastCapture: { captureId: string; episodeId: string; atMs: number } | undefined;
  /** In-process interrupted directives when no durable store exists. */
  private readonly transientInterrupted: InterruptedDirective[] = [];
  private readonly revokedEpochs = new Set<number>();
  private proposalCounter = 0;
  private dimensionValue: string | undefined;
  private unsubscribeTracker: (() => void) | undefined;

  constructor(options: SurvivalServiceOptions) {
    this.options = options;
    this.cfg = options.config && options.config.enabled ? options.config : undefined;
    this.enabled = Boolean(this.cfg);
    this.storeState = !this.cfg ? 'disabled' : options.scope && options.rootDir ? 'empty' : 'unscoped';
    this.storeDetail = !this.cfg ? 'survival disabled by config' : options.scope && options.rootDir ? 'not opened' : 'no explicit operator world/bot scope (memory profile) is configured: durable recovery is blocked; eating/resting still work';
    this.allowances = new AllowanceBook({
      now: options.now,
      connectionEpoch: () => this.tracker.connectionEpoch,
      dimension: () => this.dimensionValue,
      vitals: () => this.tracker.vitals(),
      inventory: () => this.tracker.inventory(),
      threatRadius: this.cfg?.lowHealthAllowance.threatRadius ?? 8,
      record: (e) => this.record(e),
    });
    this.unsubscribeTracker = this.tracker.subscribe((e) => this.onTrackerEvent(e));
  }

  private record(event: EvidenceEvent): void {
    try {
      this.options.record?.(event);
    } catch {
      // evidence recording never breaks survival
    }
  }

  // ------------------------------------------------------------ startup / persistence

  /** Synchronous startup: loads the scoped episode store. Restart replays nothing. */
  open(): SurvivalStatus['store'] {
    if (!this.cfg || !this.options.scope || !this.options.rootDir || this.store) return this.storeView();
    const now = this.options.now();
    this.store = new SurvivalFileStore({ dir: survivalScopeDirectory(this.options.rootDir, this.options.scope), scope: this.options.scope, now: this.options.now, ...(this.options.store ?? {}) });
    try {
      const load = this.store.open();
      this.storeState = load.state;
      this.storeDetail = load.detail;
      if (load.body || load.state === 'empty') this.book = new EpisodeBook(this.options.scope, now, load.body);
      else if (load.state === 'read_only') this.book = undefined;
    } catch (error) {
      this.storeState = 'read_only';
      this.storeDetail = `survival store could not be opened: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (this.book) {
      const closed = this.book.closeInterruptedAttempts(now);
      if (closed > 0) this.record({ type: 'survival_restart_attempts_closed', count: closed });
      this.persistedVersion = closed > 0 ? -1 : this.book.version;
      this.persistSoon();
    }
    this.record({ type: 'survival_opened', state: this.storeState, detail: this.storeDetail, episodes: this.book?.episodes().length ?? 0 });
    return this.storeView();
  }

  private storeView(): SurvivalStatus['store'] {
    return { state: this.storeState, detail: this.storeDetail, ...(this.options.scope ? { scope: this.options.scope } : {}) };
  }

  private get storeWritable(): boolean {
    return Boolean(this.book && this.store?.canWrite);
  }

  private persistSoon(): void {
    if (!this.book || !this.store?.canWrite || this.persistQueued) return;
    this.persistQueued = true;
    queueMicrotask(() => {
      this.persistQueued = false;
      if (!this.book || this.book.version === this.persistedVersion) return;
      const version = this.book.version;
      void this.store?.write(this.book.snapshot()).then((rev) => {
        if (rev !== undefined) {
          this.persistedVersion = Math.max(this.persistedVersion, version);
          this.record({ type: 'survival_written', revision: rev });
        } else this.record({ type: 'survival_write_failed', error: clip(this.store?.lastError ?? 'unknown') });
      });
    });
  }

  async flush(): Promise<void> {
    await Promise.resolve();
    await this.store?.flush();
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.book && this.book.version !== this.persistedVersion && this.store?.canWrite) {
      await this.store.write(this.book.snapshot());
    }
    await this.store?.close();
    this.unsubscribeTracker?.();
    this.tracker.detach();
  }

  // ------------------------------------------------------------ lifecycle

  attachConnection(source: SurvivalPacketSource, ctx: { connectionEpoch: number; selfPosition: () => { dimension: string; at: { x: number; y: number; z: number } } | undefined; containerLayout?: () => { id: number; inventoryStart: number } | undefined; seed?: Parameters<SurvivalTracker['attach']>[1]['seed'] }): void {
    this.tracker.attach(source, { connectionEpoch: ctx.connectionEpoch, registry: this.options.registry, now: this.options.now, selfPosition: ctx.selfPosition, ...(ctx.containerLayout ? { containerLayout: ctx.containerLayout } : {}), ...(ctx.seed ? { seed: ctx.seed } : {}) });
    this.record({ type: 'survival_tracker_attached', connectionEpoch: ctx.connectionEpoch, seeded: Boolean(ctx.seed) });
  }

  /**
   * Call synchronously after the GoalEngine revocation prefix and BEFORE memory
   * and ledger invalidation. No I/O; persistence is queued.
   */
  onLifecycle(event: GameLifecycleEvent): void {
    switch (event.type) {
      case 'ready':
        this.dimensionValue = event.info.dimension;
        return;
      case 'death':
        this.tracker.ensureDeathCaptured();
        this.allowances.revokeFor(undefined, 'death');
        this.pending.clear();
        return;
      case 'respawn':
        this.dimensionValue = event.dimension;
        this.pending.clear();
        return;
      case 'dimension_change':
        this.dimensionValue = event.to;
        this.allowances.revokeFor(undefined, 'dimension_change');
        this.pending.clear();
        return;
      case 'ended':
        this.allowances.revokeFor(undefined, 'connection_ended');
        this.pending.clear();
        this.tracker.detach();
        return;
      default:
        return;
    }
  }

  private onTrackerEvent(e: TrackerEvent): void {
    if (!this.cfg) return;
    const now = this.options.now();
    if (e.type === 'death_captured') return this.onDeath(e.death, now);
    if (e.type === 'death_location_refined') {
      const c = this.captures.get(e.captureId);
      const ep = c && !c.related ? this.book?.get(c.episodeId) : undefined;
      const d = this.tracker.latest();
      if (ep && d) {
        this.book?.refineSite(ep, d.occurredAtMs, e.site, now);
        this.persistSoon();
      }
      return;
    }
    if (e.type === 'respawn_ready') {
      const open = this.book?.open();
      if (open && (open.phase === 'awaiting_respawn' || open.phase === 'assessing')) {
        const manifest = this.book?.assess(open, e.inventory, this.options.registry, this.cfg, now);
        this.record({ type: 'survival_loss_assessed', episodeId: open.episodeId, status: open.status, missing: manifest?.missing.length ?? 0, retained: manifest?.retained.length ?? 0, partial: manifest?.partial ?? true });
        if (open.status === 'no_loss' && open.incidentFactId) this.memoryUpdate(open.incidentFactId, { regained: manifest?.retained ?? [], detail: 'retained through respawn (not dropped); no recovery trip' }, 'fresh respawn inventory retained everything');
        else if ((open.phase as RecoveryEpisode['phase']) === 'concluded' && open.incidentFactId) this.memoryUpdate(open.incidentFactId, { status: 'abandoned', detail: open.blocker?.detail ?? open.status }, `recovery not attempted: ${open.blocker?.reason ?? open.status}`);
        this.persistSoon();
      }
    }
  }

  private onDeath(d: CapturedDeathRecord, now: number): void {
    if (this.captures.has(d.captureId)) return;
    if (!this.book) {
      this.captures.set(d.captureId, { episodeId: 'unscoped', related: false });
      this.lastCapture = { captureId: d.captureId, episodeId: 'unscoped', atMs: now };
      this.record({ type: 'survival_death_unscoped', captureId: d.captureId, detail: this.storeDetail });
      return;
    }
    const { episode, related } = this.book.recordDeath(d, undefined, this.cfg as SurvivalConfig, now);
    this.captures.set(d.captureId, { episodeId: episode.episodeId, related });
    this.lastCapture = { captureId: d.captureId, episodeId: episode.episodeId, atMs: now };
    this.record({ type: 'survival_death_captured', captureId: d.captureId, episodeId: episode.episodeId, related, frozenAt: d.lastAlive.frozenAt, inventorySource: d.lastAlive.source, stacks: d.lastAlive.stacks.length, clearingPacketsAfterFreeze: d.lastAlive.clearingPacketsAfterFreeze, siteSource: d.site.source, cause: d.cause.translationKey ?? d.cause.kind });
    if (this.active?.routine === 'death_recovery') this.active.searchDone = false;
    this.persistSoon();
  }

  /** MB-MEM-001 DeathContext of the SAME frozen capture (call right after onLifecycle(death)). */
  deathContext(): SurvivalDeathContext {
    const ctx = this.tracker.deathContext();
    const d = this.tracker.latest();
    return { ...ctx, ...(d ? { captureId: d.captureId } : {}), ...(d && d.cause.kind === 'server_message' && d.cause.translationKey ? { cause: { kind: 'observed' as const, detail: `server death message ${d.cause.translationKey}` } } : {}) };
  }

  /** EXACT link: memory durably recorded this capture as `memoryFactId`. Unknown capture ids are refused. */
  linkIncident(captureId: string, memoryFactId: string): void {
    const c = this.captures.get(captureId);
    if (!c || !this.book || !/^mf-[a-z0-9]{4,24}$/.test(memoryFactId)) {
      this.record({ type: 'survival_link_refused', captureId, factId: memoryFactId, reason: !c ? 'unknown_capture' : !this.book ? 'unscoped' : 'invalid_fact_id' });
      return;
    }
    const e = this.book.get(c.episodeId);
    if (!e) return;
    if (c.related) {
      if (!e.relatedIncidentFactIds.includes(memoryFactId) && e.relatedIncidentFactIds.length < 8) e.relatedIncidentFactIds.push(memoryFactId);
      const h = [...e.hazards].reverse().find((x) => !x.incidentFactId);
      if (h) h.incidentFactId = memoryFactId;
    } else {
      e.incidentFactId = memoryFactId;
      e.originalIncidentFactId = memoryFactId;
      const h = e.hazards[0];
      if (h && !h.incidentFactId) h.incidentFactId = memoryFactId;
    }
    this.book.touch(e, this.options.now());
    this.record({ type: 'survival_incident_linked', captureId, factId: memoryFactId, episodeId: e.episodeId, related: c.related });
    this.persistSoon();
  }

  private memoryUpdate(factId: string, update: { regained?: Array<{ key: string; count: number }>; status?: 'abandoned'; detail?: string }, detail: string, actionId?: string): void {
    const m = this.options.memory;
    if (!m) return;
    void m
      .updateDeathRecovery(factId, update, { detail, ...(actionId ? { actionId, capability: 'recover_lost_items' } : {}) })
      .then((r) => this.record({ type: 'survival_memory_updated', factId, ok: r.ok, detail: clip(r.detail) }))
      .catch((error: unknown) => this.record({ type: 'survival_memory_update_failed', factId, error: clip(error instanceof Error ? error.message : String(error)) }));
  }

  // ------------------------------------------------------------ policy port

  private designatedStorage(): DesignatedStorage[] {
    const facts = this.options.memory?.facts() ?? [];
    return facts
      .filter((f) => f.status === 'active' && f.category === 'container' && f.source === 'owner_statement' && f.location)
      .slice(0, 8)
      .map((f) => ({ factId: f.id, label: f.label, dimension: (f.location as NonNullable<MemoryFact['location']>).dimension, at: (f.location as NonNullable<MemoryFact['location']>).at }));
  }

  private onCooldown(key: string, now: number): boolean {
    const until = this.cooldowns.get(key);
    return until !== undefined && now < until;
  }

  private decide(d: SurvivalDecision, now: number): SurvivalDecision {
    const routine = d.kind === 'propose' ? d.proposal.routine : d.kind === 'blocked' ? d.routine : undefined;
    const reason = d.kind === 'propose' ? d.proposal.reason : d.reason;
    const prev = this.lastDecision;
    this.lastDecision = { kind: d.kind, ...(routine ? { routine } : {}), reason: clip(reason), atMs: now };
    if (!prev || prev.kind !== d.kind || prev.reason !== this.lastDecision.reason) this.record({ type: 'survival_decision', kind: d.kind, routine: routine ?? null, reason: clip(reason) });
    return d;
  }

  assess(input: SurvivalAssessmentInput): SurvivalDecision {
    const now = input.nowMs;
    const cfg = this.cfg;
    if (!cfg) return { kind: 'none', reason: 'survival disabled' };
    if (!input.connection?.ready) return this.decide({ kind: 'none', reason: 'not connected' }, now);
    if (input.connection.connectionEpoch !== this.tracker.connectionEpoch) return this.decide({ kind: 'none', reason: 'survival tracker is not attached to this connection' }, now);
    this.dimensionValue = input.connection.dimension;
    if (this.tracker.life !== 'alive') return this.decide({ kind: 'none', reason: `awaiting fresh respawn state (${this.tracker.life})` }, now);
    const vitals = this.tracker.vitals();
    const inv = this.tracker.inventory();
    for (const [id, p] of this.pending) if (p.proposal.expiresAtMs <= now || p.connectionEpoch !== input.connection.connectionEpoch) this.pending.delete(id);

    // Immediate safety: running work that is not an admitted eat/rest task is unsafe at low health.
    const lowNow = vitals !== null && vitals.connectionEpoch === input.connection.connectionEpoch && vitals.health > 0 && vitals.health <= this.options.limits.lowHealth;
    const a = input.active;
    if (lowNow && a.kind !== 'none' && !(a.kind === 'support' && (a.routine === 'eat' || a.routine === 'rest')) && a.goalEpoch !== undefined && !this.revokedEpochs.has(a.goalEpoch)) {
      this.revokedEpochs.add(a.goalEpoch);
      return this.decide({ kind: 'revoke_unsafe', reason: 'low_health', detail: `health ${vitals.health} is at or below ${this.options.limits.lowHealth}; the running ${a.kind} work is unsafe now`, retainOwnerIntent: a.kind === 'owner_goal' }, now);
    }
    if (!input.autonomyAllowed) return this.decide({ kind: 'none', reason: 'paused by the owner (stop); nothing automatic starts until resume' }, now);
    if (a.kind === 'owner_goal' || a.kind === 'diagnostic') return this.decide({ kind: 'none', reason: 'owner/operator work has priority' }, now);
    if (input.ownerIntentPending) return this.decide({ kind: 'none', reason: 'a pending owner instruction has priority' }, now);
    if (a.kind === 'support' || this.active) return this.decide({ kind: 'none', reason: 'a support routine is already running' }, now);
    // The open episode needs its loss assessment when the respawn was not observed by this process (restart).
    const ep = this.book?.open();
    if (ep && (ep.phase === 'awaiting_respawn' || ep.phase === 'assessing') && inv?.fullSync && !this.captures.size) {
      this.book?.assess(ep, inv, this.options.registry, cfg, now, [], false);
      this.persistSoon();
    }
    while (this.admissions.length && this.admissions[0]! < now - 3_600_000) this.admissions.shift();
    const serves: SurvivalProposal['serves'] = input.ownerIntentInterrupted ? 'owner_intent' : a.kind === 'progression' ? 'progression' : 'none';
    const ctx: PolicyContext = {
      now,
      cfg,
      registry: this.options.registry,
      lowHealth: this.options.limits.lowHealth,
      travelRadius: this.options.limits.travelRadius,
      vitals: vitals && vitals.connectionEpoch === input.connection.connectionEpoch ? vitals : null,
      inv,
      snapshot: input.snapshot && input.snapshot.connectionEpoch === input.connection.connectionEpoch ? input.snapshot : null,
      connection: { connectionEpoch: input.connection.connectionEpoch, dimension: input.connection.dimension },
      episode: this.book?.open(),
      episodeLinked: Boolean(this.book?.open()?.incidentFactId),
      storeWritable: this.storeWritable,
      storeDetail: this.storeDetail,
      storage: this.designatedStorage(),
      farRoute: this.options.farRoute,
      goalLimits: input.goalLimits,
      serves,
    };
    let firstBlocked: (RoutineEval & { blocked: object }) | undefined;
    for (const routine of ROUTINE_ORDER) {
      if (this.onCooldown(routine, now)) continue;
      const ev = this.evaluate(routine, ctx, now);
      if (!ev.need) {
        this.blocks.delete(routine);
        continue;
      }
      if ('blocked' in ev) {
        if ('conclude' in ev && ev.conclude && ctx.episode) this.concludeEpisode(ctx.episode, ev.conclude.status, ev.conclude.blocker, now);
        const prior = this.blocks.get(routine);
        if (!prior || prior.signature !== ev.signature) this.blocks.set(routine, { signature: ev.signature, reason: ev.blocked.reason, detail: ev.blocked.detail, transient: ev.blocked.transient, atMs: now, ...(ev.blocked.transient ? { untilMs: now + Math.min(cfg.blockedCooldownMs, 60_000) } : {}) });
        firstBlocked ??= ev;
        continue;
      }
      const prior = this.blocks.get(routine);
      if (prior && prior.signature === ev.signature && (!prior.transient || (prior.untilMs ?? 0) > now)) {
        // Unchanged condition after a block: no new proposal (no inference on unchanged state).
        firstBlocked ??= { ...ev, blocked: { reason: prior.reason, detail: prior.detail, transient: prior.transient } } as RoutineEval & { blocked: object };
        continue;
      }
      if (this.admissions.length >= cfg.admissionsPerHour && ev.proposal.priority !== 'safety') {
        return this.decide({ kind: 'blocked', routine, reason: 'admission_cap', detail: `${this.admissions.length} automatic support admissions in the last hour (cap ${cfg.admissionsPerHour})`, signature: `cap:${this.admissions.length}`, retryAfterMs: Math.max(0, (this.admissions[0] ?? now) + 3_600_000 - now) }, now);
      }
      this.proposalCounter += 1;
      const proposal: SurvivalProposal = { ...ev.proposal, proposalId: `sp-${this.proposalCounter.toString(36)}-${(now % 1_000_000).toString(36)}`, expiresAtMs: now + 30_000 };
      const reserveKey = routine === 'resupply' ? cfg.resupply.reserves.find((r) => ev.signature.startsWith(`resupply:${r.key}:`))?.key : undefined;
      const self = ctx.snapshot?.self.at;
      const preparation = routine === 'death_recovery' ? preparationSignature(inv, vitals?.health ?? 0, this.options.registry, self ? { dimension: ctx.connection.dimension, at: self } : undefined, this.farRoute(ctx), cfg.food.avoid) : undefined;
      this.pending.set(proposal.proposalId, { proposal, connectionEpoch: input.connection.connectionEpoch, ...(reserveKey ? { reserveKey } : {}), ...(preparation ? { preparation } : {}) });
      return this.decide({ kind: 'propose', proposal }, now);
    }
    if (firstBlocked && 'blocked' in firstBlocked) {
      const b = firstBlocked.blocked as { reason: string; detail: string; transient: boolean };
      return this.decide({ kind: 'blocked', routine: firstBlocked.routine, reason: b.reason, detail: b.detail, signature: firstBlocked.need ? firstBlocked.signature : '', ...(b.transient ? { retryAfterMs: 60_000 } : {}) }, now);
    }
    return this.decide({ kind: 'none', reason: 'no survival routine needed' }, now);
  }

  /** Route policy id the recovery proposal used (`local` within the travel bound). */
  private farRoute(ctx: PolicyContext): string {
    const e = ctx.episode;
    const self = ctx.snapshot?.self.at;
    if (!e?.site.at || !self) return 'local';
    return distance(self, e.site.at) > ctx.travelRadius - ctx.cfg.recovery.arrivalWithin ? (ctx.farRoute?.() ?? 'local') : 'local';
  }

  private evaluate(routine: SurvivalRoutine, ctx: PolicyContext, now: number): RoutineEval {
    switch (routine) {
      case 'eat':
        return evalEat(ctx);
      case 'rest':
        return evalRest(ctx);
      case 'death_recovery':
        return evalRecovery(ctx);
      case 'tool_upkeep':
        return evalToolUpkeep(ctx);
      case 'inventory_room':
        return evalInventoryRoom(ctx);
      case 'resupply':
        return evalResupply(ctx, (key) => this.onCooldown(`resupply:${key}`, now));
      default:
        return { routine, need: false, reason: 'gated later slice' };
    }
  }

  private concludeEpisode(e: RecoveryEpisode, status: RecoveryEpisode['status'], blocker: RecoveryEpisode['blocker'], now: number): void {
    if (!this.book || !isOpen(e)) return;
    this.book.conclude(e, status, blocker, now);
    this.record({ type: 'survival_episode_concluded', episodeId: e.episodeId, status, reason: blocker?.reason ?? null, regained: e.regained.reduce((n, r) => n + r.count, 0) });
    if (e.incidentFactId && status !== 'recovered') this.memoryUpdate(e.incidentFactId, { status: 'abandoned', detail: clip(`${status}: ${blocker?.detail ?? ''}`) }, `bounded recovery ended (${status}${blocker ? `, ${blocker.reason}` : ''})`);
    this.persistSoon();
  }

  onSupportAdmitted(adm: SupportAdmission): LowHealthAllowanceGrant | undefined {
    const p = this.pending.get(adm.proposalId);
    const now = this.options.now();
    if (!p || p.proposal.expiresAtMs < adm.admittedAtMs || p.connectionEpoch !== adm.connectionEpoch || this.active || adm.connectionEpoch !== this.tracker.connectionEpoch || !/^goal-[a-z0-9]{4,32}$/.test(adm.goalId)) {
      this.record({ type: 'survival_admission_ignored', proposalId: adm.proposalId, goalId: adm.goalId, reason: !p ? 'unknown_or_stale_proposal' : this.active ? 'support_already_active' : !/^goal-[a-z0-9]{4,32}$/.test(adm.goalId) ? 'invalid_goal_id' : 'expired_or_other_connection' });
      return undefined;
    }
    this.pending.delete(adm.proposalId);
    const dimension = this.dimensionValue ?? 'unknown';
    const active: ActiveSupport = { proposalId: adm.proposalId, routine: p.proposal.routine, goalId: adm.goalId, goalEpoch: adm.goalEpoch, connectionEpoch: adm.connectionEpoch, dimension, admittedAtMs: adm.admittedAtMs, signature: p.proposal.signature, ...(p.proposal.episodeId ? { episodeId: p.proposal.episodeId } : {}), ...(p.reserveKey ? { reserveKey: p.reserveKey } : {}) };
    this.admissions.push(now);
    if (active.routine === 'death_recovery' && this.book && active.episodeId) {
      const e = this.book.get(active.episodeId);
      const prep = p.preparation;
      const attempt = e && prep ? this.book.beginAttempt(e, adm.goalId, prep, now) : undefined;
      if (!attempt) {
        this.record({ type: 'survival_attempt_refused', goalId: adm.goalId, episodeId: active.episodeId });
        this.active = { ...active, episodeId: 'refused' };
        return undefined;
      }
      this.persistSoon();
    }
    this.active = active;
    let grant: LowHealthAllowanceGrant | undefined;
    if (p.proposal.lowHealthAllowance) {
      grant = this.allowances.issue(p.proposal.lowHealthAllowance, { goalId: adm.goalId, goalEpoch: adm.goalEpoch, connectionEpoch: adm.connectionEpoch, dimension });
      if (grant) active.allowanceId = grant.allowanceId;
    }
    this.record({ type: 'survival_support_admitted', proposalId: adm.proposalId, goalId: adm.goalId, goalEpoch: adm.goalEpoch, routine: active.routine, allowance: grant?.allowanceId ?? null });
    return grant;
  }

  onSupportTerminal(end: SupportTerminal): void {
    const a = this.active;
    const now = this.options.now();
    if (!a || a.goalId !== end.goalId || a.goalEpoch !== end.goalEpoch || a.proposalId !== end.proposalId) {
      this.record({ type: 'survival_terminal_ignored', goalId: end.goalId, proposalId: end.proposalId, reason: 'not the bound support goal (stale)' });
      return;
    }
    this.active = undefined;
    this.allowances.revokeFor(a.goalEpoch, `goal_${end.reason}`);
    const cfg = this.cfg;
    if (!cfg) return;
    const completed = end.reason === 'outcome_verified';
    if (a.routine === 'death_recovery' && this.book && a.episodeId && a.episodeId !== 'refused') {
      const e = this.book.get(a.episodeId);
      if (e) {
        if (a.searchDone) this.book.markSearched(e, now);
        this.book.endAttempt(e, a.goalId, end.reason, { plannerTurns: end.counters.plannerTurns, tasks: end.counters.tasksAdmitted, replans: end.counters.replans, activeMs: Math.max(0, end.endedAtMs - a.admittedAtMs) }, now);
        const searched = e.attempts.some((x) => x.goalId === a.goalId && x.searchedSite);
        if (isOpen(e) && searched) {
          this.concludeEpisode(e, e.regained.length ? 'partially_recovered' : 'unknown', { reason: 'not_found_in_bounded_search', detail: 'the bounded visible search at the site found no remaining matching drops; this is not proof that they despawned', atMs: now, signature: `recovery:${e.episodeId}:searched` }, now);
        } else if (isOpen(e) && !completed && !UNCOUNTED_OUTCOMES.has(end.reason)) {
          this.blocks.set('death_recovery', { signature: a.signature, reason: end.reason, detail: clip(end.detail), transient: TRANSIENT_END.has(end.reason), atMs: now, ...(TRANSIENT_END.has(end.reason) ? { untilMs: now + cfg.blockedCooldownMs } : {}) });
        }
        this.persistSoon();
      }
    } else if (completed) {
      const key = a.routine === 'resupply' && a.reserveKey ? `resupply:${a.reserveKey}` : a.routine;
      this.cooldowns.set(key, now + (a.routine === 'resupply' ? cfg.resupply.cooldownMs : 60_000));
      this.blocks.delete(a.routine);
    } else if (!UNCOUNTED_OUTCOMES.has(end.reason)) {
      const transient = TRANSIENT_END.has(end.reason);
      this.blocks.set(a.routine, { signature: a.signature, reason: end.reason, detail: clip(end.detail), transient, atMs: now, ...(transient ? { untilMs: now + cfg.blockedCooldownMs } : {}) });
      if (a.routine === 'resupply' && a.reserveKey) this.cooldowns.set(`resupply:${a.reserveKey}`, now + cfg.resupply.cooldownMs);
    }
    this.record({ type: 'survival_support_ended', goalId: end.goalId, routine: a.routine, state: end.state, reason: end.reason });
  }

  onOwnerGoalEnd(end: OwnerGoalEnd): void {
    if (!this.cfg || !INTERRUPT_REASONS.has(end.reason)) return;
    const d: InterruptedDirective = {
      goalId: end.goalId,
      instruction: clip(end.instruction, 1_000),
      ...(end.interpretation ? { interpretation: clip(end.interpretation, 1_000) } : {}),
      ...(end.outcome ? { outcome: clip(end.outcome.rendered, 1_000) } : {}),
      outcomeKind: end.outcome?.kind ?? 'none',
      ...(end.baseline ? { baseline: { capturedAtMs: end.baseline.capturedAtMs, counts: end.baseline.counts } } : {}),
      confirmedProgress: clip(end.progress, 1_000),
      interruptedAtMs: end.endedAtMs,
      reason: end.reason,
      continuation: 'requires_owner_decision',
      continuationDetail: 'continuing would need the preserved original outcome, baseline, counters, deadline and fenced references; ask the owner (no automatic replay or new baseline)',
      state: 'awaiting_owner',
      stateAtMs: end.endedAtMs,
    };
    const ep = end.reason === 'death' && this.lastCapture && Math.abs(this.lastCapture.atMs - end.endedAtMs) < 120_000 ? this.book?.get(this.lastCapture.episodeId) : undefined;
    if (ep && !ep.interrupted) this.book?.setInterrupted(ep, d, end.endedAtMs);
    else if (this.book) this.book.addInterrupted(d);
    else this.transientInterrupted.unshift(d), this.transientInterrupted.splice(4);
    this.record({ type: 'survival_owner_interrupted', goalId: end.goalId, reason: end.reason, episodeId: ep?.episodeId ?? null });
    this.persistSoon();
  }

  private allInterrupted(): InterruptedDirective[] {
    const fromEpisodes = (this.book?.episodes() ?? []).map((e) => e.interrupted).filter((x): x is InterruptedDirective => Boolean(x));
    return [...fromEpisodes, ...(this.book?.interrupted() ?? []), ...this.transientInterrupted];
  }

  onOwnerInstruction(atMs: number): void {
    let n = 0;
    for (const d of this.allInterrupted()) {
      if (d.state !== 'awaiting_owner') continue;
      d.state = 'superseded_by_owner';
      d.stateAtMs = atMs;
      n += 1;
    }
    this.pending.clear();
    if (n > 0 && this.book) {
      this.book.version += 1;
      this.persistSoon();
    }
  }

  dismissInterrupted(goalId: string, atMs: number): boolean {
    const d = this.allInterrupted().find((x) => x.goalId === goalId && x.state === 'awaiting_owner');
    if (!d) return false;
    d.state = 'dismissed_by_owner';
    d.stateAtMs = atMs;
    if (this.book) this.book.version += 1;
    this.persistSoon();
    return true;
  }

  /** True while an interrupted owner directive awaits the owner's decision (status/supervisor). */
  hasInterruptedOwnerIntent(): boolean {
    return this.allInterrupted().some((d) => d.state === 'awaiting_owner');
  }

  abandonRecovery(detail: string, atMs: number): void {
    const e = this.book?.open();
    if (!e) return;
    this.concludeEpisode(e, 'abandoned', { reason: 'owner_abandoned', detail: clip(detail), atMs, signature: `recovery:${e.episodeId}:abandoned` }, atMs);
  }

  // ------------------------------------------------------------ low-health allowance port

  check(task: AllowanceTaskRef, snapshot: ObservationSnapshot): LowHealthCheck {
    if (!this.cfg) return { allowed: false, reason: 'survival_disabled', detail: 'survival is disabled' };
    if (!this.active || this.active.goalId !== task.goalId || this.active.goalEpoch !== task.goalEpoch) return { allowed: false, reason: 'not_support_goal', detail: 'only an admitted eat/rest support goal can hold a low-health allowance' };
    return this.allowances.check(task, snapshot);
  }

  recheck(allowanceId: string, task: AllowanceTaskRef, candidate: { capability: string; parameters: Readonly<Record<string, unknown>> }, snapshot: ObservationSnapshot): LowHealthCheck {
    if (!this.active || this.active.goalId !== task.goalId || this.active.goalEpoch !== task.goalEpoch || this.active.allowanceId !== allowanceId) return { allowed: false, reason: 'not_support_goal', detail: 'the allowance no longer belongs to the active support goal' };
    return this.allowances.recheck(allowanceId, task, candidate, snapshot);
  }

  consumed(allowanceId: string, outcome: { actionId: string; capability: string; status: string }): void {
    this.allowances.consumed(allowanceId, outcome);
  }

  // ------------------------------------------------------------ predicate port

  evaluateSurvivalState(p: SurvivalStatePredicate, owner: { goalId: string; goalEpoch: number } | undefined): SurvivalStateEvaluation {
    const out = (status: SurvivalStateEvaluation['status'], detail: string, evidence: SurvivalStateEvaluation['evidence'] = {}): SurvivalStateEvaluation => ({ status, predicate: 'survival_state', detail, evidence: { routine: p.routine, expect: p.expect, ...evidence } });
    const cfg = this.cfg;
    if (!cfg) return out('unknown', 'survival is disabled');
    const a = this.active;
    if (!owner || !a || a.goalId !== owner.goalId || a.goalEpoch !== owner.goalEpoch || a.routine !== p.routine) return out('unknown', 'survival_state is evaluated only for its bound, admitted support goal');
    if (a.connectionEpoch !== this.tracker.connectionEpoch) return out('unknown', 'the support goal belongs to another connection');
    const v = this.tracker.vitals();
    const inv = this.tracker.inventory();
    const fresh = (x: Vitals | null): x is Vitals => Boolean(x && x.connectionEpoch === a.connectionEpoch);
    switch (p.routine) {
      case 'eat':
        if (p.expect !== 'satisfied') break;
        if (!fresh(v)) return out('unknown', 'no fresh server food level');
        if (v.food >= cfg.food.eatUntil) return out('satisfied', `server food ${v.food} >= ${cfg.food.eatUntil}`, { current: v.food });
        return out('unsatisfied', `server food ${v.food} < ${cfg.food.eatUntil}${safeFoods(inv?.stacks ?? [], this.options.registry, v.food, cfg.food.avoid).length ? '' : '; no suitable owned food remains'}`, { current: v.food });
      case 'rest':
        if (p.expect !== 'satisfied') break;
        if (!fresh(v)) return out('unknown', 'no fresh server health');
        if (v.health >= cfg.health.restUntil) return out('satisfied', `server health ${v.health} >= ${cfg.health.restUntil}`, { current: v.health });
        return out('unsatisfied', `server health ${v.health} < ${cfg.health.restUntil}`, { current: v.health });
      case 'death_recovery': {
        const e = a.episodeId ? this.book?.get(a.episodeId) : undefined;
        if (!e) return out('unknown', 'no bound recovery episode');
        const sought = this.book?.sought(e) ?? new Map<string, number>();
        const regained = e.regained.reduce((n, r) => n + r.count, 0);
        const ev = { recoveryStatus: e.status, regained, stillSought: [...sought.values()].reduce((n, c) => n + c, 0), current: regained };
        if (p.expect === 'recovered') {
          if (e.status === 'recovered' || e.status === 'no_loss') return out('satisfied', `all lost items regained (server-confirmed pickups): ${e.status}`, ev);
          return out('unsatisfied', `${ev.stillSought} item(s) still sought${e.manifest?.missing.some((m) => m.state === 'likely_destroyed') ? '; some are likely destroyed' : ''}`, ev);
        }
        if (p.expect !== 'concluded') break;
        if (!isOpen(e)) return out('satisfied', `recovery concluded: ${e.status}${e.status === 'recovered' ? '' : ' (NOT a full recovery)'}`, ev);
        if (sought.size === 0) return out('satisfied', 'nothing remains to recover', ev);
        const done = this.searchDone(e, sought);
        if (done) {
          a.searchDone = true;
          return out('satisfied', `bounded visible search at the site found no remaining matching drops (${regained} item(s) regained; ${ev.stillSought} still missing — not proof of despawn); concluded as ${regained ? 'partially_recovered' : 'unknown'}, NOT a full recovery`, { ...ev, recoveryStatus: regained ? 'partially_recovered' : 'unknown', searchDone: true });
        }
        return out('unsatisfied', `${ev.stillSought} item(s) still sought; the bounded site search is not finished`, ev);
      }
      case 'tool_upkeep':
        if (p.expect !== 'satisfied') break;
        if (!inv?.fullSync) return out('unknown', 'no full server inventory');
        return wornTools(inv, cfg).length === 0 ? out('satisfied', 'no nearly worn tool lacks a spare') : out('unsatisfied', 'a nearly worn tool still lacks a spare');
      case 'inventory_room': {
        if (p.expect !== 'satisfied') break;
        if (!inv?.fullSync) return out('unknown', 'no full server inventory');
        const free = freeSlots(inv);
        return free >= cfg.inventory.targetFreeSlots ? out('satisfied', `${free} free slots`, { current: free }) : out('unsatisfied', `${free} free slots (< ${cfg.inventory.targetFreeSlots})`, { current: free });
      }
      case 'resupply': {
        if (p.expect !== 'satisfied') break;
        const r = cfg.resupply.reserves.find((x) => x.key === a.reserveKey);
        if (!r || !inv?.fullSync) return out('unknown', 'no bound reserve or no full server inventory');
        const have = reserveCount(r.key, inv, { cfg, registry: this.options.registry });
        return have >= r.high ? out('satisfied', `${r.key}: ${have} >= ${r.high}`, { current: have }) : out('unsatisfied', `${r.key}: ${have} < ${r.high}`, { current: have });
      }
      default:
        return out('unknown', 'home/bed routines are a gated later slice');
    }
    return out('unknown', `expect ${p.expect} is not defined for ${p.routine}`);
  }

  private searchDone(e: RecoveryEpisode, sought: ReadonlyMap<string, number>): boolean {
    const a = this.active;
    const snap = this.options.latestSnapshot?.();
    const cfg = this.cfg;
    if (!a || !snap || !cfg || !a.arrivedAtMs || !e.site.at || snap.dimension !== e.site.dimension || snap.connectionEpoch !== a.connectionEpoch || snap.goalEpoch !== a.goalEpoch) return false;
    if (snap.takenAtMs < a.arrivedAtMs) return false;
    if (distance(snap.self.at, e.site.at) > cfg.recovery.arrivalWithin + 1.5) return false;
    return !snap.drops.some((d) => sought.has(d.key) && distance(d.at, e.site.at as { x: number; y: number; z: number }) <= cfg.recovery.searchRadius);
  }

  // ------------------------------------------------------------ own-death destination (locator RouteDestinationProvider shape)

  current(ctx: { connectionEpoch: number; dimension: string; goalEpoch: number }): { destinationId: string; dimension: string; at: { x: number; y: number; z: number }; recordedAtMs: number; label: string } | undefined {
    const t = this.recoveryTarget(ctx);
    if ('error' in t) return undefined;
    return { destinationId: `own_death:${t.episodeId}`, dimension: t.site.dimension, at: { ...t.site.at }, recordedAtMs: t.recordedAtMs, label: 'own death site' };
  }

  // ------------------------------------------------------------ skill support API (read-only facts + fenced bookkeeping)

  config(): SurvivalConfig | undefined {
    return this.cfg;
  }

  registry(): SurvivalItemRegistry {
    return this.options.registry;
  }

  vitals(connectionEpoch: number): Vitals | null {
    const v = this.tracker.vitals();
    return v && v.connectionEpoch === connectionEpoch ? v : null;
  }

  inventory(connectionEpoch: number): InventoryFacts | null {
    const i = this.tracker.inventory();
    return i && i.connectionEpoch === connectionEpoch ? i : null;
  }

  /** The bound recovery target for a goal epoch on the current connection/dimension, or why not. */
  recoveryTarget(fence: { goalEpoch: number; connectionEpoch: number; dimension: string }): { episodeId: string; goalId: string; site: { dimension: string; at: { x: number; y: number; z: number } }; recordedAtMs: number; sought: Map<string, number>; searchRadius: number; arrivalWithin: number } | { error: string; detail: string } {
    const a = this.active;
    const cfg = this.cfg;
    if (!cfg) return { error: 'survival_disabled', detail: 'survival is disabled' };
    if (!a || a.routine !== 'death_recovery' || a.goalEpoch !== fence.goalEpoch) return { error: 'not_a_recovery_goal', detail: 'only the admitted automatic recovery goal has a death-site destination' };
    if (a.connectionEpoch !== fence.connectionEpoch || this.tracker.connectionEpoch !== fence.connectionEpoch) return { error: 'connection_changed', detail: 'the recovery belongs to another connection' };
    const e = a.episodeId ? this.book?.get(a.episodeId) : undefined;
    if (!e || !isOpen(e)) return { error: 'episode_not_open', detail: 'the recovery episode is not open' };
    if (!e.incidentFactId) return { error: 'incident_not_linked', detail: 'the incident is not linked to a durable memory death fact' };
    if (!e.site.at || !e.site.dimension) return { error: 'site_unknown', detail: 'the death location is unknown' };
    if (e.site.dimension !== fence.dimension) return { error: 'dimension_mismatch', detail: `the death site is in ${e.site.dimension}` };
    return { episodeId: e.episodeId, goalId: a.goalId, site: { dimension: e.site.dimension, at: e.site.at }, recordedAtMs: e.site.observedAtMs ?? e.occurredAtMs, sought: this.book?.sought(e) ?? new Map(), searchRadius: cfg.recovery.searchRadius, arrivalWithin: cfg.recovery.arrivalWithin };
  }

  /** go_to_death_site arrived (fenced). */
  markArrived(fence: { goalId: string; goalEpoch: number; connectionEpoch: number }): boolean {
    const a = this.active;
    if (!a || a.goalId !== fence.goalId || a.goalEpoch !== fence.goalEpoch || a.connectionEpoch !== fence.connectionEpoch) return false;
    a.arrivedAtMs = this.options.now();
    const e = a.episodeId ? this.book?.get(a.episodeId) : undefined;
    if (e && isOpen(e)) {
      e.phase = 'collecting';
      this.book?.touch(e, a.arrivedAtMs);
      this.persistSoon();
    }
    return true;
  }

  /**
   * A server-confirmed pickup of a scoped drop by the bound recovery goal.
   * Counts only still-sought keys up to the missing amount (prior possessions,
   * never new acquisition). Stale goals/connections count nothing.
   */
  recordRegain(fence: { goalId: string; goalEpoch: number; connectionEpoch: number }, key: string, count: number, actionId: string): number {
    const a = this.active;
    if (!a || a.routine !== 'death_recovery' || a.goalId !== fence.goalId || a.goalEpoch !== fence.goalEpoch || a.connectionEpoch !== fence.connectionEpoch || this.tracker.connectionEpoch !== fence.connectionEpoch) {
      this.record({ type: 'survival_regain_ignored', goalId: fence.goalId, key, reason: 'not the bound recovery goal (stale)' });
      return 0;
    }
    const e = a.episodeId ? this.book?.get(a.episodeId) : undefined;
    if (!e || !this.book) return 0;
    const counted = this.book.regain(e, key, count, this.options.now());
    if (counted > 0) {
      this.record({ type: 'survival_regained', episodeId: e.episodeId, key, counted, offered: count, status: e.status });
      if (e.incidentFactId) this.memoryUpdate(e.incidentFactId, { regained: [{ key, count: counted }] }, `server-confirmed pickup of ${counted} ${key} near the own death site`, actionId);
      this.persistSoon();
    }
    return counted;
  }

  // ------------------------------------------------------------ status

  status(nowMs: number): SurvivalStatus {
    const v = this.tracker.vitals();
    const here = this.options.latestSnapshot?.()?.self.at;
    const cfg = this.cfg;
    const episodes = (this.book?.episodes() ?? []).filter((e) => isOpen(e) || nowMs - e.updatedAtMs < 6 * 3_600_000).slice(-4);
    return {
      enabled: this.enabled,
      store: this.storeView(),
      ...(this.active ? { activeRoutine: { routine: this.active.routine, goalId: this.active.goalId, since: this.active.admittedAtMs } } : {}),
      ...(this.lastDecision ? { lastDecision: { ...this.lastDecision } } : {}),
      ...(v ? { vitals: { health: v.health, food: v.food, saturation: v.saturation, ageS: Math.round((nowMs - v.atMs) / 1000) } } : {}),
      incidents: episodes.map((e) => ({
        episodeId: e.episodeId,
        ...(e.incidentFactId ? { incidentFactId: e.incidentFactId } : {}),
        ...(e.originalIncidentFactId ? { originalIncidentFactId: e.originalIncidentFactId } : {}),
        ageS: Math.round((nowMs - e.occurredAtMs) / 1000),
        site: { source: e.site.source, ...(e.site.dimension ? { dimension: e.site.dimension } : {}), ...(e.site.at ? { at: { x: Math.round(e.site.at.x), y: Math.round(e.site.at.y), z: Math.round(e.site.at.z) } } : {}), ...(here && e.site.at ? { distance: Math.round(distance(here, e.site.at)) } : {}) },
        cause: { hazard: e.cause.hazard, ...(e.cause.translationKey ? { translationKey: e.cause.translationKey } : {}) },
        phase: e.phase,
        status: e.status,
        missing: (e.manifest?.missing ?? []).filter((m) => m.state !== 'regained').slice(0, 12).map((m) => ({ key: m.key, count: m.count, state: m.state })),
        regained: e.regained.slice(-12).map((r) => ({ key: r.key, count: r.count })),
        manifestPartial: e.manifest?.partial ?? true,
        attempts: { used: countedAttempts(e), max: e.maxAttempts },
        budget: { ...e.budget, ceilings: { plannerTurns: cfg?.recovery.episodePlannerTurns ?? 0, tasks: cfg?.recovery.episodeTasks ?? 0, replans: cfg?.recovery.episodeReplans ?? 0, deadlineMs: cfg?.recovery.episodeDeadlineMs ?? 0 } },
        ...(e.blocker ? { blocker: { reason: e.blocker.reason, detail: e.blocker.detail } } : {}),
        relatedDeaths: e.relatedIncidentFactIds.length,
      })),
      interrupted: this.allInterrupted()
        .slice(0, 4)
        .map((d) => ({ goalId: d.goalId, instruction: clip(d.instruction, 120), reason: d.reason, continuation: d.continuation, state: d.state, ageS: Math.round((nowMs - d.interruptedAtMs) / 1000) })),
      blocked: [...this.blocks.entries()].map(([routine, b]) => ({ routine, reason: b.reason, detail: b.detail, ...(b.untilMs ? { retryInS: Math.max(0, Math.round((b.untilMs - nowMs) / 1000)) } : {}) })),
      cooldowns: [...this.cooldowns.entries()].filter(([, u]) => u > nowMs).map(([k, u]) => ({ routine: (k.startsWith('resupply:') ? 'resupply' : k) as SurvivalRoutine, ...(k.startsWith('resupply:') ? { key: k.slice('resupply:'.length) } : {}), remainingS: Math.round((u - nowMs) / 1000) })),
      admissionsLastHour: this.admissions.filter((t) => t > nowMs - 3_600_000).length,
      gated: [
        { slice: 'home_rest', status: 'mechanics_gate_pending', detail: 'bed/spawn routine at an approved Overworld home awaits its fixture mechanics gate (R8); no multiplayer night control is assumed' },
        ...GATED_LATER_SLICES.map((slice) => ({ slice, status: 'later_gated_slice' as const, detail: 'not implemented in this release' })),
      ],
    };
  }

  /** Bounded terminal status lines (no inference). */
  statusLines(nowMs: number): string[] {
    const s = this.status(nowMs);
    if (!s.enabled) return ['survival: disabled'];
    const lines = [`survival: store ${s.store.state}${s.activeRoutine ? `; active ${s.activeRoutine.routine} (${s.activeRoutine.goalId})` : ''}${s.vitals ? `; health ${s.vitals.health} food ${s.vitals.food}` : ''}${s.lastDecision ? `; last ${s.lastDecision.kind}${s.lastDecision.routine ? ` ${s.lastDecision.routine}` : ''}: ${clip(s.lastDecision.reason, 100)}` : ''}`];
    if (s.store.state === 'unscoped' || s.store.state === 'read_only') lines.push(`survival store: ${clip(s.store.detail, 200)}`);
    for (const i of s.incidents) {
      lines.push(`death ${i.episodeId}${i.incidentFactId ? `/${i.incidentFactId}` : ' (not linked to memory)'}: ${i.status} (${i.phase}), ${i.cause.translationKey ?? 'cause unknown'}, site ${i.site.at ? `${i.site.at.x},${i.site.at.y},${i.site.at.z} ${i.site.dimension}` : 'unknown'} [${i.site.source}]${i.site.distance !== undefined ? ` ${i.site.distance} blocks away` : ''}; attempts ${i.attempts.used}/${i.attempts.max}; missing ${i.missing.map((m) => `${m.count} ${m.key.replace('minecraft:', '')}${m.state !== 'missing' ? ` (${m.state})` : ''}`).join(', ') || 'none'}; regained ${i.regained.reduce((n, r) => n + r.count, 0)}${i.blocker ? `; blocker ${i.blocker.reason}: ${clip(i.blocker.detail, 120)}` : ''}`);
    }
    for (const d of s.interrupted.filter((x) => x.state === 'awaiting_owner')) lines.push(`interrupted owner goal ${d.goalId} (${d.reason}): "${d.instruction}" — needs your decision (a new instruction replaces it; nothing is replayed)`);
    for (const b of s.blocked) lines.push(`survival blocked ${b.routine}: ${b.reason} — ${clip(b.detail, 160)}`);
    return lines.slice(0, 12);
  }
}

export function survivalRoot(dataDir: string, config: SurvivalConfig | undefined): string {
  return join(dataDir, config?.dir ?? 'survival');
}
