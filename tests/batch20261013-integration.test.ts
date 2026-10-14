import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReleaseManifestSchema, ServerControlRequestSchema, sequentialIds, type ReleaseManagerPort, type ReleaseManagerStatus, type SemanticDirectiveCheckpoint, type ServerControlRequest } from '../src/contracts/index.ts';
import { ChunkbotApp } from '../src/app/app.ts';
import { managedAppPort } from '../src/app/managed-child.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { pendingDirectiveFrom, renderStatusLines } from '../src/app/status.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import type { GameSession } from '../src/game/connection.ts';
import { interfaceGate } from '../src/execution/interface-gate.ts';
import { serverControlTarget } from '../src/commands/managed-controls.ts';
import { loadConfigFile, parseConfig } from '../src/config/load.ts';
import { buildApp } from '../src/cli.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { FakeGame, ScriptedPlanner, makeEngine, tick, until } from './helpers.ts';
import { FakeServer, FakeTaskRuntime, FakeWorld } from './handoff-fakes.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2 } from './skill-fakes.ts';

const owner = { surface: 'terminal', principal: 'operator' } as const;
const scope = { worldProfile: 'fixture', worldRevision: 1, botProfile: 'chunkbot', ownerUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const fence = { sessionId: 'session-one', generation: 3, releaseId: 'release-b', manifestSha256: 'b'.repeat(64) };
const config = parseConfig({ minecraft: { host: '127.0.0.1', port: 25566, version: '26.1.2' }, bot: { auth: 'offline', username: 'Chunkbot', trustedOfflineFixture: true }, owner: { name: 'FixtureOwner' }, limits: { cleanupTimeoutMs: 30 } });
function appHarness(extensions?: ConstructorParameters<typeof ChunkbotApp>[0]['extensions']) {
  const game = new FakeGame();
  const store = new MemoryRunStore();
  const app = new ChunkbotApp({ config, game, store, clock: { now: Date.now }, ids: sequentialIds(), out: () => {}, runFacts: {}, ...(extensions ? { extensions } : {}) });
  return { app, game, store };
}

describe('managed release contract boundaries', () => {
  const manifest = { formatVersion: 1, releaseId: 'release-b', sourceCommit: 'a'.repeat(40), entryPoint: 'dist/cli.js', nodeMajor: 24, minecraftVersions: ['26.1.2', '26.2'], checkpointVersion: 1, lockfileSha256: 'b'.repeat(64), vendorLockSha256: 'c'.repeat(64), files: [{ path: 'dist/cli.js', size: 12, sha256: 'd'.repeat(64) }], summary: 'Improved fixture behavior.', acceptance: { receiptId: 'accepted-one', evidenceSha256: 'e'.repeat(64) } };
  it('refuses traversal, arbitrary hooks, duplicate files and a missing entry point', () => {
    assert.equal(ReleaseManifestSchema.safeParse(manifest).success, true);
    for (const path of ['../cli.js', '/cli.js', 'dist/../cli.js', 'dist\\cli.js', 'dist//cli.js']) assert.equal(ReleaseManifestSchema.safeParse({ ...manifest, entryPoint: path }).success, false);
    assert.equal(ReleaseManifestSchema.safeParse({ ...manifest, shellHook: 'anything' }).success, false);
    assert.equal(ReleaseManifestSchema.safeParse({ ...manifest, files: [...manifest.files, ...manifest.files] }).success, false);
    assert.equal(ReleaseManifestSchema.safeParse({ ...manifest, entryPoint: 'dist/other.js' }).success, false);
  });
});

describe('release drain preserves one admission/cleanup owner', () => {
  it('defers an owner goal while planning without aborting it or changing its baseline/counters', async () => {
    const planner = new ScriptedPlanner();
    const h = makeEngine({ planner });
    await h.engine.submit('An arbitrary finite owner objective.', owner);
    await until(() => planner.waiting === 1);
    const before = h.engine.status().goal;
    const result = await h.engine.drainForUpdate();
    assert.equal(result.drained, false);
    assert.match(result.detail, /deferred/);
    assert.equal(h.engine.admissionsClosed, false);
    assert.deepEqual(h.engine.status().goal, before);
    assert.equal(planner.signals[0]?.aborted, false);
    await h.engine.shutdown();
  });

  it('an accepted drain closes intake before its first await and does not set the stop latch', async () => {
    const h = makeEngine();
    const draining = h.engine.drainForUpdate();
    assert.equal(h.engine.admissionsClosed, true);
    const intake = await h.engine.submit('Late work must not be admitted.', owner);
    assert.equal(intake.status === 'rejected' && intake.reason, 'shutting_down');
    assert.equal((await draining).cleanupConfirmed, true);
    assert.equal(h.engine.status().latch.paused, false);
    assert.equal(h.engine.safetyAuthority().basis, 'none');
    assert.equal(h.store.ofType('goal_admitted').length, 0);
  });

  it('a timeout wrapper cannot prove that a revoked planner process settled', async () => {
    const settled = Promise.withResolvers<never>();
    const planner = { readiness: () => ({ ready: true, detail: 'offline fault' }), propose: () => settled.promise };
    const h = makeEngine({ planner, limits: { maxInstructionChars: 500, plannerTurnsPerGoal: 5, plannerTimeoutMs: 1_000, planWindowSteps: 2, totalTaskCeiling: 8, goalDeadlineMs: 10_000, cleanupTimeoutMs: 10 } });
    await h.engine.submit('Retain the real process tail.', owner);
    await until(() => h.engine.plannerProcesses.running === 1);
    await h.engine.stop();
    const receipt = await h.engine.drainForUpdate();
    assert.equal(receipt.drained, false);
    assert.equal(receipt.cleanupConfirmed, false);
    assert.equal(h.engine.plannerProcesses.running, 1);
    settled.reject(new Error('task-owned fault process ended'));
    await until(() => h.engine.cleanupProof().pending === 0);
    assert.equal((await h.engine.drainForUpdate()).cleanupConfirmed, true, 'a later real settlement can be proved without replaying work');
    assert.equal(h.engine.status().goal?.terminal?.reason, 'owner_stop');
  });

  it('a rejected goal cleanup blocks release drain even when its bounded wait finished', async () => {
    const planner = new ScriptedPlanner();
    const h = makeEngine({ planner });
    await h.engine.submit('One owner.', owner);
    await until(() => planner.waiting === 1);
    h.engine.registerCleanup(h.engine.currentEpoch, () => { throw new Error('unconfirmed cleanup'); });
    await h.engine.stop();
    const receipt = await h.engine.drainForUpdate();
    assert.equal(receipt.cleanupConfirmed, false);
    assert.ok(h.engine.cleanupProof().faults.includes('goal'));
  });

  it('persistent interruption preserves immutable semantics/counters and a late stop wins', async () => {
    const planner = new ScriptedPlanner();
    const server = new FakeServer([]);
    const finishing = Promise.withResolvers<void>();
    const tasks = new FakeTaskRuntime([]);
    tasks.behaviors.set('Stay nearby.', async (task) => { await new Promise<void>((r) => task.signal.addEventListener('abort', () => r(), { once: true })); await finishing.promise; });
    const capability = { id: 'follow_entity', family: 'movement', purpose: 'test', targets: ['owner'], parameters: [], preconditions: [], effects: [], supportedPredicates: [], timeoutMs: 1_000, cancellation: 'fenced', limitations: [] };
    const h = makeEngine({ planner, observation: new FakeWorld(), outcomes: server, tasks, executor: { readiness: () => ({ ready: true, detail: 'offline fake' }), execute: async () => { throw new Error('unused'); } }, capabilities: new StaticCapabilityRegistry({ catalogVersion: 'test', capabilities: [capability] }), continuation: { sessionId: 'one', matches: (s, k) => s === k, captureAnchor: () => ({ dimension: 'overworld', at: { x: 0, y: 64, z: 0 }, radius: 128 }), currentDimension: () => 'overworld' } });
    const predicate = { predicate: 'near_target', target: { kind: 'owner' }, within: 3 };
    await h.engine.submit('Stay with the owner.', owner);
    await until(() => planner.waiting === 1);
    planner.respond({ version: 1, disposition: 'plan', interpretation: 'Stay close to the owner.', outcome: { kind: 'persistent', maintain: predicate }, tasks: [{ objective: 'Stay nearby.', decisionInstruction: 'Remain nearby.', allowedCapabilities: ['follow_entity'], targetSelectors: [{ kind: 'owner' }], parameters: {}, completion: predicate }], morePlanningNeeded: false });
    await until(() => tasks.runs.length === 1);
    const before = h.engine.status().goal!;
    const draining = h.engine.drainForUpdate();
    assert.equal(tasks.runs[0]?.task.signal.aborted, true);
    const held = h.engine.checkpoints()[0]!;
    assert.equal(held.admissionBaseline.capturedAtMs, server.boundWith[0]?.capturedAtMs);
    assert.deepEqual(held.counters, before.counters);
    const stopping = h.engine.stop();
    finishing.resolve();
    await stopping;
    const receipt = await draining;
    assert.equal(receipt.directive, null, 'a stale drain cannot restore the stopped directive');
    assert.equal(h.engine.status().latch.paused, true);
    assert.equal(h.engine.status().goal?.terminal?.reason, 'update_interrupted');
    assert.equal(h.store.ofType('goal_terminal').some((e) => e['state'] === 'completed'), false);
  });

  it('additional app control failure never reports a successful release drain', async () => {
    const h = appHarness({ closeControl: async () => { throw new Error('fault'); } });
    const receipt = await h.app.drainForUpdate();
    assert.equal(receipt.cleanupConfirmed, false);
    await h.app.diagnostic('run unsupported');
    assert.equal(h.store.ofType('goal_admitted').length, 0);
    await h.app.shutdown('operator_quit');
  });

  it('the actual skill layer withholds drain proof until server acknowledgements resolve effects and interfaces', async () => {
    const client = fakeClient();
    const fake = fakeMineflayerBot(client);
    const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never); evidence.attach();
    const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
    const clock = { now: Date.now };
    const runtime = new SkillRuntime({ config, session: () => session, connectionEpoch: () => 1, goalEpoch: () => 0, diagnosticCurrent: () => true, admission: () => ({ serverOnlineMode: false }), store: new MemoryRunStore(), clock, ids: sequentialIds() });
    const h = appHarness({ closeControl: () => runtime.closeSafety(), releaseDrainProof: () => runtime.releaseDrainProof() });
    evidence.notePrediction(2, 0, 2);
    const gate = interfaceGate(session, clock);
    gate.register(1, 1_000_001, evidence.seq, () => false);
    assert.equal((await h.app.drainForUpdate()).cleanupConfirmed, false);
    assert.equal(client.written.length, 0, 'a proof read cannot reconcile by sending invented world actions');
    client.emit('acknowledge_player_digging', { sequenceId: 1_000_001 });
    assert.equal(runtime.releaseDrainProof().confirmed, false, 'interface acknowledgement cannot confirm the block prediction');
    evidence.record({ kind: 'block_change', x: 2, y: 0, z: 2, stateId: 0 });
    assert.equal(runtime.releaseDrainProof().confirmed, true);
    assert.equal((await h.app.drainForUpdate()).cleanupConfirmed, true, 'fresh server evidence can resolve a previously deferred drain');
    await h.app.shutdown('operator_quit'); evidence.detach();
  });

  it('a restored update intent stays visible through stop/resume and is superseded only by valid new owner intake', async () => {
    const h = makeEngine();
    h.engine.restoreHandoffBudget({ discardedTurns: 11, discardedTurnAllowance: 10 });
    assert.throws(() => h.engine.restoreHandoffBudget({ discardedTurns: 0, discardedTurnAllowance: 100 }), /decreased/);
    h.engine.restoreHandoffBudget({ discardedTurns: 11, discardedTurnAllowance: 100 });
    assert.deepEqual(h.engine.handoffBudget(), { discardedTurns: 11, discardedTurnAllowance: 10 }, 'update/rollback cannot increase the original preparation allowance');
    const cp: SemanticDirectiveCheckpoint = { version: 1, goalId: 'goal-old', dimension: 'overworld', instruction: 'Retain the original job.', publicOutcome: 'Collect original supplies.', outcome: { kind: 'finite', outcome: { predicate: 'inventory_amount', selector: 'minecraft:cobblestone', atLeast: 4, mode: 'collect_additional' } }, outcomeCanonical: 'original-accepted-contract', admissionBaseline: { capturedAtMs: 1, counts: { 'minecraft:cobblestone': 8 }, detail: 'original admission' }, anchor: { dimension: 'overworld', at: { x: 0, y: 64, z: 0 }, radius: 128 }, counters: { plannerTurns: 3, knowledgeRounds: 0, repairs: 0, retries: 0, questionRefusals: 0, replans: 1, windows: 1, tasksAdmitted: 2, preparationTurns: 0, lookaheads: 0 }, caps: { plannerTurns: 8, tasks: 10, replans: 3 }, admittedTasks: 2, deadlineAtMs: Date.now() + 1_000, grounding: [], counts: [], removal: [], route: null, verifiedEffects: [], continuations: { used: 0, max: 2 }, state: 'interrupted', stateReason: 'update_held', stateAtMs: 10, intakeGeneration: 4, interruption: 'update' };
    h.engine.restoreInterruptedUpdate(cp);
    cp.admissionBaseline.counts!['minecraft:cobblestone'] = 999;
    await h.engine.stop(); h.engine.resume('terminal');
    const status = h.engine.status();
    assert.equal(status.interruptedUpdate?.admissionBaseline.counts?.['minecraft:cobblestone'], 8);
    assert.equal(status.interruptedUpdate?.counters.plannerTurns, 3);
    assert.equal(h.engine.hasActiveGoal, false);
    assert.equal(h.engine.automaticBlocker()?.reason, 'busy');
    assert.equal(pendingDirectiveFrom(status)?.state, 'rejected');
    assert.ok(renderStatusLines({ connection: 'ready', ready: undefined, live: {}, engine: status }).some((s) => /interrupted by update/.test(s)));
    await h.engine.submit('   ', owner);
    assert.ok(h.engine.status().interruptedUpdate, 'invalid input cannot erase owner intent');
    await h.engine.submit('An explicit replacement.', owner);
    assert.equal(h.engine.status().interruptedUpdate, undefined);
    assert.throws(() => h.engine.restoreInterruptedUpdate(cp), /startup/, 'a late old checkpoint cannot overwrite newer owner intake');
    await h.engine.shutdown();
  });
});

