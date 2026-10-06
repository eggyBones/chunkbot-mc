// Test doubles for MB-MEM-001: a temp-dir MemoryService and a scripted
// read-only MemoryWorld. Never wired into the real CLI.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObservationSnapshot, SkillOutcome } from '../src/contracts/index.ts';
import { MemoryConfigSchema, type MemoryConfigInput, type MemorySubject } from '../src/contracts/memory.ts';
import { MemoryService, type MemoryServiceOptions } from '../src/memory/service.ts';
import type { ActionEvidence, DeathContext, MemoryWorld } from '../src/memory/world.ts';

export const OVERWORLD = 'minecraft:overworld';
export const NETHER = 'minecraft:the_nether';

export class Clock {
  t = 1_700_000_000_000;
  now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface WorldState {
  conn: { connectionEpoch: number; dimension: string } | undefined;
  snap: ObservationSnapshot | undefined;
  voxels: Map<string, string>;
  evidence: Map<string, ActionEvidence>;
  death: DeathContext;
}

export function fakeWorld(state: WorldState): MemoryWorld {
  return {
    connection: () => state.conn,
    latestSnapshot: () => state.snap,
    observeVoxel: (x, y, z) => state.voxels.get(`${x},${y},${z}`),
    observationRadius: () => 32,
    actionEvidence: (id) => state.evidence.get(id) ?? { blockChanges: [], containers: [] },
    deathContext: () => state.death,
  };
}

const roots: string[] = [];
export function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'chunkbot-mem-'));
  roots.push(r);
  return r;
}
export function cleanupRoots(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

let pid = 90_000;
export interface Harness {
  memory: MemoryService;
  world: WorldState;
  clock: Clock;
  root: string;
  events: Array<Record<string, unknown>>;
  /** Reopen as a fresh process (same root), e.g. after an app restart. */
  restart(config?: Partial<MemoryConfigInput>): Promise<Harness>;
}

export function harness(opts: { root?: string; config?: Partial<MemoryConfigInput>; endpoint?: string; clock?: Clock; world?: WorldState; service?: Partial<MemoryServiceOptions> } = {}): Harness {
  const root = opts.root ?? tempRoot();
  const clock = opts.clock ?? new Clock();
  const config = MemoryConfigSchema.parse({ worldProfile: 'fixture-world', worldRevision: 1, botProfile: 'chunkbot', ...(opts.config ?? {}) });
  const events: Array<Record<string, unknown>> = [];
  const world: WorldState = opts.world ?? { conn: { connectionEpoch: 1, dimension: OVERWORLD }, snap: undefined, voxels: new Map(), evidence: new Map(), death: { accuracy: 'unknown', inventory: { source: 'unavailable', items: [] } } };
  const memory = new MemoryService({
    config,
    rootDir: root,
    endpoint: opts.endpoint ?? '127.0.0.1:25566',
    clock,
    record: (e) => events.push(e as Record<string, unknown>),
    observationPersistMs: 5,
    store: { pid: (pid += 1), isAlive: () => false },
    ...(opts.service ?? {}),
  });
  memory.open();
  memory.attachWorld(fakeWorld(world));
  const h: Harness = {
    memory,
    world,
    clock,
    root,
    events,
    async restart(config) {
      await memory.close();
      const fresh: WorldState = { conn: world.conn ? { connectionEpoch: world.conn.connectionEpoch + 1, dimension: world.conn.dimension } : undefined, snap: undefined, voxels: new Map(), evidence: new Map(), death: world.death };
      return harness({ root, clock, world: fresh, ...(opts.endpoint ? { endpoint: opts.endpoint } : {}), config: { ...(opts.config ?? {}), ...(config ?? {}) } });
    },
  };
  return h;
}

export const goal = (goalId: string, goalEpoch: number): MemorySubject => ({ kind: 'goal', goalId, goalEpoch });

export function viewFor(h: Harness, subject: MemorySubject, instruction: string, requestId = 'req-0001', at = { x: 0, y: 64, z: 0 }) {
  const conn = h.world.conn;
  return h.memory.view({ subject, requestId, instruction, observation: conn ? { dimension: conn.dimension, self: { at }, connectionEpoch: conn.connectionEpoch } : null });
}

export function snapshot(id: string, conn: { connectionEpoch: number; dimension: string }, blocks: Array<{ key: string; at: { x: number; y: number; z: number }; distance?: number }>, self = { x: 0, y: 64, z: 0 }): ObservationSnapshot {
  return {
    id,
    connectionEpoch: conn.connectionEpoch,
    goalEpoch: 1,
    takenAtMs: 0,
    dimension: conn.dimension,
    self: { at: self, health: 20, food: 20 },
    inventory: [],
    equipment: {},
    owner: { visible: false },
    entities: [],
    blocks: blocks.map((b, i) => ({ handle: `blk-${i + 1}`, key: b.key, at: b.at, distance: b.distance ?? 5 })),
    drops: [],
    remembered: [],
    blockSummary: [],
    frontiers: [],
  };
}

let act = 0;
export function outcome(partial: Partial<SkillOutcome> & { capability: string }): SkillOutcome {
  act += 1;
  return {
    actionId: `act-${String(act).padStart(4, '0')}`,
    owner: 'goal',
    connectionEpoch: 1,
    goalEpoch: 1,
    status: 'succeeded',
    elapsedMs: 10,
    effect: 'test',
    confirmation: 'server_packet',
    evidence: {},
    ...partial,
  };
}
