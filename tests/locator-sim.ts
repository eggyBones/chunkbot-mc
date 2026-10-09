// Shared locator test simulator (MB-LOC-001/002; not a test file itself).
//
// A scripted world and a simulated server that emits tracked_waypoint
// statements by the OFFICIAL variant rules (static 26.x source: block precision
// while the owner's chunk is in view distance, chunk precision beyond it,
// azimuth beyond 332 blocks; untrack when hidden). Real LocatorService and
// RouteController; movement is a scripted walker that only steps on standable,
// non-hazard cells inside the bound it is given (no digging/placing/towering).
//
// The azimuth the simulated server sends is the official convention recorded in
// docs/reviews/mb-loc-001-locator.md (atan2(dx, -dz) with d = receiver - source);
// the production decoder is independent of this file.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DEFAULT_LOCATOR_CONFIG, RoutePolicySchema, type LocatorConfig, type RouteAdmissionProof, type RouteDestinationProvider, type RoutePolicy } from '../src/contracts/locator.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { isStandable } from '../src/perception/frontiers.ts';
import type { BlockView, RayHit, Vec, WorldView } from '../src/perception/visibility.ts';
import { runRoute, type MoveOptions, type MoveResult, type RouteEnv, type RouteRunResult, type RouteTarget } from '../src/locator/route-runner.ts';
import { RouteController } from '../src/locator/routes.ts';
import { LocatorService } from '../src/locator/service.ts';

export const OWNER = 'OwnerPlayer';
export const OWNER_UUID = offlinePlayerUuid(OWNER);
export const FULL = [[0, 0, 0, 1, 1, 1]];
export const AIR: BlockView = { name: 'air', stateId: 0, shapes: [] };
export const DIM = 'minecraft:overworld';
/** Loaded square half-size of the procedural world (blocks). */
export const WORLD_HALF = 3_000;

export type Feature = (x: number, y: number, z: number) => BlockView | undefined;

/** Procedural terrain: grass floor at y=63 (stand at y=64) plus overrides. */
export class ProcWorld implements WorldView {
  readonly features: Feature[] = [];
  floorAt: (x: number, z: number) => number | null = () => 63;
  blockAt(x: number, y: number, z: number): BlockView | null {
    if (Math.abs(x) > WORLD_HALF || Math.abs(z) > WORLD_HALF) return null;
    for (const f of this.features) {
      const b = f(x, y, z);
      if (b) return b;
    }
    const floor = this.floorAt(x, z);
    if (floor !== null && y === floor) return { name: 'grass_block', stateId: 1, shapes: FULL };
    if (floor !== null && y < floor && y > floor - 3) return { name: 'dirt', stateId: 2, shapes: FULL };
    return AIR;
  }
}

export interface Sim {
  env: RouteEnv;
  routes: RouteController;
  locator: LocatorService;
  world: ProcWorld;
  self: Vec;
  start: Vec;
  bot: { entity: { position: Vec; yaw: number; pitch: number }; game: { dimension: string }; players: Record<string, { uuid: string; username: string }>; _client: EventEmitter };
  client: EventEmitter;
  owner: { at: Vec; hidden: boolean };
  clock: { t: number; now(): number };
  moves: number;
  /** Every move target issued by the runner, in order. */
  targets: Vec[];
  steps: Vec[];
  serverEmit(): void;
  sleeps: { count: number; revokeAfter?: number };
  proofOverride: { value: RouteAdmissionProof | undefined };
}

export interface SimOptions {
  ownerAt: Vec;
  /** Bot start (feet). Default (0.5, 64, 0.5). Also the admission anchor. */
  start?: Vec;
  /** Bot yaw (radians); the locator and runner must never depend on it. */
  yaw?: number;
  policy?: Partial<RoutePolicy>;
  routes?: boolean;
  viewDistanceChunks?: number;
  obstacles?: (w: ProcWorld) => void;
  ownerCoordinates?: Vec[];
  ownDeath?: RouteDestinationProvider;
  /** false: the simulated server never sends owner statements (raw packets can still be injected). */
  emitOwner?: boolean;
  locatorConfig?: LocatorConfig;
}

