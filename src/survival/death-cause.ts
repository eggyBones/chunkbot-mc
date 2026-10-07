// Death cause from the server's own combat-kill message: only the vanilla
// translation key is kept (player names, killer names and free text are
// dropped), classified into a small code-owned hazard family. An empty or
// non-translatable message stays `unknown`.
import type { DeathCause } from '../contracts/survival.ts';

/** Finds the top-level `translate` key in a decoded chat component (plain JSON or prismarine-nbt shaped). */
export function translationKeyOf(message: unknown, depth = 0): string | undefined {
  if (depth > 6 || message === null || message === undefined) return undefined;
  if (typeof message === 'string') {
    try {
      return translationKeyOf(JSON.parse(message), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof message !== 'object') return undefined;
  const m = message as Record<string, unknown>;
  // prismarine-nbt: { type: 'compound', value: { translate: { type: 'string', value: '...' } } }
  if (m['type'] === 'compound' && m['value'] && typeof m['value'] === 'object') return translationKeyOf(m['value'], depth + 1);
  const t = m['translate'];
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object' && typeof (t as { value?: unknown }).value === 'string') return (t as { value: string }).value;
  return undefined;
}

const VALID = /^[a-zA-Z0-9_.]{1,80}$/;

/** Hazard family of a vanilla death translation key (coordinator classification table). */
export function hazardOf(key: string): DeathCause['hazard'] {
  if (!key.startsWith('death.')) return 'other';
  const k = key.slice('death.'.length);
  if (/^fell\./.test(k) || /^attack\.(fall|flyIntoWall|stalagmite|fallingStalactite|fallingBlock|anvil)/.test(k)) return 'fall';
  if (/^attack\.lava/.test(k)) return 'lava';
  if (/^attack\.(inFire|onFire|hotFloor|campfire)/.test(k)) return 'fire';
  if (/^attack\.drown/.test(k)) return 'drowning';
  if (/^attack\.outOfWorld|^attack\.outsideBorder/.test(k)) return 'void';
  if (/^attack\.(inWall|cramming)/.test(k)) return 'suffocation';
  if (/^attack\.starve/.test(k)) return 'starvation';
  if (/^attack\.(explosion|fireworks|badRespawnPoint)/.test(k)) return 'explosion';
  if (/^attack\.(magic|indirectMagic|wither|dragonBreath|sonic_boom|thorns)/.test(k)) return 'magic';
  if (/^attack\.freeze/.test(k)) return 'freeze';
  if (/^attack\.(genericKill|generic\.?$|generic$)/.test(k) || k === 'attack.generic') return 'command';
  if (/^attack\.player/.test(k)) return 'player';
  if (/^attack\.(mob|arrow|trident|thrown|fireball|sting|witherSkull|spit|mace_smash|player\.item)/.test(k)) return 'mob';
  return 'other';
}

export function classifyDeathMessage(message: unknown): DeathCause {
  const key = translationKeyOf(message);
  if (!key || !VALID.test(key)) return { kind: 'unknown', hazard: 'unknown' };
  return { kind: 'server_message', translationKey: key, hazard: hazardOf(key) };
}

/** Hazards whose mechanics destroy or remove dropped items at the site (labeled likely, never verified). */
export function destroysDrops(hazard: DeathCause['hazard']): 'void' | 'burn' | undefined {
  if (hazard === 'void') return 'void';
  if (hazard === 'lava') return 'burn';
  return undefined;
}

/** Hazards that make returning to the exact site dangerous by themselves. */
export function siteIsHazard(hazard: DeathCause['hazard']): boolean {
  return hazard === 'lava' || hazard === 'void' || hazard === 'drowning' || hazard === 'suffocation' || hazard === 'fire' || hazard === 'explosion';
}
