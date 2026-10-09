// P-SAFETY-R18 O7F: actual-composition control for the far unseen-owner route
// staging. Actual R18 (261 goal-de389ae3aa70 / 262 goal-d7c37dbcee35): with the
// bot staged at LAYOUT.water.bot (218.5,-56,200.5) on the 4-block-high O7W dirt
// platform and the owner at the approved far point (chunk 21,12, east), every
// seek_owner window failed in ~25 ms `unobserved_terrain` (5/5 rays
// unobserved, 0 moves, legs 0) and the task exhausted retries before any owned
// motion. The real perception/locator/route runner is reproduced here over the
// declared platform/pool geometry (absolute coordinates); only the move adapter
// is a recorder (it issues no motion).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, type JsonValue } from '../src/contracts/index.ts';
import { DEFAULT_LOCATOR_CONFIG, RoutePolicySchema } from '../src/contracts/locator.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { runRoute, type RouteEnv } from '../src/locator/route-runner.ts';
import { RouteController } from '../src/locator/routes.ts';
import { LocatorService } from '../src/locator/service.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { LAYOUT } from '../scripts/ordinary-goal-live-check.ts';
import { evidenceFor, fakeClient, fakeMineflayerBot } from './skill-fakes.ts';

const OWNER = 'FixtureOwner';
const OWNER_UUID = offlinePlayerUuid(OWNER);

function o7f(start: { x: number; y: number; z: number }) {
  const client = fakeClient();
  const scene = fakeMineflayerBot(client, { dimension: 'overworld', loaded: 400, at: start });
  // Reset scene ground (grass at -61) around the declared area, then the actual O7W water geometry.
  scene.fill(170, -61, 160, 260, -61, 250, 'grass_block');
  const { platform: p, pool } = LAYOUT.water;
  scene.fill(p.x1, p.y1, p.z1, p.x2, p.y2, p.z2, 'dirt');
  scene.fill(pool.x1, p.y1, pool.z1, pool.x2, p.y2, pool.z2, 'water');
  scene.bot.players[OWNER] = { uuid: OWNER_UUID, username: OWNER } as never;
  const evidence = evidenceFor(client);
  const session = { bot: scene.bot, evidence, connectionEpoch: 1 } as unknown as GameSession & { connectionEpoch: number };
  const clock = { t: 1_791_510_492_000, now() { return this.t; } };
  const perception = new PerceptionService({ session: () => session, clock, ids: sequentialIds(), observationRadius: 32, travelRadius: 128, ownerPolicy: { mode: 'offline_name', ownerName: OWNER }, admission: () => ({ serverOnlineMode: false }) });
  const locator = new LocatorService({ config: DEFAULT_LOCATOR_CONFIG, version: '26.1.2', ownerPolicy: { mode: 'offline_name', ownerName: OWNER }, admission: () => ({ serverOnlineMode: false }), session: () => session, clock });
  locator.attach(client, 1);
  client.emit('login', {});
  // Actual far owner point 350.5,-60,198.5 -> chunk statement (precision 'chunk', as journaled `tracked:chunk`).
  client.emit('tracked_waypoint', { operation: 'track', waypoint: { hasUUID: true, uuid: OWNER_UUID, icon: { style: 'minecraft:default' }, type: 'chunk', data: { chunkX: Math.floor(LAYOUT.safety.farOwner.x / 16), chunkZ: Math.floor(LAYOUT.safety.farOwner.z / 16) } } });
  assert.equal(perception.admitTravelAnchor(5), true);
  const proof = perception.admissionBounds()!;
  const routes = new RouteController({ policy: RoutePolicySchema.parse({}), clock });
  assert.ok(routes.admit({ goalId: 'goal-o7f', goalEpoch: 5, admittedAtMs: clock.t, source: 'owner', goalDeadlineMs: clock.t + 900_000, connectionEpoch: 1, dimension: 'overworld', admissionAnchor: proof.anchor, admissionRadius: proof.radius, ownerCoordinates: [] }));
  const moves: Array<{ x: number; y: number; z: number }> = [];
  const bot = scene.bot;
  // Production routeEnv calls for observation/world/visited/bounds; the move adapter only records.
  const env: RouteEnv = {
    goalEpoch: 5,
    connectionEpoch: () => 1,
    dimension: () => 'overworld',
    self: () => ({ x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }),
    now: () => clock.now(),
    sleep: async (ms) => void (clock.t += ms),
    observe: () => { const snap = perception.take(5); const seen = snap ? perception.seenBlocks(snap.id) : undefined; return seen ? { seen } : undefined; },
    world: () => perception.world(),
    visited: () => perception.visitedLocations().map((v) => v.at),
    recordVisited: () => perception.recordVisited(),
    ownerVisible: () => undefined,
    admissionBounds: () => perception.admissionBounds(),
    move: async (target) => { moves.push(target); return { status: 'timeout', finalDistance: 99 }; },
    progress: (_e: Record<string, JsonValue>) => undefined,
    observationRadius: 32,
    ownerLossMs: 1_000,
  };
  return { env, routes, locator, moves, perception, proof };
}

describe('P-SAFETY-R18 O7F far-route staging geometry (actual perception/locator/route runner)', () => {
  it('actual R18 start on the 4-block platform: the real runner names unobserved_terrain toward the east cue and issues no motion', async () => {
    const w = o7f(LAYOUT.water.bot);
    assert.equal(w.locator.ownerHint().actionable, true);
    assert.equal(w.locator.ownerHint().direction, 'east');
    const r = await runRoute(w.env, { kind: 'owner' }, { within: 3, durationMs: 5_000 }, { routes: w.routes, locator: w.locator });
    assert.equal(r.status, 'failed');
    assert.equal(r.reason, 'unobserved_terrain');
    assert.equal(w.moves.length, 0, 'no owned motion can begin from this staging point');
    assert.equal(w.routes.status(5)!.legsUsed, 0);
  });

  it('the same platform, owner cue and ORIGINAL radius from the declared west start: real frontier choice moves east on dry platform floor, no leg needed', async () => {
    const w = o7f(LAYOUT.safety.farStart);
    const r = await runRoute(w.env, { kind: 'owner' }, { within: 3, durationMs: 5_000 }, { routes: w.routes, locator: w.locator });
    assert.ok(w.moves.length > 0, `real runner issues an owned move (got ${r.status}/${r.reason})`);
    const first = w.moves[0]!;
    assert.ok(first.x - LAYOUT.safety.farStart.x >= 6, `first waypoint lies east: ${JSON.stringify(first)}`);
    const { platform: p, pool } = LAYOUT.water;
    assert.ok(first.x >= p.x1 && first.x < p.x2 + 1 && first.z >= p.z1 && first.z < p.z2 + 1 && first.y === -56, 'waypoint stands on the dry platform');
    assert.ok(!(first.x >= pool.x1 && first.x < pool.x2 + 1 && first.z >= pool.z1 && first.z < pool.z2 + 1), 'waypoint is not in the pool');
    assert.ok(Math.hypot(first.x - w.proof.anchor.x, first.z - w.proof.anchor.z) <= w.proof.radius, 'inside the ORIGINAL admission bound');
    assert.equal(w.routes.status(5)!.legsUsed, 0, 'inside the 128 bound no counted leg is begun (legs extend a travel-limited bound only)');
  });
});