export function sim(options: SimOptions): Sim {
  const world = new ProcWorld();
  options.obstacles?.(world);
  const start: Vec = { ...(options.start ?? { x: 0.5, y: 64, z: 0.5 }) };
  const self: Vec = { ...start };
  const owner = { at: { ...options.ownerAt }, hidden: false };
  const clock = { t: 1_000_000, now() { return this.t; } };
  const client = new EventEmitter();
  const bot = { entity: { position: self, yaw: options.yaw ?? 0, pitch: 0 }, game: { dimension: DIM }, players: { [OWNER]: { uuid: OWNER_UUID, username: OWNER } }, _client: client };
  const session = { bot, connectionEpoch: 1, evidence: {} } as unknown as GameSession;
  const locator = new LocatorService({ config: options.locatorConfig ?? DEFAULT_LOCATOR_CONFIG, version: '26.2', ownerPolicy: { mode: 'offline_name', ownerName: OWNER }, admission: () => ({ serverOnlineMode: false }), session: () => session, clock });
  locator.attach(client, 1);
  client.emit('login', {});
  const routes = new RouteController({ policy: RoutePolicySchema.parse(options.policy ?? {}), clock, ...(options.ownDeath ? { ownDeath: options.ownDeath } : {}) });
  if (options.routes !== false) {
    routes.admit({ goalId: 'goal-0001', goalEpoch: 1, admittedAtMs: clock.t, source: 'owner', goalDeadlineMs: clock.t + 3_600_000, connectionEpoch: 1, dimension: DIM, admissionAnchor: { ...start }, admissionRadius: 128, ownerCoordinates: (options.ownerCoordinates ?? []).map((c) => ({ ...c, source: 'instruction' as const })) });
  }
  // Simulated server: official variant selection and change-driven updates.
  let last = '';
  const view = (options.viewDistanceChunks ?? 10) * 16;
  const serverEmit = () => {
    if (options.emitOwner === false) return;
    if (owner.hidden) {
      if (last !== 'untrack') client.emit('tracked_waypoint', { operation: 'untrack', waypoint: { hasUUID: true, uuid: OWNER_UUID, icon: { style: 'minecraft:default' }, type: 'empty' } });
      last = 'untrack';
      return;
    }
    const dx = self.x - owner.at.x;
    const dz = self.z - owner.at.z;
    const d = Math.hypot(dx, owner.at.y - self.y, dz);
    let w: Record<string, unknown>;
    if (d > 332) w = { type: 'azimuth', data: Math.atan2(dx, -dz) };
    else if (Math.abs(Math.floor(owner.at.x / 16) - Math.floor(self.x / 16)) * 16 > view || Math.abs(Math.floor(owner.at.z / 16) - Math.floor(self.z / 16)) * 16 > view) w = { type: 'chunk', data: { chunkX: Math.floor(owner.at.x / 16), chunkZ: Math.floor(owner.at.z / 16) } };
    else w = { type: 'vec3i', data: { x: Math.floor(owner.at.x), y: Math.floor(owner.at.y), z: Math.floor(owner.at.z) } };
    const key = JSON.stringify(w);
    if (key === last) return;
    client.emit('tracked_waypoint', { operation: last === '' || last === 'untrack' ? 'track' : 'update', waypoint: { hasUUID: true, uuid: OWNER_UUID, icon: { style: 'minecraft:default' }, ...w } });
    last = key;
  };
  const proofOverride: { value: RouteAdmissionProof | undefined } = { value: undefined };
  const state = { moves: 0, targets: [] as Vec[], steps: [] as Vec[], sleeps: { count: 0 } as { count: number; revokeAfter?: number } };
  // Visible faces: non-air voxels with an air neighbour (no occlusion model) within radius.
  const seen = (): Map<string, RayHit> => {
    const out = new Map<string, RayHit>();
    const r = 24;
    const air = (x: number, y: number, z: number) => world.blockAt(x, y, z)?.name === 'air';
    for (let x = Math.floor(self.x) - r; x <= Math.floor(self.x) + r; x += 1) {
      for (let z = Math.floor(self.z) - r; z <= Math.floor(self.z) + r; z += 1) {
        if (Math.hypot(x - self.x, z - self.z) > r) continue;
        for (let y = Math.floor(self.y) - 12; y <= Math.floor(self.y) + 8; y += 1) {
          const b = world.blockAt(x, y, z);
          if (!b || b.name === 'air') continue;
          if (air(x, y + 1, z) || air(x + 1, y, z) || air(x - 1, y, z) || air(x, y, z + 1) || air(x, y, z - 1)) out.set(`${x},${y},${z}`, { x, y, z, block: b });
        }
      }
    }
    return out;
  };
  const env: RouteEnv = {
    goalEpoch: 1,
    connectionEpoch: () => 1,
    dimension: () => DIM,
    self: () => ({ ...self }),
    now: () => clock.now(),
    sleep: async () => {
      state.sleeps.count += 1;
      if (state.sleeps.revokeAfter !== undefined && state.sleeps.count > state.sleeps.revokeAfter) throw new Error('lease revoked');
    },
    observe: () => ({ seen: seen() }),
    world: () => world,
    visited: () => state.steps.slice(-64),
    recordVisited: () => state.steps.push({ ...self }),
    ownerVisible: () => (!owner.hidden && Math.hypot(owner.at.x - self.x, owner.at.z - self.z) <= 24 ? { ...owner.at } : undefined),
    admissionBounds: () => (proofOverride.value ?? { goalEpoch: 1, connectionEpoch: 1, dimension: DIM, anchor: { ...start }, radius: 128 }),
    move: async (target: Vec, within: number, bounds, opts: MoveOptions): Promise<MoveResult> => {
      state.moves += 1;
      state.targets.push({ ...target });
      let goal = target;
      let path = findPath(world, self, goal, within, bounds);
      for (let i = 0; i < 600; i += 1) {
        clock.t += 250;
        serverEmit();
        const abort = opts.abortIf?.();
        if (abort) return { status: 'stuck', aborted: abort, finalDistance: Math.hypot(goal.x - self.x, goal.z - self.z) };
        const next = opts.retarget?.();
        if (next) {
          goal = next;
          path = findPath(world, self, goal, within, bounds);
        }
        const d = Math.hypot(goal.x - self.x, goal.z - self.z);
        if (d <= within + 0.25) return { status: 'arrived', finalDistance: d };
        if (!path) return { status: 'no_path', finalDistance: d };
        const step = path.cells.shift();
        if (!step) return { status: path.outOfBounds ? 'out_of_bounds' : 'no_path', finalDistance: d };
        self.x = step.x;
        self.z = step.z;
        self.y = step.y;
      }
      return { status: 'timeout', finalDistance: Math.hypot(goal.x - self.x, goal.z - self.z) };
    },
    progress: () => undefined,
    observationRadius: 32,
    ownerLossMs: 10_000,
  };
  serverEmit();
  return Object.defineProperties({ env, routes, locator, world, self, start, bot, client, owner, clock, serverEmit, sleeps: state.sleeps, proofOverride } as unknown as Sim, {
    moves: { get: () => state.moves },
    targets: { get: () => state.targets },
    steps: { get: () => state.steps },
  });
}

