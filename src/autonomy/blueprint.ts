// small_shelter_v1: the code-generated blueprint of the initial home
// (MB-FLOW-001 A3). Pure functions: no world access, no Minecraft library.
//
// Layout (outer = interior + 2, walls 2 high, flat roof one layer above):
//
//   phase 1  wall layer 1 (floor level y0) around the perimeter, except the entrance column
//   phase 2  wall layer 2 (y0+1)
//   phase 3  ONE temporary construction aid block on an interior floor cell
//            (C1-approved: the bot stands on it so the wall tops' upper faces
//            are visible; it is never a navigation tower)
//   phase 4  roof (y0+2) over every column except the aid column
//   phase 5  remove the bot's OWN aid block (identity proven by server evidence)
//   phase 6  roof cell above the aid column (placed standing under the hole)
//   phase 7  workstation (crafting table), furnace and storage (chest) inside
//
// The entrance is a 1-wide, 2-high opening in the front wall that must stay
// passable (air, or a door). The interior cell behind the entrance stays free.
import type { BlueprintCell, HomeProject } from '../contracts/autonomy.ts';

export type Facing = 'north' | 'south' | 'east' | 'west';
export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Accepted solid building blocks for walls/roof/aid (bounded; gravity and grass-converting blocks excluded). */
export const SHELTER_MATERIALS = ['#minecraft:planks', '#minecraft:logs', 'minecraft:cobblestone', 'minecraft:cobbled_deepslate', 'minecraft:stone', 'minecraft:stone_bricks', 'minecraft:bricks', 'minecraft:mud_bricks'] as const;

export const ENTRANCE_ACCEPT = ['minecraft:air', '#minecraft:wooden_doors'] as const;

export const PHASES = { wall1: 1, wall2: 2, aid: 3, roof: 4, removeAid: 5, roofHole: 6, furnishing: 7 } as const;

export const PHASE_NAMES: Record<number, string> = { 1: 'walls (layer 1)', 2: 'walls (layer 2)', 3: 'construction aid', 4: 'roof', 5: 'remove construction aid', 6: 'close the roof', 7: 'workstation, furnace and storage' };

/** Local (u along the entrance wall, v inward) -> world offset for a facing (entrance on the `facing` side). */
export function toWorld(origin: V3, outer: number, facing: Facing, u: number, v: number, dy: number): V3 {
  const n = outer - 1;
  switch (facing) {
    case 'north': // entrance wall at min z
      return { x: origin.x + u, y: origin.y + dy, z: origin.z + v };
    case 'south': // entrance wall at max z
      return { x: origin.x + n - u, y: origin.y + dy, z: origin.z + n - v };
    case 'west': // entrance wall at min x
      return { x: origin.x + v, y: origin.y + dy, z: origin.z + n - u };
    case 'east': // entrance wall at max x
      return { x: origin.x + n - v, y: origin.y + dy, z: origin.z + u };
  }
}

const key = (p: V3) => `${p.x},${p.y},${p.z}`;

/** Generates the blueprint cells for an approved footprint. */
export function smallShelterCells(origin: V3, interior: 2 | 3, facing: Facing): BlueprintCell[] {
  const outer = interior + 2;
  const mid = Math.floor(outer / 2);
  const cells: BlueprintCell[] = [];
  const at = (u: number, v: number, dy: number) => toWorld(origin, outer, facing, u, v, dy);
  const solid = [...SHELTER_MATERIALS];
  // Interior cells: the one behind the entrance stays free; the aid sits on a furnishing cell (removed before furnishing).
  const furnish: Array<[number, number, string]> =
    interior === 3
      ? [
          [1, 3, 'minecraft:crafting_table'],
          [2, 3, 'minecraft:furnace'],
          [3, 3, 'minecraft:chest'],
        ]
      : [
          [1, 1, 'minecraft:chest'],
          [1, 2, 'minecraft:crafting_table'],
          [2, 2, 'minecraft:furnace'],
        ];
  const aid: [number, number] = interior === 3 ? [2, 2] : [1, 2];
  for (let u = 0; u < outer; u += 1) {
    for (let v = 0; v < outer; v += 1) {
      const perimeter = u === 0 || v === 0 || u === outer - 1 || v === outer - 1;
      if (perimeter) {
        const entrance = v === 0 && u === mid;
        for (const dy of [0, 1]) {
          cells.push(entrance ? { at: at(u, v, dy), role: 'entrance', phase: dy === 0 ? PHASES.wall1 : PHASES.wall2, accept: [...ENTRANCE_ACCEPT] } : { at: at(u, v, dy), role: 'wall', phase: dy === 0 ? PHASES.wall1 : PHASES.wall2, accept: solid });
        }
      }
      const underAid = u === aid[0] && v === aid[1];
      cells.push({ at: at(u, v, 2), role: 'roof', phase: underAid ? PHASES.roofHole : PHASES.roof, accept: solid });
    }
  }
  cells.push({ at: at(aid[0], aid[1], 0), role: 'aid', phase: PHASES.aid, accept: solid });
  for (const [u, v, block] of furnish) cells.push({ at: at(u, v, 0), role: block === 'minecraft:chest' ? 'storage' : 'workstation', phase: PHASES.furnishing, accept: [block] });
  return cells;
}

