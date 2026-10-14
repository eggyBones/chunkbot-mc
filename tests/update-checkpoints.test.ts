import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import type { ContinuationCheckpoint } from '../src/contracts/continuation.ts';
import { CHECKPOINT_SEMANTICS, ManagedCheckpointStore, SemanticGoalSchema, digest, portableOutcome, projectContinuationCheckpoint, projectRouteLineage, type CheckpointScope, type SemanticGoal } from '../src/updates/checkpoints/index.ts';

const roots: string[] = [];
after(() => { for (const p of roots) rmSync(p, { recursive: true, force: true }); });
const scope: CheckpointScope = { worldProfile: 'fixture-independent', worldRevision: 1, botProfile: 'dummy-bot', semantics: CHECKPOINT_SEMANTICS };
function dir(): string {
  mkdirSync('var', { recursive: true });
  const d = mkdtempSync(resolve('var/checkpoint-unit-')); roots.push(d); return d;
}
function store(d = dir(), extra: Partial<ConstructorParameters<typeof ManagedCheckpointStore>[0]> = {}): ManagedCheckpointStore {
  return new ManagedCheckpointStore({ dir: d, scope, sessionId: 'logical-session', now: () => 2_000, ...extra });
}
function started(d = dir()): ManagedCheckpointStore {
  const s = store(d); assert.equal(s.open().status, 'held');
  s.createSession({ authorization: 'explicit_operator_new_session', capUsd: 1, onlineIntent: true, paused: false,
    allowances: [{ key: 'preparation_turns', limit: 8, used: 3, deadlineAtMs: 10_000, disabled: null }, { key: 'recovery_goals', limit: 2, used: 1, deadlineAtMs: null, disabled: null }] });
  return s;
}
function goal(): SemanticGoal {
  const outcome = { kind: 'finite', outcome: { predicate: 'inventory_delta', selector: 'minecraft:oak_log', atLeast: 5, mayBeConsumedLater: false } } as const;
  return SemanticGoalSchema.parse({
    goalId: 'goal-original', instruction: 'collect five more oak logs', origin: { surface: 'chat', principal: 'owner' },
    admittedAtMs: 1_000, deadlineAtMs: 10_000,
    ...portableOutcome(outcome, true),
    admissionBaseline: { capturedAtMs: 1_050, counts: { 'minecraft:oak_log': 8 }, detail: 'server inventory at original admission' },
    anchor: { dimension: 'minecraft:overworld', at: { x: 1, y: 64, z: 2 }, radius: 128 },
    counters: { plannerTurns: 3, knowledgeRounds: 1, repairs: 1, retries: 0, questionRefusals: 1, replans: 1, windows: 2, tasksAdmitted: 4, preparationTurns: 1, lookaheads: 1 },
    caps: { plannerTurns: 12, tasks: 32, replans: 8 }, admittedTasks: 4,
    counts: [{ path: 'root', basis: 'possession', predicate: 'inventory_delta', selector: 'minecraft:oak_log', atLeast: 5, admissionCount: 8, credited: 4, heldAtInterruption: 12, evidence: 'current_server_inventory', latched: false, incidentId: null, segments: 0 }],
    verifiedEffects: [{ key: 'minecraft:oak_log', count: 4, kind: 'acquired', verifiedAtMs: 1_900, provenance: 'code_verified_server_evidence' }],
    continuations: { used: 1, max: 2 }, allowances: [{ key: 'decision_attempts', limit: 16, used: 5, deadlineAtMs: 10_000, disabled: null }, { key: 'recovery_actions', limit: 2, used: 1, deadlineAtMs: 10_000, disabled: null }],
    route: null,
  });
}

