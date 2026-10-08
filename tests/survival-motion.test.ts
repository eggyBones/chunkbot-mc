// S-C12-R4: real SkillExecutorImpl / Actuator / lease / recovery skill / tracker / server journal.
// Only the server and pathfinder physics are simulated. No fixture, credentials or inference.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, it } from 'node:test';
import { systemClock, type JsonValue } from '../src/contracts/index.ts';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { clearSharedControls, SkillExecutorImpl } from '../src/execution/executor.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { navigateRecoveryTravel, survivalSkills } from '../src/skills/survival.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { fakeMineflayerBot, vec3, type FakeClient } from './skill-fakes.ts';
import { goals } from '../src/skills/navigation.ts';
import { precondition, type AnySkill } from '../src/skills/definition.ts';
import { ID, OW, SESSION_OW, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, settle, slot, snapshot, type Slot } from './survival-helpers.ts';

after(cleanupRoots);
type Scenario = 'own' | 'resync_foreign' | 'moving_foreign' | 'late_foreign' | 'unknown' | 'orb' | 'merge' | 'cancel' | 'moving_own' | 'wrong_identity' | 'reuse' | 'identity_count' | 'identity_neighbors' | 'foreign_recedes' | 'reuse_gap' | 'reuse_gap_collect' | 'collected_destroyed' | 'unstated_drop' | 'missing_origin' | 'foreign_origin' | 'unsought' | 'reuse_stated' | 'merge_stated' | 'veto_cancel';

