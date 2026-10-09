// L-owned integration: actual route skill/runner/controller, executor, actuator, S service/tracker and packets.
// Only physics/pathfinder/server replies are simulated; no fixture, inference or app-composition edits.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, it } from 'node:test';
import { systemClock } from '../src/contracts/index.ts';
import { RoutePolicySchema } from '../src/contracts/locator.ts';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { clearSharedControls, SkillExecutorImpl } from '../src/execution/executor.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { RouteController } from '../src/locator/routes.ts';
import { routeTravelSkill, seekOwnerSkill } from '../src/skills/locator.ts';
import { navigateRecoveryTravel } from '../src/skills/survival.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { fakeMineflayerBot, vec3, type FakeClient } from './skill-fakes.ts';
import { ID, OW, SESSION_OW, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, settle, slot, type Slot } from './survival-helpers.ts';
after(cleanupRoots);

type Case = 'own' | 'foreign_resync' | 'foreign_moved' | 'incidental' | 'unknown' | 'orb' | 'reuse_gap' | 'collected_destroyed' | 'stop' | 'safety' | 'connection' | 'goal' | 'identity' | 'budget' | 'deadline' | 'absent' | 'wrong_goal' | 'stale_epoch' | 'stale_connection' | 'owner_destination' | 'owner';
async function execute(which: Case) {
  const site = { x: 180.5, y: 64, z: 10.5 }, anchor = { x: 0.5, y: 64, z: 10.5 };
  const h = harness({ farRoute: () => 'locator_route_legs' }); h.pos.at = site;
  const kit = { 37: slot('bread', 8) };
  h.packets.inventory(kit); h.packets.health(20); dieWithItems(h, kit);
  const incidentId = h.service.deathContext().captureId!; h.service.linkIncident(incidentId, 'mf-l500');
  respawnFresh(h, {}, { dimensionName: OW, location: { x: 180, y: 64, z: 10 } });
  h.pos.at = { x: 150.5, y: 64, z: 10.5 }; await settle(h);
  const decision = h.service.assess(assessInput(h)); assert.equal(decision.kind, 'propose');
  h.service.onSupportAdmitted({ proposalId: (decision as { proposal: SurvivalProposal }).proposal.proposalId, goalId: 'goal-l500', goalEpoch: 5, connectionEpoch: 1, admittedAtMs: h.clock.now() }); await settle(h);
  const recoveryBefore = structuredClone(h.service.status(h.clock.now()).incidents[0]!.budget);
  const client = h.packets.client as unknown as FakeClient, events = new EventEmitter();
  const fake = fakeMineflayerBot(client, { dimension: SESSION_OW, loaded: 256, at: h.pos.at });
  fake.fill(140, 63, 0, 190, 63, 20, 'grass_block'); const bot = fake.bot; bot.entity.id = 42;
  Object.assign(bot, { on: events.on.bind(events), off: events.off.bind(events), prependListener: events.prependListener.bind(events), emit: events.emit.bind(events) });
  const evidence = new ServerEvidence(client, { items: Object.fromEntries(Object.entries(ID).map(([name, id]) => [id, { name }])), entitiesByName: { item: { id: 71 } } }); evidence.attach();
  const session = { bot, evidence, connectionEpoch: 1 };
  const scope = () => ({ goalEpoch: 5, connectionEpoch: session.connectionEpoch, dimension: SESSION_OW });
  let changedIdentity = false, elapsed = 0;
  const clock = { now: () => systemClock.now() + elapsed };
  const routes = new RouteController({ clock, policy: RoutePolicySchema.parse({ sources: ['owner', 'support'], destinations: ['owner', 'owner_destination', 'own_death'], maxTotalDistance: which === 'budget' ? 64 : 512 }), ownDeath: { kind: 'own_death', current: (ctx) => {
    const value = h.service.current(ctx); return value && changedIdentity ? { ...value, recordedAtMs: value.recordedAtMs + 1 } : value;
  } } });
  const admission = routes.admit({ goalId: 'goal-l500', ...scope(), source: 'support', admittedAtMs: Date.now(), goalDeadlineMs: Date.now() + 30_000, admissionAnchor: anchor, admissionRadius: 128, ownerCoordinates: [{ ...site, source: 'instruction' }] })!;
  // Existing counted authority: the production controller verifies the destination before granting this leg.
  assert.ok(routes.beginLeg({ ...scope(), at: { ...h.pos.at }, destination: which === 'owner' ? 'owner' : which === 'owner_destination' ? 'owner_destination' : 'own_death', ...(which === 'owner' ? { bearingRad: 0 } : { destinationAt: site }) }).ok);
  const legBefore = routes.status(5)!;
  const ordinary = which === 'owner_destination' || which === 'owner';
  const own = fake.addEntity({ id: 25, name: ordinary ? 'player' : 'item', type: ordinary ? 'player' : 'other', height: ordinary ? 1.8 : 0.25, at: site });
  if (!ordinary) h.packets.spawnItem(25, slot('bread', 4), site);
  const foreign = fake.addEntity({ id: 68, name: 'item', type: 'other', height: 0.25, at: { x: 186.5, y: 64, z: 10.5 } });
  if (which === 'foreign_resync' || which === 'foreign_moved' || which === 'incidental') h.packets.spawnItem(68, slot('bread', 64), foreign.position);
  else delete bot.entities[68];
  if (which === 'incidental') delete bot.entities[68];
  let goal: { x: number; z: number } | null = null, controls = false, starts = 0, ticks = 0, clearCount = 0, clicks = 0, callbackCalls = 0;
  let interruptedAt: number | undefined, gapMotion = 0;
  const collected: number[] = [], inventory: Record<number, Slot> = {};
  const signal = new AbortController(), ledger = new EvidenceLedger(systemClock), store = new MemoryRunStore();
  const collect = (id: number, count: number) => {
    collected.push(id); h.packets.collect(id, count); h.packets.destroy(id); delete bot.entities[id];
    if (id === 25) inventory[37] = slot('bread', count);
    if (id === 68) inventory[38] = slot('bread', count);
    h.packets.inventory(inventory);
    if (id === 25 && which === 'collected_destroyed') events.emit('entityUpdate', own);
  };
  Object.assign(bot, { clearControlStates: () => { controls = false; clearCount++; }, pathfinder: {
    setMovements: () => undefined, setGoal: (g: { x: number; z: number } | null) => { goal = g; controls = Boolean(g); if (g) starts++; }, isMoving: () => controls,
  } });
  client.write = (name, data) => {
    if (name === 'window_click') {
      clicks++;
      if (which === 'foreign_resync' && starts === 0) { foreign.position = vec3(site.x, site.y, site.z + 1); events.emit('entityMoved', foreign); }
      if (which === 'incidental' && starts > 0 && !collected.includes(68)) collect(68, 64);
      h.packets.inventory(inventory);
    }
    if (name === 'block_dig') setImmediate(() => client.emit('acknowledge_player_digging', { sequenceId: data['sequence'] }));
  };
  const services = { clock, ledger, limits: { observationRadius: 32, travelRadius: 128, ownerLossMs: 1_000 }, perception: {
    travelAnchorGoalEpoch: () => 5, admissionBounds: () => ({ ...scope(), anchor, radius: 128 }), world: () => ({ blockAt: (x: number, y: number, z: number) => fake.bot.blockAt(vec3(x, y, z)) }), recordVisited: () => undefined,
    isOwnerEntity: (_bot: unknown, e: { id: number }) => e.id === 25, entityVisibleNow: (id: number) => ordinary && id === 25,
  } };
  const leases = new ActuatorLeases({ clock, ownerCurrent: () => true, connectionEpoch: () => session.connectionEpoch, clearShared: () => clearSharedControls(bot as never) });
  const recoveryTravel = async (ctx: Parameters<typeof navigateRecoveryTravel>[1], options: Parameters<typeof navigateRecoveryTravel>[2]) => {
    callbackCalls++;
    assert.equal(ctx.session.bot, bot); assert.equal(ctx.owner.kind, 'goal');
    assert.deepEqual(options.bounds?.anchor, { x: 150.5, y: 64, z: 10.5 }); assert.equal(options.bounds?.radius, admission.ceilings.legRadius);
    assert.equal(typeof options.abortIf, 'function'); assert.equal(options.inBounds, undefined); assert.equal(options.retarget, undefined);
    assert.equal(routes.frozenOwnDeath(scope())?.recordedAtMs, h.service.current(scope())?.recordedAtMs);
    return navigateRecoveryTravel(h.service, ctx, options);
  };
  const deps = { routes, ...(which === 'absent' ? {} : { recoveryTravel }) };
  const skill = which === 'owner' ? seekOwnerSkill(deps) : routeTravelSkill(deps);
  const executor = new SkillExecutorImpl({ registry: new SkillRegistry([skill]), leases, session: () => session as never, services: services as never, goalEpoch: () => 5, store, settleMs: 0 });
  events.on('physicsTick', () => {
    if (!goal || !controls) return;
    if (interruptedAt !== undefined) gapMotion++;
    const dx = goal.x + 0.5 - bot.entity.position.x;
    bot.entity.position = vec3(bot.entity.position.x + Math.sign(dx) * Math.min(Math.abs(dx), 0.8), 64, 10.5); h.pos.at = bot.entity.position;
    if (!ordinary && bot.entities[25] && bot.entity.position.distanceTo(own.position) <= 1.3) collect(25, 4);
    if (Math.abs(dx) <= 0.8) { controls = false; events.emit('goal_reached'); }
  });
  const interval = setInterval(() => {
    if (!starts) return;
    ticks++;
    if (ticks === 1) {
      if (which === 'foreign_moved') { foreign.position = vec3(site.x, site.y, site.z + 1); events.emit('entityMoved', foreign); interruptedAt = bot.entity.position.x; }
      if (which === 'unknown') collect(999, 3);
      if (which === 'orb') { h.packets.spawnOther(998); collect(998, 1); }
      if (which === 'reuse_gap') { h.packets.destroy(25); h.packets.spawnItemWithoutStack(25, own.position); events.emit('entitySpawn', own); interruptedAt = bot.entity.position.x; }
      if (which === 'stop') { routes.revoke('owner_stop'); signal.abort(); interruptedAt = bot.entity.position.x; }
      if (which === 'safety') { leases.preemptForSafety(); interruptedAt = bot.entity.position.x; }
      // Real lifecycle ordering revokes route/lease controls before a fresh connection is attached.
      if (which === 'connection') { routes.revoke('lifecycle_ended'); leases.revokeCurrent('lifecycle_ended'); session.connectionEpoch++; interruptedAt = bot.entity.position.x; }
      if (which === 'goal') { routes.revoke('goal_replaced'); leases.revokeCurrent('owner_revoked'); interruptedAt = bot.entity.position.x; }
      if (which === 'identity') { changedIdentity = true; interruptedAt = bot.entity.position.x; }
      if (which === 'budget') { bot.entity.position = vec3(216.5, 64, 10.5); routes.sample(scope(), bot.entity.position); interruptedAt = bot.entity.position.x; }
      if (which === 'deadline') { elapsed = 31_000; interruptedAt = bot.entity.position.x; }
    }
    events.emit('physicsTick');
  }, 20);
  try {
    const parameters = which === 'owner' ? { within: 3, durationMs: 5_000 } : which === 'owner_destination' ? { target: { kind: 'destination', dimension: SESSION_OW, ...site }, within: 1, durationMs: 5_000 } : { destination: 'own_death', within: 1, durationMs: 5_000 };
    const epoch = which === 'stale_epoch' ? 6 : 5;
    if (which === 'stale_connection') session.connectionEpoch++;
    const outcome = await executor.execute({ id: 'act-l500', capability: skill.descriptor.id, connectionEpoch: 1, goalEpoch: epoch, timeoutMs: 6_000, parameters } as never, signal.signal, { kind: 'goal', goalId: which === 'wrong_goal' ? 'goal-other' : 'goal-l500', goalEpoch: epoch, taskId: 'task-l500' });
    return { outcome, callbackCalls, starts, controls, clearCount, clicks, collected, position: bot.entity.position.x, interruptedAt, gapMotion, ledger: ledger.since(0), returns: h.service.incidentReturns(incidentId), recoveryBefore, recoveryAfter: h.service.status(h.clock.now()).incidents[0]!.budget, legBefore, routeAfter: routes.status(5), admissionSame: routes.authorization(scope()) === admission, listeners: events.eventNames().filter((e) => e !== 'physicsTick'), tickListeners: events.listenerCount('physicsTick') };
  } finally { clearInterval(interval); evidence.detach(); await h.service.close(); }
}

