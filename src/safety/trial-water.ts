// Pure oracle over actual RCON block/ground facts; independent of product geometry.
export type TrialWaterBlock = 'air' | 'water' | 'lava' | 'solid' | 'other';
export interface TrialWaterSupport {
  onGround: boolean;
  floor: TrialWaterBlock;
  feet: TrialWaterBlock;
  eye: TrialWaterBlock;
}

/** A height above the surface alone proves nothing: ground and blocks must agree. */
export function serverWaterSupport(f: TrialWaterSupport): 'dry' | 'wading' | undefined {
  if (!f.onGround || f.floor !== 'solid' || f.eye !== 'air') return undefined;
  if (f.feet === 'air') return 'dry';
  if (f.feet === 'water') return 'wading';
  return undefined;
}
