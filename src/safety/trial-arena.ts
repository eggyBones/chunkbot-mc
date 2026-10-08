// Inference/credential-free staging geometry for the leased mechanics harness.
// These are test fixtures, never a gameplay goal classifier or permission port.
import type { SafetyEntityFact, SafetyPlan } from '../contracts/safety.ts';
import { parseEntityTest } from './trial-journal.ts';

export type TrialBox = [number, number, number, number, number, number];
export const SAFETY_TRIAL_BOX: TrialBox = [240, -61, 190, 270, -48, 220];
export const MOB_TRIAL_ORIGIN = { x: 255.5, y: -56, z: 205.5 };
export interface ArenaFill { box: TrialBox; block: string }
export interface ArenaCheck { source: TrialBox; target: [number, number, number]; block?: string }

export function insideTrialBox(box: TrialBox): boolean {
  return box.every(Number.isInteger) && [0, 1, 2].every((i) => box[i]! >= SAFETY_TRIAL_BOX[i]! && box[i + 3]! <= SAFETY_TRIAL_BOX[i + 3]! && box[i]! <= box[i + 3]!);
}

/** Opaque walls exclude external mobs from player-visible policy input. The
 * luminous roof seals ingress/visibility; luminous floor prevents spawning.
 * Interior 29x29, eight blocks tall: the original 12-block finite grant fits.
 * All blocks are inside the ORIGINAL clone, with no clock/gamerule changes. */
export function arenaShellPlan(): ArenaFill[] {
  return [
    { box: [240, -56, 190, 240, -49, 220], block: 'stone' },
    { box: [270, -56, 190, 270, -49, 220], block: 'stone' },
    { box: [241, -56, 190, 269, -49, 190], block: 'stone' },
    { box: [241, -56, 220, 269, -49, 220], block: 'stone' },
    { box: [240, -48, 190, 270, -48, 220], block: 'sea_lantern' },
  ];
}

export function mobArenaPlan(): ArenaFill[] {
  return [
    { box: [240, -61, 190, 270, -58, 220], block: 'dirt' },
    { box: [240, -57, 190, 270, -57, 220], block: 'sea_lantern' },
    ...arenaShellPlan(),
    { box: [241, -56, 191, 269, -49, 219], block: 'air' },
  ];
}

/** A corner test plus overlapping comparisons along EVERY non-unit axis
 * proves a whole rectangular region is uniform, without writing a prototype
 * into the original backup. One missing/blasted voxel fails a comparison. */
export function arenaChecks(fill: ArenaFill): ArenaCheck[] {
  if (!insideTrialBox(fill.box)) throw new Error('arena region outside original clone');
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

export interface TrialSummon { tag: string; uuid: string; entityId: number; key: string; visible: boolean; unprovoked?: boolean }
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
  if (visible.some((e) => nowMs - e.observedAtMs > 500 || e.observedAtMs > nowMs)) why.push('stale_visible_evidence');
  const target = visible.find((e) => e.entityId === summons.find((s) => s.key !== 'minecraft:cow')?.entityId);
  if (!target || target.key !== summons.find((s) => s.key !== 'minecraft:cow')?.key) why.push('target_not_currently_visible');
  if (gate === 'M3b') {
    if (summons.find((s) => s.key === 'minecraft:wolf')?.unprovoked !== true) why.push('server_neutral_anger_unverified');
    if (!target || target.disposition !== 'neutral' || target.damagedSelfAtMs !== null || target.aggressive === true) why.push('neutral_provocation_or_unknown_identity');
    if (plan.kind !== 'none') why.push('neutral_control_has_hazard');
  } else {
    const response = gate === 'M2' || gate === 'M2b' ? 'defend' : 'retreat';
    if (plan.kind !== 'respond' || plan.response !== response) why.push(`policy_prerequisite_${response}`);
    if (plan.kind !== 'none' && plan.hazards.some((h) => h.entityIds.some((id) => !ids.has(id)))) why.push('unexpected_active_threat');
    if ((gate === 'M2' || gate === 'M2b') && (!target || target.distance > 3.5 || !(target.aggressive === true || (target.damagedSelfAtMs !== null && nowMs - target.damagedSelfAtMs <= 6_000)))) why.push('target_not_engaging_in_melee');
  }
  return why;
}
