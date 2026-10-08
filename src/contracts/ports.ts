// Ports between the application core and adapters. Everything that crosses a
// port is plain data defined in src/contracts; no Minecraft library objects
// reach model-facing interfaces.
import type { ActionCandidate, ActionChoice, CandidateSet, SkillOutcome } from './action.ts';
import type { CapabilityCatalog } from './capability.ts';
import type { Dimension, Vec3 } from './common.ts';
import type { Epoch } from './ids.ts';
import type { KnowledgeQuery, KnowledgeResult } from './knowledge.ts';
import type { ObservationSnapshot } from './observation.ts';
import type { PlannerProposal, PlannerRequest } from './planner.ts';
import type { GoalOutcomeContract, OutcomePredicate, PredicateEvaluation } from './predicate.ts';
import type { ContinuationCapture, CountLineage, RemovalCarry } from './continuation.ts';
import type { TaskMode, TaskResult, TaskSpec } from './task.ts';
import type { JsonValue } from './common.ts';
import type { ConnectionEndReason, ConnectionState } from './states.ts';

export type Unsubscribe = () => void;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Adapter readiness reported by status/doctor without performing inference. */
export interface Readiness {
  ready: boolean;
  /** Short human-readable reason, e.g. which assignment installs the adapter. */
  detail: string;
}

// ---------------------------------------------------------------- game

export interface ReadyInfo {
  serverVersion: string;
  protocolVersion: number;
  dimension: Dimension;
  position: Vec3;
  gameMode: string;
  /** Whether the server performed online-mode (encrypted, session-verified) login. */
  serverOnlineMode: boolean;
}

export type GameLifecycleEvent =
  | { type: 'joining'; connectionEpoch: Epoch }
  | { type: 'ready'; connectionEpoch: Epoch; info: ReadyInfo }
  | { type: 'death'; connectionEpoch: Epoch }
  | { type: 'respawn'; connectionEpoch: Epoch; dimension: Dimension }
  | { type: 'dimension_change'; connectionEpoch: Epoch; from: Dimension; to: Dimension }
  | { type: 'ended'; connectionEpoch: Epoch; reason: ConnectionEndReason; detail: string };

/**
 * A chat line as received from the server, classified by packet type.
 * `player` lines carry the server-asserted sender UUID from the player-chat packet;
 * `system` (e.g. /tellraw) and `profileless` (e.g. console /say) lines have no sender.
 */
export interface ChatEnvelope {
  kind: 'player' | 'system' | 'profileless';
  /** Sender UUID from the player-chat packet (player kind only). */
  senderUuid?: string;
  /** Sender name from the server's player list for senderUuid (player kind only). */
  senderListName?: string;
  /** For player chat: the plain message the sender typed (not the rendered/decorated line). */
  text: string;
  /** Whether the message signature was verified by the protocol library. */
  signatureVerified: boolean;
  receivedAtMs: number;
}

export interface GamePort {
  readonly state: ConnectionState;
  readonly connectionEpoch: Epoch;
  /** Joins and resolves after spawn with valid world state. Rejects if aborted or ended. */
  connect(signal: AbortSignal): Promise<ReadyInfo>;
  /** Ends the connection and releases app-owned resources; bounded. */
  disconnect(reason: ConnectionEndReason, detail?: string): Promise<void>;
  onLifecycle(listener: (event: GameLifecycleEvent) => void): Unsubscribe;
  onChat(listener: (envelope: ChatEnvelope) => void): Unsubscribe;
  /** Identity facts for owner admission on the current connection (plain data). */
  admissionContext(): { selfUuid: string | undefined; serverOnlineMode: boolean };
  /** Sends a short reply to the owner (private message when supported). */
  replyToOwner(text: string): void;
  /** Plain-data snapshot for status; no inference, no world dumps. */
  statusInfo(): { dimension?: Dimension; position?: Vec3; health?: number; serverVersion?: string };
}

// ---------------------------------------------------------------- models and skills

