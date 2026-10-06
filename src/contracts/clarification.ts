// Clarification requests and correlated owner answers.
import { z } from 'zod';
import { BOUNDS, textSchema } from './common.ts';
import { ClarificationIdSchema, EpochSchema, GoalIdSchema } from './ids.ts';

export const ClarificationRequestSchema = z
  .object({
    id: ClarificationIdSchema,
    goalId: GoalIdSchema,
    goalEpoch: EpochSchema,
    /** Short owner-facing reference, e.g. `q1`, used to correlate replies. */
    ref: z.string().regex(/^q[0-9]{1,6}$/),
    question: textSchema(BOUNDS.text),
    askedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;

export const ClarificationExchangeSchema = z
  .object({
    ref: z.string().regex(/^q[0-9]{1,6}$/),
    question: textSchema(BOUNDS.text),
    answer: textSchema(BOUNDS.text),
  })
  .strict();
export type ClarificationExchange = z.infer<typeof ClarificationExchangeSchema>;

export const ANSWER_REJECTIONS = [
  'no_pending_clarification',
  'stale_reference', // reply names a question that is no longer pending
  'goal_changed', // goal was replaced/cancelled after the reply was received
  'empty',
  'too_long',
] as const;
export type AnswerRejection = (typeof ANSWER_REJECTIONS)[number];
