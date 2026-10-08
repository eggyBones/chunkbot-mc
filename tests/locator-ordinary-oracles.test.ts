import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { actionIntervals, parsePlannerInput, privacyOracle, reacquisitionProof, reconnectProblems, shutdownProblems, verifiedHistory, type ObserverSample } from '../scripts/lib/locator-ordinary-oracles.ts';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const event = (type: string, ms: number, fields: Row = {}): Row => ({ type, t: new Date(ms).toISOString(), ...fields });
const p = (x: number, z: number) => ({ x, y: -60, z });
const goalId = 'goal-original';
const sample = (ms: number, visible: boolean): ObserverSample => ({
  runId: 'run-original', atMs: ms, serverAtMs: ms, scenario: 'O1c', bot: p(visible ? 2299 : 2200, 2043.5), owner: p(2301.5, 2043.5),
  snapshot: { id: `snap-${ms}`, takenAtMs: ms, goalEpoch: 1, connectionEpoch: 1, dimension: 'overworld', owner: visible ? { visible: true, at: p(2301.5, 2043.5) } : { visible: false }, remembered: [] },
  dashboard: { publisher: { publishedAtMs: ms }, connection: { epoch: 1 }, directive: { goal: { id: goalId, epoch: 1 }, autonomy: { route: { state: 'leg_active' }, locator: { actionable: true, reason: 'tracking', direction: 'east', ageMs: 100 } } } },
});
const timeline = (): Row[] => [
  event('connection_ready', 10, { connectionEpoch: 1 }),
  event('goal_admitted', 20, { goalId, epoch: 1 }),
  event('route_authorized', 20, { goalId, goalEpoch: 1, routeId: 'route-1', destinations: ['owner'] }),
  event('task_admitted', 30, { goalId, epoch: 1, taskId: 'task-1' }),
  event('task_choice', 120, { goalId, goalEpoch: 1, taskId: 'task-1', candidateId: 'act-seek', capability: 'seek_owner' }),
  event('lease_acquired', 121, { owner: 'goal:1', leaseId: 4 }),
  event('skill_started', 122, { owner: 'goal', actionId: 'act-seek', leaseId: 4, capability: 'seek_owner' }),
];
const trip = { fromMs: 100, toMs: 200, goalId, goalEpoch: 1, connectionEpoch: 1 };
const obs = () => [sample(110, false), sample(150, false), sample(199, true)];

describe('L-H7 actual code-owned seek intervals', () => {
  it('proves the first reunion while seek is still active, then the second while the SAME seek spans both trips', () => {
    const events = timeline();
    assert.equal(actionIntervals(events)[0]!.endMs, null);
    const first = reacquisitionProof(events, obs(), trip);
    assert.deepEqual(first.errors, []);
    assert.deepEqual(first.actionIds, ['act-seek']);
    events.push(event('skill_outcome', 350, { owner: 'goal', actionId: 'act-seek', goalId, goalEpoch: 1, taskId: 'task-1', connectionEpoch: 1, capability: 'seek_owner', reason: 'owner_reached' }));
    const second = reacquisitionProof(events, [sample(260, false), sample(320, true)], { ...trip, fromMs: 250, toMs: 330 });
    assert.deepEqual(second.errors, []);
    assert.deepEqual(second.actionIds, ['act-seek']);
  });
  for (const [name, change] of [
    ['direct follow movement', (e: Row[], _o: ObserverSample[]) => { for (const r of e) if (r.capability) r.capability = 'follow_entity'; }],
    ['wrong goal', (e: Row[], _o: ObserverSample[]) => { e.find((r) => r.type === 'task_choice')!.goalId = 'goal-other'; }],
    ['wrong actuator owner', (e: Row[], _o: ObserverSample[]) => { e.find((r) => r.type === 'lease_acquired')!.owner = 'goal:9'; }],
    ['seek starts after reunion', (e: Row[], _o: ObserverSample[]) => { e.find((r) => r.type === 'skill_started')!.t = new Date(201).toISOString(); }],
    ['seek ended before loss', (e: Row[], _o: ObserverSample[]) => { e.find((r) => r.type === 'skill_started')!.t = new Date(90).toISOString(); e.push(event('lease_revoked', 99, { leaseId: 4 })); }],
    ['hidden owner never reacquired', (_e: Row[], o: ObserverSample[]) => { o[2]!.snapshot.owner = { visible: false }; }],
    ['wrong visible target', (_e: Row[], o: ObserverSample[]) => { o[2]!.snapshot.owner.at.x = 1801.5; }],
    ['no current cue', (_e: Row[], o: ObserverSample[]) => { for (const s of o) s.dashboard.directive.autonomy.locator.actionable = false; }],
    ['stale cue projection', (_e: Row[], o: ObserverSample[]) => { for (const s of o) s.dashboard.publisher.publishedAtMs = 30_000; }],
    ['wrong connection cue', (_e: Row[], o: ObserverSample[]) => { for (const s of o) s.dashboard.connection.epoch = 2; }],
    ['route withdrawn', (e: Row[], _o: ObserverSample[]) => { e.push(event('route_revoked', 130, { routeId: 'route-1' })); }],
    ['new planner turn', (e: Row[], _o: ObserverSample[]) => { e.push(event('planner_turn_started', 140, { goalId })); }],
  ] as const) {
    it(`refuses apparent successful server movement with ${name}`, () => {
      const events = timeline(), observations = obs();
      change(events, observations);
      assert.equal(reacquisitionProof(events, observations, trip).pass, false);
    });
  }
});

