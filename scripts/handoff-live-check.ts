// MB-FLOW-002 smooth-handoff live check against a LOCAL TEST FIXTURE.
//
// Drives the REAL built CLI (`node dist/cli.js run`) through normal owner chat
// intake with:
//   * the PLANNER FAULT FIXTURE (scripts/lib/fault-codex.ts) replaying scripted,
//     optionally DELAYED planner turns (the real installed CLI still answers the
//     read-only isolation-gate commands: --version, debug models --bundled,
//     features list; `login status` is scripted as the managed ChatGPT mode),
//   * a LOOPBACK Jev fault provider (first unrepeated option),
// so it is HARNESS VALIDATION of handoff behavior, never planner/Jev quality
// acceptance. World truth comes from RCON (positions, inventory) and the run
// evidence (task/lease/handoff events, planner process cleanup).
//
// Scenarios (each records timestamps and evidence in report.json):
//   L1 H1/H2  follow continues (server-confirmed movement) while a >= 3 s delayed
//             preparation runs; ack/draft/switch/first-task timeline; old result fenced
//   L2 H3     inventory gained by the old task during preparation is in the REAL
//             admission baseline; the new outcome is bound to it
//   L3 H4     superseding instructions: A and B killed mid-turn, then C and D
//             back-to-back; only D admitted; one planner process; killed planner
//             process groups cleaned; spoofed system/console lines ignored
//   L4 H5     stop during preparation: controls cleared <= 250 ms, both contexts
//             cancelled, pause latch set and shown, explicit resume
//   L5 H5     lifecycle (death) during preparation invalidates both contexts
//   L6 H6     quota before admission keeps following; a LEGACY clarification
//             (MB-PLAN-006) is a counted preparation repair: no question/answer
//             prompt, the old task continues, the repaired draft hands off
//   L7 H7     window lookahead vs no lookahead: measured window gap (two finite windows)
//
// Requires an exclusive coordinator lease on the fixture (scene reset in
// x 196..224, z 190..224). Usage:
//   npm run build && npm run fixture -- status && npm run handoff-live-check [-- --only L1,L4] [--fixture 26.2]
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';
import { CliProcess } from './lib/cli-process.ts';
import { rconCommand } from './lib/rcon.ts';
import { SCENE, sceneClearCommands, sceneCommands } from './lib/scene.ts';
import { setFaultTurns, writeFaultCodex, type FaultTurn } from './lib/fault-codex.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Bot = ReturnType<typeof mineflayer.createBot>;