async function run(scenario: Scenario, route: boolean | 'site' = false) {
  const h = harness();
  const splitIdentity = scenario === 'identity_count' || scenario === 'identity_neighbors';
  const kit = { 37: slot('bread', 4), ...(splitIdentity ? { 38: slot('bread', 4, [{ type: 'custom_name', data: 'own named bread' }]) } : {}) };
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
  const authority = () => { const i = h.service.status(h.clock.now()).incidents[0]!; return structuredClone({ attempts: i.attempts, budget: i.budget }); };
  const authorityBefore = authority();
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
  h.packets.spawnItem(25, slot('bread', scenario === 'identity_count' ? 8 : 4, scenario === 'wrong_identity' ? [{ type: 'custom_name', data: 'foreign bread' }] : []), own.position);
  const foreign = fake.addEntity({ id: 68, name: 'item', type: 'other', height: 0.25, at: { x: 34.5, y: 64, z: 10.5 } });
  if (scenario === 'resync_foreign' || scenario === 'moving_foreign' || scenario === 'late_foreign') h.packets.spawnItem(68, slot('bread', 64), foreign.position);
  else if (scenario === 'foreign_recedes' || scenario === 'veto_cancel') { foreign.position = vec3(30.5, 64, 11.5); h.packets.spawnItem(68, slot('bread', 64), foreign.position); }
  else if (scenario === 'identity_neighbors') { foreign.position = vec3(30.5, 64, 11.5); h.packets.spawnItem(68, slot('bread', 4), foreign.position); }
  else if (scenario === 'unstated_drop' || scenario === 'missing_origin' || scenario === 'foreign_origin' || scenario === 'unsought') {
    foreign.position = vec3(25.5, 64, 10.5);
    if (scenario === 'unstated_drop') h.packets.spawnItemWithoutStack(68, foreign.position);
    if (scenario === 'foreign_origin') {
      h.packets.spawnItem(68, slot('bread', 4), { x: 0, y: 64, z: 0 });
      client.emit('sync_entity_position', { entityId: 68, x: 25.5, y: 64, z: 10.5 });
    }
    if (scenario === 'unsought') h.packets.spawnItem(68, slot('dirt', 4), foreign.position);
  }
  else delete bot.entities[68];
  if (scenario === 'late_foreign') delete bot.entities[68]; // no local entity remains; packet history still supplies settlement identity
  const statedBefore = { own: h.service.dropFacts(1, 25), neighbour: h.service.dropFacts(1, 68) };
  let goal: { x: number; z: number } | null = null;
  let controls = false;
  let clearCount = 0;
  let starts = 0;
  let ticks = 0;
  let cancelledAt: number | undefined;
  let stoppedAt: number | undefined;
  let metadataGapAt: number | undefined;
  let gapHadFacts: boolean | undefined;
  let motionAfterGap = 0;
  const collected: number[] = [];
  const inventory: Record<number, Slot> = {};
  const abort = new AbortController();
  const collect = (id: number, count: number) => {
    collected.push(id);
    h.packets.collect(id, count);
    h.packets.destroy(id);
    delete bot.entities[id];
    if (id === 25 && scenario === 'collected_destroyed') events.emit('entityUpdate', own);
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
      // An unavoidable server collect arrives only during the post-stop correlated resync, without new metadata.
      if (scenario === 'reuse_gap_collect' && metadataGapAt !== undefined && !collected.includes(25)) collect(25, 4);
      if (scenario === 'foreign_recedes' && starts === 0) {
        h.clock.advance(50);
        foreign.position = vec3(34.5, 64, 10.5);
        client.emit('sync_entity_position', { entityId: 68, x: 34.5, y: 64, z: 10.5 });
        client.emit('entity_metadata', { entityId: 68, metadata: [{ key: 8, type: 'item_stack', value: slot('dirt', 1) }] });
        events.emit('entityMoved', foreign);
        events.emit('entityUpdate', foreign);
      }
      // Revoke after the already-issued resync write returns, not inside its synchronous fake transport.
      if (scenario === 'veto_cancel') queueMicrotask(() => abort.abort());
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
    if (metadataGapAt !== undefined) motionAfterGap += 1;
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
      recordVisited: () => undefined,
      resolve: () => ({ target: { kind: 'drop', entityId: 25, item: 'minecraft:bread' } }),
    },
  };
  const leases = new ActuatorLeases({ clock: systemClock, ownerCurrent: () => true, connectionEpoch: () => 1, clearShared: () => clearSharedControls(bot as never) });
  const skills = survivalSkills(h.service);
  // Prospective shared route consumer: only forwards the existing leg's NavigateOptions to the S-owned guard.
  // The actual SkillExecutor, lease, Actuator, packets and resync run unchanged; this is not integrated locator acceptance.
  const local = skills.find((s) => s.descriptor.id === 'go_to_death_site')!;
  const routeProbe: AnySkill = {
    ...local, descriptor: { ...local.descriptor, id: 'recovery_route_probe' },
    async execute(ctx) {
      const r = await navigateRecoveryTravel(h.service, ctx, {
        goal: new goals.GoalNear(30.5, 64, 10.5, 0), arrived: () => bot.entity.position.distanceTo(own.position) <= 0.3,
        distance: () => bot.entity.position.distanceTo(own.position), timeoutMs: 2_000, searchRadius: 32, inBounds: () => true,
      });
      if ('error' in r) return precondition(r.error, r.detail);
      return { status: r.pickup.incidental.length ? 'partial' : r.veto ? 'failed' : 'succeeded', ...(r.veto ? { reason: r.veto } : {}), confirmation: r.pickup.counted || r.pickup.incidental.length ? 'server_packet' : 'client_only', effect: 'route leg settled', evidence: { counted: r.pickup.counted, byKey: r.pickup.byKey } };
    },
  };
  const diagnostics: Array<{ receipt: JsonValue; provenance: string | undefined }> = [];
  const observedSkills = (route === true ? [routeProbe] : skills).map((skill): AnySkill => ({
    ...skill,
    execute(ctx, params) {
      return skill.execute({ ...ctx, progress(e, provenance) {
        if (e['recoveryPickupVeto'] !== undefined) diagnostics.push({ receipt: structuredClone(e['recoveryPickupVeto']), provenance });
        ctx.progress(e, provenance);
      } }, params);
    },
  }));
  const executor = new SkillExecutorImpl({ registry: new SkillRegistry(observedSkills), leases, session: () => session as never, services: services as never, goalEpoch: () => 5, store: new MemoryRunStore(), settleMs: 0 });
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
    if (ticks === 1 && scenario === 'reuse') {
      h.packets.destroy(25);
      h.packets.spawnItem(25, slot('bread', 4), own.position);
      collect(25, 4);
    }
    if (ticks === 1 && scenario === 'reuse_stated') {
      h.packets.destroy(25);
      h.packets.spawnItem(25, slot('bread', 4), own.position);
      events.emit('entitySpawn', own);
      events.emit('entityUpdate', own);
    }
    if (ticks === 1 && scenario === 'merge_stated') {
      client.emit('entity_metadata', { entityId: 25, metadata: [{ key: 8, type: 'item_stack', value: slot('bread', 64) }] });
      events.emit('entityUpdate', own);
    }
    if (ticks === 1 && (scenario === 'reuse_gap' || scenario === 'reuse_gap_collect')) {
      metadataGapAt = bot.entity.position.x;
      h.packets.destroy(25);
      h.packets.spawnItemWithoutStack(25, own.position);
      gapHadFacts = Boolean(h.service.dropFacts(1, 25));
      // Mineflayer's replacement remains physically present; normal events precede any collect packet.
      events.emit('entitySpawn', own);
      events.emit('entityUpdate', own);
      if (!controls) stoppedAt = bot.entity.position.x;
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
    const outcome = await executor.execute({ id: 'act-r400', capability: route === true ? 'recovery_route_probe' : route === 'site' ? 'go_to_death_site' : 'recover_lost_items', connectionEpoch: 1, goalEpoch: 5, timeoutMs: 2_000, parameters: route ? {} : { target: { snapshotId: 'snap-r400', handle: 'drp-1' } } } as never, abort.signal, { kind: 'goal', goalId: 'goal-r400', goalEpoch: 5, taskId: 'task-r400' });
    return { outcome, diagnostics, statedBefore, starts, controls, clearCount, collected, at: bot.entity.position.x, cancelledAt, stoppedAt, metadataGapAt, gapHadFacts, motionAfterGap, authorityBefore, authorityAfter: authority(), returns: h.service.incidentReturns(incidentId), incident: h.service.status(h.clock.now()).incidents[0], effects: ledger.since(0), currentFacts: h.service.dropFacts(1, 68), listeners: events.eventNames().filter((e) => e !== 'physicsTick'), tickListeners: events.listenerCount('physicsTick') };
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


it('R5: the route guard settles own passive packets once, rejects moving foreign loot before approach, and revokes cancelled motion', async () => {
  for (const scenario of ['own', 'moving_foreign', 'cancel'] as const) {
    const r = await run(scenario, true);
    assert.equal(r.controls, false, scenario);
    assert.deepEqual(r.listeners, [], scenario);
    assert.equal(r.tickListeners, 1, scenario);
    if (scenario === 'own') {
      assert.equal(r.outcome.status, 'succeeded', JSON.stringify(r.outcome));
      assert.deepEqual(r.collected, [25]);
      assert.deepEqual(r.returns?.regained, { 'minecraft:bread': 4 });
      assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up').map((e) => e.count), [4]);
    } else if (scenario === 'moving_foreign') {
      assert.equal(r.at, 24.5);
      assert.deepEqual(r.collected, []);
      assert.equal(r.outcome.reason, 'unrelated_loot_nearby');
    } else {
      assert.equal(r.outcome.status, 'cancelled');
      assert.equal(r.at, r.cancelledAt);
      assert.deepEqual(r.collected, []);
    }
  }
});
it('R5: route settlement preserves known foreign key, unknown taint, orbs and changed-stack refusal', async () => {
  for (const scenario of ['late_foreign', 'unknown', 'orb', 'merge'] as const) {
    const r = await run(scenario, true);
    assert.equal(r.controls, false, scenario);
    if (scenario === 'merge') {
      assert.deepEqual(r.returns?.regained, {});
      assert.equal(r.returns?.attribution, 'unknown');
      assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up'), []);
    } else {
      assert.deepEqual(r.returns?.regained, { 'minecraft:bread': 4 }, JSON.stringify(r.outcome));
      assert.equal(r.returns?.attribution, scenario === 'unknown' || scenario === 'late_foreign' ? 'unknown' : 'server_attributed');
    }
    const expected = scenario === 'orb' ? [] : [[scenario === 'unknown' ? undefined : 'minecraft:bread', scenario === 'unknown' ? 3 : 64]];
    assert.deepEqual(r.incident?.incidental?.map((e) => [e.key, e.count]), expected, scenario);
  }
});

it('R5: ordinary wrong-component identity is refused by the route guard and pickup executor before any path or credit', async () => {
  for (const route of [false, true]) {
    const r = await run('wrong_identity', route);
    assert.equal(r.starts, 0);
    assert.deepEqual(r.collected, []);
    assert.deepEqual(r.returns?.regained, {});
    assert.equal(r.controls, false);
    assert.equal(r.outcome.reason, route ? 'unrelated_loot_nearby' : 'metadata_mismatch');
  }
});

it('R5: reusing a frozen entity id with an identical item/count does not inherit its pickup authority', async () => {
  for (const route of [false, true]) {
    const r = await run('reuse', route);
    assert.deepEqual(r.returns?.regained, {});
    assert.equal(r.returns?.attribution, 'unknown');
    assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up'), []);
    assert.deepEqual(r.incident?.incidental?.map((e) => [e.key, e.count]), [['minecraft:bread', 4]]);
    assert.equal(r.controls, false);
  }
});

it("R5: a pile/neighbour cannot borrow another lost component identity's count allowance", async () => {
  for (const scenario of ['identity_count', 'identity_neighbors'] as const) {
    for (const route of [false, true]) {
      const r = await run(scenario, route);
      assert.equal(r.starts, 0, JSON.stringify(r.outcome));
      assert.deepEqual(r.collected, []);
      assert.deepEqual(r.returns?.regained, {});
      assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up'), []);
      assert.equal(r.controls, false);
      assert.equal(r.outcome.reason, !route && scenario === 'identity_count' ? 'oversized_stack' : 'unrelated_loot_nearby');
    }
  }
});

it('R5: an initial route pickup veto stays latched when the foreign pile moves away during resync', async () => {
  const r = await run('foreign_recedes', true);
  assert.equal(r.starts, 0);
  assert.deepEqual(r.collected, []);
  assert.equal(r.outcome.reason, 'unrelated_loot_nearby');
  assert.equal(r.controls, false);
});

it('R6: a frozen id replaced without stack metadata stops intentional approach before any collect', async () => {
  for (const route of [false, true]) {
    const r = await run('reuse_gap', route);
    assert.equal(r.gapHadFacts, false);
    assert.equal(r.motionAfterGap, 0, JSON.stringify({ route, ...r }));
    assert.equal(r.at, r.metadataGapAt);
    assert.equal(r.controls, false);
    assert.deepEqual(r.collected, []);
    assert.deepEqual(r.returns?.regained, {});
    assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up'), []);
    assert.deepEqual(r.authorityAfter, r.authorityBefore);
    assert.deepEqual(r.listeners, []);
    assert.equal(r.tickListeners, 1);
  }
});

it('R6: an unavoidable collect of the metadata-gap replacement stays keyless unknown without credit', async () => {
  for (const route of [false, true]) {
    const r = await run('reuse_gap_collect', route);
    assert.equal(r.motionAfterGap, 0, JSON.stringify({ route, ...r }));
    assert.equal(r.at, r.metadataGapAt);
    assert.equal(r.controls, false);
    assert.deepEqual(r.collected, [25]);
    assert.deepEqual(r.returns?.regained, {});
    assert.equal(r.returns?.attribution, 'unknown');
    assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up'), []);
    assert.deepEqual(r.incident?.incidental?.map((e) => [e.key, e.count]), [[undefined, 4]]);
    assert.equal(r.outcome.status, 'partial');
    assert.deepEqual(r.authorityAfter, r.authorityBefore);
  }
});

it('R6: a legitimate frozen collect then destroy and entity event retains exact settlement once', async () => {
  for (const route of [false, true]) {
    const r = await run('collected_destroyed', route);
    assert.equal(r.outcome.status, 'succeeded', JSON.stringify({ route, ...r }));
    assert.deepEqual(r.collected, [25]);
    assert.deepEqual(r.returns?.regained, { 'minecraft:bread': 4 });
    assert.equal(r.returns?.attribution, 'server_attributed');
    assert.deepEqual(r.incident?.incidental, []);
    assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up').map((e) => e.count), [4]);
    assert.deepEqual(r.authorityAfter, r.authorityBefore);
    assert.equal(r.controls, false);
  }
});

type MotionResult = Awaited<ReturnType<typeof run>>;
function object(value: JsonValue | undefined): Record<string, JsonValue> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), JSON.stringify(value));
  return value;
}
function receipt(r: MotionResult): Record<string, JsonValue> {
  assert.equal(r.diagnostics.length, 1, JSON.stringify(r.outcome));
  assert.equal(r.diagnostics[0]!.provenance, 'local');
  const v = object(r.outcome.evidence['recoveryPickupVeto'] ?? object(r.outcome.evidence['localProgress'])['recoveryPickupVeto']);
  assert.deepEqual(v, r.diagnostics[0]!.receipt, 'the outcome retains the first captured receipt');
  assert.ok(JSON.stringify(v).length < 1_600, 'one bounded receipt, independent of stack components/entity dumps');
  assert.equal(v['provenance'], 'local');
  assert.equal(v['goalId'], 'goal-r400');
  assert.equal(v['goalEpoch'], 5);
  assert.equal(v['connectionEpoch'], 1);
  assert.equal(v['dimension'], SESSION_OW);
  assert.equal(typeof v['atMs'], 'number');
  assert.equal(object(v['localDistances'])['provenance'], 'local');
  return v;
}
function noPickup(r: MotionResult) {
  assert.deepEqual(r.collected, []);
  assert.deepEqual(r.returns?.regained, {});
  assert.equal(r.returns?.attribution, 'server_attributed', 'a refusal alone is not an unknown collect');
  assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up'), []);
  assert.deepEqual(r.authorityAfter, r.authorityBefore);
  assert.equal(r.controls, false);
  assert.deepEqual(r.listeners, []);
  assert.equal(r.tickListeners, 1);
}

