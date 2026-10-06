// Test doubles for the skill layer: a voxel WorldView and a minimal fake game
// session whose client records written packets. Never wired into the real CLI.
import { EventEmitter } from 'node:events';
import type { BlockView, WorldView } from '../src/perception/visibility.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';

const FULL = [[0, 0, 0, 1, 1, 1]];

export class FakeWorld implements WorldView {
  private readonly blocks = new Map<string, BlockView>();
  /** Columns outside this x/z box are "unloaded". */
  private readonly bounds: { min: number; max: number };
  constructor(bounds = { min: -64, max: 64 }) {
    this.bounds = bounds;
  }
  set(x: number, y: number, z: number, name: string, shapes: number[][] = FULL): this {
    this.blocks.set(`${x},${y},${z}`, { name, stateId: this.blocks.size + 1, shapes });
    return this;
  }
  /** A fluid voxel: no collision shapes, with the installed fluid level (0 = source). */
  setFluid(x: number, y: number, z: number, name: string, level = 0): this {
    this.blocks.set(`${x},${y},${z}`, { name, stateId: this.blocks.size + 1, shapes: [], level });
    return this;
  }
  fill(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, name: string, shapes: number[][] = FULL): this {
    for (let x = x1; x <= x2; x += 1) for (let y = y1; y <= y2; y += 1) for (let z = z1; z <= z2; z += 1) this.set(x, y, z, name, shapes);
    return this;
  }
  blockAt(x: number, y: number, z: number): BlockView | null {
    if (x < this.bounds.min || x > this.bounds.max || z < this.bounds.min || z > this.bounds.max) return null;
    return this.blocks.get(`${x},${y},${z}`) ?? { name: 'air', stateId: 0, shapes: [] };
  }
}

/** A flat world: grass floor at y = -1 across the loaded bounds. */
export function flatWorld(size = 40): FakeWorld {
  const w = new FakeWorld({ min: -size, max: size });
  w.fill(-size, -1, -size, size, -1, size, 'grass_block');
  return w;
}

export interface FakeClient extends EventEmitter {
  written: Array<{ name: string; data: Record<string, unknown>; atMs: number }>;
  write(name: string, data: Record<string, unknown>): void;
}

export function fakeClient(onWrite?: (name: string, data: Record<string, unknown>) => void): FakeClient {
  const client = new EventEmitter() as FakeClient;
  client.written = [];
  client.write = (name, data) => {
    client.written.push({ name, data, atMs: Date.now() });
    onWrite?.(name, data);
  };
  return client;
}

/**
 * Server ordering used by vanilla: packets are processed in order and a
 * sequenced player action (block_dig / block_place carrying `sequence`) is
 * acknowledged after everything sent before it was processed. Call from a
 * fakeClient write hook AFTER emitting any reply to earlier packets.
 */
export function ackSequenced(client: EventEmitter, name: string, data: Record<string, unknown>): void {
  if ((name === 'block_dig' || name === 'block_place') && typeof data['sequence'] === 'number') {
    const sequenceId = data['sequence'];
    setImmediate(() => client.emit('acknowledge_player_digging', { sequenceId }));
  }
}

export const REGISTRY = {
  items: { 1: { name: 'oak_log' }, 2: { name: 'cobblestone' }, 3: { name: 'stick' } } as Record<number, { name: string } | undefined>,
  entitiesByName: { item: { id: 71 } } as Record<string, { id: number } | undefined>,
};

export function evidenceFor(client: EventEmitter): ServerEvidence {
  const ev = new ServerEvidence(client, REGISTRY);
  ev.attach();
  return ev;
}

// ---------------------------------------------------------------------------
// A Mineflayer-shaped bot over the INSTALLED 26.1.2 registry and block shapes
// (prismarine-block), so the real PerceptionService, resolvers, candidate
// generator and predicate engine run unmodified. Blocks default to air; the
// x/z box outside `loaded` is unloaded. Not wired into the real CLI.
import { createRequire as createRequireForBot } from 'node:module';