export interface ObservationPort {
  readiness(): Readiness;
  /** A bounded, filtered snapshot. Read-only towards the game (no packets, actuator, interface or resync). */
  snapshot(goalEpoch: Epoch): Promise<ObservationSnapshot | null>;
  /**
   * Re-grounds a handle from an earlier snapshot to the SAME target in a newer
   * snapshot of the same connection/dimension; undefined when it is no longer
   * produced. Never a fallback to another target (MB-FLOW-002 draft revalidation).
   */
  translateHandle?(fromSnapshotId: string, handle: string, toSnapshotId: string): string | undefined;
}

export interface KnowledgePort {
  readiness(): Readiness;
  answer(queries: readonly KnowledgeQuery[], signal: AbortSignal): Promise<KnowledgeResult[]>;
}

export interface CapabilityRegistry {
  catalog(): CapabilityCatalog;
  has(id: string): boolean;
}

/** Who an execution belongs to. Goal-owned work is fenced by the goal epoch. */
export type ExecutionOwner =
  | { kind: 'goal'; goalEpoch: Epoch; goalId: string; taskId: string }
  | { kind: 'diagnostic'; diagnosticId: string };

export interface SkillExecutor {
  readiness(): Readiness;
  /**
   * Revalidates and executes one candidate under the single actuator lease.
   * Aborting `signal` (or an ownership change) revokes the lease: controls are
   * cleared and owned interfaces closed before the returned promise settles.
   */
  execute(candidate: ActionCandidate, signal: AbortSignal, owner?: ExecutionOwner): Promise<SkillOutcome>;
}

/** Task-driven grounded candidate generation from the registered capability resolvers. */
export interface CandidateGenerator {
  generate(task: TaskSpec, snapshot: ObservationSnapshot): CandidateSet;
}

/**
 * The goal (and epoch) that owns a bound predicate. Ownership-fenced evidence
 * (MB-MEM-001 memory refs) resolves only for this owner; without an owner such
 * predicates evaluate `unknown`.
 */
export interface PredicateOwner {
  goalId: string;
  goalEpoch: Epoch;
}

/** A predicate with its admission-bound baselines (opaque to callers). */
export interface BoundPredicate {
  readonly predicate: OutcomePredicate;
  readonly boundAtMs: number;
  readonly baselines: Readonly<Record<string, number>>;
  /** Owning goal/epoch when bound for goal work (absent for operator diagnostics). */
  readonly owner?: PredicateOwner;
}

/**
 * Server-confirmed inventory captured at goal ADMISSION, before the first
 * planner turn and before any outcome selector is known. A goal outcome bound
 * later measures acquisition from these ORIGINAL counts (opaque lifecycle
 * marks keep a death/reconnect since admission detectable).
 */
export interface InventoryBaseline {
  readonly capturedAtMs: number;
  /** Item key -> count; null when no correlated server inventory was available. */
  readonly counts: Readonly<Record<string, number>> | null;
  readonly detail: string;
  readonly connectionEpoch?: number;
  readonly lifecycleMark?: number;
}

/** Code-owned predicate evaluation against server-confirmed evidence. */
export interface PredicateEvaluator {
  /**
   * Binds acquisition/possession baselines at goal or task admission. With
   * `baseline`, acquisition baselines come from that admission-time inventory
   * (and the binding time is the baseline's capture time).
   */
  bind(predicate: OutcomePredicate, signal: AbortSignal, baseline?: InventoryBaseline, owner?: PredicateOwner): Promise<BoundPredicate>;
  evaluate(bound: BoundPredicate, signal: AbortSignal): Promise<PredicateEvaluation>;
  /** Captures the full server-confirmed inventory for a goal admission baseline. */
  captureBaseline?(signal: AbortSignal): Promise<InventoryBaseline>;
  /** MB-FLOW-003-C12: synchronous capture of a bound outcome at an interruption (ledger still valid). */
  captureContinuation?(bound: BoundPredicate): ContinuationCapture;
  /** MB-FLOW-003-C12: possession progress per count path for given held counts. */
  progressAt?(capture: ContinuationCapture, contract: GoalOutcomeContract, counts: Readonly<Record<string, number>>, returnsNow: (incidentId: string, selector: string) => number | null): Record<string, number | null>;
  /** MB-FLOW-003-C12: continuation binding of the immutable outcome (fresh counts re-bind credit only). */
  rebindContinuation?(contract: GoalOutcomeContract, input: { counts: readonly CountLineage[]; removal: readonly RemovalCarry[]; fresh: InventoryBaseline; original: InventoryBaseline; owner: PredicateOwner; /** Ledger entries before this are already carried (default: fresh capture time). */ notBeforeMs?: number }, signal: AbortSignal): Promise<BoundPredicate>;
}

