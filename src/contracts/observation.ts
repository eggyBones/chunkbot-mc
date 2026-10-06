// Bounded, filtered, model-visible observation snapshot. Built only by approved
// perception code; contains plain data, never Minecraft library objects, and
// never hidden ore, global player positions, seeds, chunk dumps, or secrets.
import { z } from 'zod';
import { BOUNDS, DimensionSchema, RegistryKeySchema, Vec3Schema } from './common.ts';
import { EpochSchema, SnapshotIdSchema } from './ids.ts';

/** Code handle valid only within one snapshot of one connection epoch (e.g. `blk-12`). */
export const ObservationHandleSchema = z.string().regex(/^[a-z]{1,8}-[0-9]{1,6}$/);

const ObservedThingSchema = z
  .object({
    /** Code handle valid only within this snapshot/connection epoch. */
    handle: ObservationHandleSchema,
    key: RegistryKeySchema,
    at: Vec3Schema,
    distance: z.number().nonnegative(),
    /** Short code-derived label, e.g. `owner`, `player`, `workstation`, `container`, `x3` for a drop stack. */
    label: z.string().max(64).optional(),
    /** Whether the target is within the bot's interaction reach at snapshot time. */
    inReach: z.boolean().optional(),
  })
  .strict();
export type ObservedThing = z.infer<typeof ObservedThingSchema>;

const RememberedSchema = z
  .object({
    anchorId: z.string().regex(/^anchor-[a-z0-9]{1,32}$/),
    label: z.string().max(BOUNDS.shortText),
    dimension: DimensionSchema,
    at: Vec3Schema,
    observedAtMs: z.number().int().nonnegative(),
    source: z.enum(['observed', 'owner_supplied', 'skill_result']),
  })
  .strict();

/** A reachable, safe local waypoint at the edge of what is currently visible (bounded exploration). */
export const FrontierSchema = z
  .object({
    handle: ObservationHandleSchema,
    at: Vec3Schema,
    distance: z.number().nonnegative(),
    /** Compass sector from the bot, e.g. `north`, `south_east`. */
    direction: z.string().regex(/^[a-z_]{1,16}$/),
    /** True when a recorded visited location is already near this waypoint. */
    visited: z.boolean(),
  })
  .strict();
export type Frontier = z.infer<typeof FrontierSchema>;

export const ObservationSnapshotSchema = z
  .object({
    id: SnapshotIdSchema,
    connectionEpoch: EpochSchema,
    goalEpoch: EpochSchema,
    takenAtMs: z.number().int().nonnegative(),
    dimension: DimensionSchema,
    self: z
      .object({
        at: Vec3Schema,
        health: z.number().min(0).max(1_024),
        food: z.number().min(0).max(20),
      })
      .strict(),
    inventory: z
      .array(z.object({ key: RegistryKeySchema, count: z.number().int().nonnegative() }).strict())
      .max(BOUNDS.listMedium + 9),
    /** `client_model` can include optimistic local updates; `server_confirmed` comes from a server window sync. */
    inventorySource: z.enum(['client_model', 'server_confirmed']).optional(),
    equipment: z.record(z.string().max(16), RegistryKeySchema.nullable()),
    owner: z
      .object({ visible: z.boolean(), at: Vec3Schema.optional(), distance: z.number().nonnegative().optional() })
      .strict(),
    entities: z.array(ObservedThingSchema).max(BOUNDS.listMedium),
    blocks: z.array(ObservedThingSchema).max(BOUNDS.listLarge),
    drops: z.array(ObservedThingSchema).max(BOUNDS.listMedium),
    remembered: z.array(RememberedSchema).max(BOUNDS.listMedium),
    /** Visible block types with counts (bounded aggregate; individual handles are in `blocks`). */
    blockSummary: z
      .array(z.object({ key: RegistryKeySchema, count: z.number().int().positive(), nearest: z.number().nonnegative() }).strict())
      .max(BOUNDS.listMedium)
      .default([]),
    frontiers: z.array(FrontierSchema).max(BOUNDS.listSmall).default([]),
    /** The perception policy and honest limits that produced this snapshot. */
    perception: z
      .object({
        radius: z.number().positive(),
        policy: z.string().max(BOUNDS.shortText),
        truncated: z.boolean(),
        travel: z
          .object({ anchor: Vec3Schema, radius: z.number().positive(), distanceFromAnchor: z.number().nonnegative() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ObservationSnapshot = z.infer<typeof ObservationSnapshotSchema>;
export type ObservationSnapshotInput = z.input<typeof ObservationSnapshotSchema>;
