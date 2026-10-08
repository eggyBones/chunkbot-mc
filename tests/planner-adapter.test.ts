// CodexPlanner adapter end to end against a fake CLI (no inference): gate ->
// readiness -> one turn -> wire conversion -> journal/usage; sticky disable on
// isolation breach; prompt rendering stays bounded contract data.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ObservationSnapshot, PlannerRequest } from '../src/contracts/index.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { CODEX_PROFILE, type CliRunner } from '../src/planner/codex-cli.ts';
import { CodexPlanner } from '../src/planner/codex-planner.ts';
import { isPlannerError } from '../src/planner/errors.ts';
import { PLANNER_INSTRUCTIONS, renderRequest } from '../src/planner/prompt.ts';
import { allSkills } from '../src/skills/index.ts';
import { FileRunStore, MemoryRunStore } from '../src/telemetry/run-store.ts';
import { setFaultTurns, writeFaultCodex, type FaultTurn } from '../scripts/lib/fault-codex.ts';
import { existsSync } from 'node:fs';
import { pendingRealTurn } from '../scripts/lib/ordinary-safety-oracles.ts';

const catalog = new SkillRegistry(allSkills()).catalog();
const gateRunner: CliRunner = {
  run(_c, args) {
    if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.160.0\n', stderr: '' };
    if (args[0] === 'login') return { status: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
    if (args[0] === 'debug') return { status: 0, stdout: JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', supported_reasoning_levels: [{ effort: 'low' }], shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', experimental_supported_tools: [], supports_search_tool: true, tool_mode: 'code_mode_only' }] }), stderr: '' };
    return { status: 0, stdout: Object.entries({ ...CODEX_PROFILE.features, unified_exec: true }).map(([k, v]) => `${k}  ${k === 'skip_host_skill_discovery' ? 'under development' : 'stable'}  ${v}`).join('\n'), stderr: '' };
  },
};

function planner(turns: FaultTurn[], capturePrompt = false) {
  const dir = mkdtempSync(join(tmpdir(), 'chunkbot-adapter-'));
  const fault = writeFaultCodex(dir, '/nonexistent/codex');
  const command = capturePrompt ? join(dir, 'capture-codex.cjs') : fault;
  if (capturePrompt) writeFileSync(command, `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const input = args.includes('exec') ? readFileSync(0, 'utf8') : undefined;
if (input !== undefined) writeFileSync(${JSON.stringify(join(dir, 'received-prompt.txt'))}, input);
const result = spawnSync(${JSON.stringify(fault)}, args, { input, stdio: ['pipe', 'inherit', 'inherit'] });
process.exitCode = result.status ?? 1;
`, { mode: 0o700 });
  setFaultTurns(dir, '/nonexistent/codex', turns, 'chatgpt');
  const store = new MemoryRunStore();
  const journal = new MemoryRunStore();
  if (capturePrompt) {
    const file = new FileRunStore({ runsDir: join(dir, 'runs'), runId: 'run-metadata', clock: { now: () => Date.now() }, maxEvents: 100, maxEventChars: 4_000, keepRuns: 1 });
    const record = store.record.bind(store);
    store.record = (event) => { record(event); file.record(event); };
  }
  const p = new CodexPlanner({ command, model: 'gpt-6.1-sol', effort: 'low', env: { ...process.env, OPENROUTER_API_KEY: 'sk-or-secret' }, denyEnv: ['OPENROUTER_API_KEY'], store, journal, timeoutMs: 5_000, windowSteps: 8, neutralDir: join(dir, 'neutral'), runner: gateRunner });
  return { p, store, journal, dir };
}

