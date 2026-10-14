import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parseOptions, verifyGrant } from '../scripts/lib/v1-integration/guards.ts';
import { parseCapture } from '../scripts/lib/v1-integration/capture.ts';
import { containsLocation, generalityProblems, planSignature, verifyEvidence } from '../scripts/lib/v1-integration/oracles.ts';
import { runScenarios } from '../scripts/lib/v1-integration/runner.ts';
import { SCENARIOS, selectScenarios } from '../scripts/lib/v1-integration/scenarios.ts';
import type { Artifact, Evidence, Event, Grant, RunReport, Scenario, Session } from '../scripts/lib/v1-integration/types.ts';
import { main } from '../scripts/v1-integration-live-check.ts';
import { redact } from '../src/telemetry/redact.ts';

const artifact: Artifact = { head: 'test-commit', dirty: false, sourceSha256: 'a'.repeat(64), distSha256: 'b'.repeat(64) };
const grant: Grant = { version: 1, leaseId: 'coordinator-test', fixture: '26.1.2', expiresAtMs: 1000, realProviders: true, artifact };
const scenario = (id: string): Scenario => SCENARIOS.find((s) => s.id === id)!;
const event = (type: string, fields: Record<string, unknown> = {}): Event => ({ type, t: new Date(100).toISOString(), goalId: 'goal-a', ...fields });
function evidence(): Evidence {
  return {
    goalId: 'goal-a', epoch: 1, events: [
      event('goal_admitted', { epoch: 1 }), event('planner_turn_started', { authMode: 'chatgpt', selectedModel: 'gpt-6.1-sol', effort: 'low', catalogVersion: 'catalog-a' }),
      event('task_choice', { requestId: 'jev-a', provider: 'TypeSafe', model: 'typesafe/jev-1.13', costUsd: 0.0001 }), event('jev_request', { requestId: 'jev-a', endpoint: 'openrouter' }),
      event('goal_outcome_bound', { fromAdmission: true }), event('goal_outcome_evaluated', { status: 'satisfied' }), event('goal_terminal', { state: 'completed', reason: 'outcome_verified' }),
    ], journal: [], lines: [], baseline: { 'minecraft:cobblestone': 7 }, inventory: { 'minecraft:cobblestone': 11, 'minecraft:stone': 4 }, equipped: { head: 'minecraft:iron_helmet' },
    position: { x: 0, y: 0, z: 0 }, ownerPosition: { x: 2, y: 0, z: 0 }, interventions: [], captures: [], captureComplete: false, hiddenFacts: [],
  };
}
function report(): RunReport { return { version: 1, mode: 'real', fixture: '26.1.2', artifact, leaseId: grant.leaseId, scenarios: [scenario('V1-RESOURCE-STOCK')], results: [{ id: 'V1-RESOURCE-STOCK', phase: 'planned', autonomous: false, problems: [] }], cleanup: null, acceptance: false, blockers: [] }; }

