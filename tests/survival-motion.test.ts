// S-C12-R4: real SkillExecutorImpl / Actuator / lease / recovery skill / tracker / server journal.
// Only the server and pathfinder physics are simulated. No fixture, credentials or inference.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, it } from 'node:test';
import { systemClock } from '../src/contracts/index.ts';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { clearSharedControls, SkillExecutorImpl } from '../src/execution/executor.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { survivalSkills } from '../src/skills/survival.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { fakeMineflayerBot, vec3, type FakeClient } from './skill-fakes.ts';
import { ID, OW, SESSION_OW, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, settle, slot, snapshot, type Slot } from './survival-helpers.ts';

after(cleanupRoots);
type Scenario = 'own' | 'resync_foreign' | 'moving_foreign' | 'late_foreign' | 'unknown' | 'orb' | 'merge' | 'cancel' | 'moving_own';

async function run(scenario: Scenario) {
  const h = harness();
  const kit = { 37: slot('bread', 4) };
  h.packets.inventory(kit);
  h.packets.health(20);
  dieWithItems(h, kit);
  const incidentId = h.service.deathContext().captureId!;
  h.service.linkIncident(incidentId, 'mf-0001');
  respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
  await settle(h);
  const d = h.service.assess(assessInput(h));
  assert.equal(d.kind, 'propose');
  h.service.onSupportAdmitted({ proposalId: (d as { proposal: SurvivalProposal }).proposal.proposalId, goalId: 'goal-r400', goalEpoch: 5, connectionEpoch: 1, admittedAtMs: h.clock.now() });
  await settle(h);
  const client = h.packets.client as unknown as FakeClient;
  const fake = fakeMineflayerBot(client, { dimension: SESSION_OW, at: { x: 24.5, y: 64, z: 10.5 } });
  fake.fill(0, 63, 0, 40, 63, 20, 'grass_block');
  const bot = fake.bot;
  const events = new EventEmitter();
  Object.assign(bot, { on: events.on.bind(events), off: events.off.bind(events), prependListener: events.prependListener.bind(events), emit: events.emit.bind(events) });
  bot.entity.id = 42;
  const evidence = new ServerEvidence(client, { items: Object.fromEntries(Object.entries(ID).map(([name, id]) => [id, { name }])), entitiesByName: { item: { id: 71 } } });
  evidence.attach();
  const session = { bot, evidence, connectionEpoch: 1 };
  const own = fake.addEntity({ id: 25, name: 'item', type: 'other', height: 0.25, at: { x: 30.5, y: 64, z: 10.5 } });
  h.packets.spawnItem(25, slot('bread', 4), own.position);
  const foreign = fake.addEntity({ id: 68, name: 'item', type: 'other', height: 0.25, at: { x: 34.5, y: 64, z: 10.5 } });
  if (scenario === 'resync_foreign' || scenario === 'moving_foreign' || scenario === 'late_foreign') h.packets.spawnItem(68, slot('bread', 64), foreign.position);
  else delete bot.entities[68];
  if (scenario === 'late_foreign') delete bot.entities[68]; // no local entity remains; packet history still supplies settlement identity
  let goal: { x: number; z: number } | null = null;
  let controls = false;
  let clearCount = 0;
  let starts = 0;
  let ticks = 0;
  let cancelledAt: number | undefined;
  let stoppedAt: number | undefined;
  const collected: number[] = [];
  const inventory: Record<number, Slot> = {};
  const abort = new AbortController();
  const collect = (id: number, count: number) => {
    collected.push(id);
    h.packets.collect(id, count);
    h.packets.destroy(id);
    delete bot.entities[id];
    if (id === 25) inventory[37] = slot('bread', count);
    if (id === 68) inventory[38] = slot('bread', count);
    h.packets.inventory(inventory);
  };
  Object.assign(bot, {
    clearControlStates: () => { controls = false; clearCount += 1; },
    pathfinder: {
      setMovements: () => undefined,
      setGoal: (g: { x: number; z: number } | null) => { goal = g; controls = Boolean(g); if (g) starts += 1; },
      isMoving: () => controls,
    },
  });
  client.write = (name, data) => {
    if (name === 'window_click') {
      if (scenario === 'late_foreign' && starts > 0 && !collected.includes(68)) collect(68, 64);
      if (scenario === 'resync_foreign' && starts === 0) {
        // Item moved during the real correlated inventory await, after initial target preflight.
        foreign.position = vec3(30.5, 64, 11.5);
        client.emit('sync_entity_position', { entityId: 68, x: 30.5, y: 64, z: 11.5 });
        events.emit('entityMoved', foreign);
      }
      h.packets.inventory(inventory);
    }
    if (name === 'block_dig') setImmediate(() => client.emit('acknowledge_player_digging', { sequenceId: data['sequence'] }));
  };
  // A pathfinder tick runs after any prepended recovery veto. Server collects use vanilla's inflated pickup reach.
  events.on('physicsTick', () => {
    if (!goal || !controls) return;
    const dx = goal.x + 0.5 - bot.entity.position.x;
    bot.entity.position = vec3(bot.entity.position.x + Math.sign(dx) * Math.min(Math.abs(dx), 0.4), 64, 10.5);
    for (const id of [25, 68]) {
      const e = bot.entities[id];
      if (e && bot.entity.position.distanceTo(e.position) <= 1.3) collect(id, id === 68 ? 64 : 4);
    }
    if (Math.abs(dx) <= 0.4) { controls = false; events.emit('goal_reached'); }
  });
  const snap = snapshot({ goalEpoch: 5, at: bot.entity.position });
  const ledger = new EvidenceLedger(systemClock);
  const services = {
    clock: systemClock, ledger, limits: { travelRadius: 128 },
    perception: {
      travelAnchorGoalEpoch: () => 5, latest: () => snap, withinTravel: () => true, travelBounds: () => undefined,
      resolve: () => ({ target: { kind: 'drop', entityId: 25, item: 'minecraft:bread' } }),
    },
  };
  const leases = new ActuatorLeases({ clock: systemClock, ownerCurrent: () => true, connectionEpoch: () => 1, clearShared: () => clearSharedControls(bot as never) });
  const executor = new SkillExecutorImpl({ registry: new SkillRegistry(survivalSkills(h.service)), leases, session: () => session as never, services: services as never, goalEpoch: () => 5, store: new MemoryRunStore(), settleMs: 0 });
  const interval = setInterval(() => {
    if (!starts) return;
    ticks += 1;
    if (ticks === 1 && scenario === 'moving_foreign') {
      foreign.position = vec3(30.5, 64, 11.5);
      client.emit('sync_entity_position', { entityId: 68, x: 30.5, y: 64, z: 11.5 });
      events.emit('entityMoved', foreign);
      if (!controls) stoppedAt = bot.entity.position.x;
    }
    if (ticks === 1 && scenario === 'moving_own') {
      own.position = vec3(32.5, 64, 10.5);
      client.emit('sync_entity_position', { entityId: 25, x: 32.5, y: 64, z: 10.5 });
      events.emit('entityMoved', own);
    }
    if (ticks === 1 && scenario === 'unknown') collect(999, 3);
    if (ticks === 1 && scenario === 'orb') {
      h.packets.spawnOther(998);
      collect(998, 1);
    }
    if (ticks === 1 && scenario === 'merge') {
      h.packets.client.emit('entity_metadata', { entityId: 25, metadata: [{ key: 8, type: 'item_stack', value: slot('bread', 64) }] });
      // Collect arrives before any navigation poll; the frozen 4-item plan cannot credit part of the 64-stack.
      collect(25, 64);
    }
    if (ticks === 1 && scenario === 'cancel') { cancelledAt = bot.entity.position.x; abort.abort(); }
    events.emit('physicsTick');
  }, 20);
  try {
    const outcome = await executor.execute({ id: 'act-r400', capability: 'recover_lost_items', connectionEpoch: 1, goalEpoch: 5, timeoutMs: 2_000, parameters: { target: { snapshotId: 'snap-r400', handle: 'drp-1' } } } as never, abort.signal, { kind: 'goal', goalId: 'goal-r400', goalEpoch: 5, taskId: 'task-r400' });
    return { outcome, starts, controls, clearCount, collected, at: bot.entity.position.x, cancelledAt, stoppedAt, returns: h.service.incidentReturns(incidentId), incident: h.service.status(h.clock.now()).incidents[0], effects: ledger.since(0), listeners: events.eventNames().filter((e) => e !== 'physicsTick'), tickListeners: events.listenerCount('physicsTick') };
  } finally {
    clearInterval(interval);
    evidence.detach();
    await h.service.close();
  }
}

