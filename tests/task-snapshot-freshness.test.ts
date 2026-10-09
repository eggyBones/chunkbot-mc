// P-TASK-R15: actual SkillRuntime/Perception/PredicateEngine/registered resolver/
// executor/actuator composition. Only packets, physical motion and Jev are fake.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { sequentialIds, systemClock, type AdmittedTask, type DecisionPort, type DecisionRequest, type ObservationSnapshot, type TaskSpec } from '../src/contracts/index.ts';
import type { GameSession } from '../src/game/connection.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { ackSequenced, evidenceFor, fakeClient, fakeMineflayerBot, vec3 } from './skill-fakes.ts';

function composition() {
  const client = fakeClient((name, data) => {
    if (name === 'window_click' && data['stateId'] === -1) setImmediate(() => client.emit('window_items', { windowId: 0, stateId: 3, items: Array.from({ length: 46 }, () => ({ itemCount: 0 })) }));
    ackSequenced(client, name, data);
  });
  const fake = fakeMineflayerBot(client, { dimension: 'overworld' });
  fake.fill(-20, -1, -20, 20, -1, 20, 'grass_block');
  const owner = fake.addEntity({ id: 50, type: 'player', name: 'player', username: 'FixtureOwner', uuid: offlinePlayerUuid('FixtureOwner'), height: 1.8, at: { x: 5.5, y: 0, z: 0.5 } });
  const goals: unknown[] = [];
  Object.assign(fake.bot, {
    pathfinder: { goal: null as unknown, setMovements: () => undefined, isMoving: () => false, setGoal(g: unknown) {
      this.goal = g;
      if (g) { goals.push(g); fake.bot.entity.position = vec3(owner.position.x - 2, 0, 0.5); }
    } },
    clearControlStates: () => undefined, stopDigging: () => undefined,
  });
  const abort = new AbortController();
  let current = true, connectionEpoch = 1;
  let session: GameSession | undefined = { bot: fake.bot, connectionEpoch, evidence: evidenceFor(client) } as unknown as GameSession;
  const requests: DecisionRequest[] = [], snapshots: ObservationSnapshot[] = [];
  const store = new MemoryRunStore();
  const decision: DecisionPort = { readiness: () => ({ ready: true, detail: 'scripted first offered option only' }), choose: async (req) => {
    requests.push(req);
    // Bound an unchanged parent's failing reproduction without dispatching a stale action.
    if (!current || connectionEpoch !== 1 || !session || fake.bot.health <= 8 || owner.position.x > 32) abort.abort();
    const id = req.candidates[0]!.id;
    return { requestId: req.requestId, candidateId: id, confidence: 1, probabilities: { [id]: 1 }, requestedModel: 'typesafe/jev-1.13', model: 'typesafe/jev-1.13', provider: 'TypeSafe', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 0, attempts: 1 };
  } };
  const config = loadConfigFile(join(PROJECT_ROOT, 'config/examples/fixture-inference-free.json')).config;
  const runtime = new SkillRuntime({ config, session: () => session, connectionEpoch: () => connectionEpoch, goalEpoch: () => 1, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store, clock: systemClock, ids: sequentialIds(), decision });
  runtime.onGoalAdmitted({ goalId: 'goal-r150', epoch: 1, admittedAtMs: Date.now(), instruction: 'arbitrary owner instruction' });
  const take = runtime.perception.take.bind(runtime.perception);
  runtime.perception.take = (epoch) => { const snapshot = take(epoch); if (snapshot) snapshots.push(snapshot); return snapshot; };
  const spec: TaskSpec = { objective: 'Approach the visible target.', decisionInstruction: 'Use an offered option.', allowedCapabilities: ['follow_entity'], targetSelectors: [{ kind: 'owner' }], parameters: { durationMs: 1_000 }, completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } };
  const task: AdmittedTask = { goalId: 'goal-r150', goalEpoch: 1, taskId: 'task-r150', mode: 'complete', spec, signal: abort.signal, isCurrent: () => current && !abort.signal.aborted };
  const duringEvaluation = (change: () => void) => {
    const evaluate = runtime.predicates.evaluate.bind(runtime.predicates);
    let first = true;
    runtime.predicates.evaluate = async (...args) => {
      if (first) { first = false; await Promise.resolve(); change(); }
      return evaluate(...args);
    };
  };
  return { runtime, fake, client, owner, goals, abort, store, requests, snapshots, task, duringEvaluation,
    revoke: () => { current = false; },
    replace: () => { connectionEpoch++; session = { ...session!, connectionEpoch }; },
    detach: () => { session = undefined; },
  };
}

function noDecisionOrMotion(h: ReturnType<typeof composition>) {
  assert.equal(h.requests.length, 0, 'no obsolete candidate/model request');
  assert.equal(h.goals.length, 0, 'no navigation writes');
  assert.equal(h.runtime.leases.current, undefined);
  assert.equal(h.store.ofType('task_action').length, 0, 'no actual settled executor outcome');
}

