// Codex CLI isolation gate: version pin, restricted catalog entry, feature
// effective states (with the documented inert unified_exec rule), neutral
// directory, scrubbed environment and exec arguments. Uses a fake runner;
// no real CLI or inference.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CODEX_PROFILE, execArgs, parseFeatureList, plannerEnv, restrictModelEntry, verifyIsolation, type CliRunner } from '../src/planner/codex-cli.ts';

const entry = {
  slug: 'gpt-6.1-sol',
  display_name: 'GPT-6.1-Sol',
  supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
  shell_type: 'unified_exec',
  apply_patch_tool_type: 'freeform',
  experimental_supported_tools: ['send_user_message_async', 'clock'],
  supports_search_tool: true,
  tool_mode: 'code_mode_only',
  multi_agent_version: 'v2',
  base_instructions: 'x',
};

function featureList(overrides: Record<string, boolean> = {}, stage = 'under development'): string {
  const rows = Object.entries({ ...CODEX_PROFILE.features, unified_exec: true, ...overrides }).map(([k, v]) => `${k.padEnd(40)} ${(k === 'skip_host_skill_discovery' ? stage : 'stable').padEnd(18)} ${v}`);
  return `${rows.join('\n')}\n`;
}

function runner(opts: { version?: string; models?: unknown; features?: string; login?: { status: number; text: string } } = {}): CliRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run(_cmd, args) {
      calls.push([...args]);
      if (args[0] === '--version') return { status: 0, stdout: `codex-cli ${opts.version ?? '0.160.0'}\n`, stderr: '' };
      if (args[0] === 'login') return { status: opts.login?.status ?? 0, stdout: '', stderr: `${opts.login?.text ?? 'Logged in using ChatGPT'}\n` };
      if (args[0] === 'debug') return { status: 0, stdout: JSON.stringify(opts.models ?? { models: [entry] }), stderr: '' };
      if (args[0] === 'features') return { status: 0, stdout: opts.features ?? featureList(), stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected' };
    },
  };
}

const neutral = () => {
  const d = join(mkdtempSync(join(tmpdir(), 'chunkbot-planner-test-')), 'neutral');
  return d;
};
const opts = (r: CliRunner, over: Partial<Parameters<typeof verifyIsolation>[0]> = {}) => ({ command: process.execPath, model: 'gpt-6.1-sol', effort: 'low' as const, env: { PATH: process.env['PATH'] ?? '' }, runner: r, neutralDir: neutral(), ...over });

describe('Codex CLI isolation gate (fake runner)', () => {
  it('passes for the pinned version and writes only app-owned files with the restricted entry', () => {
    const r = runner();
    const res = verifyIsolation(opts(r), true);
    assert.equal(res.ok, true, res.ok ? '' : res.detail);
    if (!res.ok) return;
    assert.match(res.isolation.checks.find((c) => c.name === 'features')?.detail ?? '', /unified_exec stays on .*inert because shell_tool is off/);
    assert.deepEqual(r.calls.map((c) => c.slice(0, 2).join(' ')), ['--version', 'login status', 'debug models', 'features list']);
    assert.deepEqual(r.calls[1], ['login', 'status', '-c', 'cli_auth_credentials_store="file"'], 'the same credentials store exec uses');
    assert.match(res.isolation.checks.find((c) => c.name === 'auth')?.detail ?? '', /managed ChatGPT subscription login/);
    assert.ok(r.calls[3]!.includes('features.shell_tool=false') && r.calls[3]!.includes('features.skip_host_skill_discovery=true'));
  });

  it('fails closed on any other CLI version, a missing model, a changed registration field or an unsupported effort', () => {
    assert.match((verifyIsolation(opts(runner({ version: '0.161.0' })), false) as { detail: string }).detail, /verified for exactly 0\.160\.0/);
    assert.match((verifyIsolation(opts(runner({ models: { models: [{ ...entry, slug: 'other' }] } })), false) as { detail: string }).detail, /no gpt-6\.1-sol entry/);
    const { tool_mode: _drop, ...noToolMode } = entry;
    void _drop;
    assert.match((verifyIsolation(opts(runner({ models: { models: [noToolMode] } })), false) as { detail: string }).detail, /no "tool_mode" field/);
    assert.match((verifyIsolation(opts(runner({ models: { models: [{ ...entry, supports_search_tool: 'yes' }] } })), false) as { detail: string }).detail, /supports_search_tool" is string/);
    assert.match((verifyIsolation(opts(runner(), { model: 'gpt-5.5' }), false) as { detail: string }).detail, /no other planner model is authorized/);
  });

  it('fails closed when a feature is unknown, stays on (other than the documented inert case) or the stage changed', () => {
    const missing = featureList().split('\n').filter((l) => !l.startsWith('apps ')).join('\n');
    assert.match((verifyIsolation(opts(runner({ features: missing })), false) as { detail: string }).detail, /apps unknown to this CLI/);
    assert.match((verifyIsolation(opts(runner({ features: featureList({ plugins: true }) })), false) as { detail: string }).detail, /plugins=true \(need false\)/);
    assert.match((verifyIsolation(opts(runner({ features: featureList({ shell_tool: true }) })), false) as { detail: string }).detail, /shell_tool=true.*unified_exec=true|unified_exec=true|shell_tool=true/);
    assert.match((verifyIsolation(opts(runner({ features: featureList({}, 'stable') })), false) as { detail: string }).detail, /stage is "stable"/);
  });

  it('MB-PLAN-002: rejects persisted API-key, absent, non-subscription and unrecognized logins before any inference, keeping only the mode', () => {
    const cases: Array<[number, string, RegExp]> = [
      [0, 'Logged in using an API key - sk-proj-***abcde', /auth mode api_key: .*persisted API-key login.*ONLY the managed ChatGPT subscription/],
      [1, 'Not logged in', /auth mode absent: .*codex login/],
      [0, 'Logged in using personal access token', /auth mode other/],
      [0, 'Logged in using Amazon Bedrock API key', /auth mode other/],
      [1, 'Error checking login status: boom', /auth mode unrecognized/],
      [0, 'Logged in using ChatGPT, maybe', /auth mode unrecognized/],
    ];
    for (const [status, text, re] of cases) {
      const r = runner({ login: { status, text } });
      const res = verifyIsolation(opts(r), false);
      assert.equal(res.ok, false, text);
      if (res.ok) continue;
      assert.match(res.detail, re);
      assert.doesNotMatch(JSON.stringify(res), /sk-proj|abcde|boom/, 'never the raw status text or key fragment');
      assert.deepEqual(r.calls.map((c) => c[0]), ['--version', 'login'], 'stops before catalog/features and before any exec');
    }
  });

  it('refuses a neutral directory under development-instruction markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'chunkbot-planner-markers-'));
    writeFileSync(join(root, 'AGENTS.md'), '# dev instructions');
    mkdirSync(join(root, 'x'));
    assert.match((verifyIsolation(opts(runner(), { neutralDir: join(root, 'x', 'neutral') }), false) as { detail: string }).detail, /AGENTS\.md/);
  });

  it('doctor mode skips the cloud-config-loading feature list', () => {
    const r = runner();
    const res = verifyIsolation(opts(r, { featureGate: false }), false);
    assert.equal(res.ok, true);
    assert.deepEqual(r.calls.map((c) => c[0]), ['--version', 'login', 'debug']);
  });
});