describe('managed readiness and truthful notices', () => {
  it('the real CLI factory wires the single application/catalog into a control target without connecting or inference', async () => {
    const parent = join(process.cwd(), 'var', 'offline-integration'); mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'factory-'));
    const loaded = loadConfigFile('config/examples/fixture-inference-free.json');
    loaded.config.storage.dataDir = root;
    loaded.config.models.decision.apiKeyEnv = 'CHUNKBOT_OFFLINE_INTEGRATION_DUMMY_KEY';
    const built = buildApp({ ...loaded, dataDir: root, runsDir: join(root, 'runs'), authDir: join(root, 'dummy-auth') }, false, { autonomy: false, managed: { fence, scope } });
    try {
      assert.equal(built.game.state, 'disconnected');
      const reading = await built.managed!.readiness();
      assert.equal(reading.ready, false);
      assert.equal(reading.inventoryFresh, false);
      assert.equal(reading.catalogVersion, built.app.engine.status().readiness.catalogVersion);
      assert.ok(built.app.engine.status().readiness.capabilityCount >= 20);
      assert.equal(built.app.engine.status().handoff.preparations, 0);
      assert.equal((await built.managed!.announce('Unverified feature.')).sent, false);
      assert.equal(built.game.connectionEpoch, 0);
    } finally {
      await built.app.shutdown('operator_quit'); await built.disposed; rmSync(root, { recursive: true, force: true });
    }
  });
  it('requires fresh current-epoch inventory/observation and deduplicates the configured owner notice', async () => {
    const h = appHarness();
    const joining = h.app.connect(); h.game.completeJoin(); await joining;
    const facts = { connectionEpoch: h.game.connectionEpoch, serverVersion: '26.1.2', protocolVersion: 775, botUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerVerified: true, spawned: true, inventoryFresh: false, observationFresh: true, catalogVersion: 'one', planner: { ready: true, detail: 'offline fake' }, decision: { ready: true, detail: 'offline fake' } };
    const port = managedAppPort(h.app, { fence, scope, probeReadiness: async () => ({ ...facts }) });
    assert.equal((await port.announce('A reviewed feature.')).sent, false);
    assert.equal((await port.readiness()).ready, false);
    facts.inventoryFresh = true;
    facts.connectionEpoch = 0;
    assert.equal((await port.readiness()).ready, false, 'an old epoch cannot certify a new child');
    facts.connectionEpoch = h.game.connectionEpoch;
    assert.equal((await port.readiness()).ready, true);
    assert.equal((await port.announce('A reviewed feature.')).sent, true);
    assert.equal((await port.announce('A reviewed feature.')).sent, false);
    assert.equal(h.game.replies.filter((s) => s.startsWith('Updated:')).length, 1);
    await h.app.shutdown('operator_quit');
  });
});