const FIXTURE_PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const FIXTURE_SUFFIX = FIXTURE_PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${FIXTURE_PINS.profile}`;
const FIXTURE_VERSION_RE = FIXTURE_PINS.minecraftVersion.replace(/\./g, '\\.');
const argv = process.argv;
const only = argv.includes('--only') ? new Set((argv[argv.indexOf('--only') + 1] ?? '').split(',')) : undefined;
const fx = fixturePaths(PROJECT_ROOT, FIXTURE_PINS);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${FIXTURE_SUFFIX}-handoff`);
mkdirSync(outDir, { recursive: true });
const BASE_CONFIG = join(PROJECT_ROOT, FIXTURE_PINS.config);
const REAL_CODEX = '/opt/homebrew/bin/codex';
const STOP_TARGET_MS = 250;
const PREP_DELAY_MS = 3_500;

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
async function setup(command: string): Promise<string> {
  const reply = await rconRaw(command);
  setupLog.push({ atMs: Date.now(), scenario: currentScenario, command, reply: reply.slice(0, 200) });
  return reply;
}
/** Scripted owner behavior during a trial (the owner walking), recorded separately from setup. */
async function ownerAction(command: string, why: string): Promise<string> {
  const reply = await rconRaw(command);
  interventions.push({ atMs: Date.now(), scenario: currentScenario, command, reply: reply.slice(0, 200), why });
  return reply;
}
async function serverPos(name = 'Chunkbot'): Promise<{ x: number; y: number; z: number }> {
  const r = await rconRaw(`data get entity ${name} Pos`);
  const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(r);
  if (!m) throw new Error(`cannot read position of ${name}: ${r.slice(0, 120)}`);
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
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const tOf = (e: Json) => Date.parse(String(e.t));

/** Connection loss is recorded (with its reason) and the CLI rejoins before the next scenario. */
const connectionLosses: Array<{ atMs: number; scenario: string; line: string }> = [];
let connectionCursor = 0;
async function ensureConnected(): Promise<void> {
  if (!chunkbot) return;
  const lines = chunkbot.lines.slice(connectionCursor);
  connectionCursor = chunkbot.lines.length;
  const lost = lines.filter((l) => /\[chunkbot\] connection ended \(/.test(l.text));
  for (const l of lost) connectionLosses.push({ atMs: l.atMs, scenario: currentScenario, line: l.text });
  const lastEnd = chunkbot.lines.map((l) => l.text).findLastIndex((t) => /\[chunkbot\] connection ended \(/.test(t));
  const lastReady = chunkbot.lines.map((l) => l.text).findLastIndex((t) => /\[chunkbot\] ready: version=/.test(t));
  if (lastEnd > lastReady) {
    const from = chunkbot.length;
    chunkbot.send('/reconnect');
    await chunkbot.waitSince(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), from, 40_000);
    connectionCursor = chunkbot.lines.length;
  }
}

async function check(id: string, title: string, fn: (ev: string[], trials: Json[]) => Promise<void>): Promise<void> {
  if (only && !only.has(id)) return;
  await ensureConnected();
  currentScenario = id;
  const evidence: string[] = [];
  const trials: Json[] = [];
  const started = Date.now();
  process.stdout.write(`RUN  ${id} ${title}\n`);
  try {
    await fn(evidence, trials);
    results.push({ id, title, pass: true, evidence, trials });
    process.stdout.write(`PASS ${id} (${Math.round((Date.now() - started) / 1000)}s)\n`);
  } catch (error) {
    evidence.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    const lost = chunkbot?.lines.filter((l) => l.atMs >= started && /\[chunkbot\] connection ended \(/.test(l.text)) ?? [];
    if (lost.length) evidence.push(`connection lost during the scenario: ${lost.map((l) => l.text).join(' | ')} (check the fixture server log for a foreign login under the same name)`);
    results.push({ id, title, pass: false, evidence, trials });
    process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)?.slice(0, 800)}\n`);
  }
  for (const line of evidence.slice(0, 60)) process.stdout.write(`     ${line.slice(0, 300)}\n`);
}

// ---------------------------------------------------------------- loopback Jev fault provider

let jevServer: Server | undefined;
const jevRecent: string[] = [];
async function startJevFault(): Promise<string> {
  jevServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const parsed = JSON.parse(body) as Json;
      const criteria = parsed.questions.next_action.criteria as Record<string, string>;
      const all = Object.keys(criteria);
      const pick = all.find((k) => !jevRecent.includes(criteria[k] ?? '')) ?? all[0]!;
      jevRecent.push(criteria[pick] ?? '');
      if (jevRecent.length > 3) jevRecent.shift();
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
  await new Promise<void>((r) => jevServer!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(jevServer.address() as AddressInfo).port}/api/alpha/decisions`;
}

// ---------------------------------------------------------------- planner fault proposals (wire format)

function wp(p: Json): Json {
  const base: Json = { predicate: null, selector: null, atLeast: null, mode: null, mayBeConsumedLater: null, slot: null, target: null, within: null, expect: null, output: null, outcome: null, of: null };
  return { ...base, ...p };
}
function wt(t: Json): Json {
  const base: Json = { kind: null, key: null, snapshotId: null, handle: null, anchorId: null, dimension: null, at: null, ownerText: null, actionId: null };
  return { ...base, ...t };
}
const NEAR_OWNER = () => wp({ predicate: 'near_target', target: wt({ kind: 'owner' }), within: 3 });
const LOGS = (atLeast: number, mode: 'collect_additional' | 'possess' = 'collect_additional') => wp({ predicate: 'inventory_amount', selector: '#minecraft:logs', atLeast, mode });
function proposal(p: Json): Json {
  return { disposition: 'plan', interpretation: 'fixture plan', outcome: null, tasks: [], morePlanningNeeded: false, queries: [], question: null, missing: null, missingCapabilities: [], verifiedProgress: null, ...p };
}
const followMe = () =>
  proposal({
    interpretation: 'Stay near the owner while they move.',
    outcome: { kind: 'persistent', predicate: NEAR_OWNER() },
    tasks: [{ objective: 'Stay near the owner.', decisionInstruction: 'Follow the owner.', allowedCapabilities: ['follow_entity', 'move_near'], targetSelectors: [wt({ kind: 'owner' })], parameters: [], completion: NEAR_OWNER() }],
  });
const comeHere = (label: string) =>
  proposal({
    interpretation: `Walk to the owner (${label}).`,
    outcome: { kind: 'finite', predicate: NEAR_OWNER() },
    tasks: [{ objective: `Walk to the owner (${label}).`, decisionInstruction: 'Move next to the owner.', allowedCapabilities: ['move_near'], targetSelectors: [wt({ kind: 'owner' })], parameters: [], completion: NEAR_OWNER() }],
  });
const logTask = (objective: string, n: number) => ({
  objective,
  decisionInstruction: 'Mine a visible oak log, then pick up its drop.',
  allowedCapabilities: ['move_near', 'mine_block', 'pickup_item'],
  targetSelectors: [wt({ kind: 'registry', key: '#minecraft:logs' })],
  parameters: [],
  completion: wp({ predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: n, mayBeConsumedLater: false }),
});
const collectLogs = (total: number, windowLogs: number, more: boolean, interpretation: string) =>
  proposal({ interpretation, outcome: { kind: 'finite', predicate: LOGS(total) }, tasks: [logTask(`Collect ${windowLogs} oak log(s).`, windowLogs)], morePlanningNeeded: more });
/** A LEGACY (pre-MB-PLAN-006) owner question from the scripted planner; code must refuse it (counted repair), never relay it. */
const clarifyTurn = (question: string) => proposal({ disposition: 'needs_clarification', interpretation: 'ambiguous', question });

// ---------------------------------------------------------------- CLI helpers

let chunkbot: CliProcess;
let eventsPath = '';
function readJsonl(path: string): Json[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
  } catch {
    return [];
  }
}
const runEvents = () => readJsonl(eventsPath);

async function startChunkbot(name: string, configPath: string, env: NodeJS.ProcessEnv): Promise<CliProcess> {
  const p = new CliProcess(name, ['run', '--no-autonomy', '--config', configPath], env);
  await p.waitFor(/\[chunkbot\] planner: /, 30_000);
  const runLine = await p.waitFor(/\[chunkbot\] run \S+; evidence: /, 10_000);
  eventsPath = /evidence: (\S+)$/.exec(runLine)?.[1] ?? '';
  await p.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), 40_000);
  return p;
}

