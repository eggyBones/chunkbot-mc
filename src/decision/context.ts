// Builds the bounded, model-visible Jev decision context for one frozen round:
// the generic task objective/instruction, a filtered summary of the CURRENT
// observation snapshot (already line-of-sight filtered by perception), the
// catalog/mechanics versions, verified progress and recent results, and the
// offered candidates as criteria keyed by their code-generated IDs.
//
// Nothing here reads the game: inputs are contract data only, so raw loaded
// world data cannot reach the model through this path.
import type { ActionCandidate, DecisionRequest, JsonValue, ObservationSnapshot, PredicateEvaluation, TaskOutcomeSummary, TaskSpec } from '../contracts/index.ts';
import { buildRequestBody, type WireRequestBody } from './wire.ts';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export interface DecisionContextInput {
  spec: TaskSpec;
  mode: 'complete' | 'maintain';
  snapshot: ObservationSnapshot;
  catalogVersion: string;
  mechanicsVersion: string;
  completion: PredicateEvaluation | null;
  recentOutcomes: readonly TaskOutcomeSummary[];
  unavailable: ReadonlyArray<{ capability: string; reason: string; detail: string }>;
  remaining: { decisions: number; spendUsd: number | null };
  round: number;
}

/** Short human-readable rendering of a completion predicate (bounded). */
export function describePredicate(p: TaskSpec['completion']): string {
  return clip(JSON.stringify(p), 400);
}

/** Bounded criteria text for one candidate: what it does, why it is valid, what it needs. */
export function criterionText(c: ActionCandidate): string {
  const parts = [`${c.capability}: ${c.description}`];
  if (c.criteria.length) parts.push(`effect: ${c.criteria.slice(0, 3).join('; ')}`);
  if (c.preconditions.length) parts.push(`checked: ${c.preconditions.slice(0, 2).join('; ')}`);
  return clip(parts.join(' | '), 320);
}

export function criteriaFor(candidates: readonly ActionCandidate[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of candidates) out[c.id] = criterionText(c);
  return out;
}

/** The complete question (the question key itself is bookkeeping only). */
export function composeInstructions(objective: string, instruction: string, completion?: string, mode: 'complete' | 'maintain' = 'complete'): string {
  return clip(
    [
      'You choose the next action for Chunkbot, a Minecraft Java Edition companion player, within one task step chosen by its planner.',
      `Task objective: ${clip(objective, 1_000)}`,
      `Planner instruction for this step: ${clip(instruction, 1_000)}`,
      completion ? `${mode === 'maintain' ? 'Condition to keep (checked by code)' : 'Completion condition (checked by code)'}: ${completion}` : '',
      'The state field holds the current filtered observation, inventory, verified progress and recent action results.',
      'Which one of the offered options (by its ID) best advances the task objective right now? Every option is a grounded action that code will revalidate and verify; choose exactly one.',
    ]
      .filter(Boolean)
      .join('\n'),
    3_000,
  );
}

/** Filtered snapshot summary (lists bounded; all data originates from the perception snapshot). */
export function snapshotSummary(s: ObservationSnapshot, level: 0 | 1 | 2 = 0): JsonValue {
  const n = level === 0 ? { inv: 24, ent: 8, drop: 8, kinds: 14, rem: 4 } : level === 1 ? { inv: 12, ent: 4, drop: 4, kinds: 8, rem: 2 } : { inv: 6, ent: 2, drop: 2, kinds: 4, rem: 0 };
  return JSON.parse(JSON.stringify({
    snapshotId: s.id,
    takenAtMs: s.takenAtMs,
    connectionEpoch: s.connectionEpoch,
    goalEpoch: s.goalEpoch,
    dimension: s.dimension,
    self: s.self,
    inventory: s.inventory.slice(0, n.inv).map((i) => `${i.key.replace('minecraft:', '')} x${i.count}`),
    inventorySource: s.inventorySource ?? 'client_model',
    equipment: Object.fromEntries(Object.entries(s.equipment).filter(([, v]) => v !== null)) as Record<string, JsonValue>,
    owner: s.owner,
    entities: s.entities.slice(0, n.ent).map((e) => `${e.key.replace('minecraft:', '')}${e.label ? ` (${e.label})` : ''} ${e.distance}m`),
    drops: s.drops.slice(0, n.drop).map((d) => `${d.key.replace('minecraft:', '')} ${d.label ?? ''} ${d.distance}m`.trim()),
    visibleBlockKinds: s.blockSummary.slice(0, n.kinds).map((b) => `${b.key.replace('minecraft:', '')} x${b.count} nearest ${b.nearest}m`),
    remembered: s.remembered.slice(-n.rem).map((r) => `${r.label} (${r.source}, remembered)`),
    frontiers: s.frontiers.length,
    travel: s.perception?.travel ? { radius: s.perception.travel.radius, distanceFromAnchor: s.perception.travel.distanceFromAnchor } : null,
  })) as JsonValue;
}

export function buildState(input: DecisionContextInput, level: 0 | 1 | 2 = 0): JsonValue {
  return {
    phase: 'MB-V1-03 generic task controller',
    catalogVersion: input.catalogVersion,
    mechanicsVersion: input.mechanicsVersion,
    task: { mode: input.mode, round: input.round, completion: describePredicate(input.spec.completion) },
    progress: input.completion ? { status: input.completion.status, detail: clip(input.completion.detail, 240) } : null,
    recentResults: input.recentOutcomes.slice(level === 2 ? -1 : -4).map((o) => clip(`${o.capability} -> ${o.status}${o.reason ? ` (${o.reason})` : ''}: ${o.effect}`, 220)),
    notOffered: input.unavailable.slice(0, level === 0 ? 6 : 2).map((u) => clip(`${u.capability}: ${u.reason} - ${u.detail}`, 160)),
    remaining: input.remaining,
    observation: snapshotSummary(input.snapshot, level),
  } as JsonValue;
}

/** The exact raw HTTP body for a decision request (shared by sizing and dispatch). */
export function bodyFor(model: string, request: DecisionRequest, maxPrice?: WireRequestBody['provider']['max_price']): WireRequestBody {
  return buildRequestBody(model, request.state, composeInstructions(request.objective, request.instruction, request.condition, request.mode), criteriaFor(request.candidates), maxPrice);
}

export function requestBytes(model: string, request: DecisionRequest): number {
  return Buffer.byteLength(JSON.stringify(bodyFor(model, request)), 'utf8');
}
