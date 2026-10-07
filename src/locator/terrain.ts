// MB-LOC-001 local route geometry (pure functions over the authoritative world view).
//
// A route step is ALWAYS a safe local frontier from the existing conservative
// frontier search (standable, reachable by walk / step-up 1 / drop <= 3, floor
// currently SEEN, inside the active travel bound). A locator bearing or a
// code-owned destination only RANKS those frontiers; it never becomes a
// navigation goal through unseen terrain. Nothing here digs, places, towers or
// opens doors.
//
// When no frontier leads toward the bearing, `classifyBlocker` names the
// specific local reason for the planner/owner from OBSERVED voxels only (the
// current line-of-sight observation); the world view is consulted only for
// chunk loadedness, never to name hidden terrain (MB-LOC-001-C5).
import { findFrontiers, type FrontierCell } from '../perception/frontiers.ts';
import type { Vec, WorldView } from '../perception/visibility.ts';
import { angleBetween } from './geometry.ts';

export interface Bounds {
  anchor: Vec;
  radius: number;
}

export interface FrontierChoice {
  at: Vec;
  /** Horizontal progress along the bearing (blocks). */
  forward: number;
  angle: number;
  distance: number;
  visited: boolean;
  score: number;
}

/** Widest admissible deviation between a frontier and the bearing (67.5 degrees). */
export const MAX_FRONTIER_ANGLE = (3 * Math.PI) / 8;
/** A frontier must make at least this much progress along the bearing. */
export const MIN_FORWARD = 3;

export interface FrontierQuery {
  world: WorldView;
  self: Vec;
  bearingRad: number;
  bounds: Bounds;
  /** Search radius around the bot (blocks). */
  radius: number;
  floorSeen: (x: number, y: number, z: number) => boolean;
  visited: readonly Vec[];
  /** Frontier keys (`x,y,z`) that already failed in this execution. */
  exclude?: ReadonlySet<string>;
  /** Prefer higher/lower frontiers when the cue states the owner is above/below. */
  elevation?: 'above' | 'below' | 'level' | 'unknown';
  maxNodes?: number;
}

export const frontierKey = (v: Vec) => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;

