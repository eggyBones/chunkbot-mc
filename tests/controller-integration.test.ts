// Controller integration: GoalEngine + the REAL SkillRuntime (perception,
// registered resolvers, candidate generator, executor, predicate engine, task
// runtime) over a Mineflayer-shaped bot, with the REAL JevDecisionAdapter
// talking to a loopback provider fault fixture. Covers the MB-SKL-007 travel
// anchor through the controller (captured at admission before the Jev wait,
// unchanged by a server correction and the delayed first action, replaced only
// by a new admission), the plan-window seam (task completion is not goal
// completion; structured feedback reaches the next planner turn), and silence
// while idle or awaiting the owner.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { sequentialIds, systemClock, type PlannerProposal, type TaskSpec } from '../src/contracts/index.ts';
import { JevDecisionAdapter } from '../src/decision/jev-adapter.ts';
import { PROMPT_USD_PER_TOKEN } from '../src/decision/pricing.ts';
import { SpendLedger } from '../src/decision/spend.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import type { GoalEngine } from '../src/goals/goal-engine.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { ScriptedPlanner, clarify, makeEngine, until } from './helpers.ts';
import { ackSequenced, fakeClient, fakeMineflayerBot, REGISTRY_26_1_2, vec3, type FakeClient } from './skill-fakes.ts';

const TERMINAL = { surface: 'terminal', principal: 'operator' } as const;
const OWNER = { surface: 'chat', principal: 'owner' } as const;

