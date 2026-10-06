// Maintained regressions for the remaining MB-SKL-007 / MB-SKL-009 variants:
//   - goal admission owns the travel anchor (captured before planning, kept
//     through the first and later actions, replaced only by a new admission);
//   - container contents are CURRENT evidence only when server-synchronized
//     through the bot's own interface after the outcome was bound and within
//     CONTAINER_EVIDENCE_MAX_AGE_MS; older views are historical (unknown).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { sequentialIds, systemClock, type ActionCandidate, type ExecutionOwner, type ObservationSnapshot } from '../src/contracts/index.ts';
import { SkillExecutorImpl, clearSharedControls } from '../src/execution/executor.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { CONTAINER_EVIDENCE_MAX_AGE_MS, PredicateEngine } from '../src/execution/predicates.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { inspectContainer } from '../src/skills/containers.ts';
import type { SkillServices } from '../src/skills/definition.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { ScriptedPlanner, makeEngine, until } from './helpers.ts';
import { ackSequenced, fakeClient, fakeMineflayerBot, REGISTRY_26_1_2, vec3, type FakeClient } from './skill-fakes.ts';

const OWNER = { surface: 'chat', principal: 'owner' } as const;
const signal = () => new AbortController().signal;

// ---------------------------------------------------------------- admission anchor (MB-SKL-007)

describe('MB-SKL-007 goal admission owns the travel anchor', () => {
  it('the goal engine calls the admission hook synchronously for the new epoch BEFORE planning, and again for a replacement', async () => {
    const planner = new ScriptedPlanner();
    const calls: Array<{ epoch: number; goalId: string; plannerRequestsAtAdmission: number; engineEpoch: number }> = [];
    const harness = makeEngine({
      planner,
      onGoalAdmitted: (a) => calls.push({ epoch: a.epoch, goalId: a.goalId, plannerRequestsAtAdmission: planner.requests.length, engineEpoch: harness.engine.currentEpoch }),
    });
    const first = await harness.engine.submit('walk to the hill', OWNER);
    assert.equal(first.status, 'admitted');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.plannerRequestsAtAdmission, 0, 'captured before the planner was asked anything');
    assert.equal(calls[0]?.epoch, calls[0]?.engineEpoch, 'the hook runs with the new epoch already current');
    await until(() => planner.waiting === 1);
    const second = await harness.engine.submit('now come back', OWNER);
    assert.equal(second.status, 'admitted');
    assert.equal(calls.length, 2, 'a genuine replacement admission gets its own hook call');
    assert.ok((calls[1]?.epoch ?? 0) > (calls[0]?.epoch ?? 0));
    // Rejected instructions never re-admit.
    await harness.engine.submit('   ', OWNER);
    assert.equal(calls.length, 2);
  });

  function runtimeScene() {
    const client: FakeClient = fakeClient((name, data) => ackSequenced(client, name, data));
    const fake = fakeMineflayerBot(client, { loaded: 200 });
    fake.fill(-20, -1, -20, 20, -1, 20, 'grass_block');
    const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never);
    evidence.attach();
    const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
    Object.assign(fake.bot, { pathfinder: { setMovements: () => undefined, setGoal: () => undefined, isMoving: () => false }, clearControlStates: () => undefined, setControlState: () => undefined, lookAt: () => Promise.resolve() });
    const config = loadConfigFile(join(PROJECT_ROOT, 'config', 'examples', 'fixture.json')).config; // travelRadius 128
    const epoch = { value: 1 };
    const runtime = new SkillRuntime({ config, session: () => session, connectionEpoch: () => 1, goalEpoch: () => epoch.value, diagnosticCurrent: () => true, admission: () => ({ serverOnlineMode: false }), store: new MemoryRunStore(), clock: systemClock, ids: sequentialIds() });
    const goal = (e: number): ExecutionOwner => ({ kind: 'goal', goalEpoch: e, goalId: `goal-000${e}`, taskId: 'task-0001' });
    const moveTo = (e: number, x: number): ActionCandidate => ({
      id: `act-${e}x${Math.round(x)}aa`,
      capability: 'move_near',
      parameters: { target: { kind: 'destination', dimension: 'minecraft:overworld', x, y: 0, z: 0.5 }, within: 1 },
      snapshotId: 'snap-0001',
      connectionEpoch: 1,
      goalEpoch: e,
      description: 'move',
      criteria: [],
      preconditions: [],
      timeoutMs: 5_000,
    });
    return { fake, runtime, epoch, goal, moveTo };
  }

  it('Chunkbot moving between admission and the first action does not move the anchor (aborted and active first actions)', async () => {
    const s = runtimeScene();
    s.runtime.onGoalAdmitted({ goalId: 'goal-0001', epoch: 1, admittedAtMs: Date.now() }); // Chunkbot at 0.5,0,0.5
    s.fake.bot.entity.position = vec3(129.5, 0, 0.5); // correction/knockback while the planner is pending
    const aborted = await s.runtime.executor.execute(s.moveTo(1, 120.5), AbortSignal.abort(), s.goal(1));
    assert.equal(aborted.status, 'cancelled');
    assert.equal(s.runtime.perception.travelBounds()?.anchor.x, 0.5, 'an already-aborted first action never re-anchors');
    const active = await s.runtime.executor.execute(s.moveTo(1, 120.5), signal(), s.goal(1));
    assert.equal(active.status, 'failed');
    assert.equal(active.reason, 'outside_travel_bounds', `${active.status} ${active.reason} ${active.effect}`);
    assert.equal(s.runtime.perception.travelBounds()?.anchor.x, 0.5, 'an active first action keeps the admission anchor');
    assert.equal(s.runtime.perception.withinTravel(s.fake.bot.entity.position), false, 'the movement did not widen the bound');
    // A second task of the same goal keeps it too.
    const again = await s.runtime.executor.execute(s.moveTo(1, 60.5), signal(), s.goal(1));
    assert.equal(again.reason, 'outside_travel_bounds');
    assert.equal(s.runtime.perception.travelAnchorGoalEpoch(), 1);
  });

  it('a goal action without its own admitted anchor is refused; a replacement admission installs a fresh anchor', async () => {
    const s = runtimeScene();
    s.runtime.onGoalAdmitted({ goalId: 'goal-0001', epoch: 1, admittedAtMs: Date.now() });
    s.fake.bot.entity.position = vec3(100.5, 0, 0.5);
    s.epoch.value = 2; // the goal engine moved on (stop/replacement) before the next admission hook
    const refused = await s.runtime.executor.execute(s.moveTo(2, 101.5), signal(), s.goal(2));
    assert.equal(refused.status, 'precondition_failed');
    assert.equal(refused.reason, 'travel_anchor_not_admitted');
    assert.equal(s.runtime.perception.travelBounds()?.anchor.x, 0.5, 'refusal does not re-anchor');
    s.runtime.onGoalAdmitted({ goalId: 'goal-0002', epoch: 2, admittedAtMs: Date.now() }); // genuine replacement admission
    assert.equal(s.runtime.perception.travelBounds()?.anchor.x, 100.5);
    assert.equal(s.runtime.perception.travelAnchorGoalEpoch(), 2);
    const stale = await s.runtime.executor.execute(s.moveTo(1, 101.5), signal(), s.goal(1));
    assert.equal(stale.reason, 'stale_goal_epoch', 'the old goal cannot use the replacement anchor');
  });
});

