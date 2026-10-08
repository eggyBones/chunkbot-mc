// MB-FLOW-003-C12 shared continuation contract — APPROVED SEAM (coordinator
// decisions after P r2). P (single shared writer) implements the GoalEngine /
// predicate / app wiring; S implements ContinuationSurvivalPort; L implements
// the route lineage export/admission against RouteCarry (structural; L may
// refine field names in src/contracts/locator.ts with Codex, P adapts).
//
// Rules:
//   1. Continuation re-admits the SAME logical goal id at a fresh, monotonically
//      increasing epoch: Jev per-goal budget key, memory, journal and status keep
//      one identity. ALL cumulative counters (incl. questionRefusals and the inert
//      legacy clarifications), the ORIGINAL caps, admitted-task count, ORIGINAL
//      absolute deadline, ORIGINAL admission inventory (with provenance) and
//      ORIGINAL travel anchor carry over. The first continuation planner turn
//      counts normally. Default at most 2 continuations within those limits.
//   2. Count accounting follows the CURRENT code-verified lineage (B0 stays
//      immutable provenance). At interruption k with held count H_k and verified
//      progress C_k, the non-credit part is N_k = H_k - C_k. In the next segment:
//        restored(now) = min(C_k, max(0, X(now) - N_k))
//          X = server-attributed own-incident returns (regained + retained) when
//              the interruption had an item-loss incident; else the fresh count F
//        new(now)      = max(0, now - F - ownReturnedSinceF(now)) [+ consumption since rebind]
//        progress      = restored + new
//      so returned own belongings never become new acquisition, incidental
//      pickups never restore credit, and genuinely new resources after a lossy
//      death keep their own credit at the next interruption (B0 8, +4, death
//      recovers nothing, 3 new, death again -> C = 3, never max(0, 3 - 8)).
//      Effect atoms (crafting/smelting) carry their code-verified ledger credit.
//      Latched milestones stay satisfied. Unknown provenance -> that count atom is
//      held (declarative reason); groundable non-count jobs still continue.
//   3. Plain data only: no snapshot handles, action ids, tasks, leases or epochs.
//      Groundability is derived from predicate SEMANTICS (never a goal intent).
//      Observed-handle/prior-result/remembered/memory atoms stay held with one
//      declarative reason; blocks_removed carries its bound world positions and
//      component identity (server facts verified freshly).
//   4. P holds the checkpoint in memory; it works with survival, memory and
//      autonomy disabled. Readiness authority is code-owned and finite (no
//      dependency on the automatic progression latch or on an active goal's
//      safety authority). Explicit stop and any new owner/operator intake fence
//      held checkpoints synchronously. Optional durable copies are display-only.
//   5. Immediate safety preemption keeps the goal admitted; only interruptions
//      that ENDED ownership create a checkpoint.
//   6. Route allowance lineage transfers (exact usage state); no old leg,
//      actuator or task resumes, nothing refills or re-anchors.
import type { Vec3 } from './common.ts';
import type { GoalRecord } from './goal.ts';
import type { GoalOutcomeContract } from './predicate.ts';
import type { RouteBlocker, RouteCeilings, RouteDestinationKind, RouteDistanceAccount } from './locator.ts';

export const CONTINUATION_VERSION = 1 as const;
/** Default continuation allowance per owner job (within the job's original limits). */
export const DEFAULT_MAX_CONTINUATIONS = 2;

/** Ownership ends that may be continued in v1 (same session, connection epoch and dimension). */
export const CONTINUABLE_INTERRUPTIONS = ['death', 'low_health', 'safety_interrupted'] as const;
/** Ownership ends recorded as held, NON-executable checkpoints (display only) in v1. */
export const HELD_ONLY_INTERRUPTIONS = ['disconnected', 'kicked', 'dimension_change'] as const;
export type CheckpointInterruption = (typeof CONTINUABLE_INTERRUPTIONS)[number] | (typeof HELD_ONLY_INTERRUPTIONS)[number];

/** Full shared counters exactly as the goal record stores them. */
export type CarriedCounters = NonNullable<GoalRecord['counters']>;

/** One atom of the immutable outcome, addressed like PredicateEngine evaluation paths ('root', 'root.0', ...). */
export interface AtomGrounding {
  path: string;
  predicate: string;
  status: 'groundable' | 'not_groundable';
  /** e.g. observed_handle, prior_result_action, remembered_anchor, memory_ref, count_under_any_or_not, baseline_unknown, provenance_unavailable. */
  reason?: string;
}

/** Code-verified count lineage of one count atom (never planner text; uncertainty labeled, never upgraded). */
export interface CountLineage {
  path: string;
  basis: 'possession' | 'effect';
  predicate: 'inventory_delta' | 'inventory_amount' | 'crafting_result' | 'smelting_result';
  selector: string;
  atLeast: number;
  /** B0: ORIGINAL admission count matching `selector` (immutable provenance; null = unknown). */
  admissionCount: number | null;
  /** C_k: verified progress at the latest interruption (null while pending, e.g. death awaiting frozen evidence). */
  credited: number | null;
  /** H_k: held count at the latest interruption (possession; null when unknown). */
  heldAtInterruption: number | null;
  evidence: 'current_server_inventory' | 'last_alive_server_packets' | 'skill_confirmed_outputs' | 'pending' | 'unavailable';
  /** inventory_delta mayBeConsumedLater milestone reached: stays satisfied. */
  latched: boolean;
  /** Item-loss incident of the latest interruption whose server-attributed own returns restore credit (null: no incident). */
  incidentId: string | null;
  /** Interruptions accounted so far for this atom. */
  segments: number;
}