test('missing state is held; new budget requires explicit start and cannot replace existing state', () => {
  const s = store();
  assert.deepEqual(s.open(), { status: 'held', reason: 'missing_checkpoint', checkpoint: null });
  assert.equal(s.resumeView().kind, 'held');
  assert.throws(() => s.createSession({ authorization: 'update' as 'explicit_operator_new_session', capUsd: 1, onlineIntent: true, paused: false, allowances: [] }));
  s.createSession({ authorization: 'explicit_operator_new_session', capUsd: 0, onlineIntent: false, paused: false, allowances: [] });
  assert.equal(s.resumeView().kind, 'offline');
  assert.throws(() => s.createSession({ authorization: 'explicit_operator_new_session', capUsd: 1, onlineIntent: true, paused: false, allowances: [] }));
  s.close();
});

test('original logical goal, outcome, acquisition baseline, credit, deadline and counters survive reopen', () => {
  const s = started(); const d = s.dir;
  const generation = s.control('directive');
  s.captureGoal({ expectedGeneration: generation, goal: goal() });
  const before = s.snapshot(); s.close();
  const newer = store(d); assert.equal(newer.open().status, 'ready');
  assert.deepEqual(newer.snapshot(), before);
  const view = newer.resumeView(); assert.equal(view.kind, 'replan');
  if (view.kind !== 'replan') throw new Error('not replan');
  assert.equal(view.historical, true);
  assert.equal(view.goal.goalId, 'goal-original');
  assert.equal(view.goal.admissionBaseline.counts!['minecraft:oak_log'], 8);
  // The original target is 8 + 5 = 13, not a refreshed 12 + 5 = 17.
  assert.equal(view.goal.counts[0]!.admissionCount! + view.goal.counts[0]!.atLeast, 13);
  assert.equal(view.goal.counts[0]!.credited, 4);
  view.goal.counters.plannerTurns = 0;
  assert.equal(newer.snapshot()!.goal!.counters.plannerTurns, 3, 'view has no mutation authority');
  newer.close();
});

test('stop/logout/replacement fence late child and checkpoint callbacks, including after restart', () => {
  const s = started(); const d = s.dir;
  const gen = s.control('directive'); s.captureGoal({ expectedGeneration: gen, goal: goal() });
  const old = s.bindChild(); old();
  const next = s.bindChild(); assert.throws(old, /replaced_or_revoked/); next();
  s.control('stop'); assert.throws(next, /replaced_or_revoked/);
  assert.throws(() => s.captureGoal({ expectedGeneration: gen, goal: goal() }), /stale_directive/);
  assert.equal(s.resumeView().kind, 'paused');
  s.close(); const recovered = store(d); recovered.open();
  assert.equal(recovered.resumeView().kind, 'paused');
  recovered.control('resume'); assert.deepEqual(recovered.resumeView(), { kind: 'held', generation: 3, reason: 'superseded_directive_generation' });
  recovered.control('logout'); recovered.close();
  const offline = store(d); offline.open(); assert.equal(offline.resumeView().kind, 'offline'); offline.close();
});

test('a pending directive stays held when the semantic capture was never delivered', () => {
  const s = started(); s.control('directive');
  assert.equal(s.resumeView().kind, 'held'); s.close();
});

test('original outcome, baseline, counters, anchor, allowances and historical credit cannot be refilled', () => {
  const s = started(); const gen = s.control('directive'); s.captureGoal({ expectedGeneration: gen, goal: goal() });
  const mutations: Array<(g: SemanticGoal) => void> = [
    (g) => { g.admissionBaseline.counts!['minecraft:oak_log'] = 12; g.counts[0]!.admissionCount = 12; },
    (g) => { g.deadlineAtMs += 1; }, (g) => { g.caps.plannerTurns += 1; },
    (g) => { g.counters.plannerTurns = 0; }, (g) => { g.anchor!.at.x += 1; },
    (g) => { g.allowances[0]!.used = 0; }, (g) => { g.allowances = []; },
    (g) => { g.verifiedEffects = []; }, (g) => { g.continuations.used = 0; },
    (g) => { g.acceptedOutcome = { kind: 'finite', outcome: { predicate: 'equipped', selector: 'minecraft:diamond_helmet', slot: 'head' } }; g.outcomeDigest = digest(g.acceptedOutcome); g.counts = []; },
  ];
  for (const mutate of mutations) {
    const candidate = goal(); mutate(candidate);
    assert.throws(() => s.captureGoal({ expectedGeneration: gen, goal: candidate }));
  }
  assert.equal(s.snapshot()!.goal!.counters.plannerTurns, 3); s.close();
});

