// Exact-radius routing against installed A*, then the real resolver/task/
// executor/predicate composition. No world, inference or server evidence claim.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { sequentialIds, systemClock, type AdmittedTask, type DecisionPort, type TaskSpec } from '../src/contracts/index.ts';
import type { GameSession } from '../src/game/connection.ts';
import { conservativeMovements, GoalNearPosition, goals } from '../src/skills/navigation.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { ackSequenced, evidenceFor, fakeClient, fakeMineflayerBot, vec3 } from './skill-fakes.ts';

const require = createRequire(import.meta.url);
type Node = { x: number; y: number; z: number };
const AStar = require('mineflayer-pathfinder/lib/astar.js') as new (start: unknown, movements: unknown, goal: unknown, timeout: number, tickTimeout: number, radius: number) => { compute(): { status: string; path: Node[] } };
const Move = require('mineflayer-pathfinder/lib/move.js') as new (x: number, y: number, z: number, remaining: number, cost: number) => unknown;
function plan(bot: GameSession['bot'], movements: unknown, goal: unknown) {
  const p = bot.entity.position;
  const a = new AStar(new Move(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 0, 0), movements, goal, 1_000, 1_000, 20);
  let r = a.compute(); while (r.status === 'partial') r = a.compute();
  return r;
}
function scene(startX = 4.5) {
  const client = fakeClient((name, data) => {
    if (name === 'window_click') setImmediate(() => client.emit('window_items', { windowId: 0, stateId: 3, items: Array.from({ length: 46 }, () => ({ itemCount: 0 })) }));
    ackSequenced(client, name, data);
  });
  const fake = fakeMineflayerBot(client, { at: { x: startX, y: 0, z: 0.5 }, dimension: 'overworld', loaded: 20 });
  fake.fill(-20, -1, -20, 20, -1, 20, 'stone');
  const pathfinder = { goal: null as unknown, movements: undefined as unknown, bestHarvestTool: () => null, isMoving: () => false, setMovements(m: unknown) { this.movements = m; }, setGoal(g: unknown) {
    this.goal = g; if (!g) return;
    const r = plan(fake.bot as never, this.movements, g);
    // Only physical path following is simulated: installed A* chooses nodes.
    const end = r.path.at(-1);
    if (r.status === 'success' && end) fake.bot.entity.position = vec3(end.x + 0.5, end.y, end.z + 0.5);
    setImmediate(() => { fake.bot.emit('path_update', r); if (r.status === 'success') fake.bot.emit('goal_reached'); });
  } };
  Object.assign(fake.bot, { pathfinder, clearControlStates: () => undefined, stopDigging: () => undefined });
  const session = { bot: fake.bot, connectionEpoch: 1, evidence: evidenceFor(client) } as unknown as GameSession;
  let decisions = 0;
  const decision: DecisionPort = { readiness: () => ({ ready: true, detail: 'scripted' }), choose: async (r) => {
    decisions++; const id = r.candidates[0]!.id;
    return { requestId: r.requestId, candidateId: id, confidence: 1, probabilities: { [id]: 1 }, requestedModel: 'typesafe/jev-1.13', model: 'typesafe/jev-1.13', provider: 'TypeSafe', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 0, attempts: 1 };
  } };
  const store = new MemoryRunStore();
  const config = loadConfigFile(join(PROJECT_ROOT, 'config/examples/fixture-inference-free.json')).config;
  const runtime = new SkillRuntime({ config, session: () => session, connectionEpoch: () => 1, goalEpoch: () => 1, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store, clock: systemClock, ids: sequentialIds(), decision });
  runtime.onGoalAdmitted({ goalId: 'goal-0001', epoch: 1, admittedAtMs: Date.now(), instruction: 'Walk to a supplied position.' });
  return { fake, session, runtime, store, pathfinder, decisions: () => decisions };
}
describe('exact position routing through installed pathfinder and production tasks', () => {
  it('the installed floored GoalNear accepts an outside-radius feet center on completely free supported ground', () => {
    const h = scene(); const { movements } = conservativeMovements(h.session.bot);
    const target = { x: 3.25, y: 0, z: 0.25 };
    const old = plan(h.session.bot, movements, new goals.GoalNear(target.x, target.y, target.z, 1));
    assert.equal(old.status, 'success'); assert.equal(old.path.length, 0);
    assert.ok(h.fake.bot.entity.position.distanceTo(target) > 1.27);
    const fresh = plan(h.session.bot, movements, new GoalNearPosition(target.x, target.y, target.z, 1));
    assert.equal(fresh.status, 'success'); assert.ok(fresh.path.length > 0);
    const last = fresh.path.at(-1)!;
    assert.ok(Math.hypot(last.x + 0.5 - target.x, last.y - target.y, last.z + 0.5 - target.z) <= 1);
    h.session.evidence.detach();
  });
  for (const [x, z] of [[3.25, 0.25], [3.5, 0.5], [3, 0]] as const) it(`actual move/task reaches ${x},${z} with original within=1 and client-only evidence`, async () => {
    const h = scene(5.5), abort = new AbortController();
    const target = { kind: 'owner_destination', dimension: 'overworld', at: { x, y: 0, z }, ownerText: `${x} 0 ${z}` } as const;
    const spec: TaskSpec = { objective: 'Walk there.', decisionInstruction: 'Use an offered option.', allowedCapabilities: ['move_near'], targetSelectors: [target], parameters: { within: 1 }, completion: { predicate: 'near_target', target, within: 1 } };
    const original = structuredClone(spec);
    const task: AdmittedTask = { goalId: 'goal-0001', goalEpoch: 1, taskId: 'task-0001', mode: 'complete', spec, signal: abort.signal, isCurrent: () => !abort.signal.aborted };
    try {
      const r = await h.runtime.tasks.run(task);
      assert.equal(r.reason, 'completion_verified'); assert.equal(h.decisions(), 1);
      assert.ok(h.fake.bot.entity.position.distanceTo(target.at) <= 1, 'raw geometry, never rounded arrival');
      assert.deepEqual(spec, original);
      assert.ok(h.store.events.some(e => e.type === 'skill_outcome' && e['capability'] === 'move_near' && e['confirmation'] === 'client_only'));
      assert.equal(h.runtime.leases.current, undefined); assert.equal(h.pathfinder.goal, null);
    } finally { abort.abort(); h.session.evidence.detach(); }
  });
  it('a solid enclosure yields no path rather than accepting an outside-radius node', () => {
    const h = scene(); h.fake.fill(2, 0, -1, 4, 3, 1, 'stone');
    const r = plan(h.session.bot, conservativeMovements(h.session.bot).movements, new GoalNearPosition(3.25, 0, 0.25, 1));
    assert.notEqual(r.status, 'success'); h.session.evidence.detach();
  });
});
