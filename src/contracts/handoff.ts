// MB-FLOW-002 smooth directive handoff and bounded window lookahead.
//
// Gate H-G1 decision: a non-admitted preparation is a typed PLANNING SUBJECT on
// the single existing PlannerPort, never a goal. The same port (and the goal
// engine's single planner slot) serves goal turns, owner-instruction
// preparation and goal-owned window lookahead, so there is exactly one owned
// planner process. A preparation subject carries an intent id + generation +
// connection epoch, not a goal id: it owns no goal, epoch, travel anchor,
// inventory baseline, actuator lease or interface. Its draft is revalidated
// after the real admission (fresh anchor, server-confirmed inventory baseline,
// re-grounded references) before any action; the accepted outcome binds only
// to that admission baseline.
import type { Epoch, GoalId, IntentId } from './ids.ts';

/** Who one planner turn plans for. */
export type PlanningSubject =
  /** An admitted goal that owns control (initial/knowledge/repair/retry/clarification/replan/lookahead turns). */
  | { kind: 'goal'; goalId: GoalId; goalEpoch: Epoch }
  /**
   * A pending owner instruction that is NOT admitted. The active goal (if any)
   * keeps its admitted task meanwhile. Nothing planned here may act until the
   * instruction is admitted and its draft revalidated against fresh state.
   */
  | {
      kind: 'preparation';
      intentId: IntentId;
      /** Monotonic intake generation; a newer instruction or stop supersedes it. */
      generation: number;
      connectionEpoch: Epoch;
      /** The goal that still owns control while this instruction is prepared (null: idle/finished). */
      activeGoalId: GoalId | null;
    };

/** Planner-visible preparation facts (bounded; read-only). */
export interface PreparationContext {
  /** Objective of the old task that continues until handoff (bounded), if any. */
  continuingTask: string | null;
  /** The observation's inventory is the client model at preparation time; the admission inventory is captured by the server at handoff. */
  inventory: 'provisional_client_model';
  note: string;
}

/** Planner-visible lookahead facts: the window's last task is still running. */
export interface LookaheadContext {
  /** Objective of the still-running last task of the current window (bounded). */
  runningTask: string;
  note: string;
}

/** Lifecycle of the single pending instruction. */
export const PENDING_INSTRUCTION_STATES = ['preparing', 'awaiting_owner', 'handing_off'] as const;
export type PendingInstructionState = (typeof PENDING_INSTRUCTION_STATES)[number];

/** A clarification asked while preparing (separate from the active goal; no goal owns it yet). */
export interface PendingClarification {
  intentId: IntentId;
  ref: string;
  question: string;
  askedAtMs: number;
}

/** Plain-data status of the pending instruction (status, dashboard). */
export interface PendingInstructionStatus {
  intentId: IntentId;
  generation: number;
  instruction: string;
  state: PendingInstructionState;
  receivedAtMs: number;
  updatedAtMs: number;
  /** Goal that keeps control until handoff (null: none). */
  activeGoalId: GoalId | null;
  /** Planner turns spent on this preparation (they transfer to the admitted goal). */
  plannerTurns: number;
  pendingClarification?: PendingClarification;
}

/** Why a preparation ended without admission. */
export const PREPARATION_DISCARD_REASONS = [
  'superseded', // a newer owner instruction replaced it
  'owner_stop',
  'lifecycle', // death, disconnect, kick, dimension change
  'shutdown',
  'planner_not_ready', // auth / quota / model unavailable / isolation gate
  'planner_error', // retries exhausted, prohibited event, reroute
  'invalid_proposal', // repairs exhausted
  'cannot_execute',
  'limit_exhausted', // turn allowance or preparation deadline
  'not_connected',
] as const;
export type PreparationDiscardReason = (typeof PREPARATION_DISCARD_REASONS)[number];

/** Per-run handoff totals (actual counts; discarded turns are bounded by `discardedTurnAllowance`). */
export interface HandoffTotals {
  preparations: number;
  handedOff: number;
  discarded: number;
  /** Planner turns spent on preparations that were never admitted (counted against the run allowance). */
  discardedTurns: number;
  discardedTurnAllowance: number;
  /** Planner turns transferred to admitted goals. */
  transferredTurns: number;
  lookaheadTurns: number;
  lookaheadsUsed: number;
  lookaheadsDiscarded: number;
}

/** Explicit owner pause latch set by `stop` (cleared only by an explicit resume). */
export interface ControlLatch {
  paused: boolean;
  sinceMs?: number;
  /** What set the latch (owner stop surface). */
  source?: string;
}

/** Measured planner waiting between two consecutive windows of one goal. */
export interface WindowGap {
  goalId: GoalId;
  afterWindow: number;
  /** Last task of the previous window finished -> first task of the next window started (ms). */
  gapMs: number;
  source: 'lookahead' | 'replan';
  /** Fresh revalidation time of a lookahead draft before its first task (ms; never assumed zero). */
  revalidationMs?: number;
}