/** World positions of interior floor cells (walkable air layer y0) of a project. */
export function interiorCells(project: Pick<HomeProject, 'origin' | 'size' | 'entranceFacing'>): V3[] {
  const outer = project.size.outerX;
  const out: V3[] = [];
  for (let u = 1; u < outer - 1; u += 1) for (let v = 1; v < outer - 1; v += 1) out.push(toWorld(project.origin, outer, project.entranceFacing, u, v, 0));
  return out;
}

/** The interior cell directly behind the entrance (must stay free). */
export function entranceInterior(project: Pick<HomeProject, 'origin' | 'size' | 'entranceFacing'>): V3 {
  const outer = project.size.outerX;
  return toWorld(project.origin, outer, project.entranceFacing, Math.floor(outer / 2), 1, 0);
}

/** The cell just outside the entrance (approach point). */
export function entranceOutside(project: Pick<HomeProject, 'origin' | 'size' | 'entranceFacing'>): V3 {
  const outer = project.size.outerX;
  return toWorld(project.origin, outer, project.entranceFacing, Math.floor(outer / 2), -1, 0);
}

export function aidCell(project: Pick<HomeProject, 'cells'>): BlueprintCell | undefined {
  return project.cells.find((c) => c.role === 'aid');
}

/** Footprint columns (x,z) including walls. */
export function footprint(project: Pick<HomeProject, 'origin' | 'size'>): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let dx = 0; dx < project.size.outerX; dx += 1) for (let dz = 0; dz < project.size.outerZ; dz += 1) out.push({ x: project.origin.x + dx, z: project.origin.z + dz });
  return out;
}

export function cellKey(p: V3): string {
  return key(p);
}

// ---------------------------------------------------------------- verification

/** What code knows about one voxel now. */
export interface VoxelTruth {
  /** Registry key (e.g. minecraft:oak_planks) or undefined when not decidable. */
  key?: string;
  /**
   * server_own_change: this connection's skill-confirmed server change;
   * visible: line-of-sight chunk data without pending prediction;
   * seen_this_connection: observed earlier on this connection, still loaded and unchanged.
   */
  evidence: 'server_own_change' | 'visible' | 'seen_this_connection' | 'unknown';
  detail?: string;
}

export type CellStatus = 'satisfied' | 'missing' | 'foreign' | 'unknown';

export interface CellVerdict {
  cell: BlueprintCell;
  index: number;
  status: CellStatus;
  key?: string;
  evidence: VoxelTruth['evidence'];
}

/** Matches a key against accept entries (tags resolved by the caller's `inTag`). */
export function accepts(cell: BlueprintCell, blockKey: string, inTag: (tag: string, key: string) => boolean): boolean {
  return cell.accept.some((a) => (a.startsWith('#') ? inTag(a, blockKey) : a === blockKey));
}

const AIRLIKE = /^minecraft:(air|cave_air|void_air)$/;
/** Blocks a placement replaces (vegetation/snow layer): "vacant" for building, not acceptable as a finished wall. */
export const REPLACEABLE_KEY = /^minecraft:(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|short_dry_grass|tall_dry_grass|leaf_litter)$/;

/**
 * Per-cell verdict. Later roles at the same position supersede earlier ones
 * (the aid cell is re-used by a furnishing cell in the 2x2 layout): only the
 * latest-phase cell of a position is judged for completion.
 */
export function judgeCells(cells: readonly BlueprintCell[], truth: (p: V3) => VoxelTruth, inTag: (tag: string, key: string) => boolean): CellVerdict[] {
  const latest = new Map<string, number>();
  cells.forEach((c, i) => {
    const k = key(c.at);
    const prev = latest.get(k);
    if (prev === undefined || (cells[prev] as BlueprintCell).phase < c.phase) latest.set(k, i);
  });
  const out: CellVerdict[] = [];
  cells.forEach((cell, index) => {
    const t = truth(cell.at);
    const superseded = latest.get(key(cell.at)) !== index;
    if (!t.key || t.evidence === 'unknown') {
      out.push({ cell, index, status: 'unknown', evidence: 'unknown' });
      return;
    }
    let status: CellStatus;
    if (cell.role === 'aid') {
      // Final state of an aid position: removed (air) unless a later cell re-uses the position.
      status = superseded ? 'satisfied' : AIRLIKE.test(t.key) ? 'satisfied' : accepts(cell, t.key, inTag) ? 'missing' : 'foreign';
    } else if (cell.role === 'entrance') {
      status = accepts(cell, t.key, inTag) || REPLACEABLE_KEY.test(t.key) ? 'satisfied' : 'foreign';
    } else if (accepts(cell, t.key, inTag)) status = 'satisfied';
    else if (REPLACEABLE_KEY.test(t.key)) status = 'missing';
    else status = superseded ? 'satisfied' : 'foreign';
    out.push({ cell, index, status, key: t.key, evidence: t.evidence });
  });
  return out;
}

