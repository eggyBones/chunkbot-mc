// Shared parameter schemas for skill definitions.
import { z } from 'zod';
import { DimensionSchema, ObservationHandleSchema, RegistryKeySchema, SnapshotIdSchema } from '../contracts/index.ts';

/** A code handle from a specific observation snapshot. */
export const HandleRefSchema = z.object({ snapshotId: SnapshotIdSchema, handle: ObservationHandleSchema }).strict();
export type HandleRef = z.infer<typeof HandleRefSchema>;

export const FaceSchema = z.enum(['up', 'down', 'north', 'south', 'west', 'east']);

export const ItemKeySchema = RegistryKeySchema.refine((k) => !k.startsWith('#'), 'a concrete item key, not a tag');

/** Movement destinations: a snapshot handle, the visible owner, a remembered anchor, or owner-supplied coordinates. */
export const MoveTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('handle'), snapshotId: SnapshotIdSchema, handle: ObservationHandleSchema }).strict(),
  z.object({ kind: z.literal('owner') }).strict(),
  z.object({ kind: z.literal('anchor'), anchorId: z.string().regex(/^anchor-[a-z0-9]{1,32}$/) }).strict(),
  z
    .object({ kind: z.literal('destination'), dimension: DimensionSchema, x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
    .strict(),
]);
export type MoveTarget = z.infer<typeof MoveTargetSchema>;
