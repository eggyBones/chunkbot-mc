// MB-LOC-001 L3/L4/L5/L6: the route runner over a scripted world and a
// simulated server that emits tracked_waypoint statements by the OFFICIAL
// variant rules (static 26.x source: block precision while the owner's chunk is
// in view distance, chunk precision beyond it, azimuth beyond 332 blocks;
// untrack when hidden). Real LocatorService and RouteController; movement is a
// scripted walker that only steps on standable, non-hazard cells inside the
// bound it is given (no digging/placing/towering is possible).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { DEFAULT_LOCATOR_CONFIG, RoutePolicySchema, type RouteAdmissionProof, type RouteDestinationProvider, type RoutePolicy } from '../src/contracts/locator.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { isStandable } from '../src/perception/frontiers.ts';
import type { BlockView, RayHit, Vec, WorldView } from '../src/perception/visibility.ts';
import { runRoute, type MoveOptions, type MoveResult, type RouteEnv, type RouteRunResult, type RouteTarget } from '../src/locator/route-runner.ts';
import { RouteController } from '../src/locator/routes.ts';
import { LocatorService } from '../src/locator/service.ts';

const OWNER = 'OwnerPlayer';
const OWNER_UUID = offlinePlayerUuid(OWNER);
const FULL = [[0, 0, 0, 1, 1, 1]];
const AIR: BlockView = { name: 'air', stateId: 0, shapes: [] };
const DIM = 'minecraft:overworld';

type Feature = (x: number, y: number, z: number) => BlockView | undefined;

