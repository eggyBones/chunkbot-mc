// Proposed narrow public seams. Existing composition/core files stay owned by
// integration. The module accepts code-authored semantic data, never model text.
import type { SpendReservation, SpendSnapshot } from '../../decision/spend.ts';
import type { CheckpointAllowance, CheckpointScope, ManagedCheckpoint, SemanticGoal } from './schema.ts';

export interface CheckpointStoreOptions {
  dir: string;
  scope: CheckpointScope;
  sessionId: string;
  now?: () => number;
  /** Offline fault injection, never a production shell hook. */
  fault?: (point: 'before_write' | 'after_file_sync' | 'after_rename' | 'after_directory_sync') => void;
}
export type CheckpointLoad =
  | { status: 'ready'; checkpoint: ManagedCheckpoint }
  | { status: 'held'; reason: string; checkpoint: ManagedCheckpoint | null };

export type ResumeView =
  | { kind: 'offline'; generation: number }
  | { kind: 'paused'; generation: number }
  | { kind: 'held'; generation: number | null; reason: string }
  | { kind: 'idle'; generation: number }
  | { kind: 'replan'; generation: number; goal: SemanticGoal; historical: true };

/** Structurally uses the REAL SpendLedger; no second cost-accounting algorithm. */
export interface CheckpointDecisionOwner { goalId: string; expectedGeneration: number }
export interface CheckpointSpendPort {
  readonly capUsd: number;
  remainingUsd(): number;
  reserve(amountUsd: number, label: string, owner?: CheckpointDecisionOwner): SpendReservation | undefined;
  reconcile(reservation: SpendReservation, costUsd: number): void;
  retain(reservation: SpendReservation): void;
  release(reservation: SpendReservation): void;
  snapshot(): SpendSnapshot;
}

/** Integration must implement this restore seam; a new zero ledger is refused. */
export type RestoreCheckpointSpend = (checkpoint: SpendSnapshot) => CheckpointSpendPort;

export interface CreateManagedSession {
  /** Explicit operator start of a NEW budget/session; never called by update. */
  authorization: 'explicit_operator_new_session';
  capUsd: number;
  onlineIntent: boolean;
  paused: boolean;
  allowances: CheckpointAllowance[];
}

export interface CaptureManagedGoal {
  expectedGeneration: number;
  goal: SemanticGoal;
}
