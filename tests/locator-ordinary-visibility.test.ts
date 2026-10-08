// L-H11: retained actual input reproduction and separate synthetic bracket/adverse controls. No world/inference.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { sequentialIds, type DecisionRequest, type ObservationSnapshot } from '../src/contracts/index.ts';
import { TaskRuntime, type TaskRuntimeDeps } from '../src/tasks/task-runtime.ts';
import { FileRunStore } from '../src/telemetry/run-store.ts';
import { snapshotSummary } from '../src/decision/context.ts';
import { renderObservation } from '../src/planner/prompt.ts';
import { modelObservationBinding, parseOwnerServerRead, privacyOracle, visibleOwnerConsistency, type ObserverSample, type OwnerIdentity, type Point, type ServerVisibilityRead, type VisibilityContext } from '../scripts/lib/locator-ordinary-oracles.ts';
import { startVisibilityCapture, VISIBILITY_CAPTURE } from '../scripts/lib/locator-ordinary-visibility-capture.ts';

type Row = Record<string, any>;
const retained = JSON.parse(readFileSync(new URL('./fixtures/locator-lh11-visibility.json', import.meta.url), 'utf8')) as Row;
const ownerIdentity = { name: 'FixtureOwner', uuid: offlinePlayerUuid('FixtureOwner') };
const botIdentity = { name: 'Chunkbot', uuid: offlinePlayerUuid('Chunkbot') };
const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
function server(identity: OwnerIdentity, at: Point, fromMs: number, toMs: number) {
  const words = identity.uuid.replaceAll('-', '').match(/.{8}/g)!.map((h) => Number.parseInt(h, 16) | 0);
  return parseOwnerServerRead(identity.name, { position: `${identity.name} has the following entity data: [${at.x}d, ${at.y}d, ${at.z}d]`, uuid: `${identity.name} has the following entity data: [I; ${words.join(', ')}]`, dimension: `${identity.name} has the following entity data: "minecraft:overworld"` }, fromMs, toMs);
}
function synthetic() {
  const owner = { x: 2311.5, y: -60, z: 2062.5 }, bot = { x: 2309.5, y: -60, z: 2061.5 };
  const observation: Row = { snapshotId: 'snap-model', takenAtMs: 1005, connectionEpoch: 1, goalEpoch: 1, dimension: 'overworld', owner: { visible: true, at: owner }, self: { at: bot }, entities: [{ key: 'minecraft:player', label: 'owner', handle: 'ent-1', at: owner }], remembered: [] };
  const witness = { runId: 'run-test', atMs: 1004, serverAtMs: 1001, bot, owner, scenario: 'O1c', dashboard: {}, snapshot: { id: 'snap-diag', takenAtMs: 1004, connectionEpoch: 1, goalEpoch: 1, dimension: 'overworld' }, capture: { runId: 'run-test', connectionEpochBefore: 1, connectionEpochAfter: 1, requestedAtMs: 1003, receivedAtMs: 1010, before: server(ownerIdentity, owner, 1000, 1001), botBefore: server(botIdentity, bot, 1001, 1002), after: server(ownerIdentity, owner, 1010, 1011), botAfter: server(botIdentity, bot, 1011, 1012) } } satisfies ObserverSample;
  const context: VisibilityContext = { runId: 'run-test', atMs: 1020, snapshotId: 'snap-model', takenAtMs: 1005, goalEpoch: 1, connectionEpoch: 1, ownerIdentity, botIdentity };
  return { observation, witness, context, owner, bot };
}
function rawRead(s: ReturnType<typeof synthetic>, fromMs: number): ServerVisibilityRead {
  const scope = { runId: s.context.runId, goalEpoch: s.context.goalEpoch, connectionEpoch: s.context.connectionEpoch };
  return { scopeBefore: { ...scope }, scopeAfter: { ...scope }, owner: server(ownerIdentity, s.owner, fromMs, fromMs + 1), bot: server(botIdentity, s.bot, fromMs + 1, fromMs + 2) };
}
function metadataCase(source: 'jev_request' | 'planner_prompt') {
  const s = synthetic();
  const frame: ObservationSnapshot = { id: s.observation.snapshotId, takenAtMs: s.observation.takenAtMs, connectionEpoch: s.observation.connectionEpoch, goalEpoch: s.observation.goalEpoch, dimension: 'overworld', self: { at: s.bot, health: 20, food: 20 }, owner: { visible: true, at: s.owner, distance: d(s.bot, s.owner) }, entities: s.observation.entities.map((e: Row) => ({ ...e, distance: d(s.bot, e.at) })), inventory: [], equipment: {}, blocks: [], drops: [], blockSummary: [], remembered: [], frontiers: [] };
  const observation = (source === 'jev_request' ? snapshotSummary(frame) : renderObservation(frame)) as Row;
  const context = { source, runId: s.context.runId, atMs: s.context.atMs, connectionEpoch: s.context.connectionEpoch };
  const journal: Row = { run: context.runId, t: new Date(1015).toISOString(), type: source === 'jev_request' ? 'task_round' : 'planner_turn_started', requestId: 'req-binding', snapshotId: frame.id, snapshotTakenAtMs: frame.takenAtMs, connectionEpoch: frame.connectionEpoch, goalEpoch: source === 'jev_request' ? 29 : frame.goalEpoch, ...(source === 'jev_request' ? { snapshotGoalEpoch: frame.goalEpoch, taskId: 'task-current', goalId: 'goal-current' } : { subject: 'goal-current', subjectGoalEpoch: 29 }) };
  return { ...s, observation, source, journal, bindingContext: context };
}

