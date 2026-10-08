// Pure local geometry for immediate safety (unit-testable over a voxel view).
//
// Everything here reads the CLIENT world model (server chunk/block data as
// held by the library, with pending client predictions masked by
// sessionWorld) around the bot's client-physics position, so every result is
// a LOCAL ESTIMATE. Exit/retreat targets must additionally have a floor that
// is visible from the eye (caller-supplied `visible`), so a target never
// depends on unseen terrain.
//
// Fluids: `water`, `bubble_column` and always-waterlogged plants (kelp,
// seagrass) are water; any block whose state says `waterlogged=true` is water
// too. Fluid surface height follows the fluid level (source 8/9, flowing
// (8-level)/9, falling or covered by the same fluid: full block).
import type { Vec3 } from '../contracts/common.ts';

export interface SafetyBlock {
  name: string;
  /** Collision boxes in block-local coordinates. */
  shapes: readonly (readonly number[])[];
  /** Fluid level (0 = source, 1-7 flowing, 8+ falling). */
  level?: number;
  /** Block state `waterlogged=true`. */
  waterlogged?: boolean;
}

export interface SafetyBlockReader {
  /** Null when the chunk is not loaded. */
  blockAt(x: number, y: number, z: number): SafetyBlock | null;
}

const WATER_FILLED = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
/** Blocks never used as a safe floor or passed through by a safety exit/retreat. */
const HAZARD = new Set([
  'lava',
  'fire',
  'soul_fire',
  'magma_block',
  'campfire',
  'soul_campfire',
  'sweet_berry_bush',
  'wither_rose',
  'powder_snow',
  'cobweb',
  'pointed_dripstone',
  'cactus',
  'bubble_column',
  'unconfirmed_prediction',
]);

export type Fluid = 'water' | 'lava';

export function fluidOf(b: SafetyBlock | null): Fluid | undefined {
  if (!b) return undefined;
  if (b.name === 'lava') return 'lava';
  if (WATER_FILLED.has(b.name) || b.waterlogged === true) return 'water';
  return undefined;
}

export function isHazard(b: SafetyBlock | null): boolean {
  return b !== null && HAZARD.has(b.name);
}

/** Has a collision shape (can support / block movement). */
export function isSolid(b: SafetyBlock | null): boolean {
  return b !== null && b.shapes.length > 0 && !HAZARD.has(b.name);
}

/** No collision, no fluid, no hazard: a body can stand in it dry. */
export function isDryOpen(b: SafetyBlock | null): boolean {
  return b !== null && b.shapes.length === 0 && fluidOf(b) === undefined && !HAZARD.has(b.name);
}

/** Fluid surface height inside block (x, y, z), 0..1, or undefined when not that fluid. */
export function fluidHeight(world: SafetyBlockReader, x: number, y: number, z: number, fluid: Fluid): number | undefined {
  const b = world.blockAt(x, y, z);
  if (fluidOf(b) !== fluid) return undefined;
  if (fluidOf(world.blockAt(x, y + 1, z)) === fluid) return 1;
  const level = b?.level;
  if (level === undefined || level === 0) return 8 / 9;
  if (level >= 8) return 1;
  return (8 - level) / 9;
}

/** The fluid at a point (inside the fluid volume, below its surface), if any. */
export function fluidAtPoint(world: SafetyBlockReader, p: Vec3): Fluid | undefined {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  const z = Math.floor(p.z);
  for (const fluid of ['water', 'lava'] as const) {
    const h = fluidHeight(world, x, y, z, fluid);
    if (h !== undefined && p.y < y + h) return fluid;
  }
  return undefined;
}

export interface FluidState {
  feetIn: Fluid | 'none';
  eyeIn: Fluid | 'none';
  support: 'solid' | 'fluid' | 'none' | 'unknown';
  depth: number | null;
  headroom: 'open' | 'ceiling' | 'unknown' | 'dry';
  surfaceDy: number | null;
  /** Y of the topmost fluid block in the bot's column (null when not in fluid). */
  fluidTopY: number | null;
  /** Standing on the floor beneath would keep the eyes above the fluid surface (null when not in fluid). */
  wadeable: boolean | null;
}

/**
 * Local fluid estimate for a body at `pos` (feet) with eye height `eyeHeight`.
 * Feet are "in" a fluid when it covers the lower body (pos.y + 0.2 or + 0.6),
 * like the physics' contracted water box.
 */