/** Procedural terrain: grass floor at y=63 (stand at y=64) plus overrides. */
class ProcWorld implements WorldView {
  readonly features: Feature[] = [];
  floorAt: (x: number, z: number) => number | null = () => 63;
  blockAt(x: number, y: number, z: number): BlockView | null {
    if (Math.abs(x) > 2_000 || Math.abs(z) > 2_000) return null;
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

interface Sim {
  env: RouteEnv;
  routes: RouteController;
  locator: LocatorService;
  world: ProcWorld;
  self: Vec;
  owner: { at: Vec; hidden: boolean };
  clock: { t: number; now(): number };
  moves: number;
  steps: Vec[];
  serverEmit(): void;
  sleeps: { count: number; revokeAfter?: number };
  proofOverride: { value: RouteAdmissionProof | undefined };
}

function sim(options: { ownerAt: Vec; policy?: Partial<RoutePolicy>; routes?: boolean; viewDistanceChunks?: number; obstacles?: (w: ProcWorld) => void; ownerCoordinates?: Vec[]; ownDeath?: RouteDestinationProvider } ): Sim {
  const world = new ProcWorld();
  options.obstacles?.(world);
  const self: Vec = { x: 0.5, y: 64, z: 0.5 };
  const owner = { at: { ...options.ownerAt }, hidden: false };
  const clock = { t: 1_000_000, now() { return this.t; } };
  const client = new EventEmitter();
  const bot = { entity: { position: self }, game: { dimension: DIM }, players: { [OWNER]: { uuid: OWNER_UUID, username: OWNER } }, _client: client };
  const session = { bot, connectionEpoch: 1, evidence: {} } as unknown as GameSession;
  const locator = new LocatorService({ config: DEFAULT_LOCATOR_CONFIG, version: '26.2', ownerPolicy: { mode: 'offline_name', ownerName: OWNER }, admission: () => ({ serverOnlineMode: false }), session: () => session, clock });
  locator.attach(client, 1);
  client.emit('login', {});
  const routes = new RouteController({ policy: RoutePolicySchema.parse(options.policy ?? {}), clock, ...(options.ownDeath ? { ownDeath: options.ownDeath } : {}) });
  if (options.routes !== false) {
    routes.admit({ goalId: 'goal-0001', goalEpoch: 1, admittedAtMs: clock.t, source: 'owner', goalDeadlineMs: clock.t + 3_600_000, connectionEpoch: 1, dimension: DIM, admissionAnchor: { ...self }, admissionRadius: 128, ownerCoordinates: (options.ownerCoordinates ?? []).map((c) => ({ ...c, source: 'instruction' as const })) });
  }
  // Simulated server: official variant selection and change-driven updates.
  let last = '';
  const view = (options.viewDistanceChunks ?? 10) * 16;
  const serverEmit = () => {
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
  const state = { moves: 0, steps: [] as Vec[], sleeps: { count: 0 } as { count: number; revokeAfter?: number } };
  const seen = (): Map<string, RayHit> => {
    const out = new Map<string, RayHit>();
    const r = 24;
    for (let x = Math.floor(self.x) - r; x <= Math.floor(self.x) + r; x += 1) {
      for (let z = Math.floor(self.z) - r; z <= Math.floor(self.z) + r; z += 1) {
        if (Math.hypot(x - self.x, z - self.z) > r) continue;
        for (let y = Math.floor(self.y) - 6; y <= Math.floor(self.y) + 6; y += 1) {
          const b = world.blockAt(x, y, z);
          if (b && b.name !== 'air' && (b.shapes.length > 0 || b.name === 'lava' || b.name === 'water') && world.blockAt(x, y + 1, z)?.name === 'air') out.set(`${x},${y},${z}`, { x, y, z, block: b });
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
    admissionBounds: () => (proofOverride.value ?? { goalEpoch: 1, connectionEpoch: 1, dimension: DIM, anchor: { x: 0.5, y: 64, z: 0.5 }, radius: 128 }),
    move: async (target: Vec, within: number, bounds, opts: MoveOptions): Promise<MoveResult> => {
      state.moves += 1;
      let goal = target;
      for (let i = 0; i < 400; i += 1) {
        clock.t += 250;
        serverEmit();
        const abort = opts.abortIf?.();
        if (abort) return { status: 'stuck', aborted: abort, finalDistance: Math.hypot(goal.x - self.x, goal.z - self.z) };
        const next = opts.retarget?.();
        if (next) goal = next;
        const d = Math.hypot(goal.x - self.x, goal.z - self.z);
        if (d <= within + 0.25) return { status: 'arrived', finalDistance: d };
        const nx = self.x + ((goal.x - self.x) / d) * Math.min(1, d);
        const nz = self.z + ((goal.z - self.z) / d) * Math.min(1, d);
        if (Math.hypot(nx - bounds.anchor.x, nz - bounds.anchor.z) > bounds.radius) return { status: 'out_of_bounds', finalDistance: d };
        // conservative walker: standable, non-hazard cell; step up 1 / drop <= 3
        const cx = Math.floor(nx);
        const cz = Math.floor(nz);
        let ny: number | undefined;
        for (const y of [Math.floor(self.y), Math.floor(self.y) + 1, Math.floor(self.y) - 1, Math.floor(self.y) - 2, Math.floor(self.y) - 3]) {
          if (isStandable(world, cx, y, cz)) {
            ny = y;
            break;
          }
        }
        if (ny === undefined) return { status: 'no_path', finalDistance: d };
        self.x = nx;
        self.z = nz;
        self.y = ny;
      }
      return { status: 'timeout', finalDistance: Math.hypot(goal.x - self.x, goal.z - self.z) };
    },
    progress: () => undefined,
    observationRadius: 32,
    ownerLossMs: 10_000,
  };
  serverEmit();
  return Object.defineProperties({ env, routes, locator, world, self, owner, clock, serverEmit, sleeps: state.sleeps, proofOverride } as unknown as Sim, {
    moves: { get: () => state.moves },
    steps: { get: () => state.steps },
  });
}

/** Repeats execution windows like the task runtime's sustained continuation (bounded). */
async function runWindows(s: Sim, target: RouteTarget = { kind: 'owner' }, windows = 12): Promise<RouteRunResult[]> {
  const out: RouteRunResult[] = [];
  for (let i = 0; i < windows; i += 1) {
    const r = await runRoute(s.env, target, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator });
    out.push(r);
    if (!(r.status === 'partial' && r.reason === 'route_window_elapsed')) break;
  }
  return out;
}

function assertNoCoordinates(value: unknown, forbidden: number[]): void {
  const text = JSON.stringify(value);
  for (const n of forbidden) assert.ok(!new RegExp(`(?<![0-9.])${String(n).replace('-', '\\-')}(?![0-9])`).test(text), `exact coordinate ${n} leaked`);
}

describe('MB-LOC-001 L3 locator-assisted reunion beyond the 128-block admission radius', () => {
  it('follows azimuth -> chunk -> block cues through counted legs, reacquires the VISIBLE owner and verifies proximity', async () => {
    const s = sim({ ownerAt: { x: 437.3, y: 64, z: 61.7 } });
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.status, 'succeeded', JSON.stringify(results.map((r) => [r.status, r.reason, r.effect])));
    assert.equal(last.reason, 'owner_reached');
    assert.ok(Math.hypot(s.owner.at.x - s.self.x, s.owner.at.z - s.self.z) <= 3.25);
    const st = s.routes.status(1)!;
    assert.ok(st.legsUsed >= 3 && st.legsUsed <= st.maxLegs, `legs ${st.legsUsed}`);
    assert.ok(st.distanceUsed > 0 && st.distanceUsed <= st.maxTotalDistance);
    assert.deepEqual(s.routes.legBounds({ goalEpoch: 1, connectionEpoch: 1, dimension: DIM })!.admissionAnchor, { x: 0.5, y: 64, z: 0.5 }, 'admission anchor unchanged');
    const counters = s.locator.status().counters;
    assert.ok(counters.byVariant.azimuth > 0 && counters.byVariant.chunk > 0 && counters.byVariant.vec3i > 0, JSON.stringify(counters.byVariant));
    for (const r of results) assertNoCoordinates(r.evidence, [437, 61, 437.3, 61.7]);
  });

  it('a fixed owner-typed destination beyond the radius is reached through legs (arrival = own position)', async () => {
    const s = sim({ ownerAt: { x: 0, y: 64, z: -900 }, ownerCoordinates: [{ x: 300, y: 64, z: 200 }] });
    s.owner.hidden = true;
    const C = { goalEpoch: 1, connectionEpoch: 1, dimension: DIM };
    const results = await runWindows(s, {
      kind: 'fixed',
      destination: 'owner_destination',
      dimension: DIM,
      at: { x: 300, y: 64, z: 200 },
      label: 'owner-supplied destination 300,64,200',
      recheck: () => {
        const v = s.routes.verifyDestination(C, 'owner_destination', { x: 300, y: 64, z: 200 }, DIM);
        return v.ok ? { ok: true } : { ok: false, reason: `route_${v.blocker}`, detail: v.detail };
      },
    });
    const last = results.at(-1)!;
    assert.equal(last.status, 'succeeded', JSON.stringify(results.map((r) => [r.status, r.reason, r.effect])));
    assert.equal(last.reason, 'arrived');
    assert.ok(Math.hypot(300 - s.self.x, 200 - s.self.z) <= 3.5);
  });
});

describe('MB-LOC-001 L4 withdrawn/absent cues stop advancing', () => {
  it('no locator statement: nothing moves (no omniscient fallback)', async () => {
    const s = sim({ ownerAt: { x: 400, y: 64, z: 0 } });
    s.owner.hidden = true;
    s.serverEmit();
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'no_actionable_hint');
    assert.equal(s.moves, 0);
    assert.deepEqual(s.self, { x: 0.5, y: 64, z: 0.5 });
  });

  it('the owner hides (crouch/invisibility/head item -> untrack) mid-route: the bot stops on the withdrawn cue', async () => {
    const s = sim({ ownerAt: { x: 400, y: 64, z: 0 } });
    const original = s.env.move;
    s.env.move = async (t, w, b, o) => {
      if (s.self.x > 40) {
        s.owner.hidden = true;
      }
      return original(t, w, b, o);
    };
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'hint_withdrawn');
    const stoppedAt = s.self.x;
    assert.ok(stoppedAt < 60, `stopped near where the cue was withdrawn (x=${stoppedAt})`);
    const again = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(again.reason, 'no_actionable_hint');
    assert.equal(s.self.x, stoppedAt, 'no further movement without a current cue');
  });

  it('an expired statement (stationary bot, no broadcasts) is not followed', async () => {
    const s = sim({ ownerAt: { x: 400, y: 64, z: 0 } });
    s.clock.t += DEFAULT_LOCATOR_CONFIG.hintMaxAgeMs + 1;
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.reason, 'no_actionable_hint');
    assert.equal(s.moves, 0);
  });
});

describe('MB-LOC-001 L5 impassable terrain produces specific blockers (no dig/tower/invented path)', () => {
  it('visible lava across the cue direction -> hazard_lava; the bot never steps on lava', async () => {
    const s = sim({ ownerAt: { x: 300, y: 64, z: 0 }, obstacles: (w) => w.features.push((x, y, z) => (x >= 3 && x <= 40 && Math.abs(z) <= 300 && y === 63 ? { name: 'lava', stateId: 9, shapes: [] } : undefined)) });
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'hazard_lava', r.effect);
    assert.ok(s.self.x < 3);
  });

  it('a deep drop -> cliff_drop', async () => {
    const s = sim({ ownerAt: { x: 300, y: 40, z: 0 } });
    s.world.floorAt = (x) => (x >= 3 ? 30 : 63);
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.reason, 'cliff_drop', r.effect);
    assert.ok(s.self.x < 3 && s.self.y === 64);
  });