describe('L-H11 approved P 28796a1 convention through actual context renderers (synthetic brackets only)', () => {
  for (const source of ['jev_request', 'planner_prompt'] as const) {
    it(`binds exact ${source} observation scope independently from ownership and retains the raw journal in the bracket proof`, () => {
      const s = metadataCase(source), binding = modelObservationBinding(s.observation, [s.journal], s.bindingContext)!;
      assert.ok(binding); assert.equal(binding.goalEpoch, 1); assert.equal(s.journal[source === 'jev_request' ? 'goalEpoch' : 'subjectGoalEpoch'], 29);
      const result = visibleOwnerConsistency(s.observation, [], { ...s.context, ...binding, binding }, [rawRead(s, 1000), rawRead(s, 1010)]);
      assert.deepEqual(result.errors, []); assert.deepEqual(result.proof?.binding?.journal, s.journal);
      assert.equal(result.proof?.binding?.requestId, 'req-binding'); assert.equal(result.proof?.takenAtMs, 1005);
    });
    for (const [name, mutate] of [
      ['foreign run', (s: ReturnType<typeof metadataCase>) => { s.journal.run = 'run-other'; }],
      ['foreign snapshot', (s: ReturnType<typeof metadataCase>) => { s.journal.snapshotId = 'snap-other'; }],
      ['missing timestamp', (s: ReturnType<typeof metadataCase>) => { delete s.journal.snapshotTakenAtMs; }],
      ['request-time substitution', (s: ReturnType<typeof metadataCase>) => { s.journal.snapshotTakenAtMs = s.bindingContext.atMs; }],
      ['body timestamp alteration', (s: ReturnType<typeof metadataCase>) => { s.observation.takenAtMs++; }],
      ['foreign connection', (s: ReturnType<typeof metadataCase>) => { s.journal.connectionEpoch++; }],
      ['body epoch rewritten to ownership', (s: ReturnType<typeof metadataCase>) => { s.observation.goalEpoch = 29; }],
      ['missing observation epoch', (s: ReturnType<typeof metadataCase>) => { delete s.journal[s.source === 'jev_request' ? 'snapshotGoalEpoch' : 'goalEpoch']; }],
      ['future journal', (s: ReturnType<typeof metadataCase>) => { s.journal.t = new Date(s.bindingContext.atMs + 1).toISOString(); }],
      ['snapshot after journal', (s: ReturnType<typeof metadataCase>) => { s.journal.t = new Date(s.observation.takenAtMs - 1).toISOString(); }],
      ['absent request identity', (s: ReturnType<typeof metadataCase>) => { delete s.journal.requestId; }],
    ] as const) it(`${source} refuses ${name}`, () => {
      const s = metadataCase(source); mutate(s); assert.equal(modelObservationBinding(s.observation, [s.journal], s.bindingContext), undefined);
    });
    it(`${source} refuses the newest contradictory binding instead of falling back to an older valid row`, () => {
      const s = metadataCase(source), bad = { ...s.journal, connectionEpoch: 2, t: new Date(1016).toISOString() };
      assert.equal(modelObservationBinding(s.observation, [s.journal, bad], s.bindingContext), undefined);
    });
  }
  it('preparation retains a string subject and null subject epoch without inventing admitted ownership', () => {
    const s = metadataCase('planner_prompt'); s.journal.subject = 'intent-preparation'; s.journal.subjectGoalEpoch = null;
    const binding = modelObservationBinding(s.observation, [s.journal], s.bindingContext)!;
    assert.equal(binding.goalEpoch, 1); assert.equal(binding.journal.subjectGoalEpoch, null); assert.equal(binding.journal.subject, 'intent-preparation');
    s.journal.subject = { goalEpoch: 1 }; assert.equal(modelObservationBinding(s.observation, [s.journal], s.bindingContext), undefined);
  });
});

