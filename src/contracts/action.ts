// Grounded action candidates, decision choices, and verified skill outcomes.
import { z } from 'zod';
import { BOUNDS, CapabilityIdSchema, JsonValueSchema, ParametersSchema, textSchema } from './common.ts';
import { ActionIdSchema, EpochSchema, GoalIdSchema, SnapshotIdSchema, TaskIdSchema } from './ids.ts';

/** Code-generated, grounded option offered to the decision model. */
export const ActionCandidateSchema = z
  .object({
    id: ActionIdSchema,
    capability: CapabilityIdSchema,
    /** Grounded target/parameters resolved by code; models cannot alter them. */
    parameters: ParametersSchema,
    snapshotId: SnapshotIdSchema,
    connectionEpoch: EpochSchema,
    goalEpoch: EpochSchema,
    description: textSchema(BOUNDS.shortText),
    criteria: z.array(textSchema(BOUNDS.shortText)).max(BOUNDS.listSmall),
    preconditions: z.array(textSchema(BOUNDS.shortText)).max(BOUNDS.listSmall),
    timeoutMs: z.number().int().positive().max(600_000),
  })
  .strict();
export type ActionCandidate = z.infer<typeof ActionCandidateSchema>;

/** A decision model only returns the ID of one supplied candidate. */
export const ActionChoiceSchema = z
  .object({
    candidateId: ActionIdSchema,
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
export type ActionChoice = z.infer<typeof ActionChoiceSchema>;

/** Typed evidence-bearing reason codes are snake_case; values are code-defined, not a goal vocabulary. */
const ReasonSchema = z.string().regex(/^[a-z_]{1,48}$/);

/**
 * Why an allowed capability produced no candidate for the current task and
 * snapshot (missing ingredient/tool/workstation/fuel, no visible target, no safe
 * path, out of travel bounds, ...). Structured evidence for later planner choices;
 * never a hidden prerequisite chain.
 */
export const CandidateUnavailableSchema = z
  .object({
    capability: CapabilityIdSchema,
    reason: ReasonSchema,
    detail: textSchema(BOUNDS.shortText),
    evidence: z.record(z.string().max(64), JsonValueSchema).default({}),
  })
  .strict();
export type CandidateUnavailable = z.infer<typeof CandidateUnavailableSchema>;

export const CandidateSetSchema = z
  .object({
    snapshotId: SnapshotIdSchema,
    connectionEpoch: EpochSchema,
    goalEpoch: EpochSchema,
    generatedAtMs: z.number().int().nonnegative(),
    candidates: z.array(ActionCandidateSchema).max(BOUNDS.listMedium),
    unavailable: z.array(CandidateUnavailableSchema).max(BOUNDS.listMedium),
    /** True when more grounded options existed than the bound allows. */
    truncated: z.boolean(),
  })
  .strict();
export type CandidateSet = z.infer<typeof CandidateSetSchema>;

export const SKILL_OUTCOME_STATUSES = ['succeeded', 'partial', 'failed', 'cancelled', 'precondition_failed'] as const;

/**
 * What confirmed the reported effect. `server_packet`: a server packet such as a
 * block change, collect, damage or death status. `server_sync`: an authoritative
 * window resync requested from the server. `client_only`: only the client model
 * changed (never counts as proof). `none`: no world effect was claimed.
 */
export const EVIDENCE_CONFIRMATIONS = ['server_packet', 'server_sync', 'client_only', 'none'] as const;

export const SkillOutcomeSchema = z
  .object({
    actionId: ActionIdSchema,
    /** `goal`: executed for an admitted goal/task. `diagnostic`: operator-issued mechanic diagnostic. */
    owner: z.enum(['goal', 'diagnostic', 'safety']).default('goal'),
    /** Present for goal-owned actions. */
    goalId: GoalIdSchema.optional(),
    taskId: TaskIdSchema.optional(),
    capability: CapabilityIdSchema.optional(),
    connectionEpoch: EpochSchema,
    goalEpoch: EpochSchema,
    status: z.enum(SKILL_OUTCOME_STATUSES),
    elapsedMs: z.number().int().nonnegative(),
    /** Observable effect evidence, never a model's claim. */
    effect: z.string().max(BOUNDS.text),
    reason: ReasonSchema.optional(),
    confirmation: z.enum(EVIDENCE_CONFIRMATIONS).default('none'),
    /** Bounded structured facts: confirmed counts, positions, partial effects, cleanup timing. */
    evidence: z.record(z.string().max(64), JsonValueSchema).default({}),
  })
  .strict();
export type SkillOutcome = z.infer<typeof SkillOutcomeSchema>;
export type SkillOutcomeInput = z.input<typeof SkillOutcomeSchema>;
