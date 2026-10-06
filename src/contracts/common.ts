// Bounded primitives shared by every contract. Bounds keep model-visible and
// evidence payloads finite; they are not a vocabulary of allowed goals.
import { z } from 'zod';

export const BOUNDS = {
  shortText: 200,
  text: 1_000,
  longText: 4_000,
  listSmall: 8,
  listMedium: 32,
  listLarge: 128,
  /** Window of steps one planner proposal may admit (architecture limit). */
  planWindowSteps: 8,
} as const;

/** Trimmed, non-empty, bounded human-readable text. */
export const textSchema = (max: number = BOUNDS.text) => z.string().trim().min(1).max(max);

/**
 * A namespaced Minecraft registry key such as `minecraft:oak_log` or a tag such
 * as `#minecraft:logs`. Values come from the version registry, not a hardcoded list.
 */
export const RegistryKeySchema = z
  .string()
  .regex(/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/, 'must be a namespaced registry key')
  .max(BOUNDS.shortText);
export type RegistryKey = z.infer<typeof RegistryKeySchema>;

/** Stable code-defined capability identifier (e.g. a skill ID registered by a later module). */
export const CapabilityIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'must be a snake_case capability identifier');
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

/** Dimension names are open strings from the server registry (overworld, the_nether, modded, ...). */
export const DimensionSchema = z.string().regex(/^[a-z0-9_.:/-]{1,100}$/);
export type Dimension = z.infer<typeof DimensionSchema>;

export const Vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export type Vec3 = z.infer<typeof Vec3Schema>;

/** Positions always carry their dimension and observation time. */
export const PositionSchema = z.object({
  dimension: DimensionSchema,
  at: Vec3Schema,
  observedAtMs: z.number().int().nonnegative(),
});
export type Position = z.infer<typeof PositionSchema>;

/** Parameters are bounded JSON values; executable code is never accepted. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string().max(BOUNDS.text),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema).max(BOUNDS.listMedium),
    z.record(z.string().max(64), JsonValueSchema),
  ]),
);

export const ParametersSchema = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), JsonValueSchema);
export type Parameters = z.infer<typeof ParametersSchema>;