describe('L-H11 faithful retained trial41 reproduction', () => {
  it('reproduces the actual old scan assertion from the complete affected Jev body and exact selected sample', () => {
    assert.equal(retained.provenance.sha256, 'c2cbcc87f47c7cd6b309303f0e9007b4d81a3b33c631cb38f9359f7b2bb0c131');
    const request = retained.requests.find((r: Row) => r.atMs === 1791483171259)!;
    const input = JSON.parse(request.body), obs = input.state.observation;
    const selected = retained.samples.filter((s: Row) => s.atMs <= request.atMs + 1500).sort((a: Row, b: Row) => Math.abs(a.atMs - request.atMs) - Math.abs(b.atMs - request.atMs))[0];
    assert.equal(selected.atMs, 1791483171190); assert.equal(request.atMs - selected.atMs, 69);
    assert.deepEqual(obs.owner.at, { x: 2311.5, y: -60, z: 2062.5 });
    assert.deepEqual(selected.owner, { x: 2291.5, y: -60, z: 2137.5 });
    assert.ok(d(obs.owner.at, selected.owner) > 77); assert.ok(d(selected.bot, selected.owner) > 78);
    assert.equal(d(obs.owner.at, selected.owner) <= 0.18 && d(selected.bot, selected.owner) <= 32.2, false);
    assert.equal(obs.takenAtMs, undefined, 'the actual wire cannot establish snapshot creation chronology');
    assert.equal(obs.connectionEpoch, undefined); assert.equal(obs.goalEpoch, undefined);
    const event = retained.events.find((e: Row) => e.type === 'task_round' && e.snapshotId === obs.snapshotId);
    assert.equal(event.snapshotTakenAtMs, undefined);
    assert.equal(modelObservationBinding(obs, retained.events, { source: 'jev_request', runId: 'run-bb219ea4fe96', atMs: request.atMs, connectionEpoch: 1 }), undefined, 'new P metadata cannot be invented for the retained old wire');
    assert.ok(retained.events.some((e: Row) => e.type === 'task_choice_stale' && e.requestId === event.requestId && e.reasons[0].startsWith('no_visible_entity')));
    const proof = visibleOwnerConsistency(obs, retained.observations, { runId: 'run-bb219ea4fe96', atMs: request.atMs, snapshotId: event.snapshotId, takenAtMs: event.snapshotTakenAtMs, goalEpoch: event.goalEpoch, connectionEpoch: 1, ownerIdentity, botIdentity });
    assert.equal(proof.proof, undefined); assert.deepEqual(proof.errors, ['visible_owner_snapshot_scope_unproven']);
  });
  it('proves an actual post-step diagnostic reports the old point despite agreeing named server brackets', () => {
    const o = retained.observations.find((o: Row) => o.atMs === 1791483171209)!;
    assert.equal(retained.ownerScript[0].atMs, 1791483171188);
    assert.ok(o.capture.before.toMs < o.snapshot.takenAtMs && o.snapshot.takenAtMs < o.capture.after.fromMs);
    assert.deepEqual(o.capture.before.at, o.capture.after.at);
    assert.ok(d(o.snapshot.owner.at, o.capture.before.at) > 77);
    const obs = { ...o.snapshot, snapshotId: o.snapshot.id };
    const r = visibleOwnerConsistency(obs, [o], { runId: o.runId, atMs: o.capture.receivedAtMs, snapshotId: obs.snapshotId, takenAtMs: obs.takenAtMs, goalEpoch: 1, connectionEpoch: 1, ownerIdentity, botIdentity });
    assert.deepEqual(r.errors, ['visible_owner_position_disagrees_with_bracket']);
    assert.equal(r.proof, undefined, 'no fabricated bot reads or retrospective acceptance of the old artifact');
  });
  it('actual TaskRuntime and FileRunStore correlate exact P metadata and fence the reproduced asynchronous visibility change', async (t) => {
    // Controlled async-boundary reproduction, not a claim about the missing creation time in trial41.
    const old = retained.observations.find((o: Row) => o.atMs === 1791483171121).snapshot;
    let now = old.takenAtMs, hidden = false, takes = 0, executed = 0;
    const requests: DecisionRequest[] = [], ids = sequentialIds(), dir = mkdtempSync(join(tmpdir(), 'locator-lh11-metadata-'));
    const store = new FileRunStore({ runsDir: join(dir, 'runs'), runId: 'run-lh11-control', clock: { now: () => now }, maxEvents: 100, maxEventChars: 16000, keepRuns: 1 });
    t.after(async () => { await store.close({ test: true }); rmSync(dir, { recursive: true, force: true }); });
    const snapshot = (): ObservationSnapshot => ({ ...structuredClone(old), id: ids.next('snap'), takenAtMs: now, owner: hidden ? { visible: false } : structuredClone(old.owner), entities: hidden ? [] : structuredClone(old.entities), inventory: [], equipment: {}, blocks: [], drops: [], blockSummary: [], frontiers: [] }) as ObservationSnapshot;
    const deps: TaskRuntimeDeps = {
      perception: { take: () => { takes++; return snapshot(); }, resolve: () => ({ error: 'not_visible_now' }) },
      predicates: { bind: async (predicate) => ({ predicate, boundAtMs: now, baselines: {} }), evaluate: async () => { await Promise.resolve(); hidden = true; now = 1791483171255; return { predicate: 'near_target', status: 'unknown', detail: 'owner not currently visible', evidence: {} }; } },
      candidates: { generate: (_spec, s) => ({ snapshotId: s.id, connectionEpoch: 1, goalEpoch: 1, generatedAtMs: now, candidates: s.owner.visible ? [{ id: ids.next('act'), capability: 'follow_entity', snapshotId: s.id, connectionEpoch: 1, goalEpoch: 1, description: 'follow the visible owner', criteria: [], preconditions: [], timeoutMs: 1000, parameters: {} }] : [], unavailable: s.owner.visible ? [] : [{ capability: 'follow_entity', reason: 'no_visible_entity', detail: 'not visible now', evidence: {} }], truncated: false }) },
      decision: { readiness: () => ({ ready: true, detail: 'scripted' }), choose: async (req) => { requests.push(req); return { requestId: req.requestId, candidateId: req.candidates[0]!.id, confidence: 1, probabilities: { [req.candidates[0]!.id]: 1 }, requestedModel: 'typesafe/jev-1.13', model: 'typesafe/jev-1.13', provider: 'TypeSafe', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 0, attempts: 1 }; } },
      executor: { readiness: () => ({ ready: true, detail: 'scripted' }), execute: async () => { executed++; throw new Error('stale action must never execute'); } },
      sustained: () => undefined, catalogVersion: () => 'test', mechanicsVersion: '26.1.2', connectionEpoch: () => 1, model: 'typesafe/jev-1.13', store, clock: { now: () => now }, ids,
      limits: { maxOptions: 8, noProgressMs: 30000, perTargetRetries: 2, lowHealth: 8 },
    };
    const result = await new TaskRuntime(deps).run({ taskId: 'task-lh11', goalId: 'goal-lh11', goalEpoch: 1, mode: 'maintain', signal: new AbortController().signal, isCurrent: () => true, spec: { objective: 'Stay near the owner.', decisionInstruction: 'Follow the visible owner.', allowedCapabilities: ['follow_entity'], targetSelectors: [{ kind: 'owner' }], parameters: {}, completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } } });
    assert.ok(requests.length <= 1);
    if (requests.length) {
      // The retained dependency takes before evaluate(); a designated-writer freshness fix may remove this request.
      const wire = requests[0]!.state as Row;
      assert.equal(wire.observation.owner.visible, true); assert.deepEqual(wire.observation.owner.at, old.owner.at);
      assert.equal(wire.progress.status, 'unknown');
      assert.equal(wire.observation.takenAtMs, old.takenAtMs);
      const events = readFileSync(store.eventsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Row);
      const binding = modelObservationBinding(wire.observation, events, { source: 'jev_request', runId: store.runId, atMs: now, connectionEpoch: 1 });
      assert.equal(binding?.requestId, requests[0]!.requestId); assert.equal(binding?.takenAtMs, old.takenAtMs);
      assert.equal(binding?.goalEpoch, old.goalEpoch); assert.equal(binding?.connectionEpoch, old.connectionEpoch);
      assert.equal(binding?.journal.snapshotGoalEpoch, old.goalEpoch); assert.equal(binding?.journal.goalEpoch, 1);
      assert.ok(events.some((e) => e['type'] === 'task_choice_stale'));
    }
    assert.ok(takes >= 2); assert.equal(executed, 0); assert.equal(result.actions, 0);
  });
});

