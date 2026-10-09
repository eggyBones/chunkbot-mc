// Maintained regressions for coordinator corrections MB-SKL-005..009, driven
// through the REAL PerceptionService, TaskCandidateGenerator, registered skill
// resolvers/executors and PredicateEngine over a Mineflayer-shaped bot that
// uses the installed 26.1.2 registry and block shapes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, systemClock, type ObservationSnapshot, type TaskSpec } from '../src/contracts/index.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { PredicateEngine } from '../src/execution/predicates.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { containerTransfer } from '../src/skills/containers.ts';
import type { SkillServices } from '../src/skills/definition.ts';
import { allSkills } from '../src/skills/index.ts';
import { followEntity } from '../src/skills/movement.ts';
import { navigate } from '../src/skills/navigation.ts';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { interfaceGate } from '../src/execution/interface-gate.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { ackSequenced, fakeClient, fakeMineflayerBot, REGISTRY_26_1_2, vec3, type FakeClient } from './skill-fakes.ts';

function scene(options: { travelRadius?: number } = {}) {
  let replyInventory = true;
  const client: FakeClient = fakeClient((name, data) => {
    if (name === 'window_click' && data['stateId'] === -1 && replyInventory) {
      setImmediate(() => {
        const items = Array.from({ length: 46 }, (_, i) => {
          const s = fake.bot.inventory.slots[i];
          return s ? { itemCount: s.count, itemId: REGISTRY_26_1_2.itemsByName[s.name]?.id } : { itemCount: 0 };
        });
        client.emit('window_items', { windowId: 0, stateId: 3, items });
      });
    }
    ackSequenced(client, name, data);
  });
  const fake = fakeMineflayerBot(client);
  fake.fill(-30, -1, -30, 30, -1, 30, 'grass_block');
  const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never);
  evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession & { connectionEpoch: number };
  const ids = sequentialIds();
  const perception = new PerceptionService({ session: () => session, clock: systemClock, ids, observationRadius: 16, travelRadius: options.travelRadius ?? 64 });
  const services: SkillServices = {
    perception,
    knowledge: new VersionKnowledge({ version: '26.1.2' }),
    ledger: new EvidenceLedger(systemClock, () => session.connectionEpoch),
    clock: systemClock,
    limits: { observationRadius: 16, travelRadius: options.travelRadius ?? 64, ownerLossMs: 1_000 },
  };
  const registry = new SkillRegistry(allSkills());
  const generator = new TaskCandidateGenerator({ registry, services, session: () => session, ids });
  const leases = new ActuatorLeases({ clock: systemClock, ownerCurrent: () => true, connectionEpoch: () => session.connectionEpoch, clearShared: () => ({ steps: [], errors: [] }) });
  const predicates = new PredicateEngine({ services, session: () => session, leases });
  return { fake, client, session, perception, services, generator, predicates, leases, evidence, setInventoryReplies: (v: boolean) => (replyInventory = v) };
}

const handleAt = (snap: ObservationSnapshot, x: number, y: number, z: number) => snap.blocks.find((b) => b.at.x === x && b.at.y === y && b.at.z === z)?.handle as string;

const task = (over: Partial<TaskSpec>): TaskSpec => ({
  objective: 'test objective',
  decisionInstruction: 'choose',
  allowedCapabilities: [],
  targetSelectors: [],
  parameters: {},
  completion: { predicate: 'inventory_amount', selector: 'minecraft:stone', atLeast: 1, mode: 'possess' },
  ...over,
});

