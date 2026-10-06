// Capability catalog contracts. A capability is a reusable player mechanism
// (movement, mining, crafting, ...), never a whole user goal. The catalog
// supplied to the planner is generated from implemented definitions; there is
// no second, hardcoded planner-only catalog.
import { z } from 'zod';
import { BOUNDS, CapabilityIdSchema, textSchema } from './common.ts';

/** JSON-schema-like, model-visible parameter description (bounded). */
export const ParameterSpecSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    type: z.enum(['string', 'integer', 'number', 'boolean', 'registry_key', 'target_selector', 'handle']),
    description: textSchema(BOUNDS.shortText),
    required: z.boolean(),
    /** Allowed values for enumerated string parameters (e.g. equipment slots). */
    enum: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)).max(BOUNDS.listMedium).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
  })
  .strict();
export type ParameterSpec = z.infer<typeof ParameterSpecSchema>;

/** The model-visible description of one implemented capability. */
export const CapabilityDescriptorSchema = z
  .object({
    id: CapabilityIdSchema,
    family: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
    purpose: textSchema(),
    parameters: z.array(ParameterSpecSchema).max(BOUNDS.listSmall),
    /**
     * Kinds of grounded target this capability resolves (observation handle
     * kinds such as `block`, `entity`, `drop`, `frontier`, or `owner`,
     * `remembered_anchor`, `owner_destination`, `inventory_item`, `none`).
     */
    targets: z.array(z.string().regex(/^[a-z][a-z_]{1,31}$/)).max(BOUNDS.listSmall).optional(),
    preconditions: z.array(textSchema(BOUNDS.shortText)).max(BOUNDS.listSmall),
    effects: z.array(textSchema(BOUNDS.shortText)).max(BOUNDS.listSmall),
    /** Predicate kinds whose evidence this capability can produce. */
    supportedPredicates: z.array(z.string().regex(/^[a-z_]{1,40}$/)).max(BOUNDS.listMedium),
    timeoutMs: z.number().int().positive().max(600_000),
    cancellation: textSchema(BOUNDS.shortText),
    limitations: z.array(textSchema(BOUNDS.shortText)).max(BOUNDS.listSmall),
    /** What actually confirms the effect (server packet, server window sync, ...). */
    evidence: z.array(textSchema(BOUNDS.shortText)).max(BOUNDS.listSmall).optional(),
  })
  .strict();
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

export const CapabilityCatalogSchema = z
  .object({
    /** Changes whenever the implemented capability set changes. */
    catalogVersion: z.string().min(1).max(64),
    capabilities: z.array(CapabilityDescriptorSchema).max(BOUNDS.listLarge),
  })
  .strict();
export type CapabilityCatalog = z.infer<typeof CapabilityCatalogSchema>;