async function stopChunkbot(): Promise<void> {
  chunkbot.send('/quit');
  const exited = await Promise.race([chunkbot.exited, sleep(15_000).then(() => undefined)]);
  if (!exited) chunkbot.child.kill('SIGKILL');
  chunkbot.save(outDir);
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

async function resetScene(): Promise<void> {
  for (const c of sceneClearCommands()) await setup(c);
  await sleep(1_600);
  for (const c of sceneCommands()) await setup(c);
  await sleep(1_500);
}

/** Owner chat; returns the send time and the line index for waits. */
function say(owner: Bot, text: string): { at: number; from: number } {
  const from = chunkbot.length;
  const at = Date.now();
  owner.chat(`!chunkbot ${text}`);
  return { at, from };
}
async function lineSince(pattern: RegExp, from: number, timeoutMs: number): Promise<{ text: string; atMs: number }> {
  const text = await chunkbot.waitSince(pattern, from, timeoutMs);
  return chunkbot.lines.slice(from).find((l) => l.text === text)!;
}
async function goalAccepted(from: number, timeoutMs = 20_000): Promise<{ goalId: string; atMs: number }> {
  const l = await lineSince(/\[chunkbot\] Goal (goal-\S+) accepted: /, from, timeoutMs);
  return { goalId: /Goal (goal-\S+) accepted/.exec(l.text)![1]!, atMs: l.atMs };
}
async function goalTerminal(goalId: string, from: number, timeoutMs: number): Promise<{ state: string; reason: string; line: string }> {
  const l = await lineSince(new RegExp(`\\[chunkbot\\] Goal ${goalId} (completed|blocked|failed|cancelled) \\((\\w+)\\)`), from, timeoutMs);
  const m = new RegExp(`Goal ${goalId} (completed|blocked|failed|cancelled) \\((\\w+)\\)`).exec(l.text)!;
  return { state: m[1]!, reason: m[2]!, line: l.text };
}
async function waitEvent(pred: (e: Json) => boolean, timeoutMs: number): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = runEvents().find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error(`timed out waiting for an evidence event (${pred.toString().slice(0, 120)})`);
}

/** Planner turns never overlap (one owned process): checks started/completed/failed/cleanup pairs. */
function plannerOverlap(sinceMs: number): { overlaps: number; turns: number } {
  const ev = runEvents().filter((e) => tOf(e) >= sinceMs);
  const starts = ev.filter((e) => e.type === 'planner_turn_started');
  let overlaps = 0;
  let open = 0;
  for (const e of ev) {
    if (e.type === 'planner_turn_started') {
      if (open > 0) overlaps += 1;
      open += 1;
    } else if (e.type === 'planner_turn_completed' || e.type === 'planner_turn_failed') open = Math.max(0, open - 1);
  }
  return { overlaps, turns: starts.length };
}

