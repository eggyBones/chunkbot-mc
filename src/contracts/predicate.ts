// Code-owned, extensible outcome predicate vocabulary. Planners propose
// predicates; code validates their form and evaluates them against game
// evidence. New predicate kinds are added here in code, never by a model.
import { z } from 'zod';
import { BOUNDS, RegistryKeySchema } from './common.ts';
import { TargetSelectorSchema } from './selector.ts';
import { MemoryStatePredicateSchema } from './memory.ts';

const count = z.number().int().min(1).max(10_000);
const distance = z.number().positive().max(1_024);

/** How an inventory quantity baseline is bound and interpreted. */
export const QuantityModeSchema = z.enum([
  'collect_additional', // delta from the baseline bound at admission
  'possess', // currently holds at least N
]);

export const AtomicPredicateSchema = z.discriminatedUnion('predicate', [
  z
    .object({
      predicate: z.literal('inventory_amount'),
      selector: RegistryKeySchema,
      atLeast: count,
      mode: QuantityModeSchema,
    })
    .strict(),
  z
    .object({
      predicate: z.literal('inventory_delta'),
      selector: RegistryKeySchema,
      atLeast: count,
      /** Ingredient-gathering milestones may be consumed by later crafting. */
      mayBeConsumedLater: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      predicate: z.literal('equipped'),
      selector: RegistryKeySchema,
      slot: z.enum(['hand', 'off_hand', 'head', 'torso', 'legs', 'feet']),
    })
    .strict(),
  z.object({ predicate: z.literal('near_target'), target: TargetSelectorSchema, within: distance }).strict(),
  z.object({ predicate: z.literal('visited_location'), target: TargetSelectorSchema, within: distance }).strict(),
  z
    .object({
      predicate: z.literal('block_state'),
      target: TargetSelectorSchema,
      expect: RegistryKeySchema,
    })
    .strict(),
  z
    .object({
      predicate: z.literal('container_state'),
      target: TargetSelectorSchema,
      selector: RegistryKeySchema,
      atLeast: count,
    })
    .strict(),
  z.object({ predicate: z.literal('crafting_result'), output: RegistryKeySchema, atLeast: count }).strict(),
  z.object({ predicate: z.literal('smelting_result'), output: RegistryKeySchema, atLeast: count }).strict(),
  z
    .object({
      predicate: z.literal('entity_outcome'),
      target: TargetSelectorSchema,
      outcome: z.enum(['observed_defeated', 'observed_present']),
    })
    .strict(),
  /** MB-MEM-001: a durable LOCAL memory write (not a world effect), evaluated by the memory store. */
  MemoryStatePredicateSchema,
]);
export type AtomicPredicate = z.infer<typeof AtomicPredicateSchema>;
export type PredicateKind = AtomicPredicate['predicate'];

export type OutcomePredicate =
  | AtomicPredicate
  | { predicate: 'all'; of: OutcomePredicate[] }
  | { predicate: 'any'; of: OutcomePredicate[] }
  | { predicate: 'not'; of: OutcomePredicate };

const MAX_PREDICATE_DEPTH = 4;

export const OutcomePredicateSchema: z.ZodType<OutcomePredicate> = z.lazy(() =>
  z.union([
    AtomicPredicateSchema,
    z.object({ predicate: z.literal('all'), of: z.array(OutcomePredicateSchema).min(1).max(BOUNDS.listSmall) }).strict(),
    z.object({ predicate: z.literal('any'), of: z.array(OutcomePredicateSchema).min(1).max(BOUNDS.listSmall) }).strict(),
    z.object({ predicate: z.literal('not'), of: OutcomePredicateSchema }).strict(),
  ]),
) as z.ZodType<OutcomePredicate>;

export function predicateDepth(p: OutcomePredicate): number {
  switch (p.predicate) {
    case 'all':
    case 'any':
      return 1 + Math.max(...p.of.map(predicateDepth));
    case 'not':
      return 1 + predicateDepth(p.of);
    default:
      return 1;
  }
}

export function isPredicateWithinDepth(p: OutcomePredicate): boolean {
  return predicateDepth(p) <= MAX_PREDICATE_DEPTH;
}

/** A goal's declared outcome: finite outcomes complete; persistent ones run until stopped/blocked. */
export const GoalOutcomeContractSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('finite'), outcome: OutcomePredicateSchema }).strict(),
  z
    .object({
      kind: z.literal('persistent'),
      /** Condition to maintain (e.g. near the owner) until stopped or blocked. */
      maintain: OutcomePredicateSchema,
    })
    .strict(),
]);
export type GoalOutcomeContract = z.infer<typeof GoalOutcomeContractSchema>;

/**
 * Code evaluation of a predicate against game evidence. `unknown` means the
 * available evidence cannot decide it (the specific limitation is in `detail`);
 * it is never treated as satisfied.
 */
export interface PredicateEvaluation {
  status: 'satisfied' | 'unsatisfied' | 'unknown';
  predicate: PredicateKind | 'all' | 'any' | 'not';
  detail: string;
  /** Plain-data facts used for the decision (counts, baselines, packet times). */
  evidence: Record<string, string | number | boolean | null>;
  children?: PredicateEvaluation[];
}
