// Goal engine: one owner, one active goal. Every natural-language instruction
// enters through `submit` — there is no intent table, keyword gate, or
// resource-specific handler. The engine owns lifecycle, epochs,
// replacement/stop ordering, and the ROLLING
// planner/task-window loop (MB-V1-04):
//
//   admission (epoch, travel anchor, server-confirmed ALL-item inventory
//   baseline) -> planner turn (fresh bounded context) -> forbidden/schema/
//   reference/semantic validation (rejected proposals cause no action; bounded
//   repair turns) -> knowledge rounds / exact declarative cannot-execute / plan
//   -> the first accepted outcome is bound to the
//   ADMISSION baseline and is immutable -> the window's tasks run in order
//   through the generic task runtime -> code evaluates the accepted outcome ->
//   satisfied: completed; otherwise a replan turn with verified feedback.
//
// Every planner turn kind (initial, knowledge continuation, repair, retry,
// replan, lookahead) counts toward the goal's turn limit; counters, baselines
// and the outcome survive windows, knowledge rounds and replans. A finished
// task or window never completes a goal.
//
// MB-PLAN-006 no-follow-up-question policy (application-owned): there is no
// clarification state, question notice or answer wait for goals, preparations,
// lookahead, automatic support or continuation. A legacy/malformed question
// proposal, or owner-facing planner text that asks the owner something, is
// refused BEFORE any notice/state change/action (src/goals/declarative.ts) and
// gets a counted repair within the existing allowances; exhaustion is an
// app-owned declarative blocker (the raw question is never relayed).
//
// MB-FLOW-002 smooth handoff. While an owner goal is executing a task, a new
// valid owner instruction is NOT admitted at once: it becomes the single
// PENDING instruction (intent id + generation + connection epoch) and is
// acknowledged immediately. Only the currently admitted old task continues,
// under its original limits; the old goal starts no new task and no planner
// turn while a replacement is pending (it parks). The preparation plans from a
// read-only filtered snapshot, the catalog, knowledge and the provisional
// client-model inventory — never a resync, interface, lease or action. On a
// valid draft: revoke the old goal and await its bounded cleanup -> admit the
// new goal (travel anchor hook, server-confirmed admission baseline) -> re-ground
// and recheck the draft against a FRESH snapshot -> bind the accepted outcome
// to THAT baseline -> execute. A stale draft gets bounded counted repairs.
// Preparation turns transfer to the admitted goal's counters; discarded
// preparations consume a bounded per-run allowance. A newer instruction
// supersedes the pending one (its planner process is cancelled, late results
// are fenced by generation); stop and lifecycle events cancel both contexts.
// Planning failures before admission keep the still-valid old task running and
// say so honestly. Exactly one planner process exists at a time (PlannerSlot);
// owner preparation preempts speculative window lookahead.
import {
  BOUNDS,
  TaskSpecSchema,
  type AdmissionInventory,
  type AutonomyPlannerContext,
  type ControlLatch,
  type GoalSource,
  type GoalCounters,
  type HandoffTotals,
  type InventoryBaseline,
  type ObservationSnapshot,
  type OwnerCoordinate,
  type PendingInstructionState,
  type PendingInstructionStatus,
  type PlannerFailure,
  type PlannerProposal,
  type PlannerRequest,
  type PlannerTurnKind,
  type PreparationDiscardReason,
  type PriorResultRef,
  type RegistryFacts,
  type RouteProposalContext,
  type EvidenceEvent,
  type WindowGap,
  isActiveGoalState,
  isAutomaticSource,
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
  type Clock,
  type GoalRecord,
  type GoalState,
  type IdSource,
  type IntakeOrigin,
  type KnowledgePort,
  type KnowledgeResult,
  type MemoryPlannerPort,
  type MemoryView,
  type ObservationPort,
  type PlannerPort,
  type Readiness,
  type RunStore,
  type SkillExecutor,
  type TerminalGoalState,
  type TerminalReasonCode,
  CONTINUABLE_INTERRUPTIONS,
  DEFAULT_MAX_CONTINUATIONS,
  HELD_ONLY_INTERRUPTIONS,
  type ContinuationCapture,
  type ContinuationCheckpoint,
  type ContinuationSurvivalPort,
  type ContinueResult,
  type RouteCarry,
  type Vec3,
} from '../contracts/index.ts';
import { countFor, groundOutcome, initialCountLineage, outcomeAtoms } from './continuation.ts';
import { isOwnerQuestionProblem, questionBlockerText } from './declarative.ts';
import { checkProposal, type ShownSnapshot } from './proposal.ts';
import { predicateTargetsOwner } from './owner-navigation.ts';
import { publicBlocker, publicOutcome, publicTaskLabel } from './public-text.ts';
import { ownerCoordinates } from './owner-coordinates.ts';
import { PlannerSlot, type PlannerSlotKind } from './planner-slot.ts';
import { regroundProposal } from './reground.ts';

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

/** MB-FLOW-002 flow options (config `flow`). */
export interface FlowOptions {
  /** `smooth`: prepare a new instruction while the current task continues; `immediate`: replace at once (pre-MB-FLOW-002). */
  handoff: 'smooth' | 'immediate';
  /** Speculative next-window planner turn while a window's last task runs (counted; revalidated before use). */
  lookahead: boolean;
  /** Planner turns of discarded (never admitted) preparations allowed per run; then intake replaces directly. */
  preparationTurnsPerRun: number;
}

export const DEFAULT_FLOW: FlowOptions = { handoff: 'smooth', lookahead: false, preparationTurnsPerRun: 40 };

export interface OwnerNotice {
  text: string;
  goalId?: string;
  /** Pending-instruction notices carry the intent id instead of a goal id. */
  intentId?: string;
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
  /** Smooth handoff / lookahead options (defaults: DEFAULT_FLOW). */
  flow?: Partial<FlowOptions>;
  /** Owner/operator-facing notices (terminal and in-game reply). */
  notify: (notice: OwnerNotice) => void;
  /** Goals require a ready game connection. */
  isGameReady: () => boolean;
  /** Current connection epoch; a pending instruction belongs to the connection it arrived on. */
  connectionEpoch?: () => number;
  /**
   * MB-FLOW-001 P2: called SYNCHRONOUSLY whenever the explicit pause latch
   * changes (owner stop sets it before any await; resume clears it). The
   * supervisor cancels its scheduling here and persists the latch durably.
   * Must not throw; failures are recorded.
   */
  onLatchChanged?: (latch: ControlLatch, cause: 'owner_stop' | 'resume') => void;
  /**
   * MB-FLOW-003-C11/C13 shared seam: SYNCHRONOUS nudge whenever immediate-safety
   * authority may have changed (explicit stop AFTER the active goal was revoked
   * synchronously, resume, owner goal admission, goal terminal). The safety
   * service re-reads `safetyAuthority()`; it never caches authority from this.
   * Must not throw; failures are recorded.
   */
  onSafetyAuthorityChanged?: (cause: 'owner_stop' | 'resume' | 'owner_goal_admitted' | 'goal_terminal') => void;
  /** MB-LOC-001: the goal epoch's route view for planner requests and proposal validation (code-owned; no coordinates). */
  routeView?: (goalEpoch: number) => PlannerRequest['route'] | undefined;
  /** MB-LOC-001: coarse owner locator hint for planner requests. */
  locatorHint?: () => PlannerRequest['locator'] | undefined;
  /** Optional evaluators installed in this run (proposal validation of structure_state / survival_state). */
  installed?: { structures: boolean; survival: boolean };
  /**
   * MB-FLOW-001/003-C5 owned admission barrier: awaited (abortable, bounded by
   * the caller) AFTER admission and the baseline, BEFORE the first planner turn
   * or support task of the goal. `ok: false` ends the goal without any model
   * call or action. Never awaited on capture/revocation; stop aborts it at once.
   */
  admissionBarrier?: (admission: { goalId: string; epoch: number; source: GoalSource | undefined }, signal: AbortSignal) => Promise<{ ok: true } | { ok: false; reason: TerminalReasonCode; detail: string }>;
  /** MB-FLOW-001: a pending owner instruction ended without admission (synchronous; must not throw). */
  onPreparationDiscarded?: (p: { intentId: string; instruction: string; reason: PreparationDiscardReason; detail: string }) => void;
  /**
   * Admission ownership hook: called synchronously once a valid instruction has
   * replaced any old goal and the new goal epoch is current, BEFORE planning.
   * Execution adapters capture admission-bound state here (e.g. the goal's
   * travel anchor). Must not throw; failures are recorded, not fatal.
   */
  onGoalAdmitted?: (admission: { goalId: string; epoch: number; admittedAtMs: number; instruction: string; kind: GoalKind; source?: GoalSource; deadlineAtMs: number; ownerCoordinates: OwnerCoordinate[]; continuation?: AdmissionContinuation }) => void;
  /**
   * MB-FLOW-003-C12 same-session continuation (in memory; works with survival,
   * memory and autonomy disabled). Absent: no checkpoints are kept.
   */
  continuation?: ContinuationDeps;
  /** MB-FLOW-003-C12: keeps the Jev per-goal attempt budget of held/continuing owner jobs (same goal id). */
  decisionBudget?: { retainGoalBudget?(goalId: string, retain: boolean): void };
  /** Called once when a goal reaches a terminal state (after cleanup). Must not throw; failures are recorded. */
  onGoalTerminal?: (end: GoalTerminalEvent) => void;
  /** MB-MEM-001 planner seam (bounded view per request, shown refs, prepared-ref re-grounding). */
  memory?: MemoryPlannerPort;
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
  /** Bounded planner journal: interpretations, proposals/revisions, refusals, final predicate evidence. */
  journal?: { record(event: EvidenceEvent): void };
  /** Exact mechanics version shown to the planner. */
  mechanicsVersion?: string;
}

export type SubmitRejection = 'empty' | 'too_long' | 'not_connected' | 'shutting_down' | 'invalid_task' | 'tasks_not_installed' | 'busy' | 'paused';

/** What the terminal hook reports (MB-FLOW-001 adds source, outcome and counters for the supervisor). */
export interface GoalTerminalEvent {
  goalId: string;
  epoch: number;
  kind: GoalKind;
  state: TerminalGoalState;
  reason: TerminalReasonCode;
  detail: string;
  interpretation?: string;
  instruction?: string;
  source?: GoalSource;
  /** The accepted outcome contract, when one was bound. */
  outcome?: GoalOutcomeContract;
  outcomeStatus?: { status: 'satisfied' | 'unsatisfied' | 'unknown'; detail: string };
  counters?: GoalCounters;
  admittedAtMs?: number;
  /** Absolute goal deadline. */
  deadlineAtMs?: number;
  /** Server-confirmed admission inventory (counts null when unknown). */
  baseline?: { capturedAtMs: number; counts: Record<string, number> | null };
  progress?: string;
  /** MB-FLOW-003-C12: the owner job is HELD as a same-session checkpoint (not finished). */
  held?: { continuable: boolean; reason: string; continuations: { used: number; max: number } };
}

/** What a continuation admission passes to the admission hook (original anchor and route lineage). */
export interface AdmissionContinuation {
  number: number;
  anchor: { dimension: string; at: Vec3; radius: number } | null;
  /** undefined: the route lineage could not be exported (no route grant is made); null: the job had none. */
  route: RouteCarry | null | undefined;
}

export interface ContinuationDeps {
  /** This application process (a restart is another session: display only). */
  sessionId: string;
  maxContinuations?: number;
  /** Optional survival service (frozen last-alive counts, own-incident returns, recovery gate, display persistence). */
  survival?: ContinuationSurvivalPort;
  /** Synchronous: the ORIGINAL admission anchor of a goal epoch (execution layer). */
  captureAnchor?(goalEpoch: number): { dimension: string; at: Vec3; radius: number } | undefined;
  /** Synchronous: the route authorization lineage of a goal epoch (undefined: cannot export). */
  captureRoute?(goalEpoch: number): RouteCarry | null | undefined;
  isAlive?(): boolean;
  currentDimension?(): string | undefined;
  /** Selector matching (exact key or version tag). */
  matches(selector: string, key: string): boolean;
  /** Status/dashboard notification of a checkpoint change (synchronous; must not throw). */
  onChanged?(checkpoint: ContinuationCheckpoint): void;
}

/** One held owner job (in memory). */
interface HeldEntry {
  cp: ContinuationCheckpoint;
  capture: ContinuationCapture | undefined;
  /** Planner-internal accepted interpretation (never owner-visible). */
  plannerInterpretation: string;
  knowledge: KnowledgeResult[];
  origin: IntakeOrigin;
  /** Own-incident returns of the PREVIOUS incident at this interruption, keyed `${incidentId}|${selector}`. */
  returnsAtInterruption: Map<string, number | null>;
  /** False when the route lineage could not be exported: the continuation then gets NO route grant (never a refill). */
  routeKnown: boolean;
  /** True while the continuation admission is awaiting old-work cleanup (still fenceable by stop/intake). */
  admitting?: boolean;
}

/** Sum of two per-key count records. */
function sumCounts(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Code-owned ceilings of one support admission (survival proposal; never above the goal limits). */
export interface GoalCeilings {
  plannerTurns: number;
  tasks: number;
  replans: number;
  deadlineMs: number;
}

export type SubmitResult =
  | { status: 'admitted'; goal: GoalRecord; replacedGoalId?: string }
  /** MB-FLOW-002: acknowledged and being prepared; the active goal keeps its current task until handoff. */
  | { status: 'preparing'; intentId: string; activeGoalId: string | null; supersededIntentId?: string }
  | { status: 'rejected'; reason: SubmitRejection; detail: string }
  /** A later stop or instruction arrived while this one awaited cleanup. */
  | { status: 'superseded' };

export type AnswerResult =
  | { status: 'accepted'; goalId?: string; intentId?: string; ref: string }
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
  task?: { taskId: string; objective: string; mode: TaskMode; startedAtMs: number; capabilities?: string[] };
  /** The last finished task of the latest goal (verified result summary). */
  lastTask?: { taskId: string; status: string; reason: string; detail: string; decisions: number; actions: number; localContinuations: number };
  /** MB-FLOW-002: the single pending (not admitted) instruction, if any. */
  pending?: PendingInstructionStatus;
  /*
   * MB-FLOW-002 fields: always populated by GoalEngine.status(); optional in the
   * type so status consumers built before them (and their fixtures) stay valid.
   */
  /** The active goal finished its admitted task and waits for the pending handoff (no new work starts). */
  parked?: boolean;
  handoff?: HandoffTotals;
  latch?: ControlLatch;
  /** Latest measured gaps between windows (bounded). */
  windowGaps?: WindowGap[];
  /** MB-FLOW-003-C12 held/continuing owner jobs (bounded copies). */
  checkpoints?: ContinuationCheckpoint[];
}

/** What GoalEngine.status() actually returns: the MB-FLOW-002 fields are always present. */
export type FullEngineStatus = EngineStatus & Required<Pick<EngineStatus, 'parked' | 'handoff' | 'latch' | 'windowGaps'>>;

/** Interface for a cleanup step registered by work owned by the active goal. */
export type Cleanup = () => void | Promise<void>;

interface HandoffTimeline {
  receivedAtMs: number;
  acknowledgedAtMs: number;
  draftReadyAtMs?: number;
  handoffStartedAtMs?: number;
  admittedAtMs?: number;
  firstTaskAtMs?: number;
}

/** A plan carried into a goal turn without a new planner call (prepared draft or used lookahead). */
interface CarriedPlan {
  proposal: unknown;
  requestId: string;
  turnKind: PlannerTurnKind;
  source: 'preparation' | 'lookahead';
}

type TurnResultShape = { raw: unknown } | { failure: PlannerFailure };

interface LookaheadState {
  requestId: string;
  abort: AbortController;
  startedAtMs: number;
  readyAtMs?: number;
  promise: Promise<TurnResultShape>;
}