  it('a wall with the owner above -> vertical_separation (no towering); a plain wall -> wall', async () => {
    const wall = (w: ProcWorld) => w.features.push((x, y, z) => (x >= 3 && x <= 4 && Math.abs(z) <= 300 && y >= 64 && y <= 80 ? { name: 'stone', stateId: 3, shapes: FULL } : undefined));
    const above = sim({ ownerAt: { x: 40, y: 90, z: 0 }, obstacles: wall });
    const r1 = await runRoute(above.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: above.routes, locator: above.locator });
    assert.equal(r1.reason, 'vertical_separation', r1.effect);
    const level = sim({ ownerAt: { x: 300, y: 64, z: 0 }, obstacles: wall });
    const r2 = await runRoute(level.env, { kind: 'owner' }, { within: 3, durationMs: 60_000 }, { routes: level.routes, locator: level.locator });
    assert.equal(r2.reason, 'wall', r2.effect);
    assert.ok(level.self.x < 3 && level.self.y === 64);
  });
});

describe('MB-LOC-001 ceilings and ownership in the runner (L6/C1)', () => {
  it('without a route authorization the bot stops at the admission bound (route_not_authorized)', async () => {
    const s = sim({ ownerAt: { x: 600, y: 64, z: 0 }, routes: false });
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.status, 'failed');
    assert.equal(last.reason, 'route_not_authorized', last.effect);
    assert.ok(Math.hypot(s.self.x - 0.5, s.self.z - 0.5) <= 128);
  });

  it('the leg ceiling ends the route; the expanded leg is withdrawn and the bot never left the last authorized leg', async () => {
    const s = sim({ ownerAt: { x: 900, y: 64, z: 0 }, policy: { maxLegs: 2 } });
    let lastLeg: { anchor: Vec; radius: number } | undefined;
    const original = s.env.move;
    s.env.move = async (t, w, b, o) => {
      const leg = s.routes.legBounds({ goalEpoch: 1, connectionEpoch: 1, dimension: DIM });
      if (leg) lastLeg = { anchor: leg.anchor, radius: leg.radius };
      return original(t, w, b, o);
    };
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.reason, 'route_leg_limit', last.effect);
    assert.equal(s.routes.legBounds({ goalEpoch: 1, connectionEpoch: 1, dimension: DIM }), undefined, 'C2: no stale expanded authority');
    assert.equal((s.routes.effectiveTravel(s.env.admissionBounds()!) as { reason?: string }).reason, 'route_exhausted');
    assert.equal(s.routes.status(1)!.legsUsed, 2);
    assert.ok(lastLeg && Math.hypot(s.self.x - lastLeg.anchor.x, s.self.z - lastLeg.anchor.z) <= lastLeg.radius + 1e-6);
  });

  it('the cumulative distance ceiling stops route movement mid-leg', async () => {
    const s = sim({ ownerAt: { x: 900, y: 64, z: 0 }, policy: { maxTotalDistance: 100 } });
    const results = await runWindows(s);
    const last = results.at(-1)!;
    assert.equal(last.reason, 'route_distance_limit', last.effect);
    const st = s.routes.status(1)!;
    assert.ok(st.distanceUsed >= 100 && st.distanceUsed < 104, `${st.distanceUsed}`);
  });

  it('lease revocation (stop/replacement) aborts the runner; no movement afterwards', async () => {
    const s = sim({ ownerAt: { x: 400, y: 64, z: 0 } });
    s.sleeps.revokeAfter = 3;
    await assert.rejects(runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator }), /lease revoked/);
    const moves = s.moves;
    const at = { ...s.self };
    await assert.rejects(runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator }), /lease revoked/);
    assert.equal(s.moves, moves);
    assert.deepEqual(s.self, at);
  });

  it('a revoked route (goal ended) cannot be continued by a late window', async () => {
    const s = sim({ ownerAt: { x: 600, y: 64, z: 0 } });
    await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 30_000 }, { routes: s.routes, locator: s.locator });
    s.routes.revoke('goal_terminal', 1);
    const results = await runWindows(s);
    assert.ok(results.every((r) => r.status !== 'succeeded'));
    assert.equal(s.routes.legBounds({ goalEpoch: 1, connectionEpoch: 1, dimension: DIM }), undefined);
  });
});