describe('P-TASK-R15 post-predicate snapshot through actual production composition', () => {
  it('visible-to-hidden owner during the await has no stale candidate/model/action', async () => {
    const h = composition();
    h.duringEvaluation(() => { h.owner.position = vec3(80.5, 0, 0.5); });
    const result = await h.runtime.tasks.run(h.task);
    assert.equal(result.reason, 'no_candidates');
    assert.equal(result.feedback.completion?.status, 'unknown');
    assert.equal(h.snapshots[0]!.owner.visible, true);
    assert.equal(h.snapshots.at(-1)!.owner.visible, false);
    assert.ok(result.feedback.unavailable.some((u) => u.reason === 'no_visible_entity'));
    noDecisionOrMotion(h);
  });
  it('fresh visible target grounds the actual first-option follow, exact completion and model/journal metadata', async () => {
    const h = composition();
    h.duringEvaluation(() => { h.owner.position = vec3(7.5, 0, 0.5); });
    const result = await h.runtime.tasks.run(h.task);
    assert.equal(result.status, 'completed', result.detail); assert.equal(result.actions, 1); assert.equal(result.decisions, 1);
    const req = h.requests[0]!, snapshot = h.snapshots.find((s) => s.id === req.snapshotId)!;
    assert.notEqual(snapshot.id, h.snapshots[0]!.id);
    assert.deepEqual(h.snapshots[0]!.owner.at, { x: 5.5, y: 0, z: 0.5 });
    assert.deepEqual(snapshot.owner.at, { x: 7.5, y: 0, z: 0.5 });
    const observation = (req.state as Record<string, unknown>)['observation'] as Record<string, unknown>;
    const round = h.store.ofType('task_round')[0]!;
    assert.deepEqual(observation['owner'], snapshot.owner);
    assert.deepEqual([round['snapshotId'], round['snapshotTakenAtMs'], round['snapshotGoalEpoch'], round['connectionEpoch']], [snapshot.id, snapshot.takenAtMs, snapshot.goalEpoch, snapshot.connectionEpoch]);
    assert.deepEqual([observation['snapshotId'], observation['takenAtMs'], observation['goalEpoch'], observation['connectionEpoch']], [snapshot.id, snapshot.takenAtMs, snapshot.goalEpoch, snapshot.connectionEpoch]);
    assert.ok(Math.hypot(h.owner.position.x - h.fake.bot.entity.position.x, h.owner.position.z - h.fake.bot.entity.position.z) <= 3);
    assert.ok(h.goals.length > 0); assert.equal(h.runtime.leases.current, undefined);
  });
  it('current health falling during evaluation blocks before inference or motion', async () => {
    const h = composition();
    h.duringEvaluation(() => { h.client.emit('update_health', { health: 6, food: 20, foodSaturation: 5 }); h.fake.bot.health = 6; });
    const result = await h.runtime.tasks.run(h.task);
    assert.equal(result.reason, 'low_health'); assert.equal(h.snapshots.at(-1)!.self.health, 6);
    noDecisionOrMotion(h);
  });
  for (const change of ['revoke', 'abort', 'replace'] as const) it(`${change} during evaluation cannot admit a new request or connection`, async () => {
    const h = composition();
    h.duringEvaluation(() => { if (change === 'abort') h.abort.abort(); else h[change](); });
    const result = await h.runtime.tasks.run(h.task);
    assert.equal(result.reason, 'ownership_revoked'); assert.equal(result.status, 'cancelled');
    noDecisionOrMotion(h);
  });
  it('a detached ready session after evaluation fails before candidates/model/action', async () => {
    const h = composition(); h.duringEvaluation(h.detach);
    assert.equal((await h.runtime.tasks.run(h.task)).reason, 'not_connected');
    noDecisionOrMotion(h);
  });
  it('verified satisfied completion returns without constructing a new request snapshot', async () => {
    const h = composition(); h.duringEvaluation(() => { h.owner.position = vec3(2.5, 0, 0.5); });
    const result = await h.runtime.tasks.run(h.task);
    assert.equal(result.reason, 'completion_verified'); assert.equal(result.rounds, 1);
    assert.equal(h.snapshots.length, 1); noDecisionOrMotion(h);
  });
  it('even satisfied completion from a replaced connection is discarded', async () => {
    const h = composition(); h.duringEvaluation(() => { h.owner.position = vec3(2.5, 0, 0.5); h.replace(); });
    assert.equal((await h.runtime.tasks.run(h.task)).reason, 'ownership_revoked');
    noDecisionOrMotion(h);
  });
  it('ownership lost during the fresh take cannot reach candidate/model state', async () => {
    const h = composition(), take = h.runtime.perception.take.bind(h.runtime.perception);
    let calls = 0;
    h.runtime.perception.take = (epoch) => { const s = take(epoch); if (++calls === 2) h.revoke(); return s; };
    assert.equal((await h.runtime.tasks.run(h.task)).reason, 'ownership_revoked');
    noDecisionOrMotion(h);
  });
  it('connection replaced during the fresh take cannot supply new action authority', async () => {
    const h = composition(), take = h.runtime.perception.take.bind(h.runtime.perception);
    let calls = 0;
    h.runtime.perception.take = (epoch) => { if (++calls === 2) h.replace(); return take(epoch); };
    assert.equal((await h.runtime.tasks.run(h.task)).reason, 'ownership_revoked');
    noDecisionOrMotion(h);
  });
});
