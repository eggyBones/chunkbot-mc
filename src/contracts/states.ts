// Connection and goal lifecycle states plus typed terminal reasons.
import { z } from 'zod';

export const CONNECTION_STATES = ['disconnected', 'joining', 'ready', 'ended'] as const;
export const ConnectionStateSchema = z.enum(CONNECTION_STATES);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

/** Why a connection ended. Each value is a lifecycle cause, not a goal category. */
export const CONNECTION_END_REASONS = [
  'operator_stop', // stop/quit while joining or shutdown requested by the operator
  'shutdown_signal', // SIGINT / SIGTERM
  'kicked',
  'disconnected', // socket closed by server/network
  'join_timeout',
  'auth_required', // Microsoft sign-in required; never downgraded automatically
  'auth_failed',
  'identity_conflict', // bot identity equals the owner identity
  'connect_error',
] as const;
export const ConnectionEndReasonSchema = z.enum(CONNECTION_END_REASONS);
export type ConnectionEndReason = z.infer<typeof ConnectionEndReasonSchema>;

export const ACTIVE_GOAL_STATES = ['planning', 'awaiting_owner', 'executing', 'stopping'] as const;
export const TERMINAL_GOAL_STATES = ['completed', 'cancelled', 'blocked', 'failed'] as const;
export const GOAL_STATES = ['idle', ...ACTIVE_GOAL_STATES, ...TERMINAL_GOAL_STATES] as const;

export const GoalStateSchema = z.enum(GOAL_STATES);
export type GoalState = z.infer<typeof GoalStateSchema>;
export type ActiveGoalState = (typeof ACTIVE_GOAL_STATES)[number];
export type TerminalGoalState = (typeof TERMINAL_GOAL_STATES)[number];

export function isTerminalGoalState(state: GoalState): state is TerminalGoalState {
  return (TERMINAL_GOAL_STATES as readonly string[]).includes(state);
}

export function isActiveGoalState(state: GoalState): state is ActiveGoalState {
  return (ACTIVE_GOAL_STATES as readonly string[]).includes(state);
}

/**
 * Typed terminal reasons. `cancelled` = stop/replacement; `blocked` = known unmet
 * prerequisite/limit/capability; `failed` = unexpected runtime/provider failure or
 * a lifecycle interruption (death, disconnect, dimension change) that ended ownership.
 */
export const TERMINAL_REASON_CODES = [
  // cancelled
  'owner_stop',
  'replaced',
  'shutdown',
  // blocked
  'planner_not_ready',
  'capability_not_ready',
  'knowledge_not_ready',
  'cannot_execute',
  'limit_exhausted',
  'invalid_proposal',
  'decision_not_ready', // Jev adapter unconfigured/unauthorized/unpaid/unroutable (explicit; no fallback)
  'no_progress', // no meaningful progress on an unmet outcome within the no-progress window
  'low_health', // health at or below the configured interruption threshold
  'safety_interrupted', // MB-FLOW-001/003: a survival safety decision revoked unsafe active work (owner intent retained)
  // failed
  'death',
  'disconnected',
  'kicked',
  'dimension_change',
  'planner_error',
  'runtime_error',
  'decision_error', // Jev request failed after bounded handling (transient retry exhausted, invalid response)
  // completed
  'outcome_verified',
] as const;
export const TerminalReasonCodeSchema = z.enum(TERMINAL_REASON_CODES);
export type TerminalReasonCode = z.infer<typeof TerminalReasonCodeSchema>;
