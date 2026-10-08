// Shared production composition, credential-free fake connection/physics.
// No world, provider, persistent scope, memory or autonomous progression.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ChunkbotApp } from '../src/app/app.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { parseConfig } from '../src/config/load.ts';
import { sequentialIds, systemClock, type TaskSpec } from '../src/contracts/index.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { FakeGame, ScriptedPlanner, until } from './helpers.ts';
import { scene, stopPhysics } from './safety-session.ts';
import { conservativeMovements } from '../src/skills/navigation.ts';
import { ackSequenced } from './skill-fakes.ts';

after(stopPhysics);
const config = parseConfig({ minecraft: { host: '127.0.0.1', port: 25566, version: '26.1.2' }, bot: { auth: 'offline', username: 'Chunkbot', trustedOfflineFixture: true }, owner: { name: 'FixtureOwner' }, limits: { travelRadius: 8 } });

describe('ordinary shared safety composition', () => {
  it('canonical L route carry is revoked atomically and admitted once through the actual shared continuation hooks', () => {
    const sc = scene({ pool: false });
    let epoch = 3;
    const store = new MemoryRunStore();
    const runtime = new SkillRuntime({ config, features: { locator: true }, session: () => sc.session, connectionEpoch: () => 1, goalEpoch: () => epoch, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store, clock: systemClock, ids: sequentialIds() });
    const admittedAtMs = Date.now();
    const deadlineAtMs = admittedAtMs + 60_000;
    runtime.onGoalAdmitted({ goalId: 'goal-0001', epoch, admittedAtMs, deadlineAtMs, source: { kind: 'owner' } });
    const anchor = runtime.continuationAnchor(epoch)!;
    assert.ok(runtime.routes!.beginLeg({ goalEpoch: epoch, connectionEpoch: 1, dimension: anchor.dimension, at: anchor.at, destination: 'owner', bearingRad: 0 }).ok);
    runtime.routes!.sample({ goalEpoch: epoch, connectionEpoch: 1, dimension: anchor.dimension }, { ...anchor.at, x: anchor.at.x + 5 });
    const carry = runtime.continuationRoute(epoch)!;
    assert.ok(carry);
    assert.equal(runtime.routes!.status(epoch)!.state, 'revoked');
    assert.equal(runtime.continuationRoute(epoch), undefined, 'no second carry from a revoked route');
    epoch = 5;
    runtime.onGoalAdmitted({ goalId: 'goal-0001', epoch, admittedAtMs: Date.now(), deadlineAtMs, source: { kind: 'owner' }, continuation: { number: 1, anchor, route: carry } });
    const resumed = runtime.routes!.status(epoch)!;
    assert.equal(resumed.routeId, carry.routeId);
    assert.equal(resumed.legsUsed, carry.legsUsed);
    assert.equal(resumed.distanceUsed, carry.distance.total);
    assert.deepEqual(runtime.continuationAnchor(epoch), anchor);
    const auth = runtime.routes!.authorization({ goalEpoch: epoch, connectionEpoch: 1, dimension: anchor.dimension })!;
    assert.deepEqual(auth.ceilings, carry.ceilings);
    assert.equal(auth.grantedAtMs, carry.grantedAtMs);
    assert.ok(!store.events.some((e) => e['type'] === 'route_continuation_not_granted'));
    assert.equal(runtime.routes!.admitContinuation(carry, { goalId: 'goal-0001', goalEpoch: 7, admittedAtMs: Date.now(), goalDeadlineMs: deadlineAtMs, source: 'owner', connectionEpoch: 1, dimension: anchor.dimension, admissionAnchor: anchor.at, admissionRadius: anchor.radius, ownerCoordinates: [] }).ok, false, 'same carry never refills');
  });

  it('protects a paused manual goal during its planner wait through the actual single executor/lease; stop and logout revoke it', async () => {
    const sc = scene();
    const write = sc.client.write.bind(sc.client);
    sc.client.write = (name, data) => {
      write(name, data);
      if (name === 'window_click' && data['stateId'] === -1) setImmediate(() => sc.client.emit('window_items', { windowId: 0, stateId: 9, items: new Array(46).fill({ itemCount: 0 }) }));
      ackSequenced(sc.client, name, data);
    };
    sc.session.bot.entity.position.set(10.5, 4, 0.5);
    const game = new FakeGame();
    const planner = new ScriptedPlanner();
    const store = new MemoryRunStore();
    let app: ChunkbotApp;
    const runtime = new SkillRuntime({ config, features: { safety: true }, session: () => sc.session, connectionEpoch: () => 1, goalEpoch: () => app?.engine.currentEpoch ?? 0, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store, clock: systemClock, ids: sequentialIds(), safetyAuthority: () => app.safetyAuthority() });
    app = new ChunkbotApp({ config, game, store, clock: systemClock, ids: sequentialIds(), out: () => undefined, runFacts: {}, adapters: { ...runtime.adapters(), planner }, extensions: { onGoalAdmitted: (a) => runtime.onGoalAdmitted(a), onLifecycle: (e) => runtime.onLifecycle(e), onSafetyAuthorityChanged: (c) => runtime.safety?.onAuthorityChanged(c), travelBounds: () => runtime.perception.travelBounds(), closeControl: () => runtime.closeSafety() } });
    runtime.onBotCreated(sc.session.bot, 1);
    sc.client.emit('login', { entityId: 1 });
    sc.client.emit('update_health', { health: 20, food: 20, foodSaturation: 5 });
    sc.client.emit('entity_metadata', { entityId: 1, metadata: [{ key: 1, type: 'varint', value: 200 }] });
    try {
      const connecting = app.connect(); game.completeJoin(); await connecting;
      await app.handleTerminalLine('stop');
      await app.handleTerminalLine('help me with the work nearby');
      await until(() => planner.waiting === 1);
      const id = app.engine.status().goal!.id;
      const epoch = app.engine.currentEpoch;
      const counters = { ...app.engine.status().goal!.counters };
      const anchor = runtime.continuationAnchor(epoch);
      assert.equal(app.safetyAuthority().basis, 'owner_goal');
      const normal = runtime.leases.acquire({ kind: 'goal', goalId: id, goalEpoch: epoch, taskId: 'task-0001' });
      sc.session.bot.entity.position.set(0.5, 0, 0.5);
      runtime.safety!.tick();
      await until(() => store.events.some((e) => e['type'] === 'skill_started' && e['owner'] === 'safety'));
      assert.equal(normal.revocation, 'safety_preempt');
      assert.equal(runtime.leases.current?.owner.kind, 'safety');
      assert.equal(app.engine.status().goal!.id, id);
      assert.equal(app.engine.currentEpoch, epoch);
      assert.deepEqual(app.engine.status().goal!.counters, counters);
      assert.deepEqual(runtime.continuationAnchor(epoch), anchor);
      await app.handleTerminalLine('stop');
      assert.equal(app.safetyAuthority().basis, 'none');
      assert.ok(Object.values(sc.controls).every((on) => !on), 'stop clears actual controls synchronously');
      const revokedGrant = store.events.find((e) => e['type'] === 'safety_episode_started')!['grantId'];
      await app.handleTerminalLine('continue working nearby');
      runtime.safety!.tick();
      await until(() => store.events.filter((e) => e['type'] === 'safety_episode_started').length === 2);
      const second = store.events.filter((e) => e['type'] === 'safety_episode_started')[1]!;
      assert.notEqual(second['grantId'], revokedGrant, 'new manual goal authorizes a fresh finite grant despite automatic pause');
      assert.notEqual(app.engine.status().goal!.id, id, 'replacement has no old goal authority');
      assert.equal(runtime.safety!.grantCurrent(String(revokedGrant)), false);
      await app.handleTerminalLine('stop');
      assert.ok(Object.values(sc.controls).every((on) => !on));
      await runtime.closeSafety();
      assert.equal(runtime.leases.current, undefined);
      assert.ok(store.events.some((e) => e['type'] === 'safety_cleanup' && e['settled'] === true));
    } finally { await app.shutdown('operator_quit'); }
  });

  it('all ordinary navigation uses W deep-water exclusion with wading still allowed', () => {
    const sc = scene();
    const { movements } = conservativeMovements(sc.session.bot);
    const guards = (movements as { exclusionAreasStep: Array<(b: { position: { x: number; y: number; z: number } }) => number> }).exclusionAreasStep;
    assert.ok(guards.some((g) => g({ position: { x: 0, y: 1, z: 0 } }) === 100));
    sc.fake.setBlock(0, 0, 0, 'stone');
    assert.ok(guards.every((g) => g({ position: { x: 0, y: 1, z: 0 } }) === 0));
  });

  it('an immutable owner-directed outcome fences undirected exploration at candidate and final execution seams', async () => {
    const sc = scene({ pool: false }); const store = new MemoryRunStore();
    const runtime = new SkillRuntime({ config, features: { locator: true }, session: () => sc.session, connectionEpoch: () => 1, goalEpoch: () => 1, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store, clock: systemClock, ids: sequentialIds() });
    runtime.onGoalAdmitted({ goalId: 'goal-0001', epoch: 1, admittedAtMs: Date.now(), source: { kind: 'owner' } });
    const snapshot = runtime.perception.take(1)!;
    const task: TaskSpec = { objective: 'Survey nearby.', decisionInstruction: 'Observe from a frontier.', allowedCapabilities: ['explore_frontier'], targetSelectors: [], parameters: {}, completion: { predicate: 'inventory_amount', selector: 'minecraft:oak_log', atLeast: 1, mode: 'possess' } };
    const choices = runtime.candidates.generate(task, snapshot, undefined, true);
    assert.equal(choices.candidates.length, 0);
    assert.ok(choices.unavailable.some((e) => e.reason === 'owner_direction_required'));
    const writes = sc.client.written.length;
    const outcome = await runtime.executor.execute({ id: 'act-0001', snapshotId: snapshot.id, connectionEpoch: 1, goalEpoch: 1, capability: 'explore_frontier', parameters: { frontier: { snapshotId: snapshot.id, handle: 'frt-1' } }, description: 'Undirected frontier', criteria: [], preconditions: [], timeoutMs: 1000 }, new AbortController().signal, { kind: 'goal', goalId: 'goal-0001', goalEpoch: 1, taskId: 'task-0001', requiresOwnerDirection: true });
    assert.equal(outcome.reason, 'owner_direction_required');
    assert.equal(sc.client.written.length, writes, 'no navigation command or lease before final refusal');
    assert.equal(runtime.leases.current, undefined);
  });
});