export function fluidState(world: SafetyBlockReader, pos: Vec3, eyeHeight = 1.62): FluidState {
  const eye = { x: pos.x, y: pos.y + eyeHeight, z: pos.z };
  const feetIn = fluidAtPoint(world, { x: pos.x, y: pos.y + 0.2, z: pos.z }) ?? fluidAtPoint(world, { x: pos.x, y: pos.y + 0.6, z: pos.z }) ?? 'none';
  const eyeIn = fluidAtPoint(world, eye) ?? 'none';
  const x = Math.floor(pos.x);
  const z = Math.floor(pos.z);
  let depth: number | null = null;
  let support: FluidState['support'] = 'unknown';
  let fluidTopY: number | null = null;
  let wadeable: boolean | null = null;
  let floorTop: number | null = null;
  const fluid = feetIn !== 'none' ? feetIn : eyeIn !== 'none' ? eyeIn : undefined;
  if (fluid) {
    // Down from the feet block through contiguous fluid to what lies beneath.
    const feetY = Math.floor(pos.y + 0.2);
    let y = feetY;
    let n = 0;
    while (n < 32) {
      const b = world.blockAt(x, y, z);
      if (b === null) {
        support = 'unknown';
        break;
      }
      if (fluidOf(b) === fluid && b.shapes.length === 0) {
        n += 1;
        y -= 1;
        continue;
      }
      support = b.shapes.length > 0 ? 'solid' : fluidOf(b) ? 'fluid' : 'none';
      if (b.shapes.length > 0) floorTop = y + Math.max(...b.shapes.map((s) => s[4] ?? 1));
      break;
    }
    depth = n;
    // Up from the feet block to the top of the fluid column.
    let top = feetY;
    for (let i = 0; i < 32 && fluidOf(world.blockAt(x, top + 1, z)) === fluid; i += 1) top += 1;
    fluidTopY = fluidOf(world.blockAt(x, top, z)) === fluid ? top : null;
    if (support === 'solid' && floorTop !== null && fluidTopY !== null) {
      const surface = fluidTopY + (fluidHeight(world, x, fluidTopY, z, fluid) ?? 1);
      wadeable = surface - floorTop < eyeHeight - 0.1;
    } else {
      wadeable = false;
    }
  } else {
    const below = world.blockAt(x, Math.floor(pos.y - 0.05), z);
    support = below === null ? 'unknown' : below.shapes.length > 0 ? 'solid' : fluidOf(below) ? 'fluid' : 'none';
  }
  let headroom: FluidState['headroom'] = 'dry';
  let surfaceDy: number | null = null;
  if (eyeIn !== 'none') {
    headroom = 'unknown';
    let y = Math.floor(eye.y);
    for (let i = 0; i < 32; i += 1) {
      const b = world.blockAt(x, y, z);
      if (b === null) break;
      if (fluidOf(b) === eyeIn && b.shapes.length === 0) {
        y += 1;
        continue;
      }
      if (b.shapes.length === 0 && fluidOf(b) === undefined) {
        headroom = 'open';
        // The surface is at the top of the last fluid block (fluid height of that block).
        const h = fluidHeight(world, x, y - 1, z, eyeIn) ?? 1;
        surfaceDy = Math.max(0, Math.round((y - 1 + h - eye.y) * 100) / 100);
      } else {
        headroom = 'ceiling';
      }
      break;
    }
  }
  return { feetIn, eyeIn, support, depth, headroom, surfaceDy, fluidTopY, wadeable };
}

/** Cells at swimming depth: the feet block is fluid AND there is no solid floor right under it. */
export function isUnsupportedFluid(world: SafetyBlockReader, x: number, y: number, z: number): boolean {
  const b = world.blockAt(x, y, z);
  if (fluidOf(b) === undefined || (b && b.shapes.length > 0)) return false;
  const below = world.blockAt(x, y - 1, z);
  return !isSolid(below);
}

/**
 * Step cost for pathfinder `exclusionAreasStep` (C11): 100 (= refused by the
 * installed pathfinder) for a passed-through block that is water/water-filled
 * without a solid block directly beneath (swimming depth or a head-level
 * water block), and for bubble columns; 0 otherwise. Wading in one block of
 * water over solid ground stays allowed.
 */