it('R14: unknown stack and absent origin retain null facts and distinct reasons through actual route and local navigation', async () => {
  for (const scenario of ['unstated_drop', 'missing_origin'] as const) {
    for (const mode of [true, 'site'] as const) {
      const r = await run(scenario, mode);
      noPickup(r);
      assert.equal(r.starts, 0, JSON.stringify(r.outcome));
      const v = receipt(r);
      assert.equal(v['entityId'], 68);
      assert.equal(v['reason'], scenario === 'unstated_drop' ? 'stack_facts_unknown' : 'foreign_drop_origin');
      assert.equal(v['region'], 'bot');
      assert.equal(v['reference'], 'bot');
      for (const value of Object.values(object(v['serverStack']))) assert.equal(value, null);
      assert.equal(v['remainingCountUsed'], null);
      assert.equal(v['remainingIdentityCountUsed'], null);
      const origin = object(v['firstOrigin']);
      if (scenario === 'missing_origin') for (const value of Object.values(origin)) assert.equal(value, null);
      else {
        assert.equal(origin['provenance'], 'server_spawn');
        assert.equal(origin['distanceToSite'], 5);
        assert.equal(origin['withinSearchRadius'], true);
      }
      assert.deepEqual(object(v['localDistances'])['toBot'], { horizontal: 1, vertical: 0 });
      assert.equal(r.outcome.confirmation, mode === true ? 'client_only' : 'none');
    }
  }
});

