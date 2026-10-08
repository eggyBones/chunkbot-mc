// MB-LOC-002: the ORDINARY application composition (SkillRuntime with
// features.locator, exactly what cli.ts `run` builds) — not a harness-local
// composition. Proves, without any fixture or model:
//   - the registered catalog carries seek_owner/route_travel;
//   - the connection hook attaches the locator before login (join-time packets);
//   - an owner goal admission grants exactly one frozen route; diagnostic goals none;
//   - the SHARED travel guard (perception travelBounds/withinTravel, used by every
//     skill and navigation poll) applies a route leg only while it is live and
//     withdraws it on distance exhaustion, goal end and lifecycle revocation;
//   - goal end / death / dimension change / ended revoke the route and void hints;
//   - a replacement goal gets its own authorization; the old one never steers again.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { sequentialIds, type Clock, type GameLifecycleEvent } from '../src/contracts/index.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { REGISTRY_26_1_2, fakeClient, fakeMineflayerBot } from './skill-fakes.ts';

const DIM = 'minecraft:overworld';

function scene(locator: Record<string, unknown> | undefined = { routes: { maxTotalDistance: 200, legRadius: 96 } }) {
  const client = fakeClient(() => undefined);
  const fake = fakeMineflayerBot(client, { loaded: 400 });
  fake.fill(-30, -1, -30, 30, -1, 30, 'grass_block');
  const base = loadConfigFile(join(PROJECT_ROOT, 'config', 'examples', 'fixture.json')).config; // owner FixtureOwner, travelRadius 128
  const config = { ...base, ...(locator ? { locator } : {}) } as typeof base;
  const owner = config.owner.name ?? 'FixtureOwner';
  (fake.bot.players as Record<string, unknown>)[owner] = { uuid: offlinePlayerUuid(owner), username: owner };
  const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never);
  evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const t = { now: 1_000_000 };
  const clock: Clock = { now: () => t.now };
  const store = new MemoryRunStore();
  const epoch = { value: 0 };
  const runtime = new SkillRuntime({
    config,
    features: { locator: true },
    session: () => session,
    connectionEpoch: () => 1,
    goalEpoch: () => epoch.value,
    diagnosticCurrent: () => true,
    admission: () => ({ serverOnlineMode: false }),
    store,
    clock,
    ids: sequentialIds(),
  });
  // Connection hook BEFORE login (cli.ts onBotCreated): the locator sees join-time statements.
  runtime.onBotCreated(fake.bot as never, 1);
  client.emit('login', {});
  const ownerUuid = offlinePlayerUuid(owner);
  const statement = (type: string, data: unknown, operation = 'track') => client.emit('tracked_waypoint', { operation, waypoint: { hasUUID: true, uuid: ownerUuid, icon: { style: 'minecraft:default' }, type, data } });
  const admit = (e: number, source?: { kind: 'owner' }) => {
    epoch.value = e;
    runtime.onGoalAdmitted({ goalId: `goal-000${e}`, epoch: e, admittedAtMs: t.now, ...(source ? { source: source as never } : {}), deadlineAtMs: t.now + 600_000 });
  };
  const ctx = () => ({ goalEpoch: epoch.value, connectionEpoch: 1, dimension: DIM });
  const setPos = (x: number, z: number) => {
    fake.bot.entity.position.x = x;
    fake.bot.entity.position.z = z;
  };
  return { runtime, fake, client, store, t, epoch, statement, admit, ctx, setPos, routes: runtime.routes!, locator: runtime.locator!, perception: runtime.perception };
}

