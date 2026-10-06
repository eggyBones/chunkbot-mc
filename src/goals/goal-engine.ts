// Goal engine: one owner, one active goal. Every natural-language instruction
// enters through `submit` — there is no intent table, keyword gate, or
// resource-specific handler. The engine owns lifecycle, epochs,
// replacement/stop ordering, correlated clarification, and the ROLLING
// planner/task-window loop (MB-V1-04):
//
//   admission (epoch, travel anchor, server-confirmed ALL-item inventory
//   baseline) -> planner turn (fresh bounded context) -> forbidden/schema/
//   reference/semantic validation (rejected proposals cause no action; bounded
//   repair turns) -> knowledge rounds / one correlated clarification / exact
//   cannot-execute / plan -> the first accepted outcome is bound to the
//   ADMISSION baseline and is immutable -> the window's tasks run in order
//   through the generic task runtime -> code evaluates the accepted outcome ->
//   satisfied: completed; otherwise a replan turn with verified feedback.
//
// Every planner turn kind (initial, knowledge continuation, repair, retry,
// clarification continuation, replan) counts toward the goal's turn limit;
// counters, baselines and the outcome survive windows, knowledge rounds,
// clarification and replans. A finished task or window never completes a goal.
import {
  BOUNDS,
  TaskSpecSchema,
  type AdmissionInventory,
  type GoalCounters,
  type InventoryBaseline,
  type ObservationSnapshot,
  type OwnerCoordinate,
  type PlannerFailure,
  type PlannerRequest,
  type PriorResultRef,
  type RegistryFacts,
  type EvidenceEvent,
  isActiveGoalState,
  isPredicateWithinDepth,
  type GoalKind,
  type GoalOutcomeContract,
  type BoundPredicate,
  type PredicateEvaluator,
  type TaskExecutionPort,
  type TaskFeedback,
  type TaskMode,
  type TaskResult,
  type TaskSpec,
  type CapabilityRegistry,
  type ClarificationExchange,
  type ClarificationRequest,
  type Clock,
  type GoalRecord,
  type GoalState,
  type IdSource,
  type IntakeOrigin,
  type KnowledgePort,
  type KnowledgeResult,
  type ObservationPort,
  type PlannerPort,
  type Readiness,
  type RunStore,
  type SkillExecutor,
  type TerminalGoalState,
  type TerminalReasonCode,
} from '../contracts/index.ts';
import { checkProposal, type ShownSnapshot } from './proposal.ts';
import { ownerCoordinates } from './owner-coordinates.ts';

export interface GoalEngineLimits {
  maxInstructionChars: number;
  plannerTurnsPerGoal: number;
  plannerTimeoutMs: number;
  planWindowSteps: number;
  totalTaskCeiling: number;
  goalDeadlineMs: number;
  cleanupTimeoutMs: number;
  /** Replan turns after executed windows (default 8; counted within the turn limit). */
  replans?: number;
  /** Consecutive rejected proposals answered with a repair turn before blocking (default 2). */
  maxConsecutiveRepairs?: number;
  /** Consecutive transport failures (timeout/process error) retried once each (default 1). */
  maxConsecutiveRetries?: number;
  /** Planner-visible facts (read-only). */
  travelRadius?: number;
  observationRadius?: number;
}

export interface OwnerNotice {
  text: string;
  goalId?: string;
  /** `operator`: terminal only (operator task diagnostics); default also replies in game. */
  audience?: 'operator' | 'all';
}

export interface GoalEngineDeps {
  planner: PlannerPort;
  knowledge: KnowledgePort;
  observation: ObservationPort;
  capabilities: CapabilityRegistry;
  executor: SkillExecutor;
  store: RunStore;
  clock: Clock;
  ids: IdSource;
  limits: GoalEngineLimits;
  /** Owner/operator-facing notices (terminal and in-game reply). */
  notify: (notice: OwnerNotice) => void;
  /** Goals require a ready game connection. */
  isGameReady: () => boolean;
  /**
   * Admission ownership hook: called synchronously once a valid instruction has
   * replaced any old goal and the new goal epoch is current, BEFORE planning.
   * Execution adapters capture admission-bound state here (e.g. the goal's
   * travel anchor). Must not throw; failures are recorded, not fatal.
   */
  onGoalAdmitted?: (admission: { goalId: string; epoch: number; admittedAtMs: number }) => void;
  /**
   * Generic task runtime (MB-V1-03). When installed, accepted plan windows and
   * operator task diagnostics execute through it; otherwise plans end
   * `capability_not_ready` as in the foundation.
   */
  tasks?: TaskExecutionPort;
  /** Code-owned evaluator for goal-level outcome contracts (plan seam). */
  outcomes?: PredicateEvaluator;
  /** Version registry facts for proposal reference validation (items, blocks, tags, recipes). */
  registry?: RegistryFacts;
  /** Verifies prior skill results (e.g. placed workstations) by action id against the evidence ledger. */
  priorResults?: (actionIds: readonly string[]) => PriorResultRef[];
  /** Bounded planner journal: interpretations, proposals/revisions, questions/answers, final predicate evidence. */
  journal?: { record(event: EvidenceEvent): void };
  /** Exact mechanics version shown to the planner. */
  mechanicsVersion?: string;
}

export type SubmitRejection = 'empty' | 'too_long' | 'not_connected' | 'shutting_down' | 'invalid_task' | 'tasks_not_installed';

export type SubmitResult =
  | { status: 'admitted'; goal: GoalRecord; replacedGoalId?: string }
  | { status: 'rejected'; reason: SubmitRejection; detail: string }
  /** A later stop or instruction arrived while this one awaited cleanup. */
  | { status: 'superseded' };

export type AnswerResult =
  | { status: 'accepted'; goalId: string; ref: string }
  | { status: 'rejected'; reason: 'no_pending_clarification' | 'stale_reference' | 'empty' | 'too_long'; detail: string };

export interface EngineStatus {
  goal: GoalRecord | undefined;
  readiness: {
    planner: Readiness;
    knowledge: Readiness;
    observation: Readiness;
    executor: Readiness;
    capabilityCount: number;
    catalogVersion: string;
    tasks: Readiness;
  };
  /** The task currently executing for the active goal, if any. */
  task?: { taskId: string; objective: string; mode: TaskMode; startedAtMs: number };
  /** The last finished task of the latest goal (verified result summary). */
  lastTask?: { taskId: string; status: string; reason: string; detail: string; decisions: number; actions: number; localContinuations: number };
}

