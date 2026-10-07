// Item classification for survival policy: safe/risky/precious food, armor
// points, valuables, tool tiers and durability from SERVER slot metadata.
//
// The registry facts (food points, max durability) come from the installed
// minecraft-data for the exact configured version through a small adapter;
// the risky/precious/valuable lists are documented code policy (coordinator
// assumptions), not world observations. Unknown metadata stays unknown.
import type { ItemMetadata, TrackedStack } from '../contracts/survival.ts';

/** Minimal registry facts survival needs (adapter over minecraft-data; test doubles in tests). */
export interface SurvivalItemRegistry {
  /** Registry name for a protocol item id (e.g. 981 -> `bread`). */
  nameOf(itemId: number): string | undefined;
  /** Registry default max durability (absent: not damageable). */
  maxDurability(key: string): number | undefined;
  /** Food facts (absent: not a food). */
  food(key: string): { foodPoints: number; saturation: number } | undefined;
}

export const strip = (key: string): string => key.replace(/^minecraft:/, '');
export const mk = (name: string): string => (name.includes(':') ? name : `minecraft:${name}`);

/**
 * Foods never eaten automatically: harmful/random effects (rotten flesh,
 * spider eye, pufferfish, poisonous potato, raw chicken, suspicious stew),
 * teleporting chorus fruit, and honey/milk-style special consumables are not
 * routine food. Coordinator assumption, documented in the review.
 */
export const RISKY_FOOD = new Set(['rotten_flesh', 'spider_eye', 'pufferfish', 'poisonous_potato', 'chicken', 'suspicious_stew', 'chorus_fruit']);