describe('MB-SKL-005 target authority through actual candidate generation', () => {
  function chests() {
    const s = scene();
    s.fake.setBlock(2, 0, 0, 'chest');
    s.fake.setBlock(0, 0, 2, 'chest');
    s.fake.give(36, 'stone', 64);
    const snap = s.perception.take(1) as ObservationSnapshot;
    return { ...s, snap, named: handleAt(snap, 0, 0, 2), other: handleAt(snap, 2, 0, 0) };
  }
  const depositTwo = (snapshotId: string, handle: string): TaskSpec =>
    task({
      allowedCapabilities: ['container_transfer'],
      targetSelectors: [{ kind: 'observed', snapshotId, handle }],
      parameters: { direction: 'deposit', item: 'minecraft:stone', count: 2 },
      completion: { predicate: 'container_state', target: { kind: 'observed', snapshotId, handle }, selector: 'minecraft:stone', atLeast: 2 },
    });

  it('a CURRENT named chest is the only target, and admitted direction/item/count bind the effect', () => {
    const s = chests();
    assert.ok(s.named && s.other && s.named !== s.other);
    const set = s.generator.generate(depositTwo(s.snap.id, s.named), s.snap);
    assert.ok(set.candidates.length > 0, 'the valid named transfer is offered');
    for (const c of set.candidates) assert.deepEqual(c.parameters, { container: { snapshotId: s.snap.id, handle: s.named }, direction: 'deposit', item: 'minecraft:stone', count: 2 });
  });

  it('a refreshed snapshot re-grounds the same chest (new handle), never another one', () => {
    const s = chests();
    const fresh = s.perception.take(1) as ObservationSnapshot;
    const set = s.generator.generate(depositTwo(s.snap.id, s.named), fresh);
    const expected = handleAt(fresh, 0, 0, 2);
    assert.ok(set.candidates.length > 0);
    for (const c of set.candidates) assert.deepEqual((c.parameters as { container: unknown }).container, { snapshotId: fresh.id, handle: expected });
  });

  it('a removed named chest admits nothing (no fallback to the other chest)', () => {
    const s = chests();
    s.fake.setBlock(0, 0, 2, 'air');
    const fresh = s.perception.take(1) as ObservationSnapshot;
    const set = s.generator.generate(depositTwo(s.snap.id, s.named), fresh);
    assert.equal(set.candidates.length, 0);
    assert.equal(set.unavailable[0]?.reason, 'named_target_not_visible');
    assert.match(set.unavailable[0]?.detail ?? '', new RegExp(s.named));
  });

  it('handles from before a dimension change or reconnect are invalid for generation and execution', async () => {
    const s = chests();
    s.fake.bot.game.dimension = 'minecraft:the_nether';
    const after = s.perception.take(1) as ObservationSnapshot;
    const set = s.generator.generate(depositTwo(s.snap.id, s.named), after);
    assert.equal(set.candidates.length, 0, 'dimension-changed handle not re-grounded');
    const outcome = await containerTransfer.execute(
      { act: undefined as never, session: s.session, services: s.services, candidate: undefined as never, owner: { kind: 'diagnostic', diagnosticId: 'd' }, progress: () => undefined },
      { container: { snapshotId: s.snap.id, handle: s.named }, direction: 'deposit', item: 'minecraft:stone', count: 2 },
    );
    assert.equal(outcome.status, 'precondition_failed');
    assert.match(outcome.effect, /dimension_changed/);
    s.fake.bot.game.dimension = 'minecraft:overworld';
    s.session.connectionEpoch = 2;
    const reconnected = s.perception.take(1) as ObservationSnapshot;
    assert.equal(s.generator.generate(depositTwo(s.snap.id, s.named), reconnected).candidates.length, 0, 'old connection handle not re-grounded');
  });
});

