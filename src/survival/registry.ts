// minecraft-data adapter for survival item facts (exact configured version).
import minecraftData from 'minecraft-data';
import type { SurvivalItemRegistry } from './items.ts';
import { strip } from './items.ts';

export function minecraftDataRegistry(version: string): SurvivalItemRegistry | undefined {
  const md = minecraftData(version);
  if (!md) return undefined;
  const foods = (md as unknown as { foodsByName?: Record<string, { foodPoints: number; saturation: number } | undefined> }).foodsByName ?? {};
  return {
    nameOf: (id) => md.items[id]?.name,
    maxDurability: (key) => {
      const n = md.itemsByName[strip(key)] as { maxDurability?: number } | undefined;
      return typeof n?.maxDurability === 'number' && n.maxDurability > 0 ? n.maxDurability : undefined;
    },
    food: (key) => {
      const f = foods[strip(key)];
      return f ? { foodPoints: f.foodPoints, saturation: f.saturation } : undefined;
    },
  };
}