it('L actual own-death routed movement settles exact own pickup packets without refilling authority', async () => {
  const r = await execute('own'); assert.equal(r.outcome.status, 'succeeded', JSON.stringify(r.outcome)); assert.equal(r.callbackCalls, 1); assert.equal(r.starts, 1);
  assert.deepEqual(r.returns?.regained, { 'minecraft:bread': 4 }); assert.equal(r.outcome.confirmation, 'server_packet');
  assert.deepEqual((r.outcome.evidence.recoveryTravel as any)[0].pickup, { counted: 4, byKey: { 'minecraft:bread': 4 }, incidental: [], nonItem: [] });
  assert.equal(r.ledger.filter((e) => e.kind === 'picked_up').length, 1); assert.deepEqual(r.recoveryAfter, r.recoveryBefore);
  assert.equal(r.routeAfter?.legsUsed, r.legBefore.legsUsed); assert.equal(r.routeAfter?.maxTotalDistance, r.legBefore.maxTotalDistance); assert.ok((r.routeAfter?.distanceUsed ?? 0) > 20);
  assert.ok(r.admissionSame); assert.equal(r.controls, false); assert.ok(r.clearCount); assert.deepEqual(r.listeners, []); assert.equal(r.tickListeners, 1);
});
for (const mode of ['foreign_resync', 'foreign_moved', 'reuse_gap'] as const) it(`L production ${mode} veto refuses approach and leaves no pickup or callback behind`, async () => {
  const r = await execute(mode); assert.equal(r.outcome.status, 'failed', JSON.stringify(r.outcome)); assert.equal(r.outcome.reason, mode === 'reuse_gap' ? 'target_changed' : 'unrelated_loot_nearby');
  assert.equal(r.starts, mode === 'foreign_resync' ? 0 : 1); assert.deepEqual(r.collected, []); assert.equal(r.position, 150.5); assert.equal(r.gapMotion, 0);
  assert.equal(r.callbackCalls, 1); assert.equal(r.controls, false); assert.deepEqual(r.listeners, []); assert.equal(r.tickListeners, 1);
});
for (const mode of ['incidental', 'unknown', 'orb', 'collected_destroyed'] as const) it(`L production packet settlement preserves ${mode} effects and confirmation`, async () => {
  const r = await execute(mode); assert.equal(r.outcome.status, mode === 'incidental' || mode === 'unknown' ? 'partial' : 'succeeded', JSON.stringify(r.outcome));
  const pickup = (r.outcome.evidence.recoveryTravel as any)[0].pickup;
  assert.equal(pickup.counted, 4); assert.deepEqual(pickup.byKey, { 'minecraft:bread': 4 }); assert.equal(r.outcome.confirmation, 'server_packet');
  assert.equal(pickup.incidental.length, mode === 'incidental' || mode === 'unknown' ? 1 : 0); assert.equal(pickup.nonItem.length, mode === 'orb' ? 1 : 0);
  if (mode === 'incidental') assert.deepEqual(pickup.incidental, ['minecraft:bread x64']);
  assert.deepEqual(r.returns?.regained, { 'minecraft:bread': 4 }); assert.deepEqual(r.ledger.filter((e) => e.kind === 'picked_up').map((e) => e.kind === 'picked_up' ? e.count : 0), [4]);
  assert.equal(r.controls, false); assert.deepEqual(r.listeners, []); assert.equal(r.tickListeners, 1);
});
for (const mode of ['stop', 'safety', 'connection', 'goal', 'identity', 'budget', 'deadline'] as const) it(`L production ${mode} revokes existing navigation without replay or refill`, async () => {
  const r = await execute(mode); assert.equal(r.outcome.status, ['stop', 'safety', 'connection', 'goal'].includes(mode) ? 'cancelled' : 'failed', JSON.stringify(r.outcome));
  assert.equal(r.callbackCalls, 1); assert.equal(r.controls, false); assert.deepEqual(r.collected, []); assert.deepEqual(r.listeners, []);
  assert.equal(r.gapMotion, 0); assert.deepEqual(r.recoveryAfter, r.recoveryBefore); assert.equal(r.routeAfter?.legsUsed, 1);
  if (mode === 'budget') assert.equal(r.outcome.reason, 'route_distance_limit');
  if (mode === 'deadline') assert.equal(r.outcome.reason, 'route_time_limit');
});
for (const [mode, reason] of [['wrong_goal', 'not_a_recovery_goal'], ['stale_epoch', 'stale_goal_epoch'], ['stale_connection', 'stale_candidate']] as const) it(`L production ${mode} refuses before guard, inventory and movement admission`, async () => {
  const r = await execute(mode); assert.equal(r.outcome.status, 'precondition_failed'); assert.equal(r.outcome.reason, reason);
  assert.equal(r.callbackCalls, 0); assert.equal(r.clicks, 0); assert.equal(r.starts, 0); assert.deepEqual(r.collected, []);
});
it('L actual executor refuses own-death without the guard before any path or inventory request', async () => {
  const r = await execute('absent'); assert.equal(r.outcome.reason, 'recovery_travel_not_installed'); assert.equal(r.starts, 0); assert.equal(r.clicks, 0); assert.equal(r.callbackCalls, 0);
});
for (const mode of ['owner_destination', 'owner'] as const) it(`L existing ${mode} travels through ordinary navigation without recovery callbacks or pickup effects`, async () => {
  const r = await execute(mode); assert.equal(r.outcome.status, 'succeeded', JSON.stringify(r.outcome)); assert.equal(r.callbackCalls, 0); assert.equal(r.starts, 1); assert.equal(r.outcome.confirmation, 'client_only');
  assert.equal(r.clicks, 0); assert.equal(r.outcome.evidence.recoveryTravel, undefined); assert.equal(r.controls, false); assert.equal(r.routeAfter?.legsUsed, 1);
});