describe('MB-LOC-002 ordinary composition (SkillRuntime features.locator)', () => {
  it('registers seek_owner/route_travel in the one catalog and attaches the locator before login', () => {
    const s = scene();
    const ids = s.runtime.registry.catalog().capabilities.map((c) => c.id);
    assert.ok(ids.includes('seek_owner') && ids.includes('route_travel'));
    assert.ok(s.runtime.locator && s.runtime.routes, 'composed');
    s.statement('vec3i', { x: 200, y: 0, z: 0 });
    const h = s.locator.ownerHint();
    assert.equal(h.actionable, true, h.note);
    assert.equal(h.direction, 'east');
    assert.equal(s.locator.attachedLate, false, 'attached at client creation, not late');
  });

  it('owner goals get one frozen authorization at admission; non-owner (diagnostic) goals get none', () => {
    const s = scene();
    s.admit(1); // no source -> diagnostic
    assert.equal(s.routes.authorization(s.ctx()), undefined);
    s.admit(2, { kind: 'owner' });
    const auth = s.routes.authorization(s.ctx());
    assert.ok(auth);
    assert.deepEqual({ ...auth.admissionAnchor }, { x: 0.5, y: 0, z: 0.5 });
    assert.equal(auth.admissionRadius, 128);
    assert.ok(Object.isFrozen(auth) && Object.isFrozen(auth.ceilings));
    assert.equal(s.routes.admit({ goalId: 'goal-0002', goalEpoch: 2, admittedAtMs: s.t.now, source: 'owner', goalDeadlineMs: s.t.now + 1, connectionEpoch: 1, dimension: DIM, admissionAnchor: { x: 9, y: 0, z: 9 }, admissionRadius: 999, ownerCoordinates: [] }), undefined, 'an epoch is never re-admitted');
  });

  it('the shared travel guard (every skill) applies a leg only while live and withdraws it on distance exhaustion', () => {
    const s = scene();
    s.admit(1, { kind: 'owner' });
    const far = { x: 180, y: 0, z: 0.5 };
    assert.equal(s.perception.withinTravel(far), false, 'beyond the 128 admission radius');
    s.setPos(100, 0.5);
    const leg = s.routes.beginLeg({ ...s.ctx(), at: { x: 100, y: 0, z: 0.5 }, destination: 'owner', bearingRad: 0 });
    assert.ok(leg.ok, JSON.stringify(leg));
    assert.equal(s.perception.withinTravel(far), true, 'inside the live leg');
    assert.deepEqual(s.perception.travelBounds()?.anchor, { x: 100, y: 0, z: 0.5 });
    assert.deepEqual(s.perception.admissionBounds()?.anchor, { x: 0.5, y: 0, z: 0.5 }, 'the admission anchor never moves');
    // Cumulative own movement exhausts the operator budget (200): the expanded authority is withdrawn for every skill.
    for (const x of [140, 100, 140, 100, 140, 100]) s.routes.sample(s.ctx(), { x, y: 0, z: 0.5 });
    assert.equal(s.routes.status(1)?.state, 'exhausted');
    assert.equal(s.perception.withinTravel(far), false, 'no stale expanded leg after exhaustion');
    assert.deepEqual(s.perception.travelBounds()?.anchor, { x: 0.5, y: 0, z: 0.5 });
    const view = s.runtime.routeView(1);
    assert.equal(view?.status?.blocker?.reason, 'distance_limit');
    assert.deepEqual(view?.admission?.anchor, { x: 0.5, y: 0, z: 0.5 });
  });

  it('goal end revokes the route (no leg, no regrant); a replacement gets its own authorization', () => {
    const s = scene();
    s.admit(1, { kind: 'owner' });
    s.setPos(100, 0.5);
    assert.ok(s.routes.beginLeg({ ...s.ctx(), at: { x: 100, y: 0, z: 0.5 }, destination: 'owner', bearingRad: 0 }).ok);
    s.runtime.onGoalTerminal({ goalId: 'goal-0001', epoch: 1, kind: 'owner_goal', reason: 'replaced', detail: 'replaced' });
    assert.equal(s.routes.status(1)?.state, 'revoked');
    assert.equal(s.perception.withinTravel({ x: 180, y: 0, z: 0.5 }), false);
    s.admit(2, { kind: 'owner' });
    const auth = s.routes.authorization(s.ctx());
    assert.ok(auth && auth.goalEpoch === 2);
    assert.deepEqual({ ...auth.admissionAnchor }, { x: 100, y: 0, z: 0.5 }, 'the NEW goal is anchored where it was admitted');
    assert.equal(s.routes.legBounds({ goalEpoch: 1, connectionEpoch: 1, dimension: DIM }), undefined, 'the old route never steers again');
  });

  for (const type of ['death', 'dimension_change', 'respawn', 'ended'] as const) {
    it(`lifecycle ${type} revokes the route and voids owner statements`, () => {
      const s = scene();
      s.admit(1, { kind: 'owner' });
      s.statement('vec3i', { x: 200, y: 0, z: 0 });
      assert.ok(s.locator.ownerHint().actionable);
      s.setPos(100, 0.5);
      assert.ok(s.routes.beginLeg({ ...s.ctx(), at: { x: 100, y: 0, z: 0.5 }, destination: 'owner', bearingRad: 0 }).ok);
      const event = { type, connectionEpoch: 1, atMs: s.t.now, ...(type === 'dimension_change' ? { dimension: 'minecraft:the_nether' } : {}), ...(type === 'ended' ? { reason: 'test' } : {}) } as unknown as GameLifecycleEvent;
      s.runtime.onLifecycle(event);
      assert.equal(s.routes.status(1)?.state, 'revoked');
      assert.equal(s.locator.ownerHint().actionable, false, `${type}: no stale cue`);
      assert.equal(s.routes.legBounds(s.ctx()), undefined);
    });
  }

  it('locator disabled by configuration composes no locator/route capability (explicit opt-out)', () => {
    const client = fakeClient(() => undefined);
    const fake = fakeMineflayerBot(client, { loaded: 64 });
    const config = loadConfigFile(join(PROJECT_ROOT, 'config', 'examples', 'fixture.json')).config;
    const session = { bot: fake.bot, connectionEpoch: 1, evidence: {} } as unknown as GameSession;
    const runtime = new SkillRuntime({ config, session: () => session, connectionEpoch: () => 1, goalEpoch: () => 1, diagnosticCurrent: () => true, admission: () => ({ serverOnlineMode: false }), store: new MemoryRunStore(), clock: { now: () => 1 }, ids: sequentialIds() });
    const ids = runtime.registry.catalog().capabilities.map((c) => c.id);
    assert.ok(!ids.includes('seek_owner'));
    assert.equal(runtime.routes, undefined);
  });
});