/** Interface for a cleanup step registered by work owned by the active goal. */
export type Cleanup = () => void | Promise<void>;

interface ActiveGoal {
  record: GoalRecord;
  epoch: number;
  abort: AbortController;
  cleanups: Set<Cleanup>;
  clarifications: ClarificationExchange[];
  knowledge: KnowledgeResult[];
  admittedTasks: number;
  deadline: NodeJS.Timeout | undefined;
  feedback: TaskFeedback[];
  outcome?: { contract: GoalOutcomeContract; canonical: string; bound: BoundPredicate; interpretation: string };
  counters: GoalCounters;
  /** Server-confirmed inventory captured at admission, before the first planner turn. */
  baseline?: InventoryBaseline;
  admission?: AdmissionInventory;
  /** Snapshots/anchors actually shown to the planner for this goal (reference validation). */
  shown: Map<string, ShownSnapshot>;
  anchors: Set<string>;
  dimension?: string;
  /** Verified prior results (action ids) of this goal. */
  priorResults: Map<string, PriorResultRef>;
  rejection?: string[];
  consecutiveRepairs: number;
  consecutiveRetries: number;
  nextTurnKind: NonNullable<PlannerRequest['turnKind']>;
  outcomeStatus?: { status: 'satisfied' | 'unsatisfied' | 'unknown'; detail: string };
}

const TERMINAL_STATE_FOR: Record<TerminalReasonCode, TerminalGoalState> = {
  owner_stop: 'cancelled',
  replaced: 'cancelled',
  shutdown: 'cancelled',
  planner_not_ready: 'blocked',
  capability_not_ready: 'blocked',
  knowledge_not_ready: 'blocked',
  cannot_execute: 'blocked',
  limit_exhausted: 'blocked',
  invalid_proposal: 'blocked',
  decision_not_ready: 'blocked',
  no_progress: 'blocked',
  low_health: 'blocked',
  death: 'failed',
  disconnected: 'failed',
  kicked: 'failed',
  dimension_change: 'failed',
  planner_error: 'failed',
  runtime_error: 'failed',
  decision_error: 'failed',
  outcome_verified: 'completed',
};

/** Maps a finished task to the goal's terminal reason (cancelled tasks are handled by revocation). */
export function terminalForTask(result: TaskResult): TerminalReasonCode {
  if (result.status === 'completed') return 'outcome_verified';
  switch (result.reason) {
    case 'decision_not_ready':
      return 'decision_not_ready';
    case 'decision_limit':
    case 'round_limit':
      return 'limit_exhausted';
    case 'no_progress':
    case 'repeated_without_progress':
      return 'no_progress';
    case 'low_health':
      return 'low_health';
    case 'decision_error':
      return 'decision_error';
    case 'no_candidates':
    case 'per_target_retries_exhausted':
      return 'cannot_execute';
    default:
      return result.status === 'blocked' ? 'cannot_execute' : 'runtime_error';
  }
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Typed planner failure carried by an adapter error (structural: no adapter import). */
function plannerFailureOf(error: unknown): PlannerFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const f = (error as { failure?: unknown }).failure;
  if (!f || typeof f !== 'object' || typeof (f as { kind?: unknown }).kind !== 'string') return undefined;
  return f as PlannerFailure;
}

const PLANNER_ADVICE: Partial<Record<PlannerFailure['kind'], string>> = {
  auth: 'the Codex subscription sign-in is missing or expired; the operator must sign in with `codex login` (no API-key or other planner is used instead)',
  quota: 'the Codex subscription usage limit was reached; wait for it to reset (no paid or alternative planner is used instead)',
  model_unavailable: 'the selected planner model is not available to this subscription; no other model is substituted',
  not_ready: 'the planner isolation gate did not pass (see doctor)',
};