export function rankFrontiers(cells: readonly FrontierCell[], q: Pick<FrontierQuery, 'self' | 'bearingRad' | 'exclude' | 'elevation'>): FrontierChoice[] {
  const out: FrontierChoice[] = [];
  const cos = Math.cos(q.bearingRad);
  const sin = Math.sin(q.bearingRad);
  for (const c of cells) {
    if (q.exclude?.has(frontierKey(c.at))) continue;
    const dx = c.at.x - q.self.x;
    const dz = c.at.z - q.self.z;
    const angle = angleBetween(Math.atan2(dz, dx), q.bearingRad);
    const forward = dx * cos + dz * sin;
    if (angle > MAX_FRONTIER_ANGLE || forward < MIN_FORWARD) continue;
    const dy = c.at.y - Math.floor(q.self.y);
    const vertical = q.elevation === 'above' ? Math.max(0, dy) * 2 : q.elevation === 'below' ? Math.max(0, -dy) * 2 : 0;
    const score = forward * Math.cos(angle) + vertical - (c.visited ? 12 : 0);
    out.push({ at: c.at, forward, angle, distance: c.distance, visited: c.visited, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function frontiersToward(q: FrontierQuery): { choices: FrontierChoice[]; explored: number } {
  const { frontiers, explored } = findFrontiers(q.world, q.self, {
    radius: q.radius,
    travelAnchor: q.bounds.anchor,
    travelRadius: q.bounds.radius,
    floorSeen: q.floorSeen,
    visited: q.visited,
    ...(q.maxNodes !== undefined ? { maxNodes: q.maxNodes } : {}),
  });
  return { choices: rankFrontiers(frontiers, q), explored };
}

/**
 * Whether the active bound (not the terrain) is what limits progress: the same
 * search with the bound lifted finds a forward frontier that the bounded search
 * does not. Uses the same safe local geometry; nothing is exposed.
 */
export function boundLimited(q: FrontierQuery): boolean {
  if (frontiersToward(q).choices.length > 0) return false;
  const lifted = frontiersToward({ ...q, bounds: { anchor: q.self, radius: q.radius + 2 } });
  return lifted.choices.length > 0;
}

export const TERRAIN_BLOCKERS = ['hazard_lava', 'cliff_drop', 'wall', 'water_crossing', 'unloaded_terrain', 'unobserved_terrain', 'vertical_separation', 'no_safe_frontier'] as const;
export type TerrainBlocker = (typeof TERRAIN_BLOCKERS)[number];

export interface BlockerReport {
  reason: TerrainBlocker;
  detail: string;
  evidence: { rays: number; seenHazard: number; seenWater: number; wallRays: number; dropRays: number; unloadedRays: number; unobservedRays: number };
}

const HAZARD = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/;

/** A seen voxel as recorded by perception (line-of-sight hit). */
export type SeenVoxel = { block: { name: string; shapes?: readonly (readonly number[])[]; stateId?: number } };

const solid = (b: SeenVoxel['block'] | undefined): boolean => Boolean(b && (b.shapes?.length ?? 0) > 0 && !HAZARD.test(b.name));

/**
 * Names the local reason no safe frontier leads toward the bearing, sampling
 * five rays within +/-30 degrees up to `range` blocks.
 *
 * MB-LOC-001-C5 (observed geometry only): every label comes from voxels the bot
 * actually SAW in the current observation (`seen`, the perception line-of-sight
 * hits). The world view is consulted ONLY for chunk loadedness, never for block
 * contents, so no hidden terrain is ever named:
 *   wall        an observed solid voxel at feet AND head height ahead
 *   cliff_drop  past the last observed walkable floor, the next observed floor
 *               is more than 3 blocks below walk level
 *   hazard/water observed lava/fire / water voxels along the rays
 *   unobserved_terrain  the rays reach columns with no observed floor at all
 */
export function classifyBlocker(world: WorldView, self: Vec, bearingRad: number, seen: ReadonlyMap<string, SeenVoxel>, options: { range?: number; elevation?: 'above' | 'below' | 'level' | 'unknown'; direction?: string } = {}): BlockerReport {
  const range = options.range ?? 16;
  const sx = Math.floor(self.x);
  const sy = Math.floor(self.y);
  const sz = Math.floor(self.z);
  let seenHazard = 0;
  let seenWater = 0;
  let wallRays = 0;
  let dropRays = 0;
  let unloadedRays = 0;
  let unobservedRays = 0;
  const DEPTH = 16;
  const offsets = [-Math.PI / 6, -Math.PI / 12, 0, Math.PI / 12, Math.PI / 6];
  for (const off of offsets) {
    const a = bearingRad + off;
    let y = sy;
    let gap = 0; // consecutive columns with no observed floor near walk level
    let outcome: 'wall' | 'drop' | 'unloaded' | 'unobserved' | 'clear' = 'clear';
    for (let step = 1; step <= range; step += 1) {
      const x = Math.floor(self.x + Math.cos(a) * step);
      const z = Math.floor(self.z + Math.sin(a) * step);
      if (x === sx && z === sz) continue;
      if (world.blockAt(x, y, z) === null) {
        outcome = 'unloaded';
        break;
      }
      const at = (dy: number) => seen.get(`${x},${y + dy},${z}`)?.block;
      for (let dy = -4; dy <= 2; dy += 1) {
        const b = at(dy);
        if (!b) continue;
        if (HAZARD.test(b.name)) seenHazard += 1;
        else if (b.name === 'water' || b.name === 'bubble_column') seenWater += 1;
      }
      if (solid(at(0)) && solid(at(1))) {
        outcome = 'wall';
        break;
      }
      if (solid(at(0)) && !at(1) && !at(2)) {
        y += 1; // observed one-block step up
        gap = 0;
        continue;
      }
      if (solid(at(-1))) {
        gap = 0;
        continue; // observed walkable floor
      }
      let found: number | undefined;
      for (let d = 2; d <= DEPTH; d += 1) {
        if (at(-d)) {
          found = d;
          break;
        }
      }
      if (found !== undefined) {
        if (found - 1 <= 3) {
          y -= found - 1; // observed drop of at most 3
          gap = 0;
          continue;
        }
        outcome = 'drop'; // the next observed floor is deeper than 3 below walk level
        break;
      }
      gap += 1; // nothing observed in this column (occluded or open)
      if (gap > 6) {
        outcome = 'unobserved';
        break;
      }
    }
    if (outcome === 'clear' && gap > 0) outcome = 'unobserved';
    if (outcome === 'wall') wallRays += 1;
    else if (outcome === 'drop') dropRays += 1;
    else if (outcome === 'unloaded') unloadedRays += 1;
    else if (outcome === 'unobserved') unobservedRays += 1;
  }
  const rays = offsets.length;
  const evidence = { rays, seenHazard, seenWater, wallRays, dropRays, unloadedRays, unobservedRays };
  const toward = options.direction ? ` toward ${options.direction}` : '';
  if (seenHazard > 0) return { reason: 'hazard_lava', detail: `visible lava/fire hazard${toward}; the conservative path avoids it`, evidence };
  if (dropRays >= 3) return { reason: 'cliff_drop', detail: `an observed drop deeper than 3 blocks${toward}; no safe descent without placing blocks`, evidence };
  if (wallRays >= 3) {
    if (options.elevation === 'above') return { reason: 'vertical_separation', detail: `an observed wall/rise${toward} and the owner is above; no walkable ascent (no towering or digging)`, evidence };
    return { reason: 'wall', detail: `an observed wall or rise higher than one block${toward}; no walkable way around in sight`, evidence };
  }
  if (seenWater > 0) return { reason: 'water_crossing', detail: `water${toward} without a visible safe crossing`, evidence };
  if (unloadedRays >= 3) return { reason: 'unloaded_terrain', detail: `terrain${toward} is not loaded yet`, evidence };
  if (unobservedRays >= 3) return { reason: 'unobserved_terrain', detail: `terrain${toward} is not observed from here; no blocker can be named`, evidence };
  if (options.elevation === 'above' || options.elevation === 'below') return { reason: 'vertical_separation', detail: `the owner is ${options.elevation} and no safe frontier${toward} changes height (no digging, towering or scaffolding)`, evidence };
  return { reason: 'no_safe_frontier', detail: `no safe visible frontier${toward} inside the current travel bound`, evidence };
}