/** Version-registry facts used to validate planner references (read-only; no inference). */
export interface RegistryFacts {
  /** Exact Minecraft version these facts describe. */
  readonly version: string;
  isItem(key: string): boolean;
  isBlock(key: string): boolean;
  isTag(key: string): boolean;
  /** At least one crafting-table/inventory recipe produces this item. */
  craftable(output: string): boolean;
  /** At least one furnace-type cooking recipe produces this item. */
  cookingOutput(output: string): boolean;
}

/**
 * One frozen Jev decision round. Candidates were generated by registered skill
 * resolvers for the current task and snapshot; the model may only return one of
 * their code-generated IDs. `state` is bounded, filtered, model-visible data.
 */
export interface DecisionRequest {
  requestId: string;
  goalId: string;
  goalEpoch: Epoch;
  taskId: string;
  connectionEpoch: Epoch;
  snapshotId: string;
  /** Planner-supplied task objective and bounded decision instruction. */
  objective: string;
  instruction: string;
  /** Bounded rendering of the code-checked completion (or maintained) condition. */
  condition?: string;
  mode?: TaskMode;
  state: JsonValue;
  candidates: readonly ActionCandidate[];
}

/** A validated Jev choice plus provider evidence (actual model, usage, cost, latency). */
export interface DecisionChoice extends ActionChoice {
  requestId: string;
  confidence: number;
  probabilities: Record<string, number>;
  requestedModel: string;
  model: string;
  provider: string;
  generationId?: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs: number;
  /** Attempts made for this decision, including a transient retry. */
  attempts: number;
}

/**
 * Typed decision failures. Each is explicit; there is no provider, model or
 * billing fallback. `aborted` means the owning goal/task was revoked.
 */
export const DECISION_FAILURE_KINDS = [
  'not_configured',
  'auth',
  'payment',
  'model_unavailable',
  'request_rejected',
  'request_too_large',
  'rate_limited',
  'transient',
  'timeout',
  'invalid_response',
  'model_mismatch',
  'route_changed',
  'pricing_changed',
  'spend_cap',
  'attempt_limit',
  'busy',
  'aborted',
] as const;
export type DecisionFailureKind = (typeof DECISION_FAILURE_KINDS)[number];

export interface DecisionFailure {
  kind: DecisionFailureKind;
  detail: string;
  requestId?: string;
  attempts: number;
  httpStatus?: number;
}

export interface DecisionPort {
  readiness(): Readiness;
  /** Rejects with an error carrying `failure: DecisionFailure` (see src/decision/errors.ts). */
  choose(request: DecisionRequest, signal: AbortSignal): Promise<DecisionChoice>;
  /** MB-FLOW-003-C12: keep a goal's per-goal attempt count across its continuation lineage (optional). */
  retainGoalBudget?(goalId: string, retain: boolean): void;
}

/** A TaskSpec admitted for execution by the owning goal epoch. */
export interface AdmittedTask {
  taskId: string;
  goalId: string;
  goalEpoch: Epoch;
  spec: TaskSpec;
  mode: TaskMode;
  /** Aborted when the owning goal is stopped, replaced or ended by a lifecycle event. */
  signal: AbortSignal;
  /** True while the goal epoch that admitted this task still owns control. */
  isCurrent(): boolean;
}

/** Generic task runtime: candidates -> Jev choice -> revalidation -> executor -> verified predicates. */
export interface TaskExecutionPort {
  readiness(): Readiness;
  run(task: AdmittedTask): Promise<TaskResult>;
}

export interface PlannerPort {
  readiness(): Readiness;
  /** One bounded planner turn. Must honor the abort signal. */
  propose(request: PlannerRequest, signal: AbortSignal): Promise<PlannerProposal>;
}

// ---------------------------------------------------------------- evidence

export interface EvidenceEvent {
  type: string;
  [field: string]: unknown;
}

export interface RunStore {
  readonly runId: string;
  record(event: EvidenceEvent): void;
  close(summary: Record<string, unknown>): Promise<void>;
}
