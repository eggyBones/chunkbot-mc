// Generic task runtime (MB-V1-03). One admitted TaskSpec at a time:
//
//   bind completion baseline -> loop {
//     evaluate verified completion (code) -> done? -> fresh filtered snapshot
//     -> guards (ownership, no progress, low health) -> candidates from the
//     REGISTERED resolvers of the task's allowed capabilities -> freeze a
//     bounded option set + epochs -> one Jev choice (code-generated ID only) ->
//     ownership check after the await -> revalidate the choice against a fresh
//     snapshot (target/mechanics/limits via the same resolvers) -> execute the
//     frozen candidate through the accepted SkillExecutor -> validate the
//     outcome identity -> record progress / per-target failures }
//
// There is no intent enum, keyword switch, resource-specific loop or hidden
// prerequisite chain: what to do comes from the TaskSpec (planner or operator
// diagnostic), which options exist comes from skill resolvers, which option is
// taken comes from Jev, and whether it worked comes from server-confirmed
// evidence and code-evaluated predicates. When nothing is actionable the task
// returns structured feedback (resolver reasons) for planner recovery.
//
// Healthy sustained actions (a skill whose definition declares `sustained`,
// e.g. following, furnace processing) are continued locally while their
// window simply elapsed and an equivalent candidate still exists. Elapsed time
// grants no progress: an unmet condition still needs outcome or owned motion
// progress before the existing stall deadline. No repeated inference is needed.
import type {
  ActionCandidate,
  AdmittedTask,
  BoundPredicate,
  CandidateGenerator,
  CandidateSet,
  Clock,
  DecisionChoice,
  DecisionPort,
  DecisionRequest,
  IdSource,
  JsonValue,
  LowHealthAllowancePort,
  ObservationSnapshot,
  PredicateEvaluation,
  PredicateEvaluator,
  Readiness,
  RunStore,
  SkillExecutor,
  SkillOutcome,
  TaskExecutionPort,
  TaskFeedback,
  TaskOutcomeSummary,
  TaskResult,
  TaskResultStatus,
} from '../contracts/index.ts';
import { buildState, describePredicate, requestBytes } from '../decision/context.ts';
import { LIMIT_KINDS, NOT_READY_KINDS, isDecisionError } from '../decision/errors.ts';
import { MAX_REQUEST_BYTES } from '../decision/pricing.ts';
import { publicTaskLabel } from '../goals/public-text.ts';
import type { SafetyPort } from '../contracts/safety.ts';
import type { TaskMotionProgressPort } from './motion-progress.ts';

/** Skill-owned continuation policy (see SkillDefinition.sustained). */
export interface SustainPolicy {
  /** True when the outcome means "the healthy wait window elapsed" (not success of the whole thing, not failure). */
  windowElapsed(outcome: SkillOutcome): boolean;
}

type ResolvedTarget =
  | { kind: 'block'; x: number; y: number; z: number }
  | { kind: 'entity' | 'drop'; entityId: number }
  | { kind: 'frontier'; at: { x: number; y: number; z: number } }
  | { kind: 'group'; class: string; members: ReadonlyArray<{ x: number; y: number; z: number }> };

export interface TaskRuntimeDeps {
  perception: {
    take(goalEpoch: number): ObservationSnapshot | null;
    resolve(snapshotId: string, handle: string): { target: ResolvedTarget } | { error: string };
  };
  candidates: CandidateGenerator;
  executor: SkillExecutor;
  predicates: PredicateEvaluator;
  decision: DecisionPort;
  sustained(capability: string): SustainPolicy | undefined;
  catalogVersion(): string;
  mechanicsVersion: string;
  connectionEpoch(): number;
  /** Remaining Jev attempts for a goal (for the model-visible context). */
  decisionsRemaining?(goalId: string): number;
  spendRemainingUsd?(): number | null;
  model: string;
  store: RunStore;
  clock: Clock;
  ids: IdSource;
  limits: {
    maxOptions: number;
    noProgressMs: number;
    perTargetRetries: number;
    lowHealth: number;
    maxRequestBytes?: number;
    /** Hard safety cap on rounds per task (deadlines normally end work first). */
    maxRounds?: number;
  };
  /** Operator-visible controller events (terminal `[task-json]` lines). */
  emit?(kind: string, data: Record<string, unknown>): void;
  /** Abortable guard sleep (injectable for tests). */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Local re-observation interval while a maintained condition holds (default 1000 ms; never an inference trigger). */
  holdGuardMs?: number;
  /**
   * MB-FLOW-003 narrow low-health allowance (survival-issued grant bound to the
   * goal/epoch/connection/dimension, fresh safe food or rest, expiry and an
   * action count). Absent or refused: the guard blocks as before. Never a
   * threshold change and never planner-granted.
   */
  lowHealthAllowance?: LowHealthAllowancePort;
  /**
   * MB-FLOW-003-C11/C13 shared seam: the consumer subset of the immediate-safety
   * port (W's SafetyPort hold/waitClear; local, inference-free). While a hold is
   * active no ordinary candidate is dispatched: the task waits (bounded) without
   * inference, keeps its goal ownership/outcome/limits, and continues from a
   * FRESH observation when clear; a declared safety blocker ends the task
   * `blocked/safety_blocked` (one declarative blocker, no retry loop).
   */
  safety?: TaskSafetyGate;
  /** Code-owned client motion receipts: only the stall guard, never completion or effect credit. */
  motionProgress?: TaskMotionProgressPort;
}