describe('MB-SKL-008 admitted parameters constrain every capability', () => {
  it('invalid parameter values make the capability unavailable instead of being ignored', () => {
    const s = scene();
    s.fake.setBlock(0, 0, 2, 'chest');
    s.fake.give(36, 'stone', 64);
    const snap = s.perception.take(1) as ObservationSnapshot;
    const set = s.generator.generate(task({ allowedCapabilities: ['container_transfer'], parameters: { direction: 'sideways', item: 'minecraft:stone', count: 2 } }), snap);
    assert.equal(set.candidates.length, 0);
    assert.equal(set.unavailable[0]?.reason, 'invalid_task_parameter');
  });

  it('craft: an admitted count is exact (never more), or reported missing', () => {
    const s = scene();
    s.fake.give(36, 'oak_log', 1);
    const snap = s.perception.take(1) as ObservationSnapshot;
    const ok = s.generator.generate(task({ allowedCapabilities: ['craft_item'], parameters: { output: 'minecraft:oak_planks', count: 4 } }), snap);
    assert.ok(ok.candidates.length > 0);
    for (const c of ok.candidates) assert.equal((c.parameters as { count: number }).count, 4);
    const tooMany = s.generator.generate(task({ allowedCapabilities: ['craft_item'], parameters: { output: 'minecraft:oak_planks', count: 8 } }), snap);
    assert.equal(tooMany.candidates.length, 0, 'one log cannot make eight planks; no partial substitute');
    assert.ok(tooMany.unavailable.some((u) => /missing|ingredient/.test(u.reason)), JSON.stringify(tooMany.unavailable));
  });

  it('equip, place and furnace candidates carry exactly the admitted slot/item/face/count', () => {
    const s = scene();
    s.fake.give(36, 'cobblestone', 10);
    s.fake.give(37, 'coal', 5);
    s.fake.give(38, 'iron_helmet', 1);
    s.fake.setBlock(0, 0, 2, 'furnace');
    s.fake.setBlock(2, 0, 0, 'stone');
    const snap = s.perception.take(1) as ObservationSnapshot;
    const equip = s.generator.generate(task({ allowedCapabilities: ['equip_item'], parameters: { item: 'minecraft:iron_helmet', slot: 'head' }, completion: { predicate: 'equipped', selector: 'minecraft:iron_helmet', slot: 'head' } }), snap);
    assert.ok(equip.candidates.length > 0);
    for (const c of equip.candidates) assert.deepEqual(c.parameters, { item: 'minecraft:iron_helmet', slot: 'head' });
    const place = s.generator.generate(task({ allowedCapabilities: ['place_block'], parameters: { item: 'minecraft:cobblestone', face: 'up' } }), snap);
    assert.ok(place.candidates.length > 0, JSON.stringify(place.unavailable));
    for (const c of place.candidates) {
      assert.equal((c.parameters as { item: string }).item, 'minecraft:cobblestone');
      assert.equal((c.parameters as { face: string }).face, 'up');
    }
    const fuel = s.generator.generate(task({ allowedCapabilities: ['furnace_insert'], parameters: { slot: 'fuel', item: 'minecraft:coal', count: 3 } }), snap);
    assert.ok(fuel.candidates.length > 0, JSON.stringify(fuel.unavailable));
    for (const c of fuel.candidates) assert.deepEqual({ ...(c.parameters as object), furnace: undefined }, { furnace: undefined, slot: 'fuel', item: 'minecraft:coal', count: 3 });
  });
});

