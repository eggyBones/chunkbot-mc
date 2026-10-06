// Bounded exploration frontiers from safe local geometry (pure functions).
//
// A frontier is a standable cell reachable from the bot by conservative moves
// (walk, step up 1 with headroom, drop at most 3) without digging or placing,
// whose floor the bot can currently see, near the edge of what is visible or
// next to unloaded terrain, and inside the configured travel bounds. Frontiers
// never come from hidden-resource searches or world-seed knowledge.
import { canOcclude, isFullCube, type BlockView, type Vec, type WorldView } from './visibility.ts';

const DANGEROUS = /^(lava|fire|soul_fire|magma_block|campfire|soul_campfire|sweet_berry_bush|wither_rose|powder_snow|cactus|pointed_dripstone|cobweb)$/;

export function isDangerous(block: BlockView | null): boolean {
  return block !== null && DANGEROUS.test(block.name);
}

/** Feet/head space the bot can occupy: no collision shape, not dangerous, not liquid. */
export function isPassable(block: BlockView | null): boolean {
  if (block === null) return false;
  if (isDangerous(block) || block.name === 'water' || block.name === 'bubble_column') return false;
  return block.shapes.length === 0;
}

/** A floor the bot can stand on: a full-ish solid top. */
export function isFloor(block: BlockView | null): boolean {
  if (block === null || isDangerous(block)) return false;
  if (block.shapes.length === 0) return false;
  if (isFullCube(block)) return true;
  // slabs/stairs etc.: standable if the shape top is at least half height and the top is not above 1
  const top = Math.max(...block.shapes.map((s) => s[4] ?? 0));
  return top >= 0.5 && top <= 1;
}

export function isStandable(world: WorldView, x: number, y: number, z: number): boolean {
  return isFloor(world.blockAt(x, y - 1, z)) && isPassable(world.blockAt(x, y, z)) && isPassable(world.blockAt(x, y + 1, z));
}

export interface FrontierOptions {
  radius: number;
  /** Travel bounds: cells farther than `travelRadius` from `travelAnchor` are excluded. */
  travelAnchor: Vec;
  travelRadius: number;
  /** Whether a floor voxel was seen in the current discovery pass. */
  floorSeen: (x: number, y: number, z: number) => boolean;
  visited: readonly Vec[];
  maxNodes?: number;
}

export interface FrontierCell {
  at: Vec;
  distance: number;
  direction: string;
  visited: boolean;
  /** True when the cell borders unloaded terrain. */
  edgeOfLoaded: boolean;
}

const SECTORS = ['east', 'south_east', 'south', 'south_west', 'west', 'north_west', 'north', 'north_east'];

export function compassSector(dx: number, dz: number): string {
  // Minecraft: +x east, +z south
  const angle = Math.atan2(dz, dx); // 0 = east, pi/2 = south
  const idx = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  return SECTORS[idx] as string;
}

/**
 * Breadth-first search over standable cells with conservative moves; returns at
 * most one frontier per compass sector (the farthest seen cell), max 8.
 */
export function findFrontiers(world: WorldView, start: Vec, options: FrontierOptions): { frontiers: FrontierCell[]; explored: number } {
  const sx = Math.floor(start.x);
  const sy = Math.floor(start.y);
  const sz = Math.floor(start.z);
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const seen = new Set<string>([key(sx, sy, sz)]);
  const queue: Array<[number, number, number]> = [[sx, sy, sz]];
  const maxNodes = options.maxNodes ?? 12_000;
  const best = new Map<string, FrontierCell>();
  let explored = 0;
  const r2 = options.radius * options.radius;
  while (queue.length > 0 && explored < maxNodes) {
    const [x, y, z] = queue.shift() as [number, number, number];
    explored += 1;
    const dx = x + 0.5 - start.x;
    const dz = z + 0.5 - start.z;
    const dist = Math.hypot(dx, y - start.y, dz);
    let edgeOfLoaded = false;
    for (const [nx, nz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const cx = x + nx;
      const cz = z + nz;
      if (world.blockAt(cx, y, cz) === null) {
        edgeOfLoaded = true;
        continue;
      }
      // candidate destinations: same level, step up 1, drop up to 3
      const dests: number[] = [];
      if (isStandable(world, cx, y, cz)) dests.push(y);
      else if (isStandable(world, cx, y + 1, cz) && isPassable(world.blockAt(x, y + 2, z))) dests.push(y + 1);
      else if (isPassable(world.blockAt(cx, y, cz)) && isPassable(world.blockAt(cx, y + 1, cz))) {
        for (let drop = 1; drop <= 3; drop += 1) {
          if (isStandable(world, cx, y - drop, cz)) {
            dests.push(y - drop);
            break;
          }
          if (!isPassable(world.blockAt(cx, y - drop, cz))) break;
        }
      }
      for (const ny of dests) {
        const k = key(cx, ny, cz);
        if (seen.has(k)) continue;
        const ddx = cx + 0.5 - start.x;
        const ddz = cz + 0.5 - start.z;
        if (ddx * ddx + ddz * ddz > r2) continue;
        const ax = cx + 0.5 - options.travelAnchor.x;
        const az = cz + 0.5 - options.travelAnchor.z;
        if (Math.hypot(ax, az) > options.travelRadius) continue;
        seen.add(k);
        queue.push([cx, ny, cz]);
      }
    }
    if (!options.floorSeen(x, y - 1, z)) continue;
    const farEnough = dist >= options.radius * 0.6;
    if (!farEnough && !edgeOfLoaded) continue;
    if (dist < 4) continue;
    const sector = compassSector(dx, dz);
    const visited = options.visited.some((v) => Math.hypot(v.x - (x + 0.5), v.z - (z + 0.5)) < 8);
    const current = best.get(sector);
    const better = !current || (current.visited && !visited) || (current.visited === visited && dist > current.distance);
    if (better) best.set(sector, { at: { x: x + 0.5, y, z: z + 0.5 }, distance: dist, direction: sector, visited, edgeOfLoaded });
  }
  const frontiers = [...best.values()].sort((a, b) => Number(a.visited) - Number(b.visited) || b.distance - a.distance).slice(0, 8);
  return { frontiers, explored };
}

export { canOcclude };
