import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defenseProblems, duringPlannerWait, guardOrdinaryScene, noQuestionProblems, ordinaryProposal, parseOrdinaryOptions, preservationProblems, settledWaterProblems, strictPosition, trialPointInside, type OrdinaryEvidence, type WaterSample } from '../src/safety/ordinary-trial.ts';
import { insideMutationBox, SAFETY_RAISED_LAYOUT } from '../src/safety/trial-arena.ts';

const t = (n: number) => new Date(n).toISOString();
const event = (type: string, fields: OrdinaryEvidence = {}) => ({ type, t: t(1000), goalId: 'g1', ...fields });
const base = () => [event('goal_admitted', { epoch: 1 }), event('goal_admission_baseline'), event('goal_outcome_bound'), event('goal_travel_anchor'), event('planner_request', { counters: { plannerTurns: 1, tasksAdmitted: 0 } }), event('goal_window', { counters: { plannerTurns: 2, tasksAdmitted: 1 } })];
const planner = () => [event('goal_interpretation', { outcome: { kind: 'maintain', description: 'stay nearby' } })];
const episode = () => event('safety_episode_started', { basis: 'owner_goal', suspended: { goalId: 'g1', goalEpoch: 1 } });
const samples = (): WaterSample[] => Array.from({ length: 13 }, (_, i) => ({ atMs: 1000 + i * 250, position: { x: 259.37, y: -52, z: 205.5 }, air: 300, health: 20, episodeCount: 1, responding: false, support: { onGround: true, floor: 'solid', feet: 'air', eye: 'air' } }));

