// MB-LOC-001: converts one exact server waypoint statement into a COARSE cue
// relative to the bot's own current position. Pure functions.
//
// Exact statement data enters here transiently and only these leave:
//   - a compass sector (8 sectors, the frontier vocabulary),
//   - a distance band, only when the variant justifies it,
//   - a relative elevation, only for block-precision (vec3i) statements,
//   - an internal steering bearing (radians) used by route code to rank SAFE
//     LOCAL FRONTIERS; never a navigation goal and never model-visible.
//
// Variant semantics (installed codec; vanilla meaning to be confirmed by the
// official-source/L-G1 gate, see docs/reviews/mb-loc-001-locator.md):
//   vec3i   — the source entity's block position (block precision);
//   chunk   — the source's chunk coordinates (position within +/- 8*sqrt(2)
//             blocks of the chunk centre, no height);
//   azimuth — a horizontal angle only (no distance, no height);
//   empty   — tracked with no position (nothing actionable).
import { LOCATOR_BAND_EDGES, LOCATOR_LEVEL_TOLERANCE, type CompassSector, type LocatorDistanceBand, type LocatorElevation, type LocatorPrecision } from '../contracts/locator.ts';
import { compassSector } from '../perception/frontiers.ts';
import type { WaypointPayload } from './codec.ts';

interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** Horizontal uncertainty of a chunk statement (chunk centre to a corner). */
export const CHUNK_UNCERTAINTY = 8 * Math.SQRT2;

/**
 * Azimuth convention: the angle is a Minecraft yaw (radians) of the direction
 * from the RECEIVER to the source, i.e. facing vector (-sin a, 0, cos a):
 * 0 = south (+z), -pi/2 = east (+x), pi/2 = west, +/-pi = north.
 * Coordinator gate: confirm against the official source and L-G1 fixture
 * evidence; `azimuthToVector` is the single place to change it.
 */
export const AZIMUTH_CONVENTION = 'minecraft_yaw_receiver_to_source' as const;

export function azimuthToVector(azimuth: number): { dx: number; dz: number } {
  return { dx: -Math.sin(azimuth), dz: Math.cos(azimuth) };
}

export function distanceBand(d: number): Exclude<LocatorDistanceBand, 'unknown'> {
  if (d < LOCATOR_BAND_EDGES.close) return 'close';
  if (d < LOCATOR_BAND_EDGES.near) return 'near';
  if (d < LOCATOR_BAND_EDGES.far) return 'far';
  return 'very_far';
}

/** A band only when every position the uncertainty allows falls in the same band. */
export function bandWithUncertainty(d: number, uncertainty: number): LocatorDistanceBand {
  const lo = distanceBand(Math.max(0, d - uncertainty));
  const hi = distanceBand(d + uncertainty);
  return lo === hi ? lo : 'unknown';
}

export interface Cue {
  /** Internal steering bearing: Math.atan2(dz, dx) of the cue direction (+x east, +z south); null when undetermined. */
  bearingRad: number | null;
  direction: CompassSector | null;
  distanceBand: LocatorDistanceBand;
  elevation: LocatorElevation;
  precision: LocatorPrecision;
  /** Internal approximate horizontal distance (vec3i/chunk only); never model-visible. */
  approxDistance: number | null;
}

/** Cue from one statement relative to the bot's feet position, or undefined when it has no usable direction. */
export function cueFrom(payload: WaypointPayload, self: XYZ): Cue | undefined {
  switch (payload.variant) {
    case 'empty':
      return undefined;
    case 'vec3i': {
      const dx = payload.x + 0.5 - self.x;
      const dz = payload.z + 0.5 - self.z;
      const d = Math.hypot(dx, dz);
      const dy = payload.y - Math.floor(self.y);
      const elevation: LocatorElevation = dy > LOCATOR_LEVEL_TOLERANCE ? 'above' : dy < -LOCATOR_LEVEL_TOLERANCE ? 'below' : 'level';
      // Directly above/below the bot: the height is stated, the horizontal direction is not.
      if (d < 1) return { bearingRad: null, direction: null, distanceBand: 'close', elevation, precision: 'block', approxDistance: d };
      return { bearingRad: Math.atan2(dz, dx), direction: compassSector(dx, dz) as CompassSector, distanceBand: distanceBand(d), elevation, precision: 'block', approxDistance: d };
    }
    case 'chunk': {
      const cx = payload.chunkX * 16 + 8;
      const cz = payload.chunkZ * 16 + 8;
      const dx = cx - self.x;
      const dz = cz - self.z;
      const d = Math.hypot(dx, dz);
      // Inside or next to the stated chunk the direction is not determined.
      if (d <= CHUNK_UNCERTAINTY * 1.5) return undefined;
      return { bearingRad: Math.atan2(dz, dx), direction: compassSector(dx, dz) as CompassSector, distanceBand: bandWithUncertainty(d, CHUNK_UNCERTAINTY), elevation: 'unknown', precision: 'chunk', approxDistance: d };
    }
    case 'azimuth': {
      const { dx, dz } = azimuthToVector(payload.azimuth);
      return { bearingRad: Math.atan2(dz, dx), direction: compassSector(dx, dz) as CompassSector, distanceBand: 'unknown', elevation: 'unknown', precision: 'direction_only', approxDistance: null };
    }
  }
}

/** Smallest absolute angle between two bearings (radians, 0..pi). */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}