export function deepWaterStepCost(world: SafetyBlockReader, x: number, y: number, z: number): number {
  const b = world.blockAt(x, y, z);
  if (b === null) return 0;
  if (b.name === 'bubble_column') return 100;
  if (fluidOf(b) !== 'water') return 0;
  return isUnsupportedFluid(world, x, y, z) ? 100 : 0;
}

/** A dry standable cell: solid non-hazard floor, two dry open blocks for the body. */
export function isStandable(world: SafetyBlockReader, x: number, y: number, z: number): boolean {
  return isSolid(world.blockAt(x, y - 1, z)) && isDryOpen(world.blockAt(x, y, z)) && isDryOpen(world.blockAt(x, y + 1, z));
}

export interface ExitTarget {
  /** Feet cell (block coordinates). */
  x: number;
  y: number;
  z: number;
  /** Swim/walk path length estimate (BFS steps). */
  steps: number;
  /** Straight-line distance from the start. */
  distance: number;
}

export interface ExitOptions {
  radius: number;
  /** Floor visibility from the eye (observed geometry only). */
  visible(x: number, y: number, z: number): boolean;
  /** Extra admission (travel bounds, displacement, threat clearance). */
  allowed?(x: number, y: number, z: number): boolean;
  /** Penalty added to the ranking (e.g. proximity to threats). */
  penalty?(x: number, y: number, z: number): number;
  max?: number;
}

const DIRS4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * Dry exits from a fluid: BFS over the fluid SURFACE layer (fluid block with a
 * non-solid block above) connected to the bot's column, then dry standable
 * cells horizontally adjacent to a visited surface cell whose feet are at the
 * surface block level or one above (a single climb the physics' out-of-liquid
 * impulse supports). Ranked by path steps, then penalty. Bounded by `radius`.
 */
export function findFluidExits(world: SafetyBlockReader, pos: Vec3, fluid: Fluid, opts: ExitOptions): ExitTarget[] {
  const sx = Math.floor(pos.x);
  const sz = Math.floor(pos.z);
  const start = fluidState(world, pos);
  const topY = start.fluidTopY ?? Math.floor(pos.y);
  const seen = new Map<string, number>();
  const queue: Array<[number, number, number]> = [[sx, sz, 0]];
  seen.set(`${sx},${sz}`, 0);
  const exits = new Map<string, ExitTarget>();
  const consider = (x: number, z: number, steps: number) => {
    for (const dy of [0, 1]) {
      const y = topY + dy;
      if (!isStandable(world, x, y, z)) continue;
      if (!opts.visible(x, y - 1, z)) continue;
      if (opts.allowed && !opts.allowed(x, y, z)) continue;
      const key = `${x},${y},${z}`;
      const distance = Math.hypot(x + 0.5 - pos.x, z + 0.5 - pos.z);
      const prev = exits.get(key);
      if (!prev || prev.steps > steps) exits.set(key, { x, y, z, steps, distance });
      return;
    }
  };
  while (queue.length > 0) {
    const [x, z, steps] = queue.shift() as [number, number, number];
    for (const [dx, dz] of DIRS4) {
      const nx = x + dx;
      const nz = z + dz;
      if (Math.hypot(nx - sx, nz - sz) > opts.radius) continue;
      const k = `${nx},${nz}`;
      if (seen.has(k)) continue;
      const surface = world.blockAt(nx, topY, nz);
      const above = world.blockAt(nx, topY + 1, nz);
      if (fluidOf(surface) === fluid && surface?.shapes.length === 0 && above !== null && above.shapes.length === 0 && !isHazard(above)) {
        seen.set(k, steps + 1);
        queue.push([nx, nz, steps + 1]);
      } else {
        consider(nx, nz, steps + 1);
      }
    }
  }
  const penalty = opts.penalty ?? (() => 0);
  return [...exits.values()].sort((a, b) => a.steps + penalty(a.x, a.y, a.z) - (b.steps + penalty(b.x, b.y, b.z)) || a.distance - b.distance).slice(0, opts.max ?? 4);
}

/**
 * When a solid ceiling is directly above the submerged eye: the nearest
 * fluid column (connected through fluid at the eye level) that opens to air
 * within a few blocks. Undefined when none is within `radius`.
 */