/** Conservative cell moves: walk, step up 1 (head room), drop at most 3; standable non-hazard cells only. */
function nextY(world: WorldView, cx: number, cz: number, y: number): number | undefined {
  if (isStandable(world, cx, y, cz)) return y;
  if (isStandable(world, cx, y + 1, cz)) return y + 1;
  for (let drop = 1; drop <= 3; drop += 1) if (isStandable(world, cx, y - drop, cz)) return y - drop;
  return undefined;
}

/**
 * A small conservative pathfinder for the simulated walker (BFS over standable
 * cells, 8 directions without corner cutting, horizontal search radius 96).
 * Inside the bound when possible; if the goal is reachable only by leaving the
 * bound, the path stops at the bound edge and reports outOfBounds (like the
 * bounded production pathfinder stopping at the travel bound).
 */
function findPath(world: WorldView, from: Vec, goal: Vec, within: number, bounds: { anchor: Vec; radius: number }): { cells: Vec[]; outOfBounds: boolean } | undefined {
  const inB = (x: number, z: number) => Math.hypot(x + 0.5 - bounds.anchor.x, z + 0.5 - bounds.anchor.z) <= bounds.radius;
  const search = (bounded: boolean): Vec[] | undefined => {
    const sx = Math.floor(from.x);
    const sz = Math.floor(from.z);
    const sy = Math.floor(from.y);
    const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
    const prev = new Map<string, string | null>([[key(sx, sy, sz), null]]);
    const queue: Array<[number, number, number]> = [[sx, sy, sz]];
    let found: string | undefined;
    for (let n = 0; queue.length > 0 && n < 60_000; n += 1) {
      const [x, y, z] = queue.shift()!;
      if (Math.hypot(x + 0.5 - goal.x, z + 0.5 - goal.z) <= within + 0.25 && Math.abs(y - goal.y) <= 3) {
        found = key(x, y, z);
        break;
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const cx = x + dx;
        const cz = z + dz;
        if (Math.hypot(cx - sx, cz - sz) > 96) continue;
        if (bounded && !inB(cx, cz)) continue;
        if (dx !== 0 && dz !== 0 && (nextY(world, x + dx, z, y) === undefined || nextY(world, x, z + dz, y) === undefined)) continue;
        const ny = nextY(world, cx, cz, y);
        if (ny === undefined) continue;
        const k = key(cx, ny, cz);
        if (prev.has(k)) continue;
        prev.set(k, key(x, y, z));
        queue.push([cx, ny, cz]);
      }
    }
    if (!found) return undefined;
    const cells: Vec[] = [];
    for (let k: string | null | undefined = found; k; k = prev.get(k)) {
      const [x, y, z] = k.split(',').map(Number) as [number, number, number];
      cells.unshift({ x: x + 0.5, y, z: z + 0.5 });
    }
    cells.shift(); // the start cell
    return cells;
  };
  const bounded = search(true);
  if (bounded) return { cells: bounded, outOfBounds: false };
  const free = search(false);
  if (!free) return undefined;
  const cells: Vec[] = [];
  for (const c of free) {
    if (!inB(Math.floor(c.x), Math.floor(c.z))) break;
    cells.push(c);
  }
  return { cells, outOfBounds: true };
}

/** Repeats execution windows like the task runtime's sustained continuation (bounded). */
export async function runWindows(s: Sim, target: RouteTarget = { kind: 'owner' }, windows = 12): Promise<RouteRunResult[]> {
  const out: RouteRunResult[] = [];
  for (let i = 0; i < windows; i += 1) {
    const r = await runRoute(s.env, target, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator });
    out.push(r);
    if (!(r.status === 'partial' && r.reason === 'route_window_elapsed')) break;
  }
  return out;
}

export function assertNoCoordinates(value: unknown, forbidden: number[]): void {
  const text = JSON.stringify(value);
  for (const n of forbidden) assert.ok(!new RegExp(`(?<![0-9.])${String(n).replace('-', '\\-')}(?![0-9])`).test(text), `exact coordinate ${n} leaked`);
}