it('R14: moved foreign-origin and unsought items expose actual packet facts without consulting identity room or adding authority', async () => {
  for (const scenario of ['foreign_origin', 'unsought'] as const) {
    const r = await run(scenario, true);
    noPickup(r);
    assert.equal(r.starts, 0);
    const v = receipt(r);
    assert.equal(v['reason'], scenario === 'foreign_origin' ? 'foreign_drop_origin' : 'not_sought');
    const stack = object(v['serverStack']);
    const stated = r.statedBefore.neighbour!;
    assert.equal(stack['key'], stated.key);
    assert.equal(stack['count'], stated.count);
    assert.equal(stack['incarnation'], stated.incarnation);
    assert.equal(stack['digest'], stated.meta.digest);
    assert.equal(stack['packetAtMs'], stated.atMs);
    assert.equal(stack['provenance'], 'server_packet');
    assert.equal(stack['incarnationProvenance'], 'tracker_spawn_sequence');
    assert.equal(stack['digestProvenance'], 'derived_from_server_stack');
    assert.equal(stack['packetTimeProvenance'], 'local_packet_receipt');
    assert.equal(v['remainingCountUsed'], scenario === 'foreign_origin' ? null : 0);
    assert.equal(v['remainingIdentityCountUsed'], null);
    if (scenario === 'foreign_origin') {
      assert.equal(object(v['firstOrigin'])['distanceToSite'], Math.hypot(30.5, 10.5));
      assert.equal(object(v['firstOrigin'])['withinSearchRadius'], false);
      assert.deepEqual(object(v['localDistances'])['toBot'], { horizontal: 1, vertical: 0 });
    }
  }
});