describe('L-H8 field-level historical coordinate provenance', () => {
  const originalAt = p(2297.5, 2042.5);
  const witnessed = (): ObserverSample => ({ ...sample(110_000, true), bot: p(2295, 2042.5), owner: originalAt, snapshot: { id: 'snap-visible', takenAtMs: 110_000, connectionEpoch: 1, dimension: 'overworld', owner: { visible: true, at: originalAt }, remembered: [{ anchorId: 'anchor-1', label: 'owner last seen', source: 'observed', at: originalAt, dimension: 'overworld', observedAtMs: 110_000 }] } });
  const history = () => verifiedHistory([witnessed()]);
  const input = (): Row => ({ observation: { dimension: 'overworld', self: { at: p(2000.5, 2000.5) }, owner: { visible: false }, remembered: [{ anchorId: 'anchor-1', label: 'owner last seen', source: 'observed', at: originalAt, dimension: 'overworld', ageSeconds: 390 }] } });
  const context = () => ({ runId: 'run-original', atMs: 500_000, owner: p(2301.5, 2043.5), bot: p(2000.5, 2000.5), connectionEpoch: 1, dimension: 'overworld', history: history() });

  it('allows exactly the corroborated historical tuple and retains source field/path/evidence', () => {
    const result = privacyOracle(input(), context());
    assert.deepEqual(result.findings, []);
    assert.equal(result.allowed[0]!.path, 'observation.remembered[0].at.z');
    assert.equal(result.allowed[0]!.value, '2042.5');
    assert.equal(result.allowed[0]!.evidence!.snapshotId, 'snap-visible');
    assert.equal(result.allowed[0]!.evidence!.serverAtMs, 110_000);
  });
  it('a source:observed label alone grants no exception', () => {
    assert.ok(privacyOracle(input(), { ...context(), history: [] }).findings.some((f) => f.reason.includes('history lacks')));
  });
  for (const [name, mutate] of [
    ['hidden current owner coordinates', (i: Row) => { i.observation.owner.at = p(2301.5, 2043.5); }],
    ['forged history tuple sharing z', (i: Row) => { i.observation.remembered[0].at = p(2301.5, 2042.5); }],
    ['off-axis hidden coordinate', (i: Row) => { i.observation.other = { x: 2043.5, y: -60, z: 17 }; }],
    ['off-axis forged history', (i: Row) => { i.observation.remembered[0].at = p(2042.5, 2297.5); }],
    ['unverified history with unrelated coordinates', (i: Row) => { i.observation.remembered[0].at = p(900, 800); }],
    ['false age', (i: Row) => { i.observation.remembered[0].ageSeconds = 422; }],
    ['current coordinates inside historical extra field', (i: Row) => { i.observation.remembered[0].note = 'owner at 2301.5 2043.5'; }],
    ['current coordinates inside verified historical at extra field', (i: Row) => { i.observation.remembered[0].at = { ...originalAt, hiddenX: 2301.5 }; }],
    ['hidden coordinate text', (i: Row) => { i.note = 'z=2044'; }],
    ['nested Jev JSON text', (i: Row) => { i.questions = { next_action: { instructions: '{"target":{"x":2302}}' } }; }],
  ] as const) {
    it(`rejects ${name}`, () => {
      const i = input(); mutate(i);
      assert.ok(privacyOracle(i, context()).findings.length > 0);
    });
  }
  it('server disagreement, hidden visibility, wrong dimension/connection/run or timing cannot authorize history', () => {
    for (const mutate of [
      (o: ObserverSample) => { o.owner = p(1751.5, 1969.5); },
      (o: ObserverSample) => { o.snapshot.owner.visible = false; },
      (o: ObserverSample) => { o.serverAtMs = 100_000; },
    ]) {
      const o = witnessed(); mutate(o); assert.deepEqual(verifiedHistory([o]), []);
    }
    for (const overrides of [{ dimension: 'the_nether' }, { connectionEpoch: 2 }, { runId: 'run-restarted' }]) assert.ok(privacyOracle(input(), { ...context(), ...overrides }).findings.length > 0);
    assert.ok(privacyOracle(input(), { ...context(), history: history().map((h) => ({ ...h, serverAtMs: 500_001 })) }).findings.length > 0, 'future observation cannot authorize earlier model history');
  });
  it('a shared local axis is allowed only for a complete sampled local point; hidden owner and invented self still fail', () => {
    const i = input(); i.observation.self.at = p(2000.5, 2043.5);
    const ctx = { ...context(), bot: p(2000.5, 2043.5) };
    assert.deepEqual(privacyOracle(i, ctx).findings, []);
    i.observation.self.at = p(2301.5, 2043.5);
    assert.ok(privacyOracle(i, ctx).findings.length > 0);
    i.observation.self.at = { z: 2043.5 };
    assert.ok(privacyOracle(i, ctx).findings.length > 0);
  });
  it('handles planner JSON data and Jev state without excluding a whole observation field', () => {
    const parsed = parsePlannerInput(`Planner input (JSON data):\n${JSON.stringify(input())}\n`);
    assert.deepEqual(privacyOracle(parsed, context()).findings, []);
    const jev = { state: input(), questions: { next_action: { criteria: { a: 'seek the owner toward east' } } } };
    assert.deepEqual(privacyOracle(jev, context()).findings, []);
    assert.equal(privacyOracle(jev, context()).allowed[0]!.path, 'state.observation.remembered[0].at.z');
    assert.throws(() => parsePlannerInput('not JSON'), /missing/);
  });
});