// ---------------------------------------------------------------- loopback provider fault fixture
let server: Server;
let endpoint = '';
const provider = { requests: [] as Array<Record<string, any>>, delayMs: 0, onRequest: undefined as undefined | (() => void) }; // eslint-disable-line @typescript-eslint/no-explicit-any

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      provider.requests.push(parsed);
      provider.onRequest?.();
      const keys = Object.keys(parsed.questions.next_action.criteria) as string[];
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            model: 'typesafe/jev-1.13-20260917',
            provider: 'TypeSafe',
            id: 'gen-dec-fixture',
            answers: { next_action: { type: 'choice', choice: keys[0], probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])), confidence: 1 } },
            usage: { input_tokens: 500, output_tokens: 20, cost: 500 * PROMPT_USD_PER_TOKEN },
          }),
        );
      }, provider.delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/alpha/decisions`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

// ---------------------------------------------------------------- scene

function scene(plannerOverride?: ScriptedPlanner) {
  provider.requests = [];
  provider.delayMs = 0;
  provider.onRequest = undefined;
  const client: FakeClient = fakeClient((name, data) => {
    // Answer correlated inventory resyncs (window_click mode 5) with the player window, then ack the barrier.
    if (name === 'window_click' && data['mode'] === 5) setImmediate(() => client.emit('window_items', { windowId: 0, stateId: 1, items: Array.from({ length: 46 }, () => ({ itemCount: 0 })) }));
    ackSequenced(client, name, data);
  });
  const fake = fakeMineflayerBot(client, { loaded: 200 });
  fake.fill(-20, -1, -20, 20, -1, 20, 'grass_block');
  const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never);
  evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  Object.assign(fake.bot, { pathfinder: { setMovements: () => undefined, setGoal: () => undefined, isMoving: () => false }, clearControlStates: () => undefined, setControlState: () => undefined, lookAt: () => Promise.resolve() });
  const config = loadConfigFile(join(PROJECT_ROOT, 'config', 'examples', 'fixture.json')).config; // travelRadius 128
  const store = new MemoryRunStore();
  const spend = new SpendLedger(1);
  const decision = new JevDecisionAdapter({ endpoint, model: 'typesafe/jev-1.13', apiKeyEnv: 'OPENROUTER_API_KEY', env: () => ({ OPENROUTER_API_KEY: 'sk-fixture-not-a-real-key-000000' }), expectedProvider: 'TypeSafe', spend, store, clock: systemClock, timeoutMs: 2_000, minIntervalMs: 20, attemptsPerGoal: 50 });
  let engineRef: GoalEngine | undefined;
  const runtime = new SkillRuntime({ config, session: () => session, connectionEpoch: () => 1, goalEpoch: () => engineRef?.currentEpoch ?? 0, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store, clock: systemClock, ids: sequentialIds(), decision });
  const planner = plannerOverride;
  const h = makeEngine({ ...runtime.adapters(), ...(planner ? { planner } : {}), onGoalAdmitted: (a) => runtime.onGoalAdmitted(a) });
  engineRef = h.engine;
  return { fake, runtime, engine: h.engine, store, engineStore: h.store, spend };
}

const moveTask = (x: number): TaskSpec => ({
  objective: `Walk to the owner-supplied point ${x} 0 0.`,
  decisionInstruction: 'Choose the grounded movement option toward the destination.',
  allowedCapabilities: ['move_near'],
  targetSelectors: [{ kind: 'owner_destination', dimension: 'minecraft:overworld', at: { x, y: 0, z: 0.5 }, ownerText: `${x} 0 0` }],
  parameters: {},
  completion: { predicate: 'near_target', target: { kind: 'owner_destination', dimension: 'minecraft:overworld', at: { x, y: 0, z: 0.5 }, ownerText: `${x} 0 0` }, within: 2 },
});

describe('MB-SKL-007 through the controller: admission anchor survives the Jev wait and the delayed first action', () => {
  it('captures the anchor at admission (before any provider call), keeps it through a server correction and the first action, and a replacement gets a fresh one', async () => {
    const s = scene();
    provider.delayMs = 150;
    // The anchor must already exist when the FIRST provider request is made.
    let anchorAtFirstRequest: number | undefined;
    provider.onRequest = () => {
      anchorAtFirstRequest ??= s.runtime.perception.travelBounds()?.anchor.x;
      // Server correction / knockback while Jev is deciding: Chunkbot ends up 129 blocks away.
      s.fake.bot.entity.position = vec3(129.5, 0, 0.5);
    };
    const admitted = await s.engine.submitOperatorTask(moveTask(60.5), 'complete', TERMINAL);
    assert.equal(admitted.status, 'admitted');
    assert.equal(admitted.status === 'admitted' && admitted.goal.kind, 'operator_task_diagnostic');
    assert.equal(s.runtime.perception.travelAnchorGoalEpoch(), s.engine.currentEpoch, 'anchor owned by the admitted epoch');
    assert.equal(s.runtime.perception.travelBounds()?.anchor.x, 0.5, 'captured at the admission position');
    await until(() => s.store.ofType('task_action').length >= 1, 8_000);
    assert.equal(anchorAtFirstRequest, 0.5, 'the anchor existed before the first Jev request');
    const first = s.store.ofType('task_action')[0]!;
    assert.equal(first['capability'], 'move_near');
    // With the admission anchor at 0.5 (radius 128) the corrected position is OUTSIDE the bound,
    // so the delayed first action must stop at the travel guard instead of walking.
    assert.match(String(first['reason']), /outside_travel_bounds/, `${first['status']} ${first['reason']} ${first['effect']}`);
    assert.equal(s.runtime.perception.travelBounds()?.anchor.x, 0.5, 'the first action did not reset the anchor');
    const choice = s.store.ofType('task_choice')[0]!;
    assert.equal(choice['model'], 'typesafe/jev-1.13-20260917');
    // Replacement admission installs a fresh anchor at the bot's actual position.
    const epochBefore = s.engine.currentEpoch;
    const replaced = await s.engine.submitOperatorTask(moveTask(140.5), 'complete', TERMINAL);
    assert.equal(replaced.status, 'admitted');
    assert.ok(s.engine.currentEpoch > epochBefore);
    assert.equal(s.runtime.perception.travelBounds()?.anchor.x, 129.5, 'fresh anchor for the replacement');
    assert.equal(s.runtime.perception.travelAnchorGoalEpoch(), s.engine.currentEpoch);
    await s.engine.stop('owner_stop');
    const terminals = s.engineStore.ofType('goal_terminal');
    assert.equal(terminals[0]?.['reason'], 'replaced');
  });

  it('stop while the Jev request is in flight: provider I/O aborted, no action dispatched, goal cancelled', async () => {
    const s = scene();
    provider.delayMs = 1_500;
    await s.engine.submitOperatorTask(moveTask(10.5), 'complete', TERMINAL);
    await until(() => provider.requests.length === 1, 8_000);
    const t = Date.now();
    await s.engine.stop('owner_stop');
    assert.ok(Date.now() - t < 1_000, 'stop did not wait for the provider reply');
    await new Promise((r) => setTimeout(r, 1_700)); // the reply would have arrived by now
    assert.equal(s.store.ofType('task_action').length, 0, 'no action from the late reply');
    assert.equal(s.store.ofType('skill_started').length, 0);
    assert.equal(s.engine.status().goal?.state, 'cancelled');
    assert.equal(s.store.ofType('jev_failure')[0]?.['kind'], 'aborted');
  });
});

describe('plan-window seam (generic; the real planner arrives in MB-V1-04)', () => {
  it('a completed task is not goal completion; the goal completes only when its own outcome is verified', async () => {
    const planner = new ScriptedPlanner();
    const s = scene(planner);
    await s.engine.submit('come stand right here at 0.5 0 0.5, and later at 50.5 0 0.5', OWNER);
    await until(() => planner.waiting === 1);
    // Task completion is trivially satisfied (already here), the goal outcome is not (a point 50 away).
    const here: TaskSpec = { ...moveTask(0.5) };
    const plan: PlannerProposal = { version: 1, disposition: 'plan', interpretation: 'walk somewhere', outcome: { kind: 'finite', outcome: moveTask(50.5).completion }, tasks: [here], morePlanningNeeded: true };
    planner.respond(plan);
    await until(() => planner.waiting === 1 && planner.requests.length === 2, 8_000);
    assert.notEqual(s.engine.status().goal?.state, 'completed', 'task completion did not complete the goal');
    const feedback = planner.requests[1]!.feedback ?? [];
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0]!.status, 'completed');
    assert.equal(provider.requests.length, 0, 'an already satisfied task needs no inference');
    // Now a window whose outcome is verified: the goal completes from the outcome contract.
    planner.respond({ ...plan, outcome: { kind: 'finite', outcome: moveTask(50.5).completion }, tasks: [moveTask(0.5)] });
    await until(() => planner.waiting === 1 && planner.requests.length === 3, 8_000);
    await s.engine.stop('owner_stop');
  });

  it('a goal whose outcome is verified after its window completes with outcome_verified', async () => {
    const planner = new ScriptedPlanner();
    const s = scene(planner);
    await s.engine.submit('stand where you are (0.5 0 0.5)', OWNER);
    await until(() => planner.waiting === 1);
    planner.respond({ version: 1, disposition: 'plan', interpretation: 'stay', outcome: { kind: 'finite', outcome: moveTask(0.5).completion }, tasks: [moveTask(0.5)], morePlanningNeeded: false });
    await until(() => s.engine.status().goal?.state === 'completed', 8_000);
    assert.equal(s.engine.status().goal?.terminal?.reason, 'outcome_verified');
  });

  it('a blocked task returns structured feedback (missing ingredients) to the next planner turn, with no Jev call', async () => {
    const planner = new ScriptedPlanner();
    const s = scene(planner);
    await s.engine.submit('make a wooden pickaxe', OWNER);
    await until(() => planner.waiting === 1);
    const craft: TaskSpec = { objective: 'Craft a wooden pickaxe.', decisionInstruction: 'Craft it.', allowedCapabilities: ['craft_item'], targetSelectors: [], parameters: {}, completion: { predicate: 'crafting_result', output: 'minecraft:wooden_pickaxe', atLeast: 1 } };
    planner.respond({ version: 1, disposition: 'plan', interpretation: 'craft', outcome: { kind: 'finite', outcome: craft.completion }, tasks: [craft], morePlanningNeeded: true });
    await until(() => planner.requests.length === 2, 8_000);
    const fb = planner.requests[1]!.feedback?.[0];
    assert.equal(fb?.status, 'blocked');
    assert.equal(fb?.reason, 'no_candidates');
    assert.ok(fb?.unavailable.some((u) => u.capability === 'craft_item' && /missing_ingredients|workstation_required/.test(u.reason)), JSON.stringify(fb?.unavailable));
    assert.equal(provider.requests.length, 0);
    planner.respond({ version: 1, disposition: 'cannot_execute', interpretation: 'craft', missing: 'no wood is visible', missingCapabilities: [], verifiedProgress: '' });
    await until(() => s.engine.status().goal?.state === 'blocked');
  });
});

describe('quiet states', () => {
  it('idle and awaiting-owner states make no Jev calls', async () => {
    const planner = new ScriptedPlanner();
    const s = scene(planner);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(provider.requests.length, 0, 'idle');
    await s.engine.submit('build something nice', OWNER);
    await until(() => planner.waiting === 1);
    planner.respond(clarify('what should I build?'));
    await until(() => s.engine.status().goal?.state === 'awaiting_owner');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(provider.requests.length, 0, 'awaiting the owner');
    await s.engine.stop('owner_stop');
  });

  it('task diagnostics are terminal-only and an invalid spec never replaces the active goal', async () => {
    const s = scene();
    provider.delayMs = 2_000;
    await s.engine.submitOperatorTask(moveTask(10.5), 'complete', TERMINAL);
    const active = s.engine.status().goal?.id;
    const chat = await s.engine.submitOperatorTask(moveTask(10.5), 'complete', OWNER);
    assert.equal(chat.status, 'rejected');
    const bad = await s.engine.submitOperatorTask({ objective: 'x', decisionInstruction: 'y', allowedCapabilities: ['teleport_anywhere'], completion: { predicate: 'crafting_result', output: 'minecraft:stick', atLeast: 1 } }, 'complete', TERMINAL);
    assert.equal(bad.status, 'rejected');
    assert.equal(s.engine.status().goal?.id, active);
    assert.notEqual(s.engine.status().goal?.state, 'cancelled');
    await s.engine.stop('owner_stop');
  });
});