it('R14: exact mismatch/oversized reasons and only consulted key/identity room survive both executor entry points', async () => {
  for (const scenario of ['wrong_identity', 'identity_count', 'identity_neighbors'] as const) {
    for (const route of [false, true]) {
      const r = await run(scenario, route);
      noPickup(r);
      assert.equal(r.starts, 0);
      const v = receipt(r);
      assert.equal(v['reason'], scenario === 'wrong_identity' ? 'metadata_mismatch' : 'oversized_stack');
      assert.equal(v['entityId'], scenario === 'identity_neighbors' ? 68 : 25);
      assert.equal(v['remainingCountUsed'], scenario === 'identity_count' ? 8 : 4);
      assert.equal(v['remainingIdentityCountUsed'], scenario === 'wrong_identity' ? null : scenario === 'identity_count' ? 4 : 0);
      assert.equal(object(v['serverStack'])['count'], scenario === 'identity_count' ? 8 : 4);
      assert.equal(v['region'], 'site');
      assert.equal(v['reference'], route ? 'site' : 'pickup_target');
      const serialized = JSON.stringify(v);
      assert.equal(serialized.includes('foreign bread'), false);
      assert.equal(serialized.includes('own named bread'), false);
      assert.equal(serialized.includes('components'), false);
    }
  }
});