const request = (over: Partial<PlannerRequest> = {}): PlannerRequest => ({ requestId: 'req-0001', subject: { kind: 'goal', goalId: 'goal-0001', goalEpoch: 1 }, instruction: 'get me two cobblestone', turn: 1, maxTurns: 20, catalog, observation: null, knowledge: [], ...over });
const wireInfo = { disposition: 'needs_information', interpretation: 'need rules', outcome: null, tasks: [], morePlanningNeeded: false, queries: [{ kind: 'harvest', key: 'stone' }], question: null, missing: null, missingCapabilities: [], verifiedProgress: null };
const observed = (over: Partial<ObservationSnapshot> = {}): ObservationSnapshot => ({ id: 'snap-0101', connectionEpoch: 7, goalEpoch: 13, takenAtMs: 1_791_480_987_654, dimension: 'overworld', self: { at: { x: 0, y: -60, z: 0 }, health: 20, food: 20 }, inventory: [], equipment: {}, owner: { visible: false }, entities: [], blocks: [], drops: [], remembered: [], blockSummary: [], frontiers: [], ...over });

describe('CodexPlanner adapter (fake CLI)', () => {
  for (const kind of ['initial', 'lookahead', 'preparation', 'no_observation'] as const) {
    it(`correlates exact received observation metadata with ${kind} journal scope without deriving it from the subject or journal clock`, async () => {
      const { p, store, journal, dir } = planner([{ kind: 'proposal', proposal: wireInfo }], true);
      const snapshot = kind === 'no_observation' ? null : observed();
      const subject: PlannerRequest['subject'] = kind === 'preparation'
        ? { kind: 'preparation', intentId: 'intent-0101', generation: 4, connectionEpoch: 7, activeGoalId: 'goal-old' }
        : { kind: 'goal', goalId: 'goal-0101', goalEpoch: 13 };
      const input = request({ subject, observation: snapshot, ...(kind === 'lookahead' ? { turnKind: 'lookahead' } : {}) });
      assert.equal(p.prepare().ok, true);
      await p.propose(input, new AbortController().signal);
      const received = readFileSync(join(dir, 'received-prompt.txt'), 'utf8');
      assert.equal(received, renderRequest(input, 8), 'metadata traverses the real adapter/transport stdin');
      const doc = JSON.parse(received.slice(received.indexOf('{')));
      const start = store.ofType('planner_turn_started')[0]!;
      assert.equal(start['snapshotId'], snapshot?.id ?? null);
      assert.equal(start['snapshotTakenAtMs'], snapshot?.takenAtMs ?? null);
      assert.equal(start['promptDigest'], createHash('sha256').update(received).digest('hex').slice(0, 12), 'existing journal digest convention');
      const disk = readFileSync(join(dir, 'runs', 'run-metadata', 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      const diskStart = disk.find((e) => e['type'] === 'planner_turn_started')!;
      assert.deepEqual(Object.fromEntries(Object.keys(start).map((key) => [key, diskStart[key]])), start, 'the actual bounded/redacted JSONL writer preserves the emitted metadata');
      assert.notEqual(Date.parse(String(diskStart['t'])), snapshot?.takenAtMs, 'journal write time cannot stand in for observation time');
      const rows = [...store.events.filter((e) => e['requestId'] === input.requestId), ...journal.ofType('planner_proposal_raw')];
      for (const row of rows) {
        assert.equal(row['subject'], subject.kind === 'goal' ? subject.goalId : subject.intentId);
        assert.equal(row['subjectGoalEpoch'], subject.kind === 'goal' ? subject.goalEpoch : null);
        assert.equal(row['goalEpoch'], snapshot?.goalEpoch ?? null, `${row.type}: observation epoch, including null when unavailable`);
        assert.equal(row['connectionEpoch'], snapshot?.connectionEpoch ?? null);
      }
      if (snapshot) {
        assert.deepEqual({ takenAtMs: doc.observation.takenAtMs, goalEpoch: doc.observation.goalEpoch, connectionEpoch: doc.observation.connectionEpoch }, { takenAtMs: start['snapshotTakenAtMs'], goalEpoch: start['goalEpoch'], connectionEpoch: start['connectionEpoch'] });
        assert.deepEqual(doc.observation.owner, { visible: false });
      } else {
        assert.equal(doc.observation.available, false);
        assert.ok(!('goalEpoch' in doc.observation), 'an admitted subject cannot fabricate an observation');
      }
      if (kind === 'preparation') assert.ok(!('goalId' in start), 'the current observation does not admit the pending instruction');
    });
  }

  it('keeps snapshot metadata during actual request trimming and retains the original mandatory-input size refusal', () => {
    const snapshot = observed({ blocks: Array.from({ length: 100 }, (_, i) => ({ handle: `blk-${i}`, key: 'minecraft:stone', at: { x: i, y: -61, z: 0 }, distance: i })) });
    const knowledge = Array.from({ length: 24 }, () => ({ status: 'unknown' as const, query: { kind: 'item' as const, key: 'minecraft:x' }, detail: 'y'.repeat(6_000) }));
    const text = renderRequest(request({ observation: snapshot, knowledge }), 8);
    const doc = JSON.parse(text.slice(text.indexOf('{')));
    assert.equal(doc.knowledge.length, 12, 'the real request loop performed a trim');
    assert.equal(doc.observation.blocks.length, 48);
    assert.deepEqual({ takenAtMs: doc.observation.takenAtMs, goalEpoch: doc.observation.goalEpoch, connectionEpoch: doc.observation.connectionEpoch }, { takenAtMs: snapshot.takenAtMs, goalEpoch: snapshot.goalEpoch, connectionEpoch: snapshot.connectionEpoch });
    assert.ok(text.length < 120_000);
    const oversized = { ...catalog, capabilities: Array.from({ length: 2_000 }, () => catalog.capabilities[0]!) };
    assert.throws(() => renderRequest(request({ observation: snapshot, catalog: oversized }), 8), /exceeds the bounded size even after trimming/);
  });

  it('is not ready until its isolation gate passes; then proposes through the real transport, wire conversion and journal', async () => {
    const { p, store, journal } = planner([{ kind: 'proposal', proposal: wireInfo }]);
    const record = store.record.bind(store);
    const observedPending: boolean[] = [];
    store.record = (event) => {
      record(event);
      if (['planner_stream_started', 'planner_response_started'].includes(event.type)) observedPending.push(Boolean(pendingRealTurn(store.events, journal.events, 'goal-0001')));
    };
    assert.equal(p.readiness().ready, false);
    assert.equal(p.prepare().ok, true);
    assert.match(p.readiness().detail, /selected gpt-6\.1-sol\/low; server-resolved identity is not echoed/);
    const proposal = await p.propose(request(), new AbortController().signal);
    assert.deepEqual(proposal, { version: 1, interpretation: 'need rules', disposition: 'needs_information', queries: [{ kind: 'harvest', block: 'minecraft:stone' }] });
    assert.equal(p.totals.completedTurns, 1);
    const iso = store.ofType('planner_isolation')[0]!;
    assert.ok(!(iso['envNames'] as string[]).includes('OPENROUTER_API_KEY'));
    assert.equal(store.ofType('planner_turn_completed')[0]?.['resolvedModel'], 'not echoed by the CLI (no reroute event observed)');
    assert.equal(journal.ofType('planner_proposal_raw').length, 1);
    assert.deepEqual(observedPending, [true, false], 'actual adapter stream metadata opens/closes the harness race before process settlement');
    const types = store.events.map((e) => e.type);
    for (const type of ['planner_stream_started', 'planner_response_started', 'planner_stream_completed']) {
      const rows = store.ofType(type);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!['requestId'], 'req-0001');
      assert.equal(rows[0]!['goalId'], 'goal-0001');
      assert.equal(rows[0]!['subject'], 'goal-0001');
      assert.ok(!('text' in rows[0]!) && !('content' in rows[0]!), 'metadata contains no response/reasoning content');
    }
    assert.ok(types.indexOf('planner_stream_started') < types.indexOf('planner_response_started'));
    assert.ok(types.indexOf('planner_response_started') < types.indexOf('planner_stream_completed'));
    assert.ok(types.indexOf('planner_stream_completed') < types.indexOf('planner_turn_completed'));
  });

  it('turns invalid output into a typed invalid_output failure with repair problems', async () => {
    const { p } = planner([{ kind: 'proposal', proposal: { ...wireInfo, disposition: 'plan', interpretation: 'function x() { return 1 }' } }]);
    p.prepare();
    try {
      await p.propose(request(), new AbortController().signal);
      assert.fail('expected failure');
    } catch (e) {
      assert.ok(isPlannerError(e));
      assert.equal(e.failure.kind, 'invalid_output');
      assert.match((e.failure.problems ?? []).join(' '), /code-bearing/);
    }
  });

  it('a prohibited tool event disables the planner for the rest of the run (no fallback)', async () => {
    const { p, store } = planner([{ kind: 'tool', proposal: wireInfo }, { kind: 'proposal', proposal: wireInfo }]);
    p.prepare();
    await assert.rejects(p.propose(request(), new AbortController().signal), (e: unknown) => isPlannerError(e) && e.failure.kind === 'prohibited_event');
    assert.equal(p.readiness().ready, false);
    assert.match(p.readiness().detail, /disabled for this run: prohibited_event/);
    await assert.rejects(p.propose(request(), new AbortController().signal), (e: unknown) => isPlannerError(e) && e.failure.kind === 'not_ready');
    assert.equal(store.ofType('planner_disabled_for_run').length, 1);
  });

  it('MB-PLAN-002: a login changed to API-key (or signed out) after startup is caught before the next turn: no exec, typed auth failure, mode-only evidence', async () => {
    for (const mode of ['api_key', 'absent'] as const) {
      const { p, store, dir } = planner([{ kind: 'proposal', proposal: wireInfo }]);
      assert.equal(p.prepare().ok, true);
      setFaultTurns(dir, '/nonexistent/codex', [{ kind: 'proposal', proposal: wireInfo }], mode);
      await assert.rejects(p.propose(request(), new AbortController().signal), (e: unknown) => isPlannerError(e) && e.failure.kind === 'auth' && new RegExp(`auth mode ${mode}`).test(e.failure.detail));
      assert.equal(existsSync(join(dir, 'fault-codex-last-prompt-chars.json')), false, 'no exec turn was started');
      const ev = store.ofType('planner_auth_rejected')[0]!;
      assert.equal(ev['authMode'], mode);
      assert.doesNotMatch(JSON.stringify(store.events), /sk-fixtu/);
      setFaultTurns(dir, '/nonexistent/codex', [{ kind: 'proposal', proposal: wireInfo }], 'chatgpt');
      assert.equal((await p.propose(request(), new AbortController().signal)).disposition, 'needs_information', 'the subscription login works again without restart');
      assert.equal(store.ofType('planner_turn_started').at(-1)?.['authMode'], 'chatgpt');
    }
  });

  it('renders a bounded JSON document from contract data only, with gameplay-only base instructions', () => {
    const snapshot = { id: 'snap-0001', connectionEpoch: 1, goalEpoch: 1, takenAtMs: 0, dimension: 'overworld', self: { at: { x: 0.123, y: -60, z: 0 }, health: 20, food: 20 }, inventory: [], equipment: {}, owner: { visible: false }, entities: [], blocks: Array.from({ length: 128 }, (_, i) => ({ handle: `blk-${i}`, key: 'minecraft:stone', at: { x: i, y: -61, z: 0 }, distance: i })), drops: [], remembered: [], blockSummary: [], frontiers: [] } as unknown as ObservationSnapshot;
    const text = renderRequest(request({ observation: snapshot, knowledge: Array.from({ length: 60 }, () => ({ status: 'unknown' as const, query: { kind: 'item' as const, key: 'minecraft:x' }, detail: 'y'.repeat(150) })) }), 8);
    const doc = JSON.parse(text.slice(text.indexOf('{')));
    assert.ok(text.length < 120_000);
    assert.equal(doc.observation.blocks.length, 96, 'blocks bounded');
    assert.equal(doc.knowledge.length, 24, 'knowledge bounded to the latest results');
    assert.deepEqual(Object.keys(doc).sort(), ['accepted', 'admission', 'catalog', 'counters', 'feedback', 'goal', 'kind', 'knowledge', 'limits', 'mechanicsVersion', 'observation', 'priorResults', 'remaining']);
    assert.doesNotMatch(PLANNER_INSTRUCTIONS, /AGENTS\.md|repository|edit files|apply_patch/i);
    assert.match(PLANNER_INSTRUCTIONS, /You have no tools/);
    assert.equal(readFileSync(new URL('../src/planner/prompt.ts', import.meta.url), 'utf8').includes('collect stone'), false);
  });
});