/** Consumer subset of the reviewed immediate-safety contract (src/contracts/safety.ts SafetyPort). */
export type TaskSafetyGate = Pick<SafetyPort, 'hold' | 'waitClear'>;

/** Bound on one safety wait before ownership/currentness is re-checked. */
const SAFETY_WAIT_SLICE_MS = 30_000;

function guardSleep(ms: number, signal: AbortSignal): Promise<void> {
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

class Revoked extends Error {}

/** A candidate inside a low-health allowance: its capability is granted and any `item` parameter is a granted item (none granted: no item may be used). */
function withinAllowance(c: ActionCandidate, capabilities: readonly string[], items: readonly string[]): boolean {
  if (!capabilities.includes(c.capability)) return false;
  const item = (c.parameters as Record<string, unknown>)['item'];
  return typeof item !== 'string' || items.includes(item);
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function canonical(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/** Numeric progress facts in an evaluation tree (acquired/current/confirmed/count/satisfied). */
function progressFacts(e: PredicateEvaluation | null, out: number[] = []): number[] {
  if (!e) return out;
  out.push(e.status === 'satisfied' ? 1 : 0);
  for (const k of ['acquired', 'current', 'confirmed', 'count', 'satisfied']) {
    const v = e.evidence[k];
    out.push(typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN);
  }
  const distance = e.evidence['distance'];
  out.push(typeof distance === 'number' && Number.isFinite(distance) ? -distance : Number.NaN);
  for (const c of e.children ?? []) progressFacts(c, out);
  return out;
}

function improved(prev: PredicateEvaluation | null, cur: PredicateEvaluation): boolean {
  const a = progressFacts(prev);
  const b = progressFacts(cur);
  if (a.length !== b.length) return cur.status === 'satisfied';
  return b.some((v, i) => Number.isFinite(v) && Number.isFinite(a[i] as number) && v > (a[i] as number));
}

export class TaskRuntime implements TaskExecutionPort {
  private readonly deps: TaskRuntimeDeps;

  constructor(deps: TaskRuntimeDeps) {
    this.deps = deps;
  }

  readiness(): Readiness {
    const d = this.deps.decision.readiness();
    const e = this.deps.executor.readiness();
    return { ready: d.ready && e.ready, detail: `generic task runtime; decision: ${d.detail}; executor: ${e.detail}` };
  }

  /** World identity of a handle reference (block position / entity id), for equivalence and per-target retries. */
  private identity(params: unknown): unknown {
    if (Array.isArray(params)) return params.map((p) => this.identity(p));
    if (!params || typeof params !== 'object') return params;
    const o = params as Record<string, unknown>;
    if (typeof o['snapshotId'] === 'string' && typeof o['handle'] === 'string') {
      const r = this.deps.perception.resolve(o['snapshotId'], o['handle']);
      if ('error' in r) return `stale:${o['handle']}`;
      const t = r.target;
      const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'snapshotId' && k !== 'handle').map(([k, v]) => [k, this.identity(v)]));
      const id =
        t.kind === 'block'
          ? `block:${t.x},${t.y},${t.z}`
          : t.kind === 'frontier'
            ? `frontier:${Math.round(t.at.x)},${Math.round(t.at.y)},${Math.round(t.at.z)}`
            : t.kind === 'group'
              ? `group:${t.class}:${t.members.map((m) => `${m.x},${m.y},${m.z}`).sort()[0] ?? ''}`
              : `entity:${t.entityId}`;
      return { ...rest, target: id };
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, this.identity(v)]));
  }

  private key(c: ActionCandidate): string {
    return `${c.capability}|${canonical(this.identity(c.parameters))}`;
  }

  /** Bounded option selection: identical options merged, then round-robin over capabilities in task order, resolver order within each. */
  private select(cands: readonly ActionCandidate[], max: number): ActionCandidate[] {
    const groups = new Map<string, ActionCandidate[]>();
    const seen = new Set<string>();
    for (const c of cands) {
      const k = this.key(c);
      if (seen.has(k)) continue;
      seen.add(k);
      groups.set(c.capability, [...(groups.get(c.capability) ?? []), c]);
    }
    const out: ActionCandidate[] = [];
    while (out.length < max && [...groups.values()].some((g) => g.length > 0)) {
      for (const g of groups.values()) {
        const c = g.shift();
        if (c && out.length < max) out.push(c);
      }
    }
    return out;
  }

  async run(task: AdmittedTask): Promise<TaskResult> {
    const { deps } = this;
    const { clock, store } = deps;
    const startedAt = clock.now();
    const recent: TaskOutcomeSummary[] = [];
    const failures = new Map<string, number>();
    const succeeded = new Set<string>();
    /** Successes of an already-succeeded option without any verified progress since (reset on progress). */
    const unproductive = new Map<string, number>();
    let lastUnavailable: CandidateSet['unavailable'] = [];
    let completion: PredicateEvaluation | null = null;
    let lastProgressAt = startedAt;
    let rounds = 0;
    let decisions = 0;
    let actions = 0;
    let localContinuations = 0;
    let holding = false;
    let allowanceAnnounced = false;
    let sustain: { candidate: ActionCandidate; jevActionId: string } | undefined;
    const emit = (kind: string, data: Record<string, unknown>) => {
      store.record({ type: kind, taskId: task.taskId, goalId: task.goalId, goalEpoch: task.goalEpoch, ...data });
      deps.emit?.(kind, { taskId: task.taskId, goalId: task.goalId, ...data });
    };
    const assertCurrent = () => {
      if (!task.isCurrent() || task.signal.aborted) throw new Revoked();
    };
    const executeOwned = async (candidate: ActionCandidate, source: 'jev' | 'local_continuation', requestId?: string) => {
      const unwatch = deps.motionProgress?.watch(task, candidate, (receipt) => {
        if (!task.isCurrent() || task.signal.aborted || candidate.connectionEpoch !== deps.connectionEpoch() || deps.safety?.hold()) return;
        if (receipt.provenance !== 'client_only' || !Number.isFinite(receipt.atMs) || !Number.isFinite(receipt.netProgress) || receipt.atMs <= lastProgressAt || receipt.atMs > clock.now()) return;
        lastProgressAt = receipt.atMs; // actual useful sample time, never the end of a window
        unproductive.clear();
        emit('task_motion_progress', { actionId: candidate.id, capability: candidate.capability, sampledAtMs: receipt.atMs, netProgress: Math.round(receipt.netProgress * 10) / 10, provenance: receipt.provenance });
      });
      try { return await this.execute(task, candidate, source, recent, emit, requestId); }
      finally { unwatch?.(); }
    };
    const exhausted = () => [...failures.entries()].filter(([, n]) => n > deps.limits.perTargetRetries).map(([k]) => clip(k, 160));
    const finish = (status: TaskResultStatus, reason: string, detail: string): TaskResult => {
      const feedback: TaskFeedback = {
        taskId: task.taskId,
        objective: clip(task.spec.objective, 300),
        status,
        reason,
        detail: clip(detail, 600),
        unavailable: lastUnavailable.slice(0, 16).map((u) => ({ capability: u.capability, reason: u.reason, detail: u.detail, evidence: u.evidence as Record<string, unknown> })),
        recentOutcomes: recent.slice(-6),
        exhaustedTargets: exhausted().slice(0, 8),
        completion: completion ? { status: completion.status, detail: clip(completion.detail, 300) } : null,
      };
      const result: TaskResult = { taskId: task.taskId, status, reason, detail: clip(detail, 600), rounds, decisions, actions, localContinuations, feedback };
      emit('task_terminal', { status, reason, detail: result.detail, rounds, decisions, actions, localContinuations, elapsedMs: clock.now() - startedAt, feedback: feedback as unknown as JsonValue });
      return result;
    };

    // Terminal-visible: app-owned step label, never the planner's prose objective (MB-PLAN-006).
    emit('task_started', { mode: task.mode, step: publicTaskLabel(task.spec), allowedCapabilities: task.spec.allowedCapabilities, completion: describePredicate(task.spec.completion) });
    try {
      assertCurrent();
      // Task-admission baselines (acquisition deltas are measured from here).
      const bound: BoundPredicate = await deps.predicates.bind(task.spec.completion, task.signal, undefined, { goalId: task.goalId, goalEpoch: task.goalEpoch });
      assertCurrent();
      emit('task_baseline', { baselines: bound.baselines, boundAtMs: bound.boundAtMs });
      const maxRounds = deps.limits.maxRounds ?? 2_000;
      while (true) {
        assertCurrent();
        if (rounds >= maxRounds) return finish('blocked', 'round_limit', `task used ${maxRounds} rounds without verified completion`);
        // MB-FLOW-003-C11/C13: no ordinary dispatch while immediate safety holds control.
        if (deps.safety?.hold()) {
          const waited = await this.awaitSafety(task, emit, rounds);
          if (waited.kind === 'blocked') return finish('blocked', 'safety_blocked', waited.detail);
          lastProgressAt += waited.waitedMs; // the stall guard pauses while safety owned control
          sustain = undefined; // a preempted sustained action is re-chosen from fresh state
          continue;
        }
        rounds += 1;
        // 1. Current filtered observation FIRST, so selector-based predicates see current visibility.
        const completionSnapshot = deps.perception.take(task.goalEpoch);
        assertCurrent();
        if (!completionSnapshot) return finish('failed', 'not_connected', 'no observation: the game connection is not ready');
        if (completionSnapshot.connectionEpoch !== deps.connectionEpoch()) throw new Revoked();
        // 2. Verified completion, evaluated by code between actions.
        const evaluation = await deps.predicates.evaluate(bound, task.signal);
        assertCurrent();
        if (completionSnapshot.connectionEpoch !== deps.connectionEpoch()) throw new Revoked();
        if (improved(completion, evaluation)) {
          lastProgressAt = clock.now();
          unproductive.clear();
        }
        completion = evaluation;
        emit('task_completion', { round: rounds, status: evaluation.status, detail: clip(evaluation.detail, 300), evidence: evaluation.evidence as Record<string, JsonValue> });
        if (task.mode === 'complete' && evaluation.status === 'satisfied') return finish('completed', 'completion_verified', evaluation.detail);
        if (task.mode === 'maintain' && evaluation.status === 'satisfied') lastProgressAt = clock.now();
        // Server-backed predicate evaluation may await a resync. Freeze guard,
        // candidate and model state AFTER that await; never adopt a replacement
        // connection or give the predicate's older visibility dispatch authority.
        const snapshot = deps.perception.take(task.goalEpoch);
        assertCurrent();
        if (!snapshot) return finish('failed', 'not_connected', 'no observation: the game connection is not ready');
        if (snapshot.connectionEpoch !== completionSnapshot.connectionEpoch || snapshot.connectionEpoch !== deps.connectionEpoch()) throw new Revoked();
        if (deps.safety?.hold()) continue; // a hold that began during evaluation waits at the existing loop-top gate
        // 3. Guards: no meaningful progress on the unmet outcome within the window; low health.
        if (clock.now() - lastProgressAt > deps.limits.noProgressMs) {
          return finish('blocked', 'no_progress', `no outcome or owned-motion progress for ${Math.round((clock.now() - lastProgressAt) / 1000)}s (window ${Math.round(deps.limits.noProgressMs / 1000)}s); last completion check: ${evaluation.detail}`);
        }
        // MB-FLOW-003 narrow allowance: at the guard, only a survival-issued grant for THIS goal
        // epoch lets the round continue, and then only with its capabilities/items.
        const allowance = this.lowHealthCheck(task, snapshot);
        if (allowance && !allowance.allowed) {
          return finish('blocked', 'low_health', `health ${snapshot.self.health} is at or below the interruption threshold ${deps.limits.lowHealth}${allowance.reason === 'no_port' ? '' : ` (low-health allowance refused: ${allowance.reason}: ${allowance.detail})`}`);
        }
        if (allowance?.allowed && !allowanceAnnounced) {
          allowanceAnnounced = true;
          emit('task_low_health_allowance', { round: rounds, health: snapshot.self.health, threshold: deps.limits.lowHealth, allowanceId: allowance.allowanceId, capabilities: [...allowance.capabilities], items: [...allowance.items], detail: allowance.detail });
        }
        // 4. Candidates from the registered resolvers of the allowed capabilities.
        const generated = deps.candidates.generate(task.spec, snapshot, task.destructiveScope, task.requiresOwnerDirection);
        const set = allowance?.allowed ? { ...generated, candidates: generated.candidates.filter((c) => withinAllowance(c, allowance.capabilities, allowance.items)) } : generated;
        lastUnavailable = set.unavailable;
        const excludedFailing = (c: ActionCandidate) => (failures.get(this.key(c)) ?? 0) > deps.limits.perTargetRetries;
        const excludedRepeating = (c: ActionCandidate) => (unproductive.get(this.key(c)) ?? 0) > deps.limits.perTargetRetries;
        const usable = set.candidates.filter((c) => !excludedFailing(c) && !excludedRepeating(c));

        // 4a. Maintained condition already holds and nothing sustained is running: hold
        // locally on a guard timer (re-observe; no inference) until it is violated.
        if (task.mode === 'maintain' && evaluation.status === 'satisfied' && !sustain) {
          if (!holding) emit('task_holding', { round: rounds, detail: clip(evaluation.detail, 200) });
          holding = true;
          rounds -= 1; // holding is not a decision round
          await (deps.sleep ?? guardSleep)(deps.holdGuardMs ?? 1_000, task.signal);
          continue;
        }
        holding = false;
        // 4b. Healthy sustained action: continue locally (no inference) while an equivalent option exists.
        if (sustain) {
          const want = this.key(sustain.candidate);
          const next = usable.find((c) => this.key(c) === want);
          if (next) {
            if (deps.safety?.hold()) continue; // safety took control after observing: wait at the loop top
            // MB-FLOW-003-C2: a local continuation is a dispatch too — same allowance recheck/accounting as a Jev choice.
            const gate = this.allowanceGate(task, next, snapshot);
            if (!gate.ok) return finish('blocked', 'low_health', gate.detail);
            localContinuations += 1;
            emit('task_local_continuation', { round: rounds, actionId: next.id, capability: next.capability, continues: sustain.jevActionId, snapshotId: snapshot.id });
            const outcome = await this.dispatchCounted(task, next, gate.allowanceId, () => executeOwned(next, 'local_continuation'));
            actions += 1;
            sustain = this.afterOutcome(task, next, outcome, failures, succeeded, unproductive, sustain.jevActionId, () => (lastProgressAt = clock.now()));
            continue;
          }
          emit('task_sustain_ended', { round: rounds, capability: sustain.candidate.capability, reason: 'no equivalent grounded option in the current observation' });
          sustain = undefined;
        }

        if (usable.length === 0) {
          if (set.candidates.length > 0 && set.candidates.every(excludedFailing)) return finish('blocked', 'per_target_retries_exhausted', `all ${set.candidates.length} grounded option(s) failed more than ${deps.limits.perTargetRetries} retries`);
          if (set.candidates.length > 0) return finish('blocked', 'repeated_without_progress', `the remaining ${set.candidates.length} grounded option(s) were already repeated without verified progress (or failed); last completion check: ${evaluation.detail}`);
          const why = set.unavailable.slice(0, 4).map((u) => `${u.capability}: ${u.reason}`).join('; ');
          return finish('blocked', 'no_candidates', `no allowed capability has a grounded option now${why ? ` (${why})` : ''}`);
        }

        // 4c. Freeze a bounded option set and its epochs; ask Jev for one ID.
        const offered = this.select(usable, deps.limits.maxOptions);
        const requestId = deps.ids.next('req');
        const request = this.fitRequest(task, snapshot, offered, requestId, evaluation, recent, rounds, set.unavailable);
        emit('task_round', {
          round: rounds,
          requestId,
          snapshotId: snapshot.id,
          snapshotTakenAtMs: snapshot.takenAtMs,
          snapshotGoalEpoch: snapshot.goalEpoch,
          connectionEpoch: snapshot.connectionEpoch,
          generated: set.candidates.length,
          offered: offered.map((c) => ({ id: c.id, capability: c.capability, description: clip(c.description, 120) })),
          excludedByRetries: set.candidates.length - usable.length,
          unavailable: set.unavailable.slice(0, 8).map((u) => `${u.capability}:${u.reason}`),
          truncated: set.truncated || usable.length > offered.length,
        });
        let choice: DecisionChoice;
        try {
          decisions += 1;
          choice = await deps.decision.choose(request, task.signal);
        } catch (error) {
          if (!task.isCurrent() || task.signal.aborted) throw new Revoked();
          if (isDecisionError(error)) {
            const f = error.failure;
            emit('task_decision_failed', { round: rounds, requestId, kind: f.kind, detail: f.detail, attempts: f.attempts, httpStatus: f.httpStatus ?? null });
            if (f.kind === 'aborted') throw new Revoked();
            if (NOT_READY_KINDS.has(f.kind)) return finish('blocked', 'decision_not_ready', `${f.kind}: ${f.detail}`);
            if (LIMIT_KINDS.has(f.kind)) return finish('blocked', 'decision_limit', `${f.kind}: ${f.detail}`);
            return finish('failed', 'decision_error', `${f.kind}: ${f.detail}`);
          }
          throw error;
        }
        // A late reply for a revoked task/goal/connection can never actuate.
        if (!task.isCurrent() || task.signal.aborted || snapshot.connectionEpoch !== deps.connectionEpoch()) {
          store.record({ type: 'task_reply_discarded', taskId: task.taskId, requestId, candidateId: choice.candidateId, reason: 'ownership changed while the decision was in flight' });
          throw new Revoked();
        }
        const chosen = offered.find((c) => c.id === choice.candidateId);
        emit('task_choice', {
          round: rounds,
          requestId,
          candidateId: choice.candidateId,
          capability: chosen?.capability ?? null,
          description: chosen ? clip(chosen.description, 160) : null,
          model: choice.model,
          provider: choice.provider,
          confidence: choice.confidence,
          probabilities: choice.probabilities,
          costUsd: choice.usage.costUsd,
          inputTokens: choice.usage.inputTokens,
          latencyMs: choice.latencyMs,
          attempts: choice.attempts,
        });
        if (!chosen || chosen.goalEpoch !== task.goalEpoch || chosen.connectionEpoch !== snapshot.connectionEpoch) {
          emit('task_choice_rejected', { round: rounds, requestId, candidateId: choice.candidateId, reason: 'choice is not an offered candidate of this frozen round' });
          continue;
        }
        // A hazard (before any allowance reservation) that began while Jev was deciding wins: nothing is dispatched; the loop waits and re-observes.
        if (deps.safety?.hold()) {
          emit('task_choice_deferred', { round: rounds, requestId, candidateId: chosen.id, reason: 'immediate_safety_hold' });
          continue;
        }
        // 5. Revalidate against the CURRENT world through the same resolvers.
        const fresh = deps.perception.take(task.goalEpoch);
        if (!fresh || fresh.connectionEpoch !== chosen.connectionEpoch) throw new Revoked();
        // The allowance is re-checked (canonical recheck) against the FRESH snapshot after the Jev await, before dispatch.
        const gate = this.allowanceGate(task, chosen, fresh);
        if (!gate.ok) return finish('blocked', 'low_health', gate.detail);
        const regen = deps.candidates.generate(task.spec, fresh, task.destructiveScope, task.requiresOwnerDirection);
        const want = this.key(chosen);
        if (!regen.candidates.some((c) => this.key(c) === want)) {
          const why = regen.unavailable.filter((u) => u.capability === chosen.capability).slice(0, 3);
          lastUnavailable = regen.unavailable;
          emit('task_choice_stale', { round: rounds, requestId, candidateId: chosen.id, capability: chosen.capability, freshSnapshotId: fresh.id, reasons: why.map((u) => `${u.reason}: ${u.detail}`) });
          continue; // regenerate next round; nothing was executed
        }
        // 6. Execute the frozen candidate under the single actuator lease.
        const outcome = await this.dispatchCounted(task, chosen, gate.allowanceId, () => executeOwned(chosen, 'jev', requestId));
        actions += 1;
        sustain = this.afterOutcome(task, chosen, outcome, failures, succeeded, unproductive, chosen.id, () => (lastProgressAt = clock.now()));
      }
    } catch (error) {
      if (error instanceof Revoked || !task.isCurrent() || task.signal.aborted) return finish('cancelled', 'ownership_revoked', 'the owning goal was stopped, replaced or ended; no further action');
      const message = error instanceof Error ? error.message : String(error);
      return finish('failed', 'runtime_error', message);
    }
  }

  /**
   * Waits out an immediate-safety hold (no inference, no dispatch). Returns the
   * time spent so the caller can pause its no-progress guard for it (limits and
   * the goal deadline keep running), or a declared blocker. Revoked ownership
   * throws.
   */
  private async awaitSafety(task: AdmittedTask, emit: (k: string, d: Record<string, unknown>) => void, round: number): Promise<{ kind: 'clear'; waitedMs: number } | { kind: 'blocked'; detail: string }> {
    const gate = this.deps.safety;
    const first = gate?.hold();
    if (!gate || !first) return { kind: 'clear', waitedMs: 0 };
    emit('task_safety_hold', { round, reason: first.reason, episodeId: first.episodeId, detail: clip(first.detail, 200) });
    let waited = 0;
    while (true) {
      if (!task.isCurrent() || task.signal.aborted) throw new Revoked();
      const r = await gate.waitClear(task.signal, SAFETY_WAIT_SLICE_MS);
      waited += r.waitedMs;
      if (!task.isCurrent() || task.signal.aborted) throw new Revoked();
      if (r.status === 'blocked') {
        emit('task_safety_blocked', { round, waitedMs: waited, reason: r.reason, detail: clip(r.detail, 200), hazards: r.hazards });
        return { kind: 'blocked', detail: `immediate safety has no supported response (${r.reason}): ${clip(r.detail, 200)}` };
      }
      if (r.status === 'clear' || (r.status !== 'timeout' && !gate.hold())) {
        emit('task_safety_clear', { round, waitedMs: waited });
        return { kind: 'clear', waitedMs: waited };
      }
      if (r.status === 'aborted' && gate.hold()) {
        // Safety authority ended while still held (e.g. explicit stop): the owning goal is revoked by the stop path.
        throw new Revoked();
      }
    }
  }

  private allowanceRef(task: AdmittedTask, snapshot: ObservationSnapshot): { goalId: string; goalEpoch: number; taskId: string; connectionEpoch: number; allowedCapabilities: readonly string[] } {
    return { goalId: task.goalId, goalEpoch: task.goalEpoch, taskId: task.taskId, connectionEpoch: snapshot.connectionEpoch, allowedCapabilities: task.spec.allowedCapabilities };
  }

  /**
   * MB-FLOW-003-C2 dispatch gate for ONE chosen/continued candidate. Above the
   * guard nothing changes. At/below it, survival's canonical `check` then
   * `recheck` (fresh task/goal/connection/dimension/health/food/threat/item
   * authority on THIS snapshot) must both allow this exact candidate.
   */
  private allowanceGate(task: AdmittedTask, candidate: ActionCandidate, snapshot: ObservationSnapshot): { ok: true; allowanceId?: string } | { ok: false; detail: string } {
    const { deps } = this;
    if (!(snapshot.self.health > 0 && snapshot.self.health <= deps.limits.lowHealth)) return { ok: true };
    const base = this.lowHealthCheck(task, snapshot);
    const refused = (why: string) => ({ ok: false as const, detail: `health ${snapshot.self.health} is at or below the interruption threshold ${deps.limits.lowHealth} at dispatch; ${why}` });
    if (!base || !base.allowed) return refused(base ? `allowance refused: ${base.reason}: ${base.detail}` : 'no allowance');
    if (!withinAllowance(candidate, base.capabilities, base.items)) return refused(`${candidate.capability} is outside the low-health allowance`);
    const port = deps.lowHealthAllowance;
    if (!port) return refused('no allowance port');
    try {
      const ref = this.allowanceRef(task, snapshot);
      const cand = { id: candidate.id, capability: candidate.capability, parameters: candidate.parameters as Readonly<Record<string, unknown>> };
      const r = port.recheck(base.allowanceId, ref, cand, snapshot);
      if (!r.allowed) return refused(`allowance recheck refused: ${r.reason}: ${r.detail}`);
      if (!withinAllowance(candidate, r.capabilities, r.items)) return refused(`${candidate.capability} is outside the rechecked allowance`);
      // S311 canonical accounting: reserve immediately before the dispatch; it counts BEFORE execution.
      const reserved = port.reserve(r.allowanceId, ref, cand, snapshot);
      if (!reserved.allowed) return refused(`allowance reserve refused: ${reserved.reason}: ${reserved.detail}`);
      if (!withinAllowance(candidate, reserved.capabilities, reserved.items)) return refused(`${candidate.capability} is outside the reserved allowance`);
      return { ok: true, allowanceId: reserved.allowanceId };
    } catch (error) {
      return refused(`allowance recheck failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Executes under a RESERVED allowance; `consumed` in `finally` is the idempotent outcome note (cancellation/exception included). */
  private async dispatchCounted(task: AdmittedTask, candidate: ActionCandidate, allowanceId: string | undefined, run: () => Promise<SkillOutcome>): Promise<SkillOutcome> {
    if (!allowanceId) return run();
    let status = 'dispatch_interrupted';
    try {
      const outcome = await run();
      status = outcome.status;
      return outcome;
    } finally {
      try {
        this.deps.lowHealthAllowance?.consumed(allowanceId, { actionId: candidate.id, capability: candidate.capability, status });
      } catch (error) {
        this.deps.store.record({ type: 'low_health_allowance_error', taskId: task.taskId, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Low-health guard decision: undefined when health is above the guard;
   * otherwise the survival allowance check for THIS goal epoch/task (or a
   * refusal when no allowance port is installed).
   */
  private lowHealthCheck(task: AdmittedTask, snapshot: ObservationSnapshot): ({ allowed: true; allowanceId: string; capabilities: readonly string[]; items: readonly string[]; detail: string } | { allowed: false; reason: string; detail: string }) | undefined {
    const { deps } = this;
    if (!(snapshot.self.health > 0 && snapshot.self.health <= deps.limits.lowHealth)) return undefined;
    const port = deps.lowHealthAllowance;
    if (!port) return { allowed: false, reason: 'no_port', detail: 'no low-health allowance is installed' };
    try {
      const r = port.check(this.allowanceRef(task, snapshot), snapshot);
      if (!r.allowed) return r;
      // Only capabilities this task itself allows; the allowance never widens the task.
      const capabilities = r.capabilities.filter((c) => task.spec.allowedCapabilities.includes(c));
      return capabilities.length > 0 ? { ...r, capabilities } : { allowed: false, reason: 'no_allowed_capability', detail: 'none of the allowance capabilities is allowed in this task' };
    } catch (error) {
      return { allowed: false, reason: 'allowance_error', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private fitRequest(task: AdmittedTask, snapshot: ObservationSnapshot, offered: ActionCandidate[], requestId: string, completion: PredicateEvaluation, recent: TaskOutcomeSummary[], round: number, unavailable: CandidateSet['unavailable']): DecisionRequest {
    const { deps } = this;
    const max = deps.limits.maxRequestBytes ?? MAX_REQUEST_BYTES;
    let request: DecisionRequest | undefined;
    for (const level of [0, 1, 2] as const) {
      const state = buildState(
        {
          spec: task.spec,
          mode: task.mode,
          snapshot,
          catalogVersion: deps.catalogVersion(),
          mechanicsVersion: deps.mechanicsVersion,
          completion,
          recentOutcomes: recent,
          unavailable,
          remaining: { decisions: deps.decisionsRemaining?.(task.goalId) ?? -1, spendUsd: deps.spendRemainingUsd?.() ?? null },
          round,
        },
        level,
      );
      request = {
        requestId,
        goalId: task.goalId,
        goalEpoch: task.goalEpoch,
        taskId: task.taskId,
        connectionEpoch: snapshot.connectionEpoch,
        snapshotId: snapshot.id,
        objective: task.spec.objective,
        instruction: task.spec.decisionInstruction,
        condition: describePredicate(task.spec.completion),
        mode: task.mode,
        state,
        candidates: offered,
      };
      if (requestBytes(deps.model, request) <= max) return request;
    }
    return request as DecisionRequest; // the adapter refuses it as request_too_large
  }

  private async execute(task: AdmittedTask, c: ActionCandidate, via: TaskOutcomeSummary['via'], recent: TaskOutcomeSummary[], emit: (k: string, d: Record<string, unknown>) => void, requestId?: string): Promise<SkillOutcome> {
    const owner = { kind: 'goal' as const, goalEpoch: task.goalEpoch, goalId: task.goalId, taskId: task.taskId, ...(task.destructiveScope !== undefined ? { destructiveScope: task.destructiveScope } : {}), ...(task.requiresOwnerDirection ? { requiresOwnerDirection: true } : {}) };
    const outcome = await this.deps.executor.execute(c, task.signal, owner);
    // Outcome identity: only the dispatched action, owned by this goal/task/epochs, can advance anything.
    const matches =
      outcome.actionId === c.id &&
      outcome.owner === 'goal' &&
      outcome.goalId === task.goalId &&
      outcome.taskId === task.taskId &&
      outcome.goalEpoch === task.goalEpoch &&
      outcome.connectionEpoch === c.connectionEpoch &&
      (outcome.capability === undefined || outcome.capability === c.capability);
    if (!matches) {
      emit('task_outcome_rejected', { actionId: c.id, reportedActionId: outcome.actionId, owner: outcome.owner, reason: 'outcome does not match the dispatched action/goal/task/epochs; it cannot advance the task' });
      throw new Error(`skill outcome identity mismatch for ${c.id}`);
    }
    if (!task.isCurrent() || task.signal.aborted) throw new Revoked();
    const summary: TaskOutcomeSummary = {
      actionId: c.id,
      capability: c.capability,
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      confirmation: outcome.confirmation,
      effect: clip(outcome.effect, 200),
      via,
    };
    recent.push(summary);
    if (recent.length > 12) recent.shift();
    emit('task_action', { ...summary, requestId: requestId ?? null, elapsedMs: outcome.elapsedMs, evidence: outcome.evidence as Record<string, JsonValue> });
    return outcome;
  }

  /** Progress, per-target failures and sustained continuation after one verified outcome. */
  private afterOutcome(task: AdmittedTask, c: ActionCandidate, outcome: SkillOutcome, failures: Map<string, number>, succeeded: Set<string>, unproductive: Map<string, number>, jevActionId: string, progressed: () => void): { candidate: ActionCandidate; jevActionId: string } | undefined {
    void task;
    const key = this.key(c);
    const policy = this.deps.sustained(c.capability);
    const windowElapsed = Boolean(policy && policy.windowElapsed(outcome) && outcome.elapsedMs >= 500);
    if (outcome.status === 'failed' || outcome.status === 'precondition_failed') failures.set(key, (failures.get(key) ?? 0) + 1);
    // Repeating an option that already succeeded, with no verified progress since, is bounded like a failing target.
    if (outcome.status === 'succeeded' && succeeded.has(key) && !windowElapsed) unproductive.set(key, (unproductive.get(key) ?? 0) + 1);
    // A NEW evidenced success (server packet/sync, or observed client-side movement to a new
    // target) is meaningful progress; repeating the same success, or a claim-free result, is not.
    if (outcome.status === 'succeeded' && outcome.confirmation !== 'none' && !succeeded.has(key)) {
      succeeded.add(key);
      progressed();
    }
    if (windowElapsed) {
      // Elapsed time is not progress on an unmet predicate. The loop records
      // actual improvements and protects a satisfied maintained condition;
      // stagnant finite or violated persistent work still has a stall bound.
      return { candidate: c, jevActionId };
    }
    return undefined;
  }
}