it('R4: a foreign pile moving during inventory resync prevents the first path command', async () => {
  const r = await run('resync_foreign');
  assert.equal(r.starts, 0, JSON.stringify(r.outcome));
  assert.deepEqual(r.collected, []);
  assert.equal(r.outcome.reason, 'unrelated_loot_nearby');
  assert.equal(r.controls, false);
});

it('R4: a moving foreign pile at the destination stops approach between navigation polls, before passive pickup', async () => {
  const r = await run('moving_foreign');
  assert.equal(r.stoppedAt, 24.5, JSON.stringify(r.outcome));
  assert.equal(r.at, 24.5);
  assert.deepEqual(r.collected, []);
  assert.equal(r.outcome.reason, 'unrelated_loot_nearby');
  assert.equal(r.controls, false);
  assert.deepEqual(r.listeners, [], 'all recovery event vetoes are removed');
  assert.equal(r.tickListeners, 1, 'only the simulated pathfinder tick remains');
});

it('R4: a foreign collect during post-stop inventory settlement is reported by key without effect/own-return credit', async () => {
  const r = await run('late_foreign');
  assert.equal(r.outcome.status, 'partial');
  assert.deepEqual(r.returns?.regained, { 'minecraft:bread': 4 });
  assert.deepEqual(r.incident?.incidental?.map((x) => [x.key, x.count]), [['minecraft:bread', 64]]);
  assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up').map((e) => e.count), [4]);
});

