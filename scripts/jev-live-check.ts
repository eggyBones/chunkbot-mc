// MB-V1-03 generic task controller live check against the LOCAL TEST FIXTURE.
//
// Drives the real built CLI (`node dist/cli.js run`) over its terminal with
// OPERATOR TASK DIAGNOSTICS (`/task <TaskSpec json>`): each generic TaskSpec is
// admitted through the goal engine's ownership/epoch/anchor path and executed
// by the generic task runtime -> registered resolvers -> Jev choice ->
// revalidation -> accepted SkillExecutor -> code-evaluated predicates. Task
// specs are written by the operator as a planner stand-in; they are controller
// and mechanics trials, NOT autonomous natural-language goal acceptance.
//
//   provider modes:
//     --provider real   (default) the configured OpenRouter route; requires the
//                       key env var (e.g. OPENROUTER_API_KEY) injected by the
//                       operator's credential helper. Spends ~USD 0.001-0.01.
//     --provider fault  a LOOPBACK fault-fixture provider in this process that
//                       always picks the first offered option. Harness
//                       validation only; never acceptance evidence for Jev.
//
// Scene setup is loopback RCON in the reset area (scripts/lib/scene.ts) and is
// recorded separately from in-trial interventions. Server truth (position,
// inventory, blocks) is read over RCON independently of the bot.
//
//   npm run build && npm run fixture -- start && npm run jev-live-check
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';

// Fixture profile: default 26.1.2 (unchanged); `--fixture 26.2` selects the distinct 26.2 fixture (MB-SERVER-001).
const FIXTURE_PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const FIXTURE_SUFFIX = FIXTURE_PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${FIXTURE_PINS.profile}`;
/** Regex-escaped fixture version for expected output lines. */
const FIXTURE_VERSION_RE = FIXTURE_PINS.minecraftVersion.replace(/\./g, '\\.');
import { CliProcess } from './lib/cli-process.ts';
import { rconCommand } from './lib/rcon.ts';
import { SCENE, sceneClearCommands, sceneCommands } from './lib/scene.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Bot = ReturnType<typeof mineflayer.createBot>;

const mode = process.argv.includes('--provider') ? process.argv[process.argv.indexOf('--provider') + 1] : 'real';
if (mode !== 'real' && mode !== 'fault') {
  process.stderr.write('usage: jev-live-check [--provider real|fault]\n');
  process.exit(2);
}
const only = process.argv.includes('--only') ? new Set((process.argv[process.argv.indexOf('--only') + 1] ?? '').split(',')) : undefined;
const fx = fixturePaths(PROJECT_ROOT, FIXTURE_PINS);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${FIXTURE_SUFFIX}-jev-${mode}`);
mkdirSync(outDir, { recursive: true });
// The controller fixture uses operator task diagnostics: the planner is disabled by the explicit
// inference-free profile (J11 checks that natural-language intake stays planner_not_ready).
const BASE_CONFIG = join(PROJECT_ROOT, FIXTURE_PINS.inferenceFreeConfig);

interface Result {
  id: string;
  title: string;
  pass: boolean;
  evidence: string[];
  trials: Json[];
}
const results: Result[] = [];
const setupLog: Array<{ atMs: number; scenario: string; command: string; reply: string }> = [];
const interventions: Array<{ atMs: number; scenario: string; command: string; reply: string; why: string }> = [];
let currentScenario = 'preflight';

function rconPassword(): string {
  const line = readFileSync(fx.properties, 'utf8').split('\n').find((l) => l.startsWith('rcon.password='));
  if (!line) throw new Error('fixture RCON password missing');
  return line.slice('rcon.password='.length).trim();
}
const password = rconPassword();
let rconQueue: Promise<unknown> = Promise.resolve();
function rconRaw(command: string): Promise<string> {
  const run = rconQueue.then(() => rconCommand(FIXTURE_PINS.host, FIXTURE_PINS.rconPort, password, command));
  rconQueue = run.catch(() => undefined);
  return run;
}
/** Scene SETUP (before a trial starts). */
async function setup(command: string): Promise<string> {
  const reply = await rconRaw(command);
  setupLog.push({ atMs: Date.now(), scenario: currentScenario, command, reply: reply.slice(0, 200) });
  return reply;
}
/** IN-TRIAL intervention (world change while a task runs), recorded with its reason. */
async function intervene(command: string, why: string): Promise<string> {
  const reply = await rconRaw(command);
  interventions.push({ atMs: Date.now(), scenario: currentScenario, command, reply: reply.slice(0, 200), why });
  return reply;
}