describe('vanilla bridge target uses the single manager', () => {
  function managerHarness() {
    let status: ReleaseManagerStatus = { sessionId: null, generation: 0, controlGeneration: 0, intent: 'offline', phase: 'offline', currentRelease: null, stagedRelease: null, paused: false, detail: 'offline' };
    const calls: string[] = [];
    const joining = Promise.withResolvers<void>();
    const manager: ReleaseManagerPort = { status: () => ({ ...status }), start: async () => { calls.push('start'); await joining.promise; return { ...status }; }, logout: async () => { calls.push('logout'); status = { ...status, intent: 'offline', phase: 'offline' }; return { ...status }; }, stop: async () => status, offer: async () => status, rollback: async () => status };
    const target = serverControlTarget({ manager, scope, controlSessionId: 'fresh-control', clock: { now: () => 1_000 } });
    const request = (action: ServerControlRequest['action'], generation: number): ServerControlRequest => ({ controlSessionId: 'fresh-control', requestId: `${action}-${generation}`, scope, generation, action, issuedAtMs: 900, expiresAtMs: 2_000, identity: 'verified_server_uuid' });
    return { target, request, calls, joining };
  }

  it('refuses wrong UUID/world/session, stale requests, unknown fields and malformed input without starting', async () => {
    const h = managerHarness(); const valid = h.request('on', 1);
    assert.equal(ServerControlRequestSchema.safeParse(valid).success, true);
    for (const invalid of [{ ...valid, scope: { ...scope, ownerUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }, { ...valid, scope: { ...scope, worldRevision: 2 } }, { ...valid, controlSessionId: 'old-control' }, { ...valid, expiresAtMs: 950 }, { ...valid, shell: 'anything' }, null]) assert.equal((await h.target.handle(invalid as ServerControlRequest)).status, 'rejected');
    assert.deepEqual(h.calls, []);
  });

  it('off reaches the manager while on awaits and supersedes the old receipt; duplicates do not start again', async () => {
    const h = managerHarness();
    const on = h.target.handle(h.request('on', 1));
    const duplicate = h.target.handle(h.request('on', 1));
    await tick();
    assert.deepEqual(h.calls, ['start']);
    const off = await h.target.handle(h.request('off', 2));
    assert.equal(off.status, 'applied');
    assert.deepEqual(h.calls, ['start', 'logout']);
    h.joining.resolve();
    assert.equal((await on).status, 'rejected');
    assert.equal((await duplicate).status, 'rejected');
    assert.equal((await h.target.handle(h.request('on', 0))).status, 'rejected');
    assert.equal((await h.target.handle(h.request('off', 2))).status, 'duplicate');
    assert.deepEqual(h.calls, ['start', 'logout']);
  });

  it('off wins ambiguous same-generation on/off and status has no lifecycle effects', async () => {
    const h = managerHarness();
    const on = h.target.handle(h.request('on', 1));
    assert.equal((await h.target.handle(h.request('off', 1))).status, 'applied');
    h.joining.resolve(); await on;
    assert.equal((await h.target.handle(h.request('status', 9))).status, 'applied');
    assert.deepEqual(h.calls, ['start', 'logout']);
  });
});
