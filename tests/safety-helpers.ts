// Credential-free builders for immediate-safety tests (no Minecraft, no inference).
import { SafetyConfigSchema, type SafetyConfigInput, type SafetyEntityFact, type SafetyItemFact, type SafetySelfFacts } from '../src/contracts/safety.ts';
import type { PolicyContext } from '../src/safety/policy.ts';
import { dispositionOf } from '../src/safety/dispositions.ts';
import { FakeWorld } from './skill-fakes.ts';

export const config = (input: SafetyConfigInput = {}) => SafetyConfigSchema.parse(input);

const SWORDS = new Set(['wooden', 'stone', 'golden', 'copper', 'iron', 'diamond', 'netherite'].map((t) => `minecraft:${t}_sword`));
const AXES = new Set(['wooden', 'stone', 'golden', 'copper', 'iron', 'diamond', 'netherite'].map((t) => `minecraft:${t}_axe`));
export const inTag = (tag: '#minecraft:swords' | '#minecraft:axes', key: string) => (tag === '#minecraft:swords' ? SWORDS : AXES).has(key);

export function item(key: string, slot: number, max: number | null = null, remaining: number | null = max): SafetyItemFact {
  return { key: `minecraft:${key}`, slot, maxDurability: max, remainingUses: remaining, metadata: 'server_slot' };
}

/** Iron sword in hotbar 0 (held), iron chestplate + helmet (8 armor points). */
export function armed(): SafetySelfFacts['equipment'] {
  return {
    mainHand: item('iron_sword', 36, 250, 240),
    heldHotbar: 0,
    hotbar: [item('iron_sword', 36, 250, 240)],
    armor: [item('iron_helmet', 5, 165, 160), item('iron_chestplate', 6, 240, 230)],
    source: 'server_slots',
    observedAtMs: 0,
  };
}

export function unarmed(): SafetySelfFacts['equipment'] {
  return { mainHand: null, heldHotbar: 0, hotbar: [], armor: [], source: 'server_slots', observedAtMs: 0 };
}

export function self(over: Partial<SafetySelfFacts> = {}): SafetySelfFacts {
  return {
    connectionEpoch: 1,
    dimension: 'overworld',
    observedAtMs: 1_000,
    position: { x: 0.5, y: 0, z: 0.5 },
    health: 20,
    food: 20,
    vitalsSource: 'server_update_health',
    air: { value: null, max: 300, source: 'unknown', observedAtMs: null, trend: 'unknown' },
    fluid: { feetIn: 'none', eyeIn: 'none', support: 'solid', depth: null, wadeable: null, headroom: 'dry', surfaceDy: null, onGround: true, source: 'local_estimate' },
    equipment: armed(),
    recentDamage: [],
    ...over,
  };
}

let nextId = 100;
export function mob(key: string, distance: number, over: Partial<SafetyEntityFact> = {}): SafetyEntityFact {
  const d = dispositionOf(key, key === 'mystery' ? undefined : key === 'wolf' || key === 'cow' ? 'Passive mobs' : 'Hostile mobs', over.heldItem ?? null);
  return {
    entityId: nextId++,
    key: `minecraft:${key}`,
    disposition: d.disposition,
    at: { x: 0.5 + distance, y: 0, z: 0.5 },
    distance,
    height: 1.95,
    approaching: null,
    aggressive: null,
    // Test builder's ordinary zombie-family control is a known adult. Unknown
    // age cases must override with null; spiders have no baby property.
    baby: ['zombie', 'husk', 'zombie_villager', 'drowned'].includes(key) ? false : null,
    fuse: key === 'creeper' ? { swelling: false, ignited: false } : null,
    heldItem: null,
    damagedSelfAtMs: null,
    observedAtMs: 1_000,
    ...over,
  };
}

export function policyCtx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    config: config(),
    nowMs: 1_000,
    inTag,
    fluidExitAvailable: () => true,
    retreatAvailable: () => true,
    defenseSupported: (f) => dispositionOf(f.key, 'Hostile mobs', f.heldItem).defenseSupported,
    ...over,
  };
}

/** A pool: water from y=0..depth-1 over a stone floor at y=-1, inside a stone rim; dry grass land beyond x > half. */
export function pool(depth: number, half = 4): FakeWorld {
  const w = new FakeWorld({ min: -32, max: 32 });
  w.fill(-32, -2, -32, 32, -2, 32, 'stone');
  w.fill(-32, -1, -32, 32, -1, 32, 'stone');
  // land: raise ground so its top is level with the water's top block
  w.fill(-32, 0, -32, 32, depth - 1, 32, 'dirt');
  for (let x = -half; x <= half; x += 1) for (let z = -half; z <= half; z += 1) for (let y = 0; y < depth; y += 1) w.setFluid(x, y, z, 'water');
  return w;
}