describe('restricted catalog entry, feature parsing, environment and arguments', () => {
  it('restricts ONLY the tool-exposure metadata', () => {
    const { entry: out, problems } = restrictModelEntry(entry);
    assert.deepEqual(problems, []);
    assert.deepEqual({ shell_type: out['shell_type'], apply_patch_tool_type: out['apply_patch_tool_type'], experimental_supported_tools: out['experimental_supported_tools'], supports_search_tool: out['supports_search_tool'], tool_mode: out['tool_mode'] }, { shell_type: 'disabled', apply_patch_tool_type: null, experimental_supported_tools: [], supports_search_tool: false, tool_mode: 'direct' });
    for (const k of ['slug', 'display_name', 'supported_reasoning_levels', 'multi_agent_version', 'base_instructions']) assert.deepEqual(out[k], (entry as Record<string, unknown>)[k], `${k} preserved`);
  });

  it('parses `codex features list` rows including multi-word stages', () => {
    const m = parseFeatureList('skip_host_skill_discovery                under development  true\nshell_tool                               stable             false\n');
    assert.deepEqual(m.get('skip_host_skill_discovery'), { stage: 'under development', enabled: true });
    assert.deepEqual(m.get('shell_tool'), { stage: 'stable', enabled: false });
  });

  it('passes an allowlisted OS environment only: never API keys, tokens, sessions, backends or the Jev key', () => {
    const env = plannerEnv(
      { PATH: '/bin', HOME: '/h', LANG: 'en', OPENROUTER_API_KEY: 'sk-or-x', OPENAI_API_KEY: 'sk-x', OPENAI_BASE_URL: 'http://evil', CODEX_SESSION_ID: 's', CODEX_HOME: '/c', GITHUB_TOKEN: 't', MY_JEV_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'a', NODE_OPTIONS: '--require x' },
      ['MY_JEV_KEY'],
    );
    assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'PATH']);
  });

  it('exec arguments carry the supported isolation controls', () => {
    const iso = { command: '/x/codex', cliVersion: '0.160.0', model: 'gpt-6.1-sol', effort: 'low' as const, neutralDir: '/tmp/n', stateDir: '/tmp/n/state', catalogPath: '/tmp/n/c.json', catalogDigest: 'd', bundledModelDigest: 'b', featureStages: {}, env: {}, checks: [] };
    const args = execArgs(iso, '/tmp/n/schema.json', '/tmp/n/instr.txt');
    for (const flag of ['--no-daemon', 'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json']) assert.ok(args.includes(flag), flag);
    const pairs = new Map<string, string>();
    for (let i = 0; i < args.length - 1; i += 1) if (args[i]!.startsWith('-') && !args[i + 1]!.startsWith('--')) pairs.set(args[i]!, args[i + 1]!);
    assert.equal(pairs.get('-C'), '/tmp/n');
    assert.equal(pairs.get('-m'), 'gpt-6.1-sol');
    assert.equal(pairs.get('--sandbox'), 'read-only');
    const c = args.filter((_, i) => args[i - 1] === '-c');
    for (const want of ['cli_auth_credentials_store="file"', 'approval_policy="never"', 'agents.enabled=false', 'mcp_servers={}', 'project_doc_max_bytes=0', 'web_search="disabled"', 'include_environment_context=false', 'model_reasoning_effort="low"', 'model_catalog_json="/tmp/n/c.json"', 'model_instructions_file="/tmp/n/instr.txt"', 'sqlite_home="/tmp/n/state"', 'features.shell_tool=false', 'features.multi_agent_v2=false']) assert.ok(c.includes(want), want);
    assert.equal(args.at(-1), '-', 'prompt from stdin');
  });
});