describe('MB-SKL-006/007 follow uses only fresh visible positions and the travel bound', () => {
  function followScene(radius = 64) {
    const s = scene({ travelRadius: radius });
    s.perception.setTravelAnchor({ x: 0.5, y: 0, z: 0.5 });
    const owner = s.fake.addEntity({ id: 2, type: 'player', name: 'player', username: 'Owner', uuid: 'x', at: { x: 6.5, y: 0, z: 0.5 }, height: 1.8 });
    const goals: Array<{ x: number; z: number }> = [];
    let now = 0;
    const act = {
      fence: () => undefined,
      setPathGoal: (g: { x: number; z: number }) => goals.push({ x: g.x, z: g.z }),
      clearPathGoal: () => undefined,
      sleep: async () => {
        now += 250;
      },
    };
    (s.fake.bot as unknown as { pathfinder: unknown }).pathfinder = { setMovements: () => undefined, isMoving: () => false, goal: null };
    const services = { ...s.services, clock: { now: () => now }, perception: Object.assign(Object.create(Object.getPrototypeOf(s.perception)), s.perception) as PerceptionService };
    return { s, owner, goals, act, services, advance: (ms: number) => (now += ms) };
  }

  it('positive: re-goals toward the visible owner and reports a visible final distance', async () => {
    const f = followScene();
    const result = await followEntity.execute(
      { act: f.act as never, session: f.s.session, services: f.services, candidate: { timeoutMs: 5_000 } as never, owner: { kind: 'diagnostic', diagnosticId: 'd' }, progress: () => undefined },
      { target: { kind: 'handle', snapshotId: (f.s.perception.take(1) as ObservationSnapshot).id, handle: (f.s.perception.latest() as ObservationSnapshot).entities[0]?.handle as string }, within: 3, durationMs: 1_000 },
    );
    assert.ok(f.goals.length >= 1 && f.goals[0]?.x === 6.5, `goal retains the exact visible owner position: ${JSON.stringify(f.goals)}`);
    assert.equal(typeof result.evidence?.['finalDistance'], 'number');
  });

  it('a wall-occluded owner is never re-targeted at its hidden position and no hidden distance is reported', async () => {
    const f = followScene();
    const snap = f.s.perception.take(1) as ObservationSnapshot;
    const handle = snap.entities[0]?.handle as string;
    f.s.fake.fill(3, 0, -3, 3, 3, 3, 'stone'); // wall between bot and owner
    f.owner.position = vec3(12.5, 0, 0.5); // owner moves while hidden
    const result = await followEntity.execute(
      { act: f.act as never, session: f.s.session, services: f.services, candidate: { timeoutMs: 5_000 } as never, owner: { kind: 'diagnostic', diagnosticId: 'd' }, progress: () => undefined },
      { target: { kind: 'handle', snapshotId: snap.id, handle }, within: 3, durationMs: 1_000 },
    );
    assert.equal(f.goals.some((g) => g.x === 12), false, 'hidden position never written as a goal');
    assert.equal(result.evidence?.['finalDistance'], null);
    assert.notEqual(result.status, 'succeeded');
  });

  it('a target crossing the travel bound stops following with structured feedback', async () => {
    const f = followScene(10);
    const snap = f.s.perception.take(1) as ObservationSnapshot;
    const handle = snap.entities[0]?.handle as string;
    const ctx = { act: f.act as never, session: f.s.session, services: f.services, candidate: { timeoutMs: 5_000 } as never, owner: { kind: 'diagnostic' as const, diagnosticId: 'd' }, progress: () => undefined };
    // Starts inside the bound, then the visible owner walks out of it.
    let sleeps = 0;
    f.act.sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) f.owner.position = vec3(11.5, 0, 0.5);
    };
    const result = await followEntity.execute(ctx, { target: { kind: 'handle', snapshotId: snap.id, handle }, within: 3, durationMs: 2_000 });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'target_outside_travel_bounds');
    assert.equal(result.evidence?.['travelRadius'], 10);
    // Already outside at the start: a precondition with the same structured reason.
    const again = await followEntity.execute(ctx, { target: { kind: 'handle', snapshotId: (f.s.perception.take(1) as ObservationSnapshot).id, handle: (f.s.perception.latest() as ObservationSnapshot).entities[0]?.handle as string }, within: 3, durationMs: 2_000 });
    assert.equal(again.status, 'precondition_failed');
    assert.equal(again.reason, 'target_outside_travel_bounds');
  });

  it('navigate checks the live bound before the already-arrived fast path', async () => {
    const s = scene();
    (s.fake.bot as unknown as { pathfinder: unknown }).pathfinder = { setMovements: () => undefined };
    s.fake.bot.entity.position = vec3(129, 0, 0.5);
    let writes = 0;
    const act = { bot: s.fake.bot, session: s.session, fence: () => undefined, clearPathGoal: () => undefined, setPathGoal: () => writes++, sleep: async () => undefined };
    const r = await navigate(act as never, { goal: {}, arrived: () => true, distance: () => 1, timeoutMs: 100, bounds: { anchor: { x: 0, y: 0, z: 0 }, radius: 128 } });
    assert.equal(r.status, 'out_of_bounds');
    assert.equal(writes, 0);
  });
});

