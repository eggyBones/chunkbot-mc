// Immediate safety service (MB-FLOW-003-C11/C13): the single code-owned
// local monitor, finite grants and bounded response episodes.
//
//   tick (every config.tickMs, local, no inference)
//     -> explicit authority from the host (owner_goal | unpaused | none)
//     -> fresh self/visible-entity facts -> planSafety
//     -> respond: SafetyGrant + synchronous preemption of the current
//        non-safety lease, then code-built candidates of the registered
//        safety skills through the SHARED executor with owner kind `safety`
//        (re-planned from fresh facts after every step, bounded by the grant)
//     -> blocked: one declarative blocker (hold) until the hazard changes
//     -> none: nothing.
//
// Ordinary work consults `hold()` / `waitClear()` before every dispatch;
// a preempted action returns `cancelled`/`safety_preempt` and its task
// waits, then re-observes. Explicit stop / lifecycle revoke the grant and
// abort the in-flight step synchronously (the executor revokes the lease and
// clears controls); nothing keeps moving afterwards.
import type { ActionCandidate, IdSource, SkillOutcome } from '../contracts/index.ts';
import type { GameLifecycleEvent } from '../contracts/ports.ts';
import {
  SAFETY_BOUNDS,
  SAFETY_CAPABILITY_FOR,
  SafetyConfigSchema,
  type SafetyActuationPort,
  type SafetyAuthority,
  type SafetyClear,
  type SafetyConfig,
  type SafetyConfigInput,
  type SafetyEntityFact,
  type SafetyEpisodeOutcome,
  type SafetyEpisodeResult,
  type SafetyExecutionOwner,
  type SafetyGrant,
  type SafetyHazardKind,
  type SafetyHold,
  type SafetyLifecyclePort,
  type SafetyPacketSource,
  type SafetyPlan,
  type SafetyPort,
  type SafetyResponseKind,
  type SafetySelfFacts,
  type SafetyStatus,
} from '../contracts/safety.ts';
import { dispositionOf } from './dispositions.ts';
import { findFluidExits, findOpenColumn, findRetreatTargets, hasSafeFluidSupport, type SafetyBlockReader } from './geometry.ts';
import { planSafety, threatHazards, type PolicyContext } from './policy.ts';
import { SafetyTracker, type SafetyItemRegistry } from './tracker.ts';

/** Read side the service needs (SessionSafetyReader implements it; tests use fakes). */
export interface SafetyFactsSource {
  self(): SafetySelfFacts | undefined;
  entities(opts: { scanRadius: number; approachWindowMs: number; provokedWindowMs: number }): SafetyEntityFact[];
  world(): SafetyBlockReader | undefined;
  /** Floor-face visibility from the current eye. */
  visible(): ((x: number, y: number, z: number) => boolean) | undefined;
  /** Current body position (client physics) for the displacement fence. */
  position?(): { x: number; y: number; z: number } | undefined;
  reset(): void;
}

export interface SafetyTimers {
  every(ms: number, fn: () => void): unknown;
  after(ms: number, fn: () => void): unknown;
  clear(handle: unknown): void;
}