const botRequire = createRequireForBot(import.meta.url);
const { Vec3: BotVec3 } = botRequire('vec3') as { Vec3: new (x: number, y: number, z: number) => { x: number; y: number; z: number; distanceTo(o: unknown): number; clone(): unknown; offset(x: number, y: number, z: number): unknown } };
export const REGISTRY_26_1_2 = botRequire('prismarine-registry')('26.1.2') as {
  blocksByName: Record<string, { id: number; defaultState: number; minStateId: number } | undefined>;
  itemsByName: Record<string, { id: number } | undefined>;
  items: Record<number, { name: string } | undefined>;
  entitiesByName: Record<string, { id: number } | undefined>;
};
const BlockCtor = botRequire('prismarine-block')(REGISTRY_26_1_2) as { fromStateId(id: number, biome: number): { name: string; position: unknown } };

export function vec3(x: number, y: number, z: number) {
  return new BotVec3(x, y, z);
}

export interface FakeEntity {
  id: number;
  type: string;
  name: string;
  username?: string;
  uuid?: string;
  position: ReturnType<typeof vec3>;
  height: number;
}

export interface FakeBotOptions {
  loaded?: number;
  dimension?: string;
  username?: string;
  at?: { x: number; y: number; z: number };
}

export function fakeMineflayerBot(client: FakeClient, options: FakeBotOptions = {}) {
  const loaded = options.loaded ?? 48;
  const states = new Map<string, number>();
  const stateOf = (name: string) => {
    const b = REGISTRY_26_1_2.blocksByName[name];
    if (!b) throw new Error(`unknown block ${name}`);
    return b.defaultState;
  };
  const world = {
    getColumnAt: (p: { x: number; z: number }) => (Math.abs(p.x) <= loaded && Math.abs(p.z) <= loaded ? {} : null),
    getBlockStateId: (p: { x: number; y: number; z: number }) => states.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? 0,
  };
  const slots: Array<{ name: string; count: number; type: number; slot: number } | null> = new Array(46).fill(null);
  const at = options.at ?? { x: 0.5, y: 0, z: 0.5 };
  const events = new EventEmitter();
  const bot = {
    on: (name: string, fn: (...a: unknown[]) => void) => events.on(name, fn),
    off: (name: string, fn: (...a: unknown[]) => void) => events.off(name, fn),
    emit: (name: string, ...a: unknown[]) => events.emit(name, ...a),
    _client: client,
    registry: REGISTRY_26_1_2,
    username: options.username ?? 'Chunkbot',
    players: {} as Record<string, { uuid: string } | undefined>,
    game: { dimension: options.dimension ?? 'minecraft:overworld', minY: -64, height: 384 },
    world,
    entity: { id: 1, type: 'player', name: 'player', position: vec3(at.x, at.y, at.z), height: 1.8, eyeHeight: 1.62, velocity: vec3(0, 0, 0) } as unknown as FakeEntity & { eyeHeight: number },
    entities: {} as Record<number, FakeEntity>,
    inventory: {
      id: 0,
      slots,
      selectedItem: null,
      inventoryStart: 9,
      inventoryEnd: 45,
      items: () => slots.slice(9, 45).filter((s): s is NonNullable<typeof s> => s !== null),
    },
    quickBarSlot: 0,
    get heldItem() {
      return slots[36 + this.quickBarSlot] ?? null;
    },
    currentWindow: null as unknown,
    health: 20,
    food: 20,
    blockAt(p: { x: number; y: number; z: number }) {
      if (!world.getColumnAt(p)) return null;
      const b = BlockCtor.fromStateId(world.getBlockStateId(p), 0);
      (b as { position: unknown }).position = vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return b;
    },
  };
  bot.entities[1] = bot.entity;
  return {
    bot,
    setBlock(x: number, y: number, z: number, name: string) {
      if (name === 'air') states.delete(`${x},${y},${z}`);
      else states.set(`${x},${y},${z}`, stateOf(name));
    },
    fill(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, name: string) {
      for (let x = x1; x <= x2; x += 1) for (let y = y1; y <= y2; y += 1) for (let z = z1; z <= z2; z += 1) this.setBlock(x, y, z, name);
    },
    give(slot: number, name: string, count: number) {
      const type = REGISTRY_26_1_2.itemsByName[name]?.id ?? 0;
      slots[slot] = { name, count, type, slot };
    },
    addEntity(e: Omit<FakeEntity, 'position'> & { at: { x: number; y: number; z: number } }) {
      const { at: p, ...rest } = e;
      const entity: FakeEntity = { ...rest, position: vec3(p.x, p.y, p.z) };
      bot.entities[e.id] = entity;
      if (e.username && e.uuid) bot.players[e.username] = { uuid: e.uuid };
      return entity;
    },
  };
}
