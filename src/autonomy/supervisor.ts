// MB-FLOW-001 progression supervisor: the ONE application-owned scheduler
// above the GoalEngine. It decides, in code and only at bounded scheduling
// points, whether automatic work may start and which kind:
//
//   lifecycle/stop revocation > immediate verified safety > owner intent >
//   necessary support/recovery > unrelated progression
//
// Scheduling points: connection ready / respawn (after a settle delay), goal
// admission/terminal, explicit resume, finite cooldown timers and a coarse
// code-only survival guard (fresh-state policy evaluation; never inference).
// A progression assessment is ONE admitted goal whose planner turns are
// serialized and counted by the engine's single PlannerSlot under the normal
// per-goal limits plus this run's finite session allowance. Survival support
// is admitted through the same engine (planner goal or code-built task) with a
// `support` source and the survival-issued ceilings/allowance.
//
// MB-FLOW-001-C1: bare `resume` only clears the durable stop latch. An
// unresolved (blocked, unanswered, interrupted) owner intent stays visible and
// holds unrelated progression until a NEW owner instruction supersedes it; it
// is never continued, replayed or re-admitted by code in this release.
// Nothing here actuates, calls a model, reconnects or replays old goals.
import { createHash } from 'node:crypto';
import type {
  ActiveWorkFacts,
  Clock,
  ControlLatch,
  EvidenceEvent,
  GameLifecycleEvent,
  ObservationSnapshot,
  OutcomePredicate,
  RoutePort,
  SurvivalDecision,
  SurvivalPolicyPort,
  SurvivalProposal,
  TaskMode,
  TaskSpec,
} from '../contracts/index.ts';
import { priorityOfSource, type AutonomyConfig, type AutonomyMode, type AutonomyPlannerContext, type AutonomySessionCounters, type AutonomyStatus, type GoalSource, type HomeProjectSummary, type OwnerIntentRecord } from '../contracts/autonomy.ts';
import type { FullEngineStatus, GoalCeilings, GoalTerminalEvent, SubmitResult } from '../goals/goal-engine.ts';
import type { AutonomyControl } from './control.ts';
import { AUTONOMY_RULES, progressionInstruction } from './context.ts';

/** The GoalEngine surface the supervisor uses (a structural subset). */
export interface SupervisorEngine {
  automaticBlocker(): { reason: string; detail: string } | undefined;
  submitAutomatic(instruction: string, source: GoalSource, options?: { context?: AutonomyPlannerContext; ceilings?: GoalCeilings; replaceAutomatic?: boolean }): Promise<SubmitResult>;
  submitSupportTask(spec: unknown, mode: TaskMode, source: GoalSource, options?: { ceilings?: GoalCeilings; replaceAutomatic?: boolean }): Promise<SubmitResult>;
  revokeForSafety(detail: string): Promise<{ revoked: boolean; goalId?: string; source?: GoalSource }>;
  restoreLatch(latch: ControlLatch): void;
  status(): FullEngineStatus;
  readonly activeSource: GoalSource | undefined;
  readonly currentEpoch: number;
}

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: TimerApi = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export interface ProviderState {
  /** Planner AND Jev usable (planner goals). */
  ready: boolean;
  /** Jev usable within the run SpendLedger (code tasks: no planner turn, but every decision is a real Jev call). */
  decisionReady?: boolean;
  /** e.g. planner_not_ready, decision_not_ready, spend_cap */
  code?: string;
  detail: string;
}

export interface SupervisorDeps {
  engine: SupervisorEngine;
  control: AutonomyControl;
  config: AutonomyConfig;
  /** Suppression by CLI flag / inference-free profile / diagnostics (reason shown in status). */
  enabled: { enabled: boolean; reason: string };
  clock: Clock;
  timers?: TimerApi;
  record: (event: EvidenceEvent) => void;
  /** Owner-facing notice (terminal + in-game reply). */
  notify: (text: string) => void;
  /** Current ready connection facts (null: not ready). */
  connection: () => { ready: boolean; connectionEpoch: number; dimension: string } | null;
  /** Fresh read-only filtered snapshot (no packets, lease or resync) for survival assessment. */
  observe: () => Promise<ObservationSnapshot | null>;
  /** Planner/Jev readiness and spend cap (no inference; no account reads). */
  providers: () => ProviderState;
  /** Coarse code-only digest of the bot's state (inventory, dimension, cell, home state) for unchanged-blocker detection. */
  stateFingerprint: () => string;
  /** Configured per-goal limits (support ceilings never exceed them). */
  goalLimits: { plannerTurns: number; tasks: number; replans: number; deadlineMs: number };
  /** Code-verified home project summary (construction service), if any. */
  home?: () => HomeProjectSummary | null;
  /** MB-FLOW-003 policy (canonical port), when composed. */
  survival?: SurvivalPolicyPort;
  /** MB-LOC-001 route status (canonical port), when composed. */
  route?: Pick<RoutePort, 'status'>;
  /** Survival guard interval (code-only fresh-state evaluation; default 5 s). */
  survivalGuardMs?: number;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const PROVIDER_REASONS = new Set(['planner_not_ready', 'decision_not_ready', 'planner_error', 'decision_error']);
const LIFECYCLE_REASONS = new Set(['death', 'disconnected', 'kicked', 'dimension_change']);
const INTERRUPTION_REASONS = new Set(['low_health', 'safety_interrupted', 'death', 'disconnected', 'kicked', 'dimension_change']);

interface FingerprintEntry {
  times: number;
  interpretation: string;
  reason: string;
  stateFp: string;
  lastAtMs: number;
}

interface AssessmentFence {
  generation: number;
  goalEpoch: number;
  connectionEpoch: number;
  dimension: string;
  signal: AbortSignal;
}

interface AssessmentRequest {
  why: string;
  guardOnly: boolean;
}

type Phase = 'idle' | 'assessing' | 'cooldown' | 'waiting' | 'provider_blocked' | 'exhausted';

/** Renders an accepted outcome for survival interruption bookkeeping (display only). */
function atomicKinds(p: OutcomePredicate, out: string[] = []): string[] {
  if (p.predicate === 'all' || p.predicate === 'any') p.of.forEach((c) => atomicKinds(c, out));
  else if (p.predicate === 'not') atomicKinds(p.of, out);
  else out.push(p.predicate);
  return out;
}

export class AutonomySupervisor {
  private readonly deps: SupervisorDeps;
  private readonly timers: TimerApi;
  private timer: unknown;
  private timerAt: number | null = null;
  private timerWhy = '';
  private guard: unknown;
  private phase: { mode: Phase; detail: string; sinceMs: number };
  private blocker: { code: string; detail: string } | null = null;
  private ownerIntent: OwnerIntentRecord | null = null;
  private readonly session: AutonomySessionCounters = { progressionGoals: 0, supportGoals: 0, safetyRevocations: 0, plannerTurns: 0, completed: 0, consecutiveUnproductive: 0 };
  private readonly fingerprints = new Map<string, FingerprintEntry>();
  private readonly milestones: Array<{ interpretation: string; atMs: number }> = [];
  private lastOutcome: AutonomyStatus['lastOutcome'] = null;
  private submitting = false;
  private assessment: Promise<void> | undefined;
  private assessmentRequest: AssessmentRequest | undefined;
  private assessmentAbort: AbortController | undefined;
  private assessmentGeneration = 0;
  private guardGeneration = 0;
  /** Terminal provider failures require an explicit owner admission or resume, even if readiness still reports true. */
  private readonly providerHolds = new Set<'planner' | 'decision'>();
  private readonly automaticAdmissions = new Map<string, { atMs: number; stateFp: string }>();
  private readonly accountedTerminals = new Set<string>();
  private readonly completedFingerprints = new Map<string, { stateFp: string; times: number }>();
  private refusedProposal: { signature: string; stateFp: string } | undefined;
  private waitingStateFp: string | null = null;
  /** The survival proposal being admitted right now (correlated in onGoalAdmitted). */
  private admittingProposal: SurvivalProposal | undefined;
  /** Survival proposals by admitted goal id (terminal correlation). */
  private readonly proposals = new Map<string, { proposalId: string; goalEpoch: number }>();
  private started = false;
  private closed = false;
  private lastNotice = '';

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
    this.phase = { mode: 'idle', detail: 'not started', sinceMs: deps.clock.now() };
  }

