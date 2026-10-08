// P-LOC-R2: real shared catalog, resolvers, predicates, navigation, executor,
// route/cue service and task loop. Only physical movement and Jev are simulated.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { LocatorConfigSchema } from '../src/contracts/locator.ts';
import { sequentialIds, systemClock, type AdmittedTask, type DecisionPort, type TaskSpec } from '../src/contracts/index.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { ackSequenced, evidenceFor, fakeClient, fakeMineflayerBot, vec3 } from './skill-fakes.ts';

function composition(moving: () => boolean, policy: { maxTotalDistance?: number; hintMaxAgeMs?: number; fixedDestination?: boolean } = {}) {
  const client = fakeClient((name, data) => {
    if (name === 'window_click' && data['stateId'] === -1) setImmediate(() => client.emit('window_items', { windowId: 0, stateId: 3, items: Array.from({ length: 46 }, () => ({ itemCount: 0 })) }));
    ackSequenced(client, name, data);
  });
  const fake = fakeMineflayerBot(client, { dimension: 'overworld', loaded: 180 });
  fake.fill(-40, -1, -40, 180, -1, 40, 'grass_block');
  const uuid = offlinePlayerUuid('FixtureOwner');
  fake.bot.players['FixtureOwner'] = { uuid };
  const pathfinder = { goal: null as { x: number; z: number } | null, setMovements: (_: unknown) => undefined, isMoving: () => false, setGoal(g: unknown) { this.goal = g as typeof this.goal; } };
  Object.assign(fake.bot, { pathfinder, clearControlStates: () => undefined, stopDigging: () => undefined });
  const session = { bot: fake.bot, connectionEpoch: 1, evidence: evidenceFor(client) } as unknown as GameSession;
  const store = new MemoryRunStore();
  let onTaskEvent: (kind: string) => void = () => undefined;
  let decisions = 0, epoch = 1;
  const decision: DecisionPort = { readiness: () => ({ ready: true, detail: 'scripted only' }), choose: async (req) => {
    decisions++;
    const id = req.candidates[0]!.id;
    return { requestId: req.requestId, candidateId: id, confidence: 1, probabilities: { [id]: 1 }, requestedModel: 'typesafe/jev-1.13', model: 'typesafe/jev-1.13', provider: 'TypeSafe', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 0, attempts: 1 };
  } };
  const config = loadConfigFile(join(PROJECT_ROOT, 'config/examples/fixture-inference-free.json')).config;
  config.limits.noProgressMs = 700; // shorter than a seeking window: reproduces the actual seam
  config.limits.observationRadius = 16;
  config.limits.travelRadius = 8;
  config.locator = LocatorConfigSchema.parse({ ...(policy.hintMaxAgeMs ? { hintMaxAgeMs: policy.hintMaxAgeMs } : {}), routes: { ...(policy.fixedDestination ? { destinations: ['owner', 'owner_destination'] } : {}), legRadius: 32, maxLegs: 4, maxTotalDistance: policy.maxTotalDistance ?? 256, maxRouteMs: 20_000 } });
  const runtime = new SkillRuntime({ config, session: () => session, connectionEpoch: () => session.connectionEpoch, goalEpoch: () => epoch, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store, clock: systemClock, ids: sequentialIds(), decision, emitTask: (kind) => onTaskEvent(kind), features: { locator: true } });
  runtime.onBotCreated(fake.bot, 1);
  client.emit('login', {});
  runtime.onLifecycle({ type: 'ready', connectionEpoch: 1, info: { serverVersion: '26.1.2', protocolVersion: 775, dimension: 'overworld', position: { x: 0.5, y: 0, z: 0.5 }, gameMode: 'survival', serverOnlineMode: false } });
  const now = Date.now();
  runtime.onGoalAdmitted({ goalId: 'goal-0001', epoch: 1, admittedAtMs: now, deadlineAtMs: now + 20_000, source: { kind: 'owner' }, instruction: 'arbitrary open-ended owner instruction', ...(policy.fixedDestination ? { ownerCoordinates: [{ x: 120.5, y: 0, z: 0.5, source: 'instruction' as const }] } : {}) });
  let lastStatementAt = 0;
  const cue = () => { lastStatementAt = Date.now(); client.emit('tracked_waypoint', { operation: 'track', waypoint: { hasUUID: true, uuid, icon: { style: 'minecraft:default' }, type: 'vec3i', data: { x: 2000, y: 0, z: 0 } } }); };
  cue();
  let refresh = true;
  const physical = setInterval(() => {
    if (!moving() || !pathfinder.goal) return;
    const p = fake.bot.entity.position, dx = pathfinder.goal.x - p.x, dz = pathfinder.goal.z - p.z, distance = Math.hypot(dx, dz);
    if (distance < 0.35) return;
    fake.bot.entity.position = vec3(p.x + dx / distance * 0.35, p.y, p.z + dz / distance * 0.35);
    fake.bot.emit('move'); // real route path-length accounting remains independent
  }, 25);
  const statements = setInterval(() => { if (refresh) cue(); }, 100);
  const abort = new AbortController();
  const spec: TaskSpec = { objective: 'Maintain proximity to the owner.', decisionInstruction: 'Use an offered option.', allowedCapabilities: ['follow_entity', 'move_near', 'seek_owner'], targetSelectors: [{ kind: 'owner' }], parameters: { durationMs: 1_000 }, completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } };
  if (policy.fixedDestination) {
    spec.objective = 'Perform an open-ended task with a supplied destination.';
    spec.allowedCapabilities = ['route_travel'];
    spec.targetSelectors = [{ kind: 'owner_destination', dimension: 'overworld', at: { x: 120.5, y: 0, z: 0.5 }, ownerText: '120.5 0 0.5' }];
    // An unrelated completion remains unsatisfied. Motion cannot credit items.
    spec.completion = { predicate: 'inventory_amount', selector: 'minecraft:bread', mode: 'possess', atLeast: 1 };
  }
  const task: AdmittedTask = { goalId: 'goal-0001', goalEpoch: 1, taskId: 'task-0001', mode: 'maintain', spec, signal: abort.signal, isCurrent: () => epoch === 1 && !abort.signal.aborted };
  return { runtime, fake, client, session, store, abort, task, pathfinder, onTaskEvent: (f: typeof onTaskEvent) => { onTaskEvent = f; }, decisions: () => decisions, expireCue: () => { refresh = false; return lastStatementAt; }, withdraw: () => { refresh = false; client.emit('tracked_waypoint', { operation: 'untrack', waypoint: { hasUUID: true, uuid, icon: { style: 'minecraft:default' }, type: 'empty' } }); }, replace: () => { epoch = 2; runtime.leases.revokeCurrent('new_goal'); }, close: () => { clearInterval(physical); clearInterval(statements); abort.abort(); runtime.onLifecycle({ type: 'ended', connectionEpoch: 1, reason: 'operator_stop', detail: 'test cleanup' }); session.evidence.detach(); } };
}

