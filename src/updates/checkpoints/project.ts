import type { ContinuationCheckpoint } from '../../contracts/continuation.ts';
import type { IntakeOrigin } from '../../contracts/goal.ts';
import type { RouteLineage } from '../../contracts/locator.ts';
import { SemanticGoalSchema, digest, portableOutcome, type CheckpointAllowance, type SemanticGoal } from './schema.ts';

export interface ManagedGoalProjection {
  originalAdmittedAtMs: number;
  origin: IntakeOrigin;
  /** Exported from the actual Jev/recovery services, never inferred from logs. */
  allowances: CheckpointAllowance[];
  verifiedEffects: SemanticGoal['verifiedEffects'];
}

/** Canonical existing route usage -> durable, NON-executable allowance history. */
export function projectRouteLineage(carry: RouteLineage): NonNullable<SemanticGoal['route']> {
  return {
    grantedAtMs: carry.grantedAtMs, deadlineAtMs: carry.ceilings.routeDeadlineMs,
    anchor: { dimension: carry.dimension, at: { ...carry.admissionAnchor }, radius: carry.admissionRadius },
    limits: { legs: carry.ceilings.maxLegs, distance: carry.ceilings.maxTotalDistance, stalledLegs: carry.ceilings.maxStalledLegs, legRadius: carry.ceilings.legRadius, minLegProgress: carry.ceilings.minLegProgress },
    source: carry.source, destinations: [...carry.destinations],
    used: { legs: carry.legsUsed, distance: carry.distance.total, stalledLegs: carry.stalledLegs, continuations: carry.continuations,
      clientPhysics: carry.distance.clientPhysics, serverCorrections: carry.distance.serverCorrections, correctionSamples: carry.distance.correctionCount },
    state: carry.state, blocker: carry.blocker?.reason ?? null,
  };
}

/**
 * Consume the real existing code-authored continuation contract. Strings in its
 * verifiedEffects are display-only and not upgraded into ledger evidence. Extra
 * facts and allowances must come from the integration-owned capture services.
 * Old connection/goal epochs, route IDs, removal handles and action references
 * are deliberately not copied or made executable.
 */
export function projectContinuationCheckpoint(checkpoint: ContinuationCheckpoint, input: ManagedGoalProjection): SemanticGoal {
  const portable = portableOutcome(checkpoint.outcome, checkpoint.admissionBaseline.counts !== null);
  let heldReason = portable.heldReason;
  if (digest(JSON.parse(checkpoint.outcomeCanonical)) !== portable.outcomeDigest) heldReason = 'original_outcome_canonical_mismatch';
  if (['restart_held', 'completed', 'superseded_by_owner', 'stopped_by_owner', 'blocked'].includes(checkpoint.state)) heldReason = 'display_only_or_terminal_checkpoint';
  const decision = input.allowances.find((a) => a.key === 'decision_attempts');
  if (!decision) heldReason = 'decision_allowance_unknown';
  return SemanticGoalSchema.parse({
    goalId: checkpoint.goalId, instruction: checkpoint.instruction, origin: input.origin,
    admittedAtMs: input.originalAdmittedAtMs, deadlineAtMs: checkpoint.deadlineAtMs,
    ...portable, heldReason,
    admissionBaseline: structuredClone(checkpoint.admissionBaseline), anchor: structuredClone(checkpoint.anchor),
    counters: structuredClone(checkpoint.counters), caps: { ...checkpoint.caps }, admittedTasks: checkpoint.admittedTasks,
    counts: portable.acceptedOutcome ? structuredClone(checkpoint.counts) : [],
    verifiedEffects: structuredClone(input.verifiedEffects), continuations: { ...checkpoint.continuations },
    allowances: structuredClone(input.allowances), route: checkpoint.route ? projectRouteLineage(checkpoint.route) : null,
  });
}
