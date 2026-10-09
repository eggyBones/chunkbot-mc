import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { LAYOUT, fixtureEntityTest } from '../scripts/ordinary-goal-live-check.ts';
import { ownerStandingCommands, pendingRealTurn, verifyFiniteEpisode, verifyHiddenOwner, verifyNoAttacks, verifyPlannerWaterRace, verifyPreemption, verifySafetyOwnership, verifySharedSafetyHistory } from '../scripts/lib/ordinary-safety-oracles.ts';
import { serverUnprovokedWolf } from '../src/safety/trial-arena.ts';

type Row = Record<string, any>;
const row = (type: string, ms: number, fields: Row = {}): Row => ({ type, t: new Date(ms).toISOString(), ...fields });
const goalId = 'goal-test', requestId = 'req-test';
const started = row('planner_turn_started', 100, { goalId, requestId, selectedModel: 'gpt-6.1-sol', subject: goalId });
const completed = row('planner_turn_completed', 400, { goalId, requestId });
const stream = row('planner_stream_started', 130, { goalId, requestId });
const response = row('planner_response_started', 350, { goalId, requestId });
const streamEnd = row('planner_stream_completed', 380, { goalId, requestId });
const realTurn = [started, stream, response, streamEnd, completed];
const raw = row('planner_proposal_raw', 410, { goalId, requestId });
const episode = row('safety_episode_started', 200, { episodeId: 'safe-1', grantId: 'grant-1', suspended: { goalId, goalEpoch: 1 }, response: 'escape_water', expiresInMs: 25_000, maxActions: 4, maxDisplacement: 24, preempted: { revoked: true, holder: 'goal epoch 1', clearMs: 2 } });

it('actual correlated pending planner turn refuses settled, wrong subject/model and raw-before-completion windows', () => {
  assert.equal(pendingRealTurn([started, stream], [], goalId), started);
  assert.equal(pendingRealTurn([started], [], goalId), undefined, 'auth header before actual stream cannot prove in-flight inference');
  assert.equal(pendingRealTurn([started, stream, row('planner_turn_completed', 110, { requestId: 'other' })], [], goalId), started);
  for (const type of ['planner_response_started', 'planner_stream_completed', 'planner_turn_completed', 'planner_turn_failed', 'planner_output_rejected']) assert.equal(pendingRealTurn([started, stream, row(type, 150, { requestId })], [], goalId), undefined);
  assert.equal(pendingRealTurn([started, stream], [raw], goalId), undefined);
  for (const e of [{ ...started, goalId: 'goal-other' }, { ...started, selectedModel: 'scripted' }, { ...started, subject: 'intent-preparation' }]) assert.equal(pendingRealTurn([e, stream], [], goalId), undefined);
});

it('planner-wait intervention needs real success/raw correlation and strict ordering, never a missed race pass', () => {
  assert.doesNotThrow(() => verifyPlannerWaterRace([...realTurn, episode], [raw], goalId, requestId, episode, 150));
  for (const ep of [{ ...episode, t: response.t }, { ...episode, t: completed.t }, { ...episode, t: raw.t }, { ...episode, suspended: { goalId: 'foreign' } }, { ...episode, response: 'retreat' }]) assert.throws(() => verifyPlannerWaterRace(realTurn, [raw], goalId, requestId, ep, 150));
  assert.throws(() => verifyPlannerWaterRace(realTurn, [], goalId, requestId, episode, 150));
  assert.throws(() => verifyPlannerWaterRace(realTurn.filter((e) => e.type !== 'planner_turn_completed'), [raw], goalId, requestId, episode, 150));
  assert.throws(() => verifyPlannerWaterRace([...realTurn, row('planner_turn_failed', 450, { requestId })], [raw], goalId, requestId, episode, 150));
  assert.throws(() => verifyPlannerWaterRace(realTurn, [raw], goalId, requestId, episode, 50));
  assert.throws(() => verifyPlannerWaterRace(realTurn.map((e) => e.type === 'planner_response_started' ? { ...e, t: new Date(160).toISOString() } : e), [raw], goalId, requestId, episode, 150), 'response already arrived while process remains running');
});