// ---------------------------------------------------------------- container freshness (MB-SKL-009)

describe('MB-SKL-009 current container contents need a fresh, owned server sync', () => {
  function predicateScene(now: { value: number }) {
    const clock = { now: () => now.value };
    const ledger = new EvidenceLedger(clock, () => 1);
    const session = { connectionEpoch: 1, bot: { registry: REGISTRY_26_1_2, game: { dimension: 'minecraft:overworld' }, currentWindow: null, quickBarSlot: 0, _client: { write: () => undefined }, entities: {}, entity: { position: { x: 0, y: 0, z: 0 } } }, evidence: { seq: 0, waitFor: async () => undefined } } as unknown as GameSession;
    const engine = new PredicateEngine({ services: { clock, ledger, perception: {} as never, knowledge: new VersionKnowledge({ version: '26.1.2' }), limits: {} as never }, session: () => session, leases: { current: undefined } as never });
    const p = { predicate: 'container_state', target: { kind: 'owner_destination', dimension: 'minecraft:overworld', at: { x: 1, y: 0, z: 0 }, ownerText: '1 0 0' }, selector: 'minecraft:stone', atLeast: 3 } as const;
    return { ledger, engine, p };
  }
  const chestRead = (atMs: number) => ({ kind: 'container' as const, dimension: 'minecraft:overworld', x: 1, y: 0, z: 0, contents: { 'minecraft:stone': 3 }, atMs, actionId: 'act-inspect', via: 'inspect_container' });

  it('a view from before the outcome was bound is historical (unknown), even on the same connection and lifecycle', async () => {
    const now = { value: 100_000 };
    const s = predicateScene(now);
    s.ledger.add(chestRead(10));
    const r = await s.engine.evaluate(await s.engine.bind(s.p, signal()), signal());
    assert.equal(r.status, 'unknown');
    assert.equal(r.evidence['historical'], true);
    assert.equal(r.evidence['historicalCount'], 3);
  });

  it('a server-synced read after binding and within the age limit is current; older than the limit is unknown again', async () => {
    const now = { value: 100_000 };
    const s = predicateScene(now);
    const bound = await s.engine.bind(s.p, signal());
    now.value += 1_000;
    s.ledger.add(chestRead(now.value));
    const fresh = await s.engine.evaluate(bound, signal());
    assert.equal(fresh.status, 'satisfied');
    assert.equal(fresh.evidence['fresh'], true);
    assert.equal(fresh.evidence['observedBy'], 'act-inspect');
    now.value += CONTAINER_EVIDENCE_MAX_AGE_MS + 1;
    const aged = await s.engine.evaluate(bound, signal());
    assert.equal(aged.status, 'unknown', 'the same read cannot prove current contents forever');
    // Re-binding later does not refresh an old read (no timestamp rebinding).
    const rebound = await s.engine.evaluate(await s.engine.bind(s.p, signal()), signal());
    assert.equal(rebound.status, 'unknown');
  });

  it('the real inspect_container skill (opened, server-resynced, closed) supplies the fresh positive; a later outcome needs a new inspection', async () => {
    const chestItems = () => {
      const items = Array.from({ length: 63 }, () => ({ itemCount: 0 }) as { itemCount: number; itemId?: number });
      items[0] = { itemCount: 3, itemId: REGISTRY_26_1_2.itemsByName['stone']?.id as number };
      return items;
    };
    const client: FakeClient = fakeClient((name, data) => {
      if (name === 'block_place') {
        const sequenceId = data['sequence'];
        setImmediate(() => {
          client.emit('open_window', { windowId: 5, inventoryType: 2 });
          (fake.bot as { currentWindow: unknown }).currentWindow = { id: 5, type: 'minecraft:generic_9x3', inventoryStart: 27, inventoryEnd: 63, slots: [], selectedItem: null };
          client.emit('window_items', { windowId: 5, stateId: 1, items: chestItems() });
          client.emit('acknowledge_player_digging', { sequenceId });
        });
      }
      if (name === 'window_click' && data['stateId'] === -1) {
        const windowId = Number(data['windowId']);
        setImmediate(() => client.emit('window_items', { windowId, stateId: 2, items: windowId === 5 ? chestItems() : Array.from({ length: 46 }, () => ({ itemCount: 0 })) }));
      }
      if (name === 'block_dig') ackSequenced(client, name, data);
    });
    const fake = fakeMineflayerBot(client);
    fake.fill(-10, -1, -10, 10, -1, 10, 'grass_block');
    fake.setBlock(0, 0, 2, 'chest');
    Object.assign(fake.bot, {
      lookAt: () => Promise.resolve(),
      setControlState: () => undefined,
      clearControlStates: () => undefined,
      closeWindow: (w: { id: number }) => {
        client.write('close_window', { windowId: w.id });
        (fake.bot as { currentWindow: unknown }).currentWindow = null;
      },
    });
    const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never);
    evidence.attach();
    const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
    const perception = new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 12, travelRadius: 64 });
    const services: SkillServices = { perception, knowledge: new VersionKnowledge({ version: '26.1.2' }), ledger: new EvidenceLedger(systemClock, () => 1), clock: systemClock, limits: { observationRadius: 12, travelRadius: 64, ownerLossMs: 1_000 } };
    const leases = new ActuatorLeases({ clock: systemClock, ownerCurrent: () => true, connectionEpoch: () => 1, clearShared: () => clearSharedControls(fake.bot as never) });
    const executor = new SkillExecutorImpl({ registry: new SkillRegistry([inspectContainer]), leases, session: () => session, services, goalEpoch: () => 1, store: new MemoryRunStore(), settleMs: 10 });
    const predicates = new PredicateEngine({ services, session: () => session, leases });
    const snap = perception.take(1) as ObservationSnapshot;
    const chest = snap.blocks.find((b) => b.key === 'minecraft:chest');
    assert.ok(chest);
    const p = { predicate: 'container_state', target: { kind: 'observed', snapshotId: snap.id, handle: chest.handle }, selector: 'minecraft:stone', atLeast: 3 } as const;
    const bound = await predicates.bind(p, signal());
    assert.equal((await predicates.evaluate(bound, signal())).status, 'unknown', 'never observed: unknown');
    const inspected = await executor.execute(
      { id: 'act-inspect1', capability: 'inspect_container', parameters: { container: { snapshotId: snap.id, handle: chest.handle } }, snapshotId: snap.id, connectionEpoch: 1, goalEpoch: 1, description: 'look', criteria: [], preconditions: [], timeoutMs: 10_000 },
      signal(),
      { kind: 'diagnostic', diagnosticId: 'diag-1' },
    );
    assert.equal(inspected.status, 'succeeded', inspected.effect);
    assert.equal(inspected.confirmation, 'server_sync');
    assert.equal(fake.bot.currentWindow, null, 'interface closed');
    const now = await predicates.evaluate(bound, signal());
    assert.equal(now.status, 'satisfied', now.detail);
    assert.equal(now.evidence['observedBy'], 'act-inspect1');
    await new Promise((r) => setTimeout(r, 5));
    const later = await predicates.evaluate(await predicates.bind(p, signal()), signal());
    assert.equal(later.status, 'unknown', 'an outcome bound after the read needs its own inspection');
  });
});
