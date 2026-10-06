// Target selectors let a plan *describe* what to act on. Code resolves them to
// actual observed targets at execution time. A selector can never invent an
// entity ID or a hidden coordinate.
import { z } from 'zod';
import { BOUNDS, DimensionSchema, RegistryKeySchema, Vec3Schema, textSchema } from './common.ts';
import { ActionIdSchema, SnapshotIdSchema } from './ids.ts';

export const TargetSelectorSchema = z.discriminatedUnion('kind', [
  /** Items or blocks by version-registry key or tag (e.g. `#minecraft:logs`). */
  z.object({ kind: z.literal('registry'), key: RegistryKeySchema }).strict(),
  /** A target listed in a code-issued observation snapshot, referenced by its code handle. */
  z
    .object({
      kind: z.literal('observed'),
      snapshotId: SnapshotIdSchema,
      handle: z.string().regex(/^[a-z]{1,8}-[0-9]{1,6}$/),
    })
    .strict(),
  /** A remembered anchor; remains labeled as remembered evidence, not current visibility. */
  z.object({ kind: z.literal('remembered_anchor'), anchorId: z.string().regex(/^anchor-[a-z0-9]{1,32}$/) }).strict(),
  /** Coordinates explicitly supplied by the owner; destination evidence, not live visibility. */
  z
    .object({
      kind: z.literal('owner_destination'),
      dimension: DimensionSchema,
      at: Vec3Schema,
      ownerText: textSchema(BOUNDS.shortText),
    })
    .strict(),
  /** The owner when currently observable. */
  z.object({ kind: z.literal('owner') }).strict(),
  /** The verified result of a prior skill action (e.g. a placed workstation). */
  z.object({ kind: z.literal('prior_result'), actionId: ActionIdSchema }).strict(),
]);
export type TargetSelector = z.infer<typeof TargetSelectorSchema>;
