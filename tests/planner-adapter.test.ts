// CodexPlanner adapter end to end against a fake CLI (no inference): gate ->
// readiness -> one turn -> wire conversion -> journal/usage; sticky disable on
// isolation breach; prompt rendering stays bounded contract data.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { setFaultTurns, writeFaultCodex, type FaultTurn } from '../scripts/lib/fault-codex.ts';
import { existsSync } from 'node:fs';

const catalog = new SkillRegistry(allSkills()).catalog();
const gateRunner: CliRunner = {
  run(_c, args) {
    if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.160.0\n', stderr: '' };
    if (args[0] === 'login') return { status: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
    if (args[0] === 'debug') return { status: 0, stdout: JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', supported_reasoning_levels: [{ effort: 'low' }], shell_type: 'unified_exec', apply_patch_tool_type: 'freeform', experimental_supported_tools: [], supports_search_tool: true, tool_mode: 'code_mode_only' }] }), stderr: '' };
    return { status: 0, stdout: Object.entries({ ...CODEX_PROFILE.features, unified_exec: true }).map(([k, v]) => `${k}  ${k === 'skip_host_skill_discovery' ? 'under development' : 'stable'}  ${v}`).join('\n'), stderr: '' };
  },
};

function planner(turns: FaultTurn[]) {
  const dir = mkdtempSync(join(tmpdir(), 'chunkbot-adapter-'));
  const command = writeFaultCodex(dir, '/nonexistent/codex');
  setFaultTurns(dir, '/nonexistent/codex', turns, 'chatgpt');
  const store = new MemoryRunStore();
  const journal = new MemoryRunStore();
  const p = new CodexPlanner({ command, model: 'gpt-6.1-sol', effort: 'low', env: { ...process.env, OPENROUTER_API_KEY: 'sk-or-secret' }, denyEnv: ['OPENROUTER_API_KEY'], store, journal, timeoutMs: 5_000, windowSteps: 8, neutralDir: join(dir, 'neutral'), runner: gateRunner });
  return { p, store, journal, dir };
}

const request = (over: Partial<PlannerRequest> = {}): PlannerRequest => ({ requestId: 'req-0001', subject: { kind: 'goal', goalId: 'goal-0001', goalEpoch: 1 }, instruction: 'get me two cobblestone', turn: 1, maxTurns: 20, catalog, observation: null, knowledge: [], ...over });
const wireInfo = { disposition: 'needs_information', interpretation: 'need rules', outcome: null, tasks: [], morePlanningNeeded: false, queries: [{ kind: 'harvest', key: 'stone' }], question: null, missing: null, missingCapabilities: [], verifiedProgress: null };

describe('CodexPlanner adapter (fake CLI)', () => {
  it('is not ready until its isolation gate passes; then proposes through the real transport, wire conversion and journal', async () => {
    const { p, store, journal } = planner([{ kind: 'proposal', proposal: wireInfo }]);
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
