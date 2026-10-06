// Line-of-sight policy (pure functions over a WorldView, unit-testable).
//
// Policy: a ray from the bot's eye is blocked by an OCCLUDER: any block with a
// collision shape that the ray actually intersects, except see-through
// materials (glass, panes, iron bars, barriers). Blocks without a collision
// shape (air, plants, torches, water) do not block sight; lava and powder snow
// do, using their visual geometry (lava surface height by level) because the
// installed block data gives them no collision shape. Partial
// blocks (slabs, stairs, fences) block only where their shapes are. Leaves are
// treated as occluders (conservative "fast graphics" view).
//
// This is a symbolic approximation of player sight, not a camera render: no
// lighting/darkness, fog, or render distance, and omnidirectional (the player
// may turn freely). Installed Mineflayer `canSeeBlock` casts ONE ray to a block
// centre and treats every shaped block (including glass) as opaque; we sample
// exposed face points instead.

export interface BlockView {
  name: string;
  stateId: number;
  /** Collision boxes in block-local coordinates: [x0, y0, z0, x1, y1, z1]. */
  shapes: readonly (readonly number[])[];
  /** Fluid level property (0 = source, 1-7 flowing, 8+ falling) when the block is a fluid. */
  level?: number;
}

/** Visually opaque blocks that have NO collision shape (installed data: lava and powder snow shapes are empty). */
const OPAQUE_NO_COLLISION = new Set(['lava', 'powder_snow']);

/**
 * Name of a voxel whose CLIENT model holds an unconfirmed local prediction
 * (e.g. Mineflayer sets a finished dig to air before the server answers). The
 * authoritative world view presents it as an opaque, unreported full cube until
 * the server states the block: unknown space never reveals what is behind it.
 */
export const UNCONFIRMED_BLOCK = 'unconfirmed_prediction';

/**
 * Geometry used for sight. Collision shapes for ordinary blocks (so partial
 * blocks only block where they are); visual geometry for opaque fluids/snow,
 * which have no collision shape: lava surface height 8/9 for a source, (8-level)/9
 * when flowing, full when falling; powder snow is a full cube.
 */
export function sightShapes(block: BlockView): readonly (readonly number[])[] {
  if (block.name === 'lava') {
    const level = block.level ?? 0;
    const h = level === 0 ? 8 / 9 : level >= 8 ? 1 : (8 - level) / 9;
    return [[0, 0, 0, 1, h, 1]];
  }
  if (OPAQUE_NO_COLLISION.has(block.name)) return [[0, 0, 0, 1, 1, 1]];
  return block.shapes;
}

export interface WorldView {
  /** Null when the chunk is not loaded. */
  blockAt(x: number, y: number, z: number): BlockView | null;
}

export interface Vec {
  x: number;
  y: number;
  z: number;
}

const SEE_THROUGH = /(^|_)glass($|_pane$)|^glass_pane$|_stained_glass(_pane)?$|^tinted_glass$|^iron_bars$|^barrier$|^light$|^structure_void$|_chain$|^chain$/;

export function isSeeThrough(name: string): boolean {
  return SEE_THROUGH.test(name) && name !== 'tinted_glass';
}

/** Whether this block can block sight at all (before the per-shape ray test). */
export function canOcclude(block: BlockView): boolean {
  if (OPAQUE_NO_COLLISION.has(block.name)) return true;
  if (block.shapes.length === 0) return false;
  return !isSeeThrough(block.name);
}

export function isFullCube(block: BlockView): boolean {
  const s = sightShapes(block);
  if (s.length !== 1) return false;
  const b = s[0] as readonly number[];
  return b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 1 && b[4] === 1 && b[5] === 1;
}

/** Ray/AABB slab test; returns entry t in [0, tMax] or undefined. */
function rayBox(o: Vec, d: Vec, min: Vec, max: Vec, tMax: number): number | undefined {
  let t0 = 0;
  let t1 = tMax;
  for (const axis of ['x', 'y', 'z'] as const) {
    const inv = 1 / d[axis];
    let near = (min[axis] - o[axis]) * inv;
    let far = (max[axis] - o[axis]) * inv;
    if (Number.isNaN(near) || Number.isNaN(far)) {
      // ray parallel to this slab: inside or not
      if (o[axis] < min[axis] || o[axis] > max[axis]) return undefined;
      continue;
    }
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return undefined;
  }
  return t0;
}

export interface RayHit {
  x: number;
  y: number;
  z: number;
  block: BlockView;
}

/**
 * Walks voxels from `from` toward `to` (Amanatides–Woo DDA). Calls `visit` for
 * every non-air voxel the segment passes through (excluding `skip`), in order;
 * returns the first occluding hit, or undefined if the segment is clear. A
 * voxel in an unloaded chunk counts as occluding (unknown is not visible).
 */
