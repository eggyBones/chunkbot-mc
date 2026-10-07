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
// specific local reason for the planner/owner. Hazard identities (lava,
// water) are reported only from voxels the bot actually SAW in the current
// observation; walls/drops use loaded collision geometry along the bearing,
// the same geometry the conservative pathfinder already uses, and are
// reported only as a coarse reason (never as a geometry dump).
import { findFrontiers, isFloor, isPassable, isStandable, type FrontierCell } from '../perception/frontiers.ts';
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

export const TERRAIN_BLOCKERS = ['hazard_lava', 'cliff_drop', 'wall', 'water_crossing', 'unloaded_terrain', 'vertical_separation', 'no_safe_frontier'] as const;
export type TerrainBlocker = (typeof TERRAIN_BLOCKERS)[number];

export interface BlockerReport {
  reason: TerrainBlocker;
  detail: string;
  evidence: { rays: number; seenHazard: number; seenWater: number; wallRays: number; dropRays: number; unloadedRays: number };
}

const HAZARD = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire)$/;

/**
 * Names the local reason no safe frontier leads toward the bearing, sampling
 * five rays within +/-30 degrees up to `range` blocks.
 */
export function classifyBlocker(world: WorldView, self: Vec, bearingRad: number, seen: ReadonlyMap<string, { block: { name: string } }>, options: { range?: number; elevation?: 'above' | 'below' | 'level' | 'unknown'; direction?: string } = {}): BlockerReport {
  const range = options.range ?? 16;
  const sx = Math.floor(self.x);
  const sy = Math.floor(self.y);
  const sz = Math.floor(self.z);
  let seenHazard = 0;
  let seenWater = 0;
  let wallRays = 0;
  let dropRays = 0;
  let unloadedRays = 0;
  const offsets = [-Math.PI / 6, -Math.PI / 12, 0, Math.PI / 12, Math.PI / 6];
  for (const off of offsets) {
    const a = bearingRad + off;
    let y = sy;
    let stopped = false;
    for (let step = 1; step <= range && !stopped; step += 1) {
      const x = Math.floor(self.x + Math.cos(a) * step);
      const z = Math.floor(self.z + Math.sin(a) * step);
      if (x === sx && z === sz) continue;
      if (world.blockAt(x, y, z) === null) {
        unloadedRays += 1;
        break;
      }
      for (let dy = -4; dy <= 2; dy += 1) {
        const hit = seen.get(`${x},${y + dy},${z}`);
        if (!hit) continue;
        if (HAZARD.test(hit.block.name)) seenHazard += 1;
        else if (hit.block.name === 'water' || hit.block.name === 'bubble_column') seenWater += 1;
      }
      if (isStandable(world, x, y, z)) continue;
      if (isStandable(world, x, y + 1, z)) {
        y += 1;
        continue;
      }
      let dropped = false;
      if (isPassable(world.blockAt(x, y, z)) && isPassable(world.blockAt(x, y + 1, z))) {
        for (let drop = 1; drop <= 3; drop += 1) {
          if (isStandable(world, x, y - drop, z)) {
            y -= drop;
            dropped = true;
            break;
          }
          if (!isPassable(world.blockAt(x, y - drop, z))) break;
        }
        if (!dropped) {
          // open air below the walk level beyond a 3-block drop (or liquid/hazard surface)
          const below = world.blockAt(x, y - 1, z);
          if (below !== null && !isFloor(below)) dropRays += 1;
          stopped = true;
        }
        continue;
      }
      wallRays += 1;
      stopped = true;
    }
  }
  const rays = offsets.length;
  const evidence = { rays, seenHazard, seenWater, wallRays, dropRays, unloadedRays };
  const toward = options.direction ? ` toward ${options.direction}` : '';
  if (seenHazard > 0) return { reason: 'hazard_lava', detail: `visible lava/fire hazard${toward}; the conservative path avoids it`, evidence };
  if (dropRays >= 3) return { reason: 'cliff_drop', detail: `a drop deeper than 3 blocks${toward}; no safe descent without placing blocks`, evidence };
  if (wallRays >= 3) {
    if (options.elevation === 'above') return { reason: 'vertical_separation', detail: `a wall/rise${toward} and the owner is above; no walkable ascent (no towering or digging)`, evidence };
    return { reason: 'wall', detail: `a wall or rise higher than one block${toward}; no walkable way around in sight`, evidence };
  }
  if (seenWater > 0) return { reason: 'water_crossing', detail: `water${toward} without a visible safe crossing`, evidence };
  if (unloadedRays >= 3) return { reason: 'unloaded_terrain', detail: `terrain${toward} is not loaded yet`, evidence };
  if (options.elevation === 'above' || options.elevation === 'below') return { reason: 'vertical_separation', detail: `the owner is ${options.elevation} and no safe frontier${toward} changes height (no digging, towering or scaffolding)`, evidence };
  return { reason: 'no_safe_frontier', detail: `no safe visible frontier${toward} inside the current travel bound`, evidence };
}