it('R14: first refusal remains one immutable receipt after later packet and local position changes', async () => {
  const r = await run('foreign_recedes', true);
  noPickup(r);
  assert.equal(r.starts, 0);
  const v = receipt(r);
  assert.equal(v['reason'], 'not_sought'); // own bread4 is already reserved; foreign bread cannot reuse it
  assert.equal(v['entityId'], 68);
  assert.equal(v['remainingCountUsed'], 0);
  assert.equal(v['remainingIdentityCountUsed'], null);
  assert.equal(object(v['serverStack'])['key'], 'minecraft:bread');
  assert.equal(object(v['serverStack'])['count'], 64);
  assert.equal(object(v['serverStack'])['packetAtMs'], r.statedBefore.neighbour!.atMs);
  assert.deepEqual(object(v['localDistances'])['toSite'], { horizontal: 1, vertical: 0 });
  assert.equal(r.currentFacts?.key, 'minecraft:dirt');
  assert.equal(r.currentFacts?.count, 1);
  assert.ok(r.currentFacts!.atMs > r.statedBefore.neighbour!.atMs);
});

it('R14: frozen missing/replaced/merged stacks record current facts only and revoke approach before another tick', async () => {
  for (const scenario of ['reuse_gap', 'reuse_stated', 'merge_stated'] as const) {
    for (const route of [false, true]) {
      const r = await run(scenario, route);
      noPickup(r);
      assert.equal(r.starts, 1);
      assert.equal(r.at, 24.5);
      const v = receipt(r);
      assert.equal(v['reason'], 'target_changed');
      assert.equal(v['entityId'], 25);
      assert.equal(v['remainingCountUsed'], null, 'frozen identity fence does not consult remaining room');
      assert.equal(v['remainingIdentityCountUsed'], null);
      const stack = object(v['serverStack']);
      if (scenario === 'reuse_gap') for (const value of Object.values(stack)) assert.equal(value, null);
      else {
        assert.equal(stack['key'], 'minecraft:bread');
        assert.equal(stack['count'], scenario === 'reuse_stated' ? 4 : 64);
        assert.equal(stack['incarnation'], r.statedBefore.own!.incarnation + (scenario === 'reuse_stated' ? 1 : 0));
        assert.equal(stack['digest'], r.statedBefore.own!.meta.digest);
      }
    }
  }
});