export function findOpenColumn(world: SafetyBlockReader, pos: Vec3, fluid: Fluid, radius: number, eyeHeight = 1.62): { x: number; z: number; steps: number; surfaceY: number } | undefined {
  const ey = Math.floor(pos.y + eyeHeight);
  const sx = Math.floor(pos.x);
  const sz = Math.floor(pos.z);
  const seen = new Set<string>([`${sx},${sz}`]);
  const queue: Array<[number, number, number]> = [[sx, sz, 0]];
  while (queue.length > 0) {
    const [x, z, steps] = queue.shift() as [number, number, number];
    if (steps > 0) {
      let y = ey;
      for (let i = 0; i < 6; i += 1) {
        const b = world.blockAt(x, y, z);
        if (b === null) break;
        if (fluidOf(b) === fluid && b.shapes.length === 0) {
          y += 1;
          continue;
        }
        if (isDryOpen(b)) return { x, z, steps, surfaceY: y };
        break;
      }
    }
    for (const [dx, dz] of DIRS4) {
      const nx = x + dx;
      const nz = z + dz;
      const k = `${nx},${nz}`;
      if (seen.has(k) || Math.hypot(nx - sx, nz - sz) > radius) continue;
      const b = world.blockAt(nx, ey, nz);
      if (fluidOf(b) === fluid && b?.shapes.length === 0) {
        seen.add(k);
        queue.push([nx, nz, steps + 1]);
      }
    }
  }
  return undefined;
}

export interface RetreatOptions {
  /** Threat positions (visible entities only). */
  threats: Vec3[];
  /** Desired separation from every threat. */
  separation: number;
  /** Maximum leg length. */
  legMax: number;
  visible(x: number, y: number, z: number): boolean;
  allowed?(x: number, y: number, z: number): boolean;
  /** Directions sampled (default 16). */
  directions?: number;
}

export interface RetreatTarget {
  x: number;
  y: number;
  z: number;
  distance: number;
  /** Minimum distance from the target cell to any threat. */
  clearance: number;
}

/**
 * Dry, standable, visible-floor retreat cells on rings around the bot that
 * INCREASE the minimum separation from every visible threat. Cells in or next
 * to fluid, hazard floors, and drops larger than three blocks are refused.
 * Ranked by clearance (capped at the desired separation), then shorter legs.
 */
export function findRetreatTargets(world: SafetyBlockReader, pos: Vec3, opts: RetreatOptions): RetreatTarget[] {
  const clearanceAt = (x: number, z: number) => (opts.threats.length === 0 ? Infinity : Math.min(...opts.threats.map((t) => Math.hypot(x - t.x, z - t.z))));
  const current = clearanceAt(pos.x, pos.z);
  const n = opts.directions ?? 16;
  const rings = [6, 9, 12, 15, 18].filter((r) => r <= opts.legMax);
  if (rings.length === 0) rings.push(opts.legMax);
  const out: RetreatTarget[] = [];
  const by = Math.floor(pos.y);
  for (const r of rings) {
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.floor(pos.x + Math.cos(a) * r);
      const z = Math.floor(pos.z + Math.sin(a) * r);
      // Nearest standable feet level: up to two steps up, up to three down (the conservative drop limit).
      for (const dy of [0, 1, -1, 2, -2, -3]) {
        const y = by + dy;
        if (!isStandable(world, x, y, z)) continue;
        if (!opts.visible(x, y - 1, z)) continue;
        // Keep out of fluid neighbourhoods (no retreat into water/lava edges).
        let wet = false;
        for (const [dx, dz] of DIRS4) if (fluidOf(world.blockAt(x + dx, y, z + dz)) || fluidOf(world.blockAt(x + dx, y - 1, z + dz))) wet = true;
        if (wet) continue;
        if (opts.allowed && !opts.allowed(x, y, z)) continue;
        const clearance = clearanceAt(x + 0.5, z + 0.5);
        if (clearance <= current + 2) continue;
        out.push({ x, y, z, distance: Math.hypot(x + 0.5 - pos.x, z + 0.5 - pos.z), clearance });
        break;
      }
    }
  }
  const capped = (t: RetreatTarget) => Math.min(t.clearance, opts.separation);
  return out.sort((a, b) => capped(b) - capped(a) || a.distance - b.distance).slice(0, 6);
}