describe('L-H11 synthetic independently bracketed model-frame controls (not trial41 evidence)', () => {
  it('retains exact raw server intervals without inventing an application snapshot', () => {
    const s = synthetic(), reads = [rawRead(s, 1000), rawRead(s, 1010)];
    const r = visibleOwnerConsistency(s.observation, [], s.context, reads);
    assert.deepEqual(r.errors, []); assert.deepEqual(r.proof?.serverReads, reads);
    assert.equal(r.proof?.witnessSnapshotId, undefined); assert.equal(r.proof?.capture, undefined);
  });
  for (const [name, mutate] of [
    ['connection changes inside a read', (rows: ServerVisibilityRead[]) => { rows[1]!.scopeAfter.connectionEpoch++; }],
    ['goal changes inside a read', (rows: ServerVisibilityRead[]) => { rows[1]!.scopeAfter.goalEpoch++; }],
    ['another run', (rows: ServerVisibilityRead[]) => { for (const r of rows) r.scopeBefore.runId = 'other'; }],
    ['contradictory intermediate owner', (rows: ServerVisibilityRead[]) => { const m = rows[1]!; m.owner = server(ownerIdentity, { ...m.owner.at, x: m.owner.at.x + 1 }, m.owner.fromMs, m.owner.toMs); }],
    ['forged raw/cached point', (rows: ServerVisibilityRead[]) => { rows[1]!.owner.at.x++; }],
    ['foreign bot UUID', (rows: ServerVisibilityRead[]) => { const b = rows[2]!.bot; rows[2]!.bot = server(ownerIdentity, b.at, b.fromMs, b.toMs); }],
  ] as const) it(`raw capture refuses ${name}`, () => {
    const s = synthetic(), rows = [rawRead(s, 1000), rawRead(s, 1003), rawRead(s, 1010)];
    // The middle row spans the model instant. It cannot be skipped to hide a contradiction.
    mutate(rows); assert.equal(visibleOwnerConsistency(s.observation, [], s.context, rows).proof, undefined);
  });
  it('uses identified snapshot time rather than a later sample after the owner moved', () => {
    const s = synthetic();
    const moved = { x: 2291.5, y: -60, z: 2137.5 };
    assert.ok(d(s.bot, moved) > 32.2, 'a request-time-only test would disagree');
    const r = visibleOwnerConsistency(s.observation, [s.witness], s.context);
    assert.deepEqual(r.errors, []); assert.equal(r.proof?.takenAtMs, 1005); assert.equal(r.proof?.witnessSnapshotId, 'snap-diag');
    assert.deepEqual(r.proof?.capture, s.witness.capture, 'exact raw brackets retained');
  });
  for (const [name, mutate] of [
    ['missing creation time', (s: ReturnType<typeof synthetic>) => { delete s.observation.takenAtMs; }],
    ['forged time against journal', (s: ReturnType<typeof synthetic>) => { s.observation.takenAtMs++; }],
    ['missing goal epoch', (s: ReturnType<typeof synthetic>) => { delete s.observation.goalEpoch; }],
    ['wrong snapshot id', (s: ReturnType<typeof synthetic>) => { s.observation.snapshotId = 'snap-other'; }],
    ['wrong connection', (s: ReturnType<typeof synthetic>) => { s.observation.connectionEpoch++; }],
    ['wrong witness run', (s: ReturnType<typeof synthetic>) => { s.witness.runId = 'run-other'; }],
    ['wrong witness goal', (s: ReturnType<typeof synthetic>) => { s.witness.snapshot.goalEpoch++; }],
    ['future snapshot', (s: ReturnType<typeof synthetic>) => { s.context.atMs = 1004; }],
    ['stale frame', (s: ReturnType<typeof synthetic>) => { s.context.atMs = 2506; }],
    ['unbracketed snapshot', (s: ReturnType<typeof synthetic>) => { s.context.takenAtMs = s.observation.takenAtMs = 1013; }],
    ['foreign UUID', (s: ReturnType<typeof synthetic>) => { s.witness.capture.after = server(botIdentity, s.owner, 1010, 1011); }],
    ['raw read error', (s: ReturnType<typeof synthetic>) => { s.witness.capture.before.replies.position = 'No entity was found'; }],
    ['forged parsed point', (s: ReturnType<typeof synthetic>) => { s.witness.capture.before.at = { ...s.owner, x: s.owner.x + 1 }; }],
    ['changed owner between reads', (s: ReturnType<typeof synthetic>) => { s.witness.capture.after = server(ownerIdentity, { ...s.owner, x: s.owner.x + 0.001 }, 1010, 1011); }],
    ['wrong dimension', (s: ReturnType<typeof synthetic>) => { s.observation.dimension = 'the_nether'; }],
    ['reversed read chronology', (s: ReturnType<typeof synthetic>) => { s.witness.capture.before.toMs = 1006; }],
    ['missing bot bracket', (s: ReturnType<typeof synthetic>) => { delete (s.witness.capture as Row).botAfter; }],
    ['invented intermediate bot point', (s: ReturnType<typeof synthetic>) => { s.witness.capture.botBefore = server(botIdentity, { ...s.bot, x: s.bot.x - 1 }, 1001, 1002); s.witness.capture.botAfter = server(botIdentity, { ...s.bot, x: s.bot.x + 1 }, 1011, 1012); }],
    ['wider owner epsilon', (s: ReturnType<typeof synthetic>) => { s.observation.owner.at = { ...s.owner, x: s.owner.x + 0.181 }; }],
    ['far visible owner', (s: ReturnType<typeof synthetic>) => { s.bot.x = s.owner.x - 32.3; s.bot.z = s.owner.z; s.witness.capture.botBefore = server(botIdentity, s.bot, 1001, 1002); s.witness.capture.botAfter = server(botIdentity, s.bot, 1011, 1012); }],
    ['wrong grounded target', (s: ReturnType<typeof synthetic>) => { s.observation.entities[0].key = 'minecraft:chicken'; }],
    ['long bracket', (s: ReturnType<typeof synthetic>) => { s.witness.capture.botAfter.toMs = 2501; }],
  ] as const) it(`refuses ${name}`, () => { const s = synthetic(); mutate(s); assert.equal(visibleOwnerConsistency(s.observation, [s.witness], s.context).proof, undefined); });
  it('a Jev string summary grounding remains restricted to the exact owner/player label', () => {
    const s = synthetic(); s.observation.entities = ['player (owner) 2.2m'];
    assert.ok(visibleOwnerConsistency(s.observation, [s.witness], s.context).proof);
    s.observation.entities = ['player (guest) 2.2m']; assert.equal(visibleOwnerConsistency(s.observation, [s.witness], s.context).proof, undefined);
  });
  it('confirmed visibility never exempts admission, target context, forged history, nested or off-axis hidden current coordinates', () => {
    const s = synthetic(), visibility = visibleOwnerConsistency(s.observation, [s.witness], s.context).proof!;
    const currentHidden = { x: 2291.5, y: -60, z: 2137.5 };
    const context = { runId: 'run-test', atMs: 1020, owner: currentHidden, bot: s.bot, ownerIdentity, connectionEpoch: 1, dimension: 'overworld', history: [], visibility };
    for (const source of ['planner', 'jev']) for (const inject of [
      (i: Row) => { i.admission = { anchor: currentHidden }; },
      (i: Row) => { i.targetContext = { target: currentHidden }; },
      (i: Row) => { const o = i.observation ?? i.state.observation; o.remembered = [{ anchorId: 'forged', label: 'owner last seen', source: 'observed', dimension: 'overworld', at: currentHidden, ageSeconds: 0 }]; },
      (i: Row) => { (i.observation ?? i.state.observation).owner.at.extra = { hiddenX: currentHidden.x }; },
      (i: Row) => { (i.observation ?? i.state.observation).other = { x: currentHidden.z, y: -60, z: 17 }; },
      (i: Row) => { i.note = JSON.stringify({ nested: currentHidden }); },
    ]) {
      const obs = structuredClone(s.observation); const input: Row = source === 'planner' ? { observation: obs } : { state: { observation: obs } };
      assert.deepEqual(privacyOracle(input, context).findings, []); inject(input); assert.ok(privacyOracle(input, context).findings.length, source);
    }
    const actualCurrent = { ...context, owner: s.owner };
    const good = { observation: structuredClone(s.observation) };
    assert.deepEqual(privacyOracle(good, actualCurrent).findings, []);
    assert.ok(privacyOracle(good, actualCurrent).allowed.some((a) => a.visibility));
    const { visibility: _proof, ...unproven } = actualCurrent;
    assert.ok(privacyOracle(good, unproven).findings.length, 'visible flag alone authorizes no coordinate field');
  });
});