interface ActiveGoal {
  record: GoalRecord;
  epoch: number;
  /** MB-FLOW-001: code-owned source (owner unless the supervisor submitted it). */
  source: GoalSource | undefined;
  /** Planner context of an automatic goal. */
  autonomy?: AutonomyPlannerContext;
  /** Absolute goal deadline. */
  deadlineAtMs: number;
  /** Per-goal planner-turn/task/replan ceilings (the configured limits, or lower for a support admission). */
  caps: { plannerTurns: number; tasks: number; replans: number };
  abort: AbortController;
  cleanups: Set<Cleanup>;
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
  nextTurnKind: PlannerTurnKind;
  outcomeStatus?: { status: 'satisfied' | 'unsatisfied' | 'unknown'; detail: string };
  /** Parked: finished its admitted work while a replacement instruction is pending. */
  parked: boolean;
  /** Set when this goal was admitted through a prepared handoff. */
  handoff?: { intentId: string; generation: number; timeline: HandoffTimeline; recorded: boolean };
  lookahead?: LookaheadState | undefined;
  /** End of the previous window (for measured window gaps). */
  windowEnd?: { atMs: number; afterWindow: number } | undefined;
  nextWindowSource: 'lookahead' | 'replan';
  revalidationMs?: number;
  /** MB-FLOW-003-C12: set on a continuation admission of a held owner job (same goal id). */
  continuation?: HeldEntry;
}

/** The single pending (not admitted) owner instruction. */
interface PendingIntent {
  intentId: string;
  generation: number;
  connectionEpoch: number;
  instruction: string;
  origin: IntakeOrigin;
  abort: AbortController;
  cleanups: Set<Cleanup>;
  state: PendingInstructionState;
  receivedAtMs: number;
  updatedAtMs: number;
  activeGoalId: string | null;
  counters: { plannerTurns: number; knowledgeRounds: number; repairs: number; retries: number; questionRefusals: number };
  knowledge: KnowledgeResult[];
  shown: Map<string, ShownSnapshot>;
  anchors: Set<string>;
  dimension?: string;
  rejection?: string[];
  consecutiveRepairs: number;
  consecutiveRetries: number;
  nextTurnKind: PlannerTurnKind;
  draft?: { proposal: PlannerProposal; requestId: string; turnKind: PlannerTurnKind };
  settled: PromiseWithResolvers<'handed_off' | 'discarded'>;
  /** Bounded cleanup of the discarded preparation's owned planner process (MB-FLOW-002-C3). */
  cleanupDone?: Promise<void>;
  deadline?: NodeJS.Timeout;
  timeline: HandoffTimeline;
}

interface TurnOwner {
  kind: PlannerSlotKind;
  /** Owner revocation (goal abort, pending abort, cancelled lookahead). */
  signal: AbortSignal;
  /** Where the planner process cleanup is registered (awaited by revocation). */
  cleanups: Set<Cleanup>;
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
  safety_interrupted: 'blocked',
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
    case 'safety_blocked':
      // MB-FLOW-003-C11/C13: a hazard without a supported response (declarative blocker); not completion.
      return 'safety_interrupted';
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

const emptyCounters = (): GoalCounters => ({ plannerTurns: 0, knowledgeRounds: 0, repairs: 0, retries: 0, questionRefusals: 0, replans: 0, windows: 0, tasksAdmitted: 0, preparationTurns: 0, lookaheads: 0 });

export class GoalEngine {
  private readonly deps: GoalEngineDeps;
  /** Last goal (active or terminal). Terminal state is kept for status until the next goal. */
  private last: GoalRecord | undefined;
  private active: ActiveGoal | undefined;
  /** MB-FLOW-002: at most one pending (not admitted) instruction. */
  private pending: PendingIntent | undefined;
  /** Incremented on every ownership change; async work compares before acting. */
  private epoch = 0;
  /** Incremented by every stop/instruction so an older pending admission yields. */
  private intakeGeneration = 0;
  /** Resolves when all previously revoked goals have finished cleanup. */
  private cleanupBarrier: Promise<void> = Promise.resolve();
  private closed = false;
  private currentTask: EngineStatus['task'];
  /** INTERNAL planner-facing objective of the current task (preparation context); never owner-visible (MB-PLAN-006). */
  private currentTaskObjective: string | undefined;
  private lastTask: EngineStatus['lastTask'];
  private readonly inFlight = new Set<Promise<void>>();
  /** The single owned planner process. */
  private readonly slot: PlannerSlot;
  private readonly flow: FlowOptions;
  private readonly totals: HandoffTotals;
  private latch: ControlLatch = { paused: false };
  /** Every outstanding (bounded) owned-process cleanup of discarded preparations, superseded ones included (C3a). */
  private readonly preparationCleanups = new Set<Promise<void>>();
  private readonly windowGaps: WindowGap[] = [];
  /** Owner/operator intakes between validation and admission (an automatic admission never overtakes one). */
  private ownerIntakesInFlight = 0;
  /** MB-FLOW-003-C12 held owner jobs by goal id (bounded). */
  private readonly held = new Map<string, HeldEntry>();
  private continuingNow = false;

