// Coordinates the OWNER actually typed. A planner `owner_destination` (or a
// movement destination parameter) is admissible only when its numbers match a
// triple parsed here, by code, from the owner's instruction (MB-PLAN-006: there
// are no clarification answers). An echoed `ownerText` label is never evidence
// by itself: the planner could invent both the label and the numbers.
import type { OwnerCoordinate } from '../contracts/index.ts';

const NUM = String.raw`(-?\d{1,8}(?:\.\d{1,3})?)`;
/** "x 10 y 64 z -3", "x=10, y=64, z=-3" */
const LABELLED = new RegExp(String.raw`\bx\s*[=:]?\s*${NUM}\s*[,;]?\s*y\s*[=:]?\s*${NUM}\s*[,;]?\s*z\s*[=:]?\s*${NUM}`, 'gi');
/** "10 64 -3", "10, 64, -3", "(10,64,-3)" — three numbers in a row. */
const BARE = new RegExp(String.raw`(?<![\w.\-])${NUM}\s*[, ]\s*${NUM}\s*[, ]\s*${NUM}(?![\w.])`, 'g');

const MAX_COORDINATES = 4;
const HORIZONTAL_LIMIT = 30_000_000;

function plausible(x: number, y: number, z: number): boolean {
  return [x, y, z].every(Number.isFinite) && Math.abs(x) <= HORIZONTAL_LIMIT && Math.abs(z) <= HORIZONTAL_LIMIT && y >= -64 && y <= 320;
}

export function parseOwnerCoordinates(text: string, source: OwnerCoordinate['source']): OwnerCoordinate[] {
  const out: OwnerCoordinate[] = [];
  const seen = new Set<string>();
  for (const re of [LABELLED, BARE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!plausible(x, y, z)) continue;
      const k = `${x},${y},${z}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ x, y, z, text: m[0].trim().slice(0, 80), source });
      if (out.length >= MAX_COORDINATES) return out;
    }
  }
  return out;
}

/** All owner-typed coordinates for a goal (from the owner's instruction only). */
export function ownerCoordinates(instruction: string): OwnerCoordinate[] {
  return parseOwnerCoordinates(instruction, 'instruction');
}

/** Whether a proposed position matches an owner-typed coordinate (block centring tolerated). */
export function matchesOwnerCoordinate(at: { x: number; y: number; z: number }, coords: readonly OwnerCoordinate[]): boolean {
  return coords.some((c) => Math.abs(at.x - c.x) <= 0.5 + 1e-9 && Math.abs(at.y - c.y) <= 0.5 + 1e-9 && Math.abs(at.z - c.z) <= 0.5 + 1e-9);
}