describe('L-H11 bounded read-only capture settlement', () => {
  it('stop awaits the owned in-flight read and admits no later callbacks', async () => {
    const s = synthetic(), row = rawRead(s, 1000), recorded: unknown[] = [];
    let resolve!: (r: ServerVisibilityRead) => void, calls = 0, stopped = false;
    const c = startVisibilityCapture({ read: () => { calls++; return new Promise((r) => { resolve = r; }); }, wait: async () => { throw new Error('stop must prevent next wait/read'); }, record: (r) => recorded.push(r) });
    const tail = c.stop().then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false); assert.equal(c.status().settled, false);
    resolve(row); await tail; await Promise.resolve();
    assert.deepEqual(recorded, [row]); assert.equal(calls, 1);
    assert.deepEqual(c.status(), { attempts: 1, settled: true, capped: false, failure: null, retainedReads: 1 });
  });
  it('failed server reads record no positional authority and stop cleanly', async () => {
    const records: unknown[] = []; let release!: () => void;
    const waiting = new Promise<void>((r) => { release = r; });
    const c = startVisibilityCapture({ read: async () => { throw new Error('named entity absent'); }, record: (r) => records.push(r), wait: async (ms) => { assert.equal(ms, VISIBILITY_CAPTURE.pollMs); await waiting; } });
    await Promise.resolve(); const tail = c.stop(); release(); await tail;
    assert.equal(records.length, 1); assert.equal((records[0] as Row).error, 'named entity absent');
    assert.ok(Number.isFinite((records[0] as Row).fromMs) && (records[0] as Row).fromMs <= (records[0] as Row).toMs);
    assert.deepEqual(c.reads, []); assert.equal(c.status().settled, true);
  });
  it('the exact finite read cap settles and remains an explicit cleanup failure signal', async () => {
    let finished!: () => void, waits = 0;
    const done = new Promise<void>((r) => { finished = r; });
    const c = startVisibilityCapture({ read: async () => { throw new Error('absent'); }, record: () => {}, wait: async () => { if (++waits === VISIBILITY_CAPTURE.maxReads) finished(); } });
    await done; await Promise.resolve(); await c.stop();
    assert.equal(c.status().attempts, VISIBILITY_CAPTURE.maxReads); assert.equal(c.status().capped, true); assert.equal(c.status().settled, true); assert.equal(c.reads.length, 0);
  });
  for (const phase of ['record', 'wait'] as const) it(`settles an unexpected ${phase} failure without an unhandled rejection`, async () => {
    const row = rawRead(synthetic(), 1000);
    const c = startVisibilityCapture({ read: async () => row, record: () => { if (phase === 'record') throw new Error('journal unavailable'); }, wait: async () => { throw new Error('wait unavailable'); } });
    await Promise.resolve(); await Promise.resolve(); await c.stop();
    assert.equal(c.status().settled, true); assert.match(c.status().failure!, /unavailable/);
  });
});