export const systemTimers: SafetyTimers = {
  every: (ms, fn) => setInterval(fn, ms),
  after: (ms, fn) => setTimeout(fn, ms),
  clear: (h) => {
    clearInterval(h as ReturnType<typeof setInterval>);
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

export interface SafetyServiceDeps {
  config?: SafetyConfigInput;
  /** Explicit current authority (shared writer; synchronous, cheap). */
  authority(): SafetyAuthority;
  actuation: SafetyActuationPort;
  reader: SafetyFactsSource;
  /** Exact-version item tag membership. */
  inTag(tag: '#minecraft:swords' | '#minecraft:axes', key: string): boolean;
  /** Exact-version registry facts for the packet tracker / entity categories. */
  registry(raw: unknown): (SafetyItemRegistry & { category(entity: string): string | undefined }) | undefined;
  /** Category of an entity type on the current connection (registry fallback). */
  category(name: string): string | undefined;
  now(): number;
  ids: IdSource;
  record(event: Record<string, unknown> & { type: string }): void;
  timers?: SafetyTimers;
  /** The packet tracker shared with the reader (created here when absent). */
  tracker?: SafetyTracker;
  /** Bounded wait for the first post-join assessment before ordinary work is released anyway. */
  initialHoldMaxMs?: number;
}

interface Episode {
  grant: SafetyGrant;
  controller: AbortController;
  startedAtMs: number;
  hazardsBefore: SafetyHazardKind[];
  response: SafetyResponseKind;
  signature: string;
  before: { eyeIn: string; minThreat: number | null; airValue: number | null };
}

interface Waiter {
  resolve(c: SafetyClear): void;
  startedAtMs: number;
  episodes: number;
}

const ROUND = (n: number) => Math.round(n * 10) / 10;

export class SafetyService implements SafetyPort, SafetyLifecyclePort {
  readonly config: SafetyConfig;
  readonly tracker: SafetyTracker;
  private readonly deps: SafetyServiceDeps;
  private readonly timers: SafetyTimers;
  private interval: unknown;
  private closed = false;
  private episode: Episode | undefined;
  private initialHold: { sinceMs: number; connectionEpoch: number | null } | undefined;
  private blocker: { reason: string; detail: string; hazards: SafetyHazardKind[]; signature: string; untilMs: number | null } | undefined;
  private readonly history: Array<{ endedAtMs: number; outcome: SafetyEpisodeOutcome; signature: string; result: SafetyEpisodeResult }> = [];
  private readonly waiters = new Set<Waiter>();
  private lastSelf: SafetySelfFacts | undefined;
  private lastEntities: SafetyEntityFact[] = [];
  private lastPlan: SafetyPlan | undefined;
  private lastAuthority: SafetyAuthority | undefined;
  private lastEpoch: number | null = null;
  private episodesStarted = 0;
  private ticking = false;
  private reassessAfterCleanup = false;
  private settlement: Promise<void> | undefined;
  readonly counters: SafetyStatus['counters'] = { episodes: 0, resolved: 0, improved: 0, unresolved: 0, blocked: 0, revoked: 0, preemptions: 0, retreats: 0, defenses: 0, attacksSent: 0, hitsConfirmed: 0, defeatsConfirmed: 0 };

  constructor(deps: SafetyServiceDeps) {
    this.deps = deps;
    this.config = SafetyConfigSchema.parse(deps.config ?? {});
    this.timers = deps.timers ?? systemTimers;
    this.tracker = deps.tracker ?? new SafetyTracker();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  // ------------------------------------------------------------ authority

  /** Authority to act now: an admitted owner goal, or (coverIdle) no owner goal with the stop latch clear; ready, alive. */
  private authorized(a: SafetyAuthority): boolean {
    if (!this.config.enabled || this.closed) return false;
    if (!a.connection?.ready || !a.alive) return false;
    if (a.basis === 'owner_goal') return true;
    return a.basis === 'unpaused' && this.config.coverIdle;
  }

  private authority(): SafetyAuthority {
    const a = this.deps.authority();
    this.lastAuthority = a;
    return a;
  }

  /**
   * The grant fence (lease ownerCurrent for safety owners; also checked at every
   * dispatch and by the monitor watchdog while controls run): not revoked, not
   * expired, actions within the ceiling, authority basis not `none`, same
   * connection/dimension, and the body within the displacement bound.
   */
  grantCurrent(grantId: string): boolean {
    return this.fenceReason(grantId) === undefined;
  }

  private fenceReason(grantId: string): string | undefined {
    const e = this.episode;
    if (!e || e.grant.grantId !== grantId) return 'unknown_grant';
    if (e.grant.revoked !== undefined) return e.grant.revoked;
    if (this.deps.now() >= e.grant.expiresAtMs) return 'grant_expired';
    if (e.grant.actionsUsed > e.grant.maxActions || e.grant.attacksUsed > e.grant.maxAttacks) return 'grant_budget_exceeded';
    const a = this.deps.authority();
    if (!this.authorized(a)) return `authority_${a.basis}`;
    if (a.connection?.connectionEpoch !== e.grant.connectionEpoch || a.connection.dimension !== e.grant.dimension) return 'connection_or_dimension_changed';
    const p = this.deps.reader.position?.();
    if (p && Math.hypot(p.x - e.grant.origin.x, p.z - e.grant.origin.z) > e.grant.maxDisplacement + 0.5) return 'displacement_limit';
    return undefined;
  }

  reserveAttack(grantId: string): boolean {
    if (!this.grantCurrent(grantId)) return false;
    const g = (this.episode as Episode).grant;
    if (g.attacksUsed >= g.maxAttacks) return false;
    g.attacksUsed += 1;
    this.counters.attacksSent += 1;
    return true;
  }

  grant(grantId: string): Readonly<SafetyGrant> | undefined {
    if (!this.grantCurrent(grantId)) return undefined;
    const g = (this.episode as Episode).grant;
    return { ...g, origin: { ...g.origin }, hazards: [...g.hazards], target: g.target ? { ...g.target } : null };
  }

  // ------------------------------------------------------------ hold / wait

  hold(): SafetyHold | null {
    const now = this.deps.now();
    if (this.episode) {
      const e = this.episode;
      return { reason: 'episode', episodeId: e.grant.episodeId, response: e.response, hazards: [...e.grant.hazards], sinceMs: e.startedAtMs, detail: `safety ${e.response} in progress (${e.grant.hazards.join('+')})` };
    }
    if (this.initialHold) {
      const max = this.deps.initialHoldMaxMs ?? 5_000;
      if (now - this.initialHold.sinceMs <= max) return { reason: 'initial_assessment', episodeId: null, response: null, hazards: [], sinceMs: this.initialHold.sinceMs, detail: 'fresh self-state assessment after join/respawn' };
      this.deps.record({ type: 'safety_initial_assessment_unavailable', waitedMs: now - this.initialHold.sinceMs });
      this.initialHold = undefined;
    }
    if (this.blocker) return { reason: 'blocked', episodeId: null, response: null, hazards: [...this.blocker.hazards], sinceMs: now, detail: `${this.blocker.reason}: ${this.blocker.detail}` };
    return null;
  }

  waitClear(signal: AbortSignal, maxWaitMs = 60_000): Promise<SafetyClear> {
    const startedAtMs = this.deps.now();
    const immediate = this.clearState(startedAtMs, this.episodesStarted);
    if (immediate) return Promise.resolve(immediate);
    if (signal.aborted) return Promise.resolve({ status: 'aborted', waitedMs: 0, reason: 'signal_aborted' });
    return new Promise((resolve) => {
      let timer: unknown;
      const waiter: Waiter = {
        startedAtMs,
        episodes: this.episodesStarted,
        resolve: (c) => {
          this.waiters.delete(waiter);
          this.timers.clear(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(c);
        },
      };
      const onAbort = () => waiter.resolve({ status: 'aborted', waitedMs: this.deps.now() - startedAtMs, reason: 'signal_aborted' });
      timer = this.timers.after(maxWaitMs, () => waiter.resolve({ status: 'timeout', waitedMs: this.deps.now() - startedAtMs }));
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  /** A terminal answer for a waiter now, or undefined to keep waiting. */
  private clearState(startedAtMs: number, episodesAtStart: number): SafetyClear | undefined {
    const waitedMs = this.deps.now() - startedAtMs;
    const a = this.lastAuthority ?? this.deps.authority();
    if (!this.authorized(a) && !this.episode) {
      // No safety authority: nothing of ours holds work (stop/lifecycle are handled by their owners).
      return this.closed ? { status: 'aborted', waitedMs, reason: 'safety_closed' } : { status: 'clear', waitedMs, episodes: this.episodesStarted - episodesAtStart };
    }
    const h = this.hold();
    if (!h) return { status: 'clear', waitedMs, episodes: this.episodesStarted - episodesAtStart };
    if (h.reason === 'blocked' && this.blocker) return { status: 'blocked', waitedMs, reason: this.blocker.reason, detail: this.blocker.detail, hazards: [...this.blocker.hazards] };
    return undefined;
  }

  private notifyWaiters(): void {
    for (const w of [...this.waiters]) {
      const c = this.clearState(w.startedAtMs, w.episodes);
      if (c) w.resolve(c);
    }
  }

  // ------------------------------------------------------------ lifecycle

  attachConnection(source: SafetyPacketSource, ctx: { connectionEpoch: number; registry: () => unknown }): void {
    this.tracker.attach(source, { connectionEpoch: ctx.connectionEpoch, registry: () => this.deps.registry(ctx.registry()), now: () => this.deps.now() });
    this.initialHold = { sinceMs: this.deps.now(), connectionEpoch: ctx.connectionEpoch };
  }

  onLifecycle(event: GameLifecycleEvent): void {
    switch (event.type) {
      case 'death':
      case 'ended':
      case 'dimension_change':
        this.revokeEpisode(`lifecycle_${event.type}`);
        this.blocker = undefined;
        this.deps.reader.reset();
        if (event.type === 'ended') this.tracker.detach();
        if (event.type !== 'ended') this.initialHold = { sinceMs: this.deps.now(), connectionEpoch: event.connectionEpoch };
        else this.initialHold = undefined;
        break;
      case 'ready':
      case 'respawn':
        this.revokeEpisode(`lifecycle_${event.type}`);
        this.blocker = undefined;
        this.deps.reader.reset();
        this.initialHold = { sinceMs: this.deps.now(), connectionEpoch: event.connectionEpoch };
        break;
      default:
        break;
    }
    this.deps.record({ type: 'safety_lifecycle', event: event.type });
    this.notifyWaiters();
  }

  onAuthorityChanged(cause: 'owner_stop' | 'resume' | 'owner_goal_admitted' | 'goal_terminal'): void {
    const a = this.authority();
    if (cause === 'owner_stop' || !this.authorized(a)) {
      this.reassessAfterCleanup = false;
      this.revokeEpisode(cause === 'owner_stop' ? 'owner_stop' : `authority_${a.basis}`);
      if (cause === 'owner_stop') this.blocker = undefined;
    }
    // A stopped episode retains its hold until the executor's cleanup settles.
    // A later manual admission may request a fresh grant, never revive that one.
    if (cause === 'owner_goal_admitted' && this.authorized(a) && this.episode?.grant.revoked) this.reassessAfterCleanup = true;
    this.deps.record({ type: 'safety_authority', cause, basis: a.basis, detail: a.detail });
    this.notifyWaiters();
    if (this.authorized(a)) this.tick();
  }

  start(): void {
    if (this.interval !== undefined || this.closed || !this.config.enabled) return;
    this.interval = this.timers.every(this.config.tickMs, () => this.tick());
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.interval !== undefined) this.timers.clear(this.interval);
    this.interval = undefined;
    this.revokeEpisode('closed');
    this.tracker.detach();
    this.notifyWaiters();
    const pending = this.settlement;
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('safety executor cleanup did not settle within 5000ms')), 5_000); })]);
      } finally { if (timer) clearTimeout(timer); }
    }
  }

  // ------------------------------------------------------------ monitor

  /**
   * Policy context over the CURRENT local geometry (lazy checks).
   *
   * Default bound = the PROSPECTIVE finite safety grant: displacement from the
   * bot's current position (the grant origin) only, for water exits AND mob
   * retreat/escape-space readiness alike. It is deliberately independent of the
   * admitted goal/route travel radius: a bot outside its original anchor after
   * a route leg ended, exhausted or was withdrawn must still be able to escape
   * (C13 / L-P5). Executing that escape still requires a genuine current grant
   * (lease fence), and the goal anchor/route is never moved or refilled.
   * Goal-owned (planner/Jev) use passes its own `allowed` with the goal's
   * travel bounds and never borrows this exception.
   */
  policyContext(self: SafetySelfFacts, allowed?: (x: number, y: number, z: number) => boolean): PolicyContext {
    const cfg = this.config;
    const world = this.deps.reader.world();
    const visible = this.deps.reader.visible();
    const grant = this.episode?.grant;
    const origin = grant?.origin ?? self.position;
    const withinDisp = (max: number) => (x: number, _y: number, z: number) => Math.hypot(x + 0.5 - origin.x, z + 0.5 - origin.z) <= max;
    return {
      config: cfg,
      nowMs: this.deps.now(),
      inTag: this.deps.inTag,
      fluidExitAvailable: () => {
        if (!world || !visible) return false;
        const fluid = self.fluid.eyeIn !== 'none' ? self.fluid.eyeIn : self.fluid.feetIn !== 'none' ? self.fluid.feetIn : self.fluid.columnFluid === 'water' || self.fluid.columnFluid === 'lava' ? self.fluid.columnFluid : 'none';
        if (fluid === 'none') return false;
        const bound = allowed ?? withinDisp(grant?.maxDisplacement ?? cfg.water.maxDisplacement);
        const col = self.fluid.headroom === 'ceiling' ? findOpenColumn(world, self.position, fluid, cfg.water.surfaceSearchRadius) : undefined;
        if (col && bound(col.x, col.surfaceY, col.z)) return true;
        return findFluidExits(world, self.position, fluid, { radius: cfg.water.shoreSearchRadius, visible, allowed: bound, max: 1 }).length > 0;
      },
      retreatAvailable: (threats) => {
        if (!world || !visible || threats.length === 0) return false;
        return findRetreatTargets(world, self.position, { threats: threats.map((t) => t.at), separation: cfg.mobs.retreatSeparation, legMax: cfg.mobs.retreatLegMax, visible, allowed: allowed ?? withinDisp(grant?.maxDisplacement ?? cfg.mobs.maxDisplacement) }).length > 0;
      },
      defenseSupported: (fact) => dispositionOf(fact.key, this.deps.category(fact.key.replace(/^minecraft:/, '')), fact.heldItem).defenseSupported,
    };
  }

  /** Fresh facts + plan (also used by skills/status). */
  assess(): { self: SafetySelfFacts; entities: SafetyEntityFact[]; plan: SafetyPlan } | undefined {
    const self = this.deps.reader.self();
    if (!self) return undefined;
    const m = this.config.mobs;
    const entities = m.enabled ? this.deps.reader.entities({ scanRadius: m.scanRadius, approachWindowMs: m.approachWindowMs, provokedWindowMs: m.provokedWindowMs }) : [];
    const plan = planSafety(self, entities, this.policyContext(self));
    this.lastSelf = self;
    this.lastEntities = entities;
    this.lastPlan = plan;
    return { self, entities, plan };
  }

  /** One monitor step (synchronous decision; an episode runs asynchronously). */
  tick(): void {
    if (this.closed || !this.config.enabled || this.ticking) return;
    this.ticking = true;
    try {
      const a = this.authority();
      const epoch = a.connection?.connectionEpoch ?? null;
      if (epoch !== this.lastEpoch) {
        this.lastEpoch = epoch;
        if (epoch !== null && !this.initialHold) this.initialHold = { sinceMs: this.deps.now(), connectionEpoch: epoch };
      }
      if (!this.authorized(a)) {
        if (this.episode) this.revokeEpisode(`authority_${a.basis}`);
        this.notifyWaiters();
        return;
      }
      if (this.episode) {
        // Watchdog while controls run: any fence failure (expiry, displacement,
        // authority, connection) revokes the grant now (lease revoked, controls cleared).
        const why = this.fenceReason(this.episode.grant.grantId);
        if (why) this.revokeEpisode(why);
        return; // otherwise the episode re-plans from fresh facts itself
      }
      const r = this.assess();
      if (!r) return;
      if (this.initialHold) {
        this.deps.record({ type: 'safety_initial_assessment', plan: r.plan.kind, air: r.self.air.source, fluid: r.self.fluid.eyeIn, waitedMs: this.deps.now() - this.initialHold.sinceMs });
        this.initialHold = undefined;
      }
      this.decide(r.plan, r.self, a);
      this.notifyWaiters();
    } catch (error) {
      this.deps.record({ type: 'safety_tick_error', message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    } finally {
      this.ticking = false;
    }
  }

  private decide(plan: SafetyPlan, self: SafetySelfFacts, a: SafetyAuthority): void {
    const now = this.deps.now();
    if (plan.kind === 'none') {
      if (this.blocker?.reason === 'safe_support_unverified' && !hasSafeFluidSupport(self.fluid)) {
        this.preemptOrdinary(this.blocker.reason);
        return;
      }
      if (this.blocker) this.deps.record({ type: 'safety_blocker_cleared', reason: this.blocker.reason });
      this.blocker = undefined;
      return;
    }
    // An ACTIVE hazard always stops unsafe ordinary motion first, even when no safety
    // action is possible: the current non-safety lease is revoked synchronously
    // (controls cleared, its action returns `safety_preempt`) and the blocker hold
    // keeps new ordinary dispatch out until the hazard changes.
    if (plan.kind === 'blocked') {
      this.setBlocker(plan.reason, plan.detail, plan.hazards.map((h) => h.kind), plan.signature, null);
      this.preemptOrdinary(plan.reason);
      return;
    }
    // Same unresolved signature in cooldown: stay blocked, no retry loop.
    if (this.blocker && this.blocker.signature === plan.signature && this.blocker.untilMs !== null && now < this.blocker.untilMs) {
      this.preemptOrdinary(this.blocker.reason);
      return;
    }
    const ceiling = this.repeatedHazard(now);
    if (ceiling) {
      this.setBlocker('repeated_hazard', ceiling, plan.hazards.map((h) => h.kind), plan.signature, now + this.config.episodes.blockedCooldownMs);
      this.preemptOrdinary('repeated_hazard');
      return;
    }
    this.blocker = undefined;
    const pending = this.runEpisode(plan, self, a);
    this.settlement = pending;
    void pending.then(() => { if (this.settlement === pending) this.settlement = undefined; }, (error) => {
      if (this.settlement === pending) this.settlement = undefined;
      this.deps.record({ type: 'safety_episode_error', message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    });
  }

  /** Revokes a current NON-safety lease (no-op otherwise); never starts any motion. */
  private preemptOrdinary(why: string): void {
    try {
      const r = this.deps.actuation.preemptCurrent('safety_preempt');
      if (r.revoked) {
        this.counters.preemptions += 1;
        this.deps.record({ type: 'safety_preempt_blocked', why, holder: r.holder, clearMs: r.clearMs });
      }
    } catch (error) {
      this.deps.record({ type: 'safety_preempt_error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private setBlocker(reason: string, detail: string, hazards: SafetyHazardKind[], signature: string, untilMs: number | null): void {
    const changed = !this.blocker || this.blocker.signature !== signature || this.blocker.reason !== reason;
    this.blocker = { reason, detail: detail.slice(0, 400), hazards, signature, untilMs };
    if (changed) this.deps.record({ type: 'safety_blocked', reason, detail: detail.slice(0, 400), hazards, signature });
  }

  private repeatedHazard(now: number): string | undefined {
    const w = this.config.episodes;
    const recent = this.history.filter((h) => now - h.endedAtMs <= w.windowMs);
    if (recent.length >= w.maxPerWindow) return `${recent.length} safety episodes within ${Math.round(w.windowMs / 1000)}s (limit ${w.maxPerWindow})`;
    const failed = recent.filter((h) => h.outcome === 'unresolved' || h.outcome === 'blocked').length;
    if (failed >= w.maxFailedPerWindow) return `${failed} safety episodes without improvement within ${Math.round(w.windowMs / 1000)}s (limit ${w.maxFailedPerWindow})`;
    return undefined;
  }

  // ------------------------------------------------------------ episodes

  private minThreatDistance(entities: readonly SafetyEntityFact[]): number | null {
    const { active } = threatHazards(entities, this.config, this.deps.now());
    return active.length ? Math.min(...active.map((e) => e.distance)) : null;
  }

  private async runEpisode(first: Extract<SafetyPlan, { kind: 'respond' }>, self: SafetySelfFacts, a: SafetyAuthority): Promise<void> {
    const now = this.deps.now();
    const water = first.response === 'escape_water';
    const conn = a.connection as NonNullable<SafetyAuthority['connection']>;
    const grant: SafetyGrant = {
      grantId: `sg-${this.deps.ids.next('act').slice(4)}`,
      episodeId: `se-${this.deps.ids.next('act').slice(4)}`,
      connectionEpoch: conn.connectionEpoch,
      dimension: conn.dimension,
      initialResponse: first.response,
      hazards: first.hazards.map((h) => h.kind),
      issuedAtMs: now,
      expiresAtMs: now + Math.min(SAFETY_BOUNDS.episodeMsCeiling, water ? this.config.water.maxEpisodeMs : this.config.mobs.maxEpisodeMs),
      maxActions: Math.min(SAFETY_BOUNDS.actionsCeiling, this.config.episodes.maxActions),
      actionsUsed: 0,
      maxAttacks: Math.min(SAFETY_BOUNDS.attacksCeiling, this.config.mobs.defense.maxAttacks),
      attacksUsed: 0,
      origin: { ...self.position },
      maxDisplacement: Math.min(SAFETY_BOUNDS.displacementCeiling, water ? this.config.water.maxDisplacement : this.config.mobs.maxDisplacement),
      suspended: a.goal ? { goalId: a.goal.goalId, goalEpoch: a.goal.goalEpoch } : null,
      basis: a.basis,
      target: first.defense?.target ? { entityId: first.defense.target.entityId, key: first.defense.target.key } : null,
    };
    const episode: Episode = {
      grant,
      controller: new AbortController(),
      startedAtMs: now,
      hazardsBefore: [...grant.hazards],
      response: first.response,
      signature: first.signature,
      before: { eyeIn: self.fluid.eyeIn, minThreat: this.minThreatDistance(this.lastEntities), airValue: self.air.value },
    };
    this.episode = episode;
    this.episodesStarted += 1;
    // Expiry is enforced while controls run, not only at the next fence.
    const expiry = this.timers.after(Math.max(0, grant.expiresAtMs - now), () => {
      if (this.episode === episode) this.revokeEpisode('grant_expired');
    });
    this.counters.episodes += 1;
    // Synchronous preemption BEFORE any await: the old holder's controls are cleared now.
    let preempt: ReturnType<SafetyActuationPort['preemptCurrent']> = { revoked: false, holder: null, clearMs: null };
    try {
      preempt = this.deps.actuation.preemptCurrent('safety_preempt');
    } catch (error) {
      this.deps.record({ type: 'safety_preempt_error', message: error instanceof Error ? error.message : String(error) });
    }
    if (preempt.revoked) this.counters.preemptions += 1;
    this.deps.record({ type: 'safety_episode_started', episodeId: grant.episodeId, grantId: grant.grantId, basis: grant.basis, response: first.response, hazards: grant.hazards, reason: first.reason, suspended: grant.suspended, preempted: preempt, expiresInMs: grant.expiresAtMs - now, maxActions: grant.maxActions, maxDisplacement: grant.maxDisplacement, ...(first.defense ? { defense: first.defense as unknown as Record<string, unknown> } : {}) });
    this.notifyWaiters();

    let plan: SafetyPlan = first;
    let outcome: SafetyEpisodeOutcome = 'unresolved';
    let reason = 'bounds_exhausted';
    let detail = '';
    let disengaged = false;
    const steps: Array<Record<string, unknown>> = [];
    try {
      while (true) {
        if (!this.grantCurrent(grant.grantId)) {
          outcome = 'revoked';
          reason = grant.revoked ?? this.fenceReason(grant.grantId) ?? 'grant_fenced';
          if (reason === 'grant_expired' || reason === 'displacement_limit' || reason === 'grant_budget_exceeded') outcome = 'unresolved';
          break;
        }
        if (plan.kind !== 'respond') break;
        if (grant.actionsUsed >= grant.maxActions) {
          reason = 'action_limit';
          break;
        }
        episode.response = plan.response;
        grant.target = plan.response === 'defend' && plan.defense?.target ? { entityId: plan.defense.target.entityId, key: plan.defense.target.key } : null;
        const candidate = this.candidate(plan.response, grant, a);
        grant.actionsUsed += 1;
        if (plan.response === 'retreat') this.counters.retreats += 1;
        if (plan.response === 'defend') this.counters.defenses += 1;
        const owner: SafetyExecutionOwner = { kind: 'safety', grantId: grant.grantId, episodeId: grant.episodeId, connectionEpoch: grant.connectionEpoch };
        let result: SkillOutcome;
        try {
          result = await this.deps.actuation.execute(candidate, episode.controller.signal, owner);
        } catch (error) {
          reason = 'execute_error';
          detail = error instanceof Error ? error.message.slice(0, 200) : String(error);
          break;
        }
        steps.push({ response: plan.response, status: result.status, reason: result.reason ?? null, confirmation: result.confirmation, effect: result.effect.slice(0, 160) });
        this.noteEvidence(result);
        if (plan.response === 'defend' && result.status !== 'succeeded') disengaged = true;
        this.deps.record({ type: 'safety_step', episodeId: grant.episodeId, actionId: candidate.id, capability: candidate.capability, status: result.status, reason: result.reason ?? null, confirmation: result.confirmation, effect: result.effect.slice(0, 300) });
        if (!this.grantCurrent(grant.grantId)) continue; // classified at the top of the loop
        const fresh = this.assess();
        if (!fresh) {
          reason = 'facts_unavailable';
          break;
        }
        plan = fresh.plan;
        // A local loss threshold, attack cap, missing confirmation or readiness
        // change cannot start another defense action with a fresh health-loss
        // baseline. This grant commits to avoidance until it ends.
        if (disengaged && plan.kind === 'respond' && plan.response === 'defend') plan = { ...plan, response: 'retreat', reason: 'bounded defense ended; disengaging within the existing grant' };
        if (plan.kind === 'none') {
          if (water && !hasSafeFluidSupport(fresh.self.fluid)) {
            reason = 'safe_support_unverified';
            detail = 'water escape has not established grounded dry or shallow solid support';
            this.setBlocker(reason, detail, [], 'water_support_unknown', this.deps.now() + this.config.episodes.blockedCooldownMs);
            break;
          }
          outcome = 'resolved';
          reason = 'hazard_cleared';
          break;
        }
        if (plan.kind === 'blocked') {
          outcome = 'blocked';
          reason = plan.reason;
          detail = plan.detail;
          this.setBlocker(plan.reason, plan.detail, plan.hazards.map((h) => h.kind), plan.signature, this.deps.now() + this.config.episodes.blockedCooldownMs);
          break;
        }
      }
    } finally {
      const after = this.assessSafe();
      const hazardsAfter = after?.plan.kind === 'respond' || after?.plan.kind === 'blocked' ? after.plan.hazards.map((h) => h.kind) : [];
      if (outcome === 'unresolved' && after) {
        const improvedWater = episode.before.eyeIn !== 'none' && after.self.fluid.eyeIn === 'none';
        const airRose = episode.before.airValue !== null && after.self.air.value !== null && after.self.air.value > episode.before.airValue && after.self.air.source === 'server_metadata';
        const minNow = this.minThreatDistance(after.entities);
        const separated = episode.before.minThreat !== null && (minNow === null || minNow >= episode.before.minThreat + 2);
        if (improvedWater || airRose || separated) outcome = 'improved';
        if (outcome === 'unresolved' && hazardsAfter.length > 0) this.setBlocker('safety_unresolved', `bounded ${episode.response} ended without improvement (${reason}); hazards: ${hazardsAfter.join('+')}`, hazardsAfter, after.plan.kind === 'none' ? 'none' : after.plan.signature, this.deps.now() + this.config.episodes.blockedCooldownMs);
      }
      this.timers.clear(expiry);
      if (outcome !== 'revoked') grant.revoked ??= 'ended';
      episode.controller.abort();
      const pos = after?.self.position ?? this.lastSelf?.position;
      const result: SafetyEpisodeResult = {
        episodeId: grant.episodeId,
        grantId: grant.grantId,
        response: episode.response,
        outcome,
        reason,
        detail: detail || `${steps.length} step(s); ${steps.map((s) => `${s.response}:${s.status}${s.reason ? `(${s.reason})` : ''}`).join(', ')}`,
        hazardsBefore: episode.hazardsBefore,
        hazardsAfter,
        actions: grant.actionsUsed,
        elapsedMs: this.deps.now() - episode.startedAtMs,
        displacement: pos ? ROUND(Math.hypot(pos.x - grant.origin.x, pos.z - grant.origin.z)) : 0,
        evidence: { steps, airAfter: after ? { value: after.self.air.value, source: after.self.air.source } : null, healthAfter: after ? { value: after.self.health, source: after.self.vitalsSource } : null, fluidAfter: after ? { ...after.self.fluid } : null },
        endedAtMs: this.deps.now(),
      };
      this.counters[outcome] += 1;
      this.history.push({ endedAtMs: result.endedAtMs, outcome, signature: episode.signature, result });
      if (this.history.length > SAFETY_BOUNDS.history) this.history.shift();
      if (this.episode === episode) this.episode = undefined;
      this.deps.record({ type: 'safety_episode_ended', ...result });
      this.notifyWaiters();
      if (this.reassessAfterCleanup && !this.episode) {
        this.reassessAfterCleanup = false;
        this.tick();
      }
    }
  }

  private assessSafe(): ReturnType<SafetyService['assess']> {
    try {
      return this.assess();
    } catch {
      return undefined;
    }
  }

  private noteEvidence(o: SkillOutcome): void {
    const ev = o.evidence as Record<string, unknown>;
    if (typeof ev['hitsConfirmed'] === 'number') this.counters.hitsConfirmed += ev['hitsConfirmed'];
    if (ev['defeatedByServerStatus'] === true) this.counters.defeatsConfirmed += 1;
  }

  private candidate(response: SafetyResponseKind, grant: SafetyGrant, a: SafetyAuthority): ActionCandidate {
    const remaining = Math.max(1_000, grant.expiresAtMs - this.deps.now());
    const parameters = response === 'defend' ? { maxAttacks: this.config.mobs.defense.maxAttacks } : { maxMs: Math.min(remaining, 30_000) };
    return {
      id: this.deps.ids.next('act'),
      capability: SAFETY_CAPABILITY_FOR[response],
      parameters,
      // Safety candidates are code-built from fresh local facts, not from an observation snapshot.
      snapshotId: this.deps.ids.next('snap'),
      connectionEpoch: grant.connectionEpoch,
      goalEpoch: a.goal?.goalEpoch ?? 0,
      description: `safety ${response} (${grant.hazards.join('+')})`,
      criteria: [`grant ${grant.grantId}`, `episode ${grant.episodeId}`],
      preconditions: ['safety grant current', 'fresh local facts'],
      timeoutMs: Math.min(60_000, remaining + 2_000),
    };
  }

  private revokeEpisode(reason: string): void {
    const e = this.episode;
    if (!e) return;
    e.grant.revoked ??= reason;
    // Abort first: the executor revokes the safety lease and clears controls synchronously.
    e.controller.abort();
    this.deps.record({ type: 'safety_grant_revoked', episodeId: e.grant.episodeId, grantId: e.grant.grantId, reason });
  }

  // ------------------------------------------------------------ status

  status(nowMs: number): SafetyStatus {
    const a = this.lastAuthority;
    const self = this.lastSelf;
    const e = this.episode;
    const last = this.history.at(-1);
    const threats = this.lastPlan && this.lastPlan.kind !== 'none' ? this.lastPlan.hazards : [];
    const hazardOf = (id: number) => threats.find((h) => h.entityIds.includes(id))?.kind ?? null;
    const state: SafetyStatus['state'] = !this.config.enabled ? 'disabled' : !a || !this.authorized(a) ? 'no_authority' : e ? 'responding' : this.blocker ? 'blocked' : 'monitoring';
    const pos = self?.position;
    return {
      enabled: this.config.enabled,
      state,
      authority: { basis: a?.basis ?? 'none', detail: a?.detail ?? 'not yet assessed' },
      connectionEpoch: a?.connection?.connectionEpoch ?? null,
      vitals: self ? { health: self.health, food: self.food, source: self.vitalsSource, air: { value: self.air.value, source: self.air.source, ageS: self.air.observedAtMs !== null ? Math.round((nowMs - self.air.observedAtMs) / 1000) : null } } : null,
      fluid: self ? { feetIn: self.fluid.feetIn, eyeIn: self.fluid.eyeIn, support: self.fluid.support, headroom: self.fluid.headroom, source: 'local_estimate' } : null,
      threats: this.lastEntities
        .filter((x) => x.disposition !== 'owner' && x.disposition !== 'player')
        .slice(0, SAFETY_BOUNDS.statusThreats)
        .map((x) => ({ key: x.key, disposition: x.disposition, distance: ROUND(x.distance), hazard: hazardOf(x.entityId) })),
      episode: e
        ? { episodeId: e.grant.episodeId, response: e.response, hazards: [...e.grant.hazards], sinceS: Math.round((nowMs - e.startedAtMs) / 1000), actions: e.grant.actionsUsed, maxActions: e.grant.maxActions, displacement: pos ? ROUND(Math.hypot(pos.x - e.grant.origin.x, pos.z - e.grant.origin.z)) : 0, suspended: e.grant.suspended ? { goalId: e.grant.suspended.goalId } : null }
        : null,
      lastEpisode: last ? { episodeId: last.result.episodeId, response: last.result.response, outcome: last.result.outcome, reason: last.result.reason, detail: last.result.detail.slice(0, 200), endedAgoS: Math.round((nowMs - last.endedAtMs) / 1000) } : null,
      blocker: this.blocker ? { reason: this.blocker.reason, detail: this.blocker.detail, hazards: [...this.blocker.hazards], retryInS: this.blocker.untilMs !== null ? Math.max(0, Math.round((this.blocker.untilMs - nowMs) / 1000)) : null } : null,
      counters: { ...this.counters },
      limits: [
        'fluid/ceiling/support are local estimates from the client world model; own air is server metadata or unknown',
        'only visible entities within the scan radius are assessed; no hidden mobs, owner coordinates or global scans',
        'retreat is the default; defense only for one adult zombie/husk/zombie_villager/drowned(no ranged item)/spider already in melee contact and engaging, with verified stone+ sword/axe, armor, health/food and an observed retreat leg; never a cornered fight',
        'unknown/neutral entities are avoided on established visible danger and never attacked; players and the owner are never targets',
        'no boats, potions, sprint-swimming, block placing/digging, ranged combat, pursuit or gear restoration',
      ],
    };
  }

  now(): number {
    return this.deps.now();
  }

  inTag(tag: '#minecraft:swords' | '#minecraft:axes', key: string): boolean {
    return this.deps.inTag(tag, key);
  }

  /** Current local world view (client model) and floor visibility from the eye (skills). */
  world(): SafetyBlockReader | undefined {
    return this.deps.reader.world();
  }

  visible(): ((x: number, y: number, z: number) => boolean) | undefined {
    return this.deps.reader.visible();
  }

  /** The current goal's travel bounds from the latest authority (never moved by safety). */
  travel(): { anchor: { x: number; y: number; z: number }; radius: number } | null {
    return (this.lastAuthority ?? this.deps.authority()).travel;
  }

  /** Last episode results (bounded) for evidence/harnesses. */
  episodes(): SafetyEpisodeResult[] {
    return this.history.map((h) => h.result);
  }
}