async function serverPos(name = 'Chunkbot'): Promise<{ x: number; y: number; z: number }> {
  const r = await rconRaw(`data get entity ${name} Pos`);
  if (!r.startsWith(`${name} has the following entity data:`)) throw new Error(`RCON reply not attributed to ${name}: ${r.slice(0, 120)}`);
  const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(r);
  if (!m) throw new Error(`cannot read position: ${r}`);
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}
async function serverInventory(name = 'Chunkbot'): Promise<Record<string, number>> {
  const r = await rconRaw(`data get entity ${name} Inventory`);
  const out: Record<string, number> = {};
  for (const entry of r.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) ?? []) {
    const id = /id: "([^"]+)"/.exec(entry)?.[1];
    const count = Number(/count: (\d+)/.exec(entry)?.[1] ?? 0);
    if (id) out[id] = (out[id] ?? 0) + count;
  }
  return out;
}
async function blockIs(x: number, y: number, z: number, block: string): Promise<boolean> {
  return /passed/i.test(await rconRaw(`execute if block ${x} ${y} ${z} ${block}`));
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function check(id: string, title: string, fn: (ev: string[], trials: Json[]) => Promise<void>): Promise<void> {
  if (only && !only.has(id)) return;
  currentScenario = id;
  const evidence: string[] = [];
  const trials: Json[] = [];
  const started = Date.now();
  try {
    await fn(evidence, trials);
    results.push({ id, title, pass: true, evidence, trials });
    process.stdout.write(`PASS ${id} ${title} (${Date.now() - started}ms)\n`);
  } catch (error) {
    evidence.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    results.push({ id, title, pass: false, evidence, trials });
    process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)?.slice(0, 600)}\n`);
  }
}

// ---------------------------------------------------------------- provider

let faultServer: Server | undefined;
/**
 * Fault-fixture policy (deterministic, NOT a model): the first offered option
 * whose text was not among its last three picks, else the first option.
 */
const faultRecent: string[] = [];
async function startFaultProvider(): Promise<string> {
  faultServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const parsed = JSON.parse(body) as Json;
      const criteria = parsed.questions.next_action.criteria as Record<string, string>;
      const all = Object.keys(criteria);
      const pick = all.find((k) => !faultRecent.includes(criteria[k] ?? '')) ?? all[0]!;
      faultRecent.push(criteria[pick] ?? '');
      if (faultRecent.length > 3) faultRecent.shift();
      const keys = [pick, ...all.filter((k) => k !== pick)];
      const bytes = Buffer.byteLength(body);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            model: 'typesafe/jev-1.13-20260917',
            provider: 'TypeSafe',
            id: 'gen-dec-FAULT-FIXTURE',
            answers: { next_action: { type: 'choice', choice: pick, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])), confidence: 1 } },
            usage: { input_tokens: Math.round(bytes / 3), output_tokens: 10, cost: Math.round(bytes / 3) * 4.2e-8 },
          }),
        );
      }, 60);
    });
  });
  await new Promise<void>((r) => faultServer!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(faultServer.address() as AddressInfo).port}/api/alpha/decisions`;
}

// ---------------------------------------------------------------- CLI task helpers

let chunkbot: CliProcess;
let runEventsPath = '';

function taskJsonSince(from: number): Json[] {
  return chunkbot.lines
    .slice(from)
    .filter((l) => l.text.startsWith('[task-json] '))
    .map((l) => ({ atMs: l.atMs, ...(JSON.parse(l.text.slice('[task-json] '.length)) as Json) }));
}

async function waitTaskJson(kind: string, from: number, timeoutMs: number, goalId?: string): Promise<Json> {
  const line = await chunkbot.waitSince(new RegExp(`^\\[task-json\\] \\{"kind":"${kind}"${goalId ? `.*"goalId":"${goalId}"` : ''}`), from, timeoutMs);
  return JSON.parse(line.slice('[task-json] '.length)) as Json;
}

