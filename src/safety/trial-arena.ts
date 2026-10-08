// Inference/credential-free staging geometry for the leased mechanics harness.
// These are test fixtures, never a gameplay goal classifier or permission port.
import type { SafetyEntityFact, SafetyPlan } from '../contracts/safety.ts';
import { parseEntityTest } from './trial-journal.ts';

export type TrialBox = [number, number, number, number, number, number];
/** Original clone/backup/restoration boundary; NEVER narrowed with staging. */
export const SAFETY_TRIAL_BOX: TrialBox = [240, -61, 190, 270, -48, 220];
/** Static staging boundary, buffered from the untouched north/east strips.
 * It is not an entity exception: ANY intersecting foreign body still refuses. */
export const SAFETY_MUTATION_BOX: TrialBox = [240, -61, 196, 268, -48, 220];
export const MOB_TRIAL_ORIGIN = { x: 255.5, y: -56, z: 205.5 };
export interface ArenaFill { box: TrialBox; block: string }
export interface ArenaCheck { source: TrialBox; target: [number, number, number]; block?: string }

export function insideTrialBox(box: TrialBox): boolean {
  return inside(box, SAFETY_TRIAL_BOX);
}

function inside(box: TrialBox, boundary: TrialBox): boolean {
  return box.every(Number.isInteger) && [0, 1, 2].every((i) => box[i]! >= boundary[i]! && box[i + 3]! <= boundary[i + 3]! && box[i]! <= box[i + 3]!);
}

export function insideMutationBox(box: TrialBox): boolean {
  return inside(box, SAFETY_MUTATION_BOX);
}

/** Both official releases' EntitySelectorParser.createAabb use delta+1 for
 * positive extents; EntitySelector tests Entity.getBoundingBox().intersects.
 * Thus max-min covers the last BLOCK's full volume AND overlapping bodies
 * whose centers lie outside. No position/distance/species whitelist is used. */
export function trialEntitySelector(box: TrialBox): string {
  if (!insideTrialBox(box)) throw new Error('entity region outside original clone');
  return `x=${box[0]},y=${box[1]},z=${box[2]},dx=${box[3] - box[0]},dy=${box[4] - box[1]},dz=${box[5] - box[2]}`;
}

/** The same leased-harness guard is exercised with a voxel/entity server in
 * tests. Queries are sequential; unknown/concatenated replies refuse before
 * the caller may fill, heal or remove anything. Partial evidence is retained. */
export async function guardMutationVolume(read: (command: string) => Promise<string>, runTag: string, bot: string, record: (kind: 'entities' | 'players', command: string, reply: string) => void): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(runTag) || !/^[A-Za-z0-9_]+$/.test(bot)) throw new Error('invalid staging identity');
  const area = trialEntitySelector(SAFETY_MUTATION_BOX);
  for (const [kind, command] of [
    ['entities', `execute if entity @e[tag=!${runTag},type=!player,type=!item,type=!experience_orb,${area}]`],
    ['players', `execute if entity @a[name=!${bot},${area}]`],
  ] as const) {
    const reply = await read(command);
    record(kind, command, reply);
    refuseForeignOccupants(reply);
  }
}

/** Opaque walls exclude external mobs from player-visible policy input. The
 * luminous roof seals ingress/visibility; luminous floor prevents spawning.
 * Interior 27x23, eight blocks tall. The existing six-block retreat leg fits
 * from MOB_TRIAL_ORIGIN in every bearing; the 12-block grant is unchanged,
 * and targets near walls must still pass the ordinary geometry checks.
 * All blocks are inside the ORIGINAL clone, with no clock/gamerule changes. */
