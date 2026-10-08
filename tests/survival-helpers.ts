// Test doubles for MB-FLOW-003: a tiny item registry, raw packet emitters in
// the 26.x codec shapes, observation snapshots and a temp-dir SurvivalService
// harness. Never wired into the real CLI; no fixture, no inference.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObservationSnapshot } from '../src/contracts/observation.ts';
import type { MemoryFact } from '../src/contracts/memory.ts';
import { SurvivalConfigSchema, type RecoveryEpisode, type SurvivalConfigInput } from '../src/contracts/survival.ts';
import type { SurvivalItemRegistry } from '../src/survival/items.ts';
import { SurvivalService, type SurvivalServiceOptions } from '../src/survival/service.ts';

/** Wire (packet GlobalPos / worldState) spelling: namespaced. */
export const OW = 'minecraft:overworld';
/** C7: the SESSION spelling the real app uses (mineflayer `bot.game.dimension`, snapshots, lifecycle). */
export const SESSION_OW = 'overworld';
export const NETHER = 'minecraft:the_nether';
export const NOW0 = 1_700_000_000_000;

const ITEMS: Record<number, string> = { 1: 'bread', 2: 'iron_pickaxe', 3: 'rotten_flesh', 4: 'diamond_sword', 5: 'cobblestone', 6: 'golden_apple', 7: 'iron_helmet', 8: 'stone_pickaxe', 9: 'oak_log', 10: 'cooked_beef', 11: 'dirt' };
export const ID: Record<string, number> = Object.fromEntries(Object.entries(ITEMS).map(([k, v]) => [v, Number(k)]));
const DURABILITY: Record<string, number> = { iron_pickaxe: 250, diamond_sword: 1561, iron_helmet: 165, stone_pickaxe: 131 };
const FOOD: Record<string, { foodPoints: number; saturation: number }> = { bread: { foodPoints: 5, saturation: 6 }, rotten_flesh: { foodPoints: 4, saturation: 0.8 }, golden_apple: { foodPoints: 4, saturation: 9.6 }, cooked_beef: { foodPoints: 8, saturation: 12.8 } };

export const ITEM_ENTITY_TYPE = 71;

export const registry: SurvivalItemRegistry = {
  itemEntityTypeId: ITEM_ENTITY_TYPE,
  nameOf: (id) => ITEMS[id],
  maxDurability: (key) => DURABILITY[key.replace('minecraft:', '')],
  food: (key) => FOOD[key.replace('minecraft:', '')],
};