class StaleWorkError extends Error {
  constructor() {
    super('stale goal work');
    this.name = 'StaleWorkError';
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Rejects as soon as `signal` aborts, even if the adapter ignores the signal. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new StaleWorkError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new StaleWorkError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class GoalEngine {
  private readonly deps: GoalEngineDeps;
  /** Last goal (active or terminal). Terminal state is kept for status until the next goal. */
  private last: GoalRecord | undefined;
  private active: ActiveGoal | undefined;
  /** Incremented on every ownership change; async work compares before acting. */
  private epoch = 0;
  /** Incremented by every stop/instruction so an older pending admission yields. */
  private intakeGeneration = 0;
  /** Resolves when all previously revoked goals have finished cleanup. */
  private cleanupBarrier: Promise<void> = Promise.resolve();
  private clarificationCounter = 0;
  private closed = false;
  private currentTask: EngineStatus['task'];
  private lastTask: EngineStatus['lastTask'];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: GoalEngineDeps) {
    this.deps = deps;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  /** True while a goal owns control (planning, awaiting the owner, executing, stopping). */
  get hasActiveGoal(): boolean {
    return this.active !== undefined;
  }

  /** The single intake surface for every natural-language instruction (chat or terminal). */
  async submit(instruction: string, origin: IntakeOrigin): Promise<SubmitResult> {
    const text = instruction.trim();
    const invalid = this.validateIntake(text, origin);
    if (invalid) return invalid;
    const admitted = await this.admit(text, origin, 'owner_goal');
    if (admitted.status !== 'admitted') return admitted.result;
    this.deps.notify({ goalId: admitted.active.record.id, text: `Goal ${admitted.active.record.id} accepted: "${truncate(text, 120)}". Planning…` });
    this.track(this.plan(admitted.active));
    return admitted.result;
  }

  /**
   * Terminal-only OPERATOR TASK DIAGNOSTIC (MB-V1-03): admits one generic,
   * operator-written TaskSpec through the same validation, replacement,
   * epoch, admission hook (travel anchor) and revocation path as a goal, then
   * runs it with the generic task runtime and real Jev choices. Labeled
   * `operator_task_diagnostic`; never reachable from chat and never
   * natural-language goal acceptance. The diagnostic's declared outcome is the
   * task's own completion predicate, verified by code.
   */
  async submitOperatorTask(rawSpec: unknown, mode: TaskMode, origin: IntakeOrigin): Promise<SubmitResult> {
    if (origin.surface !== 'terminal') return this.reject('invalid_task', 'task diagnostics are terminal-only', origin);
    if (!this.deps.tasks) return this.reject('tasks_not_installed', 'the generic task runtime is not installed', origin);
    const parsed = TaskSpecSchema.safeParse(rawSpec);
    if (!parsed.success) {
      return this.reject('invalid_task', `invalid TaskSpec: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}; nothing was changed`, origin);
    }
    const spec = parsed.data;
    const unknown = spec.allowedCapabilities.filter((c) => !this.deps.capabilities.has(c));
    if (unknown.length > 0) return this.reject('invalid_task', `TaskSpec names capabilities that are not implemented: ${unknown.join(', ')}; nothing was changed`, origin);
    if (!isPredicateWithinDepth(spec.completion)) return this.reject('invalid_task', 'completion predicate nesting exceeds the supported depth; nothing was changed', origin);
    const label = `[operator task diagnostic, ${mode}] ${spec.objective}`;
    const invalid = this.validateIntake(label, origin, BOUNDS.longText);
    if (invalid) return invalid;
    const admitted = await this.admit(truncate(label, BOUNDS.longText), origin, 'operator_task_diagnostic');
    if (admitted.status !== 'admitted') return admitted.result;
    const active = admitted.active;
    this.deps.notify({ goalId: active.record.id, audience: 'operator', text: `Operator task diagnostic ${active.record.id} admitted (${mode}): "${truncate(spec.objective, 120)}" — generic task controller with real Jev choices; not natural-language goal planning.` });
    active.admittedTasks += 1;
    this.track(this.runDiagnosticTask(active, spec, mode));
    return admitted.result;
  }

  private validateIntake(text: string, origin: IntakeOrigin, max = this.deps.limits.maxInstructionChars): SubmitResult | undefined {
    // Validation happens before any existing work is touched.
    if (this.closed) return this.reject('shutting_down', 'Chunkbot is shutting down', origin);
    if (text.length === 0) return this.reject('empty', 'instruction is empty; nothing was changed', origin);
    if (text.length > max) {
      return this.reject('too_long', `instruction has ${text.length} characters; the limit is ${max}; nothing was changed`, origin);
    }
    if (!this.deps.isGameReady()) {
      return this.reject('not_connected', 'not connected to the game; nothing was changed', origin);
    }
    return undefined;
  }

  /** Replacement, epoch, record and synchronous admission hook (travel anchor) — shared by every intake. */
  private async admit(text: string, origin: IntakeOrigin, kind: GoalKind): Promise<{ status: 'admitted'; active: ActiveGoal; result: SubmitResult } | { status: 'not_admitted'; result: SubmitResult }> {
    const generation = ++this.intakeGeneration;
    const replaced = this.active?.record.id;
    // Valid replacement: revoke old ownership and await its cleanup BEFORE planning.
    await this.revokeActive('replaced', 'replaced by a new owner instruction');
    if (generation !== this.intakeGeneration || this.closed) {
      this.deps.store.record({ type: 'goal_admission_superseded', surface: origin.surface });
      return { status: 'not_admitted', result: { status: 'superseded' } };
    }

    this.epoch += 1;
    const now = this.deps.clock.now();
    const record: GoalRecord = {
      id: this.deps.ids.next('goal'),
      ...(kind === 'owner_goal' ? {} : { kind }),
      epoch: this.epoch,
      instruction: text,
      origin,
      state: 'planning',
      admittedAtMs: now,
      updatedAtMs: now,
      plannerTurns: 0,
      progress: '',
    };
    const active: ActiveGoal = {
      record,
      epoch: this.epoch,
      abort: new AbortController(),
      cleanups: new Set(),
      clarifications: [],
      knowledge: [],
      admittedTasks: 0,
      deadline: undefined,
      feedback: [],
      counters: { plannerTurns: 0, knowledgeRounds: 0, repairs: 0, retries: 0, clarifications: 0, replans: 0, windows: 0, tasksAdmitted: 0, preparationTurns: 0, lookaheads: 0 },
      shown: new Map(),
      anchors: new Set(),
      priorResults: new Map(),
      consecutiveRepairs: 0,
      consecutiveRetries: 0,
      nextTurnKind: 'initial',
    };
    // The record shows the live counters (one object; never reset across windows).
    if (kind === 'owner_goal') record.counters = active.counters;
    active.deadline = setTimeout(() => {
      void this.finishIfCurrent(active, 'limit_exhausted', `goal deadline of ${Math.round(this.deps.limits.goalDeadlineMs / 1000)}s reached`);
    }, this.deps.limits.goalDeadlineMs);
    active.deadline.unref?.();
    this.active = active;
    this.last = record;
    this.currentTask = undefined;
    this.lastTask = undefined;
    try {
      this.deps.onGoalAdmitted?.({ goalId: record.id, epoch: record.epoch, admittedAtMs: now });
    } catch (error) {
      this.deps.store.record({ type: 'goal_admission_hook_error', goalId: record.id, message: error instanceof Error ? error.message : String(error) });
    }
    this.deps.store.record({
      type: 'goal_admitted',
      goalId: record.id,
      epoch: record.epoch,
      kind,
      surface: origin.surface,
      instruction: truncate(text, BOUNDS.text),
      replacedGoalId: replaced,
    });
    const result: SubmitResult = replaced ? { status: 'admitted', goal: { ...record }, replacedGoalId: replaced } : { status: 'admitted', goal: { ...record } };
    return { status: 'admitted', active, result };
  }

  /**
   * Runs one task for the active goal under its ownership. Registers a cleanup
   * so a stop/replacement waits (bounded) until the task released the actuator.
   */
  private async runTask(active: ActiveGoal, spec: TaskSpec, mode: TaskMode): Promise<TaskResult | undefined> {
    const tasks = this.deps.tasks;
    if (!tasks) return undefined;
    this.assertCurrent(active);
    const taskId = this.deps.ids.next('task');
    if (active.record.state !== 'executing') this.setState(active, 'executing');
    this.currentTask = { taskId, objective: truncate(spec.objective, 200), mode, startedAtMs: this.deps.clock.now() };
    this.deps.store.record({ type: 'task_admitted', goalId: active.record.id, epoch: active.epoch, taskId, mode, objective: truncate(spec.objective, BOUNDS.text), allowedCapabilities: spec.allowedCapabilities });
    const running = tasks.run({ taskId, goalId: active.record.id, goalEpoch: active.epoch, spec, mode, signal: active.abort.signal, isCurrent: () => this.active === active && this.epoch === active.epoch && !active.abort.signal.aborted });
    const cleanup: Cleanup = () => running.then(() => undefined, () => undefined);
    active.cleanups.add(cleanup);
    try {
      const result = await running;
      // MB-JEV-002: a task that returns after its goal lost ownership (stop, replacement,
      // lifecycle, deadline) publishes NOTHING: no status, progress or feedback. A
      // replacement goal's state is never touched by older work.
      if (this.active !== active || this.epoch !== active.epoch || active.abort.signal.aborted) {
        this.deps.store.record({ type: 'task_result_discarded', goalId: active.record.id, epoch: active.epoch, taskId, status: result.status, reason: result.reason, currentGoalId: this.active?.record.id ?? null, detail: 'the owning goal no longer holds control; the late task result was not published' });
        return { ...result, status: 'cancelled', reason: 'ownership_revoked' };
      }
      if (this.currentTask?.taskId === taskId) this.currentTask = undefined;
      this.lastTask = { taskId, status: result.status, reason: result.reason, detail: truncate(result.detail, 300), decisions: result.decisions, actions: result.actions, localContinuations: result.localContinuations };
      active.record.progress = truncate(`task ${taskId} ${result.status} (${result.reason}): ${result.detail}`, BOUNDS.text);
      active.feedback.push(result.feedback);
      if (active.feedback.length > BOUNDS.listSmall) active.feedback.shift();
      this.collectPriorResults(active, result);
      return result;
    } finally {
      active.cleanups.delete(cleanup);
    }
  }

  private async runDiagnosticTask(active: ActiveGoal, spec: TaskSpec, mode: TaskMode): Promise<void> {
    try {
      const result = await this.runTask(active, spec, mode);
      if (!result || result.status === 'cancelled' || this.active !== active) return;
      const reason = terminalForTask(result);
      await this.finishIfCurrent(active, reason, `${result.status === 'completed' ? 'task completion predicate verified by code' : `task ${result.status} (${result.reason})`}: ${result.detail}; decisions ${result.decisions}, actions ${result.actions}, local continuations ${result.localContinuations}`);
    } catch (error) {
      if (error instanceof StaleWorkError || this.active !== active) return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.record({ type: 'task_runtime_error', goalId: active.record.id, message });
      await this.finishIfCurrent(active, 'runtime_error', truncate(message, 300));
    }
  }

  /** Stops the active goal (no-op when idle). Works in every foundation state. */
  async stop(reason: 'owner_stop' | 'shutdown' = 'owner_stop', surface: string = 'terminal'): Promise<{ stopped: boolean; goalId?: string }> {
    ++this.intakeGeneration;
    const goalId = this.active?.record.id;
    if (!this.active) {
      this.deps.store.record({ type: 'stop_requested', surface, hadActiveGoal: false });
      await this.cleanupBarrier;
      return { stopped: false };
    }
    this.deps.store.record({ type: 'stop_requested', surface, hadActiveGoal: true, goalId });
    await this.revokeActive(reason, reason === 'owner_stop' ? 'stopped by owner' : 'Chunkbot is shutting down');
    return goalId ? { stopped: true, goalId } : { stopped: true };
  }

  /** Ends active ownership because of a lifecycle event (death, disconnect, kick, dimension change). */
  async endOwnership(reason: 'death' | 'disconnected' | 'kicked' | 'dimension_change', detail: string): Promise<void> {
    ++this.intakeGeneration;
    if (!this.active) return;
    await this.revokeActive(reason, detail);
  }

  /** Correlated clarification answer. Never revives a cancelled or terminal goal. */
  answer(reply: string, ref: string | undefined, surface: string): AnswerResult {
    const text = reply.trim();
    const active = this.closed ? undefined : this.active;
    const pending = active?.record.state === 'awaiting_owner' ? active.record.pendingClarification : undefined;
    const rejectAnswer = (reason: Extract<AnswerResult, { status: 'rejected' }>['reason'], detail: string): AnswerResult => {
      this.deps.store.record({ type: 'answer_rejected', reason, surface, ref });
      this.deps.notify({ text: `Answer not applied: ${detail}` });
      return { status: 'rejected', reason, detail };
    };
    if (!active || !pending) return rejectAnswer('no_pending_clarification', 'there is no pending question');
    if (ref && ref !== pending.ref) {
      return rejectAnswer('stale_reference', `question ${ref} is no longer pending (current question is ${pending.ref})`);
    }
    if (text.length === 0) return rejectAnswer('empty', `answer is empty; reply with "answer ${pending.ref} <reply>"`);
    if (text.length > this.deps.limits.maxInstructionChars) return rejectAnswer('too_long', 'answer is too long');

    active.clarifications.push({ ref: pending.ref, question: pending.question, answer: text });
    delete active.record.pendingClarification;
    active.nextTurnKind = 'clarification';
    this.deps.journal?.record({ type: 'goal_answer', goalId: active.record.id, ref: pending.ref, question: pending.question, answer: truncate(text, BOUNDS.text) });
    this.setState(active, 'planning');
    this.deps.store.record({ type: 'answer_accepted', goalId: active.record.id, ref: pending.ref, surface, answer: truncate(text, BOUNDS.text) });
    this.deps.notify({ goalId: active.record.id, text: `Answer to ${pending.ref} recorded. Planning…` });
    this.track(this.plan(active));
    return { status: 'accepted', goalId: active.record.id, ref: pending.ref };
  }

  status(): EngineStatus {
    const catalog = this.deps.capabilities.catalog();
    return {
      goal: this.last ? structuredClone(this.last) : undefined,
      readiness: {
        planner: this.deps.planner.readiness(),
        knowledge: this.deps.knowledge.readiness(),
        observation: this.deps.observation.readiness(),
        executor: this.deps.executor.readiness(),
        capabilityCount: catalog.capabilities.length,
        catalogVersion: catalog.catalogVersion,
        tasks: this.deps.tasks ? this.deps.tasks.readiness() : { ready: false, detail: 'generic task runtime not installed' },
      },
      ...(this.currentTask && this.active ? { task: { ...this.currentTask } } : {}),
      ...(this.lastTask ? { lastTask: { ...this.lastTask } } : {}),
    };
  }

  /** Registers cleanup for work owned by the given goal epoch (e.g. a later actuator lease). */
  registerCleanup(epoch: number, cleanup: Cleanup): boolean {
    if (!this.active || this.active.epoch !== epoch) return false;
    this.active.cleanups.add(cleanup);
    return true;
  }

  /**
   * Closes admission synchronously (before any await), then cancels active work
   * and waits, bounded, for cleanup and in-flight work. Submissions arriving
   * during shutdown are rejected; ones already waiting on cleanup are superseded.
   */
  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.cleanupBarrier;
      return;
    }
    this.closed = true;
    await this.stop('shutdown', 'app');
    await withTimeout(Promise.allSettled([...this.inFlight]).then(() => undefined), this.deps.limits.cleanupTimeoutMs, () => new Error('timeout')).catch(
      () => undefined,
    );
  }