function ownership() {
  const outcome = { kind: 'persistent', maintain: { kind: 'near_target', within: 3, target: { kind: 'owner' } } };
  const events = [
    row('goal_admitted', 1, { goalId, epoch: 1 }),
    row('goal_travel_anchor', 2, { goalId, epoch: 1, admitted: true, radius: 128, anchor: { x: 218.5, y: -56, z: 200.5 } }),
    row('goal_admission_baseline', 3, { goalId, epoch: 1, counts: { 'minecraft:bread': 8 } }),
    row('goal_outcome_bound', 4, { goalId, fromAdmission: true }),
    row('goal_window', 5, { goalId, counters: { plannerTurns: 1, windows: 1, tasksAdmitted: 0 } }),
    row('planner_request', 500, { goalId, counters: { plannerTurns: 2, windows: 1, tasksAdmitted: 1 } }),
  ];
  const journal = [row('goal_proposal_accepted', 4, { goalId, proposal: { disposition: 'plan', outcome } }), row('goal_proposal_accepted', 510, { goalId, proposal: { disposition: 'plan', outcome: structuredClone(outcome) } })];
  const phase = (n: number): Row => ({ directive: { goal: { id: goalId, epoch: 1, admittedAtMs: 1, outcome: 'within three of owner', counters: { plannerTurns: n, windows: 1, tasksAdmitted: n-1 } }, pause: { paused: true, manualGoalsAllowed: true }, autonomy: { route: { admissionAnchor: { x: 218.5, y: -56, z: 200.5 } } } }, usage: { jev: { value: { capNanoUsd: 1e9, confirmedNanoUsd: n*10, retainedNanoUsd: 0 } } } });
  return { events, journal, before: phase(1), after: phase(2) };
}
it('active safety preserves exact code-owned outcome, original baseline/anchor, epoch and all cumulative allowances', () => {
  const h = ownership();
  assert.doesNotThrow(() => verifySafetyOwnership(h.events, h.journal, goalId, h.before, h.after));
  for (const mutate of [
    (r: ReturnType<typeof ownership>) => { r.events.push(row('goal_admitted', 700, { goalId, epoch: 2, continuation: {} })); },
    (r: ReturnType<typeof ownership>) => { r.events.push(row('goal_admission_baseline', 700, { goalId, counts: {} })); },
    (r: ReturnType<typeof ownership>) => { r.events.push(row('goal_terminal', 700, { goalId, reason: 'outcome_verified' })); },
    (r: ReturnType<typeof ownership>) => { r.after.directive.goal.epoch++; },
    (r: ReturnType<typeof ownership>) => { r.after.directive.goal.id = 'foreign'; },
    (r: ReturnType<typeof ownership>) => { r.after.directive.goal.counters.plannerTurns = 0; },
    (r: ReturnType<typeof ownership>) => { r.after.directive.goal.admittedAtMs = 600; },
    (r: ReturnType<typeof ownership>) => { r.after.directive.pause.paused = false; },
    (r: ReturnType<typeof ownership>) => { r.after.directive.autonomy.route.admissionAnchor.x++; },
    (r: ReturnType<typeof ownership>) => { r.after.usage.jev.value.capNanoUsd++; },
    (r: ReturnType<typeof ownership>) => { r.after.usage.jev.value.confirmedNanoUsd = 0; },
    (r: ReturnType<typeof ownership>) => { r.journal[1]!.proposal.outcome.maintain.within = 4; },
  ]) {
    const r = ownership(); mutate(r);
    assert.throws(() => verifySafetyOwnership(r.events, r.journal, goalId, r.before, r.after));
  }
});

