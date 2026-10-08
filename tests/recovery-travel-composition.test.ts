// P R11: actual SkillRuntime-created S service, packet lifecycle, registry,
// resolver, route controller, fenced executor/actuator and navigation.
// Only transport, inventory replies and physical movement are simulated.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { LocatorConfigSchema } from '../src/contracts/locator.ts';
import { sequentialIds, systemClock, type ActionCandidate, type ExecutionOwner, type TaskSpec } from '../src/contracts/index.ts';
import type { GameSession } from '../src/game/connection.ts';
import { Actuator } from '../src/execution/actuator.ts';
import type { ExecuteContext } from '../src/skills/definition.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { ackSequenced, evidenceFor, fakeClient, fakeMineflayerBot, REGISTRY_26_1_2, vec3 } from './skill-fakes.ts';

const GOAL = 'goal-recovery1', EPOCH = 5, SITE = { x: 20.5, y: 0, z: 0.5 };
const task: TaskSpec = { objective: 'Attempt bounded recovery.', decisionInstruction: 'Use offered options.', allowedCapabilities: ['route_travel'], targetSelectors: [], parameters: { destination: 'own_death', durationMs: 3_000, within: 3 }, completion: { predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' } };
const empty = () => ({ itemCount: 0 });
const stack = (key: string, count: number) => ({ itemId: REGISTRY_26_1_2.itemsByName[key]!.id, itemCount: count, components: [], removeComponents: [] });
async function until<T>(read: () => T | undefined, detail: string): Promise<T> {
  const end = Date.now() + 2_000;
  while (Date.now() <= end) { const value = read(); if (value !== undefined) return value; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error(detail);
}

async function scene(mode: 'enabled' | 'disabled' | 'missing' = 'enabled') {
  const dataDir = mkdtempSync(join(tmpdir(), 'chunkbot-p-route-compose-'));
  let inventory = Array.from({ length: 46 }, empty), epoch = 1, starts = 0, clicks = 0;
  let onSync: () => void = () => undefined;
  const client = fakeClient((name, data) => {
    if (name === 'window_click') { clicks++; onSync(); client.emit('window_items', { windowId: 0, stateId: clicks + 5, items: inventory }); }
    ackSequenced(client, name, data);
  });
  const fake = fakeMineflayerBot(client, { dimension: 'overworld', at: SITE, loaded: 64 });
  fake.fill(-4, -1, -4, 32, -1, 4, 'grass_block');
  const pf = { goal: null as { x: number; y: number; z: number } | null, setMovements: (_: unknown) => undefined, isMoving: () => Boolean(pf.goal), setGoal: (g: unknown) => { pf.goal = g as typeof pf.goal; if (g) starts++; } };
  Object.assign(fake.bot, { pathfinder: pf, clearControlStates: () => undefined, stopDigging: () => undefined });
  const session = { bot: fake.bot, connectionEpoch: 1, evidence: evidenceFor(client) } as unknown as GameSession;
  let current: GameSession | undefined = session;
  const config = loadConfigFile(join(PROJECT_ROOT, 'config/examples/fixture-memory.json')).config;
  config.limits.travelRadius = 8;
  config.locator = LocatorConfigSchema.parse({ routes: { sources: ['owner', 'support'], destinations: ['owner', 'owner_destination', 'own_death'], legRadius: 32, maxLegs: 4, maxTotalDistance: 128, maxRouteMs: 30_000 } });
  const store = new MemoryRunStore();
  const runtime = new SkillRuntime({ config, dataDir, sessionId: 'run-pcompose', session: () => current, connectionEpoch: () => current?.connectionEpoch ?? 2, goalEpoch: () => epoch, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store, clock: systemClock, ids: sequentialIds(), features: { locator: true, ...(mode === 'missing' ? {} : { survival: { config: { enabled: mode === 'enabled' }, scope: { worldProfile: config.memory!.worldProfile, worldRevision: config.memory!.worldRevision, botProfile: config.memory!.botProfile } } }) } });
  const sync = () => client.emit('window_items', { windowId: 0, stateId: 2, items: inventory });
  const health = (n: number) => client.emit('update_health', { health: n, food: 20, foodSaturation: 5 });
  runtime.onBotCreated(fake.bot, 1);
  client.emit('login', { entityId: 1, worldState: { name: 'minecraft:overworld' } });
  runtime.onLifecycle({ type: 'ready', connectionEpoch: 1, info: { serverVersion: '26.1.2', protocolVersion: 775, dimension: 'overworld', position: SITE, gameMode: 'survival', serverOnlineMode: false } });
  let incidentId: string | undefined;
  const owner: ExecutionOwner = { kind: 'goal', goalId: GOAL, goalEpoch: EPOCH, taskId: 'task-recovery1' };
  if (runtime.survival) {
    inventory[36] = stack('bread', 4); inventory[37] = stack('oak_log', 2); sync(); health(20);
    client.emit('death_combat_event', { playerId: 1, message: { type: 'compound', value: { translate: { type: 'string', value: 'death.attack.genericKill' } } } });
    inventory = Array.from({ length: 46 }, empty); sync(); health(0);
    runtime.onLifecycle({ type: 'death', connectionEpoch: 1 });
    incidentId = runtime.survival.deathContext().captureId;
    fake.bot.entity.position = vec3(0.5, 0, 0.5);
    client.emit('respawn', { worldState: { name: 'minecraft:overworld', death: { dimensionName: 'minecraft:overworld', location: { x: 20, y: 0, z: 0 } } }, copyMetadata: 0 });
    runtime.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: 'overworld' });
    sync(); health(20);
    const proposal = await until(() => {
      const p = runtime.survival!.assess({ nowMs: Date.now(), connection: { ready: true, connectionEpoch: 1, dimension: 'overworld' }, snapshot: runtime.perception.take(1)!, autonomyAllowed: true, active: { kind: 'none' }, ownerIntakePending: false, ownerIntentInterrupted: false, goalLimits: { plannerTurns: 20, tasks: 64, replans: 8, deadlineMs: 600_000 } });
      return p.kind === 'propose' ? p.proposal : undefined;
    }, 'actual runtime survival/memory incident never became eligible');
    runtime.survival.onSupportAdmitted({ proposalId: proposal.proposalId, goalId: GOAL, goalEpoch: EPOCH, connectionEpoch: 1, admittedAtMs: Date.now() });
  } else fake.bot.entity.position = vec3(0.5, 0, 0.5);
  epoch = EPOCH;
  runtime.onGoalAdmitted({ goalId: GOAL, epoch, admittedAtMs: Date.now(), deadlineAtMs: Date.now() + 30_000, source: { kind: 'support', routine: 'death_recovery', proposalId: 'sur-proposal1', execution: 'planner_goal', priority: 'support', serves: 'owner_intent', reason: 'test own incident', sessionAttempt: 1 } });
  if (runtime.survival) await until(() => {
    const r = runtime.survival!.recoveryTarget({ goalEpoch: epoch, connectionEpoch: 1, dimension: 'overworld' });
    return 'error' in r ? undefined : r;
  }, 'actual admitted support did not settle durably');
  let captured: ExecuteContext | undefined;
  const skill = runtime.registry.get('route_travel')!;
  const originalExecute = skill.execute;
  skill.execute = (ctx, params) => { captured = ctx; return originalExecute(ctx, params); };
  const makeCandidate = (): ActionCandidate => {
    const snap = runtime.perception.take(epoch)!;
    const generated = runtime.candidates.generate(task, snap);
    if (mode === 'enabled') assert.equal(generated.candidates.length, 1, JSON.stringify(generated.unavailable));
    else assert.equal(generated.candidates.length, 0);
    return generated.candidates[0] ?? { id: 'act-recovery1', capability: 'route_travel', parameters: { ...task.parameters }, description: 'guarded route', criteria: [], preconditions: [], timeoutMs: 5_000, snapshotId: snap.id, goalEpoch: epoch, connectionEpoch: 1 };
  };
  const drops = (id: number, key?: string, count = 4, at = SITE) => {
    fake.addEntity({ id, name: 'item', type: 'other', height: 0.25, at });
    client.emit('spawn_entity', { entityId: id, type: REGISTRY_26_1_2.entitiesByName['item']!.id, ...at });
    if (key) client.emit('entity_metadata', { entityId: id, metadata: [{ key: 8, type: 'item_stack', value: stack(key, count) }] });
  };
  const collect = (id: number, count: number) => { client.emit('collect', { collectedEntityId: id, collectorEntityId: 1, pickupItemCount: count }); client.emit('entity_destroy', { entityIds: [id] }); delete fake.bot.entities[id]; };
  const abort = new AbortController();
  let physical: ReturnType<typeof setInterval> | undefined;
  const travel = (onTick?: () => void) => { physical = setInterval(() => {
    if (!pf.goal) return;
    onTick?.(); if (!pf.goal) return;
    const p = fake.bot.entity.position, dx = pf.goal.x + 0.5 - p.x, dz = pf.goal.z + 0.5 - p.z, d = Math.hypot(dx, dz);
    if (d) fake.bot.entity.position = vec3(p.x + dx / d * Math.min(d, 0.5), 0, p.z + dz / d * Math.min(d, 0.5));
    fake.bot.emit('move');
    if (fake.bot.entities[25] && fake.bot.entity.position.distanceTo(fake.bot.entities[25].position) <= 1.3) { collect(25, 4); inventory[36] = stack('bread', 4); sync(); }
    if (d <= 0.5) fake.bot.emit('goal_reached');
    fake.bot.emit('physicsTick');
  }, 10); };
  return { runtime, fake, client, session, store, pf, owner, abort, drops, collect, travel, candidate: makeCandidate, captured: () => captured, starts: () => starts, clicks: () => clicks, onSync: (f: () => void) => { onSync = f; }, returns: () => incidentId ? runtime.survival?.incidentReturns(incidentId) : undefined,
    invalidate: (kind: 'ended' | 'dimension' | 'replacement') => {
      epoch++;
      if (kind === 'ended') { runtime.onLifecycle({ type: 'ended', connectionEpoch: 1, reason: 'operator_stop', detail: 'test disconnect' }); current = undefined; }
      else if (kind === 'dimension') { runtime.onLifecycle({ type: 'dimension_change', connectionEpoch: 1, from: 'overworld', to: 'the_nether' }); fake.bot.game.dimension = 'the_nether'; }
      else { runtime.leases.revokeCurrent('new_goal'); runtime.onGoalAdmitted({ goalId: 'goal-replaced1', epoch, admittedAtMs: Date.now(), source: { kind: 'owner' } }); }
    }, close: async () => { if (physical) clearInterval(physical); abort.abort(); runtime.onLifecycle({ type: 'ended', connectionEpoch: 1, reason: 'operator_stop', detail: 'test cleanup' }); session.evidence.detach(); await runtime.survival?.close(); await runtime.memory?.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

describe('R11 guarded own-death travel through actual SkillRuntime composition', () => {
  it('the current service receives the goal context and existing actuator; exact own and non-item receipts propagate without full recovery', async () => {
    const h = await scene();
    try {
      h.drops(25, 'bread');
      const current = h.runtime.survival!, before = structuredClone(h.runtime.routes!.authorization({ goalEpoch: EPOCH, connectionEpoch: 1, dimension: 'overworld' }));
      const budgets = structuredClone(current.status(Date.now()).incidents[0]!.budget);
      const calls: Array<Parameters<typeof current.recoveryTarget>[0]> = [];
      const refusals: string[] = [];
      const originalTarget = current.recoveryTarget.bind(current);
      current.recoveryTarget = (fence) => { calls.push({ ...fence }); const r = originalTarget(fence); if ('error' in r) refusals.push(r.error); return r; };
      let orb = false;
      h.onSync(() => { if (h.starts() && !h.pf.goal && !orb) { orb = true; h.client.emit('spawn_entity', { entityId: 99, type: REGISTRY_26_1_2.entitiesByName['experience_orb']!.id, ...SITE }); h.collect(99, 1); } });
      h.travel();
      const candidate = h.candidate();
      const result = await h.runtime.executor.execute(candidate, h.abort.signal, h.owner);
      // Recording an own return updates the REAL memory death fact. If its
      // write is still pending at revalidation, the provider must refuse; if
      // already durable it may report arrival. No other failure is admitted.
      assert.ok(refusals.every((r) => r === 'incident_write_pending'), JSON.stringify(refusals));
      assert.equal(result.status, refusals.length ? 'failed' : 'succeeded', JSON.stringify({ result, refusals }));
      assert.equal(result.reason, refusals.length ? 'route_destination_unverified' : 'arrived'); assert.equal(result.confirmation, 'server_packet');
      const ctx = h.captured()!; assert.equal(ctx.session, h.session); assert.equal(ctx.services, h.runtime.services); assert.deepEqual(ctx.owner, h.owner);
      const acquisitions = h.store.events.filter((e) => e.type === 'lease_acquired');
      assert.equal(acquisitions.length, 1); assert.equal(ctx.act.lease.id, acquisitions[0]!['leaseId']);
      assert.ok(calls.length > 3 && calls.every((c) => c.goalEpoch === EPOCH && c.connectionEpoch === 1 && c.dimension === 'overworld'));
      assert.ok(h.starts() > 0 && h.starts() <= 4); assert.ok(h.clicks() >= 2); assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pf.goal, null);
      const receipts = result.evidence!['recoveryTravel'] as Array<{ pickup: { counted: number; byKey: Record<string, number>; incidental: string[]; nonItem: string[] } }>;
      assert.equal(receipts.length, h.starts());
      assert.deepEqual(receipts.filter((r) => r.pickup.counted).map((r) => r.pickup.byKey), [{ 'minecraft:bread': 4 }]);
      assert.equal(receipts.reduce((n, r) => n + r.pickup.counted, 0), 4);
      assert.deepEqual(receipts.flatMap((r) => r.pickup.incidental), []); assert.deepEqual(receipts.flatMap((r) => r.pickup.nonItem), ['entity 99 x1']);
      assert.deepEqual(h.returns()?.regained, { 'minecraft:bread': 4 });
      assert.deepEqual(h.runtime.ledger.since(0).filter((e) => e.kind === 'picked_up').map((e) => [e.item, e.count]), [['minecraft:bread', 4]]);
      assert.equal(current.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' }, { goalId: GOAL, goalEpoch: EPOCH }).status, 'unsatisfied');
      await until(() => 'error' in originalTarget({ goalEpoch: EPOCH, connectionEpoch: 1, dimension: 'overworld' }) ? undefined : true, 'updated incident fact never settled');
      const fresh = await h.runtime.executor.execute(h.candidate(), h.abort.signal, h.owner);
      assert.equal(fresh.status, 'succeeded'); assert.equal(fresh.confirmation, 'client_only');
      assert.deepEqual(fresh.evidence!['recoveryTravel'], [], 'fresh arrival neither replays the pickup nor manufactures server confirmation');
      assert.deepEqual(h.returns()?.regained, { 'minecraft:bread': 4 });
      assert.deepEqual(h.runtime.routes!.authorization({ goalEpoch: EPOCH, connectionEpoch: 1, dimension: 'overworld' }), before);
      assert.deepEqual(current.status(Date.now()).incidents[0]!.budget, budgets);
      assert.ok(h.runtime.routes!.status(EPOCH)!.distanceUsed > 0); assert.equal(h.runtime.routes!.status(EPOCH)!.legsUsed, 1);
    } finally { await h.close(); }
  });
  for (const pile of ['unknown', 'oversized'] as const) it(`${pile} pile at the destination vetoes before raw navigation dispatch`, async () => {
    const h = await scene();
    try {
      h.drops(68, pile === 'unknown' ? undefined : 'bread', 64);
      const result = await h.runtime.executor.execute(h.candidate(), h.abort.signal, h.owner);
      assert.equal(result.status, 'failed'); assert.equal(result.reason, 'unrelated_loot_nearby'); assert.equal(h.starts(), 0);
      assert.deepEqual(h.returns()?.regained, {}); assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pf.goal, null);
      assert.equal(h.runtime.ledger.since(0).filter((e) => e.kind === 'picked_up').length, 0);
    } finally { await h.close(); }
  });
  it('an unavoidable unknown collect during final resync propagates a keyless incidental receipt without pickup credit', async () => {
    const h = await scene();
    try {
      let sent = false;
      h.onSync(() => {
        if (h.starts() && !h.pf.goal && !sent) {
          sent = true;
          h.client.emit('spawn_entity', { entityId: 68, type: REGISTRY_26_1_2.entitiesByName['item']!.id, ...SITE });
          h.collect(68, 1); // No stack metadata or local selectable target was supplied.
        }
      });
      h.travel();
      const r = await h.runtime.executor.execute(h.candidate(), h.abort.signal, h.owner);
      assert.equal(r.status, 'partial'); assert.equal(r.reason, 'incidental_pickup'); assert.equal(r.confirmation, 'server_packet');
      const receipts = r.evidence!['recoveryTravel'] as Array<{ pickup: { counted: number; incidental: string[]; byKey: Record<string, number> } }>;
      assert.deepEqual(receipts.flatMap((p) => p.pickup.incidental), ['entity 68 (stack never stated) x1']);
      assert.ok(receipts.every((p) => p.pickup.counted === 0 && Object.keys(p.pickup.byKey).length === 0));
      assert.match(r.effect, /incidental loot collected, not counted as own return/);
      assert.deepEqual(h.returns()?.regained, {}); assert.equal(h.returns()?.attribution, 'unknown');
      assert.equal(h.runtime.ledger.since(0).filter((e) => e.kind === 'picked_up').length, 0);
      assert.equal(h.pf.goal, null); assert.equal(h.runtime.leases.current, undefined);
    } finally { await h.close(); }
  });
  for (const mode of ['disabled', 'missing'] as const) it(`${mode} survival cannot borrow an own-death route or raw fallback`, async () => {
    const h = await scene(mode);
    try {
      assert.equal(h.runtime.survival, undefined);
      const r = await h.runtime.executor.execute(h.candidate(), h.abort.signal, h.owner);
      assert.equal(r.status, 'precondition_failed'); assert.equal(h.starts(), 0); assert.equal(h.clicks(), 0); assert.equal(h.runtime.leases.current, undefined);
    } finally { await h.close(); }
  });
  it('another goal in the same epoch cannot execute the current recovery service or bind its incident', async () => {
    const h = await scene();
    try {
      const r = await h.runtime.executor.execute(h.candidate(), h.abort.signal, { ...h.owner, kind: 'goal', goalId: 'goal-foreign1' });
      assert.equal(r.status, 'precondition_failed'); assert.equal(r.reason, 'not_a_recovery_goal'); assert.equal(h.starts(), 0); assert.equal(h.clicks(), 0);
      assert.equal(h.runtime.routes!.frozenOwnDeath({ goalEpoch: EPOCH, connectionEpoch: 1, dimension: 'overworld' }), null);
    } finally { await h.close(); }
  });
  for (const kind of ['ended', 'dimension', 'replacement'] as const) it(`${kind} during the actual initial inventory sync revokes the same actuator before movement`, async () => {
    const h = await scene();
    try {
      let once = false; h.onSync(() => { if (!once) { once = true; h.invalidate(kind); } });
      const r = await h.runtime.executor.execute(h.candidate(), h.abort.signal, h.owner);
      assert.equal(r.status, 'cancelled', JSON.stringify(r)); assert.equal(h.starts(), 0); assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pf.goal, null);
      assert.deepEqual(h.returns()?.regained, {});
    } finally { await h.close(); }
  });
  it('stop during actual guarded route movement clears the single lease and never credits an uncollected stack', async () => {
    const h = await scene();
    try {
      h.drops(25, 'bread'); h.travel(() => h.abort.abort(new Error('owner_stop')));
      const r = await h.runtime.executor.execute(h.candidate(), h.abort.signal, h.owner);
      assert.equal(r.status, 'cancelled'); assert.equal(h.starts(), 1); assert.equal(h.pf.goal, null); assert.equal(h.runtime.leases.current, undefined); assert.deepEqual(h.returns()?.regained, {});
    } finally { await h.close(); }
  });
  it('replacement during final sync preserves the replacement lease/path while the old guarded executor settles', async () => {
    const h = await scene();
    try {
      let replacement: ReturnType<typeof h.runtime.leases.acquire> | undefined;
      const nextGoal = { x: 1, y: 0, z: 1 };
      h.onSync(() => {
        if (h.starts() && !h.pf.goal && !replacement) {
          h.invalidate('replacement');
          replacement = h.runtime.leases.acquire({ kind: 'goal', goalId: 'goal-replaced1', goalEpoch: EPOCH + 1, taskId: 'task-replaced1' });
          new Actuator(h.session, replacement, systemClock).setPathGoal(nextGoal);
        }
      });
      h.travel();
      const r = await h.runtime.executor.execute(h.candidate(), h.abort.signal, h.owner);
      assert.equal(r.status, 'cancelled'); assert.ok(replacement?.active); assert.equal(h.runtime.leases.current, replacement);
      assert.equal(h.pf.goal, nextGoal, 'old navigation/finally cleanup cannot clear the new owner');
      assert.deepEqual(h.returns()?.regained, {}); assert.equal(h.runtime.ledger.since(0).filter((e) => e.kind === 'picked_up').length, 0);
    } finally { await h.close(); }
  });
});