  // ------------------------------------------------------------------ internals

  private reject(reason: SubmitRejection, detail: string, origin: IntakeOrigin): SubmitResult {
    this.deps.store.record({ type: 'instruction_rejected', reason, surface: origin.surface });
    this.deps.notify({ text: `Instruction not accepted: ${detail}.` });
    return { status: 'rejected', reason, detail };
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  private setState(active: ActiveGoal, state: GoalState): void {
    active.record.state = state;
    active.record.updatedAtMs = this.deps.clock.now();
    this.deps.store.record({ type: 'goal_state', goalId: active.record.id, epoch: active.epoch, state });
  }

  private assertCurrent(active: ActiveGoal): void {
    if (this.active !== active || this.epoch !== active.epoch || active.abort.signal.aborted) throw new StaleWorkError();
  }

  /** Revokes whichever goal is active (stop, replacement, shutdown, lifecycle interruption). */
  private async revokeActive(reason: TerminalReasonCode, detail: string): Promise<void> {
    if (this.active) await this.revoke(this.active, reason, detail, true);
    else await this.cleanupBarrier;
  }

  /** Ends the goal with a terminal reason if `active` still owns control. */
  private async finishIfCurrent(active: ActiveGoal, reason: TerminalReasonCode, detail: string): Promise<void> {
    if (this.active === active) await this.revoke(active, reason, detail, false);
  }

  /**
   * Ownership revocation order: invalidate the epoch first, then abort model
   * work, then await bounded cleanup of goal-owned resources, then record the
   * terminal state. A later revocation always waits for earlier cleanup.
   */
  private async revoke(active: ActiveGoal, reason: TerminalReasonCode, detail: string, viaStopping: boolean): Promise<void> {
    this.active = undefined;
    this.epoch += 1;
    if (active.deadline) clearTimeout(active.deadline);
    delete active.record.pendingClarification;
    if (viaStopping) this.setState(active, 'stopping');
    active.abort.abort(new Error(reason));
    const previousBarrier = this.cleanupBarrier;
    this.cleanupBarrier = (async () => {
      await previousBarrier;
      const started = this.deps.clock.now();
      const results = await withTimeout(
        Promise.allSettled([...active.cleanups].map(async (fn) => fn())),
        this.deps.limits.cleanupTimeoutMs,
        () => new Error('cleanup timeout'),
      ).catch(() => 'timeout' as const);
      const failed = results === 'timeout' ? 'timeout' : results.filter((r) => r.status === 'rejected').length;
      this.deps.store.record({
        type: 'goal_cleanup',
        goalId: active.record.id,
        epoch: active.epoch,
        cleanups: active.cleanups.size,
        failed,
        elapsedMs: this.deps.clock.now() - started,
      });
      this.finalize(active, reason, detail);
    })();
    await this.cleanupBarrier;
  }

  private finalize(active: ActiveGoal, reason: TerminalReasonCode, detail: string): void {
    if (!isActiveGoalState(active.record.state)) return;
    const state = TERMINAL_STATE_FOR[reason];
    active.record.state = state;
    active.record.updatedAtMs = this.deps.clock.now();
    active.record.terminal = { reason, detail: truncate(detail, BOUNDS.text), atMs: active.record.updatedAtMs };
    this.deps.store.record({ type: 'goal_terminal', goalId: active.record.id, epoch: active.epoch, state, reason, detail: active.record.terminal.detail, ...(active.record.kind === undefined ? { counters: { ...active.counters } } : {}) });
    if (active.record.kind === undefined) this.deps.journal?.record({ type: 'goal_terminal', goalId: active.record.id, state, reason, detail: active.record.terminal.detail, counters: { ...active.counters }, outcomeStatus: active.outcomeStatus ?? null });
    this.deps.notify({ goalId: active.record.id, ...(active.record.kind === 'operator_task_diagnostic' ? { audience: 'operator' as const } : {}), text: `Goal ${active.record.id} ${state} (${reason}): ${truncate(detail, 160)}` });
  }

  /** Verified prior results (placed workstations etc.) of this goal, from the evidence ledger. */
  private collectPriorResults(active: ActiveGoal, result: TaskResult): void {
    const verify = this.deps.priorResults;
    if (!verify) return;
    const ids = result.feedback.recentOutcomes.filter((o) => o.status === 'succeeded' && o.confirmation !== 'none').map((o) => o.actionId);
    if (ids.length === 0) return;
    for (const r of verify(ids)) {
      active.priorResults.set(r.actionId, r);
      if (active.priorResults.size > BOUNDS.listMedium) active.priorResults.delete(active.priorResults.keys().next().value as string);
    }
  }

  /** Records what the planner is shown so its references can be validated (bounded). */
  private remember(active: ActiveGoal, snapshot: ObservationSnapshot | null): void {
    if (!snapshot) return;
    const handles = new Set<string>([...snapshot.blocks, ...snapshot.entities, ...snapshot.drops].map((t) => t.handle));
    for (const f of snapshot.frontiers) handles.add(f.handle);
    active.shown.set(snapshot.id, { handles, dimension: snapshot.dimension });
    while (active.shown.size > 4) active.shown.delete(active.shown.keys().next().value as string);
    for (const a of snapshot.remembered) active.anchors.add(a.anchorId);
    active.dimension = snapshot.dimension;
  }

  private ownerCoords(active: ActiveGoal): OwnerCoordinate[] {
    return ownerCoordinates(active.record.instruction, active.clarifications);
  }

  private progressSummary(active: ActiveGoal): string {
    const c = active.counters;
    return `planner turns ${c.plannerTurns} (knowledge ${c.knowledgeRounds}, repairs ${c.repairs}, retries ${c.retries}, clarifications ${c.clarifications}, replans ${c.replans}), windows ${c.windows}, tasks ${c.tasksAdmitted}${active.outcomeStatus ? `; outcome ${active.outcomeStatus.status}: ${truncate(active.outcomeStatus.detail, 160)}` : ''}`;
  }

  /** Captures the goal's server-confirmed ALL-item inventory before the first planner turn. */
  private async captureBaseline(active: ActiveGoal): Promise<void> {
    const capture = this.deps.outcomes?.captureBaseline?.bind(this.deps.outcomes);
    if (!capture || active.baseline) return;
    const baseline = await raceAbort(capture(active.abort.signal), active.abort.signal);
    this.assertCurrent(active);
    active.baseline = baseline;
    const counts = baseline.counts ? Object.entries(baseline.counts).map(([key, count]) => ({ key, count })).slice(0, BOUNDS.listMedium + 9) : null;
    active.admission = { capturedAtMs: baseline.capturedAtMs, counts, detail: baseline.detail };
    this.deps.store.record({ type: 'goal_admission_baseline', goalId: active.record.id, epoch: active.epoch, capturedAtMs: baseline.capturedAtMs, counts: baseline.counts, detail: baseline.detail });
  }

  /** Bounded planner turns for the active goal until a terminal state or a clarification wait. */
  private async plan(active: ActiveGoal): Promise<void> {
    const { planner, knowledge, observation, capabilities, executor, limits } = this.deps;
    const maxReplans = limits.replans ?? 8;
    const maxRepairs = limits.maxConsecutiveRepairs ?? 2;
    const maxRetries = limits.maxConsecutiveRetries ?? 1;
    const c = active.counters;
    try {
      const readiness = planner.readiness();
      if (!readiness.ready) {
        await this.finishIfCurrent(active, 'planner_not_ready', `${readiness.detail}. No game actions were taken.`);
        return;
      }
      // Admission-bound baseline BEFORE the first planner turn (kept across every later turn).
      await this.captureBaseline(active);
      while (true) {
        this.assertCurrent(active);
        if (c.plannerTurns >= limits.plannerTurnsPerGoal) {
          await this.finishIfCurrent(active, 'limit_exhausted', `planner turn limit (${limits.plannerTurnsPerGoal}) reached; ${this.progressSummary(active)}`);
          return;
        }
        if (active.admittedTasks >= limits.totalTaskCeiling) {
          await this.finishIfCurrent(active, 'limit_exhausted', `total task ceiling (${limits.totalTaskCeiling}) reached; ${this.progressSummary(active)}`);
          return;
        }
        const snapshot = await observation.snapshot(active.epoch).catch(() => null);
        this.assertCurrent(active);
        this.remember(active, snapshot);
        c.plannerTurns += 1;
        active.record.plannerTurns = c.plannerTurns;
        const turnKind = active.nextTurnKind;
        const requestId = this.deps.ids.next('req');
        const priorResults = [...active.priorResults.values()];
        const request: PlannerRequest = {
          requestId,
          subject: { kind: 'goal', goalId: active.record.id, goalEpoch: active.epoch },
          instruction: active.record.instruction,
          turn: c.plannerTurns,
          maxTurns: limits.plannerTurnsPerGoal,
          catalog: capabilities.catalog(),
          observation: snapshot,
          clarifications: [...active.clarifications],
          knowledge: [...active.knowledge],
          ...(active.feedback.length > 0 ? { feedback: [...active.feedback] } : {}),
          turnKind,
          ...(active.admission ? { admission: active.admission } : {}),
          ...(active.outcome ? { acceptedOutcome: active.outcome.contract, acceptedInterpretation: active.outcome.interpretation } : {}),
          ...(active.outcomeStatus ? { outcomeStatus: active.outcomeStatus } : {}),
          counters: { ...c },
          remaining: {
            plannerTurns: limits.plannerTurnsPerGoal - c.plannerTurns,
            tasks: limits.totalTaskCeiling - active.admittedTasks,
            replans: maxReplans - c.replans,
            deadlineMs: Math.max(0, active.record.admittedAtMs + limits.goalDeadlineMs - this.deps.clock.now()),
            windowSteps: limits.planWindowSteps,
          },
          ownerCoordinates: this.ownerCoords(active),
          priorResults,
          ...(active.rejection ? { rejection: { problems: active.rejection } } : {}),
          ...(this.deps.mechanicsVersion ? { mechanicsVersion: this.deps.mechanicsVersion } : {}),
          limits: { travelRadius: limits.travelRadius ?? 128, observationRadius: limits.observationRadius ?? 32, planWindowSteps: limits.planWindowSteps },
        };
        this.deps.store.record({ type: 'planner_request', goalId: active.record.id, requestId, turn: c.plannerTurns, turnKind, snapshotId: snapshot?.id ?? null, counters: { ...c } });

        // One bounded turn. Its own abort (timeout) is linked to the goal's; a stop/replacement
        // aborts it immediately, and revocation cleanup waits (bounded) for the planner process.
        const turnAbort = new AbortController();
        const onGoalAbort = () => turnAbort.abort(new Error('goal revoked'));
        active.abort.signal.addEventListener('abort', onGoalAbort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          turnAbort.abort(new Error('planner turn timeout'));
        }, limits.plannerTimeoutMs);
        const turn = Promise.resolve().then(() => planner.propose(request, turnAbort.signal));
        const settled: Cleanup = () => turn.then(() => undefined, () => undefined);
        active.cleanups.add(settled);
        let raw: unknown;
        let failure: PlannerFailure | undefined;
        try {
          raw = await raceAbort(raceAbort(turn, turnAbort.signal), active.abort.signal);
        } catch (error) {
          if (error instanceof StaleWorkError && active.abort.signal.aborted) throw error;
          if (error instanceof StaleWorkError && timedOut) failure = { kind: 'timeout', detail: `planner turn exceeded ${limits.plannerTimeoutMs}ms` };
          else failure = plannerFailureOf(error) ?? { kind: 'process_error', detail: error instanceof Error ? error.message : String(error) };
          if (failure.kind === 'aborted' && timedOut) failure = { kind: 'timeout', detail: `planner turn exceeded ${limits.plannerTimeoutMs}ms` };
        } finally {
          clearTimeout(timer);
          active.abort.signal.removeEventListener('abort', onGoalAbort);
          if (!active.abort.signal.aborted) {
            // Own failure (timeout/error): wait, bounded, for the planner process cleanup before continuing.
            if (timedOut || failure) await withTimeout(settled() as Promise<void>, limits.cleanupTimeoutMs, () => new Error('planner cleanup timeout')).catch(() => undefined);
            active.cleanups.delete(settled);
          } // a revoked goal keeps the cleanup registered so revocation awaits the planner process

        }
        // A reply for a stopped/replaced goal is discarded without effect.
        this.assertCurrent(active);

        if (failure) {
          this.deps.store.record({ type: 'planner_failure', goalId: active.record.id, requestId, kind: failure.kind, detail: truncate(failure.detail, 400) });
          switch (failure.kind) {
            case 'aborted':
              throw new StaleWorkError();
            case 'invalid_output':
              if (await this.rejectAndMaybeRepair(active, requestId, 'invalid_output', failure.problems ?? [failure.detail], maxRepairs)) continue;
              return;
            case 'timeout':
            case 'process_error':
              if (active.consecutiveRetries < maxRetries) {
                active.consecutiveRetries += 1;
                c.retries += 1;
                active.nextTurnKind = 'retry';
                continue;
              }
              await this.finishIfCurrent(active, 'planner_error', `${failure.kind}: ${truncate(failure.detail, 240)} (after ${maxRetries} bounded retr${maxRetries === 1 ? 'y' : 'ies'}). No game actions were taken by the planner.`);
              return;
            case 'model_mismatch':
            case 'prohibited_event':
              await this.finishIfCurrent(active, 'planner_error', `${failure.kind}: ${truncate(failure.detail, 240)}; the planner is disabled for this run and no fallback is used`);
              return;
            default:
              // auth / quota / model_unavailable / not_ready: actionable, never a billing/model fallback.
              await this.finishIfCurrent(active, 'planner_not_ready', `${failure.kind}: ${truncate(failure.detail, 200)} — ${PLANNER_ADVICE[failure.kind] ?? 'planner unavailable'}. No game actions were taken.`);
              return;
          }
        }
        active.consecutiveRetries = 0;

        const check = checkProposal(
          raw,
          capabilities,
          { planWindowSteps: limits.planWindowSteps, remainingTaskAllowance: limits.totalTaskCeiling - active.admittedTasks },
          {
            ...(this.deps.registry ? { registry: this.deps.registry } : {}),
            shown: active.shown,
            anchors: active.anchors,
            ...(active.dimension ? { dimension: active.dimension } : {}),
            ownerCoordinates: request.ownerCoordinates ?? [],
            priorResults: new Set(active.priorResults.keys()),
          },
        );
        if (!check.ok) {
          if (await this.rejectAndMaybeRepair(active, requestId, check.kind, check.problems, maxRepairs)) continue;
          return;
        }
        const proposal = check.proposal;
        // Accepted outcome is immutable: a later plan may not silently change it.
        if (proposal.disposition === 'plan' && active.outcome && active.outcome.canonical !== canonicalJson(proposal.outcome)) {
          if (await this.rejectAndMaybeRepair(active, requestId, 'semantic', ['the plan changes the accepted goal outcome; repeat acceptedOutcome exactly (a changed outcome needs a new owner instruction)'], maxRepairs)) continue;
          return;
        }
        active.consecutiveRepairs = 0;
        delete active.rejection;
        active.record.interpretation = truncate(proposal.interpretation, BOUNDS.text);
        this.deps.store.record({ type: 'planner_proposal', goalId: active.record.id, requestId, turn: c.plannerTurns, disposition: proposal.disposition, interpretation: proposal.interpretation });
        this.deps.journal?.record({ type: 'goal_proposal_accepted', goalId: active.record.id, requestId, turn: c.plannerTurns, turnKind, disposition: proposal.disposition, proposal: proposal as unknown as Record<string, unknown> });

        switch (proposal.disposition) {
          case 'needs_information': {
            const results = await raceAbort(knowledge.answer(proposal.queries, active.abort.signal), active.abort.signal);
            this.assertCurrent(active);
            c.knowledgeRounds += 1;
            active.knowledge.push(...results.slice(0, BOUNDS.listSmall));
            if (active.knowledge.length > 48) active.knowledge.splice(0, active.knowledge.length - 48);
            active.nextTurnKind = 'knowledge';
            this.deps.store.record({ type: 'knowledge_answered', goalId: active.record.id, queries: proposal.queries, statuses: results.map((r) => r.status) });
            continue;
          }
          case 'needs_clarification': {
            this.clarificationCounter += 1;
            c.clarifications += 1;
            const request: ClarificationRequest = {
              id: this.deps.ids.next('clar'),
              goalId: active.record.id,
              goalEpoch: active.epoch,
              ref: `q${this.clarificationCounter}`,
              question: truncate(proposal.question, BOUNDS.text),
              askedAtMs: this.deps.clock.now(),
            };
            active.record.pendingClarification = request;
            this.setState(active, 'awaiting_owner');
            this.deps.store.record({ type: 'clarification_requested', goalId: active.record.id, ref: request.ref, question: request.question });
            this.deps.journal?.record({ type: 'goal_question', goalId: active.record.id, ref: request.ref, question: request.question, interpretation: proposal.interpretation });
            this.deps.notify({
              goalId: active.record.id,
              text: `Question ${request.ref}: ${truncate(request.question, 180)} (reply: answer ${request.ref} <reply>)`,
            });
            return; // Pending clarification causes no game actions and no repeated inference.
          }
          case 'cannot_execute': {
            const detail = `${proposal.missing}${proposal.missingCapabilities.length ? ` (missing capabilities: ${proposal.missingCapabilities.join(', ')})` : ''}${proposal.verifiedProgress ? `; planner-reported progress: ${proposal.verifiedProgress}` : ''}; ${this.progressSummary(active)}`;
            await this.finishIfCurrent(active, 'cannot_execute', detail);
            return;
          }
          case 'plan': {
            const ready = executor.readiness();
            if (!ready.ready) {
              await this.finishIfCurrent(
                active,
                'capability_not_ready',
                `plan accepted ("${truncate(proposal.interpretation, 100)}") but ${ready.detail}. No game actions were taken.`,
              );
              return;
            }
            if (!this.deps.tasks || !this.deps.outcomes) {
              // Execution belongs to the task runtime; the foundation never reports fake success.
              await this.finishIfCurrent(active, 'capability_not_ready', 'task execution loop is not installed');
              return;
            }
            // Goal outcome contract: bound ONCE at the first accepted plan, measured
            // from the ADMISSION baseline (original counts), immutable afterwards.
            const outcomeRoot = proposal.outcome.kind === 'finite' ? proposal.outcome.outcome : proposal.outcome.maintain;
            if (!active.outcome) {
              const bound = await raceAbort(this.deps.outcomes.bind(outcomeRoot, active.abort.signal, active.baseline), active.abort.signal);
              this.assertCurrent(active);
              active.outcome = { contract: proposal.outcome, canonical: canonicalJson(proposal.outcome), bound, interpretation: proposal.interpretation };
              active.record.outcome = truncate(`${proposal.outcome.kind}: ${JSON.stringify(outcomeRoot)}`, BOUNDS.text);
              this.deps.store.record({ type: 'goal_outcome_bound', goalId: active.record.id, kind: proposal.outcome.kind, baselines: bound.baselines, boundAtMs: bound.boundAtMs, fromAdmission: Boolean(active.baseline) });
              this.deps.journal?.record({ type: 'goal_interpretation', goalId: active.record.id, interpretation: proposal.interpretation, outcome: proposal.outcome as unknown as Record<string, unknown>, baselines: bound.baselines });
              this.deps.notify({ goalId: active.record.id, text: `Goal ${active.record.id}: ${truncate(proposal.interpretation, 200)}` });
            }
            c.windows += 1;
            c.tasksAdmitted += proposal.tasks.length;
            active.admittedTasks += proposal.tasks.length;
            this.deps.store.record({ type: 'goal_window', goalId: active.record.id, window: c.windows, tasks: proposal.tasks.map((t) => ({ objective: truncate(t.objective, 160), allowedCapabilities: t.allowedCapabilities })), morePlanningNeeded: proposal.morePlanningNeeded, counters: { ...c } });
            this.deps.notify({ goalId: active.record.id, audience: 'operator', text: `Goal ${active.record.id} window ${c.windows}: ${proposal.tasks.length} task(s): ${proposal.tasks.map((t) => truncate(t.objective, 60)).join(' | ')}` });
            // Execute the window in order. A task completing is NOT goal completion.
            const maintainKey = proposal.outcome.kind === 'persistent' ? canonicalJson(proposal.outcome.maintain) : undefined;
            for (const spec of proposal.tasks) {
              const mode: TaskMode = maintainKey !== undefined && canonicalJson(spec.completion) === maintainKey ? 'maintain' : 'complete';
              const result = await this.runTask(active, spec, mode);
              this.assertCurrent(active);
              if (!result || result.status === 'cancelled') return;
              if (result.status !== 'completed') break; // feedback goes to the next planner turn
            }
            const verdict = await raceAbort(this.deps.outcomes.evaluate(active.outcome.bound, active.abort.signal), active.abort.signal);
            this.assertCurrent(active);
            active.outcomeStatus = { status: verdict.status, detail: truncate(verdict.detail, 400) };
            this.deps.store.record({ type: 'goal_outcome_evaluated', goalId: active.record.id, window: c.windows, status: verdict.status, detail: verdict.detail, evidence: verdict.evidence });
            if (active.outcome.contract.kind === 'finite' && verdict.status === 'satisfied') {
              this.deps.journal?.record({ type: 'goal_final_evidence', goalId: active.record.id, status: verdict.status, detail: verdict.detail, evaluation: verdict as unknown as Record<string, unknown>, counters: { ...c } });
              await this.finishIfCurrent(active, 'outcome_verified', `goal outcome verified by code: ${verdict.detail}; ${this.progressSummary(active)}`);
              return;
            }
            if (c.replans >= maxReplans) {
              await this.finishIfCurrent(active, 'limit_exhausted', `replan limit (${maxReplans}) reached with the outcome ${verdict.status} (${truncate(verdict.detail, 160)}); ${this.progressSummary(active)}`);
              return;
            }
            c.replans += 1;
            active.nextTurnKind = 'replan';
            this.setState(active, 'planning');
            continue; // exhausting a window requests more planning; it never completes the goal
          }
        }
      }
    } catch (error) {
      if (error instanceof StaleWorkError || this.active !== active) return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.record({ type: 'planner_error', goalId: active.record.id, message });
      await this.finishIfCurrent(active, 'planner_error', truncate(message, 300));
    }
  }