export function arenaShellPlan(): ArenaFill[] {
  const [x1, , z1, x2, , z2] = SAFETY_MUTATION_BOX;
  return [
    { box: [x1, -56, z1, x1, -49, z2], block: 'stone' },
    { box: [x2, -56, z1, x2, -49, z2], block: 'stone' },
    { box: [x1 + 1, -56, z1, x2 - 1, -49, z1], block: 'stone' },
    { box: [x1 + 1, -56, z2, x2 - 1, -49, z2], block: 'stone' },
    { box: [x1, -48, z1, x2, -48, z2], block: 'sea_lantern' },
  ];
}

export function mobArenaPlan(): ArenaFill[] {
  const [x1, y1, z1, x2, , z2] = SAFETY_MUTATION_BOX;
  return [
    { box: [x1, y1, z1, x2, -58, z2], block: 'dirt' },
    { box: [x1, -57, z1, x2, -57, z2], block: 'sea_lantern' },
    ...arenaShellPlan(),
    { box: [x1 + 1, -56, z1 + 1, x2 - 1, -49, z2 - 1], block: 'air' },
  ];
}

/** Same four-deep pool and dirt bank as the proven trial, now all inside the
 * smaller staging boundary. Non-overlapping final regions allow the server
 * verifier to check the actual pool/floor/ceiling as well as the shell. */
export function waterArenaPlan(lid = false): ArenaFill[] {
  const [x1, y1, z1, x2, , z2] = SAFETY_MUTATION_BOX;
  return [
    { box: [x1, y1, z1, x2, y1, z2], block: 'dirt' },
    { box: [x1, -60, z1, 251, -57, z2], block: 'dirt' },
    { box: [259, -60, z1, x2, -57, z2], block: 'dirt' },
    { box: [252, -60, z1, 258, -57, 201], block: 'dirt' },
    { box: [252, -60, 209, 258, -57, z2], block: 'dirt' },
    { box: [252, -60, 202, 258, lid ? -58 : -57, 208], block: 'water' },
    ...(lid ? [{ box: [252, -57, 202, 258, -57, 208] as TrialBox, block: 'stone' }] : []),
    ...arenaShellPlan(),
    { box: [x1 + 1, -56, z1 + 1, x2 - 1, -49, z2 - 1], block: 'air' },
  ];
}

/** A corner test plus overlapping comparisons along EVERY non-unit axis
 * proves a whole rectangular region is uniform, without writing a prototype
 * into the original backup. One missing/blasted voxel fails a comparison. */
export function arenaChecks(fill: ArenaFill): ArenaCheck[] {
  if (!insideTrialBox(fill.box)) throw new Error('arena region outside original clone');
  if (!insideMutationBox(fill.box)) throw new Error('arena region outside staging mutation boundary');
  const [x, y, z] = fill.box;
  const out: ArenaCheck[] = [{ source: [x, y, z, x, y, z], target: [x, y, z], block: fill.block }];
  for (let i = 0; i < 3; i += 1) {
    if (fill.box[i] === fill.box[i + 3]) continue;
    const source: TrialBox = [...fill.box];
    source[i + 3] = source[i + 3]! - 1;
    const target: [number, number, number] = [x, y, z];
    target[i] = target[i]! + 1;
    out.push({ source, target });
  }
  return out;
}

/** Real harness read seam, also exercised against a credential-free voxel
 * server in tests. Unknown/error replies never certify intact staging. */
export async function verifyArena(read: (command: string) => Promise<string>, fills: readonly ArenaFill[] = mobArenaPlan()): Promise<number> {
  let comparisons = 0;
  for (const fill of fills) for (const c of arenaChecks(fill)) {
    const command = c.block ? `execute if block ${c.target.join(' ')} minecraft:${c.block}` : `execute if blocks ${c.source.join(' ')} ${c.target.join(' ')} all`;
    const reply = await read(command);
    if (parseEntityTest(reply) !== true) throw new Error(`staging_unready: arena ${fill.block} ${fill.box.join(' ')} failed exact server comparison: ${reply.slice(0, 120)}`);
    comparisons += 1;
  }
  return comparisons;
}

