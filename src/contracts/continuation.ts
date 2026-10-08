// MB-FLOW-003-C12 shared continuation API — PROPOSED by P (single shared
// writer), DECLARATIONS ONLY, NOT CONSUMED until Codex approves. Not exported
// from contracts/index.ts yet (S's r2 declarations in survival.ts use some of
// the same names; after approval S imports these and deletes its copies).
//
// Smallest shared surface, answering the joint review (points 1-6):
//   1. SAME logical goal id re-admitted at a FRESH epoch (Jev per-goal attempts,
//      memory, journal and status keep one identity); the FULL shared counters
//      carried cumulatively and compared with the ORIGINAL ceilings; the ORIGINAL
//      absolute deadline (no fresh goalDeadlineMs).
//   2. The checkpoint carries the immutable ORIGINAL admission baseline (with its
//      provenance; unknown stays unknown), the immutable accepted outcome, the
//      original travel anchor and code-confirmed accounting. A fresh resync at
//      continuation is CURRENT evidence for re-binding credit only:
//        possession: carried = min(V, max(0, F - B0)); acquired = carried + max(0, now - F)
//        effect:     carried = V (skill-confirmed crafts/smelts since admission)
//      so returned original belongings never newly acquire credit.
//   3. Plain data only: no snapshot handles, action ids, tasks, leases or epochs.
//      Only atoms groundable from SEMANTIC identity continue; others hold the
//      checkpoint with one declarative reason; the outcome is never rewritten.
//   4. P holds the same-session checkpoint IN MEMORY (works with survival,
//      memory and autonomy disabled). Survival's service is optional: frozen
//      last-alive inventory, a recovery-priority gate, display-only persistence.
//      Readiness never consults the automatic progression latch; explicit stop
//      and any new owner/operator intake fence held work; nothing moves after stop.
//   5. Immediate W preemption keeps the goal admitted (TaskRuntime hold gate);
//      only interruptions that ENDED ownership create a checkpoint.
//   6. Code-owned route allowance carried in the same lineage: the continuation
//      epoch's route grant copies the ORIGINAL ceilings (absolute route deadline)
//      and the legs/distance already used; it never refills or re-anchors.
import type { GoalRecord } from './goal.ts';
import type { GoalOutcomeContract } from './predicate.ts';
import type { Vec3 } from './common.ts';
import type { RouteCeilings, RouteDestinationKind, RouteBlocker } from './locator.ts';

export const CONTINUATION_VERSION = 1 as const;

/**
 * Interruptions that ENDED goal ownership and may be continued in v1: same
 * application session, same connection epoch, original dimension. Other ends
 * (disconnect, kick, dimension change) record a held, NON-executable checkpoint
 * with reason `not_continuable_in_v1` (display only); owner stop/replacement
 * never create one.
 */
export const CONTINUABLE_INTERRUPTIONS = ['death', 'low_health', 'safety_interrupted'] as const;
export const HELD_ONLY_INTERRUPTIONS = ['disconnected', 'kicked', 'dimension_change'] as const;
export type CheckpointInterruption = (typeof CONTINUABLE_INTERRUPTIONS)[number] | (typeof HELD_ONLY_INTERRUPTIONS)[number];

/** Full shared counters as the goal record stores them (incl. questionRefusals and the inert legacy `clarifications`). */
export type CarriedCounters = NonNullable<GoalRecord['counters']>;

/** One atom of the immutable outcome, addressed like PredicateEngine evaluation paths ('root', 'root.0', ...). */
export interface AtomGrounding {
  path: string;
  predicate: string;
  status: 'groundable' | 'not_groundable';
  /** `observed_handle`, `prior_result_action`, `remembered_anchor`, `memory_ref`, `count_under_any_or_not`, `baseline_unknown`. */
  reason?: string;
}

/** Code-confirmed accounting of one count atom (never planner text; uncertain data labeled, never upgraded). */
export interface AcquisitionEntry {
  path: string;
  basis: 'possession' | 'effect';
  predicate: 'inventory_delta' | 'inventory_amount' | 'crafting_result' | 'smelting_result';
  selector: string;
  atLeast: number;
  /** B0: count matching `selector` in the ORIGINAL admission baseline (null -> not continuable). */
  admissionCount: number | null;
  /** V: prior verified progress, recomputed against the ORIGINAL B0 at every interruption. */
  verifiedAcquired: number;
  evidence: 'last_alive_server_packets' | 'current_server_inventory' | 'last_code_evaluation' | 'skill_confirmed_outputs' | 'unavailable';
  /** inventory_delta mayBeConsumedLater milestone reached before the interruption: stays satisfied. */
  latched: boolean;
  consumedSinceAdmission: number;
}

/** Bound target positions of a `blocks_removed` atom (world coordinates = semantic identity; not a handle). */
export interface RemovalCarry {
  path: string;
  selector: string;
  dimension: string;
  /** Bounded (<= 256) positions still bound at the interruption ("x,y,z" -> key at binding). */
  members: Array<{ x: number; y: number; z: number; key: string }>;
  group?: { class: string; min: Vec3; max: Vec3 };
}

