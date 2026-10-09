import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { actionIntervals, parseOwnerServerRead, parsePlannerInput, privacyOracle, reacquisitionProof, reconnectProblems, shutdownProblems, verifiedHistory, type ObserverSample } from '../scripts/lib/locator-ordinary-oracles.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const event = (type: string, ms: number, fields: Row = {}): Row => ({ type, t: new Date(ms).toISOString(), ...fields });
const p = (x: number, z: number) => ({ x, y: -60, z });
const goalId = 'goal-original';
const ownerIdentity = { name: 'FixtureOwner', uuid: offlinePlayerUuid('FixtureOwner') };
const serverRead = (fromMs: number, toMs: number, at: ReturnType<typeof p>, uuid = ownerIdentity.uuid, dimension = 'overworld') => {
  const bytes = Buffer.from(uuid.replaceAll('-', ''), 'hex');
  const prefix = `${ownerIdentity.name} has the following entity data: `;
  return parseOwnerServerRead(ownerIdentity.name, {
    position: `${prefix}[${at.x}d, ${at.y}d, ${at.z}d]`,
    uuid: `${prefix}[I; ${[0, 4, 8, 12].map((offset) => bytes.readInt32BE(offset)).join(', ')}]`,
    dimension: `${prefix}"minecraft:${dimension}"`,
  }, fromMs, toMs);
};
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
  // Real L-H9 ordering: snapshot starts before the visible-owner remember() timestamp.
  const witnessed = (): ObserverSample => ({ ...sample(110_000, true), serverAtMs: 109_999, bot: p(2295, 2042.5), owner: originalAt,
    snapshot: { id: 'snap-visible', takenAtMs: 110_000, goalEpoch: 5, connectionEpoch: 1, dimension: 'overworld', owner: { visible: true, at: originalAt }, entities: [{ handle: 'ent-owner', key: 'minecraft:player', label: 'owner', at: originalAt }], remembered: [{ anchorId: 'anchor-1', label: 'owner last seen', source: 'observed', at: originalAt, dimension: 'overworld', observedAtMs: 110_031 }] },
    capture: { requestedAtMs: 110_000, receivedAtMs: 110_041, runId: 'run-original', connectionEpochBefore: 1, connectionEpochAfter: 1, before: serverRead(109_997, 109_999, originalAt), after: serverRead(110_041, 110_043, originalAt) } });
  const history = () => verifiedHistory([witnessed()], ownerIdentity);
  const input = (): Row => ({ observation: { dimension: 'overworld', self: { at: p(2000.5, 2000.5) }, owner: { visible: false }, remembered: [{ anchorId: 'anchor-1', label: 'owner last seen', source: 'observed', at: originalAt, dimension: 'overworld', ageSeconds: 390 }] } });
  const context = () => ({ runId: 'run-original', atMs: 500_000, owner: p(2301.5, 2043.5), bot: p(2000.5, 2000.5), ownerIdentity, connectionEpoch: 1, dimension: 'overworld', history: history() });

  it('allows exactly the corroborated historical tuple and retains source field/path/evidence', () => {
    const result = privacyOracle(input(), context());
    assert.deepEqual(result.findings, []);
    assert.equal(result.allowed[0]!.path, 'observation.remembered[0].at.z');
    assert.equal(result.allowed[0]!.value, '2042.5');
    assert.equal(result.allowed[0]!.evidence!.snapshotId, 'snap-visible');
    assert.equal(result.allowed[0]!.evidence!.serverAtMs, 109_999);
    assert.equal(result.allowed[0]!.evidence!.observedAtMs, 110_031);
    assert.equal(result.allowed[0]!.evidence!.capture.receivedAtMs, 110_041);
    assert.equal(result.allowed[0]!.evidence!.ownerIdentity.uuid, ownerIdentity.uuid);
  });
  it('a source:observed label alone grants no exception', () => {
    assert.ok(privacyOracle(input(), { ...context(), history: [] }).findings.some((f) => f.reason.includes('history lacks')));
  });
  for (const [name, mutate] of [
    ['hidden current owner coordinates', (i: Row) => { i.observation.owner.at = p(2301.5, 2043.5); }],
    ['hidden coordinates in admission anchor', (i: Row) => { i.admission = { anchor: p(2301.5, 2043.5) }; }],
    ['hidden coordinates in target context', (i: Row) => { i.targetContext = { target: p(2301.5, 2043.5) }; }],
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
      const o = witnessed(); mutate(o); assert.deepEqual(verifiedHistory([o], ownerIdentity), []);
    }
    for (const overrides of [{ dimension: 'the_nether' }, { connectionEpoch: 2 }, { runId: 'run-restarted' }]) assert.ok(privacyOracle(input(), { ...context(), ...overrides }).findings.length > 0);
    assert.ok(privacyOracle(input(), { ...context(), history: history().map((h) => ({ ...h, serverAtMs: 500_001 })) }).findings.length > 0, 'future observation cannot authorize earlier model history');
    const early = input(); early.observation.remembered[0].ageSeconds = 1;
    assert.deepEqual(privacyOracle(early, { ...context(), atMs: 110_044 }).findings, []);
    assert.ok(privacyOracle(early, { ...context(), atMs: 110_042 }).findings.length > 0, 'the complete independent server bracket must precede the model request');
    assert.ok(privacyOracle(input(), { ...context(), ownerIdentity: { ...ownerIdentity, uuid: offlinePlayerUuid('FixtureGuest') } }).findings.length > 0, 'wrong owner UUID cannot reuse history');
  });
  it('accepts a remember timestamp only inside the actual read completion bracket, with exact stationary server identity/point', () => {
    assert.equal(history().length, 1);
    const bounded = witnessed(); bounded.capture!.after.toMs = 111_497;
    assert.equal(verifiedHistory([bounded], ownerIdentity).length, 1, 'inclusive 1500ms maximum');
    for (const mutate of [
      (o: ObserverSample) => { delete o.capture; }, // old report lacks the new bracket, remains unproven
      (o: ObserverSample) => { o.snapshot.remembered[0].observedAtMs = 110_042; }, // 1ms future of response
      (o: ObserverSample) => { o.snapshot.remembered[0].observedAtMs = 109_999; },
      (o: ObserverSample) => { o.capture!.requestedAtMs = 110_001; },
      (o: ObserverSample) => { o.capture!.after.toMs = 111_498; }, // 1501ms total
      (o: ObserverSample) => { o.capture!.before.toMs = 110_001; },
      (o: ObserverSample) => { o.capture!.after.fromMs = 110_040; },
      (o: ObserverSample) => { o.capture!.connectionEpochAfter = 2; },
      (o: ObserverSample) => { o.capture!.runId = 'other-run'; },
      (o: ObserverSample) => { o.capture!.after = serverRead(110_041, 110_043, p(2297.6, 2042.5)); },
      (o: ObserverSample) => { o.capture!.after = serverRead(110_041, 110_043, originalAt, offlinePlayerUuid('FixtureGuest')); },
      (o: ObserverSample) => { o.capture!.after = serverRead(110_041, 110_043, originalAt, ownerIdentity.uuid, 'the_nether'); },
      (o: ObserverSample) => { o.capture!.after.at = p(2301.5, 2043.5); },
      (o: ObserverSample) => { o.capture!.after.replies.uuid = 'No entity was found'; },
      (o: ObserverSample) => { o.snapshot.entities[0].label = 'player'; },
      (o: ObserverSample) => { o.snapshot.entities[0].at = p(1801.5, 2000.5); },
    ]) {
      const o = witnessed(); mutate(o); assert.deepEqual(verifiedHistory([o], ownerIdentity), []);
    }
  });
  it('server parser refuses absent/error/foreign/malformed coordinate, identity and dimension replies', () => {
    const read = serverRead(1, 2, originalAt);
    assert.equal(read.uuid, ownerIdentity.uuid);
    for (const replies of [
      { ...read.replies, position: 'No entity was found' },
      { ...read.replies, uuid: read.replies.uuid.replace('FixtureOwner', 'FixtureGuest') },
      { ...read.replies, uuid: 'FixtureOwner has the following entity data: [I; 2147483648, 0, 0, 0]' },
      { ...read.replies, dimension: 'FixtureOwner has the following entity data: "unknown"' },
      { ...read.replies, position: 'FixtureOwner has the following entity data: [1d, NaNd, 2d]' },
    ]) assert.throws(() => parseOwnerServerRead(ownerIdentity.name, replies, 1, 2));
  });
  it('correlates the actual L-H9 O3/O4 tuples and ages across goals only with newly captured independent brackets', () => {
    // These point/anchor/start/remember/response values are from the unchanged failed report/log.
    // Server UUID/bracket readbacks below are synthetic new-format data, NOT retroactive world acceptance.
    const row = (start: number, rememberedAt: number, end: number, at: ReturnType<typeof p>, anchorId: string, goalEpoch: number) => {
      const o = witnessed();
      o.atMs = start; o.serverAtMs = start; o.bot = p(at.x + 2, at.z - 1); o.owner = at;
      o.snapshot = { ...o.snapshot, id: `snap-${anchorId}`, takenAtMs: start, goalEpoch, owner: { visible: true, at }, entities: [{ handle: `ent-${anchorId}`, key: 'minecraft:player', label: 'owner', at }], remembered: [{ anchorId, label: 'owner last seen', source: 'observed', dimension: 'overworld', at, observedAtMs: rememberedAt }] };
      o.capture = { ...o.capture!, requestedAtMs: start, receivedAtMs: end, before: serverRead(start - 2, start, at), after: serverRead(end, end + 2, at) };
      return o;
    };
    const a = row(1791445358069, 1791445358088, 1791445358088, p(1821.5, 2121.5), 'anchor-1', 6);
    const b = row(1791445428451, 1791445428472, 1791445428472, p(2017.5, 1737.5), 'anchor-2', 10);
    const i = input();
    i.observation.remembered = [a, b].map((o, n) => ({ ...o.snapshot.remembered[0], observedAtMs: undefined, ageSeconds: n === 0 ? 75 : 4 }));
    const ctx = { ...context(), atMs: 1791445432956, history: verifiedHistory([a, b], ownerIdentity) };
    const result = privacyOracle(i, ctx);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.allowed.map((x) => x.path), ['observation.remembered[0]', 'observation.remembered[1]']);
    assert.deepEqual(result.allowed.map((x) => x.evidence!.goalEpoch), [6, 10]);
    assert.deepEqual(result.allowed.map((x) => x.evidence!.at), [p(1821.5, 2121.5), p(2017.5, 1737.5)]);
    for (const o of [a, b]) delete o.capture;
    assert.equal(privacyOracle(i, { ...ctx, history: verifiedHistory([a, b], ownerIdentity) }).findings.length, 2, 'old report stays missing the new corroboration');
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