/** Starts a persistent follow and waits until its task is running. */
async function startFollow(owner: Bot, ev: string[]): Promise<{ goalId: string }> {
  await setup(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
  await setup(`tp FixtureOwner ${SCENE.start.x + 3} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
  await sleep(1_000);
  const s = say(owner, 'follow me');
  const g = await goalAccepted(s.from);
  await waitEvent((e) => e.type === 'task_admitted' && e.goalId === g.goalId, 20_000);
  ev.push(`follow goal ${g.goalId} executing`);
  return { goalId: g.goalId };
}

/** Owner walks a short scripted path (RCON tp steps) while sampling the bot's server position. */
async function ownerWalksAndSample(points: Array<[number, number]>, stepMs: number): Promise<Array<{ atMs: number; bot: { x: number; y: number; z: number }; owner: { x: number; y: number; z: number } }>> {
  const samples: Array<{ atMs: number; bot: { x: number; y: number; z: number }; owner: { x: number; y: number; z: number } }> = [];
  for (const [x, z] of points) {
    await ownerAction(`tp FixtureOwner ${x} -60 ${z}`, 'scripted owner movement during preparation');
    await sleep(stepMs);
    samples.push({ atMs: Date.now(), bot: await serverPos(), owner: await serverPos('FixtureOwner') });
  }
  return samples;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  process.stdout.write(`handoff-live-check (PLANNER FAULT FIXTURE with scripted delays + loopback Jev; harness validation): fixture ${FIXTURE_PINS.host}:${FIXTURE_PINS.port}; report ${outDir}\n`);
  const base = JSON.parse(readFileSync(BASE_CONFIG, 'utf8')) as Json;
  const keyEnv = String(base.models?.decision?.apiKeyEnv ?? 'OPENROUTER_API_KEY');
  const env: NodeJS.ProcessEnv = { ...process.env, [keyEnv]: 'fault-fixture-placeholder-key' };
  const decision = { ...base.models.decision, endpoint: await startJevFault() };
  const faultDir = join(outDir, 'fault-planner');
  mkdirSync(faultDir, { recursive: true });
  const faultCodex = writeFaultCodex(faultDir, REAL_CODEX);
  const turnsFor = (turns: FaultTurn[]) => setFaultTurns(faultDir, REAL_CODEX, turns, 'chatgpt');
  const execCount = () => (JSON.parse(readFileSync(join(faultDir, 'fault-codex-counter.json'), 'utf8')) as { n: number }).n;
  const makeConfig = (name: string, flow: Json): string => {
    const cfg: Json = {
      ...base,
      storage: { ...base.storage, dataDir: join(PROJECT_ROOT, 'var') },
      models: { ...base.models, planner: { ...base.models.planner, mode: 'codex', command: faultCodex }, decision },
      limits: { ...base.limits, plannerTimeoutMs: 8_000 },
      flow,
    };
    const path = join(outDir, `${name}.json`);
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
    return path;
  };
  const smoothConfig = makeConfig('fixture-handoff-smooth', { handoff: 'smooth', lookahead: true, preparationTurnsPerRun: 40 });
  const noLookaheadConfig = makeConfig('fixture-handoff-no-lookahead', { handoff: 'smooth', lookahead: false, preparationTurnsPerRun: 40 });
  const list = await rconRaw('list').catch((error: unknown) => {
    throw new Error(`fixture not reachable over RCON (${String(error)}); the coordinator starts it under the lease`);
  });
  process.stdout.write(`fixture: ${list}\n`);
  const fixturePid = Number(readFileSync(fx.pidFile, 'utf8').trim());

  turnsFor([]);
  chunkbot = await startChunkbot('run-handoff', smoothConfig, env);
  connectionCursor = 0;
  let owner: Bot | undefined;
  try {
    await check('L0', 'built CLI with the planner fault fixture and loopback Jev is ready; owner joins; scene reset', async (ev) => {
      ev.push(chunkbot.lines.find((l) => l.text.startsWith('[chunkbot] planner: '))?.text ?? 'no planner line');
      chunkbot.send('status');
      ev.push(await chunkbot.waitFor(/\[status\] planner: ready/, 10_000));
      owner = await fixtureBot('FixtureOwner');
      await resetScene();
      ev.push(`scene reset (${setupLog.length} setup commands)`);
    });
    assert(owner, 'owner bot joined');
    const o = owner;

    await check('L1', `H1/H2: follow keeps moving (server positions) while a ${PREP_DELAY_MS} ms delayed preparation runs; immediate ack; single switch; timeline`, async (ev, trials) => {
      turnsFor([{ kind: 'proposal', proposal: followMe() }, { kind: 'proposal', proposal: comeHere('handoff target'), delayMs: PREP_DELAY_MS }]);
      const follow = await startFollow(o, ev);
      const t0 = Date.now();
      const s = say(o, 'come stand next to me');
      const ack = await lineSince(/\[chunkbot\] Preparing your new instruction: "come stand next to me"; continuing the current task until handoff/, s.from, 5_000);
      const receipt = chunkbot.lines.slice(s.from).find((l) => /\[chat\] owner: !chunkbot come stand next to me/.test(l.text));
      const before = await serverPos();
      const samples = await ownerWalksAndSample([[SCENE.start.x + 6, SCENE.start.z + 2], [SCENE.start.x + 8, SCENE.start.z + 5], [SCENE.start.x + 9, SCENE.start.z + 8]], 800);
      const accepted = await goalAccepted(s.from, 20_000);
      const prepEvents = runEvents().filter((e) => tOf(e) >= t0 && tOf(e) <= accepted.atMs);
      // A follow action runs up to its window (~30 s), so "continued" means the old task was still
      // running (no task_terminal) until admission, plus server-confirmed movement below.
      const continued = prepEvents.filter((e) => (e.type === 'task_local_continuation' || e.type === 'task_action' || e.type === 'task_choice' || e.type === 'task_holding') && e.goalId === follow.goalId);
      const timeline = await waitEvent((e) => e.type === 'handoff_timeline' && e.goalId === accepted.goalId, 30_000);
      const startedDuringPrep = runEvents().filter((e) => e.type === 'task_admitted' && e.goalId !== follow.goalId && tOf(e) >= t0 && tOf(e) < Number(timeline.admittedAtMs));
      const moved = Math.max(...samples.map((x) => dist(before, x.bot)));
      const old = await goalTerminal(follow.goalId, s.from, 10_000);
      const overlap = plannerOverlap(t0);
      const discarded = runEvents().filter((e) => e.type === 'task_result_discarded' && e.goalId === follow.goalId);
      ev.push(`receipt ${receipt ? receipt.atMs - s.at : 'n/a'} ms after send; ack ${ack.atMs - s.at} ms after send; switch (goal accepted) ${accepted.atMs - s.at} ms after send`);
      ev.push(`timeline ${JSON.stringify(timeline)}`);
      ev.push(`bot moved ${moved.toFixed(2)} blocks (server) during preparation; ${continued.length} old-task continuation/action events; samples ${JSON.stringify(samples.map((x) => ({ dt: x.atMs - t0, bot: x.bot, owner: x.owner })))}`);
      ev.push(`old goal ${follow.goalId} ${old.state} (${old.reason}); late old results discarded: ${discarded.length}; planner turns ${overlap.turns}, overlaps ${overlap.overlaps}`);
      trials.push({ sendAtMs: s.at, receiptAtMs: receipt?.atMs ?? null, ackAtMs: ack.atMs, acceptedAtMs: accepted.atMs, timeline, samples, movedBlocks: moved, oldTaskEventsDuringPrep: continued.length, oldGoal: old, plannerOverlap: overlap });
      assert(ack.atMs - s.at < 1_500, 'acknowledged promptly');
      assert(Number(timeline.receiptToDraftMs) >= PREP_DELAY_MS - 200, 'preparation took the scripted planner delay');
      // The old task ends only by revocation AT the switch (handoff start -> revoke -> admit).
      const oldEnd = runEvents().find((e) => e.type === 'task_terminal' && e.goalId === follow.goalId);
      const oldEndedBeforeAdmission = Boolean(oldEnd && (tOf(oldEnd) < Number(timeline.handoffStartedAtMs) - 1 || oldEnd.reason !== 'ownership_revoked'));
      ev.push(`old follow task end: ${oldEnd ? `${oldEnd.status} (${oldEnd.reason}) ${tOf(oldEnd) - Number(timeline.handoffStartedAtMs)} ms after handoff start` : 'none'}`);
      assert(moved >= 1.5, 'server-confirmed movement continued during preparation');
      assert(!oldEndedBeforeAdmission, 'the admitted follow task kept running until the switch');
      assert(startedDuringPrep.length === 0, 'no task ran under pending ownership');
      assert(old.reason === 'replaced', 'old goal replaced at the switch');
      assert(overlap.overlaps === 0, 'one planner process at a time');
      const done = await goalTerminal(accepted.goalId, s.from, 90_000);
      ev.push(`new goal ${accepted.goalId} ${done.state} (${done.reason})`);
      trials.push({ newGoal: done });
    });

    await check('L2', 'H3: logs gained by the old task during preparation are in the REAL admission baseline; the new outcome is bound to it', async (ev, trials) => {
      await resetScene();
      turnsFor([
        { kind: 'proposal', proposal: collectLogs(3, 3, false, 'Collect three oak logs.') },
        { kind: 'proposal', proposal: collectLogs(1, 1, false, 'Collect one more oak log.'), delayMs: 3_000 },
      ]);
      const s1 = say(o, 'collect three oak logs');
      const first = await goalAccepted(s1.from);
      // Send the replacement once the old task has collected at least one log.
      const deadline = Date.now() + 90_000;
      let inv = await serverInventory();
      while ((inv['minecraft:oak_log'] ?? 0) < 1 && Date.now() < deadline) {
        await sleep(500);
        inv = await serverInventory();
      }
      assert((inv['minecraft:oak_log'] ?? 0) >= 1, 'the old task collected a log');
      const atSend = inv['minecraft:oak_log'] ?? 0;
      const s2 = say(o, 'collect one more oak log');
      await lineSince(/\[chunkbot\] Preparing your new instruction/, s2.from, 5_000);
      const accepted = await goalAccepted(s2.from, 30_000);
      const baseline = await waitEvent((e) => e.type === 'goal_admission_baseline' && e.goalId === accepted.goalId, 15_000);
      const bound = await waitEvent((e) => e.type === 'goal_outcome_bound' && e.goalId === accepted.goalId, 15_000);
      const draftCaptured = runEvents().filter((e) => e.type === 'goal_admission_baseline' && tOf(e) > s2.at && tOf(e) < accepted.atMs);
      const admitted = Number(baseline.counts?.['minecraft:oak_log'] ?? 0);
      ev.push(`old goal ${first.goalId}: oak logs at send ${atSend}; admission baseline of ${accepted.goalId}: ${JSON.stringify(baseline.counts)}; bound ${JSON.stringify(bound.baselines)}`);
      const done = await goalTerminal(accepted.goalId, s2.from, 120_000);
      const finalInv = await serverInventory();
      ev.push(`new goal ${done.state} (${done.reason}); final oak logs ${finalInv['minecraft:oak_log'] ?? 0}`);
      trials.push({ atSend, admissionBaseline: baseline, bound, finalInventory: finalInv, newGoal: done, gainedDuringPreparation: admitted - atSend });
      assert(draftCaptured.length === 0, 'no admission baseline (server resync) was taken for the draft before admission');
      assert(admitted >= atSend, 'admission baseline includes everything gained before admission');
      assert(Number(bound.baselines?.['inv:#minecraft:logs']) === admitted, 'outcome bound to the admission baseline');
      if (done.state === 'completed') assert((finalInv['minecraft:oak_log'] ?? 0) >= admitted + 1, 'completion required one log beyond the admission baseline');
    });

    await check('L3', 'H4: superseding instructions while following: A and B killed mid-turn, then C and D back-to-back; only D admitted; one planner process; aborted planner process groups cleaned; spoofed lines ignored', async (ev, trials) => {
      await resetScene();
      // Every preparation turn would answer after 1.5 s; superseded ones are killed before that.
      turnsFor([{ kind: 'proposal', proposal: followMe() }, { kind: 'proposal', proposal: comeHere('latest instruction'), delayMs: 1_500 }]);
      const follow = await startFollow(o, ev);
      const t0 = Date.now();
      const turnStarted = (since: number) => waitEvent((e) => e.type === 'planner_turn_started' && e.intentId && tOf(e) >= since - 5, 10_000);
      const a = say(o, 'instruction A');
      await turnStarted(a.at);
      const b = say(o, 'instruction B');
      await turnStarted(b.at);
      await setup('tellraw @a "<FixtureOwner> !chunkbot stop"');
      await setup('say !chunkbot stop');
      const c = say(o, 'instruction C');
      const d = say(o, 'instruction D');
      const accepted = await goalAccepted(a.from, 30_000);
      const acceptedLines = chunkbot.lines.slice(a.from).filter((l) => /\[chunkbot\] Goal goal-\S+ accepted: /.test(l.text));
      await sleep(1_000);
      const discarded = runEvents().filter((e) => e.type === 'preparation_discarded' && tOf(e) >= t0);
      const cleanups = runEvents().filter((e) => e.type === 'planner_process_cleanup' && tOf(e) >= t0);
      const rejected = runEvents().filter((e) => e.type === 'chat_rejected' && tOf(e) >= t0);
      const overlap = plannerOverlap(t0);
      const followStillRunningAtD = !runEvents().some((e) => e.type === 'goal_terminal' && e.goalId === follow.goalId && tOf(e) < d.at);
      ev.push(`sent A/B/C/D at +0/+${b.at - a.at}/+${c.at - a.at}/+${d.at - a.at} ms; accepted lines: ${acceptedLines.map((l) => l.text.slice(0, 120)).join(' | ')}`);
      ev.push(`discarded ${JSON.stringify(discarded.map((x) => ({ intentId: x.intentId, reason: x.reason, turns: x.plannerTurns })))}`);
      ev.push(`process cleanups ${JSON.stringify(cleanups.map((x) => ({ remaining: x.remaining, signals: x.signals })))}; spoofed lines rejected ${rejected.map((r) => r.reason).join(',')}; planner turns ${overlap.turns}, overlaps ${overlap.overlaps}; follow still running when D arrived: ${followStillRunningAtD}`);
      trials.push({ accepted, discarded, cleanups, rejected, plannerOverlap: overlap, followGoal: follow.goalId, followStillRunningAtD });
      assert(acceptedLines.length === 1 && /instruction D/.test(acceptedLines[0]!.text), 'only the newest instruction (D) was admitted');
      assert(discarded.filter((x) => x.reason === 'superseded').length === 3, 'A, B and C superseded');
      assert(cleanups.length >= 2 && cleanups.every((x) => (x.remaining as unknown[]).length === 0), 'killed planner process groups fully cleaned');
      assert(overlap.overlaps === 0, 'one planner process at a time');
      assert(rejected.length >= 2, 'system/console spoofs ignored');
      assert(followStillRunningAtD, 'superseding drafts never stopped the active follow');
      await goalTerminal(accepted.goalId, a.from, 90_000).catch(() => undefined);
    });

    await check('L4', `H5: stop during preparation clears controls <= ${STOP_TARGET_MS} ms, cancels both contexts, latches pause; resume is explicit`, async (ev, trials) => {
      await resetScene();
      turnsFor([{ kind: 'proposal', proposal: followMe() }, { kind: 'hang' }]);
      const follow = await startFollow(o, ev);
      const s = say(o, 'build a tower');
      await lineSince(/\[chunkbot\] Preparing your new instruction/, s.from, 5_000);
      await waitEvent((e) => e.type === 'planner_turn_started' && e.intentId && tOf(e) >= s.at - 5, 10_000);
      await ownerAction(`tp FixtureOwner ${SCENE.start.x + 9} -60 ${SCENE.start.z + 7}`, 'owner walks so the follow is moving at the stop');
      // Stop only while a follow ACTION holds the actuator lease (the maintain hold re-observes about once a second).
      const leaseFrom = Date.now();
      await waitEvent((e) => e.type === 'lease_acquired' && tOf(e) >= leaseFrom - 5, 10_000);
      await sleep(300);
      const sentAt = chunkbot.send('stop');
      const cancelled = await lineSince(new RegExp(`Goal ${follow.goalId} cancelled \\(owner_stop\\)`), s.from, 5_000);
      await sleep(300);
      const revoked = runEvents().filter((e) => e.type === 'lease_revoked' && tOf(e) >= sentAt - 5);
      const discarded = runEvents().find((e) => e.type === 'preparation_discarded' && e.reason === 'owner_stop');
      const p1 = await serverPos();
      await ownerAction(`tp FixtureOwner ${SCENE.start.x - 2} -60 ${SCENE.start.z - 4}`, 'owner walks away after the stop');
      await sleep(2_000);
      const p2 = await serverPos();
      chunkbot.send('status');
      const paused = await chunkbot.waitFor(/\[status\] Automatic work paused/, 5_000);
      const r = say(o, 'resume');
      const resumed = await lineSince(/\[chunkbot\] Resumed: automatic work is allowed again/, r.from, 5_000);
      const lease = revoked[0];
      const cancelMs = cancelled.atMs - sentAt;
      ev.push(`stop -> goal cancelled line ${cancelMs} ms; lease revoke ${lease ? `${tOf(lease) - sentAt} ms after stop, clearMs=${lease.clearMs}` : 'none (no action held the lease at the stop)'}; pending discarded: ${Boolean(discarded)}`);
      ev.push(`after stop the bot moved ${dist(p1, p2).toFixed(2)} blocks while the owner walked away; ${paused}; ${resumed.text}`);
      trials.push({ stopSentAtMs: sentAt, cancelMs, lease: lease ?? null, discarded: discarded ?? null, drift: dist(p1, p2) });
      assert(cancelMs <= 1_000, 'stop did not wait for the planner');
      assert(lease, 'the stop revoked a held actuator lease (follow action in progress)');
      assert(tOf(lease) - sentAt <= STOP_TARGET_MS && Number(lease.clearMs) <= STOP_TARGET_MS, 'controls cleared within the stop target');
      assert(discarded, 'the pending preparation was cancelled');
      assert(dist(p1, p2) < 0.6, 'no movement after stop (paused)');
    });

    await check('L5', 'H5: a lifecycle interruption (death) during preparation invalidates both contexts; nothing resumes', async (ev) => {
      await resetScene();
      turnsFor([{ kind: 'proposal', proposal: followMe() }, { kind: 'hang' }]);
      const follow = await startFollow(o, ev);
      const s = say(o, 'dig a well');
      await lineSince(/\[chunkbot\] Preparing your new instruction/, s.from, 5_000);
      await waitEvent((e) => e.type === 'planner_turn_started' && e.intentId && tOf(e) >= s.at - 5, 10_000);
      await ownerAction('kill Chunkbot', 'lifecycle interruption under test');
      const ended = await goalTerminal(follow.goalId, s.from, 10_000);
      const discarded = await waitEvent((e) => e.type === 'preparation_discarded' && e.reason === 'lifecycle', 10_000);
      await sleep(2_000);
      const admittedAfter = runEvents().filter((e) => e.type === 'goal_admitted' && tOf(e) > tOf(discarded));
      ev.push(`old goal ${ended.state} (${ended.reason}); pending discarded (${discarded.detail}); goals admitted afterwards: ${admittedAfter.length}`);
      assert(ended.reason === 'death', 'goal ended by death');
      assert(admittedAfter.length === 0, 'the pending instruction did not start after the death');
      await setup(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
    });

    await check('L6', 'H6 + MB-PLAN-006: quota before admission keeps following; a legacy clarification is a counted preparation repair (no question or answer prompt, old task continues) and the repaired draft completes the handoff', async (ev, trials) => {
      await resetScene();
      turnsFor([{ kind: 'proposal', proposal: followMe() }, { kind: 'quota' }, { kind: 'proposal', proposal: clarifyTurn('Which side of the house?') }, { kind: 'proposal', proposal: comeHere('after repair') }]);
      const follow = await startFollow(o, ev);
      const s = say(o, 'guard the house');
      const notStarted = await lineSince(/\[chunkbot\] Your new instruction was not started \(planner_not_ready\): quota/, s.from, 15_000);
      const before = await serverPos();
      await ownerWalksAndSample([[SCENE.start.x + 7, SCENE.start.z + 3], [SCENE.start.x + 9, SCENE.start.z + 6]], 900);
      const after = await serverPos();
      ev.push(`${notStarted.text.slice(0, 260)}; follow moved ${dist(before, after).toFixed(2)} blocks afterwards`);
      assert(/no paid or alternative planner/.test(notStarted.text) && /Continuing goal/.test(notStarted.text), 'honest no-fallback text');
      assert(dist(before, after) >= 1.5, 'the old follow kept moving');
      const s2 = say(o, 'stand guard');
      const accepted = await goalAccepted(s2.from, 30_000);
      const oldEnd = await goalTerminal(follow.goalId, s.from, 10_000);
      const shown = chunkbot.since(s2.from).filter((l) => /\[chunkbot\] .*(Question q\d+|answer q\d+|Which side of the house)/.test(l));
      const refused = runEvents().filter((e) => e.type === 'planner_question_refused' && e.preparation === true).length;
      ev.push(`no-question: ${shown.length} question/answer lines shown; preparation question refusals ${refused}; accepted ${accepted.goalId}; old ${oldEnd.state} (${oldEnd.reason})`);
      trials.push({ quotaNotice: notStarted.text, shown, refused, accepted, oldEnd });
      assert(shown.length === 0, 'no follow-up question or answer prompt reached chat/terminal');
      assert(refused >= 1, 'the legacy question was refused as a counted repair');
      assert(oldEnd.reason === 'replaced', 'the old follow continued until the handoff');
      await goalTerminal(accepted.goalId, s2.from, 90_000).catch(() => undefined);
    });
  } finally {
    await stopChunkbot();
  }

  // L7: identical two-window goal with and without lookahead (separate CLI processes).
  const gaps: Json = {};
  for (const [label, configPath] of [['lookahead', smoothConfig], ['no-lookahead', noLookaheadConfig]] as const) {
    if (only && !only.has('L7')) break;
    chunkbot = await startChunkbot(`run-handoff-${label}`, configPath, env);
    connectionCursor = 0;
    try {
      await check('L7', `H7 (${label}): two finite windows; measured gap between windows`, async (ev, trials) => {
        owner ??= await fixtureBot('FixtureOwner');
        await resetScene();
        // Window 1 walks to the owner (it cannot satisfy the log outcome; move_near the owner is a
        // proven grounded action); window 2 collects the log. The second planner turn (lookahead or
        // replan) takes 1 s, shorter than window 1's ~8-block walk.
        await setup(`tp FixtureOwner ${SCENE.start.x + 6} -60 ${SCENE.start.z + 6} 0 0`);
        await sleep(800);
        const interpretation = 'Walk to the owner, then collect one oak log.';
        const w1 = proposal({ ...comeHere('window 1'), interpretation, outcome: { kind: 'finite', predicate: LOGS(1) }, morePlanningNeeded: true });
        const w2 = proposal({ interpretation, outcome: { kind: 'finite', predicate: LOGS(1) }, tasks: [logTask('Collect 1 oak log.', 1)], morePlanningNeeded: false });
        turnsFor([{ kind: 'proposal', proposal: w1 }, { kind: 'proposal', proposal: w2, delayMs: 1_000 }]);
        const s = say(owner, 'come to me then collect an oak log');
        const g = await goalAccepted(s.from);
        const done = await goalTerminal(g.goalId, s.from, 180_000);
        const gap = runEvents().find((e) => e.type === 'goal_window_gap' && e.goalId === g.goalId);
        const lookaheadReady = runEvents().find((e) => e.type === 'lookahead_ready' && e.goalId === g.goalId);
        gaps[label] = gap ?? null;
        ev.push(`${g.goalId} ${done.state} (${done.reason}); gap ${gap ? `${gap.gapMs} ms (${gap.source}${gap.revalidationMs !== undefined ? `, revalidation ${gap.revalidationMs} ms` : ''})` : 'none'}; lookahead ${lookaheadReady ? `ready after ${lookaheadReady.elapsedMs} ms` : 'not used'}`);
        trials.push({ label, goal: done, gap, lookaheadReady: lookaheadReady ?? null });
        assert(gap, 'two windows ran and the gap was measured');
        if (label === 'lookahead') assert(gap.source === 'lookahead' && typeof gap.revalidationMs === 'number', 'the next window came from the revalidated lookahead');
        if (label === 'no-lookahead') {
          const on = gaps['lookahead'];
          assert(gap.source === 'replan', 'the next window waited for a replan turn');
          if (on) assert(Number(on.gapMs) < Number(gap.gapMs), `lookahead reduced the measured gap (${on.gapMs} ms vs ${gap.gapMs} ms)`);
        }
      });
    } finally {
      await stopChunkbot();
    }
  }
  owner?.quit();
  jevServer?.close();

  const passed = results.filter((r) => r.pass).length;
  const report = {
    kind: 'mb-flow-002-handoff-live-check',
    planner: 'PLANNER FAULT FIXTURE with scripted delays (real CLI answers only the read-only isolation-gate commands; login status scripted as managed ChatGPT mode)',
    jev: 'loopback Jev fault provider (first unrepeated option)',
    acceptanceEvidence: 'harness validation of handoff ownership/timing/world evidence; NOT planner or Jev quality acceptance',
    startedAt: stamp,
    fixture: { host: FIXTURE_PINS.host, port: FIXTURE_PINS.port, version: FIXTURE_PINS.minecraftVersion, pid: fixturePid },
    passed,
    total: results.length,
    results,
    windowGaps: gaps,
    setupCommands: setupLog,
    scriptedOwnerActions: interventions,
    connectionLosses,
    faultHangChildFile: existsSync(join(faultDir, 'fault-codex-hang-child.json')) ? JSON.parse(readFileSync(join(faultDir, 'fault-codex-hang-child.json'), 'utf8')) : null,
  };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n${passed}/${results.length} handoff scenarios passed; report ${join(outDir, 'report.json')}\n`);
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`handoff-live-check error: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