const reconnectEvents = (): Row[] => [
  event('connection_ended', 400, { connectionEpoch: 1 }),
  event('locator_detached', 401, { connectionEpoch: 1 }),
  event('route_revoked', 402, { routeId: 'route-1', goalEpoch: 1 }),
  event('goal_terminal', 403, { goalId, reason: 'kicked' }),
  event('locator_attached', 450, { connectionEpoch: 2, late: false }),
  event('connection_ready', 500, { connectionEpoch: 2 }),
];
const rc = { goalId, goalEpoch: 1, oldEpoch: 1, newEpoch: 2, routeId: 'route-1', disconnectedAtMs: 400, readyAtMs: 500, untilMs: 600 };
describe('L-H7 owned disconnected-to-reconnect evidence', () => {
  it('requires old goal/route/callback revocation and fresh early attachment/readiness', () => {
    assert.deepEqual(reconnectProblems(reconnectEvents(), rc), []);
    for (const type of ['connection_ended', 'locator_detached', 'route_revoked', 'goal_terminal', 'locator_attached', 'connection_ready']) assert.ok(reconnectProblems(reconnectEvents().filter((e) => e.type !== type), rc).length > 0, type);
    assert.ok(reconnectProblems([], { ...rc, newEpoch: 1 }).length > 0, 'ready no-op cannot masquerade as reconnect');
  });
  for (const type of ['skill_started', 'planner_turn_started', 'goal_admitted', 'route_leg_started', 'route_authorized']) it(`rejects unrequested ${type}`, () => assert.ok(reconnectProblems([...reconnectEvents(), event(type, 550)], rc).length));
  it('rejects an old locator callback after the fresh epoch', () => assert.ok(reconnectProblems([...reconnectEvents(), event('locator_owner_state', 550, { connectionEpoch: 1 })], rc).length));
});

describe('L-H7 truthful CLI finalizer', () => {
  const summary = { controlCleanupSettled: true, connectionState: 'ended', eventsDropped: 0 };
  it('requires exit 0, terminal completion, settled controls and fully revoked leases/route/callbacks', () => {
    const clean = [event('shutdown_started', 1), event('locator_attached', 0, { connectionEpoch: 1 }), event('locator_detached', 2, { connectionEpoch: 1 }), event('lease_acquired', 0, { leaseId: 1 }), event('lease_revoked', 2, { leaseId: 1 }), event('route_authorized', 0, { routeId: 'r' }), event('route_revoked', 2, { routeId: 'r' })];
    const exit = { code: 0, signal: null }, lines = ['[chunkbot] shutdown complete'];
    assert.deepEqual(shutdownProblems(exit, lines, clean, summary), []);
    for (const badExit of [undefined, { code: 1, signal: null }, { code: 0, signal: 'SIGKILL' }]) assert.ok(shutdownProblems(badExit, lines, clean, summary).length);
    assert.ok(shutdownProblems(exit, [], clean, summary).length);
    assert.ok(shutdownProblems(exit, [...lines, 'stderr: [chunkbot] exit watchdog: a handle did not close'], clean, summary).length);
    for (const type of ['lease_revoked', 'locator_detached', 'route_revoked']) assert.ok(shutdownProblems(exit, lines, clean.filter((e) => e.type !== type), summary).length, type);
    assert.ok(shutdownProblems(exit, lines, clean, { ...summary, controlCleanupSettled: false }).length);
    assert.ok(shutdownProblems(exit, lines, clean, { ...summary, eventsDropped: 1 }).length);
    assert.ok(shutdownProblems(exit, lines, [...clean, event('skill_started', 3)], summary).length);
  });
});