test('reference-bearing outcome is held without writing executable tasks, handles or action IDs', () => {
  const s = started(); const gen = s.control('directive');
  const g = goal();
  Object.assign(g, portableOutcome({ kind: 'finite', outcome: { predicate: 'blocks_removed', selector: '#minecraft:logs', target: { kind: 'observed', snapshotId: 'snap-abcd', handle: 'grp-42' } } }, true));
  g.counts = [];
  s.captureGoal({ expectedGeneration: gen, goal: g });
  assert.equal(s.resumeView().kind, 'held');
  const disk = readdirSync(s.dir).filter((f) => f.endsWith('.json')).map((f) => readFileSync(join(s.dir, f), 'utf8')).join('');
  for (const forbidden of ['grp-42', 'snap-abcd', 'actionId', 'taskId', 'lease', 'apiKey', 'auth']) assert.equal(disk.includes(`"${forbidden}"`), false);
  assert.throws(() => SemanticGoalSchema.parse({ ...goal(), tasks: [] }));
  assert.throws(() => SemanticGoalSchema.parse({ ...goal(), admissionBaseline: { ...goal().admissionBaseline, key: 'dummy-secret' } }));
  s.close();
});

test('persistent owner following is semantic, while missing count provenance and expired budgets remain held', () => {
  const s = started(); const gen = s.control('directive');
  const g = goal(); g.counts = []; Object.assign(g, portableOutcome({ kind: 'persistent', maintain: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } }, true));
  s.captureGoal({ expectedGeneration: gen, goal: g }); assert.equal(s.resumeView().kind, 'replan');
  s.close();
  const expired = store(s.dir, { now: () => 10_001 }); expired.open(); assert.equal(expired.resumeView().kind, 'held'); expired.close();
  const u = started(); const ugen = u.control('directive');
  const unavailable = goal(); unavailable.counts[0]!.incidentId = 'own-incident'; u.captureGoal({ expectedGeneration: ugen, goal: unavailable });
  assert.deepEqual(u.resumeView(), { kind: 'held', generation: 1, reason: 'count_provenance_requires_core_rebind' }); u.close();
});

test('route usage is durable but never reissues a saved leg or refills route ceilings', () => {
  const s = started(); const gen = s.control('directive'); const g = goal();
  g.route = { grantedAtMs: 1_000, deadlineAtMs: 9_000, anchor: g.anchor!, limits: { legs: 12, distance: 1_024, stalledLegs: 3, legRadius: 96, minLegProgress: 8 }, source: 'owner', destinations: ['owner'], used: { legs: 8, distance: 800, stalledLegs: 2, continuations: 1, clientPhysics: 750, serverCorrections: 50, correctionSamples: 2 }, state: 'authorized', blocker: null };
  s.captureGoal({ expectedGeneration: gen, goal: g });
  assert.equal(s.resumeView().kind, 'held');
  const reset = structuredClone(g); reset.route!.used.distance = 0;
  assert.throws(() => s.captureGoal({ expectedGeneration: gen, goal: reset }));
  s.close(); const reopened = store(s.dir); reopened.open(); assert.deepEqual(reopened.snapshot()!.goal!.route, g.route); reopened.close();
});