export interface ShelterVerdict {
  status: 'complete' | 'incomplete' | 'unknown';
  enclosed: 'satisfied' | 'unsatisfied' | 'unknown';
  satisfied: number;
  total: number;
  missing: number;
  foreign: Array<{ at: V3; key: string; role: string }>;
  unknown: number;
  /** Earliest phase with a missing (or unknown) cell, or null when nothing is missing. */
  nextPhase: number | null;
  detail: string;
}

/** Code-verified shelter criteria: every wall/roof cell accepted, entrance passable, furnishings present, own aid removed. */
export function verifyShelter(cells: readonly BlueprintCell[], verdicts: readonly CellVerdict[]): ShelterVerdict {
  const judged = verdicts;
  const foreign = judged.filter((v) => v.status === 'foreign').map((v) => ({ at: v.cell.at, key: v.key ?? 'unknown', role: v.cell.role }));
  const missing = judged.filter((v) => v.status === 'missing');
  const unknown = judged.filter((v) => v.status === 'unknown');
  const satisfied = judged.filter((v) => v.status === 'satisfied').length;
  const enclosure = judged.filter((v) => v.cell.role === 'wall' || v.cell.role === 'roof' || v.cell.role === 'entrance');
  const enclosed = enclosure.some((v) => v.status === 'missing' || v.status === 'foreign') ? 'unsatisfied' : enclosure.some((v) => v.status === 'unknown') ? 'unknown' : 'satisfied';
  const open = [...missing, ...unknown].map((v) => v.cell.phase);
  const nextPhase = open.length ? Math.min(...open) : null;
  const status = foreign.length > 0 || missing.length > 0 ? 'incomplete' : unknown.length > 0 ? 'unknown' : 'complete';
  const detail =
    status === 'complete'
      ? `all ${cells.length} blueprint cells verified: walls and roof closed, entrance passable, workstation/furnace/storage present, construction aid removed`
      : `${satisfied}/${cells.length} cells verified; ${missing.length} missing${unknown.length ? `, ${unknown.length} not observable now` : ''}${foreign.length ? `, ${foreign.length} occupied by blocks the project did not place (${foreign.slice(0, 3).map((f) => `${f.key} at ${f.at.x},${f.at.y},${f.at.z}`).join('; ')})` : ''}${nextPhase !== null ? `; next: ${PHASE_NAMES[nextPhase] ?? `phase ${nextPhase}`}` : ''}`;
  return { status, enclosed, satisfied, total: cells.length, missing: missing.length, foreign, unknown: unknown.length, nextPhase, detail };
}

// ---------------------------------------------------------------- site selection

export interface SiteProbe {
  /** Registry key of the voxel (from loaded server chunk data), or undefined when unloaded/unconfirmed. */
  blockAt(p: V3): string | undefined;
  /** True when the voxel is in line of sight now (some face visible). */
  visible(p: V3): boolean;
  /** Whether a block key is a full, non-gravity natural ground block. */
  naturalGround(key: string): boolean;
}

export interface SiteCandidate {
  origin: V3;
  facing: Facing;
  interior: 2 | 3;
  distance: number;
  checks: string[];
}

/** Keys that indicate someone else's structure nearby (never build next to/into it). */
export const FOREIGN_STRUCTURE = /^minecraft:([a-z_]+_planks|[a-z_]+_door|[a-z_]+_bed|chest|barrel|crafting_table|furnace|torch|wall_torch|[a-z_]+_fence|glass|[a-z_]+_glass|bricks|stone_bricks|ladder|[a-z_]+_slab|[a-z_]+_stairs)$/;

/**
 * Checks one footprint: flat natural ground (all ground blocks the same y, natural,
 * full and VISIBLE now), the whole volume (3 layers) air or replaceable
 * vegetation, the entrance approach walkable, and no foreign structure block
 * within `margin` columns. Returns the failure reason or the checks passed.
 */
