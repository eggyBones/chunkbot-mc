// Generic task step. There is deliberately no task-type enum (no
// `collect_logs | return | follow`); every step is an objective plus a bounded
// decision instruction, allowed capabilities, selectors, and completion predicate.
import { z } from 'zod';
import { BOUNDS, CapabilityIdSchema, ParametersSchema, textSchema } from './common.ts';
import { OutcomePredicateSchema } from './predicate.ts';
import { TargetSelectorSchema } from './selector.ts';

/** A step as proposed by the planner (no code IDs yet). */
export const TaskSpecSchema = z
  .object({
    objective: textSchema(BOUNDS.text),
    /** Bounded instruction for the fast decision model (Jev) within this step. */
    decisionInstruction: textSchema(BOUNDS.text),
    allowedCapabilities: z.array(CapabilityIdSchema).min(1).max(BOUNDS.listSmall),
    targetSelectors: z.array(TargetSelectorSchema).max(BOUNDS.listSmall).default([]),
    parameters: ParametersSchema.default({}),
    completion: OutcomePredicateSchema,
  })
  .strict();
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/**
 * How a task's completion predicate is used. `complete`: the task ends when the
 * predicate is verified. `maintain`: the predicate is a condition to keep
 * (persistent behavior such as staying near the owner); the task runs until
 * stopped, replaced or blocked, and a satisfied condition is healthy waiting.
 */
export const TASK_MODES = ['complete', 'maintain'] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export const TASK_RESULT_STATUSES = ['completed', 'blocked', 'failed', 'cancelled'] as const;
export type TaskResultStatus = (typeof TASK_RESULT_STATUSES)[number];

/** One bounded, code-observed action result included in planner feedback. */
export interface TaskOutcomeSummary {
  actionId: string;
  capability: string;
  status: string;
  reason?: string;
  confirmation: string;
  effect: string;
  /** `jev`: chosen by a validated Jev decision; `local_continuation`: a healthy sustained action continued without inference. */
  via: 'jev' | 'local_continuation';
}

/**
 * Structured recovery evidence for the planner. Built only from filtered
 * snapshots, registered resolver reasons and verified outcomes; it never
 * contains raw loaded-world data, and it is not a hidden prerequisite plan.
 */
export interface TaskFeedback {
  taskId: string;
  objective: string;
  status: TaskResultStatus;
  /** snake_case code-defined reason (e.g. no_candidates, per_target_retries_exhausted, no_progress, decision_not_ready). */
  reason: string;
  detail: string;
  /** Why allowed capabilities offered nothing (missing_ingredients, workstation_required, harvest_tool_missing, no_visible_target, no_safe_path, ...). */
  unavailable: Array<{ capability: string; reason: string; detail: string; evidence: Record<string, unknown> }>;
  recentOutcomes: TaskOutcomeSummary[];
  /** Capability|target keys excluded after exhausting per-target retries. */
  exhaustedTargets: string[];
  completion: { status: 'satisfied' | 'unsatisfied' | 'unknown'; detail: string } | null;
}

export interface TaskResult {
  taskId: string;
  status: TaskResultStatus;
  reason: string;
  detail: string;
  rounds: number;
  decisions: number;
  actions: number;
  localContinuations: number;
  feedback: TaskFeedback;
}