test('the public projection consumes the existing continuation contract without upgrading display history', () => {
  const g = goal();
  const cp: ContinuationCheckpoint = {
    version: 1, goalId: g.goalId, sessionId: 'logical-session', connectionEpoch: 9, dimension: 'minecraft:overworld',
    instruction: g.instruction, publicOutcome: 'collect five additional oak logs', outcome: g.acceptedOutcome!, outcomeCanonical: JSON.stringify(g.acceptedOutcome),
    admissionBaseline: g.admissionBaseline, anchor: g.anchor, counters: g.counters, caps: g.caps, admittedTasks: g.admittedTasks, deadlineAtMs: g.deadlineAtMs,
    grounding: [{ path: 'root', predicate: 'inventory_delta', status: 'groundable' }], counts: g.counts, removal: [], route: null,
    verifiedEffects: ['display-only effect is not a server receipt'], continuations: g.continuations,
    interruptions: [{ reason: 'low_health', atMs: 1_990, epoch: 5 }], state: 'held', stateReason: 'waiting:safety_clear', stateAtMs: 1_990,
  };
  const input = { originalAdmittedAtMs: g.admittedAtMs, origin: g.origin, allowances: g.allowances, verifiedEffects: g.verifiedEffects };
  const projected = projectContinuationCheckpoint(cp, input);
  assert.deepEqual(projected, g);
  assert.equal(JSON.stringify(projected).includes('connectionEpoch'), false);
  assert.equal(JSON.stringify(projected).includes('display-only'), false);
  assert.equal(projectContinuationCheckpoint({ ...cp, state: 'restart_held' }, input).heldReason, 'display_only_or_terminal_checkpoint');
  assert.equal(projectContinuationCheckpoint({ ...cp, outcomeCanonical: JSON.stringify({ kind: 'persistent', maintain: { predicate: 'equipped', selector: 'minecraft:diamond_helmet', slot: 'head' } }) }, input).heldReason, 'original_outcome_canonical_mismatch');
  assert.equal(projectContinuationCheckpoint(cp, { ...input, allowances: [] }).heldReason, 'decision_allowance_unknown');
});

test('canonical RouteLineage projects every original ceiling and usage source without executable identity', () => {
  const projected = projectRouteLineage({
    version: 1, routeId: 'route-original', goalId: 'goal-original', originalGoalEpoch: 3, fromGoalEpoch: 5, connectionEpoch: 9,
    dimension: 'minecraft:overworld', source: 'owner', grantedAtMs: 1_000, exportedAtMs: 1_999, destinations: ['owner'], admissionAnchor: { x: 1, y: 64, z: 2 }, admissionRadius: 128,
    ceilings: { legRadius: 96, maxLegs: 12, maxTotalDistance: 1_024, routeDeadlineMs: 9_000, maxStalledLegs: 3, minLegProgress: 8 },
    legsUsed: 8, nextLegIndex: 9, lastLeg: { index: 8, outcome: 'interrupted_stalled', netProgress: 1, displacement: 96 }, stalledLegs: 2,
    distance: { total: 800, clientPhysics: 750, serverCorrections: 50, correctionCount: 2 }, state: 'authorized', blocker: null,
    ownerCoordinates: [], boundOwnDeath: null, continuations: 1,
  });
  assert.deepEqual(projected.limits, { legs: 12, distance: 1_024, stalledLegs: 3, legRadius: 96, minLegProgress: 8 });
  assert.equal(projected.deadlineAtMs, 9_000); assert.equal(projected.used.distance, 800);
  const serialized = JSON.stringify(projected);
  for (const field of ['routeId', 'connectionEpoch', 'fromGoalEpoch', 'lastLeg', 'nextLegIndex']) assert.equal(serialized.includes(`"${field}"`), false);
});

test('missing or exhausted decision allowance cannot become a fresh goal allowance', () => {
  for (const mode of ['missing', 'exhausted']) {
    const s = started(); const gen = s.control('directive'); const g = goal();
    if (mode === 'missing') g.allowances = [];
    else g.allowances[0]!.used = g.allowances[0]!.limit;
    s.captureGoal({ expectedGeneration: gen, goal: g }); assert.equal(s.resumeView().kind, 'held'); s.close();
  }
});