describe('MB-LOC-001-C3 provenance in the runner', () => {
  it('a frozen own-incident destination that changes or disappears mid-route stops movement at the next poll', async () => {
    let current: ReturnType<RouteDestinationProvider['current']> = { destinationId: 'mf-0001', dimension: DIM, at: { x: 400, y: 64, z: 0 }, recordedAtMs: 5, label: 'own death location', provenance: 'own_incident' };
    for (const change of ['moved', 'missing'] as const) {
      current = { destinationId: 'mf-0001', dimension: DIM, at: { x: 400, y: 64, z: 0 }, recordedAtMs: 5, label: 'own death location', provenance: 'own_incident' };
      const s = sim({ ownerAt: { x: 0, y: 64, z: -900 }, policy: { destinations: ['owner', 'own_death'] }, ownDeath: { kind: 'own_death', current: () => current } });
      s.owner.hidden = true;
      const C = { goalEpoch: 1, connectionEpoch: 1, dimension: DIM };
      const v = s.routes.verifyDestination(C, 'own_death');
      assert.ok(v.ok && v.kind === 'own_death');
      if (v.ok && v.kind === 'own_death') assert.ok(s.routes.bindOwnDeath(C, v.identity));
      const original = s.env.move;
      let changedAt: Vec | undefined;
      s.env.move = async (t, w, b, o) => {
        if (s.self.x > 60 && !changedAt) {
          changedAt = { ...s.self };
          current = change === 'moved' ? { ...current!, at: { x: 420, y: 64, z: 0 } } : undefined;
        }
        return original(t, w, b, o);
      };
      const r = await runRoute(s.env, { kind: 'fixed', destination: 'own_death', dimension: DIM, at: { x: 400, y: 64, z: 0 }, label: 'own death location', recheck: () => {
        const c = s.routes.verifyDestination(C, 'own_death');
        return c.ok ? { ok: true } : { ok: false, reason: `route_${c.blocker}`, detail: c.detail };
      } }, { within: 3, durationMs: 120_000 }, { routes: s.routes, locator: s.locator });
      assert.equal(r.status, 'failed');
      assert.equal(r.reason, change === 'moved' ? 'route_destination_changed' : 'route_destination_unverified', r.effect);
      assert.ok(changedAt, 'the incident changed mid-route');
      assert.deepEqual(s.self, changedAt, 'stopped at the first movement poll after the change (no further step)');
    }
  });

  it('a leg whose admission anchor differs from the goal-owned proof is never applied (no relaxed fallback)', async () => {
    const s = sim({ ownerAt: { x: 600, y: 64, z: 0 } });
    // The proof claims a different admission anchor than the route authorization (e.g. a leg-expanded travelBounds misused as proof).
    s.proofOverride.value = { goalEpoch: 1, connectionEpoch: 1, dimension: DIM, anchor: { x: 10.5, y: 64, z: 0.5 }, radius: 128 };
    await runWindows(s);
    assert.ok(Math.hypot(s.self.x - 10.5, s.self.z - 0.5) <= 128 + 1e-6, `stayed inside the proven admission bound (x=${s.self.x})`);
    s.proofOverride.value = { goalEpoch: 2, connectionEpoch: 1, dimension: DIM, anchor: { x: 0.5, y: 64, z: 0.5 }, radius: 128 };
    const r = await runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 30_000 }, { routes: s.routes, locator: s.locator });
    assert.equal(r.reason, 'travel_anchor_not_admitted', 'a proof for another goal epoch moves nothing');
  });
});