export function refuseForeignOccupants(reply: string): void {
  const occupied = parseEntityTest(reply);
  if (occupied !== false) throw new Error(`staging_unready: foreign arena occupants ${occupied === undefined ? 'unreadable' : 'present'}; no foreign entity is removed`);
}

/** Exact SNBT UUID IntArray identity; a substring/error cannot identify a mob. */
export function parseTrialUuid(reply: string): string | undefined {
  const m = /^[^\n]+ has the following entity data: \[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]$/.exec(reply.trim());
  if (!m) return undefined;
  const ints = m.slice(1).map(Number);
  if (ints.some((n) => !Number.isInteger(n) || n < -2147483648 || n > 2147483647)) return undefined;
  const h = ints.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function serverUnprovokedWolf(anger: string, target: string): boolean {
  return /^[^\n]+ has the following entity data: -1L$/.test(anger.trim()) && parseEntityTest(target) === false;
}

export interface TrialSummon { tag: string; uuid: string; entityId: number; key: string; visible: boolean; unprovoked?: boolean; effectFree?: boolean }
export type MobTrialGate = 'M1' | 'M2' | 'M2b' | 'M3' | 'M3b' | 'M4';

/** Current visible facts and the SAME real policy plan, evaluated with no
 * actuator authority. Prerequisite failure is retained as staging failure,
 * never attributed to product behavior or hidden by resetting the service. */
export function mobStageRefusals(gate: MobTrialGate, summons: readonly TrialSummon[], visible: readonly SafetyEntityFact[], plan: SafetyPlan, nowMs: number): string[] {
  const why: string[] = [];
  const ids = new Set(summons.map((s) => s.entityId));
  const keys = summons.map((s) => s.key).sort().join(',');
  const expected = gate === 'M3b' ? 'minecraft:cow,minecraft:wolf' : gate === 'M3' ? 'minecraft:creeper' : 'minecraft:zombie';
  if (keys !== expected || ids.size !== summons.length || summons.some((s) => !s.visible)) why.push('summon_identity_or_visibility');
  if (visible.some((e) => !ids.has(e.entityId))) why.push('unexpected_visible_entity');
  if (!Number.isFinite(nowMs) || visible.some((e) => !Number.isFinite(e.observedAtMs) || nowMs - e.observedAtMs > 500 || e.observedAtMs > nowMs)) why.push('stale_visible_evidence');
  const target = visible.find((e) => e.entityId === summons.find((s) => s.key !== 'minecraft:cow')?.entityId);
  if (!target || target.key !== summons.find((s) => s.key !== 'minecraft:cow')?.key) why.push('target_not_currently_visible');
  if (gate === 'M3b') {
    if (summons.find((s) => s.key === 'minecraft:wolf')?.unprovoked !== true) why.push('server_neutral_anger_unverified');
    if (!target || target.disposition !== 'neutral' || target.damagedSelfAtMs !== null || target.aggressive === true) why.push('neutral_provocation_or_unknown_identity');
    if (plan.kind !== 'none') why.push('neutral_control_has_hazard');
  } else {
    if (gate === 'M3' && summons.find((s) => s.key === 'minecraft:creeper')?.effectFree !== true) why.push('server_creeper_effects_unverified');
    const response = gate === 'M2' || gate === 'M2b' ? 'defend' : 'retreat';
    if (plan.kind !== 'respond' || plan.response !== response) why.push(`policy_prerequisite_${response}`);
    if (plan.kind !== 'none' && plan.hazards.some((h) => h.entityIds.some((id) => !ids.has(id)))) why.push('unexpected_active_threat');
    if ((gate === 'M2' || gate === 'M2b') && (!target || target.distance > 3.5 || !(target.aggressive === true || (target.damagedSelfAtMs !== null && nowMs - target.damagedSelfAtMs <= 6_000)))) why.push('target_not_engaging_in_melee');
  }
  return why;
}
