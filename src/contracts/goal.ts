// Goal records. A goal is an open-ended natural-language instruction plus
// code-owned lifecycle state; there is no goal-type/intent enum.
import { z } from 'zod';
import { BOUNDS } from './common.ts';
import { ClarificationRequestSchema } from './clarification.ts';
import { EpochSchema, GoalIdSchema } from './ids.ts';
import { GoalStateSchema, TerminalReasonCodeSchema } from './states.ts';

export const INTAKE_SURFACES = ['chat', 'terminal'] as const;
export const IntakeSurfaceSchema = z.enum(INTAKE_SURFACES);
export type IntakeSurface = z.infer<typeof IntakeSurfaceSchema>;

/** Where an admitted instruction came from. Identity is already verified by the caller. */
export const IntakeOriginSchema = z
  .object({
    surface: IntakeSurfaceSchema,
    /** Role, not a personal identifier: chat input is always from the verified owner. */
    principal: z.enum(['owner', 'operator']),
  })
  .strict();
export type IntakeOrigin = z.infer<typeof IntakeOriginSchema>;

/**
 * `owner_goal`: an open-ended instruction that goes through the gameplay planner.
 * `operator_task_diagnostic`: a terminal-only, operator-written generic TaskSpec
 * run through the same ownership/epoch/anchor/controller path with real Jev
 * choices (MB-V1-03 controller diagnostic). It is never natural-language goal
 * acceptance and never reachable from chat.
 */
export const GOAL_KINDS = ['owner_goal', 'operator_task_diagnostic'] as const;
export const GoalKindSchema = z.enum(GOAL_KINDS);
export type GoalKind = z.infer<typeof GoalKindSchema>;

export const GoalRecordSchema = z
  .object({
    id: GoalIdSchema,
    kind: GoalKindSchema.optional(),
    epoch: EpochSchema,
    instruction: z.string().min(1).max(BOUNDS.longText),
    origin: IntakeOriginSchema,
    state: GoalStateSchema,
    admittedAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    plannerTurns: z.number().int().nonnegative(),
    /** Code-owned per-goal counters (never reset across task windows). */
    counters: z
      .object({
        plannerTurns: z.number().int().nonnegative(),
        knowledgeRounds: z.number().int().nonnegative(),
        repairs: z.number().int().nonnegative(),
        retries: z.number().int().nonnegative(),
        clarifications: z.number().int().nonnegative(),
        replans: z.number().int().nonnegative(),
        windows: z.number().int().nonnegative(),
        tasksAdmitted: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    interpretation: z.string().max(BOUNDS.text).optional(),
    /** Bounded rendering of the accepted goal outcome contract (code evaluates it). */
    outcome: z.string().max(BOUNDS.text).optional(),
    pendingClarification: ClarificationRequestSchema.optional(),
    terminal: z
      .object({
        reason: TerminalReasonCodeSchema,
        detail: z.string().max(BOUNDS.text),
        atMs: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    progress: z.string().max(BOUNDS.text).default(''),
  })
  .strict();
export type GoalRecord = z.infer<typeof GoalRecordSchema>;