it('R14: a veto diagnostic alone never confirms partial effects when ownership is then cancelled', async () => {
  const r = await run('veto_cancel', true);
  noPickup(r);
  assert.equal(r.starts, 0);
  assert.equal(r.outcome.status, 'cancelled');
  assert.equal(r.outcome.confirmation, 'none');
  assert.equal(r.outcome.evidence['recoveryPickupVeto'], undefined);
  assert.equal(object(r.outcome.evidence['partialEffects'])['confirmed'], 'none');
  assert.equal(object(r.outcome.evidence['localProgress'])['provenance'], 'client model / local samples (not server-confirmed)');
  assert.equal(receipt(r)['reason'], 'not_sought');
  assert.equal(r.outcome.evidence['commandsAfterRevoke'], 0);
});

it('R14: legitimate own pickup remains exactly once; a post-collect approach fence does not rewrite settlement', async () => {
  for (const route of [false, true]) {
    const r = await run('own', route);
    if (route) {
      assert.deepEqual(r.diagnostics, []);
      assert.equal(r.outcome.evidence['recoveryPickupVeto'], undefined);
    } else {
      // Existing local navigation checks the frozen target after its legitimate collect/destroy.
      const v = receipt(r);
      assert.equal(v['reason'], 'target_changed');
      for (const value of Object.values(object(v['serverStack']))) assert.equal(value, null);
      for (const [key, value] of Object.entries(object(v['localDistances']))) if (key !== 'provenance') assert.equal(value, null);
    }
    assert.equal(r.starts, 1);
    assert.deepEqual(r.collected, [25]);
    assert.equal(r.outcome.status, 'succeeded');
    assert.deepEqual(r.returns?.regained, { 'minecraft:bread': 4 });
    assert.equal(r.returns?.attribution, 'server_attributed');
    assert.deepEqual(r.effects.filter((e) => e.kind === 'picked_up').map((e) => e.count), [4]);
    assert.deepEqual(r.authorityAfter, r.authorityBefore);
    assert.equal(r.controls, false);
  }
});

it('R14: a packet-driven destination veto records the refusal before the next physics movement or collect', async () => {
  for (const route of [false, true]) {
    const r = await run('moving_foreign', route);
    noPickup(r);
    assert.equal(r.starts, 1);
    assert.equal(r.at, 24.5);
    const v = receipt(r);
    assert.equal(v['entityId'], 68);
    assert.equal(v['reason'], 'not_sought');
    assert.equal(v['region'], 'site');
    assert.equal(object(v['serverStack'])['count'], 64);
    assert.deepEqual(object(v['localDistances'])['toSite'], { horizontal: 1, vertical: 0 });
    assert.deepEqual(object(v['localDistances'])['toBot'], { horizontal: Math.hypot(6, 1), vertical: 0 });
  }
});