test('session preparation/recovery allowances and disabled providers are preserved without replenishment', () => {
  const s = started(); s.consumeAllowance('recovery_goals', 1, 0);
  assert.throws(() => s.consumeAllowance('recovery_goals', 1, 0), /allowance_not_available/);
  s.disableProvider('planner', 'model_drift'); s.close();
  const reopened = store(s.dir); reopened.open();
  assert.equal(reopened.snapshot()!.allowances.find((a) => a.key === 'recovery_goals')!.used, 2);
  assert.equal(reopened.snapshot()!.providerDisabled.planner, 'model_drift'); reopened.close();
});

test('newest corruption, unknown schema, wrong scope, missing revision/head and concurrent writer fail closed', () => {
  for (const mode of ['corrupt', 'version', 'scope', 'gap', 'tail', 'head']) {
    const s = started(); s.control('stop'); const d = s.dir; s.close();
    const path = join(d, 'checkpoint-000000000002.json');
    if (mode === 'corrupt') writeFileSync(path, '{partial');
    if (mode === 'version') { const doc = JSON.parse(readFileSync(path, 'utf8')); doc.version = 99; writeFileSync(path, JSON.stringify(doc)); }
    if (mode === 'gap') rmSync(join(d, 'checkpoint-000000000001.json'));
    if (mode === 'tail') rmSync(path);
    if (mode === 'head') rmSync(join(d, 'head.json'));
    const r = store(d, mode === 'scope' ? { scope: { ...scope, worldRevision: 2 } } : {});
    assert.equal(r.open().status, 'held', mode); assert.equal(r.resumeView().kind, 'held'); r.close();
  }
  const owner = started(); const other = store(owner.dir); assert.equal(other.open().status, 'held');
  other.close(); owner.control('stop'); owner.close();
});

test('real task-owned process crashes before/after atomic writes preserve stop or truthful ambiguity', () => {
  const entry = resolve('src/updates/checkpoints/index.ts');
  for (const point of ['before_write', 'after_file_sync', 'after_rename', 'after_directory_sync'] as const) {
    const s = started(); const d = s.dir; s.close();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { ManagedCheckpointStore } from ${JSON.stringify(entry)};
      const s = new ManagedCheckpointStore({dir:${JSON.stringify(d)}, scope:${JSON.stringify(scope)}, sessionId:'logical-session', now:()=>2000,
        fault:(point)=>{if(point===${JSON.stringify(point)}) process.exit(73)}});
      if(s.open().status!=='ready') process.exit(74);
      s.control('stop'); process.exit(75);
    `], { timeout: 10_000, env: { PATH: process.env['PATH'] }, encoding: 'utf8' });
    assert.equal(child.status, 73, child.stderr);
    const r = store(d); const load = r.open();
    if (point === 'after_file_sync' || point === 'after_rename') {
      assert.equal(load.status, 'held'); assert.equal(r.resumeView().kind, 'held');
    } else if (point !== 'before_write') {
      assert.equal(load.status, 'ready'); assert.equal(r.resumeView().kind, 'paused');
    } else {
      // No write or acknowledgement occurred. Only the prior durable intent exists.
      assert.equal(load.status, 'ready'); assert.equal(r.snapshot()!.generation, 0);
      assert.deepEqual(r.resumeView(), { kind: 'held', generation: 0, reason: 'unclean_manager_restart_requires_explicit_start' });
    }
    r.close();
  }
});

test('abandoned recovery guard and lost writer ownership cannot report resumable authority', () => {
  const s = started(); const d = s.dir; s.close();
  writeFileSync(join(d, 'lock-recovery.guard'), 'abandoned');
  const guarded = store(d); assert.equal(guarded.open().status, 'held');
  assert.deepEqual(guarded.resumeView(), { kind: 'held', generation: null, reason: 'writer_or_recovery_busy' }); guarded.close();
  rmSync(join(d, 'lock-recovery.guard'));
  const owner = store(d); owner.open();
  rmSync(join(d, 'writer.lock'));
  assert.deepEqual(owner.resumeView(), { kind: 'held', generation: 0, reason: 'writer_ownership_changed' });
  assert.throws(() => owner.control('start'), /writer_ownership_changed/); owner.close();
});