  /**
   * A rejected proposal (forbidden content, schema, references, semantics,
   * unknown capabilities) causes NO action. The planner gets a bounded number
   * of consecutive repair turns (each counted); then the goal blocks.
   */
  private async rejectAndMaybeRepair(active: ActiveGoal, requestId: string, kind: string, problems: string[], maxRepairs: number): Promise<boolean> {
    this.deps.store.record({ type: 'planner_proposal_rejected', goalId: active.record.id, requestId, kind, problems: problems.slice(0, 12) });
    this.deps.journal?.record({ type: 'goal_proposal_rejected', goalId: active.record.id, requestId, kind, problems: problems.slice(0, 12) });
    if (active.consecutiveRepairs < maxRepairs) {
      active.consecutiveRepairs += 1;
      active.counters.repairs += 1;
      active.rejection = problems.slice(0, 12);
      active.nextTurnKind = 'repair';
      return true;
    }
    const detail = `${problems.slice(0, 3).join('; ')} (after ${maxRepairs} repair turn${maxRepairs === 1 ? '' : 's'}). No game actions were taken.`;
    await this.finishIfCurrent(active, kind === 'unknown_capabilities' ? 'capability_not_ready' : 'invalid_proposal', truncate(detail, BOUNDS.text));
    return false;
  }
}