describe('V1 authority and entry point (credential-free; no fixture/provider calls)', () => {
  it('imports the actual entry point without launching anything', () => { assert.equal(typeof main, 'function'); });
  it('rejects absent, malformed, conflicting and duplicate authority', () => {
    for (const args of [[], ['--fixture-lease', 'test'], ['--fixture-lease', '../escape', '--grant-file', 'test'], ['--stage', '--fixture-lease', 'test'], ['--stage', '--fixture', '26.3'], ['--stage', '--only', 'x', '--only', 'y']]) assert.throws(() => parseOptions(args));
    assert.equal(parseOptions(['--stage', '--fixture', '26.2']).stage, true);
  });
  it('requires the exact clean source/build, nonexpired fixture lease and injected key', () => {
    assert.equal(verifyGrant(grant, '26.1.2', grant.leaseId, artifact, 999, true), grant);
    for (const g of [null, { ...grant, fixture: '26.2' }, { ...grant, realProviders: false }, { ...grant, expiresAtMs: 999 }, { ...grant, artifact: { ...artifact, distSha256: 'other' } }]) assert.throws(() => verifyGrant(g, '26.1.2', grant.leaseId, artifact, 999, true));
    for (const a of [{ ...artifact, dirty: true }, { ...artifact, distSha256: null }, { ...artifact, sourceSha256: 'other' }]) assert.throws(() => verifyGrant(grant, '26.1.2', grant.leaseId, a, 999, true));
    assert.throws(() => verifyGrant(grant, '26.1.2', grant.leaseId, artifact, 999, false));
  });
  it('capture sidecars retain complete goals separately and refuse credentials, headers or reasoning fields', () => {
    const capture = { provider: 'planner', requestId: 'p1', goalId: 'goal-a', atMs: 100, body: 'gameplay prompt' };
    const value = { version: 1, captures: [capture], completeGoalIds: ['goal-a'] };
    assert.deepEqual(parseCapture(value, 'goal-a'), { captures: [capture], complete: true });
    assert.deepEqual(parseCapture(value, 'goal-b'), { captures: [], complete: false });
    for (const field of ['authorization', 'headers', 'privateReasoning']) assert.throws(() => parseCapture({ ...value, captures: [{ ...capture, [field]: 'forbidden' }] }, 'goal-a'));
    assert.throws(() => parseOptions(['--stage', '--capture-file', 'dummy']));
  });
  it('real process refuses before reports, fixture password, joins, or model calls', () => {
    const root = resolve(import.meta.dirname, '..'), dir = resolve(root, 'var/live-check');
    const list = () => existsSync(dir) ? readdirSync(dir).filter((p) => p.endsWith('-v1-integration')).sort() : [];
    const before = list();
    for (const args of [[], ['--fixture-lease', 'ungranted']]) {
      const r = spawnSync(process.execPath, [resolve(root, 'scripts/v1-integration-live-check.ts'), ...args], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env['PATH'] } });
      assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /named coordinator fixture lease/);
    }
    assert.deepEqual(list(), before);
  });
  it('uses only the existing ordinary harness, and never deletes foreign actors or changes settings', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../scripts/lib/v1-integration/ordinary.ts'), 'utf8');
    assert.match(source, /import\('\.\.\/\.\.\/ordinary-goal-live-check\.ts'\)/);
    assert.match(source, /blockResetCommands\(\)\.filter/);
    assert.doesNotMatch(source, /(?:process\.kill|killall|pkill|startJev|writeFaultCodex|rconCommand)\(/);
    assert.doesNotMatch(source, /[`'"](?:difficulty |gamerule |time |weather |kill @e|spawnpoint |setworldspawn )/);
  });
});

describe('independent server/outcome/cleanup oracles', () => {
  it('accepts server additional acquisition but refuses existing possession, missing code predicate or admission baseline', () => {
    const s = scenario('V1-RESOURCE-STOCK'), e = evidence();
    assert.deepEqual(verifyEvidence(s, e), []);
    assert.match(verifyEvidence(s, { ...e, inventory: { 'minecraft:cobblestone': 7 } }).join(), /11 minecraft:cobblestone/);
    for (const type of ['goal_outcome_evaluated', 'goal_outcome_bound', 'planner_turn_started', 'task_choice']) assert.ok(verifyEvidence(s, { ...e, events: e.events.filter((v) => v.type !== type) }).length, type);
  });
  it('never substitutes cobblestone for stone or held equipment for a server equipment slot', () => {
    assert.ok(verifyEvidence(scenario('V1-STONE'), { ...evidence(), inventory: { 'minecraft:cobblestone': 64 } }).length);
    assert.ok(verifyEvidence(scenario('V1-HELMET'), { ...evidence(), inventory: { 'minecraft:iron_helmet': 1 }, equipped: {} }).length);
  });
  it('refuses changed outcomes, questions, wrong route, and truncated journals', () => {
    const e = evidence();
    for (const extra of [event('goal_outcome_bound'), event('clarification_requested'), event('task_choice', { provider: 'fallback', model: 'other' }), event('something', { truncated: true })]) assert.ok(verifyEvidence(scenario('V1-RESOURCE-STOCK'), { ...e, events: [...e.events, extra] }).length);
    assert.ok(verifyEvidence(scenario('V1-RESOURCE-STOCK'), { ...e, journal: [event('goal_proposal_accepted', { truncated: true })] }).length);
  });
  it('cannot count finite completion as persistent follow', () => {
    assert.ok(verifyEvidence(scenario('V1-FOLLOW'), evidence()).length);
    const e = evidence(); e.events = e.events.filter((v) => v.type !== 'goal_terminal' && v.type !== 'goal_outcome_bound'); e.events.push(event('goal_outcome_bound', { kind: 'persistent' }));
    assert.deepEqual(verifyEvidence(scenario('V1-FOLLOW'), e), []);
  });
  it('requires active cancellation, bounded control clear, own epoch, closed interface and honest partial effects', () => {
    const e = evidence(); e.events = e.events.filter((v) => v.type !== 'goal_terminal');
    e.events.push(event('goal_terminal', { state: 'cancelled', reason: 'owner_stop' }), event('goal_cleanup', { failed: 0 }), event('skill_outcome', { actionId: 'action-a', goalEpoch: 1, status: 'cancelled', evidence: { cleanup: { clearMs: 20, errors: [], clearedShared: true }, interfaceAfterSettle: { currentWindow: null, pendingRequests: 0 }, commandsAfterRevoke: 0, partialEffects: { confirmed: 'none', additional: 'unknown' } } }));
    e.stop = { sentAtMs: 50, activeAtMs: 40, family: 'mining', actionId: 'action-a' };
    assert.deepEqual(verifyEvidence(scenario('V1-STOP-MINING'), e), []);
    const cancelled = e.events.at(-1)!;
    for (const altered of [{ ...cancelled, goalEpoch: 2 }, { ...cancelled, evidence: { cleanup: { clearMs: 251 }, interfaceAfterSettle: { currentWindow: 7, pendingRequests: 1 }, commandsAfterRevoke: 1 } }]) assert.ok(verifyEvidence(scenario('V1-STOP-MINING'), { ...e, events: [...e.events.slice(0, -1), altered] }).length);
    assert.ok(verifyEvidence(scenario('V1-STOP-MINING'), { ...e, events: [...e.events, event('task_action')] }).length);
  });
  it('requires real process survivors list and cannot count another goal cleanup', () => {
    const e = evidence(); e.events = e.events.filter((v) => v.type !== 'goal_terminal');
    e.events.push(event('goal_terminal', { reason: 'owner_stop' }), event('goal_cleanup', { failed: 0 }), event('planner_turn_failed', { requestId: 'planner-a', kind: 'aborted' }), event('planner_process_cleanup', { requestId: 'planner-a', remaining: [] })); e.stop = { sentAtMs: 50, activeAtMs: 40, family: 'planner', requestId: 'planner-a' };
    assert.deepEqual(verifyEvidence(scenario('V1-STOP-PLANNER'), e), []);
    for (const remaining of [0, [123], undefined]) assert.ok(verifyEvidence(scenario('V1-STOP-PLANNER'), { ...e, events: [...e.events.slice(0, -1), event('planner_process_cleanup', { requestId: 'planner-a', remaining })] }).length);
  });
  it('decision cancellation requires the matching actual HTTP abort and retained ambiguous charge', () => {
    const e = evidence(); e.events = e.events.filter((v) => !['goal_terminal', 'task_choice'].includes(v.type));
    e.events.push(event('goal_terminal', { reason: 'owner_stop' }), event('goal_cleanup', { failed: 0 }), event('jev_failure', { requestId: 'jev-a', kind: 'aborted', spend: { retainedUsd: 0.001344 } }));
    e.stop = { sentAtMs: 50, activeAtMs: 40, family: 'decision', requestId: 'jev-a' };
    assert.deepEqual(verifyEvidence(scenario('V1-STOP-DECISION'), e), []);
    for (const changed of [{ requestId: 'other', kind: 'aborted', spend: { retainedUsd: 1 } }, { requestId: 'jev-a', kind: 'timeout', spend: { retainedUsd: 1 } }, { requestId: 'jev-a', kind: 'aborted', spend: {} }]) assert.ok(verifyEvidence(scenario('V1-STOP-DECISION'), { ...e, events: [...e.events.slice(0, -1), event('jev_failure', changed)] }).length);
  });
  it('fresh lifecycle idle requires an observation window and refuses replay of an old or new goal', () => {
    const e = evidence(); e.events = e.events.filter((v) => v.type !== 'goal_terminal');
    e.events.push(event('goal_terminal', { reason: 'kicked' }), event('goal_cleanup', { failed: 0 }));
    e.stop = { sentAtMs: 50, activeAtMs: 40, family: 'disconnect', actionId: 'action-a' };
    e.freshIdle = { sinceMs: 100, untilMs: 3100, events: [] };
    assert.deepEqual(verifyEvidence(scenario('V1-DISCONNECT'), e), []);
    assert.ok(verifyEvidence(scenario('V1-DISCONNECT'), { ...e, freshIdle: { sinceMs: 100, untilMs: 200, events: [] } }).length);
    assert.ok(verifyEvidence(scenario('V1-DISCONNECT'), { ...e, freshIdle: { ...e.freshIdle, events: [event('goal_admitted', { goalId: 'goal-new' })] } }).length);
  });
  it('missing actual payload capture, mismatched captures or hidden-coordinate leaks cannot verify privacy', () => {
    const e = evidence(); e.hiddenFacts = ['205,-60,214']; e.hiddenLocations = [{ x: 205, y: -60, z: 214 }];
    e.position = { x: 205.5, y: -60, z: 205.5 };
    e.events = e.events.filter((v) => v.type !== 'goal_terminal'); e.events.push(event('goal_terminal', { reason: 'owner_stop' }), event('goal_cleanup', { failed: 0 }));
    assert.ok(verifyEvidence(scenario('V1-PRIVACY'), e).length);
    e.captureComplete = true; e.captures = ['planner', 'jev'].map((provider) => ({ provider: provider as 'planner' | 'jev', goalId: e.goalId, requestId: provider, atMs: 100, body: 'filtered visible world' }));
    const hash = createHash('sha256').update('filtered visible world').digest('hex');
    e.events = e.events.map((v) => v.type === 'planner_turn_started' ? { ...v, requestId: 'planner', promptDigest: hash.slice(0, 12) } : v.type === 'jev_request' ? { ...v, requestId: 'jev', bodyDigest: { algorithm: 'sha256', parts: hash.match(/.{16}/g) } } : v.type === 'task_choice' ? { ...v, requestId: 'jev' } : v);
    assert.deepEqual(verifyEvidence(scenario('V1-PRIVACY'), e), []);
    assert.deepEqual(verifyEvidence(scenario('V1-PRIVACY'), { ...e, events: e.events.map((v) => redact(v) as Event) }), [], 'actual telemetry redaction must preserve digest binding');
    assert.ok(verifyEvidence(scenario('V1-PRIVACY'), { ...e, captures: e.captures.map((c) => ({ ...c, body: '205,-60,214' })) }).length);
  });
  it('untemplated composition is chosen at acceptance, not compiled as a goal plan', () => {
    assert.equal(selectScenarios(['V1-COMPOSITION'])[0]!.instruction, '');
    assert.throws(() => selectScenarios(['unknown'])); assert.throws(() => selectScenarios(['V1-STONE', 'V1-STONE']));
    const chosen = selectScenarios(['V1-COMPOSITION'], { instruction: 'Collect two oak logs and make two sticks, then come back', outputs: { 'minecraft:oak_log': 2, 'minecraft:stick': 2 } });
    assert.equal(chosen[0]!.instruction, 'Collect two oak logs and make two sticks, then come back');
    assert.throws(() => selectScenarios(undefined, { instruction: 'x', outputs: { 'minecraft:stone': 1, 'minecraft:stick': 1 }, supplies: { injected: 99 } } as unknown as Parameters<typeof selectScenarios>[1]));
  });
  it('incidental handle/coordinate/key ordering changes cannot establish a materially different plan', () => {
    const e = evidence(); e.journal = [event('goal_proposal_accepted', { proposal: { tasks: [{ allowedCapabilities: ['mine_block'], targetSelectors: [{ kind: 'handle', handle: 'h1', snapshotId: 's1', at: { x: 1, y: 2, z: 3 } }] }] } })];
    const changed = { ...e, journal: [event('goal_proposal_accepted', { proposal: { tasks: [{ targetSelectors: [{ snapshotId: 's2', at: { x: 9, y: 9, z: 9 }, handle: 'h2', kind: 'handle' }], allowedCapabilities: ['mine_block'] }] } })] };
    assert.equal(planSignature(e), planSignature(changed));
  });
  it('privacy scan detects structured, reordered and whitespace-separated coordinates', () => {
    const p = { x: 205, y: -60, z: 214 };
    for (const body of ['[205, -60, 214]', '{"block":{"z":214,"y":-60,"x":205}}', 'hidden at 205 / -60 / 214']) assert.equal(containsLocation(body, p), true);
    assert.equal(containsLocation('{"x":205,"y":-60,"z":213}', p), false);
  });
  it('three successful but identical or intervened resource trials cannot establish generality', () => {
    const rs = ['V1-RESOURCE-EMPTY', 'V1-RESOURCE-TOOL', 'V1-RESOURCE-STOCK'].map((id) => ({ id, phase: 'verified' as const, autonomous: true, problems: [], evidence: { ...evidence(), journal: [event('goal_proposal_accepted', { proposal: { tasks: [{ allowedCapabilities: ['mine_block'] }] } })] } }));
    assert.match(generalityProblems(rs).join(), /materially different/);
    rs[0]!.autonomous = false; assert.match(generalityProblems(rs).join(), /three autonomous/);
  });
});

describe('phase/report retention with injected test-only session', () => {
  it('saves staged then executed then failed evidence, and closes after oracle failure', async () => {
    const r = report(), phases: string[] = []; let closed = false;
    const session: Session = { stage: async () => {}, execute: async () => ({ ...evidence(), inventory: {} }), close: async () => { closed = true; return { reconciled: true, steps: [{ step: 'dummy', ok: true, detail: 'test' }] }; } };
    await runScenarios(r, [scenario('V1-RESOURCE-STOCK')], async () => session, () => { phases.push(r.results[0]!.phase); });
    assert.deepEqual(phases.slice(0, 3), ['staged', 'executed', 'failed']); assert.equal(closed, true); assert.ok(r.results[0]!.evidence); assert.equal(r.acceptance, false);
  });
  it('retains staging/execution and cleanup failures without crediting unexercised cases', async () => {
    const r = report();
    await runScenarios(r, [scenario('V1-RESOURCE-STOCK')], async () => ({ stage: async () => { throw new Error('foreign entity'); }, execute: async () => { throw new Error('should not execute'); }, close: async () => { throw new Error('cleanup failure'); } }), () => {});
    assert.equal(r.results[0]!.phase, 'failed'); assert.equal(r.results[0]!.executedAtMs, undefined); assert.deepEqual(r.results[0]!.problems, ['foreign entity']); assert.equal(r.cleanup?.reconciled, false);
  });
  it('open failure leaves all scenarios deferred and never claims cleanup or acceptance', async () => {
    const r = report(); await runScenarios(r, [scenario('V1-RESOURCE-STOCK')], async () => { throw new Error('lease absent'); }, () => {});
    assert.equal(r.results[0]!.phase, 'deferred'); assert.equal(r.cleanup, null); assert.equal(r.acceptance, false);
  });
  it('actual admission is checkpointed as executed even when later observation fails', async () => {
    const r = report(), phases: string[] = [];
    await runScenarios(r, [scenario('V1-RESOURCE-STOCK')], async () => ({ stage: async () => {}, execute: async (_s, admitted) => { admitted?.(); throw new Error('actual readback failed'); }, close: async () => ({ reconciled: false, steps: [] }) }), () => { phases.push(r.results[0]!.phase); });
    assert.deepEqual(phases.slice(0, 3), ['staged', 'executed', 'failed']); assert.ok(r.results[0]!.executedAtMs); assert.equal(r.results[0]!.verifiedAtMs, undefined);
  });
});