it('R4: exact own bread returns4; unknown collect stays unknown; known orb remains excluded', async () => {
  for (const scenario of ['own', 'unknown', 'orb'] as const) {
    const r = await run(scenario);
    assert.equal(r.returns?.regained['minecraft:bread'], 4, JSON.stringify(r.outcome));
    assert.equal(r.returns?.attribution, scenario === 'unknown' ? 'unknown' : 'server_attributed');
    assert.equal(r.outcome.status, scenario === 'unknown' ? 'partial' : 'succeeded');
    assert.equal(r.controls, false);
    assert.ok(r.clearCount > 0);
  }
});

it('R4: a planned pile merged into bread64 immediately before collect is incidental64, never own returned4', async () => {
  const r = await run('merge');
  assert.deepEqual(r.returns?.regained, {}, JSON.stringify(r.outcome));
  assert.equal(r.returns?.attribution, 'unknown');
  assert.deepEqual(r.incident?.incidental?.map((x) => [x.key, x.count]), [['minecraft:bread', 64]]);
  assert.equal(r.outcome.status, 'partial');
  assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up'), []);
});

it('R4: cancellation revokes path and controls; no subsequent tick advances or collects', async () => {
  const r = await run('cancel');
  assert.equal(r.outcome.status, 'cancelled');
  assert.equal(r.at, r.cancelledAt);
  assert.deepEqual(r.collected, []);
  assert.equal(r.controls, false);
  assert.equal(r.outcome.evidence['commandsAfterRevoke'], 0);
});

it('R4: a moving own drop is freshly targeted within original bounds and still returns exactly4', async () => {
  const r = await run('moving_own');
  assert.ok(r.starts >= 2, JSON.stringify(r.outcome));
  assert.equal(r.outcome.status, 'succeeded');
  assert.deepEqual(r.returns?.regained, { 'minecraft:bread': 4 });
});
