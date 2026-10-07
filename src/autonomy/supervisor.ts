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

const PROVIDER_REASONS = new Set(['planner_not_ready', 'decision_not_ready', 'planner_error']);
const LIFECYCLE_REASONS = new Set(['death', 'disconnected', 'kicked', 'dimension_change']);
const INTERRUPTION_REASONS = new Set(['low_health', 'safety_interrupted', 'death', 'disconnected', 'kicked', 'dimension_change']);

interface FingerprintEntry {
  times: number;
  interpretation: string;
  reason: string;
  stateFp: string;
  lastAtMs: number;
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
  private assessing = false;
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
    if (cause === 'owner_stop') {
      this.cancelTimer('owner stop');
      this.stopGuard();
      this.setPhase('idle', 'paused by owner stop');
      void this.deps.control.setLatch({ paused: true, ...(latch.sinceMs !== undefined ? { sinceMs: latch.sinceMs } : {}), source: latch.source ?? 'stop' });
      return;
    }
    // C1: resume ONLY clears the durable latch and freshly reassesses. Unresolved owner intent is untouched.
    void this.deps.control.setLatch({ paused: false });
    this.waitingStateFp = null;
    this.setPhase('idle', 'resumed by owner');
    this.startGuard();
    this.schedule(0, 'resume');
  }

  onGoalAdmitted(admission: { goalId: string; epoch: number; instruction: string; source?: GoalSource; admittedAtMs: number }): void {
    if (!this.enabled) return;
    const source = admission.source;
    if (!source) return; // operator diagnostic
    this.cancelTimer('goal admitted');
    if (source.kind === 'owner') {
      // A NEW explicit owner instruction supersedes any older unresolved intent (C1).
      if (this.ownerIntent && this.ownerIntent.state !== 'active') this.deps.record({ type: 'autonomy_owner_intent_superseded', goalId: this.ownerIntent.goalId, by: admission.goalId });
      this.ownerIntent = { goalId: admission.goalId, instruction: clip(admission.instruction, 400), state: 'active', reason: 'admitted', detail: 'owner instruction admitted', sinceMs: admission.admittedAtMs, requiresOwnerDecision: false };
      this.session.consecutiveUnproductive = 0;
      this.waitingStateFp = null;
      this.blocker = null;
      this.safeSurvival((s) => s.onOwnerInstruction(admission.admittedAtMs));
      return;
    }
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
      this.blocker = { code: end.reason, detail: clip(end.detail, 300) };
      this.setPhase('provider_blocked', `automatic work waits: ${end.reason} (${clip(end.detail, 200)}); no polling or fallback — an owner instruction or resume re-checks`);
      this.noticeOnce(`Automatic work is waiting: ${end.reason}. It will not retry by itself; give me an instruction or say resume after fixing it.`);
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
        this.deps.notify(`Finished your instruction (${clip(end.interpretation ?? end.instruction ?? end.goalId, 100)}); returning to automatic progression shortly. Say stop to pause automatic work.`);
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
    this.ownerIntent = {
      goalId: end.goalId,
      instruction: clip(end.instruction ?? intent?.instruction ?? '', 400),
      state: interrupted ? 'interrupted' : 'blocked',
      reason: end.reason,
      detail: clip(end.detail, 300),
      sinceMs: now,
      ...(end.outcome ? { outcome: end.outcome } : {}),
      ...(end.interpretation ? { interpretation: end.interpretation } : {}),
      requiresOwnerDecision: true,
    };
    this.deps.record({ type: 'autonomy_owner_intent', goalId: end.goalId, state: this.ownerIntent.state, reason: end.reason });
    this.deps.notify(
      interrupted
        ? `Your instruction was interrupted (${end.reason}); I'm keeping it in view and won't resume it on my own or start unrelated automatic work. Tell me what to do next (repeat it to start it again).`
        : `Your instruction is blocked (${end.reason}); I'll keep it in view and won't start unrelated automatic work until you give a new instruction.`,
    );
    // Support (eating, rest, recovery) may still run while the intent waits for the owner.
    if (!LIFECYCLE_REASONS.has(end.reason)) this.schedule(0, `owner goal ${end.reason}`);
  }

  // ------------------------------------------------------------------ scheduling

  private mayRun(): boolean {
    return this.enabled && !this.closed && this.deps.control.usable();
  }

  private schedule(ms: number, why: string): void {
    if (!this.enabled || this.closed) return;
    this.cancelTimer();
    const at = this.deps.clock.now() + Math.max(0, ms);
    this.timerAt = at;
    this.timerWhy = why;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.timerAt = null;
      void this.consider(why);
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
    if (!this.deps.survival?.enabled || this.closed) return;
    const ms = this.deps.survivalGuardMs ?? 5_000;
    const tick = () => {
      this.guard = this.timers.set(() => {
        this.guard = undefined;
        if (this.closed) return;
        void this.survivalGuard().finally(() => {
          if (!this.closed && this.deps.connection()?.ready) tick();
        });
      }, ms);
    };
    tick();
  }

  private stopGuard(): void {
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

  /** One fresh survival evaluation (code only). */
  private async assessSurvival(): Promise<SurvivalDecision | null> {
    const s = this.deps.survival;
    if (!s?.enabled) return null;
    const conn = this.deps.connection();
    const snapshot = conn?.ready ? await this.deps.observe().catch(() => null) : null;
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
      return null;
    }
  }

  /** Guard: immediate safety (revoke unsafe active work) and safety proposals that may replace automatic work. */
  private async survivalGuard(): Promise<void> {
    if (!this.mayRun() || this.submitting || this.assessing) return;
    this.assessing = true;
    try {
      const decision = await this.assessSurvival();
      if (!decision) return;
      if (decision.kind === 'revoke_unsafe') {
        await this.revokeUnsafe(decision);
        return;
      }
      if (decision.kind === 'propose' && decision.proposal.priority === 'safety' && this.deps.engine.activeSource && this.deps.engine.activeSource.kind !== 'owner') {
        await this.admitProposal(decision.proposal);
        return;
      }
      if (decision.kind === 'propose' && !this.deps.engine.activeSource && !this.deps.engine.automaticBlocker()) await this.consider('survival guard');
    } finally {
      this.assessing = false;
    }
  }

  private async revokeUnsafe(decision: Extract<SurvivalDecision, { kind: 'revoke_unsafe' }>): Promise<void> {
    const r = await this.deps.engine.revokeForSafety(`${decision.reason}: ${decision.detail}`);
    if (r.revoked) {
      this.session.safetyRevocations += 1;
      this.deps.record({ type: 'autonomy_safety_revocation', goalId: r.goalId ?? null, source: r.source ?? null, reason: decision.reason, retainOwnerIntent: decision.retainOwnerIntent });
      this.deps.notify(`Stopped the current work for safety (${clip(decision.detail, 160)}).${r.source?.kind === 'owner' || !r.source ? ' Your instruction stays in view until you decide.' : ''}`);
    }
  }

  /** One bounded scheduling decision (code only). */
  private async consider(why: string): Promise<void> {
    if (!this.enabled || this.closed || this.submitting) return;
    if (!this.deps.control.usable()) {
      this.setPhase('idle', `automatic work off: ${this.deps.control.persistence().detail}`);
      return;
    }
    // 1. Survival first (safety/support), also while an owner intent is unresolved.
    const decision = await this.assessSurvival();
    if (decision?.kind === 'revoke_unsafe') {
      await this.revokeUnsafe(decision);
      return;
    }
    const engineBlocker = this.deps.engine.automaticBlocker();
    if (engineBlocker) {
      this.setPhase('idle', `not started (${engineBlocker.reason}): ${engineBlocker.detail}`);
      return;
    }
    const providers = this.deps.providers();
    if (decision?.kind === 'propose') {
      const needsPlanner = decision.proposal.execution.kind === 'planner_goal';
      // A code task makes no planner turn, but its decisions are real Jev calls counted in the run SpendLedger.
      const usable = needsPlanner ? providers.ready : (providers.decisionReady ?? providers.ready);
      if (!usable) {
        this.blocker = { code: providers.code ?? 'provider_not_ready', detail: providers.detail };
        this.setPhase('provider_blocked', `support routine ${decision.proposal.routine} waits: ${providers.detail}`);
        return;
      }
      await this.admitProposal(decision.proposal);
      return;
    }
    if (decision?.kind === 'blocked') {
      this.blocker = { code: `${decision.routine}_${decision.reason}`.slice(0, 64), detail: clip(decision.detail, 300) };
      if (decision.retryAfterMs !== undefined) this.schedule(decision.retryAfterMs, `survival ${decision.routine} retry window`);
    }
    if (!providers.ready) {
      this.blocker = { code: providers.code ?? 'provider_not_ready', detail: providers.detail };
      this.setPhase('provider_blocked', `automatic work waits: ${providers.detail} (no polling, no fallback)`);
      return;
    }
    // 2. Unresolved owner intent holds unrelated progression (C1; no automatic continuation), including survival's durable record after a restart.
    const intent = this.heldIntent();
    if (intent) {
      this.setPhase('idle', `holding automatic progression for your ${intent.state} instruction "${clip(intent.instruction, 80)}" (${intent.reason}); a new instruction releases it`);
      return;
    }
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
    await this.submitProgression(why);
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
    return Math.max(0, this.deps.config.session.maxPlannerTurns - this.session.plannerTurns);
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
        this.session.progressionGoals += 1;
        this.deps.record({ type: 'autonomy_goal_submitted', goalId: r.goal.id, source, why });
        this.setPhase('idle', `progression goal ${r.goal.id} admitted`);
      } else {
        this.deps.record({ type: 'autonomy_goal_not_admitted', source: source.kind, status: r.status, ...(r.status === 'rejected' ? { reason: r.reason, detail: r.detail } : {}) });
        this.setPhase('idle', r.status === 'rejected' ? `not started (${r.reason})` : 'superseded by an owner instruction or stop');
      }
    } finally {
      this.submitting = false;
    }
  }

  /** Admits one survival proposal through the single admission path (planner goal or code task). */
  private async admitProposal(proposal: SurvivalProposal): Promise<void> {
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
    const replaceAutomatic = active !== undefined && active.kind !== 'owner' && (proposal.priority === 'safety' || active.kind === 'progression');
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
        this.session.supportGoals += 1;
        this.deps.record({ type: 'autonomy_goal_submitted', goalId: r.goal.id, source, replacedGoalId: r.replacedGoalId ?? null });
        this.setPhase('idle', `support goal ${r.goal.id} admitted`);
      } else {
        this.deps.record({ type: 'autonomy_goal_not_admitted', source: 'support', routine: proposal.routine, status: r.status, ...(r.status === 'rejected' ? { reason: r.reason, detail: r.detail } : {}) });
      }
    } finally {
      this.admittingProposal = undefined;
      this.submitting = false;
    }
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
      session: { ...this.session, limits: { ...this.deps.config.session } },
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
    return this.consider(why);
  }

  /** Test seam: runs one survival guard evaluation now. */
  guardNow(): Promise<void> {
    return this.survivalGuard();
  }
}