/** Route allowance lineage (L's RouteController copies it into the continuation epoch's grant). */
export interface RouteCarry {
  routeId: string;
  originalGoalEpoch: number;
  grantedAtMs: number;
  /** ORIGINAL frozen ceilings; `routeDeadlineMs` is absolute and never recomputed. */
  ceilings: Readonly<RouteCeilings>;
  destinations: readonly RouteDestinationKind[];
  legsUsed: number;
  distanceUsed: number;
  stalledLegs: number;
  /** A route exhausted/blocked before the interruption stays so. */
  blocker: RouteBlocker | null;
}

/** The same-session semantic checkpoint P holds in memory (survival may persist a copy for display only). */
export interface ContinuationCheckpoint {
  version: typeof CONTINUATION_VERSION;
  /** The SAME logical goal id for every continuation of this owner job. */
  goalId: string;
  /** App process session; another session (restart) only displays it (`restart_held`). */
  sessionId: string;
  connectionEpoch: number;
  dimension: string;
  instruction: string;
  /** App-owned public outcome text (never planner prose). */
  publicOutcome: string;
  outcome: GoalOutcomeContract;
  /** Canonical JSON of `outcome` (immutability check for every later proposal). */
  outcomeCanonical: string;
  admissionBaseline: { capturedAtMs: number; counts: Record<string, number> | null; detail: string };
  /** ORIGINAL admission anchor; the continuation installs exactly this anchor (never the respawn position). */
  anchor: { dimension: string; at: Vec3; radius: number };
  counters: CarriedCounters;
  /** ORIGINAL ceilings; admission compares the cumulative counters with these (nothing refilled or double-charged). */
  caps: { plannerTurns: number; tasks: number; replans: number };
  admittedTasks: number;
  /** ORIGINAL absolute deadline; past it the checkpoint is blocked `deadline_passed`. */
  deadlineAtMs: number;
  grounding: AtomGrounding[];
  accounting: AcquisitionEntry[];
  removal: RemovalCarry[];
  route: RouteCarry | null;
  /** Historical labels only (e.g. "crafted 1 crafting_table"); never action ids or handles. */
  verifiedEffects: string[];
  /** Bounded continuation allowance for this job (default 2); each continuation is counted before planning. */
  continuations: { used: number; max: number };
  interruptions: Array<{ reason: CheckpointInterruption; atMs: number; epoch: number }>;
  state: 'held' | 'continuing' | 'completed' | 'superseded_by_owner' | 'stopped_by_owner' | 'blocked' | 'restart_held';
  /** Code reason for `held`/`blocked` (e.g. recovery_open, not_groundable:observed_handle, deadline_passed, continuations_exhausted, not_continuable_in_v1). */
  stateReason: string;
  stateAtMs: number;
}

/** Credit re-bound at the continuation admission from CURRENT evidence (fresh resync), per count atom. */
export interface ContinuationCarry {
  path: string;
  basis: AcquisitionEntry['basis'];
  selector: string;
  atLeast: number;
  carried: number;
  /** F: fresh count at the continuation admission (possession basis). */
  freshCount?: number;
  latched: boolean;
  detail: string;
}

/** Survival's OPTIONAL service contribution (absent: continuation still works; gate = clear). */
export interface ContinuationSurvivalPort {
  /** Packet-frozen last-alive counts of the latest own death on this connection (V evidence), else null. */
  frozenInventory(connectionEpoch: number): { counts: Record<string, number>; evidence: 'last_alive_server_packets' } | null;
  /** Necessary recovery/support has priority: open episode or running support -> wait. */
  continuationGate(nowMs: number): { kind: 'clear' } | { kind: 'wait'; reason: 'recovery_open' | 'support_running' | 'not_alive'; detail: string } | { kind: 'blocked'; reason: string; detail: string };
  /** Display-only persistence (loaded after a restart as `restart_held`; never executed). */
  persistCheckpoint(checkpoint: ContinuationCheckpoint): void;
}

/** GoalEngine surface (P). Everything local and inference-free except the admitted goal's own later planner turns. */
export interface ContinuationEnginePort {
  /** Held/continuing checkpoints for status/dashboard (bounded copies). */
  checkpoints(): readonly ContinuationCheckpoint[];
  /**
   * Fresh readiness decision and, when ready, the continuation admission of
   * the SAME goal id at a new epoch through the single admission path:
   * original anchor + route carry via onGoalAdmitted, fresh resync -> carry
   * re-binding via PredicateEvaluator.rebindContinuation, cumulative counters
   * and original ceilings/deadline, first planner turn kind `continuation`.
   * Refused (checkpoint unchanged; one declarative reason) unless: same
   * session/connection epoch/dimension, game ready, alive, no active owner
   * goal, no pending/in-flight owner intake, safety authority not `none`,
   * survival gate clear (when installed), checkpoint `held` and continuable,
   * deadline/caps/continuations remaining.
   */
  continueHeld(goalId: string, cause: 'respawn_ready' | 'recovery_concluded' | 'safety_clear'): Promise<{ status: 'admitted'; goalId: string; epoch: number; continuation: number } | { status: 'not_ready'; reason: string; detail: string } | { status: 'blocked'; reason: string; detail: string }>;
}