export class TestClock {
  t = NOW0;
  now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export type Slot = { itemCount: number; itemId?: number; components?: Array<{ type: string; data?: unknown }>; removeComponents?: unknown[] };
export const empty: Slot = { itemCount: 0 };
export function slot(name: string, count = 1, components: Array<{ type: string; data?: unknown }> = []): Slot {
  return { itemCount: count, itemId: ID[name] as number, components, removeComponents: [] };
}

/** Window-0 contents (46 slots) from a slot->stack map. */
export function windowItems(stacks: Record<number, Slot>): { windowId: number; stateId: number; items: Slot[]; carriedItem: Slot } {
  const items: Slot[] = [];
  for (let i = 0; i <= 45; i += 1) items.push(stacks[i] ?? empty);
  return { windowId: 0, stateId: 1, items, carriedItem: empty };
}

export class Packets {
  readonly client = new EventEmitter();
  login(entityId = 42): void {
    this.client.emit('login', { entityId, worldState: { name: OW } });
  }
  inventory(stacks: Record<number, Slot>): void {
    this.client.emit('window_items', windowItems(stacks));
  }
  setSlot(index: number, s: Slot): void {
    this.client.emit('set_slot', { windowId: 0, stateId: 2, slot: index, item: s });
  }
  health(health: number, food = 20, saturation = 5): void {
    this.client.emit('update_health', { health, food, foodSaturation: saturation });
  }
  kill(playerId = 42, translate = 'death.attack.lava'): void {
    this.client.emit('death_combat_event', { playerId, message: { type: 'compound', value: { translate: { type: 'string', value: translate }, with: { type: 'list', value: { type: 'string', value: ['bot'] } } } } });
  }
  /** A server-announced dropped item entity with its server-stated stack (metadata key 8). */
  spawnItem(entityId: number, s: Slot, at = { x: 0, y: 64, z: 0 }): void {
    this.client.emit('spawn_entity', { entityId, type: ITEM_ENTITY_TYPE, x: at.x, y: at.y, z: at.z });
    this.client.emit('entity_metadata', { entityId, metadata: [{ key: 8, type: 'item_stack', value: s }] });
  }
  /** A server-announced item entity whose stack was never stated. */
  spawnItemWithoutStack(entityId: number, at = { x: 0, y: 64, z: 0 }): void {
    this.client.emit('spawn_entity', { entityId, type: ITEM_ENTITY_TYPE, x: at.x, y: at.y, z: at.z });
  }
  /** Server collect packet (default collector: the bot, entity 42). */
  collect(entityId: number, count: number, collector = 42): void {
    this.client.emit('collect', { collectedEntityId: entityId, collectorEntityId: collector, pickupItemCount: count });
  }
  /** A non-item entity (e.g. an experience orb, type 70 here). */
  spawnOther(entityId: number, at = { x: 0, y: 64, z: 0 }): void {
    this.client.emit('spawn_entity', { entityId, type: 70, x: at.x, y: at.y, z: at.z });
  }
  destroy(...entityIds: number[]): void {
    this.client.emit('entity_destroy', { entityIds });
  }
  respawn(death?: { dimensionName: string; location: { x: number; y: number; z: number } }): void {
    this.client.emit('respawn', { worldState: { name: OW, ...(death ? { death } : {}) }, copyMetadata: 0 });
  }
}

export function snapshot(over: Partial<ObservationSnapshot> & { at?: { x: number; y: number; z: number } } = {}): ObservationSnapshot {
  const { at, ...rest } = over;
  return {
    id: 'snap-1',
    connectionEpoch: 1,
    goalEpoch: 1,
    takenAtMs: NOW0,
    dimension: SESSION_OW,
    self: { at: at ?? { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
    inventory: [],
    equipment: {},
    owner: { visible: false },
    entities: [],
    blocks: [],
    drops: [],
    remembered: [],
    blockSummary: [],
    frontiers: [],
    ...rest,
  } as ObservationSnapshot;
}

const roots: string[] = [];
export function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'chunkbot-survival-'));
  roots.push(r);
  return r;
}
export function cleanupRoots(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export interface FakeMemory {
  factList: MemoryFact[];
  /** C5 durability per fact (default: durable for any linked fact id). */
  durability: Map<string, 'durable' | 'pending' | 'failed' | 'unknown'>;
  factDurability(factId: string): 'durable' | 'pending' | 'failed' | 'unknown';
  updates: Array<{ factId: string; update: unknown; detail: string }>;
  facts(): readonly MemoryFact[];
  updateDeathRecovery(factId: string, update: unknown, evidence: { detail: string }): Promise<{ ok: boolean; detail: string }>;
}

export function fakeMemory(): FakeMemory {
  const m: FakeMemory = {
    factList: [],
    durability: new Map(),
    factDurability: (id) => m.durability.get(id) ?? 'durable',
    updates: [],
    facts: () => m.factList,
    updateDeathRecovery: async (factId, update, evidence) => {
      m.updates.push({ factId, update, detail: evidence.detail });
      return { ok: true, detail: 'ok' };
    },
  };
  return m;
}

export interface Harness {
  service: SurvivalService;
  packets: Packets;
  clock: TestClock;
  root: string;
  memory: FakeMemory;
  events: Array<Record<string, unknown>>;
  pos: { dimension: string; at: { x: number; y: number; z: number } };
  snap: { value: ObservationSnapshot | undefined };
}

export function harness(opts: { config?: SurvivalConfigInput; scoped?: boolean; root?: string; clock?: TestClock; farRoute?: () => string | undefined; pid?: number; connectionEpoch?: number; beforeRename?: (tmp: string) => void | Promise<void>; memory?: FakeMemory; sessionId?: string } = {}): Harness {
  const clock = opts.clock ?? new TestClock();
  const root = opts.root ?? tempRoot();
  const memory = opts.memory ?? fakeMemory();
  const events: Array<Record<string, unknown>> = [];
  const snap: { value: ObservationSnapshot | undefined } = { value: undefined };
  const service = new SurvivalService({
    config: SurvivalConfigSchema.parse(opts.config ?? {}),
    scope: opts.scoped === false ? undefined : { worldProfile: 'test-world', worldRevision: 1, botProfile: 'chunkbot' },
    rootDir: opts.scoped === false ? undefined : root,
    registry,
    now: clock.now,
    limits: { lowHealth: 8, travelRadius: 128 },
    record: (e) => events.push(e),
    memory,
    latestSnapshot: () => snap.value,
    ...(opts.farRoute ? { farRoute: opts.farRoute } : {}),
    store: { pid: opts.pid ?? 4242, isAlive: () => false, ...(opts.beforeRename ? { beforeRename: opts.beforeRename } : {}) },
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  service.open();
  const packets = new Packets();
  const pos = { dimension: SESSION_OW, at: { x: 0, y: 64, z: 0 } };
  service.attachConnection(packets.client, { connectionEpoch: opts.connectionEpoch ?? 1, selfPosition: () => ({ dimension: pos.dimension, at: { ...pos.at } }) });
  service.onLifecycle({ type: 'ready', connectionEpoch: opts.connectionEpoch ?? 1, info: { serverVersion: '26.1.2', protocolVersion: 775, dimension: SESSION_OW, position: pos.at, gameMode: 'survival', serverOnlineMode: false } });
  packets.login();
  return { service, packets, clock, root, memory, events, pos, snap };
}

export function assessInput(h: Harness, over: Partial<Parameters<SurvivalService['assess']>[0]> = {}): Parameters<SurvivalService['assess']>[0] {
  return {
    nowMs: h.clock.now(),
    connection: { ready: true, connectionEpoch: 1, dimension: SESSION_OW },
    snapshot: h.snap.value ?? snapshot({ at: h.pos.at }),
    autonomyAllowed: true,
    active: { kind: 'none' },
    ownerIntakePending: false,
    ownerIntentInterrupted: false,
    goalLimits: { plannerTurns: 20, tasks: 64, replans: 8, deadlineMs: 20 * 60_000 },
    ...over,
  };
}

/** Death with a kill packet first, clearing slot packets next, then zero health (hypothesized vanilla order). */
export function dieWithItems(h: Harness, stacks: Record<number, Slot>, translate = 'death.attack.mob'): void {
  h.packets.kill(42, translate);
  for (const k of Object.keys(stacks)) h.packets.setSlot(Number(k), empty);
  h.packets.health(0, 20);
  h.service.onLifecycle({ type: 'death', connectionEpoch: 1 });
}

export function respawnFresh(h: Harness, stacks: Record<number, Slot> = {}, death?: { dimensionName: string; location: { x: number; y: number; z: number } }): void {
  h.packets.respawn(death);
  h.service.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: SESSION_OW });
  h.packets.inventory(stacks);
  h.packets.health(20, 20);
}

const NOW = NOW0;
export function sampleEpisode(over: Partial<RecoveryEpisode> = {}): RecoveryEpisode {
  return {
    episodeId: 'rep-0001',
    incidentFactId: 'mf-0001',
    originalIncidentFactId: 'mf-0001',
    relatedIncidentFactIds: [],
    openedAtMs: NOW,
    updatedAtMs: NOW,
    occurredAtMs: NOW,
    phase: 'awaiting_respawn',
    status: 'pending',
    site: { source: 'client_position_at_death_event', dimension: 'minecraft:overworld', at: { x: 1, y: 64, z: 2 }, observedAtMs: NOW },
    cause: { kind: 'unknown', hazard: 'unknown' },
    lastAlive: { source: 'server_packets', frozenAt: 'combat_kill_packet', capturedAtMs: NOW, ageMsAtDeath: 5, stacks: [], clearingPacketsAfterFreeze: 0 },
    regained: [],
    incidental: [],
    attempts: [],
    maxAttempts: 2,
    budget: { plannerTurns: 0, tasks: 0, replans: 0, admissions: 0, activeMs: 0 },
    hazards: [],
    detail: '',
    ...over,
  };
}


/** Waits until every queued survival write settled (durability bookkeeping included). */
export async function settle(h: Harness): Promise<void> {
  await h.service.flush();
}
