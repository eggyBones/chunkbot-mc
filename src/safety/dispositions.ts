// Safety dispositions of entity TYPES and the supported defensive matchups.
//
// This is documented CODE POLICY (coordinator assumptions, MB-FLOW-003-C13),
// not world observation and not a model decision. It is deliberately
// conservative:
//   - The installed minecraft-data `category` cannot be used directly: it
//     files neutral mobs (enderman, piglin, zombified piglin) and a passive
//     mount (strider) under "Hostile mobs". Curated names below override it.
//   - A name not curated here falls back to `hostile_other` when the exact
//     version's registry files it as hostile (avoided when close/approaching,
//     never fought), `passive` when the registry files it as passive, and
//     `unknown` otherwise (avoided only after server-attributed damage).
//   - Only a few adult melee mobs are SUPPORTED for defense; everything else
//     (ranged, explosive, flying, swarming, high-damage, boss, status-effect,
//     neutral, unknown) is avoidance-only. Supported != always fought: the
//     readiness checks in policy.ts must also pass for the current situation.
//
// Names are validated against the exact version's entity registry by the
// adapter; a curated name absent from a version is simply never seen.
import type { SafetyDisposition } from '../contracts/safety.ts';

const strip = (key: string): string => key.replace(/^minecraft:/, '');

/** Melee hostiles. */
const HOSTILE_MELEE = new Set([
  'zombie',
  'husk',
  'zombie_villager',
  'drowned',
  'spider',
  'cave_spider',
  'silverfish',
  'endermite',
  'vindicator',
  'zoglin',
  'hoglin',
  'ravager',
  'warden',
  'piglin_brute',
  'wither_skeleton',
  'creaking',
  'giant',
  'vex',
  'phantom',
  'slime',
  'magma_cube',
  'zombie_nautilus',
]);

/** Ranged/area attackers (avoidance only; break line of sight). */
const HOSTILE_RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'breeze', 'shulker', 'evoker', 'illusioner', 'guardian', 'elder_guardian', 'wither', 'ender_dragon']);

const HOSTILE_EXPLOSIVE = new Set(['creeper']);

/** Neutral: a threat only after server-attributed damage; never attacked by safety. */
const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin', 'wolf', 'polar_bear', 'bee', 'iron_golem', 'llama', 'trader_llama', 'panda', 'dolphin', 'goat']);

/** Registry "hostile" entries that are not hostile to players in vanilla play. */
const PASSIVE_OVERRIDES = new Set(['strider']);

/** Behaviour not established for this release (no curated policy): avoided only after damage. */
const UNKNOWN_OVERRIDES = new Set(['sulfur_cube', 'camel_husk', 'parched']);

/**
 * Adult mobs that bounded defensive melee MAY engage when every readiness
 * check passes. Coordinator assumption pending M-G1 fixture evidence on both
 * exact versions: ordinary-damage melee mobs without ranged attacks, status
 * effects, flight, splitting, swarming or boss mechanics.
 */
const DEFENSE_SUPPORTED = new Set(['zombie', 'husk', 'zombie_villager', 'drowned', 'spider']);

/** Supported species with a baby variant. Spiders have no age metadata. */
export function defenseRequiresAdult(key: string): boolean {
  return DEFENSE_SUPPORTED.has(strip(key)) && strip(key) !== 'spider';
}

/** Main-hand items that make an otherwise melee mob a ranged threat. */
const RANGED_ITEMS = new Set(['bow', 'crossbow', 'trident']);

export interface DispositionFacts {
  disposition: SafetyDisposition;
  /** Whether this type may ever be a defense target (subject to readiness). */
  defenseSupported: boolean;
}

/**
 * Disposition of an entity type. `registryCategory` is the exact version's
 * minecraft-data category (fallback only); `heldItem` is the server-stated
 * main hand (entity_equipment), which can make a melee mob ranged.
 */
