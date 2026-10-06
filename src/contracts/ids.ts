// Code-owned identifiers and epochs. Models never create authoritative IDs,
// ownership, or epochs; they may only echo IDs that code supplied to them.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const ID_KINDS = [
  'run',
  'conn',
  'goal',
  'task',
  'snap',
  'req',
  'act',
  'clar',
  /** A pending owner instruction being prepared before admission (MB-FLOW-002). Never a goal id. */
  'intent',
] as const;
export type IdKind = (typeof ID_KINDS)[number];

const ID_PATTERN = /^(run|conn|goal|task|snap|req|act|clar|intent)-[a-z0-9]{4,32}$/;

export const IdSchema = z.string().regex(ID_PATTERN, 'must be a code-generated identifier');
export const RunIdSchema = z.string().regex(/^run-[a-z0-9]{4,32}$/);
export const ConnectionIdSchema = z.string().regex(/^conn-[a-z0-9]{4,32}$/);
export const GoalIdSchema = z.string().regex(/^goal-[a-z0-9]{4,32}$/);
export const TaskIdSchema = z.string().regex(/^task-[a-z0-9]{4,32}$/);
export const SnapshotIdSchema = z.string().regex(/^snap-[a-z0-9]{4,32}$/);
export const RequestIdSchema = z.string().regex(/^req-[a-z0-9]{4,32}$/);
export const ActionIdSchema = z.string().regex(/^act-[a-z0-9]{4,32}$/);
export const ClarificationIdSchema = z.string().regex(/^clar-[a-z0-9]{4,32}$/);
export const IntentIdSchema = z.string().regex(/^intent-[a-z0-9]{4,32}$/);

export type RunId = z.infer<typeof RunIdSchema>;
export type ConnectionId = z.infer<typeof ConnectionIdSchema>;
export type GoalId = z.infer<typeof GoalIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type SnapshotId = z.infer<typeof SnapshotIdSchema>;
export type RequestId = z.infer<typeof RequestIdSchema>;
export type ActionId = z.infer<typeof ActionIdSchema>;
export type ClarificationId = z.infer<typeof ClarificationIdSchema>;
export type IntentId = z.infer<typeof IntentIdSchema>;

/** Monotonic counters that invalidate stale async work after an ownership change. */
export const EpochSchema = z.number().int().nonnegative();
export type Epoch = z.infer<typeof EpochSchema>;

export interface IdSource {
  next(kind: IdKind): string;
}

/** Random, collision-resistant identifiers for production use. */
export const randomIds: IdSource = {
  next(kind) {
    return `${kind}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  },
};

/** Deterministic identifiers for tests and fixtures. */
export function sequentialIds(): IdSource {
  const counters = new Map<IdKind, number>();
  return {
    next(kind) {
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      return `${kind}-${n.toString().padStart(4, '0')}`;
    },
  };
}