describe('ordinary safety evidence (no fixture, provider or policy injection)', () => {
  it('proposal retains full clone/backup and every actual selected fill/point inside it', () => {
    const p = ordinaryProposal();
    assert.equal(p.cells, 31 * 14 * 31);
    assert.deepEqual(p.scene, [240, -61, 190, 270, -48, 220]);
    assert.deepEqual(p.backup, [240, 200, 190, 270, 213, 220]);
    for (const f of [...p.water, ...p.mobs]) assert.equal(insideMutationBox(f.box, SAFETY_RAISED_LAYOUT), true);
    for (const v of [...Object.values(p.points), ...p.logs]) assert.equal(trialPointInside(v), true);
    assert.equal(trialPointInside({ x: 270.9, y: -52, z: 205 }), false, 'body cannot overlap east boundary');
    assert.equal(trialPointInside({ x: 255, y: -48, z: 205 }), false, 'head cannot extend above original volume');
  });
  it('lease/layout/fixture guard refuses ambiguous, duplicate and mode-switch arguments before side effects', () => {
    assert.deepEqual(parseOrdinaryOptions(['--describe']), { describe: true });
    assert.deepEqual(parseOrdinaryOptions(['--fixture-lease', 'root-35', '--raised-stage', '--fixture', '26.2']), { fixture: '26.2', lease: 'root-35', raised: true });
    for (const args of [[], ['--raised-stage'], ['--fixture-lease', 'root-35'], ['--fixture-lease', '../x', '--raised-stage'], ['--fixture-lease', 'root-35', '--fixture', '26.2.1', '--raised-stage'], ['--fixture-lease', 'root-35', '--raised-stage', '--raised-stage'], ['--describe', '--fixture-lease', 'root-35'], ['--fixture-lease', 'root-35', '--raised-stage', '--jev', 'fault']]) assert.throws(() => parseOrdinaryOptions(args));
  });
  it('FULL-body guard includes last block and all species/items initially; unknown/concatenated/errors refuse', async () => {
    const commands: string[] = [];
    await guardOrdinaryScene(async (s) => { commands.push(s); return 'Test failed.'; }, 'owned_unique', true);
    assert.equal(commands[0], 'execute if entity @e[tag=!owned_unique,x=240,y=-61,z=190,dx=30,dy=13,dz=30]');
    for (const reply of ['Test passed. Count: 1', 'Test failed.Test failed.', 'Unknown command', '', 'Test failed\nTest passed. Count: 1']) {
      let mutations = 0;
      await assert.rejects(async () => { await guardOrdinaryScene(async () => reply, 'owned_unique', true); mutations++; });
      assert.equal(mutations, 0);
    }
    await guardOrdinaryScene(async (s) => { assert.match(s, /type=!item,type=!experience_orb/); return 'Test failed'; }, 'owned_unique', false);
  });
  it('stable dry and genuine shallow wading pass; the recorded deep-pool bob, unknown, gaps and churn refuse', () => {
    assert.deepEqual(settledWaterProblems(samples()), []);
    const wading = samples(); wading.forEach((s) => { s.support.feet = 'water'; });
    assert.deepEqual(settledWaterProblems(wading), []);
    for (const mutate of [(s: WaterSample) => { s.position = { x: 256.1394, y: -52.1606, z: 205.5 }; s.support.floor = 'water'; s.support.onGround = false; }, (s: WaterSample) => { s.support.eye = 'water'; }, (s: WaterSample) => { s.support.floor = 'other'; }, (s: WaterSample) => { s.air = 232; }, (s: WaterSample) => { s.episodeCount++; }, (s: WaterSample) => { s.responding = true; }, (s: WaterSample) => { s.health--; }]) {
      const ss = samples(); mutate(ss[6]!); assert.notDeepEqual(settledWaterProblems(ss), []);
    }
    assert.notDeepEqual(settledWaterProblems(samples().filter((_, i) => i < 3 || i > 9)), []);
    const future = samples(); future[4]!.atMs = future[5]!.atMs; assert.notDeepEqual(settledWaterProblems(future), []);
    assert.notDeepEqual(settledWaterProblems(samples().slice(0, 12)), []);
  });
  it('only actual outstanding request at response proves planner-wait protection', () => {
    const req = event('planner_request', { requestId: 'p1', t: t(2000) });
    const start = { t: t(2100) };
    assert.equal(duringPlannerWait([req], [], 'g1', start), true);
    assert.equal(duringPlannerWait([req], [event('planner_response', { requestId: 'p1', t: t(2099) })], 'g1', start), false);
    assert.equal(duringPlannerWait([req], [event('planner_error', { requestId: 'p1', t: t(2099) })], 'g1', start), false);
    assert.equal(duringPlannerWait([req], [], 'g2', start), false);
    assert.equal(duringPlannerWait([req], [], 'g1', { t: t(1999) }), false);
    assert.equal(duringPlannerWait([req], [event('planner_response', { requestId: 'p1', t: t(2101) })], 'g1', start), true);
  });
  it('same job accounting refuses rebinding, admission resets, wrong epoch and decreasing counters', () => {
    assert.deepEqual(preservationProblems(base(), planner(), 'g1', [episode()]), []);
    for (const type of ['goal_admitted', 'goal_admission_baseline', 'goal_outcome_bound', 'goal_travel_anchor']) assert.notDeepEqual(preservationProblems([...base(), event(type)], planner(), 'g1', [episode()]), []);
    assert.notDeepEqual(preservationProblems(base(), [...planner(), ...planner()], 'g1', [episode()]), []);
    for (const fields of [{ goalId: 'g2', goalEpoch: 1 }, { goalId: 'g1', goalEpoch: 2 }]) assert.notDeepEqual(preservationProblems(base(), planner(), 'g1', [{ ...episode(), suspended: fields }]), []);
    assert.notDeepEqual(preservationProblems([...base(), event('goal_window', { counters: { plannerTurns: 1, tasksAdmitted: 1 } })], planner(), 'g1', [episode()]), []);
    assert.notDeepEqual(preservationProblems([...base(), event('goal_terminal', { state: 'completed', reason: 'safety_resolved' })], planner(), 'g1', [episode()]), []);
  });
  it('no unknown absence or unrelated episode can earn defense/zero-question credit', () => {
    const start = { episodeId: 's1', response: 'defend', defense: { target: { entityId: 7 } } };
    const end = { episodeId: 's1', outcome: 'resolved' };
    const outcomes = [{ owner: 'safety', evidence: { defeatedByServerStatus: true, hitsConfirmed: 4 } }];
    assert.deepEqual(defenseProblems(start, end, outcomes, false), []);
    for (const present of [true, undefined]) assert.notDeepEqual(defenseProblems(start, end, outcomes, present), []);
    assert.notDeepEqual(defenseProblems(start, { ...end, episodeId: 's0' }, outcomes, false), []);
    assert.notDeepEqual(defenseProblems(start, end, [{ owner: 'goal', evidence: outcomes[0]!.evidence }], false), []);
    assert.deepEqual(noQuestionProblems([], ['terminal ready: answer [qN] <reply>']), []);
    assert.notDeepEqual(noQuestionProblems([event('goal_state', { state: 'awaiting_owner' })], []), []);
    assert.notDeepEqual(noQuestionProblems([], ['[chunkbot] Question q1: Which one?']), []);
  });
  it('server NBT position parser refuses errors, nonfinite/multiple replies', () => {
    assert.deepEqual(strictPosition('Chunkbot has the following entity data: [259.37d, -52.0d, 205.5d]'), { x: 259.37, y: -52, z: 205.5 });
    for (const s of ['error [259.37d, -52.0d, 205.5d]', 'Chunkbot has the following entity data: [NaNd, -52.0d, 205.5d]', 'Chunkbot has the following entity data: [259.37d, -52.0d, 205.5d]\nTest passed. Count: 1']) assert.equal(strictPosition(s), undefined);
  });
});