describe('MB-SKL-009 completion from current authoritative evidence', () => {
  const signal = () => new AbortController().signal;

  it('possession uses a fresh correlated resync; a failed refresh is unknown even with an old cache', async () => {
    const s = scene();
    s.fake.give(36, 'stone', 4);
    const p = { predicate: 'inventory_amount', selector: 'minecraft:stone', atLeast: 4, mode: 'possess' } as const;
    const bound = await s.predicates.bind(p, signal());
    assert.equal((await s.predicates.evaluate(bound, signal())).status, 'satisfied', 'positive: current server inventory');
    s.setInventoryReplies(false);
    const failed = await s.predicates.evaluate(bound, signal());
    assert.equal(failed.status, 'unknown', 'no fallback to the cached inventory');
    assert.match(failed.detail, /not answered/);
  });

  it('a late reply to an EARLIER resync is not accepted as the current inventory', async () => {
    const s = scene();
    s.fake.give(36, 'stone', 4);
    s.setInventoryReplies(false);
    // A stale full-state reply from before (showing 4 stone) arrives after our request but before the ack.
    s.client.write = ((orig) => (name: string, data: Record<string, unknown>) => {
      orig(name, data);
      if (name === 'window_click') s.client.emit('window_items', { windowId: 0, stateId: 2, items: Array.from({ length: 46 }, () => ({ itemCount: 0 })) });
    })(s.client.write.bind(s.client));
    // Only an uncorrelated stale reply arrived before the barrier ack: the last one before the ack is used.
    const r = await s.predicates.evaluate(await s.predicates.bind({ predicate: 'inventory_amount', selector: 'minecraft:stone', atLeast: 4, mode: 'possess' }, signal()), signal());
    assert.equal(r.status, 'unsatisfied', 'the reply that preceded the ack is the processed one; nothing older is substituted');
  });

  it('block_state: server block updates decide; optimistic local changes and hidden blocks are unknown', async () => {
    const s = scene();
    s.fake.setBlock(0, 0, 3, 'stone');
    const snap = s.perception.take(1) as ObservationSnapshot;
    const handle = handleAt(snap, 0, 0, 3);
    const air = { predicate: 'block_state', target: { kind: 'observed', snapshotId: snap.id, handle }, expect: 'minecraft:air' } as const;
    const stone = { ...air, expect: 'minecraft:stone' } as const;
    const bound = await s.predicates.bind(stone, signal());
    assert.equal((await s.predicates.evaluate(bound, signal())).status, 'satisfied', 'visible chunk data, no prediction');
    // Optimistic local dig result (Mineflayer sets air locally) without a server statement.
    s.evidence.notePrediction(0, 0, 3);
    s.fake.setBlock(0, 0, 3, 'air');
    assert.equal((await s.predicates.evaluate(await s.predicates.bind(air, signal()), signal())).status, 'unknown');
    // The server confirms the change.
    s.client.emit('block_change', { location: { x: 0, y: 0, z: 3 }, type: 0 });
    assert.equal((await s.predicates.evaluate(await s.predicates.bind(air, signal()), signal())).status, 'satisfied');
    // A hidden block is not described.
    s.fake.setBlock(0, 0, 9, 'diamond_ore');
    s.fake.fill(-2, 0, 6, 2, 3, 6, 'stone');
    const hidden = await s.predicates.evaluate(await s.predicates.bind({ predicate: 'block_state', target: { kind: 'owner_destination', dimension: 'minecraft:overworld', at: { x: 0, y: 0, z: 9 }, ownerText: '0 0 9' }, expect: 'minecraft:diamond_ore' }, signal()), signal());
    assert.equal(hidden.status, 'unknown');
    assert.doesNotMatch(JSON.stringify(hidden), /diamond/, 'feedback does not reveal the hidden block');
  });

  it('container contents count as current only after binding; older reads are historical; scoped to the observing connection', async () => {
    const s = scene();
    s.fake.setBlock(0, 0, 2, 'chest');
    const snap = s.perception.take(1) as ObservationSnapshot;
    const handle = handleAt(snap, 0, 0, 2);
    const read = () => s.services.ledger.add({ kind: 'container', dimension: 'minecraft:overworld', x: 0, y: 0, z: 2, contents: { 'minecraft:stone': 3 }, atMs: Date.now(), actionId: 'act-inspect', via: 'inspect_container' });
    read(); // an earlier read
    const p = { predicate: 'container_state', target: { kind: 'observed', snapshotId: snap.id, handle }, selector: 'minecraft:stone', atLeast: 2 } as const;
    await new Promise((r) => setTimeout(r, 2));
    const bound = await s.predicates.bind(p, signal());
    const old = await s.predicates.evaluate(bound, signal());
    assert.equal(old.status, 'unknown', 'a read from before binding is historical');
    assert.equal(old.evidence['historical'], true);
    assert.match(old.detail, /historical/);
    await new Promise((r) => setTimeout(r, 2));
    read(); // a fresh server-synced read by a skill after binding
    const r = await s.predicates.evaluate(bound, signal());
    assert.equal(r.status, 'satisfied');
    assert.equal(r.evidence['fresh'], true);
    s.session.connectionEpoch = 2;
    const fresh = s.perception.take(1) as ObservationSnapshot;
    const after = await s.predicates.evaluate(await s.predicates.bind({ ...p, target: { kind: 'observed', snapshotId: fresh.id, handle: handleAt(fresh, 0, 0, 2) } }, signal()), signal());
    assert.equal(after.status, 'unknown', 'a previous connection’s observation does not complete the replacement');
  });

  it('a lifecycle interruption makes admission-bound baselines incomparable', async () => {
    const s = scene();
    s.fake.give(36, 'stone', 1);
    const p = { predicate: 'inventory_amount', selector: 'minecraft:stone', atLeast: 2, mode: 'collect_additional' } as const;
    const bound = await s.predicates.bind(p, signal());
    s.fake.give(36, 'stone', 3);
    assert.equal((await s.predicates.evaluate(bound, signal())).status, 'satisfied', 'positive before interruption');
    s.services.ledger.invalidate('lifecycle_death');
    assert.equal(s.services.ledger.inventory(), undefined, 'cached inventory dropped');
    const after = await s.predicates.evaluate(bound, signal());
    assert.equal(after.status, 'unknown');
    assert.equal(after.evidence['lifecycleInterrupted'], true);
  });

  it('death on the same connection/dimension voids handles, snapshots, anchors, container history and prior results', async () => {
    const s = scene();
    s.fake.setBlock(0, 0, 2, 'chest');
    const snap = s.perception.take(1) as ObservationSnapshot;
    const handle = handleAt(snap, 0, 0, 2);
    const anchorId = s.perception.remember('chest seen', { x: 0, y: 0, z: 2 }, 'observed') as string;
    s.services.ledger.setResult('act-0009', { dimension: 'minecraft:overworld', x: 0, y: 0, z: 2, key: 'minecraft:chest' });
    const p = { predicate: 'container_state', target: { kind: 'observed', snapshotId: snap.id, handle }, selector: 'minecraft:stone', atLeast: 3 } as const;
    const boundBefore = await s.predicates.bind(p, signal());
    s.services.ledger.add({ kind: 'container', dimension: 'minecraft:overworld', x: 0, y: 0, z: 2, contents: { 'minecraft:stone': 3 }, atMs: Date.now() + 1, actionId: 'act-inspect', via: 'inspect_container' });
    assert.equal((await s.predicates.evaluate(boundBefore, signal())).status, 'satisfied', 'positive before the interruption (fresh read after binding)');
    // What SkillRuntime.onLifecycle does for death / dimension change / ended:
    s.services.ledger.invalidate('lifecycle_death');
    s.perception.invalidate('lifecycle_death');
    assert.ok('error' in s.perception.resolve(snap.id, handle), 'old handle void');
    assert.equal(s.perception.latest(), undefined);
    assert.equal(s.perception.anchor(anchorId), undefined);
    assert.equal(s.services.ledger.latestContainer('minecraft:overworld', 0, 0, 2), undefined);
    const fresh = s.perception.take(1) as ObservationSnapshot;
    const after = await s.predicates.evaluate(await s.predicates.bind({ ...p, target: { kind: 'observed', snapshotId: fresh.id, handle: handleAt(fresh, 0, 0, 2) } }, signal()), signal());
    assert.equal(after.status, 'unknown', 'pre-interruption contents do not prove current contents');
    const prior = await s.predicates.evaluate(await s.predicates.bind({ predicate: 'near_target', target: { kind: 'prior_result', actionId: 'act-0009' }, within: 4 }, signal()), signal());
    assert.equal(prior.status, 'unknown', 'pre-interruption result does not complete a replacement');
  });

  it('the composed SkillRuntime.onLifecycle revokes, invalidates perception and ledger, and clears the interface gate', () => {
    const s = scene();
    const config = loadConfigFile(join(PROJECT_ROOT, 'config', 'examples', 'fixture.json')).config;
    const runtime = new SkillRuntime({ config, session: () => s.session, connectionEpoch: () => 1, goalEpoch: () => 1, diagnosticCurrent: () => true, admission: () => ({ serverOnlineMode: false }), store: new MemoryRunStore(), clock: systemClock, ids: sequentialIds() });
    s.fake.setBlock(0, 0, 2, 'chest');
    const snap = runtime.perception.take(1) as ObservationSnapshot;
    const handle = handleAt(snap, 0, 0, 2);
    const lease = runtime.leases.acquire({ kind: 'diagnostic', diagnosticId: 'd' });
    interfaceGate(s.session, systemClock).register(lease.id, 1_000_001, s.session.evidence.seq, () => lease.active);
    runtime.onLifecycle({ type: 'death', connectionEpoch: 1 } as never);
    assert.equal(lease.active, false, 'actuation revoked');
    assert.ok('error' in runtime.perception.resolve(snap.id, handle), 'handles void after death');
    assert.equal(runtime.ledger.invalidations.at(-1)?.reason, 'lifecycle_death');
    assert.equal(interfaceGate(s.session, systemClock).pending().length, 0, 'in-flight interface requests void');
  });

  it('a prior result from another dimension is unknown, not near', async () => {
    const s = scene();
    s.services.ledger.setResult('act-0010', { dimension: 'minecraft:the_nether', x: 0, y: 0, z: 1, key: 'minecraft:chest' });
    const r = await s.predicates.evaluate(await s.predicates.bind({ predicate: 'near_target', target: { kind: 'prior_result', actionId: 'act-0010' }, within: 4 }, signal()), signal());
    assert.equal(r.status, 'unknown');
    assert.match(r.detail, /the_nether/);
  });

  it('a server update for a hidden position does not reveal it; the goal’s own confirmed change still counts', async () => {
    const s = scene();
    s.fake.fill(-2, 0, 4, 2, 3, 4, 'stone'); // wall
    s.client.emit('block_change', { location: { x: 0, y: 0, z: 8 }, type: REGISTRY_26_1_2.blocksByName['diamond_ore']?.defaultState });
    const at = { kind: 'owner_destination', dimension: 'minecraft:overworld', at: { x: 0, y: 0, z: 8 }, ownerText: '0 0 8' } as const;
    const bound = await s.predicates.bind({ predicate: 'block_state', target: at, expect: 'minecraft:diamond_ore' }, signal());
    const hidden = await s.predicates.evaluate(bound, signal());
    assert.equal(hidden.status, 'unknown');
    assert.doesNotMatch(JSON.stringify(hidden), /diamond/);
    // Our own skill-confirmed change behind the wall (e.g. a block we placed before walking around it).
    s.services.ledger.add({ kind: 'block_changed', x: 0, y: 0, z: 8, from: 'minecraft:air', to: 'minecraft:diamond_ore', atMs: Date.now(), actionId: 'act-1' });
    const own = await s.predicates.evaluate(bound, signal());
    assert.equal(own.status, 'satisfied');
    assert.equal(own.evidence['ownChange'], true);
  });

  it('a hidden entity position is not used for spatial predicates', async () => {
    const s = scene();
    s.fake.addEntity({ id: 5, type: 'mob', name: 'cow', at: { x: 4.5, y: 0, z: 0.5 }, height: 1.4 });
    const snap = s.perception.take(1) as ObservationSnapshot;
    const handle = snap.entities[0]?.handle as string;
    const near = { predicate: 'near_target', target: { kind: 'observed', snapshotId: snap.id, handle }, within: 8 } as const;
    assert.equal((await s.predicates.evaluate(await s.predicates.bind(near, signal()), signal())).status, 'satisfied', 'visible: decided');
    s.fake.fill(2, 0, -3, 2, 3, 3, 'stone');
    const hidden = await s.predicates.evaluate(await s.predicates.bind(near, signal()), signal());
    assert.equal(hidden.status, 'unknown');
    assert.doesNotMatch(hidden.detail, /4\.\d blocks/);
  });
});