export function dispositionOf(key: string, registryCategory: string | undefined, heldItem: string | null = null): DispositionFacts {
  const name = strip(key);
  if (name === 'player') return { disposition: 'player', defenseSupported: false };
  const ranged = heldItem !== null && RANGED_ITEMS.has(strip(heldItem));
  if (HOSTILE_EXPLOSIVE.has(name)) return { disposition: 'hostile_explosive', defenseSupported: false };
  if (HOSTILE_RANGED.has(name)) return { disposition: 'hostile_ranged', defenseSupported: false };
  if (HOSTILE_MELEE.has(name)) return ranged ? { disposition: 'hostile_ranged', defenseSupported: false } : { disposition: 'hostile_melee', defenseSupported: DEFENSE_SUPPORTED.has(name) };
  if (NEUTRAL.has(name)) return { disposition: 'neutral', defenseSupported: false };
  if (PASSIVE_OVERRIDES.has(name)) return { disposition: 'passive', defenseSupported: false };
  if (UNKNOWN_OVERRIDES.has(name)) return { disposition: 'unknown', defenseSupported: false };
  if (registryCategory === 'Hostile mobs') return { disposition: 'hostile_other', defenseSupported: false };
  if (registryCategory === 'Passive mobs') return { disposition: 'passive', defenseSupported: false };
  // Projectiles, vehicles, displays, items, orbs, etc. are not creatures.
  if (registryCategory === 'Projectiles' || registryCategory === 'Vehicles' || registryCategory === 'Immobile') return { disposition: 'passive', defenseSupported: false };
  return { disposition: 'unknown', defenseSupported: false };
}

/** Weapon classes admitted for defense, by the exact version's official item tags. */
export interface WeaponFacts {
  kind: 'sword' | 'axe';
  tier: string;
  /** Conservative full attack-cooldown wait (ms) for the class (vanilla attack speed 1.6 sword; axes 0.8-1.0). */
  cooldownMs: number;
}

/** Excluded tiers: lowest damage (wooden) and very low durability (golden). */
const EXCLUDED_TIERS = new Set(['wooden', 'golden']);

/**
 * Weapon facts when `key` is in the exact version's `#minecraft:swords` or
 * `#minecraft:axes` tag (membership supplied by the caller from VersionKnowledge),
 * excluding wooden/golden tiers. Spears, maces, tridents and bows are not
 * admitted in this release.
 */
export function weaponFacts(key: string, inTag: (tag: '#minecraft:swords' | '#minecraft:axes', key: string) => boolean): WeaponFacts | undefined {
  const k = key.includes(':') ? key : `minecraft:${key}`;
  const tier = /^([a-z]+)_(sword|axe)$/.exec(strip(k))?.[1];
  if (!tier || EXCLUDED_TIERS.has(tier)) return undefined;
  if (inTag('#minecraft:swords', k)) return { kind: 'sword', tier, cooldownMs: 650 };
  if (inTag('#minecraft:axes', k)) return { kind: 'axe', tier, cooldownMs: 1_300 };
  return undefined;
}

/** Vanilla armor points per piece (unchanged across 1.9-26.x); unknown pieces count 0. */
const ARMOR_POINTS: Record<string, Record<string, number>> = {
  leather: { helmet: 1, chestplate: 3, leggings: 2, boots: 1 },
  golden: { helmet: 2, chestplate: 5, leggings: 3, boots: 1 },
  chainmail: { helmet: 2, chestplate: 5, leggings: 4, boots: 1 },
  copper: { helmet: 2, chestplate: 4, leggings: 3, boots: 1 },
  iron: { helmet: 2, chestplate: 6, leggings: 5, boots: 2 },
  diamond: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 },
  netherite: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 },
};

export function armorPointsOf(key: string): number {
  const n = strip(key);
  if (n === 'turtle_helmet') return 2;
  const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(n);
  return m ? (ARMOR_POINTS[m[1] as string]?.[m[2] as string] ?? 0) : 0;
}