it('preemption needs a real old goal lease clear and refuses concurrent actuator acquisition', () => {
  const action = row('skill_started', 50, { owner: 'goal', leaseId: 1 });
  const lease = row('lease_acquired', 40, { leaseId: 1 });
  const clear = row('lease_revoked', 199, { leaseId: 1, reason: 'safety_preempt', clearMs: 2, clearedShared: true });
  const next = row('lease_acquired', 201, { leaseId: 2 });
  assert.doesNotThrow(() => verifyPreemption([lease, action, clear, episode, next], episode, action, 1));
  for (const bad of [{ ...episode, preempted: { revoked: false } }, { ...episode, preempted: { ...episode.preempted, holder: 'goal epoch 2' } }]) assert.throws(() => verifyPreemption([lease, clear], bad, action, 1));
  assert.throws(() => verifyPreemption([lease, next, clear], episode, action, 1));
  assert.throws(() => verifyPreemption([lease, { ...clear, clearedShared: false }], episode, action, 1));
  assert.throws(() => verifyPreemption([lease, { ...clear, clearMs: 251 }], episode, action, 1));
  assert.throws(() => verifyPreemption([lease, { ...clear, leaseId: 8 }], episode, action, 1));
});

it('finite grant never grows action, displacement or wall-clock authority', () => {
  const end = { episodeId: 'safe-1', grantId: 'grant-1', elapsedMs: 8_000, actions: 2, displacement: 9 };
  assert.doesNotThrow(() => verifyFiniteEpisode(episode, end));
  for (const bad of [{ ...end, grantId: 'refill' }, { ...end, elapsedMs: 25_001 }, { ...end, actions: 5 }, { ...end, displacement: 25 }, { ...end, displacement: NaN }]) assert.throws(() => verifyFiniteEpisode(episode, bad));
});

it('passive/neutral/owner control rejects any offensive dispatch or attack evidence, including goal-owned attacks', () => {
  assert.doesNotThrow(() => verifyNoAttacks([row('skill_started', 100, { capability: 'follow_entity' })], 90));
  for (const e of [row('skill_started', 100, { capability: 'attack_entity', owner: 'goal' }), row('skill_started', 100, { capability: 'defend_against_threat', owner: 'safety' }), row('skill_outcome', 100, { evidence: { attacksSent: 1 } }), row('safety_episode_started', 100, { response: 'defend' })]) assert.throws(() => verifyNoAttacks([e], 90));
  assert.equal(serverUnprovokedWolf('Wolf has the following entity data: -1L', 'Test failed'), true);
  for (const anger of ['Wolf has the following entity data: 0', 'Found no elements matching anger_end_time', 'Wolf has the following entity data: 30L']) assert.equal(serverUnprovokedWolf(anger, 'Test failed'), false);
  assert.equal(serverUnprovokedWolf('Wolf has the following entity data: -1L', 'Test passed. Count: 1'), false);
  assert.equal(serverUnprovokedWolf('Wolf has the following entity data: -1L', 'Unknown command'), false);
});

it('additional far point is owner-only, positively loaded/supported and unoccupied; no block or forceload extension', () => {
  const commands = ownerStandingCommands(LAYOUT.safety.farOwner, 'FixtureOwner');
  assert.deepEqual(Object.values(commands), [
    'execute if loaded 350 -61 198 if block 350 -61 198 minecraft:grass_block',
    'execute if loaded 350 -60 198 if block 350 -60 198 minecraft:air',
    'execute if loaded 350 -59 198 if block 350 -59 198 minecraft:air',
    'execute if entity @e[x=350,y=-60,z=198,dx=0,dy=1,dz=0]',
  ]);
  assert.throws(() => ownerStandingCommands(LAYOUT.safety.farOwner, 'Chunkbot'));
  assert.throws(() => ownerStandingCommands({ ...LAYOUT.safety.farOwner, x: 351.5 }, 'FixtureOwner'));
  for (const s of ['', 'Unknown block', 'Found no elements', 'Test passed. Count: 0']) assert.equal(fixtureEntityTest(s), null);
});