  get enabled(): boolean {
    return this.deps.enabled.enabled;
  }

  /** Startup: opens the durable scope and restores the latch into the engine (before any connection). */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.enabled) {
      this.deps.record({ type: 'autonomy_disabled', reason: this.deps.enabled.reason });
      return;
    }
    this.deps.control.open();
    const latch = this.deps.control.latch();
    if (latch.paused) this.deps.engine.restoreLatch({ paused: true, ...(latch.sinceMs !== undefined ? { sinceMs: latch.sinceMs } : {}), source: latch.source ?? 'restored' });
    const p = this.deps.control.persistence();
    this.deps.record({ type: 'autonomy_started', persistence: p.state, detail: p.detail, paused: latch.paused, limits: this.deps.config.session, survival: Boolean(this.deps.survival?.enabled) });
  }

  // ------------------------------------------------------------------ engine/app hooks

  /** Engine latch hook: SYNCHRONOUS inside stop()/resume(). */
  onLatchChanged(latch: ControlLatch, cause: 'owner_stop' | 'resume'): void {
    if (!this.enabled) return;
    this.invalidateAssessment();
    if (cause === 'owner_stop') {
      this.cancelTimer('owner stop');
      this.stopGuard();
      this.setPhase('idle', 'paused by owner stop');
      void this.deps.control.setLatch({ paused: true, ...(latch.sinceMs !== undefined ? { sinceMs: latch.sinceMs } : {}), source: latch.source ?? 'stop' });
      return;
    }
    // C1: resume ONLY clears the durable latch and freshly reassesses. Unresolved owner intent is untouched.
    void this.deps.control.setLatch({ paused: false });
    this.providerHolds.clear();
    this.refusedProposal = undefined;
    this.waitingStateFp = null;
    this.setPhase('idle', 'resumed by owner');
    this.startGuard();
    this.schedule(0, 'resume');
  }

  onGoalAdmitted(admission: { goalId: string; epoch: number; instruction: string; source?: GoalSource; admittedAtMs: number }): void {
    if (!this.enabled) return;
    this.invalidateAssessment();
    this.cancelTimer('goal admitted');
    const source = admission.source;
    if (!source) return; // operator diagnostic
    if (source.kind === 'owner') {
      // A NEW explicit owner instruction supersedes any older unresolved intent (C1).
      if (this.ownerIntent && this.ownerIntent.state !== 'active') this.deps.record({ type: 'autonomy_owner_intent_superseded', goalId: this.ownerIntent.goalId, by: admission.goalId });
      this.ownerIntent = { goalId: admission.goalId, instruction: clip(admission.instruction, 400), state: 'active', reason: 'admitted', detail: 'owner instruction admitted', sinceMs: admission.admittedAtMs, requiresOwnerDecision: false };
      this.session.consecutiveUnproductive = 0;
      this.waitingStateFp = null;
      this.blocker = null;
      this.providerHolds.clear();
      this.refusedProposal = undefined;
      this.safeSurvival((s) => s.onOwnerInstruction(admission.admittedAtMs));
      return;
    }
    // Count at the synchronous admission hook, before a fast terminal result or a later stop can return to the submitter.
    this.automaticAdmissions.set(`${admission.goalId}:${admission.epoch}`, { atMs: admission.admittedAtMs, stateFp: this.deps.stateFingerprint() });
    if (source.kind === 'progression') this.session.progressionGoals += 1;
    else this.session.supportGoals += 1;
    this.setPhase('idle', `${source.kind} goal ${admission.goalId} admitted`);
    if (source.kind === 'support') {
      const proposal = this.admittingProposal;
      if (proposal && proposal.proposalId === source.proposalId) {
        this.proposals.set(admission.goalId, { proposalId: proposal.proposalId, goalEpoch: admission.epoch });
        // Synchronous, BEFORE the first task round: survival binds the episode and any low-health allowance to this epoch.
        this.safeSurvival((s) => {
          const conn = this.deps.connection();
          const grant = s.onSupportAdmitted({ proposalId: proposal.proposalId, goalId: admission.goalId, goalEpoch: admission.epoch, connectionEpoch: conn?.connectionEpoch ?? 0, admittedAtMs: admission.admittedAtMs });
          if (grant) this.deps.record({ type: 'autonomy_low_health_allowance', goalId: admission.goalId, allowanceId: grant.allowanceId, routine: grant.routine, capabilities: [...grant.capabilities], maxActions: grant.maxActions, expiresAtMs: grant.expiresAtMs });
        });
      }
    }
  }

  /**
   * A pending (not admitted) owner instruction ended without admission. A
   * planning failure keeps the owner's words visible as a blocked intent
   * (C1); supersession, stop, lifecycle and shutdown do not.
   */
  onPreparationDiscarded(p: { intentId: string; instruction: string; reason: string; detail: string }): void {
    if (!this.enabled) return;
    if (['superseded', 'owner_stop', 'lifecycle', 'shutdown', 'not_connected'].includes(p.reason)) return;
    this.ownerIntent = { goalId: p.intentId, instruction: clip(p.instruction, 400), state: 'blocked', reason: p.reason, detail: clip(p.detail, 300), sinceMs: this.deps.clock.now(), requiresOwnerDecision: true };
    this.deps.record({ type: 'autonomy_owner_intent', goalId: p.intentId, state: 'blocked', reason: p.reason, preparation: true });
    if (!this.deps.engine.activeSource) this.schedule(0, `owner instruction ${p.reason}`);
  }

  onGoalTerminal(end: GoalTerminalEvent): void {
    if (!this.enabled || end.kind === 'operator_task_diagnostic') return;
    const source = end.source;
    const now = this.deps.clock.now();
    this.lastOutcome = { goalId: end.goalId, source: source?.kind ?? 'owner', state: end.state, reason: end.reason, detail: clip(end.detail, 300), atMs: now };
    if (!source || source.kind === 'owner') {
      this.ownerTerminal(end, now);
      return;
    }
    const admissionKey = `${end.goalId}:${end.epoch}`;
    if (this.accountedTerminals.has(admissionKey)) return;
    this.accountedTerminals.add(admissionKey);
    const admission = this.automaticAdmissions.get(admissionKey);
    this.automaticAdmissions.delete(admissionKey);
    this.session.plannerTurns += end.counters?.plannerTurns ?? 0;
    if (source.kind === 'support') {
      const p = this.proposals.get(end.goalId);
      this.proposals.delete(end.goalId);
      if (p) {
        this.safeSurvival((s) => s.onSupportTerminal({ proposalId: p.proposalId, goalId: end.goalId, goalEpoch: p.goalEpoch, state: end.state, reason: end.reason, detail: end.detail, counters: { plannerTurns: end.counters?.plannerTurns ?? 0, tasksAdmitted: end.counters?.tasksAdmitted ?? 0, replans: end.counters?.replans ?? 0 }, endedAtMs: now }));
      }
    }
    if (end.state === 'completed') {
      this.session.completed += 1;
      this.session.consecutiveUnproductive = 0;
      this.waitingStateFp = null;
      this.blocker = null;
      if (source.kind === 'progression' && end.interpretation) {
        this.milestones.unshift({ interpretation: clip(end.interpretation, 200), atMs: now });
        this.milestones.splice(6);
      }
      // A verified predicate can already hold at admission. Repeated completion of the same
      // outcome in the same state is not a new milestone and must not drive an inference loop.
      if (source.kind === 'progression') {
        const fp = this.outcomeFingerprint(end);
        const stateFp = this.deps.stateFingerprint();
        const previous = this.completedFingerprints.get(fp);
        const times = previous?.stateFp === stateFp ? previous.times + 1 : 1;
        this.completedFingerprints.set(fp, { stateFp, times });
        while (this.completedFingerprints.size > 32) this.completedFingerprints.delete(this.completedFingerprints.keys().next().value as string);
        if (admission?.stateFp === stateFp && times >= this.deps.config.session.maxRepeatsPerFingerprint) {
          this.waitingStateFp = stateFp;
          this.blocker = { code: 'unchanged_completed_outcome', detail: 'the same verified outcome completed again without changed inventory, place or project state' };
          this.setPhase('waiting', 'the last milestone already holds; waiting for changed state or an owner instruction before another assessment');
          this.schedule(this.backoffMs(), 'unchanged-state check');
          return;
        }
      }
      this.schedule(this.deps.config.afterCompletionMs, 'after a verified automatic outcome');
      return;
    }
    if (end.state === 'cancelled') {
      if (end.reason === 'replaced' && !this.deps.engine.activeSource) this.schedule(this.deps.config.afterCompletionMs, 'replaced automatic goal');
      return;
    }
    if (LIFECYCLE_REASONS.has(end.reason)) return; // rescheduled after respawn/ready
    if (end.reason === 'safety_interrupted') {
      this.schedule(0, 'after safety revocation');
      return;
    }
    if (PROVIDER_REASONS.has(end.reason)) {
      this.providerHolds.add(end.reason.startsWith('planner_') ? 'planner' : 'decision');
      this.cancelTimer('provider failure');
      this.blocker = { code: end.reason, detail: clip(end.detail, 300) };
      this.setPhase('provider_blocked', `automatic work waits: ${end.reason} (${clip(end.detail, 200)}); no polling or fallback — an owner instruction or resume re-checks`);
      this.noticeOnce(`Automatic work is waiting: ${end.reason}. Automatic retries stay off until an owner instruction or resume reassesses readiness.`);
      return;
    }
    // Support goals: survival owns attempts/cooldowns of its routines; progression: bounded backoff and repeated-blocker detection.
    if (source.kind === 'support') {
      this.schedule(this.deps.config.afterCompletionMs, `support ${end.reason}`);
      return;
    }
    this.session.consecutiveUnproductive += 1;
    const stateFp = this.deps.stateFingerprint();
    const fp = this.outcomeFingerprint(end);
    const entry = this.fingerprints.get(fp);
    const times = (entry?.times ?? 0) + 1;
    this.fingerprints.set(fp, { times, interpretation: clip(end.interpretation ?? 'automatic milestone', 160), reason: `${end.reason}: ${clip(end.detail, 120)}`, stateFp, lastAtMs: now });
    while (this.fingerprints.size > 32) this.fingerprints.delete(this.fingerprints.keys().next().value as string);
    const limits = this.deps.config.session;
    if (this.session.consecutiveUnproductive >= limits.maxConsecutiveUnproductive || times >= limits.maxRepeatsPerFingerprint) {
      this.waitingStateFp = stateFp;
      this.blocker = { code: times >= limits.maxRepeatsPerFingerprint ? 'repeated_blocked_outcome' : 'consecutive_unproductive', detail: `${end.reason}: ${clip(end.detail, 200)}` };
      this.setPhase('waiting', `${this.session.consecutiveUnproductive} automatic goal(s) in a row ended without a verified outcome (last: ${end.reason}); waiting for a change in inventory, place or home state, an owner instruction or resume (no polling inference)`);
      this.noticeOnce(`Automatic work is waiting: the last attempts were blocked (${end.reason}). I'll try again when something changes, or when you give me an instruction.`);
      this.schedule(this.backoffMs(), 'unchanged-state check');
      return;
    }
    this.schedule(this.backoffMs(), `cooldown after ${end.reason}`);
  }

  onLifecycle(event: GameLifecycleEvent): void {
    if (!this.enabled) return;
    if (['death', 'dimension_change', 'ended', 'ready', 'respawn'].includes(event.type)) this.invalidateAssessment();
    switch (event.type) {
      case 'death':
      case 'dimension_change':
      case 'ended':
        this.cancelTimer(`lifecycle ${event.type}`);
        this.stopGuard();
        return;
      case 'ready':
        this.deps.control.onConnectionReady();
        this.startGuard();
        this.schedule(this.deps.config.startDelayMs, 'connection ready');
        return;
      case 'respawn':
        this.startGuard();
        this.schedule(this.deps.config.startDelayMs, 'respawned');
        return;
      default:
        return;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.invalidateAssessment();
    this.cancelTimer('shutdown');
    this.stopGuard();
    if (this.enabled) await this.deps.control.close();
  }

  // ------------------------------------------------------------------ owner intent

  private ownerTerminal(end: GoalTerminalEvent, now: number): void {
    this.safeSurvival((s) =>
      s.onOwnerGoalEnd({
        goalId: end.goalId,
        instruction: clip(end.instruction ?? '', 1_000),
        ...(end.interpretation ? { interpretation: end.interpretation } : {}),
        ...(end.outcome ? { outcome: { kind: end.outcome.kind, rendered: clip(JSON.stringify(end.outcome.kind === 'finite' ? end.outcome.outcome : end.outcome.maintain), 1_000), atomic: atomicKinds(end.outcome.kind === 'finite' ? end.outcome.outcome : end.outcome.maintain) } } : {}),
        ...(end.baseline ? { baseline: { capturedAtMs: end.baseline.capturedAtMs, counts: end.baseline.counts ? { ...end.baseline.counts } : null } } : {}),
        progress: clip(end.progress ?? '', 1_000),
        state: end.state,
        reason: end.reason,
        endedAtMs: now,
      }),
    );
    const intent = this.ownerIntent && this.ownerIntent.goalId === end.goalId ? this.ownerIntent : null;
    if (end.state === 'completed') {
      if (intent) this.ownerIntent = null;
      this.session.consecutiveUnproductive = 0;
      this.waitingStateFp = null;
      this.blocker = null;
      if (this.mayRun() && !this.deps.engine.status().latch.paused) {
        const held = this.heldIntent();
        const next = held
          ? 'a newer unresolved instruction holds unrelated automatic work'
          : this.session.progressionGoals >= this.deps.config.session.maxProgressionGoals || this.plannerTurnsLeft() <= 0
            ? 'automatic progression allowance is exhausted; necessary support can still be reassessed'
            : 'returning to automatic progression shortly. Say stop to pause automatic work';
        this.deps.notify(`Finished your instruction (${clip(end.interpretation ?? end.instruction ?? end.goalId, 100)}); ${next}.`);
        this.schedule(this.deps.config.afterCompletionMs, 'owner goal verified');
      }
      return;
    }
    if (end.state === 'cancelled') {
      // owner_stop: the owner's own decision about THIS goal resolves it; replaced: the newer owner goal is tracked at admission.
      if (intent && end.reason === 'owner_stop') this.ownerIntent = null;
      return;
    }
    const interrupted = INTERRUPTION_REASONS.has(end.reason);
    // MB-FLOW-003-C12: a same-session HELD job that continues on its own needs no owner decision.
    const continues = end.held?.continuable === true;
    this.ownerIntent = {
      goalId: end.goalId,
      instruction: clip(end.instruction ?? intent?.instruction ?? '', 400),
      state: interrupted ? 'interrupted' : 'blocked',
      reason: end.reason,
      detail: clip(continues ? `held: continues when it is safe (continuation ${end.held!.continuations.used + 1} of at most ${end.held!.continuations.max})` : end.held ? `held, not continued automatically (${end.held.reason.replace(/[_:]/g, ' ')})` : end.detail, 300),
      sinceMs: now,
      ...(end.outcome ? { outcome: end.outcome } : {}),
      ...(end.interpretation ? { interpretation: end.interpretation } : {}),
      requiresOwnerDecision: !continues,
    };
    this.deps.record({ type: 'autonomy_owner_intent', goalId: end.goalId, state: this.ownerIntent.state, reason: end.reason, ...(end.held ? { held: end.held } : {}) });
    // App-written, declarative (MB-PLAN-006): never a question or a request for a reply.
    this.deps.notify(
      continues
        ? `Your instruction was interrupted (${end.reason.replace(/_/g, ' ')}); it is held and continues on its own when it is safe, after any necessary recovery. Unrelated automatic work waits. Stop cancels it; a new instruction replaces it.`
        : interrupted
          ? `Your instruction was interrupted (${end.reason.replace(/_/g, ' ')}); it is held and is not continued automatically. Unrelated automatic work waits; a new instruction replaces it.`
          : `Your instruction is blocked (${end.reason.replace(/_/g, ' ')}); it stays in view and unrelated automatic work waits until a new instruction replaces it.`,
    );
    // Support (eating, rest, recovery) may still run while the intent waits for the owner.
    if (!LIFECYCLE_REASONS.has(end.reason)) this.schedule(0, `owner goal ${end.reason}`);
  }

  // ------------------------------------------------------------------ scheduling

  private mayRun(): boolean {
    return this.started && this.enabled && !this.closed && this.deps.control.usable();
  }

  private schedule(ms: number, why: string): void {
    if (!this.mayRun() || this.deps.engine.status().latch.paused || !this.deps.connection()?.ready) return;
    this.cancelTimer();
    const at = this.deps.clock.now() + Math.max(0, ms);
    this.timerAt = at;
    this.timerWhy = why;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.timerAt = null;
      void this.runAssessment(why, false);
    }, Math.max(0, ms));
  }

  private cancelTimer(why?: string): void {
    if (this.timer !== undefined) {
      this.timers.clear(this.timer);
      this.timer = undefined;
      if (why) this.deps.record({ type: 'autonomy_schedule_cancelled', why, was: this.timerWhy });
    }
    this.timerAt = null;
  }

  /** Coarse survival guard: code-only fresh-state evaluation while connected, enabled and unpaused. */
  private startGuard(): void {
    this.stopGuard();
    if (!this.deps.survival?.enabled || !this.mayRun() || this.deps.engine.status().latch.paused || !this.deps.connection()?.ready) return;
    const generation = this.guardGeneration;
    const ms = this.deps.survivalGuardMs ?? 5_000;
    const tick = () => {
      this.guard = this.timers.set(() => {
        this.guard = undefined;
        if (generation !== this.guardGeneration) return;
        void this.runAssessment('survival guard', true).finally(() => {
          if (generation === this.guardGeneration && this.mayRun() && !this.deps.engine.status().latch.paused && this.deps.connection()?.ready) tick();
        });
      }, ms);
    };
    tick();
  }

  private stopGuard(): void {
    this.guardGeneration += 1;
    if (this.guard !== undefined) {
      this.timers.clear(this.guard);
      this.guard = undefined;
    }
  }

  private backoffMs(): number {
    const n = Math.max(1, this.session.consecutiveUnproductive);
    return Math.min(this.deps.config.maxBackoffMs, this.deps.config.afterBlockedMs * 2 ** (n - 1));
  }

  private setPhase(mode: Phase, detail: string): void {
    if (this.phase.mode === mode && this.phase.detail === detail) return;
    this.phase = { mode, detail: clip(detail, 400), sinceMs: this.deps.clock.now() };
    this.deps.record({ type: 'autonomy_phase', mode, detail: clip(detail, 300) });
  }

  private noticeOnce(text: string): void {
    if (text === this.lastNotice) return;
    this.lastNotice = text;
    this.deps.notify(text);
  }

  private safeSurvival(fn: (s: SurvivalPolicyPort) => void): void {
    const s = this.deps.survival;
    if (!s?.enabled) return;
    try {
      fn(s);
    } catch (error) {
      this.deps.record({ type: 'autonomy_survival_hook_error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  private activeFacts(engine: FullEngineStatus): ActiveWorkFacts {
    const source = this.deps.engine.activeSource;
    const goal = engine.goal;
    if (!goal || goal.terminal || !goal) return { kind: 'none' };
    const base = { goalId: goal.id, goalEpoch: goal.epoch, ...(engine.task?.capabilities ? { runningCapabilities: engine.task.capabilities } : {}) };
    if (goal.kind === 'operator_task_diagnostic') return { kind: 'diagnostic', ...base };
    if (!source || source.kind === 'owner') return { kind: 'owner_goal', ...base };
    if (source.kind === 'support') return { kind: 'support', ...base, routine: source.routine };
    return { kind: 'progression', ...base };
  }

  /** MB-FLOW-003-C4: LIVE owner intake only (a new instruction being prepared, or an owner question awaiting an answer). */
  private ownerIntakePending(engine: FullEngineStatus): boolean {
    if (engine.pending) return true;
    return Boolean(engine.goal && !engine.goal.terminal && engine.goal.state === 'awaiting_owner');
  }

  /**
   * The unresolved owner intent holding unrelated progression: the in-process
   * record, else survival's DURABLE interrupted directive (survives restart).
   * Only a new explicit owner instruction (or an explicit dismissal) clears it.
   */
  private heldIntent(): OwnerIntentRecord | null {
    if (this.ownerIntent && this.ownerIntent.state !== 'active') return this.ownerIntent;
    const s = this.deps.survival;
    if (!s?.enabled) return null;
    try {
      const d = s.interruptedOwnerIntent()[0];
      if (!d) return null;
      return { goalId: d.goalId, instruction: clip(d.instruction, 400), state: 'interrupted', reason: d.reason, detail: `interrupted (${d.reason})${d.durable ? '; durable record' : ''}`, sinceMs: d.interruptedAtMs, requiresOwnerDecision: true };
    } catch {
      return null;
    }
  }

  private invalidateAssessment(): void {
    this.assessmentGeneration += 1;
    this.assessmentAbort?.abort();
  }

  private currentAssessment(fence: AssessmentFence): boolean {
    const conn = this.deps.connection();
    return !fence.signal.aborted && fence.generation === this.assessmentGeneration && this.mayRun() &&
      !this.deps.engine.status().latch.paused && this.deps.engine.currentEpoch === fence.goalEpoch &&
      conn?.ready === true && conn.connectionEpoch === fence.connectionEpoch && conn.dimension === fence.dimension;
  }

  /** One code-only assessment at a time. Stop/lifecycle/admission fences abort the wait,
   * so a late observation cannot admit support or revoke a newer owner's work. */
  private runAssessment(why: string, guardOnly: boolean): Promise<void> {
    if (this.assessment) {
      if (this.assessmentAbort?.signal.aborted) return this.assessment.then(() => this.runAssessment(why, guardOnly));
      // A ready/completion timer must not be lost behind a code-only guard read.
      if (!guardOnly && this.assessmentRequest) {
        this.assessmentRequest.guardOnly = false;
        this.assessmentRequest.why = why;
      }
      return this.assessment;
    }
    if (!this.mayRun() || this.submitting || this.deps.engine.status().latch.paused) return Promise.resolve();
    const conn = this.deps.connection();
    if (!conn?.ready || (guardOnly && !this.deps.survival?.enabled)) return Promise.resolve();
    const abort = new AbortController();
    this.assessmentAbort = abort;
    const fence: AssessmentFence = { generation: this.assessmentGeneration, goalEpoch: this.deps.engine.currentEpoch, connectionEpoch: conn.connectionEpoch, dimension: conn.dimension, signal: abort.signal };
    const request = { why, guardOnly };
    this.assessmentRequest = request;
    const op = this.consider(request, fence).catch((error: unknown) => {
      if (!this.currentAssessment(fence)) return;
      this.blocker = { code: 'assessment_failed', detail: clip(error instanceof Error ? error.message : String(error), 300) };
      this.setPhase('waiting', `automatic assessment waits: ${this.blocker.detail}`);
      this.deps.record({ type: 'autonomy_assessment_error', detail: this.blocker.detail });
    }).finally(() => {
      if (this.assessment === op) {
        this.assessment = undefined;
        this.assessmentRequest = undefined;
        this.assessmentAbort = undefined;
      }
    });
    this.assessment = op;
    return op;
  }

  private observe(fence: AssessmentFence): Promise<ObservationSnapshot | null> {
    return new Promise((resolve) => {
      if (fence.signal.aborted) return resolve(null);
      const finish = (snapshot: ObservationSnapshot | null) => {
        clearTimeout(timeout);
        fence.signal.removeEventListener('abort', aborted);
        resolve(snapshot);
      };
      const aborted = () => finish(null);
      const timeout = setTimeout(aborted, Math.min(5_000, this.deps.goalLimits.deadlineMs));
      timeout.unref?.();
      fence.signal.addEventListener('abort', aborted, { once: true });
      // The port is read-only. Retain a rejection handler even after cancellation or timeout.
      Promise.resolve().then(() => this.deps.observe()).then(finish, () => finish(null));
    });
  }

  /** One fresh survival evaluation (code only), consuming this assessment's snapshot once. */
  private assessSurvival(snapshot: ObservationSnapshot): SurvivalDecision | null {
    const s = this.deps.survival;
    if (!s?.enabled) return null;
    const conn = this.deps.connection();
    const engine = this.deps.engine.status();
    try {
      return s.assess({
        nowMs: this.deps.clock.now(),
        connection: conn,
        snapshot,
        autonomyAllowed: !engine.latch.paused && this.mayRun(),
        active: this.activeFacts(engine),
        ownerIntakePending: this.ownerIntakePending(engine),
        ownerIntentInterrupted: this.heldIntent()?.state === 'interrupted',
        goalLimits: { ...this.deps.goalLimits, plannerTurns: Math.min(this.deps.goalLimits.plannerTurns, this.plannerTurnsLeft()) },
      });
    } catch (error) {
      this.deps.record({ type: 'autonomy_survival_assess_error', message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async revokeUnsafe(decision: Extract<SurvivalDecision, { kind: 'revoke_unsafe' }>): Promise<void> {
    const r = await this.deps.engine.revokeForSafety(`${decision.reason}: ${decision.detail}`);
    if (r.revoked) {
      this.session.safetyRevocations += 1;
      this.deps.record({ type: 'autonomy_safety_revocation', goalId: r.goalId ?? null, source: r.source ?? null, reason: decision.reason, retainOwnerIntent: decision.retainOwnerIntent });
      this.deps.notify(`Stopped the current work for safety (${clip(decision.detail, 160)}).${r.source?.kind === 'owner' || !r.source ? ' Your instruction stays in view.' : ''}`);
    }
  }

  /** One bounded scheduling decision (code only). */
  private async consider(request: AssessmentRequest, fence: AssessmentFence): Promise<void> {
    const snapshot = await this.observe(fence);
    if (!this.currentAssessment(fence)) return;
    if (!snapshot || snapshot.connectionEpoch !== fence.connectionEpoch || snapshot.dimension !== fence.dimension ||
      snapshot.takenAtMs > this.deps.clock.now() || this.deps.clock.now() - snapshot.takenAtMs > 5_000) {
      this.blocker = { code: 'observation_not_current', detail: 'a current filtered observation is unavailable; automatic work waits' };
      this.setPhase('waiting', this.blocker.detail);
      return;
    }
    // 1. Survival first (safety/support), also while an owner intent is unresolved.
    const decision = this.assessSurvival(snapshot);
    if (decision?.kind === 'revoke_unsafe') {
      await this.revokeUnsafe(decision);
      return;
    }
    const engineBlocker = this.deps.engine.automaticBlocker();
    if (engineBlocker) {
      const active = this.deps.engine.activeSource;
      if (decision?.kind === 'propose' && active && active.kind !== 'owner' && decision.proposal.priority === 'safety' &&
        engineBlocker.reason === 'busy' && !this.ownerIntakePending(this.deps.engine.status())) {
        await this.admitProposal(decision.proposal);
        return;
      }
      this.setPhase('idle', `not started (${engineBlocker.reason}): ${engineBlocker.detail}`);
      return;
    }
    if (decision?.kind === 'propose') {
      await this.admitProposal(decision.proposal);
      return;
    }
    if (decision?.kind === 'blocked') {
      this.blocker = { code: `${decision.routine}_${decision.reason}`.slice(0, 64), detail: clip(decision.detail, 300) };
      this.setPhase('waiting', `automatic work waits for ${decision.routine}: ${decision.detail}`);
      if (decision.retryAfterMs !== undefined) {
        const requested = Number.isFinite(decision.retryAfterMs) ? decision.retryAfterMs : this.deps.config.maxBackoffMs;
        this.schedule(Math.min(this.deps.config.maxBackoffMs, Math.max(this.deps.config.afterBlockedMs, requested)), `survival ${decision.routine} retry window`);
      }
      return;
    }
    // 2. Unresolved owner intent holds unrelated progression (C1; no automatic continuation), including survival's durable record after a restart.
    const intent = this.heldIntent();
    if (intent) {
      this.setPhase('idle', `holding automatic progression for your ${intent.state} instruction "${clip(intent.instruction, 80)}" (${intent.reason}); a new instruction releases it`);
      return;
    }
    if (request.guardOnly) return; // The guard never starts unrelated progression or a second assessment.
    if (!this.providersUsable(true)) return;
    // 3. Progression.
    const limits = this.deps.config.session;
    if (this.session.progressionGoals >= limits.maxProgressionGoals || this.session.plannerTurns >= limits.maxPlannerTurns) {
      this.blocker = { code: 'session_allowance_exhausted', detail: `${this.session.progressionGoals}/${limits.maxProgressionGoals} progression goals, ${this.session.plannerTurns}/${limits.maxPlannerTurns} automatic planner turns this run` };
      this.setPhase('exhausted', `the automatic allowance for this run is used up (${this.blocker.detail}); owner instructions still work`);
      this.noticeOnce('The automatic-work allowance for this session is used up; I will wait for your instructions.');
      return;
    }
    if (this.waitingStateFp !== null) {
      const fp = this.deps.stateFingerprint();
      if (fp === this.waitingStateFp) {
        this.schedule(this.backoffMs(), 'unchanged-state check');
        return;
      }
      this.deps.record({ type: 'autonomy_state_changed', from: this.waitingStateFp, to: fp });
      this.waitingStateFp = null;
      this.session.consecutiveUnproductive = Math.max(0, limits.maxConsecutiveUnproductive - 1);
    }
    await this.submitProgression(request.why);
  }

  private context(source: GoalSource, reason: string, support?: AutonomyPlannerContext['support']): AutonomyPlannerContext {
    const limits = this.deps.config.session;
    const avoid = [...this.fingerprints.values()]
      .sort((a, b) => b.lastAtMs - a.lastAtMs)
      .slice(0, 6)
      .map((f) => ({ interpretation: f.interpretation, reason: f.reason, times: f.times }));
    const held = this.heldIntent();
    const intent = held ? { instruction: clip(held.instruction, 200), state: held.state, detail: clip(`${held.reason}: ${held.detail}`, 200) } : null;
    return {
      source,
      reason: clip(reason, 200),
      owner: { unresolvedIntent: intent },
      recentMilestones: this.milestones.slice(0, 6),
      avoid,
      session: {
        automaticGoalsLeft: Math.max(0, source.kind === 'support' ? limits.maxSupportGoals - this.session.supportGoals : limits.maxProgressionGoals - this.session.progressionGoals),
        plannerTurnsLeft: this.plannerTurnsLeft(),
      },
      home: this.deps.home?.() ?? null,
      ...(support ? { support } : {}),
      rules: AUTONOMY_RULES,
    };
  }

  /** Planner turns left in this run's automatic allowance (never replenished by resume, death or a new milestone). */
  private plannerTurnsLeft(): number {
    const source = this.deps.engine.activeSource;
    const goal = this.deps.engine.status().goal;
    const live = source && source.kind !== 'owner' && goal && !goal.terminal ? (goal.counters?.plannerTurns ?? goal.plannerTurns) : 0;
    return Math.max(0, this.deps.config.session.maxPlannerTurns - this.session.plannerTurns - live);
  }

  /** Every admission path, including guard replacement, uses the same readiness and run-spend gate. */
  private providersUsable(needsPlanner: boolean): boolean {
    if (this.providerHolds.has('decision') || (needsPlanner && this.providerHolds.has('planner'))) {
      this.cancelTimer('provider hold');
      this.setPhase('provider_blocked', `automatic work waits after ${this.blocker?.code ?? 'provider failure'}; owner admission or resume reassesses readiness`);
      return false;
    }
    const providers = this.deps.providers();
    if (needsPlanner ? providers.ready : (providers.decisionReady ?? providers.ready)) return true;
    this.cancelTimer('provider unavailable');
    this.blocker = { code: providers.code ?? 'provider_not_ready', detail: clip(providers.detail, 300) };
    this.setPhase('provider_blocked', `automatic work waits: ${providers.detail} (no polling inference or fallback)`);
    return false;
  }

  /** MB-FLOW-001-C2: every automatic planner admission is clamped to the remaining session planner turns. */
  private plannerCeilings(base: GoalCeilings): GoalCeilings | undefined {
    const left = this.plannerTurnsLeft();
    if (left <= 0) return undefined;
    return { ...base, plannerTurns: Math.min(base.plannerTurns, left) };
  }

  private async submitProgression(why: string): Promise<void> {
    const source: GoalSource = { kind: 'progression', sessionAttempt: this.session.progressionGoals + 1 };
    const ceilings = this.plannerCeilings({ ...this.deps.goalLimits });
    if (!ceilings) {
      this.blocker = { code: 'session_allowance_exhausted', detail: `${this.session.plannerTurns}/${this.deps.config.session.maxPlannerTurns} automatic planner turns used this run` };
      this.setPhase('exhausted', `no automatic planner turns are left this run (${this.blocker.detail}); owner instructions still work`);
      return;
    }
    const context = this.context(source, `no owner instruction is pending (${why})`);
    this.submitting = true;
    this.setPhase('assessing', `starting automatic progression assessment ${source.sessionAttempt}`);
    try {
      const r = await this.deps.engine.submitAutomatic(progressionInstruction(context), source, { context, ceilings });
      if (r.status === 'admitted') {
        this.deps.record({ type: 'autonomy_goal_submitted', goalId: r.goal.id, source, why });
      } else {
        this.deps.record({ type: 'autonomy_goal_not_admitted', source: source.kind, status: r.status, ...(r.status === 'rejected' ? { reason: r.reason, detail: r.detail } : {}) });
        if (r.status === 'rejected') this.admissionRejected(r);
      }
    } finally {
      this.submitting = false;
    }
  }

  /** Admits one survival proposal through the single admission path (planner goal or code task). */
  private async admitProposal(proposal: SurvivalProposal): Promise<void> {
    if (!this.mayRun() || this.deps.engine.status().latch.paused || !this.deps.connection()?.ready ||
      this.ownerIntakePending(this.deps.engine.status()) || this.deps.engine.activeSource?.kind === 'owner') return;
    if (this.refusedProposal?.signature === proposal.signature && this.refusedProposal.stateFp === this.deps.stateFingerprint()) return;
    if (!this.providersUsable(proposal.execution.kind === 'planner_goal')) return;
    const now = this.deps.clock.now();
    if (proposal.expiresAtMs <= now) {
      this.deps.record({ type: 'autonomy_support_proposal_expired', proposalId: proposal.proposalId, routine: proposal.routine });
      return;
    }
    const limits = this.deps.config.session;
    if (this.session.supportGoals >= limits.maxSupportGoals) {
      this.blocker = { code: 'support_allowance_exhausted', detail: `${this.session.supportGoals}/${limits.maxSupportGoals} support goals this run` };
      this.setPhase('exhausted', `support allowance used up (${this.blocker.detail}); ${proposal.routine} not started`);
      this.noticeOnce(`I need to ${clip(proposal.reason, 80)}, but the automatic support allowance for this session is used up.`);
      return;
    }
    const active = this.deps.engine.activeSource;
    // Support never replaces owner work or another support routine; safety may replace progression/support.
    const replaceAutomatic = active !== undefined && (proposal.priority === 'safety' || active.kind === 'progression');
    const source: GoalSource = {
      kind: 'support',
      routine: proposal.routine,
      priority: proposal.priority,
      proposalId: proposal.proposalId,
      ...(proposal.episodeId ? { episodeId: proposal.episodeId } : {}),
      execution: proposal.execution.kind,
      serves: proposal.serves,
      reason: clip(proposal.reason, 200),
      sessionAttempt: this.session.supportGoals + 1,
    };
    const base: GoalCeilings = {
      plannerTurns: Math.min(proposal.ceilings.plannerTurns, this.deps.goalLimits.plannerTurns),
      tasks: Math.min(proposal.ceilings.tasks, this.deps.goalLimits.tasks),
      replans: Math.min(proposal.ceilings.replans, this.deps.goalLimits.replans),
      deadlineMs: Math.min(proposal.ceilings.deadlineMs, this.deps.goalLimits.deadlineMs),
    };
    // Planner goals are clamped to the remaining session planner turns (and refused when none remain);
    // an inference-free code task needs no planner turn and stays bounded by its own ceilings.
    const ceilings = proposal.execution.kind === 'planner_goal' ? this.plannerCeilings(base) : base;
    if (!ceilings) {
      this.blocker = { code: 'session_allowance_exhausted', detail: `${this.session.plannerTurns}/${this.deps.config.session.maxPlannerTurns} automatic planner turns used this run` };
      this.setPhase('exhausted', `support routine ${proposal.routine} needs planning but no automatic planner turns are left this run`);
      this.noticeOnce(`I need to ${clip(proposal.reason, 80)}, but the automatic planning allowance for this session is used up.`);
      return;
    }
    this.submitting = true;
    this.admittingProposal = proposal;
    this.setPhase('assessing', `starting support routine ${proposal.routine}`);
    try {
      let r: SubmitResult;
      if (proposal.execution.kind === 'planner_goal') {
        const context = this.context(source, proposal.reason, proposal.execution.context);
        r = await this.deps.engine.submitAutomatic(proposal.execution.instruction, source, { context, ceilings, replaceAutomatic });
      } else {
        // The code-built spec carries its completion (survival_state once that predicate is shared); the engine re-validates it.
        const exec = proposal.execution as { spec: Partial<TaskSpec>; completion?: unknown };
        const spec = { ...exec.spec, ...(exec.completion !== undefined ? { completion: exec.completion } : {}) } as TaskSpec;
        r = await this.deps.engine.submitSupportTask(spec, proposal.execution.mode, source, { ceilings, replaceAutomatic });
      }
      if (r.status === 'admitted') {
        this.deps.record({ type: 'autonomy_goal_submitted', goalId: r.goal.id, source, replacedGoalId: r.replacedGoalId ?? null });
      } else {
        this.deps.record({ type: 'autonomy_goal_not_admitted', source: 'support', routine: proposal.routine, status: r.status, ...(r.status === 'rejected' ? { reason: r.reason, detail: r.detail } : {}) });
        if (r.status === 'rejected') {
          this.admissionRejected(r);
          if (!['busy', 'paused', 'not_connected', 'shutting_down'].includes(r.reason)) this.refusedProposal = { signature: proposal.signature, stateFp: this.deps.stateFingerprint() };
        }
      }
    } finally {
      this.admittingProposal = undefined;
      this.submitting = false;
    }
  }

  private admissionRejected(result: Extract<SubmitResult, { status: 'rejected' }>): void {
    if (['busy', 'paused', 'not_connected', 'shutting_down'].includes(result.reason)) return;
    this.blocker = { code: `admission_${result.reason}`, detail: clip(result.detail, 300) };
    this.setPhase('waiting', `automatic admission waits: ${result.detail}`);
    // A faulty policy proposal must not be retried by the coarse guard forever.
    this.waitingStateFp = this.deps.stateFingerprint();
  }

  private outcomeFingerprint(end: GoalTerminalEvent): string {
    const what = end.outcome ? JSON.stringify(end.outcome) : (end.interpretation ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    return hash(`${what}|${end.reason}`);
  }

  // ------------------------------------------------------------------ status

  status(): AutonomyStatus {
    const now = this.deps.clock.now();
    const engine = this.deps.engine.status();
    const persistence = this.enabled ? this.deps.control.persistence() : { state: 'disabled' as const, detail: this.deps.enabled.reason, revision: 0 };
    const active = this.deps.engine.activeSource;
    const goal = engine.goal;
    const activeGoal = active && goal && !goal.terminal ? { goalId: goal.id, source: active, priority: priorityOfSource(active) } : null;
    let intent = this.ownerIntent && this.ownerIntent.state === 'active' ? this.ownerIntent : (this.heldIntent() ?? this.ownerIntent);
    if (intent && intent.state === 'active' && goal && goal.id === intent.goalId && goal.state === 'awaiting_owner') intent = { ...intent, state: 'awaiting_answer', detail: goal.pendingClarification ? `question ${goal.pendingClarification.ref}: ${goal.pendingClarification.question}` : intent.detail };
    let mode: AutonomyMode;
    let detail: string;
    if (!this.enabled) {
      mode = 'disabled';
      detail = this.deps.enabled.reason;
    } else if (persistence.state !== 'ready') {
      mode = 'scope_blocked';
      detail = persistence.detail;
    } else if (!this.deps.connection()?.ready) {
      mode = 'not_connected';
      detail = 'no ready connection; automatic work never connects or reconnects';
    } else if (engine.latch.paused) {
      mode = 'paused';
      detail = `automatic work paused (stop${engine.latch.source ? ` from ${engine.latch.source}` : ''}); manual instructions work; say resume to allow automatic work`;
    } else if (engine.pending || (active && active.kind === 'owner')) {
      mode = 'owner';
      detail = engine.pending ? 'an owner instruction is being prepared' : `owner goal ${goal?.id ?? ''} has priority`;
    } else if (active?.kind === 'support') {
      mode = 'support';
      detail = `${active.priority} routine ${active.routine}: ${active.reason}`;
    } else if (active?.kind === 'progression') {
      mode = 'progression';
      detail = `automatic progression goal ${goal?.id ?? ''} (attempt ${active.sessionAttempt})`;
    } else if (intent && intent.state !== 'active') {
      mode = 'owner_unresolved';
      detail = `your ${intent.state} instruction "${clip(intent.instruction, 80)}" (${intent.reason}) holds automatic progression until you give a new instruction`;
    } else if (this.phase.mode !== 'idle' && this.phase.mode !== 'cooldown') {
      mode = this.phase.mode;
      detail = this.phase.detail;
    } else if (this.timerAt !== null) {
      mode = 'cooldown';
      detail = `next assessment in ${Math.max(0, Math.round((this.timerAt - now) / 1000))}s (${this.timerWhy})`;
    } else {
      mode = 'waiting';
      detail = this.phase.detail;
    }
    const latch = engine.latch;
    const epoch = goal && !goal.terminal ? goal.epoch : undefined;
    return {
      mode,
      detail: clip(detail, 400),
      sinceMs: this.phase.sinceMs,
      enabled: this.enabled,
      scope: this.deps.control.scope ? { ...this.deps.control.scope } : null,
      persistence,
      latch: { paused: latch.paused, ...(latch.sinceMs !== undefined ? { sinceMs: latch.sinceMs } : {}), ...(latch.source ? { source: latch.source } : {}), durable: this.enabled ? this.deps.control.latchDurability() : 'none' },
      active: activeGoal,
      ownerIntent: intent ? { goalId: intent.goalId, instruction: intent.instruction, state: intent.state, detail: intent.detail, requiresOwnerDecision: intent.requiresOwnerDecision } : null,
      nextAssessmentAtMs: this.timerAt,
      session: { ...this.session, plannerTurns: this.deps.config.session.maxPlannerTurns - this.plannerTurnsLeft(), limits: { ...this.deps.config.session } },
      lastOutcome: this.lastOutcome,
      blocker: this.blocker,
      home: this.deps.home?.() ?? null,
      support: this.deps.survival?.enabled ? this.deps.survival.status(now) : null,
      route: this.deps.route?.status(epoch) ?? null,
    };
  }

  /** Test seam: runs one scheduling decision now (code only). */
  assessNow(why = 'test'): Promise<void> {
    this.cancelTimer();
    return this.runAssessment(why, false);
  }

  /** Test seam: runs one survival guard evaluation now. */
  guardNow(): Promise<void> {
    return this.runAssessment('survival guard', true);
  }
}