export function checkSite(probe: SiteProbe, origin: V3, interior: 2 | 3, facing: Facing, margin = 3): { ok: true; checks: string[] } | { ok: false; reason: string } {
  const outer = interior + 2;
  const groundY = origin.y - 1;
  let visibleGround = 0;
  for (let dx = 0; dx < outer; dx += 1) {
    for (let dz = 0; dz < outer; dz += 1) {
      const g = { x: origin.x + dx, y: groundY, z: origin.z + dz };
      const k = probe.blockAt(g);
      if (!k) return { ok: false, reason: `ground at ${g.x},${g.y},${g.z} is not loaded/confirmed` };
      if (!probe.naturalGround(k)) return { ok: false, reason: `ground ${k} at ${g.x},${g.y},${g.z} is not flat natural ground` };
      if (probe.visible(g)) visibleGround += 1;
      for (let dy = 0; dy < 3; dy += 1) {
        const p = { x: g.x, y: origin.y + dy, z: g.z };
        const v = probe.blockAt(p);
        if (!v) return { ok: false, reason: `volume at ${p.x},${p.y},${p.z} is not loaded/confirmed` };
        if (!REPLACEABLE_KEY.test(v)) return { ok: false, reason: `volume at ${p.x},${p.y},${p.z} holds ${v} (no demolition)` };
      }
    }
  }
  const cells = outer * outer;
  if (visibleGround < cells) return { ok: false, reason: `only ${visibleGround}/${cells} footprint ground blocks are in line of sight now` };
  // Entrance approach: the cell outside the entrance has natural ground and 2 free blocks.
  const out = toWorld(origin, outer, facing, Math.floor(outer / 2), -1, 0);
  const og = probe.blockAt({ ...out, y: out.y - 1 });
  if (!og || !probe.naturalGround(og)) return { ok: false, reason: 'no walkable ground in front of the entrance' };
  for (const dy of [0, 1]) {
    const k = probe.blockAt({ ...out, y: out.y + dy });
    if (!k || !REPLACEABLE_KEY.test(k)) return { ok: false, reason: 'the entrance approach is blocked' };
  }
  for (let dx = -margin; dx < outer + margin; dx += 1) {
    for (let dz = -margin; dz < outer + margin; dz += 1) {
      for (let dy = -1; dy < 4; dy += 1) {
        const p = { x: origin.x + dx, y: origin.y + dy, z: origin.z + dz };
        const k = probe.blockAt(p);
        if (k && FOREIGN_STRUCTURE.test(k)) return { ok: false, reason: `a structure block (${k}) is within ${margin} blocks; not building next to someone else's work` };
      }
    }
  }
  return { ok: true, checks: [`flat natural ground at y=${groundY}, ${cells}/${cells} ground blocks visible`, `${cells * 3} volume voxels air/replaceable`, `entrance faces ${facing}; approach walkable`, `no structure blocks within ${margin}`] };
}

/** Searches candidate footprints around a standing position (bounded scan). */
export function findSites(probe: SiteProbe, standing: V3, interior: 2 | 3, maxDistance: number, withinTravel: (p: V3) => boolean, limit = 4): SiteCandidate[] {
  const out: SiteCandidate[] = [];
  const outer = interior + 2;
  const facings: Facing[] = ['north', 'south', 'east', 'west'];
  const seen = new Set<string>();
  for (let r = 1; r <= maxDistance && out.length < limit; r += 1) {
    for (let dx = -r; dx <= r && out.length < limit; dx += 1) {
      for (let dz = -r; dz <= r && out.length < limit; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of [0, -1, 1]) {
          const origin = { x: Math.floor(standing.x) + dx, y: Math.floor(standing.y) + dy, z: Math.floor(standing.z) + dz };
          const k = key(origin);
          if (seen.has(k)) continue;
          seen.add(k);
          const centre = { x: origin.x + outer / 2, y: origin.y, z: origin.z + outer / 2 };
          // The bot must not stand inside the footprint (it would block placements), and the site must be inside travel bounds.
          const inside = standing.x >= origin.x && standing.x < origin.x + outer && standing.z >= origin.z && standing.z < origin.z + outer;
          if (inside || !withinTravel(centre)) continue;
          // Entrance faces the bot (shortest approach).
          const facing = facings.slice().sort((a, b) => {
            const pa = toWorld(origin, outer, a, Math.floor(outer / 2), -1, 0);
            const pb = toWorld(origin, outer, b, Math.floor(outer / 2), -1, 0);
            return Math.hypot(pa.x - standing.x, pa.z - standing.z) - Math.hypot(pb.x - standing.x, pb.z - standing.z);
          })[0] as Facing;
          const check = checkSite(probe, origin, interior, facing);
          if (check.ok) {
            out.push({ origin, facing, interior, distance: Math.round(Math.hypot(centre.x - standing.x, centre.z - standing.z) * 10) / 10, checks: check.checks });
            break;
          }
        }
      }
    }
  }
  return out;
}