describe('P-LOC-R2 owned motion through production SkillRuntime/TaskRuntime', () => {
  it('useful hidden-owner seeking exceeds a stall window and continues locally without completion or another decision', async () => {
    const h = composition(() => true);
    const before = structuredClone(h.runtime.routes!.authorization({ goalEpoch: 1, connectionEpoch: 1, dimension: 'overworld' }));
    let continued = false;
    h.onTaskEvent((kind) => { if (kind === 'task_local_continuation') continued = true; if (kind === 'task_motion_progress' && continued) h.abort.abort(new Error('owner_stop')); });
    const timer = setTimeout(() => h.abort.abort(new Error('test_timeout')), 9_000);
    try {
      const result = await h.runtime.tasks.run(h.task);
      assert.equal(result.status, 'cancelled'); assert.equal(h.decisions(), 1);
      assert.ok(result.localContinuations >= 1, JSON.stringify(result));
      const receipts = h.store.events.filter((e) => e.type === 'task_motion_progress');
      assert.ok(receipts.length >= 2); assert.ok(receipts.every((e) => e['provenance'] === 'client_only'));
      assert.ok(h.store.events.some((e) => e.type === 'skill_outcome' && e['reason'] === 'route_window_elapsed' && e['confirmation'] === 'client_only' && Number(e['elapsedMs']) > 700));
      assert.ok(h.store.events.filter((e) => e.type === 'task_completion').every((e) => e['status'] !== 'satisfied'), 'motion is not arrival');
      assert.equal(h.runtime.perception.take(1)!.owner.visible, false);
      const after = h.runtime.routes!.authorization({ goalEpoch: 1, connectionEpoch: 1, dimension: 'overworld' });
      assert.deepEqual(after, before, 'immutable anchor, deadline and all route ceilings');
      const status = h.runtime.routes!.status(1)!;
      assert.ok(status.legsUsed > 0 && status.legsUsed <= status.maxLegs); assert.ok(status.distanceUsed > 0 && status.distanceUsed < status.maxTotalDistance);
      assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pathfinder.goal, null);
      const keys = ['type', 'taskId', 'goalId', 'goalEpoch', 'actionId', 'capability', 'sampledAtMs', 'netProgress', 'provenance'].sort();
      assert.ok(receipts.every((e) => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(keys)), 'bounded receipt has no hidden position, raw cue or grant');
      assert.equal(h.runtime.ledger.result(String(receipts[0]!['actionId'])), undefined, 'client motion never creates verified effects');
    } finally { clearTimeout(timer); h.close(); }
  });
  it('stationary seeking with the same fresh cue blocks and emits no useful motion', async () => {
    const h = composition(() => false);
    const timer = setTimeout(() => h.abort.abort(new Error('test_timeout')), 9_000);
    try {
      const result = await h.runtime.tasks.run(h.task);
      assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'no_progress'); assert.equal(h.decisions(), 1);
      assert.equal(h.store.events.filter((e) => e.type === 'task_motion_progress').length, 0);
      assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pathfinder.goal, null);
    } finally { clearTimeout(timer); h.close(); }
  });
  it('a finite hidden-owner task continues its useful window and completes only at the visible exact within-three predicate', async () => {
    const h = composition(() => true);
    const owner = h.fake.addEntity({ id: 50, type: 'player', name: 'player', username: 'FixtureOwner', uuid: offlinePlayerUuid('FixtureOwner'), height: 1.8, at: { x: 30.5, y: 0, z: 0.5 } });
    h.task.mode = 'complete';
    const original = structuredClone(h.task.spec);
    assert.equal(h.runtime.perception.take(1)!.owner.visible, false);
    const timer = setTimeout(() => h.abort.abort(new Error('test_timeout')), 9_000);
    try {
      const result = await h.runtime.tasks.run(h.task);
      assert.equal(result.status, 'completed'); assert.equal(result.reason, 'completion_verified');
      const outcomes = h.store.events.filter((e) => e.type === 'skill_outcome');
      assert.ok(outcomes.some((e) => e['capability'] === 'seek_owner' && e['reason'] === 'route_window_elapsed'));
      assert.ok(outcomes.filter((e) => e['status'] === 'succeeded' || e['status'] === 'partial').length >= 2, 'the real first offered option continues; no capability is forced');
      const actions = new Set(h.store.events.filter((e) => e.type === 'task_motion_progress').map((e) => e['actionId']));
      assert.ok(actions.size >= 2, 'actual motion continues across the execution window');
      const p = h.fake.bot.entity.position, at = owner.position;
      assert.ok(Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z) <= 3, 'unrounded exact predicate, never 3.3-as-3');
      assert.deepEqual(h.task.spec, original, 'no parameter, outcome or task rewrite');
      assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pathfinder.goal, null);
    } finally { clearTimeout(timer); h.close(); }
  });
  it('the registered sustained follow loop also publishes fenced client-only motion while approaching a visible owner', async () => {
    const h = composition(() => true);
    h.fake.addEntity({ id: 50, type: 'player', name: 'player', username: 'FixtureOwner', uuid: offlinePlayerUuid('FixtureOwner'), height: 1.8, at: { x: 7.5, y: 0, z: 0.5 } });
    h.task.mode = 'complete'; h.task.spec.allowedCapabilities = ['follow_entity'];
    const timer = setTimeout(() => h.abort.abort(new Error('test_timeout')), 9_000);
    try {
      const result = await h.runtime.tasks.run(h.task);
      assert.equal(result.reason, 'completion_verified'); assert.equal(h.decisions(), 1);
      assert.ok(h.store.events.some((e) => e.type === 'task_motion_progress' && e['capability'] === 'follow_entity' && e['provenance'] === 'client_only'));
      assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pathfinder.goal, null);
    } finally { clearTimeout(timer); h.close(); }
  });
  it('early useful motion followed by a stalled execution uses sample time, not its later settlement time', async () => {
    let moving = true;
    const h = composition(() => moving);
    h.onTaskEvent((kind) => { if (kind === 'task_motion_progress') moving = false; });
    const timer = setTimeout(() => h.abort.abort(new Error('test_timeout')), 9_000);
    try {
      const result = await h.runtime.tasks.run(h.task);
      assert.equal(result.reason, 'no_progress'); assert.equal(result.localContinuations, 0); assert.equal(h.decisions(), 1);
      const receipts = h.store.events.filter((e) => e.type === 'task_motion_progress');
      assert.ok(receipts.length > 0);
      const last = Number(receipts.at(-1)!['sampledAtMs']);
      assert.ok(Date.now() - last > 700, 'elapsed partial cannot refresh the old motion timestamp');
      assert.equal(h.runtime.leases.current, undefined);
    } finally { clearTimeout(timer); h.close(); }
  });
  it('useful movement stops at the original cumulative route ceiling without a new grant', async () => {
    const h = composition(() => true, { maxTotalDistance: 64 });
    const auth = structuredClone(h.runtime.routes!.authorization({ goalEpoch: 1, connectionEpoch: 1, dimension: 'overworld' }));
    const timer = setTimeout(() => h.abort.abort(new Error('test_timeout')), 12_000);
    try {
      const result = await h.runtime.tasks.run(h.task);
      assert.equal(result.status, 'blocked'); assert.equal(result.decisions, h.decisions());
      assert.ok(result.decisions <= 3, 'the existing two per-target retries remain bounded and counted');
      const status = h.runtime.routes!.status(1)!;
      assert.equal(status.state, 'exhausted'); assert.equal(status.blocker?.reason, 'distance_limit'); assert.equal(status.maxTotalDistance, 64); assert.ok(status.distanceUsed >= 64);
      assert.deepEqual(h.runtime.routes!.authorization({ goalEpoch: 1, connectionEpoch: 1, dimension: 'overworld' }), auth);
      assert.ok(h.store.events.some((e) => e.type === 'task_motion_progress'));
      assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pathfinder.goal, null);
    } finally { clearTimeout(timer); h.close(); }
  });
  it('expired guidance ends movement and cannot refresh progress with its old cue', async () => {
    const h = composition(() => true, { hintMaxAgeMs: 1_000 });
    let statementAt = 0;
    h.onTaskEvent((kind) => { if (kind === 'task_motion_progress' && !statementAt) statementAt = h.expireCue(); });
    const timer = setTimeout(() => h.abort.abort(new Error('test_timeout')), 9_000);
    try {
      const result = await h.runtime.tasks.run(h.task);
      assert.equal(result.status, 'blocked'); assert.equal(h.decisions(), 1);
      assert.equal(h.runtime.locator!.ownerHint().reason, 'expired'); assert.ok(statementAt > 0);
      const receipts = h.store.events.filter((e) => e.type === 'task_motion_progress');
      assert.ok(receipts.length > 0); assert.ok(receipts.every((e) => Number(e['sampledAtMs']) <= statementAt + 1_000));
      assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pathfinder.goal, null);
    } finally { clearTimeout(timer); h.close(); }
  });
  for (const interruption of ['withdraw', 'replace', 'stop'] as const) it(`${interruption}: existing motion cannot authorize later dispatch or progress`, async () => {
    const h = composition(() => true);
    let countAtInterruption = -1;
    h.onTaskEvent((kind) => {
      if (kind !== 'task_motion_progress' || countAtInterruption >= 0) return;
      countAtInterruption = h.store.events.filter((e) => e.type === 'task_motion_progress').length;
      if (interruption === 'withdraw') h.withdraw();
      else if (interruption === 'replace') h.replace();
      else h.abort.abort(new Error('owner_stop'));
    });
    const timeout = setTimeout(() => h.abort.abort(new Error('test_timeout')), 9_000);
    try {
      const result = await h.runtime.tasks.run(h.task);
      assert.ok(countAtInterruption > 0);
      assert.equal(h.store.events.filter((e) => e.type === 'task_motion_progress').length, countAtInterruption);
      assert.equal(h.decisions(), 1); assert.equal(result.localContinuations, 0);
      assert.equal(result.status, interruption === 'withdraw' ? 'blocked' : 'cancelled');
      assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pathfinder.goal, null);
    } finally { clearTimeout(timeout); h.close(); }
  });
});