/** Precious consumables preserved unless the owner explicitly authorizes them. */
export const PRECIOUS_FOOD = new Set(['golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'glistering_melon_slice']);

/** Valuable item families (never dumped; flagged valuable in a loss manifest). */
const VALUABLE = /^(diamond|netherite|emerald|totem_of_undying|elytra|enchanted_golden_apple|golden_apple|nether_star|beacon|shulker_box|[a-z_]+_shulker_box|heart_of_the_sea|trident|mace|heavy_core|ancient_debris|enchanted_book|experience_bottle|music_disc_[a-z0-9_]+)$/;
const TOOL = /_(pickaxe|axe|shovel|hoe|sword)$|^(shears|flint_and_steel|fishing_rod|bow|crossbow|shield|trident|mace|brush)$/;
const ARMOR = /_(helmet|chestplate|leggings|boots)$|^(turtle_helmet|elytra)$/;

/** Vanilla armor defense points per piece (Java; unchanged across 1.9–26.x). Unknown pieces count 0. */
const ARMOR_POINTS: Record<string, Record<string, number>> = {
  leather: { helmet: 1, chestplate: 3, leggings: 2, boots: 1 },
  golden: { helmet: 2, chestplate: 5, leggings: 3, boots: 1 },
  chainmail: { helmet: 2, chestplate: 5, leggings: 4, boots: 1 },
  copper: { helmet: 2, chestplate: 4, leggings: 3, boots: 1 },
  iron: { helmet: 2, chestplate: 6, leggings: 5, boots: 2 },
  diamond: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 },
  netherite: { helmet: 3, chestplate: 8, leggings: 6, boots: 3 },
  turtle: { helmet: 2 },
};

export function armorPoints(key: string): number {
  const n = strip(key);
  if (n === 'turtle_helmet') return 2;
  const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(n);
  if (!m) return 0;
  return ARMOR_POINTS[m[1] as string]?.[m[2] as string] ?? 0;
}

/** Tool tier order used to prefer cheaper capable tools (wood < gold < stone < copper < iron < diamond < netherite). */
const TIER: Record<string, number> = { wooden: 1, golden: 2, stone: 3, copper: 4, iron: 5, diamond: 6, netherite: 7 };
export function toolTier(key: string): number {
  const m = /^([a-z]+)_(pickaxe|axe|shovel|hoe|sword)$/.exec(strip(key));
  return m ? (TIER[m[1] as string] ?? 0) : 0;
}
export function toolKind(key: string): string | undefined {
  return /_(pickaxe|axe|shovel|hoe|sword)$/.exec(strip(key))?.[1];
}

export function isTool(key: string): boolean {
  return TOOL.test(strip(key));
}
export function isArmor(key: string): boolean {
  return ARMOR.test(strip(key));
}

export function isValuable(key: string, meta?: ItemMetadata, extra: readonly string[] = []): boolean {
  const n = strip(key);
  if (extra.includes(mk(n))) return true;
  if (meta?.enchanted || meta?.customName) return true;
  return VALUABLE.test(n) || /^(diamond|netherite)_/.test(n);
}

export interface FoodChoice {
  key: string;
  foodPoints: number;
  saturation: number;
  count: number;
}

/**
 * Safe owned foods, best routine choice first. Excludes risky and precious
 * food and the configured avoid list. Prefers the smallest food that does not
 * waste much (closest to the missing hunger), then higher saturation.
 */
export function safeFoods(stacks: readonly { key: string; count: number }[], registry: SurvivalItemRegistry, food: number, avoid: readonly string[] = []): FoodChoice[] {
  const totals = new Map<string, number>();
  for (const s of stacks) totals.set(mk(s.key), (totals.get(mk(s.key)) ?? 0) + s.count);
  const missing = Math.max(0, 20 - food);
  const out: FoodChoice[] = [];
  for (const [key, count] of totals) {
    const n = strip(key);
    if (RISKY_FOOD.has(n) || PRECIOUS_FOOD.has(n) || avoid.includes(key)) continue;
    const f = registry.food(key);
    if (!f || f.foodPoints <= 0) continue;
    out.push({ key, foodPoints: f.foodPoints, saturation: f.saturation, count });
  }
  const waste = (c: FoodChoice) => Math.max(0, c.foodPoints - missing);
  return out.sort((a, b) => waste(a) - waste(b) || b.saturation - a.saturation || a.key.localeCompare(b.key));
}

export function isSafeFood(key: string, registry: SurvivalItemRegistry, avoid: readonly string[] = []): boolean {
  const n = strip(key);
  if (RISKY_FOOD.has(n) || PRECIOUS_FOOD.has(n) || avoid.includes(mk(n))) return false;
  return (registry.food(mk(n))?.foodPoints ?? 0) > 0;
}

/** Remaining uses of a damageable stack, or undefined when the metadata is unknown / not damageable. */
export function remainingUses(stack: Pick<TrackedStack, 'meta'>): number | undefined {
  const m = stack.meta;
  if (m.metadata !== 'server_slot' || m.maxDurability === undefined) return undefined;
  return Math.max(0, m.maxDurability - (m.damage ?? 0));
}

/** Nearly worn per config (fraction or absolute uses, whichever is larger). Unknown metadata is NOT worn (unknown). */
export function nearlyWorn(stack: Pick<TrackedStack, 'meta'>, wornFraction: number, wornUses: number): boolean | undefined {
  const left = remainingUses(stack);
  if (left === undefined || stack.meta.maxDurability === undefined) return undefined;
  return left <= Math.max(wornUses, Math.floor(stack.meta.maxDurability * wornFraction));
}

// ---------------------------------------------------------------- raw slot parsing

interface RawComponent {
  type?: unknown;
  data?: unknown;
}
export interface RawSlot {
  itemCount?: number;
  itemId?: number;
  components?: RawComponent[];
  removeComponents?: Array<{ type?: unknown }>;
}

/**
 * Parses a server slot (26.x Slot: count, id, component patch). The patch is
 * relative to the item's registry defaults, so a damageable item without a
 * `damage` patch has damage 0 — known because the server stated this slot.
 */
export function parseSlot(raw: RawSlot | null | undefined, registry: SurvivalItemRegistry): { key: string; count: number; meta: ItemMetadata } | null {
  if (!raw || !raw.itemCount || raw.itemCount <= 0 || typeof raw.itemId !== 'number') return null;
  const name = registry.nameOf(raw.itemId) ?? `unknown_${raw.itemId}`;
  const key = mk(name);
  let maxDurability = registry.maxDurability(key);
  let damage: number | undefined;
  let enchanted = false;
  let customName = false;
  let unbreakable = false;
  for (const c of raw.components ?? []) {
    const t = typeof c.type === 'string' ? c.type : undefined;
    if (t === 'damage' && typeof c.data === 'number') damage = c.data;
    else if (t === 'max_damage' && typeof c.data === 'number') maxDurability = c.data;
    else if (t === 'enchantments' || t === 'stored_enchantments') enchanted = true;
    else if (t === 'custom_name') customName = true;
    else if (t === 'unbreakable') unbreakable = true;
  }
  for (const r of raw.removeComponents ?? []) if (r.type === 'max_damage') maxDurability = undefined;
  if (unbreakable) maxDurability = undefined;
  const meta: ItemMetadata = { metadata: 'server_slot', ...(maxDurability !== undefined ? { maxDurability, damage: damage ?? 0 } : {}), ...(enchanted ? { enchanted } : {}), ...(customName ? { customName } : {}) };
  return { key, count: raw.itemCount, meta };
}

/** Player-inventory index (set_player_inventory) -> window-0 slot (0..8 hotbar, 9..35 main, 36..39 feet..head, 40 off hand). */
export function inventoryIndexToWindowSlot(index: number): number | undefined {
  if (index >= 0 && index <= 8) return 36 + index;
  if (index >= 9 && index <= 35) return index;
  if (index >= 36 && index <= 39) return 8 - (index - 36);
  if (index === 40) return 45;
  return undefined;
}

/** Window-0 equipment slots. */
export const ARMOR_SLOTS = [5, 6, 7, 8] as const;
export const OFF_HAND_SLOT = 45;
/** Main inventory + hotbar (36 slots) used for free-space accounting. */
export const STORAGE_SLOTS = Array.from({ length: 36 }, (_, i) => 9 + i);

export function counts(stacks: readonly { key: string; count: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of stacks) m.set(s.key, (m.get(s.key) ?? 0) + s.count);
  return m;
}