export function traceSegment(
  world: WorldView,
  from: Vec,
  to: Vec,
  options: { skip?: Vec; visit?: (hit: RayHit) => void; maxSteps?: number } = {},
): RayHit | 'unloaded' | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return undefined;
  const d = { x: dx / len, y: dy / len, z: dz / len };
  let x = Math.floor(from.x);
  let y = Math.floor(from.y);
  let z = Math.floor(from.z);
  const stepX = d.x > 0 ? 1 : -1;
  const stepY = d.y > 0 ? 1 : -1;
  const stepZ = d.z > 0 ? 1 : -1;
  const tDeltaX = d.x !== 0 ? Math.abs(1 / d.x) : Infinity;
  const tDeltaY = d.y !== 0 ? Math.abs(1 / d.y) : Infinity;
  const tDeltaZ = d.z !== 0 ? Math.abs(1 / d.z) : Infinity;
  let tMaxX = d.x !== 0 ? (d.x > 0 ? x + 1 - from.x : from.x - x) * tDeltaX : Infinity;
  let tMaxY = d.y !== 0 ? (d.y > 0 ? y + 1 - from.y : from.y - y) * tDeltaY : Infinity;
  let tMaxZ = d.z !== 0 ? (d.z > 0 ? z + 1 - from.z : from.z - z) * tDeltaZ : Infinity;
  const maxSteps = options.maxSteps ?? Math.ceil(len * 3) + 3;
  let t = 0;
  for (let i = 0; i < maxSteps && t <= len; i += 1) {
    const skip = options.skip && options.skip.x === x && options.skip.y === y && options.skip.z === z;
    if (!skip) {
      const block = world.blockAt(x, y, z);
      if (block === null) return 'unloaded';
      if (block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
        if (canOcclude(block)) {
          if (isFullCube(block)) {
            const hit = { x, y, z, block };
            options.visit?.(hit);
            return hit;
          }
          for (const s of sightShapes(block)) {
            const tb = rayBox(from, d, { x: x + (s[0] ?? 0), y: y + (s[1] ?? 0), z: z + (s[2] ?? 0) }, { x: x + (s[3] ?? 1), y: y + (s[4] ?? 1), z: z + (s[5] ?? 1) }, len);
            if (tb !== undefined) {
              const hit = { x, y, z, block };
              options.visit?.(hit);
              return hit;
            }
          }
        }
        options.visit?.({ x, y, z, block });
      }
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
    }
  }
  return undefined;
}

/** True when nothing occludes the segment (endpoints' own voxels may be skipped). */
export function lineOfSight(world: WorldView, from: Vec, to: Vec, skip?: Vec): boolean {
  const hit = traceSegment(world, from, to, skip ? { skip } : {});
  return hit === undefined;
}

const FACES: ReadonlyArray<{ name: string; n: Vec }> = [
  { name: 'up', n: { x: 0, y: 1, z: 0 } },
  { name: 'down', n: { x: 0, y: -1, z: 0 } },
  { name: 'north', n: { x: 0, y: 0, z: -1 } },
  { name: 'south', n: { x: 0, y: 0, z: 1 } },
  { name: 'west', n: { x: -1, y: 0, z: 0 } },
  { name: 'east', n: { x: 1, y: 0, z: 0 } },
];

export type FaceName = 'up' | 'down' | 'north' | 'south' | 'west' | 'east';

export function faceNormal(face: FaceName): Vec {
  return (FACES.find((f) => f.name === face) as { n: Vec }).n;
}

/**
 * Faces of block (bx,by,bz) visible from `eye`: exposed (neighbour cannot
 * occlude), facing the eye, and with a clear ray to at least one sample point
 * (face centre plus four inset points).
 */
export function visibleFaces(world: WorldView, eye: Vec, bx: number, by: number, bz: number): FaceName[] {
  const out: FaceName[] = [];
  const target = { x: bx, y: by, z: bz };
  for (const face of FACES) {
    const n = face.n;
    const cx = bx + 0.5 + n.x * 0.5;
    const cy = by + 0.5 + n.y * 0.5;
    const cz = bz + 0.5 + n.z * 0.5;
    // must face the eye
    if ((eye.x - cx) * n.x + (eye.y - cy) * n.y + (eye.z - cz) * n.z <= 0) continue;
    const neighbour = world.blockAt(bx + n.x, by + n.y, bz + n.z);
    if (neighbour === null || (canOcclude(neighbour) && isFullCube(neighbour))) continue;
    const eps = 0.02;
    const samples: Vec[] = [{ x: cx + n.x * eps, y: cy + n.y * eps, z: cz + n.z * eps }];
    for (const [u, v] of [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ] as const) {
      if (n.x !== 0) samples.push({ x: cx + n.x * eps, y: by + u, z: bz + v });
      else if (n.y !== 0) samples.push({ x: bx + u, y: cy + n.y * eps, z: bz + v });
      else samples.push({ x: bx + u, y: by + v, z: cz + n.z * eps });
    }
    if (samples.some((p) => lineOfSight(world, eye, p, target))) out.push(face.name as FaceName);
  }
  return out;
}

export function isBlockVisible(world: WorldView, eye: Vec, bx: number, by: number, bz: number): boolean {
  return visibleFaces(world, eye, bx, by, bz).length > 0;
}

/** Entity/drop visibility: any of the sampled points on its box has a clear ray. */
export function isEntityVisible(world: WorldView, eye: Vec, at: Vec, height: number): boolean {
  const points = [0.1, 0.5, 0.9].map((f) => ({ x: at.x, y: at.y + Math.max(0.05, height * f), z: at.z }));
  return points.some((p) => lineOfSight(world, eye, p));
}

/** Evenly distributed unit directions (Fibonacci sphere). */
export function sphereDirections(n: number): Vec[] {
  const out: Vec[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i += 1) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
  }
  return out;
}

/**
 * Discovery pass: casts `directions` rays from `eye` up to `radius`, collecting
 * every non-air voxel actually seen (see-through blocks are seen and passed;
 * the first occluder is seen and stops the ray). Buried blocks are never seen.
 */
export function discoverVisible(world: WorldView, eye: Vec, radius: number, directions: readonly Vec[]): Map<string, RayHit> {
  const seen = new Map<string, RayHit>();
  for (const d of directions) {
    const to = { x: eye.x + d.x * radius, y: eye.y + d.y * radius, z: eye.z + d.z * radius };
    traceSegment(world, eye, to, {
      visit: (hit) => {
        const key = `${hit.x},${hit.y},${hit.z}`;
        if (!seen.has(key)) seen.set(key, hit);
      },
    });
  }
  return seen;
}
