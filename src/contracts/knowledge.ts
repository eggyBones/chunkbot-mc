// Read-only, version-specific game knowledge queries. A knowledge query never
// implies a game action and never exposes hidden world state.
import { z } from 'zod';
import { BOUNDS, CapabilityIdSchema, JsonValueSchema, RegistryKeySchema } from './common.ts';

export const KnowledgeQuerySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('item'), key: RegistryKeySchema }).strict(),
  z.object({ kind: z.literal('recipe'), output: RegistryKeySchema }).strict(),
  z.object({ kind: z.literal('harvest'), block: RegistryKeySchema }).strict(),
  z.object({ kind: z.literal('tool'), forBlock: RegistryKeySchema }).strict(),
  z.object({ kind: z.literal('smelting'), input: RegistryKeySchema }).strict(),
  z.object({ kind: z.literal('capability'), id: CapabilityIdSchema }).strict(),
  /** Furnace fuel value of one item, or (without `item`) the known fuel table. */
  z.object({ kind: z.literal('fuel'), item: RegistryKeySchema.optional() }).strict(),
  /** Members of an item tag such as `#minecraft:planks`. */
  z.object({ kind: z.literal('tag'), key: RegistryKeySchema.refine((k) => k.startsWith('#'), 'tag keys start with #') }).strict(),
  /** Recipes that consume an ingredient (bounded). */
  z.object({ kind: z.literal('uses'), ingredient: RegistryKeySchema }).strict(),
]);
export type KnowledgeQuery = z.infer<typeof KnowledgeQuerySchema>;

export const KnowledgeResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('known'), query: KnowledgeQuerySchema, data: JsonValueSchema }).strict(),
  /** The key exists, but the answer is not known (e.g. no recipe). */
  z.object({ status: z.literal('unknown'), query: KnowledgeQuerySchema, detail: z.string().max(BOUNDS.shortText) }).strict(),
  /** The knowledge source is not installed or cannot answer this query kind. */
  z
    .object({ status: z.literal('unavailable'), query: KnowledgeQuerySchema, detail: z.string().max(BOUNDS.shortText) })
    .strict(),
]);
export type KnowledgeResult = z.infer<typeof KnowledgeResultSchema>;

export const KnowledgeQueryBatchSchema = z.array(KnowledgeQuerySchema).min(1).max(BOUNDS.listSmall);