function runEvents(): Json[] {
  try {
    return readFileSync(runEventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
  } catch {
    return [];
  }
}

interface Trial {
  name: string;
  goalId: string;
  terminal: Json;
  goalLine: string;
  events: Json[];
  decisions: Json[];
}

/** Admits one operator task diagnostic and waits for its terminal result. */
async function runTask(name: string, spec: Json, opts: { maintain?: boolean; timeoutMs?: number; during?: (from: number) => Promise<void> } = {}): Promise<Trial> {
  const from = chunkbot.length;
  chunkbot.send(`/task ${opts.maintain ? 'maintain ' : ''}${JSON.stringify(spec)}`);
  const admitted = await waitTaskJson('task_admitted', from, 10_000);
  if (opts.during) await opts.during(from);
  const terminal = await waitTaskJson('task_terminal', from, opts.timeoutMs ?? 240_000, admitted.goalId as string);
  const goalLine = await chunkbot.waitSince(new RegExp(`Goal ${admitted.goalId} (completed|blocked|failed|cancelled) \\(`), from, 15_000);
  await sleep(150);
  const events = taskJsonSince(from);
  return { name, goalId: admitted.goalId as string, terminal, goalLine, events, decisions: linkDecisions(events) };
}

/** Joins request/candidate/choice/model/cost with the executed action and its verified result. */
function linkDecisions(events: Json[]): Json[] {
  const run = runEvents();
  const out: Json[] = [];
  for (const round of events.filter((e) => e.kind === 'task_round')) {
    const choice = events.find((e) => e.kind === 'task_choice' && e.requestId === round.requestId);
    const action = events.find((e) => e.kind === 'task_action' && e.requestId === round.requestId);
    const stale = events.find((e) => e.kind === 'task_choice_stale' && e.requestId === round.requestId);
    const failed = events.find((e) => e.kind === 'task_decision_failed' && e.requestId === round.requestId);
    const responses = run.filter((e) => e.type === 'jev_response' && e.requestId === round.requestId);
    const requests = run.filter((e) => e.type === 'jev_request' && e.requestId === round.requestId);
    out.push({
      requestId: round.requestId,
      snapshotId: round.snapshotId,
      offered: (round.offered as Json[]).map((o) => `${o.id} ${o.capability}: ${o.description}`),
      attempts: requests.length,
      requestBytes: requests[0]?.requestBytes ?? null,
      reservationUsd: requests[0]?.reservationUsd ?? null,
      choice: choice ? { candidateId: choice.candidateId, capability: choice.capability, description: choice.description, confidence: choice.confidence, probabilities: choice.probabilities } : null,
      model: responses.at(-1)?.model ?? null,
      provider: responses.at(-1)?.provider ?? null,
      generationId: responses.at(-1)?.generationId ?? null,
      usage: responses.at(-1)?.usage ?? null,
      latencyMs: responses.at(-1)?.latencyMs ?? null,
      action: action ? { actionId: action.actionId, capability: action.capability, status: action.status, reason: action.reason ?? null, confirmation: action.confirmation, effect: action.effect } : null,
      stale: stale ? stale.reasons : null,
      decisionFailure: failed ? `${failed.kind}: ${failed.detail}` : null,
    });
  }
  for (const c of events.filter((e) => e.kind === 'task_local_continuation')) {
    const action = events.find((e) => e.kind === 'task_action' && e.actionId === c.actionId);
    out.push({ localContinuation: true, continues: c.continues, action: action ? { actionId: action.actionId, capability: action.capability, status: action.status, reason: action.reason ?? null, confirmation: action.confirmation, effect: action.effect } : null });
  }
  return out;
}

function summarize(t: Trial, ev: string[], trials: Json[]): void {
  const completion = t.events.filter((e) => e.kind === 'task_completion').at(-1);
  ev.push(`${t.name}: ${t.goalLine.replace(/^\[chunkbot\] /, '').slice(0, 260)}`);
  ev.push(`  rounds=${t.terminal.rounds} jevDecisions=${t.terminal.decisions} actions=${t.terminal.actions} localContinuations=${t.terminal.localContinuations}; last completion: ${completion?.status} (${String(completion?.detail ?? '').slice(0, 140)})`);
  for (const d of t.decisions) {
    if (d.localContinuation) ev.push(`  local continuation of ${d.continues}: ${d.action?.capability} -> ${d.action?.status}${d.action?.reason ? ` (${d.action.reason})` : ''}`);
    else ev.push(`  ${d.requestId}: ${d.offered.length} options -> ${d.choice ? `${d.choice.capability} "${String(d.choice.description).slice(0, 80)}" p=${Number(d.choice.probabilities?.[d.choice.candidateId] ?? 0).toFixed(2)} conf=${d.choice.confidence}` : 'no choice'} | model=${d.model} provider=${d.provider} cost=${d.usage?.costUsd ?? '?'} in=${d.usage?.inputTokens ?? '?'} ${d.latencyMs}ms | ${d.action ? `${d.action.status}${d.action.reason ? `(${d.action.reason})` : ''} [${d.action.confirmation}]` : d.stale ? `stale: ${JSON.stringify(d.stale).slice(0, 100)}` : d.decisionFailure ?? 'no action'}`);
  }
  trials.push({ name: t.name, goalId: t.goalId, goalLine: t.goalLine, terminal: t.terminal, decisions: t.decisions });
}

/** Every Jev-executed action must follow a validated choice of the same candidate from the configured model. */
function assertLinked(t: Trial): void {
  for (const d of t.decisions.filter((x) => !x.localContinuation && x.action)) {
    assert(d.choice && d.choice.candidateId === d.action.actionId, `action ${d.action.actionId} was not the validated choice of ${d.requestId}`);
    assert(/^typesafe\/jev-1\.13(-\d{8})?$/.test(String(d.model)), `unexpected response model ${d.model}`);
    assert(d.provider === 'TypeSafe', `unexpected provider ${d.provider}`);
    assert(typeof d.usage?.costUsd === 'number', 'usage/cost recorded');
  }
}

const reg = (key: string) => ({ kind: 'registry', key });

async function resetScene(): Promise<void> {
  for (const c of sceneClearCommands()) await setup(c);
  await sleep(1_600);
  for (const c of sceneCommands()) await setup(c);
  await sleep(1_500);
}

async function fixtureBot(username: string): Promise<Bot> {
  const bot = mineflayer.createBot({ host: FIXTURE_PINS.host, port: FIXTURE_PINS.port, username, auth: 'offline', version: FIXTURE_PINS.minecraftVersion, hideErrors: true });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${username} did not spawn`)), 20_000);
    bot.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once('end', (reason: string) => reject(new Error(`${username} ended: ${reason}`)));
  });
  return bot;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  process.stdout.write(`jev-live-check (${mode} provider): fixture ${FIXTURE_PINS.host}:${FIXTURE_PINS.port}; report dir ${outDir}\n`);
  const base = JSON.parse(readFileSync(BASE_CONFIG, 'utf8')) as Json;
  const keyEnv = String(base.models?.decision?.apiKeyEnv ?? 'OPENROUTER_API_KEY');
  let configPath = BASE_CONFIG;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (mode === 'real') {
    if (!process.env[keyEnv]) {
      process.stderr.write(`jev-live-check: ${keyEnv} is not set. Run with the key injected by the operator's credential helper, or use --provider fault for harness validation only.\n`);
      process.exitCode = 2;
      return;
    }
  } else {
    const endpoint = await startFaultProvider();
    const cfg = { ...base, storage: { ...base.storage, dataDir: join(PROJECT_ROOT, 'var') }, models: { ...base.models, decision: { ...base.models.decision, endpoint } } };
    configPath = join(outDir, 'fixture-fault-provider.json');
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
    env[keyEnv] = 'fault-fixture-placeholder-key';
  }
  const list = await rconRaw('list').catch((error: unknown) => {
    throw new Error(`fixture not reachable over RCON (${String(error)}); run npm run fixture -- start`);
  });
  process.stdout.write(`fixture: ${list}\n`);
  const fixturePid = Number(readFileSync(fx.pidFile, 'utf8').trim());

  // The key (real mode) reaches the CLI only through the inherited environment.
  chunkbot = new CliProcess(`run-jev-${mode}`, ['run', '--config', configPath], env);
  let owner: Bot | undefined;
  try {
    await check('J0', 'built CLI joins; decision adapter ready (route/model/price ceiling); natural-language goals still planner_not_ready', async (ev) => {
      ev.push(await chunkbot.waitFor(/\[chunkbot\] decision: /, 30_000));
      const runLine = await chunkbot.waitFor(/\[chunkbot\] run \S+; evidence: /, 10_000);
      runEventsPath = /evidence: (\S+)$/.exec(runLine)?.[1] ?? '';
      ev.push(await chunkbot.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), 30_000));
      chunkbot.send('status');
      ev.push(await chunkbot.waitFor(/\[status\] decision: ready/, 10_000));
      await resetScene();
      ev.push(`scene reset with ${setupLog.length} recorded RCON setup commands`);
    });

    // ------------------------------------------------------------ movement
    await check('J1', 'movement task: Jev chooses among move/explore options; near_target verified; RCON position near the chest', async (ev, trials) => {
      await setup('tp Chunkbot 214.5 -60 196.5 0 0');
      await sleep(1_000);
      const t = await runTask('move to the visible chest', {
        objective: 'Walk over to the chest you can see.',
        decisionInstruction: 'Choose the option that brings you next to the visible chest; avoid wandering elsewhere.',
        allowedCapabilities: ['move_near', 'explore_frontier'],
        targetSelectors: [reg('minecraft:chest')],
        completion: { predicate: 'near_target', target: reg('minecraft:chest'), within: 3 },
      });
      summarize(t, ev, trials);
      assertLinked(t);
      assert(t.terminal.status === 'completed', `task ${t.terminal.status} (${t.terminal.reason})`);
      assert(t.terminal.decisions >= 1, 'at least one real Jev decision');
      const p = await serverPos();
      const d = Math.hypot(p.x - (SCENE.chest.x + 0.5), p.z - (SCENE.chest.z + 0.5));
      ev.push(`RCON: Chunkbot at ${p.x.toFixed(2)},${p.z.toFixed(2)}, ${d.toFixed(2)} from the chest centre`);
      assert(d <= 3.6, 'server position is near the chest');
    });

    // ------------------------------------------------------------ mining by hand
    const invBefore = await serverInventory();
    await check('J2', 'mining task: Jev drives mine/move/pickup over several rounds; inventory_delta verified; RCON 3 oak logs and air', async (ev, trials) => {
      ev.push(`RCON inventory before: ${JSON.stringify(invBefore)}`);
      await setup(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
      await sleep(1_000);
      const t = await runTask('collect three oak logs', {
        objective: 'Collect three oak logs from the visible tree.',
        decisionInstruction: 'Mine visible logs, moving closer first when they are out of reach, and pick up dropped logs.',
        allowedCapabilities: ['mine_block', 'move_near', 'pickup_item'],
        targetSelectors: [reg('#minecraft:logs')],
        completion: { predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: 3, mayBeConsumedLater: true },
      });
      summarize(t, ev, trials);
      assertLinked(t);
      assert(t.terminal.status === 'completed', `task ${t.terminal.status} (${t.terminal.reason})`);
      const inv = await serverInventory();
      ev.push(`RCON inventory after: ${JSON.stringify(inv)}`);
      assert((inv['minecraft:oak_log'] ?? 0) >= 3, 'server holds at least 3 oak logs');
      for (const l of SCENE.logs) assert(await blockIs(l.x, l.y, l.z, 'air'), `log at ${l.x},${l.y},${l.z} is air`);
      assert(t.decisions.some((d) => d.action?.capability === 'mine_block' && d.action.confirmation === 'server_packet'), 'server-confirmed mining by a Jev choice');
    });

    // ------------------------------------------------------------ planner feedback: missing tool
    await check('J3', 'missing tool: cobblestone task without a pickaxe blocks with structured harvest-tool evidence; no Jev call; stone intact', async (ev, trials) => {
      await setup('tp Chunkbot 203.5 -60 203.5 0 0');
      await sleep(1_000);
      const t = await runTask('collect cobblestone without a pickaxe', {
        objective: 'Collect two cobblestone.',
        decisionInstruction: 'Mine visible stone.',
        allowedCapabilities: ['mine_block'],
        completion: { predicate: 'inventory_delta', selector: 'minecraft:cobblestone', atLeast: 2, mayBeConsumedLater: false },
      });
      summarize(t, ev, trials);
      ev.push(`feedback.unavailable: ${JSON.stringify(t.terminal.feedback?.unavailable ?? []).slice(0, 400)}`);
      assert(t.terminal.status === 'blocked' && t.terminal.reason === 'no_candidates', `expected blocked/no_candidates, got ${t.terminal.status}/${t.terminal.reason}`);
      assert((t.terminal.feedback?.unavailable as Json[]).some((u) => u.reason === 'harvest_tool_missing'), 'harvest_tool_missing evidence');
      assert(t.terminal.decisions === 0, 'no inference without options');
      assert(/blocked \(cannot_execute\)/.test(t.goalLine), 'goal blocked cannot_execute');
      assert(await blockIs(SCENE.stone[0].x, SCENE.stone[0].y, SCENE.stone[0].z, 'stone'), 'stone intact');
    });

    // ------------------------------------------------------------ crafting (inventory grid)
    await check('J4', 'crafting tasks: planks, a crafting table and sticks through Jev-chosen craft_item candidates; crafting_result verified; RCON inventory', async (ev, trials) => {
      for (const [name, output, n] of [
        ['craft twelve planks', 'minecraft:oak_planks', 12],
        ['craft a crafting table', 'minecraft:crafting_table', 1],
        ['craft four sticks', 'minecraft:stick', 4],
      ] as const) {
        const t = await runTask(name, {
          objective: `Craft ${n} ${output.replace('minecraft:', '').replace('_', ' ')}.`,
          decisionInstruction: 'Craft the requested item from what is in the inventory.',
          allowedCapabilities: ['craft_item'],
          completion: { predicate: 'crafting_result', output, atLeast: n },
        });
        summarize(t, ev, trials);
        assertLinked(t);
        assert(t.terminal.status === 'completed', `${name}: ${t.terminal.status} (${t.terminal.reason}) ${t.terminal.detail}`);
      }
      const inv = await serverInventory();
      ev.push(`RCON inventory: ${JSON.stringify(inv)}`);
      assert((inv['minecraft:crafting_table'] ?? 0) === 1 && (inv['minecraft:stick'] ?? 0) >= 4, 'table and sticks in the server inventory');
    });

    // ------------------------------------------------------------ planner feedback: missing workstation
    await check('J5', 'missing workstation: a wooden pickaxe task with ingredients but no placed table blocks with workstation_required; no Jev call', async (ev, trials) => {
      const t = await runTask('craft a pickaxe without a placed table', {
        objective: 'Craft a wooden pickaxe.',
        decisionInstruction: 'Craft it.',
        allowedCapabilities: ['craft_item'],
        completion: { predicate: 'crafting_result', output: 'minecraft:wooden_pickaxe', atLeast: 1 },
      });
      summarize(t, ev, trials);
      ev.push(`feedback.unavailable: ${JSON.stringify(t.terminal.feedback?.unavailable ?? []).slice(0, 300)}`);
      assert(t.terminal.reason === 'no_candidates', `got ${t.terminal.reason}`);
      assert((t.terminal.feedback?.unavailable as Json[]).some((u) => u.reason === 'workstation_required'), 'workstation_required evidence');
      assert(t.terminal.decisions === 0, 'no inference without options');
    });

    // ------------------------------------------------------------ interaction: place + 3x3 table crafting
    await check('J6', 'interaction: place the crafting table (Jev picks a generated site), then craft a wooden pickaxe at it; block_state + crafting_result verified; RCON', async (ev, trials) => {
      const place = await runTask('place the crafting table', {
        objective: 'Place the crafting table on the ground near you.',
        decisionInstruction: 'Choose a placement site for the crafting table close to you.',
        allowedCapabilities: ['place_block'],
        targetSelectors: [reg('minecraft:crafting_table')],
        completion: { predicate: 'block_state', target: reg('minecraft:crafting_table'), expect: 'minecraft:crafting_table' },
      });
      summarize(place, ev, trials);
      assertLinked(place);
      assert(place.terminal.status === 'completed', `place: ${place.terminal.status} (${place.terminal.reason}) ${place.terminal.detail}`);
      const placedAction = place.events.filter((e) => e.kind === 'task_action' && e.capability === 'place_block' && e.status === 'succeeded').at(-1);
      const at = placedAction?.evidence?.at as Json | undefined;
      assert(at, 'placement evidence position');
      assert(await blockIs(at.x, at.y, at.z, 'crafting_table'), `RCON: crafting_table at ${at.x},${at.y},${at.z}`);
      ev.push(`RCON: crafting_table at ${at.x},${at.y},${at.z}`);
      const craft = await runTask('craft a wooden pickaxe at the table', {
        objective: 'Craft a wooden pickaxe at the placed crafting table.',
        decisionInstruction: 'Craft the pickaxe using the crafting table; approach it first if it is out of reach.',
        allowedCapabilities: ['craft_item', 'move_near'],
        targetSelectors: [reg('minecraft:crafting_table')],
        completion: { predicate: 'crafting_result', output: 'minecraft:wooden_pickaxe', atLeast: 1 },
      });
      summarize(craft, ev, trials);
      assertLinked(craft);
      assert(craft.terminal.status === 'completed', `craft: ${craft.terminal.status} (${craft.terminal.reason}) ${craft.terminal.detail}`);
      const inv = await serverInventory();
      ev.push(`RCON inventory: ${JSON.stringify(inv)}`);
      assert((inv['minecraft:wooden_pickaxe'] ?? 0) === 1, 'server holds the pickaxe');
    });

    // ------------------------------------------------------------ mining with a tool (mechanically different)
    await check('J7', 'tool mining task: cobblestone with the crafted pickaxe through Jev choices; RCON cobblestone and stone removed', async (ev, trials) => {
      // Setup: an unobstructed stone pair of its own, so the result does not depend on where J6 placed the table.
      await setup('setblock 211 -60 196 stone');
      await setup('setblock 212 -60 196 stone');
      await setup('tp Chunkbot 211.5 -60 198.5 0 0');
      await sleep(1_000);
      const t = await runTask('collect two cobblestone with the pickaxe', {
        objective: 'Collect two cobblestone using the wooden pickaxe.',
        decisionInstruction: 'Equip the pickaxe if needed, mine visible stone (approach first if out of reach) and pick up the cobblestone.',
        allowedCapabilities: ['mine_block', 'move_near', 'pickup_item', 'equip_item'],
        targetSelectors: [reg('minecraft:stone'), reg('minecraft:wooden_pickaxe')],
        completion: { predicate: 'inventory_delta', selector: 'minecraft:cobblestone', atLeast: 2, mayBeConsumedLater: false },
      });
      summarize(t, ev, trials);
      assertLinked(t);
      assert(t.terminal.status === 'completed', `task ${t.terminal.status} (${t.terminal.reason}) ${t.terminal.detail}`);
      const inv = await serverInventory();
      ev.push(`RCON inventory: ${JSON.stringify(inv)}`);
      assert((inv['minecraft:cobblestone'] ?? 0) >= 2 && !inv['minecraft:stone'], 'server: cobblestone (not stone items)');
      const mined = t.decisions.filter((d) => d.action?.capability === 'mine_block' && d.action.confirmation === 'server_packet').length;
      ev.push(`server-confirmed stone breaks by Jev choices: ${mined}`);
    });

    // ------------------------------------------------------------ planner feedback: missing target
    await check('J8', 'missing target: the walled-in diamond ore is not a candidate; the task blocks with no-visible-target evidence; no hidden data in feedback', async (ev, trials) => {
      await setup(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
      await sleep(1_000);
      const t = await runTask('mine the hidden diamond ore', {
        objective: 'Mine the diamond ore.',
        decisionInstruction: 'Mine the diamond ore if you can see it.',
        allowedCapabilities: ['mine_block', 'move_near'],
        targetSelectors: [reg('minecraft:diamond_ore')],
        completion: { predicate: 'inventory_delta', selector: 'minecraft:diamond', atLeast: 1, mayBeConsumedLater: false },
      });
      summarize(t, ev, trials);
      const fb = JSON.stringify(t.terminal.feedback ?? {});
      ev.push(`feedback: ${fb.slice(0, 400)}`);
      assert(t.terminal.reason === 'no_candidates', `got ${t.terminal.reason}`);
      assert(!fb.includes(`${SCENE.hiddenOre.x},${SCENE.hiddenOre.y},${SCENE.hiddenOre.z}`) && !/"x":205,"y":-60,"z":214/.test(fb), 'hidden ore position never reported');
      assert(t.terminal.decisions === 0, 'no inference without options');
    });

    // ------------------------------------------------------------ stop during an in-flight decision
    await check('J9', 'stop while a Jev request is in flight: provider I/O aborted or reply discarded; no action; goal cancelled', async (ev, trials) => {
      const from = chunkbot.length;
      chunkbot.send(`/task ${JSON.stringify({ objective: 'Walk to the point 214 -60 214.', decisionInstruction: 'Move toward the destination.', allowedCapabilities: ['move_near'], targetSelectors: [{ kind: 'owner_destination', dimension: 'overworld', at: { x: 214.5, y: -60, z: 214.5 }, ownerText: '214 -60 214' }], completion: { predicate: 'near_target', target: { kind: 'owner_destination', dimension: 'overworld', at: { x: 214.5, y: -60, z: 214.5 }, ownerText: '214 -60 214' }, within: 2 } })}`);
      const round = await waitTaskJson('task_round', from, 30_000);
      const sentAt = chunkbot.send('stop');
      const line = await chunkbot.waitSince(/Goal goal-\S+ cancelled \(owner_stop\)/, from, 10_000);
      const stopLatency = (chunkbot.lines.find((l) => l.text === line)?.atMs ?? Date.now()) - sentAt;
      await sleep(2_500); // a late provider reply would have arrived by now
      const events = taskJsonSince(from);
      const run = runEvents().filter((e) => e.requestId === round.requestId);
      ev.push(`stop -> goal cancelled in ${stopLatency}ms; request ${round.requestId}: ${run.map((e) => `${e.type}${e.kind ? `:${e.kind}` : ''}`).join(', ')}`);
      ev.push(`task events after stop: ${events.map((e) => e.kind).join(', ')}`);
      trials.push({ name: 'stop during decision', requestId: round.requestId, stopLatencyMs: stopLatency, runEvents: run.map((e) => ({ type: e.type, kind: e.kind ?? null })), taskEvents: events.map((e) => e.kind) });
      assert(!events.some((e) => e.kind === 'task_action'), 'no action after stop');
      assert(events.some((e) => e.kind === 'task_terminal' && e.status === 'cancelled'), 'task cancelled');
      assert(stopLatency < 1_000, 'stop did not wait for the provider');
    });

    // ------------------------------------------------------------ persistent follow + replacement
    await check('J10', 'persistent follow (maintain): one Jev decision, healthy windows continue locally while the owner moves; replacement then takes over with a fresh anchor', async (ev, trials) => {
      owner = await fixtureBot('FixtureOwner');
      // Owner starts just outside the kept range (5): the violation triggers the first decision.
      await setup('tp FixtureOwner 214.5 -60 199.5 0 0');
      await setup('tp Chunkbot 207.5 -60 199.5 0 0');
      await sleep(1_500);
      const requestsBefore = runEvents().filter((e) => e.type === 'jev_request').length;
      const from = chunkbot.length;
      chunkbot.send(`/task maintain ${JSON.stringify({ objective: 'Stay near the owner and follow them while they walk around.', decisionInstruction: 'Follow the visible owner.', allowedCapabilities: ['follow_entity'], targetSelectors: [{ kind: 'owner' }], parameters: { within: 3, durationMs: 12_000 }, completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 5 } })}`);
      const admitted = await waitTaskJson('task_admitted', from, 10_000);
      await waitTaskJson('task_choice', from, 30_000); // the one decision for the violated condition
      // In-trial interventions: the owner walks (teleports in small steps) inside the travel bounds.
      const path = [[211.5, 201.5], [213.5, 203.5], [213.5, 206.5], [211.5, 208.5], [209.5, 206.5], [209.5, 203.5], [211.5, 201.5], [213.5, 199.5]];
      for (const [x, z] of path) {
        await intervene(`tp FixtureOwner ${x} -60 ${z}`, 'owner moves during the persistent follow');
        await sleep(4_000);
      }
      const mid = taskJsonSince(from);
      const continuations = mid.filter((e) => e.kind === 'task_local_continuation').length;
      const decisionsDuring = runEvents().filter((e) => e.type === 'jev_request').length - requestsBefore;
      const ownerPos = await serverPos('FixtureOwner');
      const chunkbotPos = await serverPos();
      ev.push(`~${Math.round((Date.now() - (chunkbot.lines[from]?.atMs ?? Date.now())) / 1000)}s of following: Jev requests=${decisionsDuring}, local continuations=${continuations}; RCON Chunkbot ${chunkbotPos.x.toFixed(1)},${chunkbotPos.z.toFixed(1)} owner ${ownerPos.x.toFixed(1)},${ownerPos.z.toFixed(1)} (distance ${Math.hypot(chunkbotPos.x - ownerPos.x, chunkbotPos.z - ownerPos.z).toFixed(1)})`);
      assert(decisionsDuring <= 2, `stable following must not poll Jev (saw ${decisionsDuring} requests)`);
      assert(continuations >= 2, 'healthy windows continued locally');
      assert(!mid.some((e) => e.kind === 'task_terminal'), 'no false no-progress/owner-loss escalation while following');
      // Replacement by a new operator task: old goal cancelled (replaced) first, new anchor at the actual position.
      const repFrom = chunkbot.length;
      chunkbot.send(`/task ${JSON.stringify({ objective: 'Walk over to the chest you can see.', decisionInstruction: 'Move next to the chest.', allowedCapabilities: ['move_near'], targetSelectors: [reg('minecraft:chest')], completion: { predicate: 'near_target', target: reg('minecraft:chest'), within: 3 } })}`);
      const replacedLine = await chunkbot.waitSince(new RegExp(`Goal ${admitted.goalId} cancelled \\(replaced\\)`), repFrom, 15_000);
      ev.push(replacedLine);
      const repAdmitted = await waitTaskJson('task_admitted', repFrom, 10_000);
      const repTerminal = await waitTaskJson('task_terminal', repFrom, 120_000, repAdmitted.goalId as string);
      const anchors = runEvents().filter((e) => e.type === 'goal_travel_anchor');
      const a1 = anchors.find((e) => e.goalId === admitted.goalId)?.anchor;
      const a2 = anchors.find((e) => e.goalId === repAdmitted.goalId)?.anchor;
      ev.push(`anchors: follow goal ${JSON.stringify(a1)}; replacement ${JSON.stringify(a2)}; replacement task ${repTerminal.status} (${repTerminal.reason})`);
      const followEvents = taskJsonSince(from).filter((e) => e.taskId === mid.find((m) => m.kind === 'task_started')?.taskId);
      trials.push({ name: 'persistent follow', goalId: admitted.goalId, jevRequests: decisionsDuring, localContinuations: continuations, decisions: linkDecisions(followEvents), replacement: { goalId: repAdmitted.goalId, terminal: repTerminal, anchors: { follow: a1, replacement: a2 } } });
      assert(a1 && a2 && (a1.x !== a2.x || a1.z !== a2.z), 'the replacement captured its own admission anchor');
    });

    // ------------------------------------------------------------ natural-language intake unchanged; idle silence
    await check('J11', 'normal natural-language intake still ends planner_not_ready with no Jev call; idle makes no calls', async (ev) => {
      const before = runEvents().filter((e) => e.type === 'jev_request').length;
      const from = chunkbot.length;
      if (owner) owner.chat('!chunkbot walk over to the chest');
      else chunkbot.send('walk over to the chest');
      ev.push(await chunkbot.waitSince(/blocked \(planner_not_ready\)/, from, 10_000));
      await sleep(10_000);
      const after = runEvents().filter((e) => e.type === 'jev_request').length;
      ev.push(`Jev requests during natural-language intake + 10s idle: ${after - before}`);
      assert(after === before, 'no inference while idle or for planner-not-ready goals');
    });
  } finally {
    try {
      owner?.quit();
    } catch {
      // ignore
    }
    chunkbot.send('/quit');
    const exited = await Promise.race([chunkbot.exited, sleep(10_000).then(() => undefined)]);
    if (!exited) chunkbot.child.kill('SIGKILL');
    chunkbot.save(outDir);
    faultServer?.close();
    const run = runEvents();
    const responses = run.filter((e) => e.type === 'jev_response');
    const requests = run.filter((e) => e.type === 'jev_request');
    const spend = responses.at(-1)?.spend ?? run.filter((e) => e.type === 'jev_failure').at(-1)?.spend ?? null;
    const passed = results.filter((r) => r.pass).length;
    const report = {
      kind: 'mb-v1-03-jev-live-check',
      providerMode: mode,
      acceptanceEvidence: mode === 'real' ? 'real OpenRouter Jev decisions' : 'FAULT FIXTURE provider (first option); harness validation only, NOT Jev acceptance',
      startedAt: stamp,
      fixture: { host: FIXTURE_PINS.host, port: FIXTURE_PINS.port, version: FIXTURE_PINS.minecraftVersion, pid: fixturePid },
      cli: { pid: chunkbot.pid, exit: exited ?? 'killed', config: configPath, runEvents: runEventsPath },
      provider: {
        requests: requests.length,
        responses: responses.length,
        models: [...new Set(responses.map((r) => r.model))],
        providers: [...new Set(responses.map((r) => r.provider))],
        latencyMs: responses.map((r) => r.latencyMs),
        totalReportedCostUsd: responses.reduce((n, r) => n + Number(r.usage?.costUsd ?? 0), 0),
        failures: run.filter((e) => e.type === 'jev_failure').map((e) => ({ requestId: e.requestId, kind: e.kind, detail: e.detail })),
        spend,
      },
      passed,
      total: results.length,
      results,
      setupCommands: setupLog,
      inTrialInterventions: interventions,
    };
    writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\n${passed}/${results.length} Jev controller scenarios passed (${mode} provider); report ${join(outDir, 'report.json')}\n`);
    process.exitCode = passed === results.length ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`jev-live-check error: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