it('hidden-owner oracle rejects current/nested exact positions and numeric current distances', () => {
  const s = { owner: { visible: false }, entities: [], remembered: [] };
  assert.doesNotThrow(() => verifyHiddenOwner(s, LAYOUT.safety.farOwner));
  for (const bad of [{ ...s, owner: { visible: true } }, { ...s, owner: { visible: false, distance: 132 } }, { ...s, owner: { visible: false, at: LAYOUT.safety.farOwner } }, { ...s, nested: { forged: [LAYOUT.safety.farOwner] } }, { ...s, nested: { rounded: { x: 350, y: -60, z: 198 } } }]) assert.throws(() => verifyHiddenOwner(bad, LAYOUT.safety.farOwner));
});

it('multiple ordinary safety cases keep one actual service history and original spend authority even after an unresolved episode', () => {
  const make = (): Row[] => [0,1].map((i) => ({ scenario: i ? 'O7R' : 'O7P', dashboard: { publisher: { runId: 'run-one', pid: 4, seq: i+1 }, connection: { epoch: 1 }, directive: { safety: { counters: { episodes: i+1, preemptions: i, retreats: 0 } } }, usage: { jev: { value: { capNanoUsd: 1e9, confirmedNanoUsd: i*10, retainedNanoUsd: 3 } } } } }));
  assert.doesNotThrow(() => verifySharedSafetyHistory(make(), ['O7P', 'O7R']));
  for (const change of [
    (r: Row) => { r.publisher.runId = 'run-reset'; },
    (r: Row) => { r.publisher.pid++; },
    (r: Row) => { r.connection.epoch++; },
    (r: Row) => { r.directive.safety.counters.episodes = 0; },
    (r: Row) => { r.usage.jev.value.capNanoUsd++; },
    (r: Row) => { r.usage.jev.value.retainedNanoUsd = 0; },
  ]) { const r = make(); change(r[1]!.dashboard); assert.throws(() => verifySharedSafetyHistory(r, ['O7P', 'O7R'])); }
  assert.throws(() => verifySharedSafetyHistory(make(), ['O7P', 'O7R', 'O8C']));
});

it('all five oracles are wired to the one real ordinary CLI; retained O7W and mob cases remain distinct', () => {
  const source = readFileSync(new URL('../scripts/ordinary-goal-live-check.ts', import.meta.url), 'utf8');
  const extension = source.slice(source.indexOf('let extendedSafetyStarted'), source.indexOf("await h.scenarioRun('RC1'"));
  for (const id of ['O7P', 'O7R', 'O7F', 'O8C', 'O8N']) assert.match(extension, new RegExp(`scenarioRun\\('${id}'`));
  assert.equal((extension.match(/await freshCli\(/g) ?? []).length, 1, 'one service/history, including failed episodes');
  for (const oracle of ['verifyPlannerWaterRace', 'verifyPreemption', 'verifySafetyOwnership', 'verifyHiddenOwner', 'verifyFiniteEpisode', 'verifyNoAttacks']) assert.ok(extension.includes(`${oracle}(`));
  assert.match(extension, /await guard\.close\(\)/);
  assert.ok(extension.indexOf('ownerStandingCommands(') < extension.indexOf('await h.triggerTeleport(OWNER, LAYOUT.safety.farOwner'));
  assert.match(source, /profile\.limits\.travelRadius = 8/);
  assert.match(source, /waterEpisode|finite water episode/);
  assert.ok(!source.includes('kill @e[type=!player,'), 'ambient/group/cloud actors are never culled to force a stage/cleanup pass');
  assert.ok(source.includes('nbt={UUID:${actor.nbt}}'), 'recorded actor kills retain UUID and original scene bound');
});