/** Bound positions and component identity of a `blocks_removed` atom (world coordinates; never a handle). */
export interface RemovalCarry {
  path: string;
  selector: string;
  dimension: string;
  /** Bounded (<= 256) bound positions. */
  members: Array<{ x: number; y: number; z: number; key: string }>;
  identity?: { class: string; anchors: Vec3[]; others: Vec3[]; min: Vec3; max: Vec3 };
}

/**
 * Route authorization lineage (exact usage state so nothing resets): L's
 * RouteController exports it at the interruption and admits the continuation
 * epoch with it. Leg numbering continues after `nextLegIndex`; the counted
 * distance account, stalled history, blocker and ABSOLUTE deadline carry; the
 * ORIGINAL admission anchor/radius stay. No old leg is resumed.
 */
export interface RouteCarry {
  routeId: string;
  originalGoalEpoch: number;
  grantedAtMs: number;
  ceilings: Readonly<RouteCeilings>;
  destinations: readonly RouteDestinationKind[];
  admissionAnchor: Vec3;
  admissionRadius: number;
  state: 'authorized' | 'leg_active' | 'exhausted' | 'blocked' | 'revoked';
  legsUsed: number;
  nextLegIndex: number;
  distance: Readonly<RouteDistanceAccount>;
  stalledLegs: number;
  blocker: { reason: RouteBlocker; detail: string } | null;
  /** Opaque frozen own-incident identity bound by the route (L-owned shape; compared, never re-bound). */
  boundOwnDeath: unknown | null;
}

/** The same-session semantic checkpoint P holds in memory (S may persist a copy for display only). */
export interface ContinuationCheckpoint {
  version: typeof CONTINUATION_VERSION;
  /** The SAME logical goal id for every continuation of this owner job. */
  goalId: string;
  sessionId: string;
  connectionEpoch: number;
  dimension: string;
  instruction: string;
  /** App-owned public outcome text (never planner prose). */
  publicOutcome: string;
  outcome: GoalOutcomeContract;
  outcomeCanonical: string;
  admissionBaseline: { capturedAtMs: number; counts: Record<string, number> | null; detail: string };
  anchor: { dimension: string; at: Vec3; radius: number } | null;
  counters: CarriedCounters;
  caps: { plannerTurns: number; tasks: number; replans: number };
  admittedTasks: number;
  deadlineAtMs: number;
  grounding: AtomGrounding[];
  counts: CountLineage[];
  removal: RemovalCarry[];
  route: RouteCarry | null;
  /** Historical labels only (e.g. "crafted 1 crafting_table"). */
  verifiedEffects: string[];
  continuations: { used: number; max: number };
  interruptions: Array<{ reason: CheckpointInterruption; atMs: number; epoch: number }>;
  state: 'capturing' | 'held' | 'continuing' | 'completed' | 'superseded_by_owner' | 'stopped_by_owner' | 'blocked' | 'restart_held';
  /** Code reason for held/blocked (e.g. waiting:recovery_open, not_groundable:observed_handle, provenance_unavailable, deadline_passed, continuations_exhausted, not_continuable_in_v1). */
  stateReason: string;
  stateAtMs: number;
}

/** Server-attributed own-incident returns (S): regained (any collector) and retained, per item key; never foreign/incidental items. */
export interface IncidentReturns {
  incidentId: string;
  connectionEpoch: number;
  regained: Record<string, number>;
  retained: Record<string, number>;
  /** `server_attributed`: complete for this incident so far; `unknown`: attribution not established (count atoms stay held). */
  attribution: 'server_attributed' | 'unknown';
}

/** S's OPTIONAL service (absent: continuation still runs; lossy-death count atoms are then held for provenance). */
export interface ContinuationSurvivalPort {
  /** Packet-frozen last-alive counts of the latest own death on this connection, with its incident id. */
  frozenInventory(connectionEpoch: number): { incidentId: string; counts: Record<string, number>; evidence: 'last_alive_server_packets' } | null;
  /** Bounded, server-attributed own-incident return lineage (late returns by ANY collector included). */
  incidentReturns(incidentId: string): IncidentReturns | null;
  /** Necessary recovery/support first: open episode or running support -> wait (finite, code-owned). */
  continuationGate(nowMs: number): { kind: 'clear' } | { kind: 'wait'; reason: 'recovery_open' | 'support_running' | 'not_alive'; detail: string } | { kind: 'blocked'; reason: string; detail: string };
  /** Display-only persistence (restart loads `restart_held`; never executed). */
  persistCheckpoint(checkpoint: ContinuationCheckpoint): void;
}

export type ContinueResult =
  | { status: 'admitted'; goalId: string; epoch: number; continuation: number }
  | { status: 'not_ready'; reason: string; detail: string }
  | { status: 'blocked'; reason: string; detail: string };

/** GoalEngine surface (P). */
export interface ContinuationEnginePort {
  checkpoints(): readonly ContinuationCheckpoint[];
  continueHeld(goalId: string, cause: 'respawn_ready' | 'recovery_concluded' | 'safety_clear' | 'scheduled'): Promise<ContinueResult>;
}