describe('fixed destinations through the same production task/executor motion seam', () => {
  it('useful current route motion continues locally without owner cues or inventory/completion credit', async () => {
    const h = composition(() => true, { fixedDestination: true });
    h.task.mode = 'complete'; h.withdraw();
    const original = structuredClone(h.task.spec), auth = structuredClone(h.runtime.routes!.authorization({ goalEpoch: 1, connectionEpoch: 1, dimension: 'overworld' }));
    let continued = false;
    h.onTaskEvent((kind) => { if (kind === 'task_local_continuation') continued = true; if (kind === 'task_motion_progress' && continued) h.abort.abort(new Error('owner_stop')); });
    const timer = setTimeout(() => h.abort.abort(new Error('test_timeout')), 9_000);
    try {
      const result = await h.runtime.tasks.run(h.task);
      assert.equal(result.status, 'cancelled'); assert.equal(h.decisions(), 1);
      assert.ok(result.localContinuations >= 1, JSON.stringify(result));
      assert.ok(h.store.events.some((e) => e.type === 'skill_outcome' && e['capability'] === 'route_travel' && e['reason'] === 'route_window_elapsed' && e['confirmation'] === 'client_only'));
      const receipts = h.store.events.filter((e) => e.type === 'task_motion_progress');
      assert.ok(receipts.length >= 2 && receipts.every((e) => e['provenance'] === 'client_only'));
      assert.ok(h.store.events.filter((e) => e.type === 'task_completion').every((e) => e['status'] !== 'satisfied'));
      assert.equal(h.runtime.locator!.ownerHint().actionable, false);
      assert.deepEqual(h.task.spec, original); assert.deepEqual(h.runtime.routes!.authorization({ goalEpoch: 1, connectionEpoch: 1, dimension: 'overworld' }), auth);
      const status = h.runtime.routes!.status(1)!;
      assert.ok(status.legsUsed > 0 && status.distanceUsed > 0 && status.distanceUsed < status.maxTotalDistance);
      assert.equal(h.runtime.ledger.result(String(receipts[0]!['actionId'])), undefined);
      assert.ok(receipts.every((e) => !JSON.stringify(e).includes('120.5')), 'private destination never enters motion telemetry');
      assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pathfinder.goal, null);
    } finally { clearTimeout(timer); h.close(); }
  });
  it('a stagnant fixed-destination window still blocks instead of manufacturing progress from its elapsed outcome', async () => {
    const h = composition(() => false, { fixedDestination: true }); h.task.mode = 'complete'; h.withdraw();
    const timer = setTimeout(() => h.abort.abort(new Error('test_timeout')), 9_000);
    try {
      const result = await h.runtime.tasks.run(h.task);
      assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'no_progress'); assert.equal(h.decisions(), 1);
      assert.equal(h.store.events.filter((e) => e.type === 'task_motion_progress').length, 0);
      assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pathfinder.goal, null);
    } finally { clearTimeout(timer); h.close(); }
  });
});
