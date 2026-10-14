// Survival-owned task context. The shared composition writer supplies exact
// recipe/harvest facts for an accepted task; no instruction parsing or new
// scheduler lives here. Missing/stale context never invents task requirements.
import { z } from 'zod';
import type { InventoryFacts, SurvivalConfig, TrackedStack } from '../contracts/survival.ts';
import { armorPoints, isValuable, mk, nearlyWorn, remainingUses, sameDimension, STORAGE_SLOTS, toolTier } from './items.ts';

const key = z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(128);
export const UpkeepTaskContextSchema = z.object({
  connectionEpoch: z.number().int().nonnegative(),
  dimension: z.string().min(1).max(128),
  observedAtMs: z.number().finite(),
  /** Registry-backed harvest requirements, empty tools = no required tool. */
  harvest: z.array(z.object({ block: key, tools: z.array(key).max(16) }).strict()).max(8),
  /** Supplies needed by this task. Their whole keys are retained. */
  retain: z.array(key).max(32),
  /** Only these non-food configured reserves are appropriate to the task. */
  reserveKeys: z.array(key).max(16),
  requiredFreeSlots: z.number().int().min(0).max(36),
}).strict();
export type UpkeepTaskContext = z.infer<typeof UpkeepTaskContextSchema>;

export function freshTaskContext(value: unknown, fence: { connectionEpoch: number; dimension: string }, now: number): UpkeepTaskContext | undefined {
  const parsed = UpkeepTaskContextSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const c = parsed.data;
  return c.connectionEpoch === fence.connectionEpoch && sameDimension(c.dimension, fence.dimension) && c.observedAtMs <= now && now - c.observedAtMs <= 5_000 ? c : undefined;
}

export const UPKEEP_CAPABILITIES = {
  equipArmor: 'equip_suitable_armor',
  moveStorage: 'move_to_approved_storage',
  storeSurplus: 'store_surplus',
  withdrawReserve: 'withdraw_reserve',
} as const;

/** Equip-by-key cannot distinguish duplicate stacks. Every selectable stack
 * of a key must be ordinary, server-stated and healthy before auto-selection. */
export function healthySelectable(inv: InventoryFacts, keys: readonly string[], cfg: SurvivalConfig): TrackedStack[] {
  const valid = new Set(keys.map(mk));
  const grouped = new Map<string, TrackedStack[]>();
  for (const s of inv.stacks) {
    if (!valid.has(s.key)) continue;
    grouped.set(s.key, [...(grouped.get(s.key) ?? []), s]);
  }
  return [...grouped.values()].filter((ss) => ss.every((s) => s.meta.metadata === 'server_slot' && !isValuable(s.key, s.meta) && nearlyWorn(s, cfg.tools.wornFraction, cfg.tools.wornUses) === false))
    .flatMap((ss) => ss.filter((s) => STORAGE_SLOTS.includes(s.slot)));
}

export function suitableTool(inv: InventoryFacts, tools: readonly string[], cfg: SurvivalConfig): TrackedStack | undefined {
  return healthySelectable(inv, tools, cfg).sort((a, b) => toolTier(a.key) - toolTier(b.key) || (remainingUses(b) ?? 0) - (remainingUses(a) ?? 0) || a.slot - b.slot)[0];
}

export const ARMOR_DESTINATIONS = { head: 5, torso: 6, legs: 7, feet: 8 } as const;
export type ArmorSlot = keyof typeof ARMOR_DESTINATIONS;
export function armorSlot(key: string): ArmorSlot | undefined {
  if (/_helmet$/.test(key)) return 'head';
  if (/_chestplate$/.test(key)) return 'torso';
  if (/_leggings$/.test(key)) return 'legs';
  if (/_boots$/.test(key)) return 'feet';
  return undefined;
}

export function suitableArmor(inv: InventoryFacts, cfg: SurvivalConfig): { key: string; slot: ArmorSlot } | undefined {
  const keys = inv.stacks.filter((s) => armorSlot(s.key)).map((s) => s.key);
  const eligible = healthySelectable(inv, keys, cfg).sort((a, b) => armorPoints(b.key) - armorPoints(a.key) || a.slot - b.slot);
  for (const s of eligible) {
    const dest = armorSlot(s.key)!;
    const worn = inv.stacks.find((x) => x.slot === ARMOR_DESTINATIONS[dest]);
    if (worn && (isValuable(worn.key, worn.meta) || worn.key === s.key)) continue;
    if (!worn || armorPoints(s.key) > armorPoints(worn.key) || (armorPoints(s.key) >= armorPoints(worn.key) && nearlyWorn(worn, cfg.tools.wornFraction, cfg.tools.wornUses) === true)) return { key: s.key, slot: dest };
  }
  return undefined;
}