  constructor(deps: GoalEngineDeps) {
    this.deps = deps;
    this.flow = { ...DEFAULT_FLOW, ...deps.flow };
    this.totals = { preparations: 0, handedOff: 0, discarded: 0, discardedTurns: 0, discardedTurnAllowance: this.flow.preparationTurnsPerRun, transferredTurns: 0, lookaheadTurns: 0, lookaheadsUsed: 0, lookaheadsDiscarded: 0 };
    this.slot = new PlannerSlot(deps.limits.cleanupTimeoutMs, (kind) => deps.store.record({ type: 'planner_slot_wait_timeout', kind, detail: 'an earlier planner process did not settle within the cleanup bound; this turn was not started (bounded failure)' }));
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  /** True while a goal owns control (planning, executing, stopping). */
  get hasActiveGoal(): boolean {
    return this.active !== undefined;
  }

  /** Planner processes running now / at most so far (single-process invariant evidence). */
  get plannerProcesses(): { running: number; maxRunning: number } {
    return { running: this.slot.running, maxRunning: this.slot.maxRunning };
  }

  /** True while a new owner instruction is being prepared (not admitted). */
  get hasPendingInstruction(): boolean {
    return this.pending !== undefined;
  }

  /**
   * Explicit owner pause latch (set by `stop`, cleared only by `resume`).
   * Autonomous follow-up work (e.g. the unassigned MB-FLOW-001 progression
   * scheduler) must not start while it is set; explicit owner instructions are
   * always accepted and do not clear it.
   */
  autonomyAllowed(): boolean {
    return !this.latch.paused && !this.closed;
  }

  /**
   * MB-FLOW-003-C11/C13 immediate-safety authority, computed FRESH on every
   * call from this engine's state only (never from memory/autonomy/survival
   * configuration). Coordinator decision: safety protects every active OWNER
   * goal even while the automatic pause latch is set; without an owner goal it
   * acts only while unpaused; an explicit stop with no newer owner goal, a
   * closed engine or no ready connection is `none` (no idle motion).
   *   owner_goal: an admitted, non-terminal, not-stopping owner goal (latch may be set)
   *   unpaused:   no owner goal and the explicit stop latch is clear
   *   none:       anything else
   */
  safetyAuthority(): { basis: 'owner_goal' | 'unpaused' | 'none'; detail: string; goal: { goalId: string; goalEpoch: number; source: 'owner' | 'support' | 'progression' | 'diagnostic' | 'unknown' } | null } {
    if (this.closed) return { basis: 'none', detail: 'shutting down', goal: null };
    if (!this.deps.isGameReady()) return { basis: 'none', detail: 'not connected', goal: null };
    const a = this.active;
    const live = a && (a.record.state === 'planning' || a.record.state === 'executing') && !a.abort.signal.aborted ? a : undefined;
    type SafetyGoalSource = 'owner' | 'support' | 'progression' | 'diagnostic' | 'unknown';
    const source: SafetyGoalSource | undefined = live ? (live.record.kind === 'operator_task_diagnostic' ? 'diagnostic' : live.source?.kind === 'owner' ? 'owner' : live.source?.kind === 'support' ? 'support' : live.source?.kind === 'progression' ? 'progression' : 'unknown') : undefined;
    const goal = live && source ? { goalId: live.record.id, goalEpoch: live.epoch, source } : null;
    if (live && source === 'owner') return { basis: 'owner_goal', detail: `owner goal ${live.record.id} ${live.record.state}`, goal };
    if (this.latch.paused) return { basis: 'none', detail: 'explicit stop: paused with no newer owner goal', goal };
    return { basis: 'unpaused', detail: goal ? `${source} goal ${goal.goalId} ${live!.record.state}` : 'idle, not paused', goal };
  }

  private safetyAuthorityChanged(cause: 'owner_stop' | 'resume' | 'owner_goal_admitted' | 'goal_terminal'): void {
    try {
      this.deps.onSafetyAuthorityChanged?.(cause);
    } catch (error) {
      this.deps.store.record({ type: 'safety_authority_hook_error', cause, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Clears the pause latch (explicit owner resume). */
  resume(surface: string): { wasPaused: boolean } {
    const wasPaused = this.latch.paused;
    this.latch = { paused: false };
    this.deps.store.record({ type: 'control_resumed', surface, wasPaused });
    this.latchChanged('resume');
    this.safetyAuthorityChanged('resume');
    return { wasPaused };
  }

  /** Startup only: restores a durable latch (MB-FLOW-001 P2) without notifying the hook. */
  restoreLatch(latch: ControlLatch): void {
    this.latch = { ...latch };
    this.deps.store.record({ type: 'control_latch_restored', paused: latch.paused, source: latch.source ?? null });
  }

  private latchChanged(cause: 'owner_stop' | 'resume'): void {
    try {
      this.deps.onLatchChanged?.({ ...this.latch }, cause);
    } catch (error) {
      this.deps.store.record({ type: 'latch_hook_error', cause, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Why an automatic (supervisor) admission may not start NOW, or undefined.
   * Synchronous: an automatic goal never replaces an owner goal, a pending
   * instruction or an owner intake in flight, and never runs while paused.
   */
  automaticBlocker(): { reason: SubmitRejection; detail: string } | undefined {
    if (this.closed) return { reason: 'shutting_down', detail: 'Chunkbot is shutting down' };
    if (!this.deps.isGameReady()) return { reason: 'not_connected', detail: 'not connected to the game' };
    if (this.latch.paused) return { reason: 'paused', detail: 'automatic work is paused (stop latch)' };
    if (this.pending) return { reason: 'busy', detail: 'an owner instruction is being prepared' };
    if (this.ownerIntakesInFlight > 0) return { reason: 'busy', detail: 'an owner instruction is being admitted' };
    if (this.active) return { reason: 'busy', detail: `goal ${this.active.record.id} owns control` };
    return undefined;
  }

  /** Source of the goal that owns control now (undefined: idle or an operator diagnostic). */
  get activeSource(): GoalSource | undefined {
    return this.active?.source;
  }

  /**
   * MB-FLOW-001 single automatic intake: the supervisor's progression or
   * support goal enters through the SAME admission path (replacement, epoch,
   * travel-anchor hook, admission baseline, planner slot, limits) as owner
   * goals. Refused synchronously (no side effects, no owner notice) while
   * anything owner-related or a pause holds. A later owner instruction or stop
   * supersedes it through the intake generation. `replaceAutomatic` lets a
   * support need replace an ACTIVE automatic goal (never an owner goal).
   */
  async submitAutomatic(instruction: string, source: GoalSource, options: { context?: AutonomyPlannerContext; ceilings?: GoalCeilings; replaceAutomatic?: boolean } = {}): Promise<SubmitResult> {
    const origin: IntakeOrigin = { surface: 'supervisor', principal: 'supervisor' };
    if (source.kind === 'owner') return this.rejectQuiet('invalid_task', 'owner goals use submit', origin);
    if (source.kind === 'support' && source.execution !== 'planner_goal') return this.rejectQuiet('invalid_task', 'a code_task support routine uses submitSupportTask', origin);
    const blocker = this.automaticBlockerFor(options.replaceAutomatic === true);
    if (blocker) return this.rejectQuiet(blocker.reason, blocker.detail, origin);
    const text = instruction.trim();
    if (text.length === 0 || text.length > BOUNDS.longText) return this.rejectQuiet(text.length === 0 ? 'empty' : 'too_long', 'automatic instruction out of bounds', origin);
    const admitted = await this.admit(text, origin, 'owner_goal', undefined, {
      source,
      ...(options.context ? { autonomy: options.context } : {}),
      ...(options.ceilings ? { ceilings: options.ceilings } : {}),
    });
    if (admitted.status !== 'admitted') return admitted.result;
    const label = source.kind === 'support' ? `Automatic ${source.priority === 'safety' ? 'safety' : 'support'} routine (${source.routine})` : 'Automatic progression';
    this.deps.notify({ goalId: admitted.active.record.id, text: `${label} goal ${admitted.active.record.id} started: ${truncate(source.kind === 'support' ? source.reason : 'assessing a useful, attainable milestone', 160)}. Say stop to pause automatic work.` });
    this.track(this.plan(admitted.active));
    return admitted.result;
  }

  /** As automaticBlocker; with `replaceAutomatic`, an ACTIVE automatic goal may be replaced (support over progression). */
  private automaticBlockerFor(replaceAutomatic: boolean): { reason: SubmitRejection; detail: string } | undefined {
    const b = this.automaticBlocker();
    if (b && replaceAutomatic && b.reason === 'busy' && this.active && !this.pending && this.ownerIntakesInFlight === 0 && this.active.source && this.active.source.kind !== 'owner') return undefined;
    return b;
  }

  /**
   * MB-FLOW-001 x MB-FLOW-003: a survival `code_task` (small preapproved
   * eat/rest TaskSpec built by code) admitted through the SAME admission path
   * (replacement, epoch, admission hook — where the low-health allowance is
   * granted — travel anchor) and run by the SAME task runtime, Jev choice,
   * fenced executor and lease. No planner turn. The task's completion
   * predicate is the goal outcome, verified by code. Never reachable from chat
   * and never labeled an operator diagnostic.
   */
  async submitSupportTask(rawSpec: unknown, mode: TaskMode, source: GoalSource, options: { ceilings?: GoalCeilings; replaceAutomatic?: boolean } = {}): Promise<SubmitResult> {
    const origin: IntakeOrigin = { surface: 'supervisor', principal: 'supervisor' };
    if (source.kind !== 'support' || source.execution !== 'code_task') return this.rejectQuiet('invalid_task', 'only survival code_task support uses submitSupportTask', origin);
    if (!this.deps.tasks) return this.rejectQuiet('tasks_not_installed', 'the generic task runtime is not installed', origin);
    const blocker = this.automaticBlockerFor(options.replaceAutomatic === true);
    if (blocker) return this.rejectQuiet(blocker.reason, blocker.detail, origin);
    const parsed = TaskSpecSchema.safeParse(rawSpec);
    if (!parsed.success) return this.rejectQuiet('invalid_task', `invalid support TaskSpec: ${parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`, origin);
    const spec = parsed.data;
    const unknown = spec.allowedCapabilities.filter((c) => !this.deps.capabilities.has(c));
    if (unknown.length > 0) return this.rejectQuiet('invalid_task', `support TaskSpec names capabilities that are not implemented: ${unknown.join(', ')}`, origin);
    if (!isPredicateWithinDepth(spec.completion)) return this.rejectQuiet('invalid_task', 'support completion predicate nesting exceeds the supported depth', origin);
    const label = truncate(`[support ${source.routine}] ${spec.objective}`, BOUNDS.longText);
    const admitted = await this.admit(label, origin, 'support_task', undefined, { source, ...(options.ceilings ? { ceilings: options.ceilings } : {}) });
    if (admitted.status !== 'admitted') return admitted.result;
    const active = admitted.active;
    this.deps.notify({ goalId: active.record.id, text: `Automatic ${source.priority === 'safety' ? 'safety' : 'support'} routine (${source.routine}) ${active.record.id}: ${truncate(source.reason, 160)}. Say stop to pause automatic work.` });
    active.admittedTasks += 1;
    active.counters.tasksAdmitted += 1;
    this.track(this.runSupportTask(active, spec, mode));
    return admitted.result;
  }

  private async runSupportTask(active: ActiveGoal, spec: TaskSpec, mode: TaskMode): Promise<void> {
    try {
      await this.captureBaseline(active);
      if (!(await this.passBarrier(active))) return;
      const result = await this.runTask(active, spec, mode);
      if (!result || result.status === 'cancelled' || this.active !== active) return;
      const reason = terminalForTask(result);
      await this.finishIfCurrent(active, reason, `${result.status === 'completed' ? 'support task completion verified by code' : `support task ${result.status} (${result.reason})`}: ${result.detail}; decisions ${result.decisions}, actions ${result.actions}`);
    } catch (error) {
      if (error instanceof StaleWorkError || this.active !== active) return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.record({ type: 'task_runtime_error', goalId: active.record.id, message });
      await this.finishIfCurrent(active, 'runtime_error', truncate(message, 300));
    }
  }

  /**
   * MB-FLOW-003 safety decision (`revoke_unsafe`): synchronously revokes the
   * ACTIVE goal — any source, owner included — as `safety_interrupted`. A
   * pending owner instruction is untouched (it still takes priority over
   * support). The supervisor keeps the interrupted owner intent visible.
   */
  async revokeForSafety(detail: string): Promise<{ revoked: boolean; goalId?: string; source?: GoalSource }> {
    const active = this.active;
    if (!active) return { revoked: false };
    ++this.intakeGeneration;
    this.deps.store.record({ type: 'safety_revocation', goalId: active.record.id, source: active.source ?? null, detail: truncate(detail, 300) });
    await this.revoke(active, 'safety_interrupted', detail, true);
    return { revoked: true, goalId: active.record.id, ...(active.source ? { source: active.source } : {}) };
  }

  private rejectQuiet(reason: SubmitRejection, detail: string, origin: IntakeOrigin): SubmitResult {
    this.deps.store.record({ type: 'automatic_intake_refused', reason, detail: truncate(detail, 200), surface: origin.surface });
    return { status: 'rejected', reason, detail };
  }

  /** The single intake surface for every natural-language instruction (chat or terminal). */
  async submit(instruction: string, origin: IntakeOrigin): Promise<SubmitResult> {
    const receivedAtMs = this.deps.clock.now();
    const text = instruction.trim();
    const invalid = this.validateIntake(text, origin);
    if (invalid) return invalid;
    // MB-FLOW-003-C12: a new owner instruction supersedes held jobs synchronously.
    this.fenceHeld('superseded_by_owner', 'new_owner_instruction');
    const route = this.intakeRoute();
    if (route === 'prepare') return this.startPreparation(text, origin, receivedAtMs);
    if (route === 'allowance_exhausted') {
      this.deps.store.record({ type: 'preparation_allowance_exhausted', discardedTurns: this.totals.discardedTurns, allowance: this.totals.discardedTurnAllowance });
      this.deps.notify({ text: `The per-run allowance for preparing instructions in the background (${this.totals.discardedTurnAllowance} planner turns of discarded drafts) is used up; switching to your new instruction directly.` });
    }
    this.ownerIntakesInFlight += 1;
    let admitted: Awaited<ReturnType<GoalEngine['admit']>>;
    try {
      admitted = await this.admit(text, origin, 'owner_goal', undefined, { source: { kind: 'owner' } });
    } finally {
      this.ownerIntakesInFlight -= 1;
    }
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
    this.fenceHeld('superseded_by_owner', 'operator_task');
    const admitted = await this.admit(truncate(label, BOUNDS.longText), origin, 'operator_task_diagnostic');
    if (admitted.status !== 'admitted') return admitted.result;
    const active = admitted.active;
    this.deps.notify({ goalId: active.record.id, audience: 'operator', text: `Operator task diagnostic ${active.record.id} admitted (${mode}): "${truncate(spec.objective, 120)}" — generic task controller with real Jev choices; not natural-language goal planning.` });
    active.admittedTasks += 1;
    this.track(this.runDiagnosticTask(active, spec, mode));
    return admitted.result;
  }

  private validateIntake(text: string, origin: IntakeOrigin, max = this.deps.limits.maxInstructionChars): SubmitResult | undefined {
    // Validation happens before any existing (active or pending) work is touched.
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

  /**
   * Smooth preparation applies while an owner goal is EXECUTING (its admitted
   * task keeps running) or while an earlier instruction is still pending.
   * Planning/idle states have no task to continue: direct admission.
   */
  private intakeRoute(): 'prepare' | 'direct' | 'allowance_exhausted' {
    if (this.flow.handoff !== 'smooth') return 'direct';
    const executing = this.active !== undefined && this.active.record.kind === undefined && this.active.record.state === 'executing';
    if (!this.pending && !executing) return 'direct';
    if (this.totals.discardedTurns >= this.totals.discardedTurnAllowance) return 'allowance_exhausted';
    return 'prepare';
  }

  // ------------------------------------------------------------ preparation (MB-FLOW-002)

  private startPreparation(text: string, origin: IntakeOrigin, receivedAtMs: number): SubmitResult {
    const generation = ++this.intakeGeneration;
    const superseded = this.pending;
    if (superseded) this.discardPending(superseded, 'superseded', 'replaced by a newer owner instruction', false);
    const now = this.deps.clock.now();
    const active = this.active;
    const pending: PendingIntent = {
      intentId: this.deps.ids.next('intent'),
      generation,
      connectionEpoch: this.deps.connectionEpoch?.() ?? 0,
      instruction: text,
      origin,
      abort: new AbortController(),
      cleanups: new Set(),
      state: 'preparing',
      receivedAtMs,
      updatedAtMs: now,
      activeGoalId: active?.record.id ?? null,
      counters: { plannerTurns: 0, knowledgeRounds: 0, repairs: 0, retries: 0, questionRefusals: 0 },
      knowledge: [],
      shown: new Map(),
      anchors: new Set(),
      consecutiveRepairs: 0,
      consecutiveRetries: 0,
      nextTurnKind: 'initial',
      settled: Promise.withResolvers(),
      timeline: { receivedAtMs, acknowledgedAtMs: now },
    };
    // Owner preparation takes priority over a speculative lookahead turn, whether
    // it is running (the slot holder) or still waiting for the slot.
    const hadLookahead = Boolean(active?.lookahead);
    if (active?.lookahead) this.dropLookahead(active, 'owner instruction preparation takes priority');
    if (this.slot.preemptLookahead('owner instruction preparation takes priority') || hadLookahead) this.deps.store.record({ type: 'lookahead_preempted', intentId: pending.intentId });
    pending.deadline = setTimeout(() => this.discardPending(pending, 'limit_exhausted', `preparation deadline of ${Math.round(this.deps.limits.goalDeadlineMs / 1000)}s reached`), this.deps.limits.goalDeadlineMs);
    pending.deadline.unref?.();
    this.pending = pending;
    this.totals.preparations += 1;
    const task = this.currentTask && active ? this.currentTask : undefined;
    this.deps.store.record({
      type: 'instruction_preparing',
      intentId: pending.intentId,
      generation,
      connectionEpoch: pending.connectionEpoch,
      surface: origin.surface,
      instruction: truncate(text, BOUNDS.text),
      activeGoalId: pending.activeGoalId,
      continuingTaskId: task?.taskId ?? null,
      supersededIntentId: superseded?.intentId ?? null,
      receivedAtMs,
      acknowledgedAtMs: now,
    });
    const continuing = task ? 'continuing the current task until handoff' : active ? `goal ${active.record.id} starts no new work until handoff` : 'nothing else is running';
    this.deps.notify({ intentId: pending.intentId, text: `Preparing your new instruction${superseded ? ' (replacing the earlier pending one)' : ''}: "${truncate(text, 120)}"; ${continuing}.` });
    this.track(this.prepare(pending));
    return { status: 'preparing', intentId: pending.intentId, activeGoalId: pending.activeGoalId, ...(superseded ? { supersededIntentId: superseded.intentId } : {}) };
  }

  /** All outstanding discarded-preparation cleanups (each already bounded by cleanupTimeoutMs). */
  private preparationCleanupsDone(): Promise<void> {
    return Promise.all([...this.preparationCleanups]).then(() => undefined);
  }

  private pendingCurrent(p: PendingIntent): boolean {
    return this.pending === p && !p.abort.signal.aborted && p.generation === this.intakeGeneration && !this.closed;
  }

  private assertPending(p: PendingIntent): void {
    if (!this.pendingCurrent(p)) throw new StaleWorkError();
  }

  /**
   * Ends a pending instruction without admission. Idempotent; never touches the
   * active goal. Synchronous part: ownership is invalidated and its planner
   * process aborted at once. Its owned process cleanup is then awaited (bounded,
   * `p.cleanupDone`): stop/lifecycle/shutdown await it, and the intent settles
   * (a parked old goal may resume) only after it (MB-FLOW-002-C3).
   */
  private discardPending(p: PendingIntent, reason: PreparationDiscardReason, detail: string, notify = true): void {
    if (this.pending !== p) return;
    this.pending = undefined;
    if (p.deadline) clearTimeout(p.deadline);
    p.abort.abort(new Error(reason));
    const cleanups = [...p.cleanups];
    p.cleanupDone = cleanups.length === 0
      ? Promise.resolve()
      : withTimeout(Promise.allSettled(cleanups.map(async (fn) => fn())).then(() => undefined), this.deps.limits.cleanupTimeoutMs, () => new Error('preparation cleanup timeout')).then(
          () => this.deps.store.record({ type: 'preparation_cleanup', intentId: p.intentId, cleanups: cleanups.length, outcome: 'settled' }),
          () => this.deps.store.record({ type: 'preparation_cleanup', intentId: p.intentId, cleanups: cleanups.length, outcome: 'timeout', boundMs: this.deps.limits.cleanupTimeoutMs }),
        );
    const done = p.cleanupDone;
    this.preparationCleanups.add(done);
    void done.finally(() => this.preparationCleanups.delete(done));
    this.track(done);
    this.releasePreparation(p.intentId);
    this.totals.discarded += 1;
    this.totals.discardedTurns += p.counters.plannerTurns;
    this.deps.store.record({ type: 'preparation_discarded', intentId: p.intentId, generation: p.generation, reason, detail: truncate(detail, BOUNDS.text), plannerTurns: p.counters.plannerTurns, discardedTurns: this.totals.discardedTurns, allowance: this.totals.discardedTurnAllowance, activeGoalId: this.active?.record.id ?? null });
    this.deps.journal?.record({ type: 'preparation_discarded', intentId: p.intentId, reason, detail: truncate(detail, BOUNDS.text), plannerTurns: p.counters.plannerTurns });
    try {
      this.deps.onPreparationDiscarded?.({ intentId: p.intentId, instruction: p.instruction, reason, detail: truncate(detail, BOUNDS.text) });
    } catch (error) {
      this.deps.store.record({ type: 'preparation_hook_error', intentId: p.intentId, message: error instanceof Error ? error.message : String(error) });
    }
    if (notify) {
      const continuing = this.active ? ` Continuing goal ${this.active.record.id}.` : '';
      const text =
        reason === 'owner_stop'
          ? 'Stopped: the pending new instruction was discarded.'
          : reason === 'lifecycle'
            ? `The pending new instruction was discarded: ${truncate(detail, 160)}.`
            : `Your new instruction was not started (${reason}): ${truncate(detail, 320)}.${continuing}`;
      this.deps.notify({ intentId: p.intentId, text });
    }
    void p.cleanupDone.then(() => p.settled.resolve('discarded'));
  }

  private preparationRequest(p: PendingIntent, snapshot: ObservationSnapshot | null, requestId: string): PlannerRequest {
    const { limits, capabilities } = this.deps;
    const maxReplans = limits.replans ?? 8;
    const c = p.counters;
    const task = this.active && this.currentTask ? this.currentTask : undefined;
    return {
      requestId,
      subject: { kind: 'preparation', intentId: p.intentId, generation: p.generation, connectionEpoch: p.connectionEpoch, activeGoalId: this.active?.record.id ?? null },
      instruction: p.instruction,
      turn: c.plannerTurns,
      maxTurns: limits.plannerTurnsPerGoal,
      catalog: capabilities.catalog(),
      observation: snapshot,
      knowledge: [...p.knowledge],
      turnKind: p.nextTurnKind,
      preparation: {
        continuingTask: task ? (this.currentTaskObjective ?? task.objective) : null,
        inventory: 'provisional_client_model',
        note: 'not admitted yet: earlier work may still change the world and inventory; code captures the server-confirmed admission inventory and revalidates this plan at the switch',
      },
      counters: { ...emptyCounters(), plannerTurns: c.plannerTurns, knowledgeRounds: c.knowledgeRounds, repairs: c.repairs, retries: c.retries, questionRefusals: c.questionRefusals, preparationTurns: c.plannerTurns },
      remaining: { plannerTurns: limits.plannerTurnsPerGoal - c.plannerTurns, tasks: limits.totalTaskCeiling, replans: maxReplans, deadlineMs: limits.goalDeadlineMs, windowSteps: limits.planWindowSteps },
      ownerCoordinates: ownerCoordinates(p.instruction),
      priorResults: [],
      ...(p.rejection ? { rejection: { problems: p.rejection } } : {}),
      ...(this.deps.mechanicsVersion ? { mechanicsVersion: this.deps.mechanicsVersion } : {}),
      limits: { travelRadius: limits.travelRadius ?? 128, observationRadius: limits.observationRadius ?? 32, planWindowSteps: limits.planWindowSteps },
      ...this.memoryField({ kind: 'preparation', intentId: p.intentId, generation: p.generation, connectionEpoch: p.connectionEpoch, activeGoalId: this.active?.record.id ?? null }, requestId, p.instruction, snapshot),
    };
  }

  private memoryField(subject: PlannerRequest['subject'], requestId: string, instruction: string, snapshot: ObservationSnapshot | null): { memory?: MemoryView } {
    const view = this.memoryView(subject, requestId, instruction, snapshot);
    return view ? { memory: view } : {};
  }

  /** Bounded preparation turns for a pending instruction: read-only context, no action. */
  private async prepare(p: PendingIntent): Promise<void> {
    const { planner, knowledge, observation, capabilities, limits } = this.deps;
    const maxRepairs = limits.maxConsecutiveRepairs ?? 2;
    const maxRetries = limits.maxConsecutiveRetries ?? 1;
    const c = p.counters;
    try {
      this.assertPending(p);
      const readiness = planner.readiness();
      if (!readiness.ready) {
        this.discardPending(p, 'planner_not_ready', `${readiness.detail}. No game actions were taken for it`);
        return;
      }
      while (true) {
        this.assertPending(p);
        if (c.plannerTurns >= limits.plannerTurnsPerGoal) {
          this.discardPending(p, 'limit_exhausted', `planner turn limit (${limits.plannerTurnsPerGoal}) reached while preparing`);
          return;
        }
        // Read-only filtered snapshot (no packets, resync, interface or lease). Epoch 0: it belongs to no goal.
        const snapshot = await observation.snapshot(0).catch(() => null);
        this.assertPending(p);
        this.rememberShown(p, snapshot);
        c.plannerTurns += 1;
        p.updatedAtMs = this.deps.clock.now();
        const turnKind = p.nextTurnKind;
        const requestId = this.deps.ids.next('req');
        const request = this.preparationRequest(p, snapshot, requestId);
        this.deps.store.record({ type: 'planner_request', intentId: p.intentId, generation: p.generation, requestId, turn: c.plannerTurns, turnKind, preparation: true, snapshotId: snapshot?.id ?? null });
        const r = await this.plannerTurn({ kind: 'preparation', signal: p.abort.signal, cleanups: p.cleanups }, request);
        this.assertPending(p);
        if ('failure' in r) {
          const failure = r.failure;
          this.deps.store.record({ type: 'planner_failure', intentId: p.intentId, requestId, kind: failure.kind, detail: truncate(failure.detail, 400), preparation: true });
          switch (failure.kind) {
            case 'invalid_output':
              if (this.repairPending(p, requestId, 'invalid_output', failure.problems ?? [failure.detail], maxRepairs)) continue;
              return;
            case 'timeout':
            case 'process_error':
            case 'aborted':
              if (p.consecutiveRetries < maxRetries) {
                p.consecutiveRetries += 1;
                c.retries += 1;
                p.nextTurnKind = 'retry';
                continue;
              }
              this.discardPending(p, 'planner_error', `${failure.kind}: ${truncate(failure.detail, 200)} (after ${maxRetries} bounded retr${maxRetries === 1 ? 'y' : 'ies'})`);
              return;
            case 'model_mismatch':
            case 'prohibited_event':
              this.discardPending(p, 'planner_error', `${failure.kind}: ${truncate(failure.detail, 200)}; the planner is disabled for this run and no fallback is used`);
              return;
            default:
              this.discardPending(p, 'planner_not_ready', `${failure.kind}: ${truncate(failure.detail, 160)} — ${PLANNER_ADVICE[failure.kind] ?? 'planner unavailable'}`);
              return;
          }
        }
        p.consecutiveRetries = 0;
        const check = checkProposal(
          r.raw,
          capabilities,
          { planWindowSteps: limits.planWindowSteps, remainingTaskAllowance: limits.totalTaskCeiling },
          {
            ...(this.deps.registry ? { registry: this.deps.registry } : {}),
            shown: p.shown,
            anchors: p.anchors,
            ...(p.dimension ? { dimension: p.dimension } : {}),
            ownerCoordinates: request.ownerCoordinates ?? [],
            priorResults: new Set(),
            ownerText: p.instruction,
            ...(this.deps.memory ? { memory: { refs: this.deps.memory.shownPreparedRefs({ intentId: p.intentId, generation: p.generation }), kind: 'prepared' as const } } : {}),
            ...this.proposalExtras(undefined),
          },
        );
        if (!check.ok) {
          if (this.repairPending(p, requestId, check.kind, check.problems, maxRepairs)) continue;
          return;
        }
        const proposal = check.proposal;
        p.consecutiveRepairs = 0;
        delete p.rejection;
        this.deps.store.record({ type: 'planner_proposal', intentId: p.intentId, requestId, turn: c.plannerTurns, disposition: proposal.disposition, interpretation: proposal.interpretation, preparation: true });
        this.deps.journal?.record({ type: 'preparation_proposal_accepted', intentId: p.intentId, requestId, turn: c.plannerTurns, turnKind, disposition: proposal.disposition, proposal: proposal as unknown as Record<string, unknown> });
        switch (proposal.disposition) {
          case 'needs_information': {
            const results = await raceAbort(knowledge.answer(proposal.queries, p.abort.signal), p.abort.signal);
            this.assertPending(p);
            c.knowledgeRounds += 1;
            p.knowledge.push(...results.slice(0, BOUNDS.listSmall));
            if (p.knowledge.length > 48) p.knowledge.splice(0, p.knowledge.length - 48);
            p.nextTurnKind = 'knowledge';
            continue;
          }
          case 'cannot_execute':
            // MB-PLAN-006: the planner's wording stays internal (journal); the owner sees an app-owned blocker.
            this.discardPending(p, 'cannot_execute', publicBlocker({ missingCapabilities: proposal.missingCapabilities, feedback: [] }));
            return;
          case 'plan': {
            const now = this.deps.clock.now();
            p.draft = { proposal, requestId, turnKind };
            p.timeline.draftReadyAtMs = now;
            this.deps.store.record({ type: 'preparation_draft_ready', intentId: p.intentId, generation: p.generation, requestId, tasks: proposal.tasks.length, plannerTurns: c.plannerTurns, elapsedMs: now - p.receivedAtMs });
            await this.handoff(p);
            return;
          }
        }
      }
    } catch (error) {
      if (error instanceof StaleWorkError || !this.pendingCurrent(p)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.record({ type: 'preparation_error', intentId: p.intentId, message });
      this.discardPending(p, 'planner_error', truncate(message, 300));
    }
  }

  private repairPending(p: PendingIntent, requestId: string, kind: string, problems: string[], maxRepairs: number): boolean {
    const question = isOwnerQuestionProblem(problems);
    if (question) {
      p.counters.questionRefusals += 1;
      this.deps.store.record({ type: 'planner_question_refused', intentId: p.intentId, requestId, preparation: true, refusals: p.counters.questionRefusals });
    }
    this.deps.store.record({ type: 'planner_proposal_rejected', intentId: p.intentId, requestId, kind, problems: problems.slice(0, 12), preparation: true });
    this.deps.journal?.record({ type: 'preparation_proposal_rejected', intentId: p.intentId, requestId, kind, problems: problems.slice(0, 12) });
    if (p.consecutiveRepairs < maxRepairs) {
      p.consecutiveRepairs += 1;
      p.counters.repairs += 1;
      p.rejection = problems.slice(0, 12);
      p.nextTurnKind = 'repair';
      return true;
    }
    // A question is never relayed: the blocker text is app-owned.
    this.discardPending(p, kind === 'unknown_capabilities' ? 'cannot_execute' : 'invalid_proposal', question ? questionBlockerText(maxRepairs) : `${problems.slice(0, 2).join('; ')} (after ${maxRepairs} repair turn${maxRepairs === 1 ? '' : 's'})`);
    return false;
  }

  /**
   * Valid draft: revoke the old owner (bounded cleanup), admit the new goal
   * (travel anchor + server-confirmed admission baseline), then revalidate the
   * draft against fresh state inside the goal's own loop before any action.
   */
  private async handoff(p: PendingIntent): Promise<void> {
    p.state = 'handing_off';
    p.updatedAtMs = this.deps.clock.now();
    p.timeline.handoffStartedAtMs = p.updatedAtMs;
    this.deps.store.record({ type: 'handoff_started', intentId: p.intentId, generation: p.generation, replacingGoalId: this.active?.record.id ?? null });
    if (!this.deps.isGameReady() || (this.deps.connectionEpoch && this.deps.connectionEpoch() !== p.connectionEpoch)) {
      this.discardPending(p, 'not_connected', 'the game connection changed before the switch');
      return;
    }
    const admitted = await this.admit(p.instruction, p.origin, 'owner_goal', p, { source: { kind: 'owner' } });
    if (admitted.status !== 'admitted') {
      if (this.pending === p) this.discardPending(p, this.closed ? 'shutdown' : 'superseded', 'superseded during the switch', !this.closed);
      return;
    }
    const active = admitted.active;
    const draft = p.draft!;
    this.deps.notify({
      goalId: active.record.id,
      text: `Goal ${active.record.id} accepted: "${truncate(p.instruction, 120)}" (prepared while the previous work continued; ${p.counters.plannerTurns} planner turn${p.counters.plannerTurns === 1 ? '' : 's'}). Checking the plan against the current world…`,
    });
    this.track(this.plan(active, { proposal: draft.proposal, requestId: draft.requestId, turnKind: draft.turnKind, source: 'preparation' }));
  }

  /** Bounded memory view for one planner request (MB-MEM-001); undefined when memory is not installed. */
  private memoryView(subject: PlannerRequest['subject'], requestId: string, instruction: string, snapshot: ObservationSnapshot | null): MemoryView | undefined {
    const memory = this.deps.memory;
    if (!memory) return undefined;
    try {
      return memory.view({
        subject,
        requestId,
        instruction,
        answers: [],
        observation: snapshot ? { dimension: snapshot.dimension, self: { at: snapshot.self.at }, connectionEpoch: snapshot.connectionEpoch } : null,
      });
    } catch (error) {
      this.deps.store.record({ type: 'memory_view_error', requestId, message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  private releasePreparation(intentId: string): void {
    try {
      this.deps.memory?.releasePreparation(intentId);
    } catch (error) {
      this.deps.store.record({ type: 'memory_release_error', intentId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * After the REAL admission: every prepared memory ref (mprep-) in a draft is
   * re-grounded to a fresh executable ref of the SAME fact, or the draft is
   * stale (fail closed). The preparation's refs are released only afterwards.
   */
  private regroundMemoryRefs(active: ActiveGoal, proposal: unknown, requestId: string, snapshot: ObservationSnapshot | null): { proposal: unknown; problems: string[]; regrounded: number } {
    const memory = this.deps.memory;
    const h = active.handoff;
    const problems: string[] = [];
    let regrounded = 0;
    // One fresh executable ref per prepared ref (the same fact may be named by selectors, completion and outcome).
    const done = new Map<string, string | null>();
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (!v || typeof v !== 'object') return v;
      const o = v as Record<string, unknown>;
      if (o['kind'] === 'memory_ref' && typeof o['refId'] === 'string' && o['refId'].startsWith('mprep-')) {
        const refId = o['refId'];
        const known = done.get(refId);
        if (known !== undefined) return known === null ? { ...o } : { ...o, refId: known };
        if (!memory || !h || !snapshot) {
          done.set(refId, null);
          problems.push(`${refId}: a prepared memory reference cannot be re-grounded (${!memory ? 'memory not installed' : !snapshot ? 'no current observation' : 'not a prepared handoff'})`);
          return { ...o };
        }
        const r = memory.regroundPrepared(refId, { intentId: h.intentId, generation: h.generation, goalId: active.record.id, goalEpoch: active.epoch, requestId, connectionEpoch: snapshot.connectionEpoch, dimension: snapshot.dimension });
        if ('error' in r) {
          done.set(refId, null);
          if (problems.length < 12) problems.push(`${refId} no longer names the same remembered fact (${r.error}): ${truncate(r.detail, 160)}; re-plan from the current memory view`);
          return { ...o };
        }
        done.set(refId, r.refId);
        regrounded += 1;
        return { ...o, refId: r.refId };
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    };
    if (!proposal || typeof proposal !== 'object' || !Array.isArray((proposal as Record<string, unknown>)['tasks'])) return { proposal, problems, regrounded };
    const r = proposal as Record<string, unknown>;
    // The outcome is walked only while it is not bound yet (prepared drafts); an accepted outcome is immutable.
    const out = { ...r, tasks: (r['tasks'] as unknown[]).map(walk), ...(r['outcome'] && !active.outcome ? { outcome: walk(r['outcome']) } : {}) };
    return { proposal: out, problems, regrounded };
  }

  private rememberShown(target: { shown: Map<string, ShownSnapshot>; anchors: Set<string>; dimension?: string }, snapshot: ObservationSnapshot | null): void {
    if (!snapshot) return;
    const handles = new Set<string>([...snapshot.blocks, ...snapshot.entities, ...snapshot.drops].map((t) => t.handle));
    for (const f of snapshot.frontiers) handles.add(f.handle);
    for (const g of snapshot.groups ?? []) handles.add(g.handle);
    target.shown.set(snapshot.id, { handles, dimension: snapshot.dimension });
    while (target.shown.size > 4) target.shown.delete(target.shown.keys().next().value as string);
    for (const a of snapshot.remembered) target.anchors.add(a.anchorId);
    target.dimension = snapshot.dimension;
  }

  // ------------------------------------------------------------ admission

  /** Replacement, epoch, record and synchronous admission hook (travel anchor) — shared by every intake. */
  private async admit(
    text: string,
    origin: IntakeOrigin,
    kind: GoalKind,
    prepared?: PendingIntent,
    extras: { source?: GoalSource; autonomy?: AutonomyPlannerContext; ceilings?: GoalCeilings; continuation?: HeldEntry } = {},
  ): Promise<{ status: 'admitted'; active: ActiveGoal; result: SubmitResult } | { status: 'not_admitted'; result: SubmitResult }> {
    if (!prepared && this.pending) this.discardPending(this.pending, 'superseded', 'replaced by a directly admitted instruction', false);
    const generation = prepared ? prepared.generation : ++this.intakeGeneration;
    const replaced = this.active?.record.id;
    // Valid replacement: revoke old ownership and await its cleanup BEFORE planning.
    await this.revokeActive('replaced', prepared ? 'replaced by the prepared owner instruction (handoff)' : 'replaced by a new owner instruction');
    if (generation !== this.intakeGeneration || this.closed || (prepared && this.pending !== prepared)) {
      this.deps.store.record({ type: 'goal_admission_superseded', surface: origin.surface, ...(prepared ? { intentId: prepared.intentId } : {}) });
      return { status: 'not_admitted', result: { status: 'superseded' } };
    }

    this.epoch += 1;
    const now = this.deps.clock.now();
    const cont = extras.continuation;
    const record: GoalRecord = {
      // MB-FLOW-003-C12: a continuation keeps the SAME logical goal id (fresh epoch).
      id: cont ? cont.cp.goalId : this.deps.ids.next('goal'),
      ...(kind === 'owner_goal' ? {} : { kind }),
      epoch: this.epoch,
      instruction: text,
      origin,
      state: 'planning',
      admittedAtMs: now,
      updatedAtMs: now,
      plannerTurns: 0,
      progress: '',
      ...(extras.source ? { source: extras.source } : {}),
      ...(cont ? { continuation: { number: cont.cp.continuations.used, max: cont.cp.continuations.max, after: cont.cp.interruptions.at(-1)?.reason ?? 'interruption' } } : {}),
    };
    const lim = this.deps.limits;
    const cl = extras.ceilings;
    // A continuation keeps the ORIGINAL absolute deadline and ORIGINAL caps (never a fresh allowance).
    const deadlineAtMs = cont ? cont.cp.deadlineAtMs : now + (cl ? Math.min(cl.deadlineMs, lim.goalDeadlineMs) : lim.goalDeadlineMs);
    const caps = cont ? { ...cont.cp.caps } : {
      plannerTurns: cl ? Math.min(cl.plannerTurns, lim.plannerTurnsPerGoal) : lim.plannerTurnsPerGoal,
      tasks: cl ? Math.min(cl.tasks, lim.totalTaskCeiling) : lim.totalTaskCeiling,
      replans: cl ? Math.min(cl.replans, lim.replans ?? 8) : (lim.replans ?? 8),
    };
    const active: ActiveGoal = {
      record,
      epoch: this.epoch,
      source: extras.source,
      ...(extras.autonomy ? { autonomy: extras.autonomy } : {}),
      deadlineAtMs,
      caps,
      abort: new AbortController(),
      cleanups: new Set(),
      knowledge: [],
      admittedTasks: 0,
      deadline: undefined,
      feedback: [],
      counters: emptyCounters(),
      shown: new Map(),
      anchors: new Set(),
      priorResults: new Map(),
      consecutiveRepairs: 0,
      consecutiveRetries: 0,
      nextTurnKind: 'initial',
      parked: false,
      nextWindowSource: 'replan',
      ...(cont ? { continuation: cont } : {}),
    };
    if (cont) {
      // ALL cumulative counters continue (incl. questionRefusals and any legacy history field); nothing resets.
      active.counters = { ...cont.cp.counters } as GoalCounters;
      record.plannerTurns = active.counters.plannerTurns;
      active.admittedTasks = cont.cp.admittedTasks;
      active.knowledge = [...cont.knowledge];
    }
    if (prepared) {
      // The pending instruction becomes this goal: its turns count against THIS goal.
      if (prepared.deadline) clearTimeout(prepared.deadline);
      this.pending = undefined;
      const pc = prepared.counters;
      Object.assign(active.counters, { plannerTurns: pc.plannerTurns, knowledgeRounds: pc.knowledgeRounds, repairs: pc.repairs, retries: pc.retries, questionRefusals: pc.questionRefusals, preparationTurns: pc.plannerTurns });
      record.plannerTurns = pc.plannerTurns;
      active.knowledge = [...prepared.knowledge];
      active.handoff = { intentId: prepared.intentId, generation: prepared.generation, timeline: { ...prepared.timeline, admittedAtMs: now }, recorded: false };
      this.totals.handedOff += 1;
      this.totals.transferredTurns += pc.plannerTurns;
      prepared.settled.resolve('handed_off');
    }
    // The record shows the live counters (one object; never reset across windows).
    if (kind === 'owner_goal' || kind === 'support_task') record.counters = active.counters;
    active.deadline = setTimeout(() => {
      void this.finishIfCurrent(active, 'limit_exhausted', `goal deadline of ${Math.round((deadlineAtMs - now) / 1000)}s reached${cl ? ' (support ceiling)' : ''}`);
    }, Math.max(0, deadlineAtMs - now));
    active.deadline.unref?.();
    this.active = active;
    this.last = record;
    this.currentTask = undefined;
    this.lastTask = undefined;
    try {
      this.deps.onGoalAdmitted?.({ goalId: record.id, epoch: record.epoch, admittedAtMs: now, instruction: text, kind, ...(extras.source ? { source: extras.source } : {}), deadlineAtMs, ownerCoordinates: extras.source?.kind === 'owner' ? ownerCoordinates(text) : [], ...(cont ? { continuation: { number: cont.cp.continuations.used, anchor: cont.cp.anchor, route: cont.routeKnown ? cont.cp.route : undefined } } : {}) });
    } catch (error) {
      this.deps.store.record({ type: 'goal_admission_hook_error', goalId: record.id, message: error instanceof Error ? error.message : String(error) });
    }
    if (extras.source?.kind === 'owner') {
      this.safetyAuthorityChanged('owner_goal_admitted');
      // MB-FLOW-003-C12: an ACTIVE owner job's per-goal Jev budget survives any churn (released at its end unless held).
      this.retainBudget(record.id, true);
    }
    this.deps.store.record({
      type: 'goal_admitted',
      goalId: record.id,
      epoch: record.epoch,
      kind,
      surface: origin.surface,
      instruction: truncate(text, BOUNDS.text),
      replacedGoalId: replaced,
      ...(extras.source ? { source: extras.source } : {}),
      ...(cl ? { ceilings: { ...caps, deadlineMs: deadlineAtMs - now } } : {}),
      ...(cont ? { continuation: { number: cont.cp.continuations.used, of: cont.cp.continuations.max, deadlineAtMs, counters: { ...active.counters } } } : {}),
      ...(prepared ? { intentId: prepared.intentId, preparedTurns: prepared.counters.plannerTurns, timeline: active.handoff?.timeline } : {}),
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
    const startedAtMs = this.deps.clock.now();
    // Owner-visible step label is app-owned (MB-PLAN-006); the planner's objective stays in internal evidence.
    this.currentTask = { taskId, objective: publicTaskLabel(spec), mode, startedAtMs, capabilities: [...spec.allowedCapabilities] };
    this.currentTaskObjective = truncate(spec.objective, 300);
    this.deps.store.record({ type: 'task_admitted', goalId: active.record.id, epoch: active.epoch, taskId, mode, objective: truncate(spec.objective, BOUNDS.text), allowedCapabilities: spec.allowedCapabilities });
    this.recordTimings(active, startedAtMs);
    const removal = active.outcome ? this.deps.outcomes?.captureContinuation?.(active.outcome.bound).removal : undefined;
    const hasRemoval = active.outcome && outcomeAtoms(active.outcome.contract).some(({ atom }) => atom.predicate === 'blocks_removed');
    const requiresOwnerDirection = active.outcome && outcomeAtoms(active.outcome.contract).some(({ atom }) => 'target' in atom && atom.target.kind === 'owner');
    const running = tasks.run({ taskId, goalId: active.record.id, goalEpoch: active.epoch, spec, mode, ...(hasRemoval ? { destructiveScope: removal ?? [] } : {}), ...(requiresOwnerDirection ? { requiresOwnerDirection: true } : {}), signal: active.abort.signal, isCurrent: () => this.active === active && this.epoch === active.epoch && !active.abort.signal.aborted });
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

  /** Measured handoff timeline (first task of a handed-off goal) and window gaps. */
  private recordTimings(active: ActiveGoal, startedAtMs: number): void {
    const h = active.handoff;
    if (h && !h.recorded) {
      h.recorded = true;
      h.timeline.firstTaskAtMs = startedAtMs;
      const t = h.timeline;
      this.deps.store.record({ type: 'handoff_timeline', goalId: active.record.id, intentId: h.intentId, ...t, receiptToDraftMs: t.draftReadyAtMs !== undefined ? t.draftReadyAtMs - t.receivedAtMs : null, switchMs: t.admittedAtMs !== undefined && t.handoffStartedAtMs !== undefined ? t.admittedAtMs - t.handoffStartedAtMs : null, admissionToFirstTaskMs: t.admittedAtMs !== undefined ? startedAtMs - t.admittedAtMs : null, receiptToFirstTaskMs: startedAtMs - t.receivedAtMs });
    }
    const end = active.windowEnd;
    if (end) {
      active.windowEnd = undefined;
      const gap: WindowGap = { goalId: active.record.id, afterWindow: end.afterWindow, gapMs: Math.max(0, startedAtMs - end.atMs), source: active.nextWindowSource, ...(active.revalidationMs !== undefined ? { revalidationMs: active.revalidationMs } : {}) };
      this.windowGaps.push(gap);
      if (this.windowGaps.length > 16) this.windowGaps.shift();
      this.deps.store.record({ type: 'goal_window_gap', ...gap });
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

  /**
   * Stops the active goal AND any pending instruction (no-op when idle). Works
   * in every state. An owner stop also sets the explicit pause latch.
   */
  async stop(reason: 'owner_stop' | 'shutdown' = 'owner_stop', surface: string = 'terminal'): Promise<{ stopped: boolean; goalId?: string; intentId?: string }> {
    ++this.intakeGeneration;
    // MB-FLOW-003-C12: an explicit stop fences every held job (it never continues; resume does not revive it).
    this.fenceHeld('stopped_by_owner', reason === 'owner_stop' ? 'owner_stop' : 'shutdown');
    if (reason === 'owner_stop') {
      this.latch = { paused: true, sinceMs: this.deps.clock.now(), source: surface };
      this.latchChanged('owner_stop');
    }
    // Synchronous prefix: the pending planner process is cancelled and the
    // active goal revoked (task/action aborted) before anything is awaited.
    const pending = this.pending;
    if (pending) this.discardPending(pending, reason === 'shutdown' ? 'shutdown' : 'owner_stop', reason === 'shutdown' ? 'Chunkbot is shutting down' : 'stopped by owner', reason !== 'shutdown');
    const goalId = this.active?.record.id;
    if (!this.active) {
      this.deps.store.record({ type: 'stop_requested', surface, hadActiveGoal: false, hadPendingInstruction: Boolean(pending) });
      if (reason === 'owner_stop') this.safetyAuthorityChanged('owner_stop');
      await Promise.all([this.cleanupBarrier, this.preparationCleanupsDone()]);
      return pending ? { stopped: true, intentId: pending.intentId } : { stopped: false };
    }
    this.deps.store.record({ type: 'stop_requested', surface, hadActiveGoal: true, goalId, hadPendingInstruction: Boolean(pending) });
    // revokeActive runs its synchronous revocation prefix before the first await; both cleanups are awaited (bounded).
    const revoking = this.revokeActive(reason, reason === 'owner_stop' ? 'stopped by owner' : 'Chunkbot is shutting down');
    // The owner goal is already revoked (synchronous prefix): safety re-reads authority NOW (no idle motion after stop).
    if (reason === 'owner_stop') this.safetyAuthorityChanged('owner_stop');
    await Promise.all([revoking, this.preparationCleanupsDone()]);
    return { stopped: true, ...(goalId ? { goalId } : {}), ...(pending ? { intentId: pending.intentId } : {}) };
  }

  /** Ends active ownership AND any pending instruction because of a lifecycle event (death, disconnect, kick, dimension change). */
  async endOwnership(reason: 'death' | 'disconnected' | 'kicked' | 'dimension_change', detail: string): Promise<void> {
    ++this.intakeGeneration;
    const pending = this.pending;
    if (pending) this.discardPending(pending, 'lifecycle', `${reason}: ${detail}`);
    await Promise.all([this.active ? this.revokeActive(reason, detail) : undefined, this.preparationCleanupsDone()]);
  }

  /**
   * MB-PLAN-006: Chunkbot never asks follow-up questions, so no question is
   * ever pending. An `answer ...` command (e.g. a reply to a question shown by
   * an older release) is retired declaratively: it is never applied as an
   * answer, never treated as permission for any task, and never revives,
   * replaces or changes active or pending work.
   */
  answer(reply: string, ref: string | undefined, surface: string): AnswerResult {
    const detail = 'no question is pending: Chunkbot does not ask follow-up questions, so this reply was not applied and nothing changed';
    this.deps.store.record({ type: 'answer_retired', surface, ref: ref ?? null, chars: reply.trim().length, activeGoalId: this.active?.record.id ?? null, pendingIntentId: this.pending?.intentId ?? null });
    this.deps.notify({ text: `Reply not applied: ${detail}. Send a new instruction to change what Chunkbot is doing.` });
    return { status: 'rejected', reason: 'no_pending_clarification', detail };
  }

  // ------------------------------------------------------------ continuation (MB-FLOW-003-C12)

  /** Held/continuing owner-job checkpoints (bounded copies; status/dashboard). */
  checkpoints(): ContinuationCheckpoint[] {
    return [...this.held.values()].map((h) => structuredClone(h.cp));
  }

  private heldChanged(h: HeldEntry, state: ContinuationCheckpoint['state'], reason: string): void {
    h.cp.state = state;
    h.cp.stateReason = reason;
    h.cp.stateAtMs = this.deps.clock.now();
    const terminal = state === 'completed' || state === 'stopped_by_owner' || state === 'superseded_by_owner' || (state === 'blocked' && reason !== 'not_continuable_in_v1' && !reason.startsWith('waiting'));
    if (terminal || state === 'blocked') this.retainBudget(h.cp.goalId, false);
    this.deps.store.record({ type: 'continuation_checkpoint', goalId: h.cp.goalId, state, reason, continuations: { ...h.cp.continuations }, counters: { ...h.cp.counters }, deadlineAtMs: h.cp.deadlineAtMs, caps: { ...h.cp.caps }, outcomeCanonical: h.cp.outcomeCanonical, admissionBaseline: h.cp.admissionBaseline });
    try {
      this.deps.continuation?.onChanged?.(structuredClone(h.cp));
      this.deps.continuation?.survival?.persistCheckpoint(structuredClone(h.cp));
    } catch (error) {
      this.deps.store.record({ type: 'continuation_hook_error', goalId: h.cp.goalId, message: error instanceof Error ? error.message : String(error) });
    }
    // Bounded history: drop the oldest finished entries.
    if (this.held.size > 8) {
      for (const [id, e] of this.held) {
        if (this.held.size <= 8) break;
        if (e.cp.state !== 'held' && e.cp.state !== 'capturing' && e.cp.state !== 'continuing') this.held.delete(id);
      }
    }
  }

  private retainBudget(goalId: string, retain: boolean): void {
    try {
      this.deps.decisionBudget?.retainGoalBudget?.(goalId, retain);
    } catch {
      /* optional */
    }
  }

  /** Explicit stop / new owner or operator intake: every waiting checkpoint is fenced synchronously (never continues). */
  private fenceHeld(state: 'stopped_by_owner' | 'superseded_by_owner', why: string): void {
    for (const h of this.held.values()) {
      if (h.cp.state === 'held' || h.cp.state === 'capturing' || (h.cp.state === 'continuing' && h.admitting) || (h.cp.state === 'blocked' && h.cp.stateReason === 'not_continuable_in_v1')) this.heldChanged(h, state, why);
    }
  }

  /**
   * Synchronous prefix of an ownership end: a checkpoint for an OWNER job whose
   * ownership ENDED by a checkpoint interruption (never stop/replace/completion).
   * Captures code-verified effect credit, consumption, latches and removal
   * positions while the ledger is still valid; possession credit is resolved
   * after cleanup (alive) or at readiness from packet-frozen evidence (death).
   */
  private beginHold(active: ActiveGoal, reason: TerminalReasonCode): HeldEntry | undefined {
    const C = this.deps.continuation;
    if (!C || active.source?.kind !== 'owner' || active.record.kind !== undefined || !active.outcome) return undefined;
    const continuable = (CONTINUABLE_INTERRUPTIONS as readonly string[]).includes(reason);
    const heldOnly = (HELD_ONLY_INTERRUPTIONS as readonly string[]).includes(reason);
    if (!continuable && !heldOnly) return undefined;
    const now = this.deps.clock.now();
    const existing = this.held.get(active.record.id);
    const contract = active.outcome.contract;
    const capture = this.deps.outcomes?.captureContinuation?.(active.outcome.bound);
    const baseline = active.baseline;
    const prevCounts = existing?.cp.counts ?? initialCountLineage(contract, baseline?.counts ?? null, C.matches);
    const returnsAtInterruption = new Map<string, number | null>();
    const counts = prevCounts.map((l) => {
      const next = { ...l, segments: l.segments + 1 };
      if (capture?.latched.includes(l.path)) next.latched = true;
      if (l.basis === 'effect') {
        next.credited = capture?.effect[l.path] ?? null;
        next.evidence = capture ? 'skill_confirmed_outputs' : 'unavailable';
      } else {
        if (l.incidentId) {
          const r = C.survival?.incidentReturns(l.incidentId);
          returnsAtInterruption.set(`${l.incidentId}|${l.selector}`, r && r.attribution === 'server_attributed' ? countFor({ ...sumCounts(r.regained, r.retained) }, l.selector, C.matches) : null);
        }
        next.credited = null;
        next.heldAtInterruption = null;
        next.evidence = 'pending';
      }
      return next;
    });
    const route = C.captureRoute?.(active.epoch);
    const cp: ContinuationCheckpoint = {
      version: 1,
      goalId: active.record.id,
      sessionId: C.sessionId,
      connectionEpoch: this.deps.connectionEpoch?.() ?? 0,
      dimension: existing?.cp.dimension ?? active.dimension ?? C.currentDimension?.() ?? '',
      instruction: active.record.instruction,
      publicOutcome: active.record.interpretation ?? '',
      outcome: contract,
      outcomeCanonical: active.outcome.canonical,
      admissionBaseline: existing?.cp.admissionBaseline ?? { capturedAtMs: baseline?.capturedAtMs ?? active.record.admittedAtMs, counts: baseline?.counts ? { ...baseline.counts } : null, detail: baseline?.detail ?? 'no admission baseline' },
      anchor: existing?.cp.anchor ?? C.captureAnchor?.(active.epoch) ?? null,
      counters: { ...active.counters },
      caps: { ...active.caps },
      admittedTasks: active.admittedTasks,
      deadlineAtMs: active.deadlineAtMs,
      grounding: existing?.cp.grounding ?? groundOutcome(contract, Boolean(baseline?.counts)),
      counts,
      removal: capture?.removal ?? existing?.cp.removal ?? [],
      route: route === undefined ? (existing?.cp.route ?? null) : route,
      verifiedEffects: [...(existing?.cp.verifiedEffects ?? [])],
      continuations: existing?.cp.continuations ?? { used: 0, max: C.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS },
      interruptions: [...(existing?.cp.interruptions ?? []), { reason: reason as ContinuationCheckpoint['interruptions'][number]['reason'], atMs: now, epoch: active.epoch }].slice(-8),
      state: 'capturing',
      stateReason: 'capturing',
      stateAtMs: now,
    };
    const entry: HeldEntry = { cp, capture, plannerInterpretation: active.outcome.interpretation, knowledge: active.knowledge.slice(-16), origin: active.record.origin, returnsAtInterruption, routeKnown: route !== undefined || (existing?.routeKnown ?? false) };
    this.held.set(cp.goalId, entry);
    this.retainBudget(cp.goalId, true);
    if (heldOnly) this.heldChanged(entry, 'blocked', 'not_continuable_in_v1');
    return entry;
  }

  /** After cleanup: resolve alive possession credit from a server-confirmed inventory; decide held/blocked. */
  private async completeHold(h: HeldEntry, reason: TerminalReasonCode): Promise<void> {
    if (h.cp.state !== 'capturing') return;
    const C = this.deps.continuation!;
    const alive = reason === 'low_health' || reason === 'safety_interrupted';
    const possession = h.cp.counts.filter((l) => l.basis === 'possession');
    if (alive && possession.length > 0 && h.capture && this.deps.outcomes?.captureBaseline && this.deps.outcomes.progressAt) {
      const counts = await withTimeout(this.deps.outcomes.captureBaseline(new AbortController().signal), Math.max(1_000, this.deps.limits.cleanupTimeoutMs), () => new Error('capture timeout')).catch(() => undefined);
      if (h.cp.state !== 'capturing') return;
      if (counts?.counts) {
        const progress = this.deps.outcomes.progressAt(h.capture, h.cp.outcome, counts.counts, (id, sel) => h.returnsAtInterruption.get(`${id}|${sel}`) ?? null);
        for (const l of possession) {
          const v = progress[l.path];
          l.credited = v ?? null;
          l.heldAtInterruption = countFor(counts.counts, l.selector, C.matches);
          l.incidentId = null;
          l.evidence = v === null || v === undefined ? 'unavailable' : 'current_server_inventory';
        }
      } else for (const l of possession) l.evidence = 'unavailable';
    }
    const ng = h.cp.grounding.find((g) => g.status === 'not_groundable');
    if (ng) return this.heldChanged(h, 'blocked', `not_groundable:${ng.reason ?? ng.predicate}`);
    if (h.cp.counts.some((l) => l.evidence === 'unavailable' && !l.latched)) return this.heldChanged(h, 'blocked', 'provenance_unavailable');
    if (h.cp.continuations.used >= h.cp.continuations.max) return this.heldChanged(h, 'blocked', 'continuations_exhausted');
    if (this.deps.clock.now() >= h.cp.deadlineAtMs) return this.heldChanged(h, 'blocked', 'deadline_passed');
    this.heldChanged(h, 'held', reason === 'death' ? 'waiting:respawn_and_recovery' : 'waiting:safe_state');
  }

  /**
   * MB-FLOW-003-C12 continuation of a held owner job: code-owned, finite
   * readiness (never the automatic progression latch or an absent goal's
   * safety authority), then the SAME goal id is admitted at a fresh epoch
   * through the single admission path with all original limits/anchor/route
   * lineage, and its immutable outcome is re-bound before any planner turn.
   */
  async continueHeld(goalId: string, cause: 'respawn_ready' | 'recovery_concluded' | 'safety_clear' | 'scheduled'): Promise<ContinueResult> {
    const C = this.deps.continuation;
    const h = this.held.get(goalId);
    const notReady = (reason: string, detail: string): ContinueResult => ({ status: 'not_ready', reason, detail });
    const blocked = (reason: string, detail: string): ContinueResult => {
      if (h) this.heldChanged(h, 'blocked', reason);
      return { status: 'blocked', reason, detail };
    };
    if (!C || !h) return notReady('no_checkpoint', 'no held job with this id');
    if (h.cp.state !== 'held') return notReady(`state_${h.cp.state}`, h.cp.stateReason);
    if (this.closed) return notReady('shutting_down', 'Chunkbot is shutting down');
    if (this.continuingNow) return notReady('busy', 'another continuation is being admitted');
    const now = this.deps.clock.now();
    if (now >= h.cp.deadlineAtMs) return blocked('deadline_passed', 'the job deadline passed while it was held');
    if (h.cp.continuations.used >= h.cp.continuations.max) return blocked('continuations_exhausted', `already continued ${h.cp.continuations.used} time(s)`);
    if (h.cp.counters.plannerTurns >= h.cp.caps.plannerTurns || h.cp.admittedTasks >= h.cp.caps.tasks || h.cp.counters.replans >= h.cp.caps.replans) return blocked('limit_exhausted', 'the job used its original planner/task/replan limits');
    if (!this.deps.isGameReady()) return notReady('not_connected', 'not connected');
    if ((this.deps.connectionEpoch?.() ?? 0) !== h.cp.connectionEpoch) return blocked('connection_changed', 'held work never continues on another connection');
    if (C.isAlive && !C.isAlive()) return notReady('not_alive', 'waiting for respawn');
    const dim = C.currentDimension?.();
    if (dim !== undefined && dim !== h.cp.dimension) return notReady('other_dimension', `the job belongs to ${h.cp.dimension}`);
    if (this.active || this.pending || this.ownerIntakesInFlight > 0) return notReady('busy', this.active ? `goal ${this.active.record.id} owns control` : 'an owner instruction is being handled');
    const gate = C.survival?.continuationGate(now);
    if (gate?.kind === 'wait') return notReady(gate.reason, gate.detail);
    if (gate?.kind === 'blocked') return blocked(gate.reason, gate.detail);
    // Death: possession credit from packet-frozen last-alive evidence and its incident (provenance).
    const pending = h.cp.counts.filter((l) => l.basis === 'possession' && l.evidence === 'pending' && !l.latched);
    if (pending.length > 0) {
      const S = C.survival;
      if (!S || !h.capture || !this.deps.outcomes?.progressAt) return blocked('provenance_unavailable', 'counted progress cannot be attributed without the survival service');
      const frozen = S.frozenInventory(h.cp.connectionEpoch);
      const used = new Set(h.cp.counts.map((l) => l.incidentId).filter(Boolean));
      if (!frozen || used.has(frozen.incidentId)) return notReady('frozen_inventory_pending', 'waiting for the death evidence');
      const returns = S.incidentReturns(frozen.incidentId);
      if (!returns || returns.attribution !== 'server_attributed') return notReady('attribution_unknown', 'own-incident returns are not attributed yet');
      const progress = this.deps.outcomes.progressAt(h.capture, h.cp.outcome, frozen.counts, (id, sel) => h.returnsAtInterruption.get(`${id}|${sel}`) ?? null);
      for (const l of pending) {
        const v = progress[l.path];
        if (v === null || v === undefined) return blocked('provenance_unavailable', `no verified progress for ${l.selector}`);
        l.credited = v;
        l.heldAtInterruption = countFor(frozen.counts, l.selector, C.matches);
        l.incidentId = frozen.incidentId;
        l.evidence = 'last_alive_server_packets';
      }
    }
    for (const l of h.cp.counts) if (l.latched && l.credited === null) l.credited = l.atLeast;
    this.continuingNow = true;
    try {
      // Counted BEFORE planning (a later failure never refunds it).
      h.cp.continuations.used += 1;
      h.admitting = true;
      this.heldChanged(h, 'continuing', `continuation ${h.cp.continuations.used}/${h.cp.continuations.max} (${cause})`);
      const admitted = await this.admit(h.cp.instruction, h.origin, 'owner_goal', undefined, { source: { kind: 'owner' }, continuation: h });
      h.admitting = false;
      if (admitted.status !== 'admitted') {
        if ((h.cp.state as string) === 'continuing') this.heldChanged(h, 'blocked', 'admission_superseded');
        return notReady('superseded', 'a stop or instruction arrived during admission');
      }
      const last = h.cp.interruptions.at(-1)?.reason ?? 'interruption';
      this.deps.notify({ goalId: h.cp.goalId, text: `Continuing goal ${h.cp.goalId} after ${last.replace(/_/g, ' ')} (continuation ${h.cp.continuations.used}/${h.cp.continuations.max}): ${truncate(h.cp.publicOutcome, 200)}` });
      this.track(this.plan(admitted.active));
      return { status: 'admitted', goalId: h.cp.goalId, epoch: admitted.active.epoch, continuation: h.cp.continuations.used };
    } finally {
      this.continuingNow = false;
    }
  }

  /** Re-binds the immutable outcome of a continuation from a fresh server inventory (credit re-binding only). */
  private async bindContinuation(active: ActiveGoal): Promise<boolean> {
    const h = active.continuation!;
    const cp = h.cp;
    const outcomes = this.deps.outcomes;
    const original: InventoryBaseline = { capturedAtMs: cp.admissionBaseline.capturedAtMs, counts: cp.admissionBaseline.counts, detail: cp.admissionBaseline.detail };
    active.baseline = original;
    active.admission = { capturedAtMs: original.capturedAtMs, counts: original.counts ? Object.entries(original.counts).map(([key, count]) => ({ key, count })).slice(0, BOUNDS.listMedium + 9) : null, detail: `ORIGINAL admission inventory (continuation ${cp.continuations.used}): ${original.detail}` };
    if (!outcomes?.captureBaseline || !outcomes.rebindContinuation) {
      await this.finishIfCurrent(active, 'capability_not_ready', 'continuation re-binding is not installed');
      return false;
    }
    const fresh = await raceAbort(outcomes.captureBaseline(active.abort.signal), active.abort.signal);
    this.assertCurrent(active);
    if (!fresh.counts && cp.counts.some((l) => l.basis === 'possession' && !l.latched)) {
      await this.finishIfCurrent(active, 'cannot_execute', `the held job's counted progress could not be re-bound: no server-confirmed inventory now (${truncate(fresh.detail, 160)})`);
      return false;
    }
    const bound = await raceAbort(outcomes.rebindContinuation(cp.outcome, { counts: cp.counts, removal: cp.removal, fresh, original, owner: { goalId: active.record.id, goalEpoch: active.epoch }, notBeforeMs: (cp.interruptions.at(-1)?.atMs ?? 0) + 1 }, active.abort.signal), active.abort.signal);
    this.assertCurrent(active);
    active.outcome = { contract: cp.outcome, canonical: cp.outcomeCanonical, bound, interpretation: h.plannerInterpretation };
    const root = cp.outcome.kind === 'finite' ? cp.outcome.outcome : cp.outcome.maintain;
    active.record.outcome = truncate(`${cp.outcome.kind}: ${JSON.stringify(root)}`, BOUNDS.text);
    active.record.interpretation = cp.publicOutcome;
    active.nextTurnKind = 'continuation';
    this.deps.store.record({ type: 'goal_continuation_bound', goalId: active.record.id, epoch: active.epoch, continuation: cp.continuations.used, freshCapturedAtMs: fresh.capturedAtMs, deadlineAtMs: active.deadlineAtMs, caps: { ...active.caps }, outcomeCanonical: cp.outcomeCanonical, admissionBaseline: cp.admissionBaseline, carriedTasks: 0, carriedHandles: 0, counts: cp.counts.map((l) => ({ path: l.path, basis: l.basis, selector: l.selector, credited: l.credited, held: l.heldAtInterruption, evidence: l.evidence, latched: l.latched, incident: l.incidentId !== null })), removal: cp.removal.map((r) => ({ path: r.path, members: r.members.length })) });
    return true;
  }

  /** Bounded, app-written planner facts for a continuation (never planner prose). */
  private continuationFacts(h: HeldEntry): NonNullable<PlannerRequest['continuation']> {
    const cp = h.cp;
    const last = cp.interruptions.at(-1)?.reason ?? 'interruption';
    const facts = [
      `this is continuation ${cp.continuations.used} of ${cp.continuations.max} of the SAME owner job after ${last.replace(/_/g, ' ')}; the accepted outcome, limits and counters are unchanged`,
      ...cp.counts.slice(0, 6).map((l) => (l.basis === 'effect' ? `${l.credited ?? 0} ${l.selector} already produced (skill-confirmed) count toward ${l.atLeast}` : l.latched ? `the ${l.selector} milestone was already reached` : `${l.credited ?? 0} ${l.selector} were verified before the interruption; own lost items returned to the inventory restore that credit, other items count as new`)),
      ...cp.removal.slice(0, 3).map((r) => `${r.members.length} bound ${r.selector} positions of the original target remain bound (verified freshly by code)`),
      'old tasks, handles and actions are NOT resumed: observe afresh and plan only the remaining work',
    ];
    return { number: cp.continuations.used, max: cp.continuations.max, after: last, facts: facts.slice(0, 10) };
  }

  status(): FullEngineStatus {
    const catalog = this.deps.capabilities.catalog();
    const p = this.pending;
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
      ...(p
        ? {
            pending: {
              intentId: p.intentId,
              generation: p.generation,
              instruction: p.instruction,
              state: p.state,
              receivedAtMs: p.receivedAtMs,
              updatedAtMs: p.updatedAtMs,
              activeGoalId: this.active?.record.id ?? null,
              plannerTurns: p.counters.plannerTurns,
            },
          }
        : {}),
      parked: this.active?.parked ?? false,
      handoff: { ...this.totals },
      latch: { ...this.latch },
      windowGaps: this.windowGaps.slice(-8).map((g) => ({ ...g })),
      ...(this.held.size > 0 ? { checkpoints: this.checkpoints() } : {}),
    };
  }

  /** Registers cleanup for work owned by the given goal epoch (e.g. a later actuator lease). */
  registerCleanup(epoch: number, cleanup: Cleanup): boolean {
    if (!this.active || this.active.epoch !== epoch) return false;
    this.active.cleanups.add(cleanup);
    return true;
  }

  /**
   * Closes admission synchronously (before any await), then cancels active and
   * pending work and waits, bounded, for cleanup and in-flight work. Submissions
   * arriving during shutdown are rejected; ones already waiting on cleanup are superseded.
   */
  async shutdown(): Promise<void> {
    if (this.closed) {
      // A repeated shutdown waits for the same outstanding (bounded) cleanups; it never reports done early.
      await Promise.all([this.cleanupBarrier, this.preparationCleanupsDone()]);
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
    // MB-FLOW-003-C12: synchronous capture BEFORE any lifecycle invalidation (ledger still valid).
    let hold: HeldEntry | undefined;
    try {
      hold = this.beginHold(active, reason);
    } catch (error) {
      this.deps.store.record({ type: 'continuation_capture_error', goalId: active.record.id, message: error instanceof Error ? error.message : String(error) });
    }
    if (viaStopping) this.setState(active, 'stopping');
    active.abort.abort(new Error(reason));
    if (active.lookahead) {
      active.lookahead.abort.abort(new Error(reason));
      active.lookahead = undefined;
    }
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
      if (hold) await this.completeHold(hold, reason).catch((error: unknown) => this.deps.store.record({ type: 'continuation_capture_error', goalId: active.record.id, message: error instanceof Error ? error.message : String(error) }));
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
    // MB-FLOW-003-C12: a held owner job is NOT finished; a continuation's end settles its checkpoint.
    const heldEntry = this.held.get(active.record.id);
    let heldInfo: GoalTerminalEvent['held'];
    if (heldEntry && (heldEntry.cp.state === 'held' || heldEntry.cp.state === 'blocked' || heldEntry.cp.state === 'capturing') && heldEntry.cp.interruptions.at(-1)?.epoch === active.epoch) {
      heldInfo = { continuable: heldEntry.cp.state === 'held', reason: heldEntry.cp.stateReason, continuations: { ...heldEntry.cp.continuations } };
    } else if (heldEntry && heldEntry.cp.state === 'continuing' && active.continuation === heldEntry) {
      if (reason === 'outcome_verified') this.heldChanged(heldEntry, 'completed', 'outcome_verified');
      else if (reason === 'owner_stop') this.heldChanged(heldEntry, 'stopped_by_owner', 'owner_stop');
      else if (reason === 'replaced') this.heldChanged(heldEntry, 'superseded_by_owner', 'replaced');
      else this.heldChanged(heldEntry, 'blocked', `ended:${reason}`);
    }
    if (!heldInfo && active.source?.kind === 'owner' && !(heldEntry && heldEntry.cp.state === 'continuing')) this.retainBudget(active.record.id, false);
    const heldText = heldInfo ? (heldInfo.continuable ? ` — held: Chunkbot continues this job when it is safe (continuation ${heldInfo.continuations.used + 1} of at most ${heldInfo.continuations.max})` : ` — held, not continued (${heldInfo.reason.replace(/_/g, ' ')}); a new instruction replaces it`) : '';
    this.deps.notify({ goalId: active.record.id, ...(active.record.kind === 'operator_task_diagnostic' ? { audience: 'operator' as const } : {}), text: `Goal ${active.record.id} ${state} (${reason}): ${truncate(detail, 160)}${heldText}` });
    this.safetyAuthorityChanged('goal_terminal');
    // A handed-off goal that ended before its draft was revalidated still releases the preparation's refs.
    if (active.handoff) this.releasePreparation(active.handoff.intentId);
    try {
      this.deps.onGoalTerminal?.({
        goalId: active.record.id,
        epoch: active.epoch,
        kind: active.record.kind ?? 'owner_goal',
        state,
        reason,
        detail: active.record.terminal.detail,
        ...(active.record.interpretation ? { interpretation: active.record.interpretation } : {}),
        instruction: active.record.instruction,
        ...(active.source ? { source: active.source } : {}),
        ...(active.outcome ? { outcome: active.outcome.contract } : {}),
        ...(active.outcomeStatus ? { outcomeStatus: { ...active.outcomeStatus } } : {}),
        counters: { ...active.counters },
        admittedAtMs: active.record.admittedAtMs,
        deadlineAtMs: active.deadlineAtMs,
        ...(active.baseline ? { baseline: { capturedAtMs: active.baseline.capturedAtMs, counts: active.baseline.counts ? { ...active.baseline.counts } : null } } : {}),
        progress: active.record.progress,
        ...(heldInfo ? { held: heldInfo } : {}),
      });
    } catch (error) {
      this.deps.store.record({ type: 'goal_terminal_hook_error', goalId: active.record.id, message: error instanceof Error ? error.message : String(error) });
    }
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

  private ownerCoords(active: ActiveGoal): OwnerCoordinate[] {
    return ownerCoordinates(active.record.instruction);
  }

  private progressSummary(active: ActiveGoal): string {
    const c = active.counters;
    return `planner turns ${c.plannerTurns} (knowledge ${c.knowledgeRounds}, repairs ${c.repairs}, retries ${c.retries}${c.questionRefusals ? `, question refusals ${c.questionRefusals}` : ''}, replans ${c.replans}${c.preparationTurns ? `, preparation ${c.preparationTurns}` : ''}${c.lookaheads ? `, lookahead ${c.lookaheads}` : ''}), windows ${c.windows}, tasks ${c.tasksAdmitted}${active.outcomeStatus ? `; outcome ${active.outcomeStatus.status}: ${truncate(active.outcomeStatus.detail, 160)}` : ''}`;
  }

  private routeFields(goalEpoch: number): Pick<PlannerRequest, 'route' | 'locator'> {
    const out: Pick<PlannerRequest, 'route' | 'locator'> = {};
    try {
      const route = this.deps.routeView?.(goalEpoch);
      if (route) out.route = route;
      const hint = this.deps.locatorHint?.();
      if (hint) out.locator = hint;
    } catch (error) {
      this.deps.store.record({ type: 'route_view_error', message: error instanceof Error ? error.message : String(error) });
    }
    return out;
  }

  /** Optional-evaluator and route facts for proposal validation of THIS goal epoch. */
  private proposalExtras(goalEpoch: number | undefined): { structures?: boolean; survival?: boolean; route?: RouteProposalContext; routeDeferred?: boolean } {
    const route = goalEpoch !== undefined ? this.routeFields(goalEpoch).route : undefined;
    return {
      ...(this.deps.installed?.structures ? { structures: true } : {}),
      ...(this.deps.installed?.survival ? { survival: true } : {}),
      ...(route ? { route: { authorized: route.authorized, destinations: route.destinations, ownDeathAvailable: route.ownDeathAvailable, state: route.state } } : {}),
      ...(goalEpoch === undefined ? { routeDeferred: true } : {}),
    };
  }

  /** The owned admission barrier (C5); false when the goal ended because it did not pass. */
  private async passBarrier(active: ActiveGoal): Promise<boolean> {
    const barrier = this.deps.admissionBarrier;
    if (!barrier) return true;
    const r = await raceAbort(barrier({ goalId: active.record.id, epoch: active.epoch, source: active.source }, active.abort.signal), active.abort.signal);
    this.assertCurrent(active);
    if (r.ok) return true;
    this.deps.store.record({ type: 'admission_barrier_refused', goalId: active.record.id, reason: r.reason, detail: truncate(r.detail, 300) });
    await this.finishIfCurrent(active, r.reason, `${r.detail}; no model call or action was started`);
    return false;
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
    this.deps.store.record({ type: 'goal_admission_baseline', goalId: active.record.id, epoch: active.epoch, capturedAtMs: baseline.capturedAtMs, counts: baseline.counts, detail: baseline.detail, ...(active.handoff ? { intentId: active.handoff.intentId } : {}) });
  }

  /**
   * While a replacement instruction is pending, the active goal starts no new
   * task and no planner turn: it waits (parked) until the pending instruction
   * is handed off (this goal is then revoked) or discarded (it continues).
   */
  private async parkWhilePending(active: ActiveGoal): Promise<void> {
    while (this.pending && this.active === active) {
      const p = this.pending;
      if (!active.parked) {
        active.parked = true;
        this.deps.store.record({ type: 'goal_parked_for_handoff', goalId: active.record.id, epoch: active.epoch, intentId: p.intentId });
        active.record.progress = truncate(`waiting for the pending instruction to be ready; no new task or planner turn starts meanwhile${active.record.progress ? `; last: ${active.record.progress}` : ''}`, BOUNDS.text);
        this.deps.notify({ goalId: active.record.id, text: `The current step finished; waiting for your new instruction's plan before switching (no new work started).` });
      }
      await raceAbort(p.settled.promise, active.abort.signal);
      this.assertCurrent(active);
    }
    if (active.parked) {
      active.parked = false;
      this.deps.store.record({ type: 'goal_unparked', goalId: active.record.id, epoch: active.epoch });
    }
  }

  private goalRequest(active: ActiveGoal, snapshot: ObservationSnapshot | null, requestId: string, turnKind: PlannerTurnKind, extra: Partial<PlannerRequest> = {}): PlannerRequest {
    const { capabilities, limits } = this.deps;
    const c = active.counters;
    const maxReplans = active.caps.replans;
    return {
      requestId,
      subject: { kind: 'goal', goalId: active.record.id, goalEpoch: active.epoch },
      instruction: active.record.instruction,
      turn: c.plannerTurns,
      maxTurns: active.caps.plannerTurns,
      catalog: capabilities.catalog(),
      observation: snapshot,
      knowledge: [...active.knowledge],
      ...(active.feedback.length > 0 ? { feedback: [...active.feedback] } : {}),
      turnKind,
      ...(active.admission ? { admission: active.admission } : {}),
      ...(active.outcome ? { acceptedOutcome: active.outcome.contract, acceptedInterpretation: active.outcome.interpretation } : {}),
      ...(active.outcomeStatus ? { outcomeStatus: active.outcomeStatus } : {}),
      counters: { ...c },
      remaining: {
        plannerTurns: active.caps.plannerTurns - c.plannerTurns,
        tasks: active.caps.tasks - active.admittedTasks,
        replans: maxReplans - c.replans,
        deadlineMs: Math.max(0, active.deadlineAtMs - this.deps.clock.now()),
        windowSteps: limits.planWindowSteps,
      },
      ownerCoordinates: this.ownerCoords(active),
      priorResults: [...active.priorResults.values()],
      ...(active.rejection ? { rejection: { problems: active.rejection } } : {}),
      ...(this.deps.mechanicsVersion ? { mechanicsVersion: this.deps.mechanicsVersion } : {}),
      limits: { travelRadius: limits.travelRadius ?? 128, observationRadius: limits.observationRadius ?? 32, planWindowSteps: limits.planWindowSteps },
      ...this.memoryField({ kind: 'goal', goalId: active.record.id, goalEpoch: active.epoch }, requestId, active.record.instruction, snapshot),
      ...(active.autonomy ? { autonomy: active.autonomy } : {}),
      ...(active.continuation ? { continuation: this.continuationFacts(active.continuation) } : {}),
      ...this.routeFields(active.epoch),
      ...extra,
    };
  }

  /**
   * One bounded planner turn through the single planner slot. Its own abort
   * (timeout) is linked to the owner's; a stop/replacement/supersession aborts
   * it immediately, and revocation cleanup waits (bounded) for the process.
   * Throws StaleWorkError when the owner was revoked.
   */
  private async plannerTurn(owner: TurnOwner, request: PlannerRequest): Promise<TurnResultShape> {
    const { planner, limits } = this.deps;
    const turnAbort = new AbortController();
    const onOwnerAbort = () => turnAbort.abort(new Error('owner revoked'));
    owner.signal.addEventListener('abort', onOwnerAbort, { once: true });
    const acquired = await this.slot.acquire(owner.kind, turnAbort, owner.signal);
    if (!acquired.ok || owner.signal.aborted || turnAbort.signal.aborted) {
      if (acquired.ok) acquired.ticket.skip();
      owner.signal.removeEventListener('abort', onOwnerAbort);
      if (owner.signal.aborted) throw new StaleWorkError();
      if (!acquired.ok && acquired.reason === 'timeout') {
        // MB-FLOW-002-C1: an earlier planner process is still running; never start a second one.
        return { failure: { kind: 'process_error', detail: `an earlier planner process did not finish within ${limits.cleanupTimeoutMs}ms; no second planner process was started` } };
      }
      return { failure: { kind: 'aborted', detail: 'planner turn preempted before it started' } };
    }
    const ticket = acquired.ticket;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      turnAbort.abort(new Error('planner turn timeout'));
    }, limits.plannerTimeoutMs);
    const turn = Promise.resolve().then(() => planner.propose(request, turnAbort.signal));
    ticket.started(turn);
    const settled: Cleanup = () => turn.then(() => undefined, () => undefined);
    owner.cleanups.add(settled);
    // The cleanup entry leaves the owner's set once the process has settled.
    void turn.then(() => undefined, () => undefined).finally(() => owner.cleanups.delete(settled));
    let raw: unknown;
    let failure: PlannerFailure | undefined;
    try {
      raw = await raceAbort(raceAbort(turn, turnAbort.signal), owner.signal);
    } catch (error) {
      if (error instanceof StaleWorkError && owner.signal.aborted) throw error;
      if (error instanceof StaleWorkError && timedOut) failure = { kind: 'timeout', detail: `planner turn exceeded ${limits.plannerTimeoutMs}ms` };
      else if (error instanceof StaleWorkError) failure = { kind: 'aborted', detail: 'planner turn preempted by owner work' };
      else failure = plannerFailureOf(error) ?? { kind: 'process_error', detail: error instanceof Error ? error.message : String(error) };
      if (failure.kind === 'aborted' && timedOut) failure = { kind: 'timeout', detail: `planner turn exceeded ${limits.plannerTimeoutMs}ms` };
    } finally {
      clearTimeout(timer);
      owner.signal.removeEventListener('abort', onOwnerAbort);
      // Own failure (timeout/error): wait, bounded, for the planner process cleanup before continuing.
      if (!owner.signal.aborted && (timedOut || failure)) await withTimeout(settled() as Promise<void>, limits.cleanupTimeoutMs, () => new Error('planner cleanup timeout')).catch(() => undefined);
    }
    if (owner.signal.aborted) throw new StaleWorkError();
    return failure ? { failure } : { raw };
  }

  // ------------------------------------------------------------ window lookahead (MB-FLOW-002 H7)

  /** Starts ONE speculative next-window turn while the window's last task runs (counted; revalidated before use). */
  private maybeStartLookahead(active: ActiveGoal, running: TaskSpec): void {
    const { limits } = this.deps;
    const c = active.counters;
    if (!this.flow.lookahead || active.record.kind !== undefined || active.lookahead || this.pending || this.closed) return;
    // Keep at least one turn for an ordinary replan if the lookahead is discarded.
    if (active.caps.plannerTurns - c.plannerTurns < 2 || c.replans >= active.caps.replans) return;
    if (!this.deps.planner.readiness().ready) return;
    const abort = new AbortController();
    const la: LookaheadState = { requestId: this.deps.ids.next('req'), abort, startedAtMs: this.deps.clock.now(), promise: Promise.resolve({ failure: { kind: 'aborted', detail: 'not started' } }) };
    la.promise = this.runLookahead(active, la, running);
    active.lookahead = la;
  }

  private async runLookahead(active: ActiveGoal, la: LookaheadState, running: TaskSpec): Promise<TurnResultShape> {
    const signal = AbortSignal.any([active.abort.signal, la.abort.signal]);
    try {
      const snapshot = await this.deps.observation.snapshot(active.epoch).catch(() => null);
      this.assertCurrent(active);
      if (signal.aborted || this.pending) return { failure: { kind: 'aborted', detail: 'owner instruction pending' } };
      this.remember(active, snapshot);
      const c = active.counters;
      c.plannerTurns += 1;
      c.lookaheads += 1;
      active.record.plannerTurns = c.plannerTurns;
      this.totals.lookaheadTurns += 1;
      const request = this.goalRequest(active, snapshot, la.requestId, 'lookahead', { lookahead: { runningTask: running.objective, note: 'speculative: code discards this plan if the running task fails or the outcome is already met, and revalidates it against fresh state before use' } });
      this.deps.store.record({ type: 'planner_request', goalId: active.record.id, requestId: la.requestId, turn: c.plannerTurns, turnKind: 'lookahead', snapshotId: snapshot?.id ?? null, counters: { ...c } });
      const r = await this.plannerTurn({ kind: 'lookahead', signal, cleanups: active.cleanups }, request);
      la.readyAtMs = this.deps.clock.now();
      this.deps.store.record({ type: 'lookahead_ready', goalId: active.record.id, requestId: la.requestId, ok: !('failure' in r), ...('failure' in r ? { failure: r.failure.kind } : {}), elapsedMs: la.readyAtMs - la.startedAtMs });
      return r;
    } catch {
      return { failure: { kind: 'aborted', detail: 'lookahead cancelled' } };
    }
  }

  private dropLookahead(active: ActiveGoal, reason: string): void {
    const la = active.lookahead;
    if (!la) return;
    active.lookahead = undefined;
    la.abort.abort(new Error(reason));
    this.totals.lookaheadsDiscarded += 1;
    this.deps.store.record({ type: 'lookahead_discarded', goalId: active.record.id, requestId: la.requestId, reason });
  }

  /** The lookahead plan, when the window's last task completed and the outcome still needs work. */
  private async takeLookahead(active: ActiveGoal, last: TaskResult | undefined): Promise<CarriedPlan | undefined> {
    const la = active.lookahead;
    if (!la) return undefined;
    if (!last || last.status !== 'completed') {
      this.dropLookahead(active, `the window's last task ${last ? `${last.status} (${last.reason})` : 'did not run'}; its premise no longer holds`);
      return undefined;
    }
    if (this.pending) {
      this.dropLookahead(active, 'an owner instruction is pending');
      return undefined;
    }
    const r = await raceAbort(la.promise, active.abort.signal);
    this.assertCurrent(active);
    if (active.lookahead !== la) return undefined;
    active.lookahead = undefined;
    if ('failure' in r || this.pending) {
      this.totals.lookaheadsDiscarded += 1;
      this.deps.store.record({ type: 'lookahead_discarded', goalId: active.record.id, requestId: la.requestId, reason: 'failure' in r ? `lookahead turn failed (${r.failure.kind}): ${truncate(r.failure.detail, 200)}` : 'an owner instruction is pending' });
      return undefined;
    }
    this.totals.lookaheadsUsed += 1;
    return { proposal: r.raw, requestId: la.requestId, turnKind: 'lookahead', source: 'lookahead' };
  }

  /** Records what the planner is shown so its references can be validated (bounded). */
  private remember(active: ActiveGoal, snapshot: ObservationSnapshot | null): void {
    this.rememberShown(active, snapshot);
  }

  /** Bounded planner turns for the active goal until a terminal state (there is never an owner-answer wait). */
  private async plan(active: ActiveGoal, carriedIn?: CarriedPlan): Promise<void> {
    const { planner, knowledge, observation, capabilities, executor, limits } = this.deps;
    const maxReplans = active.caps.replans;
    const maxRepairs = limits.maxConsecutiveRepairs ?? 2;
    const maxRetries = limits.maxConsecutiveRetries ?? 1;
    const c = active.counters;
    let carried = carriedIn;
    try {
      const readiness = planner.readiness();
      if (!readiness.ready && !carried) {
        await this.finishIfCurrent(active, 'planner_not_ready', `${readiness.detail}. No game actions were taken.`);
        return;
      }
      // Admission-bound baseline BEFORE the first planner turn or draft revalidation (kept across every later turn).
      // A continuation keeps the ORIGINAL baseline and re-binds its immutable outcome from a fresh inventory instead.
      if (active.continuation) {
        if (!(await this.bindContinuation(active))) return;
      } else await this.captureBaseline(active);
      if (!(await this.passBarrier(active))) return;
      while (true) {
        this.assertCurrent(active);
        await this.parkWhilePending(active);
        if (!carried && c.plannerTurns >= active.caps.plannerTurns) {
          await this.finishIfCurrent(active, 'limit_exhausted', `planner turn limit (${active.caps.plannerTurns}) reached; ${this.progressSummary(active)}`);
          return;
        }
        if (active.admittedTasks >= active.caps.tasks) {
          await this.finishIfCurrent(active, 'limit_exhausted', `total task ceiling (${active.caps.tasks}) reached; ${this.progressSummary(active)}`);
          return;
        }
        let raw: unknown;
        let requestId: string;
        let turnKind: PlannerTurnKind;
        let ownerCoordinateList: OwnerCoordinate[];
        if (carried) {
          // Revalidation of a prepared draft or a lookahead plan against FRESH state (no planner call).
          const draft = carried;
          carried = undefined;
          const t0 = this.deps.clock.now();
          const snapshot = await observation.snapshot(active.epoch).catch(() => null);
          this.assertCurrent(active);
          this.remember(active, snapshot);
          // C2: a prepared draft's outcome is not bound yet, so its references are re-grounded too
          // (before the initial binding). A lookahead never rewrites the accepted, bound outcome:
          // it must repeat it exactly and only its new tasks are re-grounded.
          const handles = regroundProposal(draft.proposal, snapshot, observation.translateHandle?.bind(observation), { outcome: draft.source === 'preparation' && !active.outcome });
          requestId = draft.requestId;
          turnKind = draft.turnKind;
          // Prepared memory refs (mprep-) -> fresh executable refs of the SAME facts, then release the preparation's refs.
          const mem = draft.source === 'preparation' ? this.regroundMemoryRefs(active, handles.proposal, requestId, snapshot) : { proposal: handles.proposal, problems: [] as string[], regrounded: 0 };
          if (draft.source === 'preparation' && active.handoff) this.releasePreparation(active.handoff.intentId);
          const rg = { proposal: mem.proposal, problems: [...handles.problems, ...mem.problems], regrounded: handles.regrounded + mem.regrounded };
          ownerCoordinateList = this.ownerCoords(active);
          active.revalidationMs = this.deps.clock.now() - t0;
          active.nextWindowSource = draft.source === 'lookahead' ? 'lookahead' : 'replan';
          this.deps.store.record({ type: 'draft_revalidated', goalId: active.record.id, source: draft.source, requestId, snapshotId: snapshot?.id ?? null, regrounded: rg.regrounded, memoryRefsRegrounded: mem.regrounded, problems: rg.problems, elapsedMs: active.revalidationMs });
          if (rg.problems.length > 0) {
            if (await this.rejectAndMaybeRepair(active, requestId, 'stale_draft', rg.problems, maxRepairs)) continue;
            return;
          }
          raw = rg.proposal;
        } else {
          const snapshot = await observation.snapshot(active.epoch).catch(() => null);
          this.assertCurrent(active);
          this.remember(active, snapshot);
          // A replacement may have become pending while observing: no planner turn for the old goal then.
          if (this.pending) continue;
          c.plannerTurns += 1;
          active.record.plannerTurns = c.plannerTurns;
          turnKind = active.nextTurnKind;
          requestId = this.deps.ids.next('req');
          const request = this.goalRequest(active, snapshot, requestId, turnKind);
          ownerCoordinateList = [...(request.ownerCoordinates ?? [])];
          active.nextWindowSource = 'replan';
          delete active.revalidationMs;
          this.deps.store.record({ type: 'planner_request', goalId: active.record.id, requestId, turn: c.plannerTurns, turnKind, snapshotId: snapshot?.id ?? null, counters: { ...c } });
          const r = await this.plannerTurn({ kind: 'goal', signal: active.abort.signal, cleanups: active.cleanups }, request);
          // A reply for a stopped/replaced goal is discarded without effect.
          this.assertCurrent(active);
          if ('failure' in r) {
            const failure = r.failure;
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
          raw = r.raw;
        }

        const check = checkProposal(
          raw,
          capabilities,
          { planWindowSteps: limits.planWindowSteps, remainingTaskAllowance: active.caps.tasks - active.admittedTasks },
          {
            ...(this.deps.registry ? { registry: this.deps.registry } : {}),
            shown: active.shown,
            anchors: active.anchors,
            ...(active.dimension ? { dimension: active.dimension } : {}),
            ownerCoordinates: ownerCoordinateList,
            priorResults: new Set(active.priorResults.keys()),
            ownerText: active.record.instruction,
            ...(this.deps.memory ? { memory: { refs: this.deps.memory.shownRefs({ goalId: active.record.id, goalEpoch: active.epoch }), kind: 'executable' as const } } : {}),
            ...this.proposalExtras(active.epoch),
          },
        );
        if (!check.ok) {
          if (await this.rejectAndMaybeRepair(active, requestId, check.kind, check.problems, maxRepairs)) continue;
          return;
        }
        const proposal = check.proposal;
        // MB-FLOW-001: an automatic goal must have a FINITE outcome (it can never hold control indefinitely).
        if (proposal.disposition === 'plan' && !active.outcome && isAutomaticSource(active.source) && proposal.outcome.kind !== 'finite') {
          if (await this.rejectAndMaybeRepair(active, requestId, 'semantic', ['automatic (progression/support) goals need a finite, code-verifiable outcome; persistent outcomes are only for owner instructions'], maxRepairs)) continue;
          return;
        }
        // Accepted outcome is immutable: a later plan may not silently change it.
        if (proposal.disposition === 'plan' && active.outcome && active.outcome.canonical !== canonicalJson(proposal.outcome)) {
          if (await this.rejectAndMaybeRepair(active, requestId, 'semantic', ['the plan changes the accepted goal outcome; repeat acceptedOutcome exactly (a changed outcome needs a new owner instruction)'], maxRepairs)) continue;
          return;
        }
        active.consecutiveRepairs = 0;
        delete active.rejection;
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
          case 'cannot_execute': {
            // MB-PLAN-006: planner prose (missing / verifiedProgress) stays internal; the owner-visible blocker is app-owned.
            const detail = `${publicBlocker({ missingCapabilities: proposal.missingCapabilities, feedback: active.feedback })}; ${this.progressSummary(active)}`;
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
              const bound = await raceAbort(this.deps.outcomes.bind(outcomeRoot, active.abort.signal, active.baseline, { goalId: active.record.id, goalEpoch: active.epoch }), active.abort.signal);
              this.assertCurrent(active);
              active.outcome = { contract: proposal.outcome, canonical: canonicalJson(proposal.outcome), bound, interpretation: proposal.interpretation };
              active.record.outcome = truncate(`${proposal.outcome.kind}: ${JSON.stringify(outcomeRoot)}`, BOUNDS.text);
              // Owner-visible interpretation is APP-OWNED, rendered from the accepted contract (MB-PLAN-006).
              active.record.interpretation = truncate(publicOutcome(proposal.outcome), BOUNDS.text);
              this.deps.store.record({ type: 'goal_outcome_bound', goalId: active.record.id, kind: proposal.outcome.kind, baselines: bound.baselines, boundAtMs: bound.boundAtMs, fromAdmission: Boolean(active.baseline), ...(active.handoff ? { intentId: active.handoff.intentId } : {}) });
              this.deps.journal?.record({ type: 'goal_interpretation', goalId: active.record.id, interpretation: proposal.interpretation, outcome: proposal.outcome as unknown as Record<string, unknown>, baselines: bound.baselines });
              this.deps.notify({ goalId: active.record.id, text: `Goal ${active.record.id}: ${active.record.interpretation}` });
            }
            c.windows += 1;
            c.tasksAdmitted += proposal.tasks.length;
            active.admittedTasks += proposal.tasks.length;
            this.deps.store.record({ type: 'goal_window', goalId: active.record.id, window: c.windows, source: turnKind === 'lookahead' ? 'lookahead' : 'planner_turn', tasks: proposal.tasks.map((t) => ({ objective: truncate(t.objective, 160), allowedCapabilities: t.allowedCapabilities })), morePlanningNeeded: proposal.morePlanningNeeded, counters: { ...c } });
            this.deps.notify({ goalId: active.record.id, audience: 'operator', text: `Goal ${active.record.id} window ${c.windows}: ${proposal.tasks.length} task(s): ${proposal.tasks.map((t) => truncate(publicTaskLabel(t), 80)).join(' | ')}` });
            // Execute the window in order. A task completing is NOT goal completion.
            const maintainKey = proposal.outcome.kind === 'persistent' ? canonicalJson(proposal.outcome.maintain) : undefined;
            let last: TaskResult | undefined;
            for (const [index, spec] of proposal.tasks.entries()) {
              // Only the currently admitted task continues while a replacement is pending.
              if (index > 0) await this.parkWhilePending(active);
              const mode: TaskMode = maintainKey !== undefined && canonicalJson(spec.completion) === maintainKey ? 'maintain' : 'complete';
              if (index === proposal.tasks.length - 1 && mode === 'complete' && proposal.morePlanningNeeded && proposal.outcome.kind === 'finite') this.maybeStartLookahead(active, spec);
              const result = await this.runTask(active, spec, mode);
              this.assertCurrent(active);
              if (!result || result.status === 'cancelled') return;
              last = result;
              if (result.status !== 'completed') break; // feedback goes to the next planner turn
            }
            active.windowEnd = { atMs: this.deps.clock.now(), afterWindow: c.windows };
            const verdict = await raceAbort(this.deps.outcomes.evaluate(active.outcome.bound, active.abort.signal), active.abort.signal);
            this.assertCurrent(active);
            active.outcomeStatus = { status: verdict.status, detail: truncate(verdict.detail, 400) };
            this.deps.store.record({ type: 'goal_outcome_evaluated', goalId: active.record.id, window: c.windows, status: verdict.status, detail: verdict.detail, evidence: verdict.evidence });
            if (active.outcome.contract.kind === 'finite' && verdict.status === 'satisfied') {
              this.dropLookahead(active, 'the goal outcome is already verified');
              this.deps.journal?.record({ type: 'goal_final_evidence', goalId: active.record.id, status: verdict.status, detail: verdict.detail, evaluation: verdict as unknown as Record<string, unknown>, counters: { ...c } });
              await this.finishIfCurrent(active, 'outcome_verified', `goal outcome verified by code: ${verdict.detail}; ${this.progressSummary(active)}`);
              return;
            }
            const ownerOutcome = active.outcome.contract.kind === 'finite' ? active.outcome.contract.outcome : active.outcome.contract.maintain;
            const guidanceFailure = last?.status === 'blocked' && last.feedback.unavailable.find((u) => u.capability === 'seek_owner' && ['no_locator_hint', 'hint_withdrawn', 'no_actionable_hint'].includes(u.reason));
            if (guidanceFailure && predicateTargetsOwner(ownerOutcome)) {
              const fresh = await raceAbort(observation.snapshot(active.epoch), active.abort.signal);
              this.assertCurrent(active);
              const hint = this.deps.locatorHint?.();
              if (!fresh?.owner.visible && !hint?.actionable) {
                this.dropLookahead(active, 'owner guidance is unavailable');
                const reason = hint?.reason ?? guidanceFailure.reason;
                this.deps.store.record({ type: 'owner_guidance_blocked', goalId: active.record.id, reason, counters: { ...c } });
                await this.finishIfCurrent(active, 'cannot_execute', `Owner guidance is unavailable (${reason}); ${this.progressSummary(active)}`);
                return;
              }
            }
            if (c.replans >= maxReplans) {
              this.dropLookahead(active, 'replan limit reached');
              await this.finishIfCurrent(active, 'limit_exhausted', `replan limit (${maxReplans}) reached with the outcome ${verdict.status} (${truncate(verdict.detail, 160)}); ${this.progressSummary(active)}`);
              return;
            }
            c.replans += 1;
            active.nextTurnKind = 'replan';
            // A usable lookahead plan replaces the replan turn (it is revalidated against fresh state first).
            carried = await this.takeLookahead(active, last);
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
   * unknown capabilities, stale draft) causes NO action. The planner gets a
   * bounded number of consecutive repair turns (each counted); then the goal blocks.
   */
  private async rejectAndMaybeRepair(active: ActiveGoal, requestId: string, kind: string, problems: string[], maxRepairs: number): Promise<boolean> {
    const question = isOwnerQuestionProblem(problems);
    if (question) {
      active.counters.questionRefusals += 1;
      this.deps.store.record({ type: 'planner_question_refused', goalId: active.record.id, requestId, refusals: active.counters.questionRefusals });
    }
    this.deps.store.record({ type: 'planner_proposal_rejected', goalId: active.record.id, requestId, kind, problems: problems.slice(0, 12) });
    this.deps.journal?.record({ type: 'goal_proposal_rejected', goalId: active.record.id, requestId, kind, problems: problems.slice(0, 12) });
    if (active.consecutiveRepairs < maxRepairs) {
      active.consecutiveRepairs += 1;
      active.counters.repairs += 1;
      active.rejection = problems.slice(0, 12);
      active.nextTurnKind = 'repair';
      return true;
    }
    // A question is never relayed: the blocker text is app-owned (MB-PLAN-006).
    const detail = question ? `${questionBlockerText(maxRepairs)}; ${this.progressSummary(active)}` : `${problems.slice(0, 3).join('; ')} (after ${maxRepairs} repair turn${maxRepairs === 1 ? '' : 's'}). No game actions were taken.`;
    await this.finishIfCurrent(active, kind === 'unknown_capabilities' ? 'capability_not_ready' : 'invalid_proposal', truncate(detail, BOUNDS.text));
    return false;
  }
}
