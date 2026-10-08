// MB-V1-04 planner live check against the LOCAL TEST FIXTURE.
//
// Drives the REAL built CLI (`node dist/cli.js run`) through its NORMAL goal
// intake (owner chat `!chunkbot ...` and the terminal) with the REAL Codex
// subscription planner (isolated `codex exec`), the generic Jev task
// controller and the accepted skills, against a controlled survival scene.
// Every planner proposal, Jev request/choice, skill result and final predicate
// is linked from the run evidence; RCON reads server truth independently.
//
//   --jev real   (default) real OpenRouter Jev; needs the configured key env
//                var (e.g. OPENROUTER_API_KEY) injected by the operator's
//                credential helper. The planner is always the real subscription.
//   --jev fault  a LOOPBACK Jev fault provider (first unrepeated option):
//                harness validation of planner/controller integration only,
//                never Jev acceptance.
//   --only P1,P2 run a subset.
//
// A separate CLI process uses a PLANNER FAULT FIXTURE (scripts/lib/fault-codex.ts)
// for malformed/code-bearing/invented-reference/quota/auth/hang/reroute/tool
// cases; it wraps the real CLI for the isolation gate and is labeled as such.
//
// Scene setup is RCON in the reset area (scripts/lib/scene.ts), recorded
// separately from every in-trial intervention.
//
//   npm run build && npm run fixture -- start && npm run planner-live-check
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
import { setFaultTurns, writeFaultCodex, type FaultAuthMode, type FaultTurn } from './lib/fault-codex.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Bot = ReturnType<typeof mineflayer.createBot>;

const argv = process.argv;
const jevMode = argv.includes('--jev') ? argv[argv.indexOf('--jev') + 1] : 'real';
if (jevMode !== 'real' && jevMode !== 'fault') {
  process.stderr.write('usage: planner-live-check [--jev real|fault] [--only P1,P2]\n');
  process.exit(2);
}
const only = argv.includes('--only') ? new Set((argv[argv.indexOf('--only') + 1] ?? '').split(',')) : undefined;
const fx = fixturePaths(PROJECT_ROOT, FIXTURE_PINS);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${FIXTURE_SUFFIX}-planner-jev-${jevMode}`);
mkdirSync(outDir, { recursive: true });
const BASE_CONFIG = join(PROJECT_ROOT, FIXTURE_PINS.config);
const REAL_CODEX = '/opt/homebrew/bin/codex';
/** Optional experiment override of limits.plannerTimeoutMs (recorded in the report). */
const plannerTimeoutOverride = argv.includes('--planner-timeout-ms') ? Number(argv[argv.indexOf('--planner-timeout-ms') + 1]) : undefined;

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
async function intervene(command: string, why: string): Promise<string> {
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
async function blockIs(x: number, y: number, z: number, block: string): Promise<boolean> {
  return /passed/i.test(await rconRaw(`execute if block ${x} ${y} ${z} ${block}`));
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

async function check(id: string, title: string, fn: (ev: string[], trials: Json[]) => Promise<void>): Promise<void> {
  if (only && !only.has(id)) return;
  currentScenario = id;
  // MB-FLOW-002-C4: every scenario starts from idle. A goal or pending instruction left
  // by an earlier (possibly failed) scenario is stopped and its bounded cleanup awaited,
  // so it cannot cascade into this one. A failure to quiesce fails THIS scenario honestly.
  let quiesceError: string | undefined;
  try {
    await quiesce(`before ${id}`);
  } catch (error) {
    quiesceError = error instanceof Error ? error.message : String(error);
  }
  if (quiesceError) {
    results.push({ id, title, pass: false, evidence: [`ERROR: could not reach an idle start: ${quiesceError}`], trials: [] });
    process.stdout.write(`FAIL ${id} ${title}\n  could not reach an idle start: ${quiesceError.slice(0, 600)}\n`);
    return;
  }
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
    results.push({ id, title, pass: false, evidence, trials });
    process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)?.slice(0, 800)}\n`);
  }
  for (const line of evidence.slice(0, 60)) process.stdout.write(`     ${line.slice(0, 300)}\n`);
}

// ---------------------------------------------------------------- Jev fault provider (loopback)

let faultServer: Server | undefined;
const faultRecent: string[] = [];
async function startJevFault(): Promise<string> {
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
const journal = () => readJsonl(join(eventsPath, '..', 'planner.jsonl'));

async function startChunkbot(name: string, configPath: string, env: NodeJS.ProcessEnv): Promise<CliProcess> {
  const p = new CliProcess(name, ['run', '--no-autonomy', '--config', configPath], env);
  await p.waitFor(/\[chunkbot\] planner: /, 30_000);
  const runLine = await p.waitFor(/\[chunkbot\] run \S+; evidence: /, 10_000);
  eventsPath = /evidence: (\S+)$/.exec(runLine)?.[1] ?? '';
  await p.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), 40_000);
  return p;
}

interface GoalRun {
  goalId: string;
  terminalLine: string;
  state: string;
  reason: string;
  events: Json[];
  journal: Json[];
  fromLine: number;
}

/** Limits of the CLI process currently driven (set before each startChunkbot); used only for honest wait bounds. */
let runLimits = { plannerTurnsPerGoal: 20, plannerTimeoutMs: 45_000, cleanupTimeoutMs: 2_000 };
function setRunLimits(limits: Json | undefined): void {
  runLimits = {
    plannerTurnsPerGoal: Number(limits?.plannerTurnsPerGoal ?? 20),
    plannerTimeoutMs: Number(limits?.plannerTimeoutMs ?? 45_000),
    cleanupTimeoutMs: Number(limits?.cleanupTimeoutMs ?? 2_000),
  };
}

/** Intake timing record per submission (pending preparation vs direct admission). */
const submissions: Json[] = [];

/**
 * Submits through normal intake (owner chat or terminal) and returns the admitted goal id.
 * MB-FLOW-002-C4: with smooth handoff a valid instruction that arrives while a goal is
 * executing is first PREPARED ("Preparing your new instruction ...") and admitted only after
 * its plan is ready. Then admission is awaited up to the configured preparation budget
 * (every preparation turn counts against plannerTurnsPerGoal; each is bounded by the planner
 * timeout plus process cleanup). A preparation that ends without admission (not started,
 * discarded, hung until its bounded failure) fails the scenario; a rejected instruction too.
 */
async function submit(text: string, via: 'chat' | 'terminal', owner?: Bot): Promise<{ goalId: string; from: number }> {
  const from = chunkbot.length;
  const sentAtMs = Date.now();
  if (via === 'chat') {
    assert(owner, 'owner bot required for chat intake');
    owner.chat(`!chunkbot ${text}`);
  } else chunkbot.send(text);
  const first = await chunkbot.waitSince(/\[chunkbot\] (Goal (goal-\S+) accepted: |Preparing your new instruction|Instruction not accepted: )/, from, 15_000);
  const record: Json = { scenario: currentScenario, text: text.slice(0, 120), via, sentAtMs };
  submissions.push(record);
  if (/Instruction not accepted: /.test(first)) {
    record.rejected = first;
    throw new Error(`instruction rejected at intake: ${first.slice(0, 300)}`);
  }
  let line = first;
  if (/Preparing your new instruction/.test(first)) {
    record.preparingAtMs = chunkbot.lines.slice(from).find((l) => l.text === first)?.atMs ?? Date.now();
    const budgetMs = runLimits.plannerTurnsPerGoal * (runLimits.plannerTimeoutMs + runLimits.cleanupTimeoutMs) + 10_000;
    record.preparationBudgetMs = budgetMs;
    line = await chunkbot.waitSince(/\[chunkbot\] (Goal (goal-\S+) accepted: |Your new instruction was not started |Stopped: the pending new instruction was discarded|The pending new instruction was discarded)/, from, budgetMs);
    if (!/Goal (goal-\S+) accepted: /.test(line)) {
      record.preparationEnded = line;
      throw new Error(`the prepared instruction was not admitted: ${line.slice(0, 300)}`);
    }
  }
  const goalId = /Goal (goal-\S+) accepted/.exec(line)?.[1] as string;
  record.goalId = goalId;
  record.acceptedAtMs = chunkbot.lines.slice(from).find((l) => l.text === line)?.atMs ?? Date.now();
  return { goalId, from };
}

/** One `status` rendering: the active goal (if in an active state) and the pending instruction (if any). */
async function statusSnapshot(): Promise<{ activeGoalId?: string; activeState?: string; pendingIntentId?: string; paused: boolean }> {
  const from = chunkbot.length;
  chunkbot.send('status');
  // `network:` is the first status extra, printed after every engine line of the same rendering.
  await chunkbot.waitSince(/^\[status\] network: /, from, 10_000);
  const lines = chunkbot.lines.slice(from).map((l) => l.text);
  const end = lines.findIndex((t) => /^\[status\] network: /.test(t));
  const block = lines.slice(0, end + 1);
  const goal = block.map((t) => /^\[status\] goal: (goal-\S+)(?: \[operator task diagnostic\])? (planning|awaiting_owner|executing|stopping) /.exec(t)).find(Boolean);
  const pending = block.map((t) => /^\[status\] pending instruction: (intent-\S+) /.exec(t)).find(Boolean);
  return {
    ...(goal ? { activeGoalId: goal[1], activeState: goal[2] } : {}),
    ...(pending ? { pendingIntentId: pending[1] } : {}),
    paused: block.some((t) => /^\[status\] Automatic work paused/.test(t)),
  };
}

/** Planner turns started minus turns that reached a completed/failed record (0 = no planner process running). */
const plannerTurnsOpen = () => {
  const ev = runEvents();
  return ev.filter((e) => e.type === 'planner_turn_started').length - ev.filter((e) => e.type === 'planner_turn_completed' || e.type === 'planner_turn_failed').length;
};

/** Inter-scenario quiescence records (report.json). */
const quiesceLog: Json[] = [];

/**
 * MB-FLOW-002-C4 completed-stop seam BEFORE any world change: revoke active AND pending work
 * with an ordinary owner stop, then wait for the application's own completion evidence
 * (the goal's terminal line, written only after its bounded cleanup; the pending
 * instruction's discard; every started planner turn recorded as ended) and confirm idle via
 * `status`. The stop latch it sets is cleared with an explicit bare `resume`, so the next
 * scenario starts from the default idle state. Bounded by the configured cleanup and
 * planner-turn limits; failure to quiesce throws (never a silent proceed).
 */
async function quiesce(label: string): Promise<void> {
  if (!chunkbot) return;
  const t0 = Date.now();
  const before = await statusSnapshot();
  const entry: Json = { scenario: currentScenario, label, atMs: t0, activeGoalId: before.activeGoalId ?? null, activeState: before.activeState ?? null, pendingIntentId: before.pendingIntentId ?? null };
  quiesceLog.push(entry);
  const budgetMs = runLimits.plannerTimeoutMs + 4 * runLimits.cleanupTimeoutMs + 10_000;
  if (before.activeGoalId || before.pendingIntentId) {
    const from = chunkbot.length;
    entry.stopSentAtMs = chunkbot.send('stop');
    if (before.activeGoalId) {
      const line = await chunkbot.waitSince(new RegExp(`\\[chunkbot\\] Goal ${before.activeGoalId} (completed|blocked|failed|cancelled) \\(`), from, budgetMs);
      entry.goalTerminal = line.replace(/^\[chunkbot\] /, '').slice(0, 200);
    }
    if (before.pendingIntentId) {
      const deadline = Date.now() + budgetMs;
      while (!runEvents().some((e) => e.type === 'preparation_discarded' && e.intentId === before.pendingIntentId)) {
        if (Date.now() > deadline) throw new Error(`pending instruction ${before.pendingIntentId} was not discarded within ${budgetMs} ms of the stop`);
        await sleep(100);
      }
      entry.pendingDiscarded = true;
    }
  }
  const deadline = Date.now() + budgetMs;
  while (plannerTurnsOpen() > 0) {
    if (Date.now() > deadline) throw new Error(`a planner process is still running ${budgetMs} ms after the stop (${plannerTurnsOpen()} turn(s) without an ended record)`);
    await sleep(100);
  }
  const after = await statusSnapshot();
  if (after.activeGoalId || after.pendingIntentId) throw new Error(`not idle after the stop: goal ${after.activeGoalId ?? 'none'} (${after.activeState ?? '-'}), pending ${after.pendingIntentId ?? 'none'}`);
  if (after.paused) {
    const from = chunkbot.length;
    chunkbot.send('resume');
    await chunkbot.waitSince(/\[chunkbot\] (Resumed: |Automatic work is not paused)/, from, 10_000);
    entry.resumed = true;
  }
  entry.idleAfterMs = Date.now() - t0;
}

async function waitTerminal(goalId: string, from: number, timeoutMs: number): Promise<GoalRun> {
  const line = await chunkbot.waitSince(new RegExp(`\\[chunkbot\\] Goal ${goalId} (completed|blocked|failed|cancelled) \\((\\w+)\\)`), from, timeoutMs);
  const m = new RegExp(`Goal ${goalId} (completed|blocked|failed|cancelled) \\((\\w+)\\)`).exec(line)!;
  await sleep(300);
  return { goalId, terminalLine: line, state: m[1] as string, reason: m[2] as string, events: runEvents().filter((e) => e.goalId === goalId), journal: journal().filter((e) => e.goalId === goalId), fromLine: from };
}

/** Compact planner evidence for one goal: turns, proposals (interpretation/outcome/tasks), rejections, usage. */
function plannerSummary(g: GoalRun): Json {
  const turns = g.events.filter((e) => e.type === 'planner_turn_completed').map((e) => ({ turn: e.turn, turnKind: e.turnKind, elapsedMs: e.elapsedMs, usage: e.usage, selectedModel: e.selectedModel, effort: e.effort, events: e.eventCounts }));
  const failed = g.events.filter((e) => e.type === 'planner_turn_failed').map((e) => ({ turn: e.turn, kind: e.kind, detail: e.detail }));
  const proposals = g.journal
    .filter((e) => e.type === 'goal_proposal_accepted')
    .map((e) => {
      const p = e.proposal as Json;
      return {
        turn: e.turn,
        turnKind: e.turnKind,
        disposition: p.disposition,
        interpretation: p.interpretation,
        ...(p.outcome ? { outcome: p.outcome } : {}),
        ...(p.tasks ? { tasks: (p.tasks as Json[]).map((t) => ({ objective: t.objective, allowedCapabilities: t.allowedCapabilities, targetSelectors: t.targetSelectors, completion: t.completion })) } : {}),
        ...(p.queries ? { queries: p.queries } : {}),
        ...(p.question ? { question: p.question } : {}),
        ...(p.missing ? { missing: p.missing } : {}),
        ...(p.morePlanningNeeded !== undefined ? { morePlanningNeeded: p.morePlanningNeeded } : {}),
      };
    });
  const rejected = g.events.filter((e) => e.type === 'planner_proposal_rejected').map((e) => ({ kind: e.kind, problems: e.problems }));
  const windows = g.events.filter((e) => e.type === 'goal_window').map((e) => ({ window: e.window, tasks: e.tasks, morePlanningNeeded: e.morePlanningNeeded }));
  const outcomeEvals = g.events.filter((e) => e.type === 'goal_outcome_evaluated').map((e) => ({ window: e.window, status: e.status, detail: e.detail }));
  const bound = g.events.find((e) => e.type === 'goal_outcome_bound');
  const baseline = g.events.find((e) => e.type === 'goal_admission_baseline');
  const terminal = g.events.find((e) => e.type === 'goal_terminal');
  return { goalId: g.goalId, terminal: g.terminalLine.replace(/^\[chunkbot\] /, ''), counters: terminal?.counters ?? null, turns, failedTurns: failed, proposals, rejected, windows, outcomeEvals, outcomeBound: bound ? { kind: bound.kind, baselines: bound.baselines, fromAdmission: bound.fromAdmission } : null, admissionBaseline: baseline ? { counts: baseline.counts, detail: baseline.detail } : null };
}

/** Jev requests/choices linked to executed actions for one goal. */
function jevSummary(g: GoalRun): Json {
  const ev = g.events;
  const rounds = ev.filter((e) => e.type === 'task_round');
  const choices = ev.filter((e) => e.type === 'task_choice');
  const actions = ev.filter((e) => e.type === 'task_action');
  const all = runEvents();
  const reqIds = new Set(rounds.map((r) => r.requestId));
  const responses = all.filter((e) => e.type === 'jev_response' && reqIds.has(e.requestId));
  return {
    jevRequests: all.filter((e) => e.type === 'jev_request' && reqIds.has(e.requestId)).length,
    jevResponses: responses.length,
    models: [...new Set(responses.map((r) => r.model))],
    providers: [...new Set(responses.map((r) => r.provider))],
    costUsd: responses.reduce((n, r) => n + Number(r.usage?.costUsd ?? 0), 0),
    choices: choices.map((c) => ({ requestId: c.requestId, capability: c.capability, description: String(c.description ?? '').slice(0, 100), confidence: c.confidence })),
    actions: actions.map((a) => ({ actionId: a.actionId, capability: a.capability, status: a.status, reason: a.reason ?? null, confirmation: a.confirmation, via: a.via, effect: String(a.effect ?? '').slice(0, 140) })),
    localContinuations: ev.filter((e) => e.type === 'task_local_continuation').length,
    tasks: ev.filter((e) => e.type === 'task_terminal').map((t) => ({ taskId: t.taskId, status: t.status, reason: t.reason, decisions: t.decisions, actions: t.actions })),
  };
}

function summarize(g: GoalRun, ev: string[], trials: Json[], extra: Json = {}): Json {
  const p = plannerSummary(g);
  const j = jevSummary(g);
  ev.push(`${g.goalId}: ${p.terminal.slice(0, 280)}`);
  ev.push(`  counters ${JSON.stringify(p.counters)}`);
  for (const pr of p.proposals) {
    ev.push(`  planner turn ${pr.turn} (${pr.turnKind}) ${pr.disposition}: ${String(pr.interpretation).slice(0, 200)}`);
    if (pr.outcome) ev.push(`    outcome ${JSON.stringify(pr.outcome).slice(0, 260)}`);
    for (const t of pr.tasks ?? []) ev.push(`    task [${t.allowedCapabilities.join(',')}] ${String(t.objective).slice(0, 120)} => ${JSON.stringify(t.completion).slice(0, 160)}`);
    if (pr.queries) ev.push(`    queries ${JSON.stringify(pr.queries).slice(0, 260)}`);
    if (pr.question) ev.push(`    question ${pr.question}`);
    if (pr.missing) ev.push(`    missing ${pr.missing}`);
  }
  for (const r of p.rejected) ev.push(`  REJECTED ${r.kind}: ${JSON.stringify(r.problems).slice(0, 300)}`);
  for (const t of p.turns) ev.push(`  codex turn ${t.turn} ${t.turnKind} ${t.elapsedMs}ms in=${t.usage?.inputTokens} out=${t.usage?.outputTokens} ${t.selectedModel}/${t.effort}`);
  ev.push(`  jev: requests=${j.jevRequests} responses=${j.jevResponses} models=${j.models.join(',')} providers=${j.providers.join(',')} cost=${j.costUsd.toFixed(6)} localContinuations=${j.localContinuations}`);
  for (const t of j.tasks) ev.push(`  task ${t.taskId} ${t.status} (${t.reason}) decisions=${t.decisions} actions=${t.actions}`);
  for (const o of p.outcomeEvals) ev.push(`  outcome after window ${o.window}: ${o.status} — ${String(o.detail).slice(0, 160)}`);
  const trial = { goalId: g.goalId, planner: p, jev: j, ...extra };
  trials.push(trial);
  return trial;
}

async function resetScene(): Promise<void> {
  // MB-FLOW-002-C4: no world change while any goal or preparation still owns control.
  await quiesce('before scene reset');
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

const jevRequestsTotal = () => runEvents().filter((e) => e.type === 'jev_request').length;
const plannerTurnsTotal = () => runEvents().filter((e) => e.type === 'planner_turn_started').length;

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  process.stdout.write(`planner-live-check (real Codex subscription planner; Jev ${jevMode}): fixture ${FIXTURE_PINS.host}:${FIXTURE_PINS.port}; report dir ${outDir}\n`);
  const base = JSON.parse(readFileSync(BASE_CONFIG, 'utf8')) as Json;
  const keyEnv = String(base.models?.decision?.apiKeyEnv ?? 'OPENROUTER_API_KEY');
  const env: NodeJS.ProcessEnv = { ...process.env };
  let decision = { ...base.models.decision };
  if (jevMode === 'real') {
    if (!process.env[keyEnv]) {
      process.stderr.write(`planner-live-check: ${keyEnv} is not set. Run with the key injected by the operator's credential helper, or use --jev fault for harness validation only.\n`);
      process.exitCode = 2;
      return;
    }
  } else {
    decision = { ...decision, endpoint: await startJevFault() };
    env[keyEnv] = 'fault-fixture-placeholder-key';
  }
  const cfg: Json = { ...base, storage: { ...base.storage, dataDir: join(PROJECT_ROOT, "var") }, models: { ...base.models, planner: { ...base.models.planner, mode: 'codex', command: REAL_CODEX }, decision }, ...(plannerTimeoutOverride ? { limits: { ...base.limits, plannerTimeoutMs: plannerTimeoutOverride } } : {}) };
  const configPath = join(outDir, 'fixture-planner.json');
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const list = await rconRaw('list').catch((error: unknown) => {
    throw new Error(`fixture not reachable over RCON (${String(error)}); run npm run fixture -- start`);
  });
  process.stdout.write(`fixture: ${list}\n`);
  const fixturePid = Number(readFileSync(fx.pidFile, 'utf8').trim());

  setRunLimits(cfg.limits);
  chunkbot = await startChunkbot(`run-planner-jev-${jevMode}`, configPath, env);
  const mainEvents = () => eventsPath;
  let owner: Bot | undefined;
  try {
    await check('P0', 'built CLI: real Codex planner gate passed on normal intake; Jev ready; status shows planner ready', async (ev) => {
      ev.push(chunkbot.lines.find((l) => l.text.startsWith('[chunkbot] planner: '))?.text ?? 'no planner line');
      chunkbot.send('status');
      ev.push(await chunkbot.waitFor(/\[status\] planner: ready — Codex subscription planner/, 10_000));
      ev.push(await chunkbot.waitFor(/\[status\] decision: ready/, 10_000));
      const iso = runEvents().find((e) => e.type === 'planner_isolation');
      assert(iso?.ok === true, 'isolation gate passed');
      ev.push(`isolation: cli ${iso.cliVersion}, selected ${iso.selectedModel}/${iso.effort}, env ${JSON.stringify(iso.envNames)}, stages ${JSON.stringify(iso.featureStages)}`);
      assert(!(iso.envNames as string[]).includes(keyEnv), 'the Jev key variable is not passed to the planner');
      owner = await fixtureBot('FixtureOwner');
      await resetScene();
      ev.push(`scene reset (${setupLog.length} setup commands so far)`);
    });

    // ------------------------------------------------------------ P1: come here (owner chat)
    await check('P1', '"come here" via owner chat: planner chooses an owner-proximity outcome; Jev moves; code verifies near owner; RCON distance', async (ev, trials) => {
      await setup('tp FixtureOwner 213.5 -60 205.5 90 0');
      await setup(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
      await sleep(1_500);
      const { goalId, from } = await submit('come here', 'chat', owner);
      const g = await waitTerminal(goalId, from, 6 * 60_000);
      summarize(g, ev, trials);
      const b = await serverPos();
      const o = await serverPos('FixtureOwner');
      ev.push(`RCON: Chunkbot ${b.x.toFixed(1)},${b.z.toFixed(1)} owner ${o.x.toFixed(1)},${o.z.toFixed(1)} distance ${dist(b, o).toFixed(2)}`);
      assert(g.state === 'completed' && g.reason === 'outcome_verified', `goal ${g.state} (${g.reason})`);
      assert(dist(b, o) <= 5, 'server distance to owner is small');
    });

    // ------------------------------------------------------------ P2: resource goal from an EMPTY inventory
    let p2Plan: Json | undefined;
    await check('P2', 'resource goal from an EMPTY inventory: planner-chosen wood/table/tool prerequisites; real controller executes; new cobblestone verified by code and RCON', async (ev, trials) => {
      await resetScene();
      await setup('tp FixtureOwner 200.5 -60 209.5 0 0');
      await sleep(1_000);
      const before = await serverInventory();
      ev.push(`RCON inventory before: ${JSON.stringify(before)}`);
      const { goalId, from } = await submit('get me two cobblestone', 'terminal');
      const g = await waitTerminal(goalId, from, 19 * 60_000);
      const t = summarize(g, ev, trials);
      p2Plan = t.planner;
      const after = await serverInventory();
      ev.push(`RCON inventory after: ${JSON.stringify(after)}`);
      const caps = new Set((t.planner.proposals as Json[]).flatMap((p) => (p.tasks ?? []).flatMap((x: Json) => x.allowedCapabilities)));
      ev.push(`capabilities chosen by the planner across windows: ${[...caps].join(', ')}`);
      assert(caps.has('craft_item'), 'the planner chose crafting prerequisites (no tool in the empty inventory)');
      assert(g.state === 'completed' && g.reason === 'outcome_verified', `goal ${g.state} (${g.reason})`);
      assert((after['minecraft:cobblestone'] ?? 0) >= 2, 'RCON: at least two cobblestone held');
    });

    // ------------------------------------------------------------ P3: same goal, PREPARED inventory
    await check('P3', 'same resource goal with a PREPARED inventory (pickaxe already owned): materially different plan without tool/workstation prerequisites', async (ev, trials) => {
      await resetScene();
      await setup('give Chunkbot minecraft:wooden_pickaxe 1');
      await setup('tp FixtureOwner 200.5 -60 209.5 0 0');
      await sleep(1_000);
      const { goalId, from } = await submit('get me two cobblestone', 'terminal');
      const g = await waitTerminal(goalId, from, 12 * 60_000);
      const t = summarize(g, ev, trials);
      const firstTasks = (t.planner.proposals as Json[]).find((p) => p.disposition === 'plan')?.tasks ?? [];
      const caps = new Set(firstTasks.flatMap((x: Json) => x.allowedCapabilities));
      const p2First = (p2Plan?.proposals as Json[] | undefined)?.find((p) => p.disposition === 'plan')?.tasks ?? [];
      ev.push(`P2 first window: ${p2First.map((x: Json) => `[${x.allowedCapabilities.join(',')}]`).join(' ')}`);
      ev.push(`P3 first window: ${firstTasks.map((x: Json) => `[${x.allowedCapabilities.join(',')}]`).join(' ')}`);
      assert(!caps.has('craft_item'), 'no crafting prerequisite when the tool is already owned');
      const after = await serverInventory();
      ev.push(`RCON inventory after: ${JSON.stringify(after)}`);
      assert(g.state === 'completed' && g.reason === 'outcome_verified', `goal ${g.state} (${g.reason})`);
    });

    // ------------------------------------------------------------ P4: MB-PLAN-006 no follow-up question + occluded target
    // Updated for MB-PLAN-006 (the previous clarification/answer scenario is retained in
    // historical reports only): the owner names the item but not where it is; Chunkbot must
    // act from grounded defaults WITHOUT asking — no question line, no awaiting_owner state,
    // no answer prompt — explore to find the occluded bread, collect it and deliver it.
    await check('P4', 'MB-PLAN-006: no follow-up question for an under-specified instruction (no question/answer prompt, never awaiting the owner); the item is initially occluded, so planner-selected exploration must move Chunkbot before pickup and delivery (RCON)', async (ev, trials) => {
      await resetScene();
      // PRETRIAL SETUP (recorded): the base scene's bread drop is deliberately unpickable (a
      // visibility fixture), so it is removed and a pickable bread is summoned at 203.5,-60,208.5.
      // From Chunkbot's start (205.5,-60,205.5) the chest at 203,-60,207 lies on the sight line to
      // this low item: honest line-of-sight perception does NOT report it until Chunkbot moves.
      await setup('kill @e[type=item,tag=chunkbot_front]');
      await setup('summon item 203.5 -60 208.5 {Item:{id:"minecraft:bread",count:1},PickupDelay:0s,Tags:["chunkbot_p4"]}');
      await setup('tp FixtureOwner 200.5 -60 209.5 0 0');
      await sleep(1_000);
      ev.push(`RCON pretrial: bread ${await rconRaw('data get entity @e[type=item,tag=chunkbot_p4,limit=1] Pos')}`);
      const { goalId, from } = await submit('bring me some bread', 'chat', owner);
      const g = await waitTerminal(goalId, from, 12 * 60_000);
      summarize(g, ev, trials);
      // No owner-facing question anywhere in this trial: terminal/chat lines, run events or journal.
      const lines = chunkbot.since(from);
      const questionLines = lines.filter((l) => /\[chunkbot\] .*(Question q\d+|answer q\d+|\?)/.test(l));
      ev.push(`owner-facing lines with a question/answer prompt: ${questionLines.length}${questionLines.length ? ` e.g. ${questionLines[0]!.slice(0, 160)}` : ''}`);
      assert(questionLines.length === 0, 'no follow-up question or answer prompt reached the terminal/chat');
      assert(!g.events.some((e) => e.type === 'clarification_requested' || (e.type === 'goal_state' && e.state === 'awaiting_owner')), 'never awaiting the owner');
      const refusals = g.events.filter((e) => e.type === 'planner_question_refused').length;
      ev.push(`planner proposals refused for asking the owner (counted repairs): ${refusals}`);
      // MB-PLAN-005: goal-correlated task/action evidence across ALL planner windows. The
      // planner may recover from a blocked window by replanning (e.g. a survey-only first
      // window ends no_progress, a replan explores); restricting to the first task was a
      // false negative. Every event used here carries this goal's id.
      const at = (e: Json) => Date.parse(String(e.t));
      const ordered = g.events.map((e, i) => ({ e, i })).sort((x, y) => at(x.e) - at(y.e) || x.i - y.i).map((x) => x.e);
      const baseline = ordered.find((e) => e.type === 'goal_admission_baseline');
      ev.push(`admission baseline: ${baseline ? `${baseline.detail} ${JSON.stringify(baseline.counts)} at ${baseline.t}` : 'MISSING'}`);
      const windowOf = (e: Json) => {
        let w: Json | undefined;
        for (const x of ordered) {
          if (x === e) break;
          if (x.type === 'goal_window') w = x;
        }
        return w?.window as number | undefined;
      };
      const actions = ordered.filter((e) => e.type === 'task_action');
      const runs = (list: Json[]) => {
        const out: string[] = [];
        let prev = '';
        let n = 0;
        for (const a of list) {
          const k = `${a.capability}:${a.status}`;
          if (k === prev) n += 1;
          else {
            if (n) out.push(n > 1 ? `${prev} x${n}` : prev);
            prev = k;
            n = 1;
          }
        }
        if (n) out.push(n > 1 ? `${prev} x${n}` : prev);
        return out.join(', ') || 'no actions';
      };
      for (const t of ordered.filter((e) => e.type === 'task_started')) {
        const term = ordered.find((e) => e.type === 'task_terminal' && e.taskId === t.taskId);
        const own = actions.filter((a) => a.taskId === t.taskId);
        ev.push(`window ${windowOf(t) ?? '?'} task ${t.taskId} [${(t.allowedCapabilities ?? []).join(',')}] "${String(t.objective).slice(0, 100)}" => ${term ? `${term.status} (${term.reason})` : 'no terminal'}; actions: ${runs(own)}`);
      }
      const explore = actions.find((a) => a.capability === 'explore_frontier' && a.status === 'succeeded');
      const preExplore = explore ? actions.filter((a) => at(a) < at(explore)) : actions;
      const surveys = actions.filter((a) => a.capability === 'survey_surroundings');
      const surveyDrops = surveys.filter((a) => !explore || at(a) < at(explore)).map((a) => Number(a.evidence?.drops ?? 0));
      ev.push(`survey_surroundings actions (observation only, no movement or collection): ${surveys.length} goal-wide; drops visible in the pre-exploration surveys: max ${surveyDrops.length ? Math.max(...surveyDrops) : 'n/a'}`);
      ev.push(`first successful planner-selected exploration: ${explore ? `window ${windowOf(explore)} task ${explore.taskId} at ${explore.t}: ${String(explore.effect).slice(0, 160)}` : 'NONE'}`);
      // Code-verified bread evidence: acquisition relative to the admission baseline.
      const breadNode = (n: Json | undefined): Json | undefined => {
        if (!n) return undefined;
        if (n.evidence?.selector === 'minecraft:bread') return n;
        for (const c of (n.children ?? []) as Json[]) {
          const f = breadNode(c);
          if (f) return f;
        }
        return undefined;
      };
      const acquired = (evd: Json) => Number(evd.acquired ?? Number(evd.current ?? 0) - Number(evd.baseline ?? 0));
      const breadChecks = ordered.filter((e) => e.type === 'task_completion' && e.evidence?.selector === 'minecraft:bread');
      const finalEvidence = g.journal.find((e) => e.type === 'goal_final_evidence');
      const finalBread = breadNode(finalEvidence?.evaluation as Json | undefined);
      const held: Array<{ t: number; what: string }> = [
        ...actions.filter((a) => a.capability === 'pickup_item' && a.status === 'succeeded').map((a) => ({ t: at(a), what: `pickup_item action (window ${windowOf(a)}) at ${a.t}` })),
        ...breadChecks.filter((e) => acquired(e.evidence) >= 1).map((e) => ({ t: at(e), what: `task ${e.taskId} completion check at ${e.t}: ${e.detail}` })),
        ...(finalEvidence && finalBread && acquired(finalBread.evidence) >= 1 ? [{ t: at(finalEvidence), what: `final goal outcome evidence at ${finalEvidence.t}: ${finalBread.detail} (${finalBread.evidence.source})` }] : []),
      ].sort((x, y) => x.t - y.t);
      const notHeld: Array<{ t: number; what: string }> = [
        ...(baseline ? [{ t: at(baseline), what: `admission baseline at ${baseline.t}` }] : []),
        ...breadChecks.filter((e) => acquired(e.evidence) < 1).map((e) => ({ t: at(e), what: `task ${e.taskId} completion check at ${e.t}: ${e.detail}` })),
      ].filter((x) => !explore || x.t < at(explore));
      const lastNotHeld = notHeld[notHeld.length - 1];
      const firstHeld = held[0];
      const pickedByAction = actions.some((a) => a.capability === 'pickup_item' && a.status === 'succeeded');
      const between = lastNotHeld && firstHeld ? actions.filter((a) => at(a) > lastNotHeld.t && at(a) <= firstHeld.t && a.status === 'succeeded') : [];
      ev.push(`bread acquisition (code-verified, since admission): last not-held evidence before exploration = ${lastNotHeld?.what ?? 'none'}; first held evidence = ${firstHeld?.what ?? 'none'}; goal actions in between: ${between.map((a) => `${a.capability} (window ${windowOf(a)})`).join(', ') || 'none'}`);
      ev.push(`collection: ${pickedByAction ? 'by a pickup_item action' : 'vanilla auto-pickup while moving (no pickup_item action was executed)'}; actions before the exploration: ${runs(preExplore)}`);
      const inv = await serverInventory();
      const b = await serverPos();
      const o = await serverPos('FixtureOwner');
      ev.push(`RCON: inventory ${JSON.stringify(inv)}; Chunkbot ${dist(b, o).toFixed(2)} blocks from the owner; bread entity left: ${await rconRaw('execute if entity @e[type=item,tag=chunkbot_p4]')}`);
      assert(g.state === 'completed' && g.reason === 'outcome_verified', `goal ${g.state} (${g.reason})`);
      assert(baseline !== undefined, 'the goal admission baseline was captured');
      assert(explore !== undefined, 'a planner-selected exploration action succeeded for this goal (the item was occluded from the start)');
      assert(lastNotHeld !== undefined && firstHeld !== undefined, 'code-verified bread evidence exists both before the exploration (not held) and after it (held)');
      assert(firstHeld!.t > at(explore!), 'the successful exploration preceded every code-verified acquisition of the bread');
      assert((inv['minecraft:bread'] ?? 0) >= 1, 'RCON: bread held');
    });

    // ------------------------------------------------------------ P5: novel composition (no code/prompt edits)
    await check('P5', 'novel composition chosen at acceptance (craft planks and store them in the chest): new task window/predicates composed from the catalog; container outcome verified', async (ev, trials) => {
      await resetScene();
      await setup('tp FixtureOwner 200.5 -60 209.5 0 0');
      await sleep(1_000);
      const { goalId, from } = await submit('make four oak planks and put them in the chest', 'chat', owner);
      const g = await waitTerminal(goalId, from, 15 * 60_000);
      summarize(g, ev, trials);
      const chest = await rconRaw(`data get block ${SCENE.chest.x} ${SCENE.chest.y} ${SCENE.chest.z} Items`);
      ev.push(`RCON chest: ${chest.slice(0, 300)}`);
      assert(g.state === 'completed' && g.reason === 'outcome_verified', `goal ${g.state} (${g.reason})`);
      assert(/oak_planks/.test(chest), 'RCON: planks in the chest');
    });

    // ------------------------------------------------------------ P6: persistent follow (quiet)
    await check('P6', '"follow me" (persistent): stays active while the owner walks; maintenance is quiet local observation (bounded planner/Jev calls); stop clears it', async (ev, trials) => {
      await resetScene();
      await setup('tp FixtureOwner 213.5 -60 199.5 0 0');
      await setup('tp Chunkbot 207.5 -60 199.5 0 0');
      await sleep(1_500);
      const { goalId, from } = await submit('follow me', 'chat', owner);
      await chunkbot.waitSince(/\[task-json\] \{"kind":"task_started"/, from, 4 * 60_000);
      const turnsAtStart = plannerTurnsTotal();
      const jevAtStart = jevRequestsTotal();
      const path = [[211.5, 201.5], [213.5, 203.5], [213.5, 206.5], [211.5, 208.5], [209.5, 206.5], [209.5, 203.5], [211.5, 201.5], [213.5, 199.5]];
      for (const [x, z] of path) {
        await intervene(`tp FixtureOwner ${x} -60 ${z}`, 'owner walks during the persistent follow');
        await sleep(4_000);
      }
      const turnsDuring = plannerTurnsTotal() - turnsAtStart;
      const jevDuring = jevRequestsTotal() - jevAtStart;
      const status = runEvents().filter((e) => e.goalId === goalId && e.type === 'goal_terminal');
      const b = await serverPos();
      const o = await serverPos('FixtureOwner');
      ev.push(`~32s of following: planner turns ${turnsDuring}, Jev requests ${jevDuring}, local continuations ${runEvents().filter((e) => e.goalId === goalId && e.type === 'task_local_continuation').length}; RCON distance ${dist(b, o).toFixed(1)}`);
      assert(status.length === 0, 'the persistent goal is still active (no false no-progress/terminal)');
      assert(turnsDuring <= 1 && jevDuring <= 3, `quiet maintenance (planner turns ${turnsDuring}, Jev ${jevDuring})`);
      const stopAt = chunkbot.send('stop');
      const line = await chunkbot.waitSince(new RegExp(`Goal ${goalId} cancelled \\(owner_stop\\)`), from, 10_000);
      ev.push(`stop -> cancelled in ${(chunkbot.lines.find((l) => l.text === line)?.atMs ?? Date.now()) - stopAt} ms (includes the bounded wait for the follow action to return)`);
      const evs = runEvents();
      const stopEv = evs.findLast((e) => e.type === 'stop_requested' && e.goalId === goalId) ?? { t: new Date().toISOString() };
      const lease = evs.find((e) => e.type === 'lease_revoked' && e.reason === 'owner_stop' && Date.parse(e.t) >= Date.parse(stopEv?.t ?? '0'));
      ev.push(`control clear: lease_revoked ${lease ? `${Date.parse(lease.t) - Date.parse(stopEv.t)} ms after stop_requested, clearMs ${lease.clearMs}, steps ${JSON.stringify(lease.steps)}` : 'not found'}`);
      assert(lease && Date.parse(lease.t) - Date.parse(stopEv.t) <= 250 && lease.clearMs <= 250, 'controls cleared within 250 ms of the accepted stop');
      const g = await waitTerminal(goalId, from, 5_000);
      summarize(g, ev, trials);
    });

    // ------------------------------------------------------------ P8: prerequisite removed mid-goal -> outcome-preserving replan
    await check('P8', 'a prerequisite is removed as the first window starts (the owned pickaxe is cleared): verified feedback leads to a REVISED plan with new prerequisites; the accepted outcome is preserved and verified', async (ev, trials) => {
      await resetScene();
      await setup('give Chunkbot minecraft:wooden_pickaxe 1');
      await setup('tp FixtureOwner 200.5 -60 209.5 0 0');
      await sleep(1_000);
      const { goalId, from } = await submit('get me two cobblestone', 'terminal');
      await chunkbot.waitSince(new RegExp(`\\[chunkbot\\] Goal ${goalId} window 1: `), from, 5 * 60_000);
      await intervene('clear Chunkbot minecraft:wooden_pickaxe', 'remove the owned tool prerequisite just as the first task window starts');
      const g = await waitTerminal(goalId, from, 19 * 60_000);
      const t = summarize(g, ev, trials);
      const plans = (t.planner.proposals as Json[]).filter((p) => p.disposition === 'plan');
      const outcomes = new Set(plans.map((p) => JSON.stringify(p.outcome)));
      const laterCaps = new Set(plans.slice(1).flatMap((p) => (p.tasks ?? []).flatMap((x: Json) => x.allowedCapabilities)));
      ev.push(`plans: ${plans.length}; distinct outcomes across revisions: ${outcomes.size}; capabilities in revised windows: ${[...laterCaps].join(', ')}`);
      const inv = await serverInventory();
      ev.push(`RCON inventory: ${JSON.stringify(inv)}`);
      assert(plans.length >= 2 && (t.planner.counters?.replans ?? 0) >= 1, 'at least one replan after the removed prerequisite');
      assert(outcomes.size === 1, 'the accepted outcome is identical in every revision');
      assert(laterCaps.has('craft_item'), 'the revised plan adds tool prerequisites');
      assert(g.state === 'completed' && g.reason === 'outcome_verified', `goal ${g.state} (${g.reason})`);
      assert((inv['minecraft:cobblestone'] ?? 0) >= 2, 'RCON: two cobblestone');
    });

    // ------------------------------------------------------------ P9: stone vs cobblestone (exact item identity)
    await check('P9', '"make me two stone" with cobblestone already held: the outcome names minecraft:stone (not cobblestone); the planner chooses furnace/fuel/smelting steps; RCON stone items', async (ev, trials) => {
      await resetScene();
      await setup('give Chunkbot minecraft:cobblestone 10');
      await setup('give Chunkbot minecraft:oak_log 2');
      await setup('give Chunkbot minecraft:crafting_table 1');
      await setup('tp FixtureOwner 200.5 -60 209.5 0 0');
      await sleep(1_000);
      const before = await serverInventory();
      ev.push(`RCON inventory before: ${JSON.stringify(before)}`);
      const { goalId, from } = await submit('make me two stone', 'chat', owner);
      const g = await waitTerminal(goalId, from, 19 * 60_000);
      const t = summarize(g, ev, trials);
      const outcome = JSON.stringify((t.planner.proposals as Json[]).find((p) => p.disposition === 'plan')?.outcome ?? {});
      const caps = new Set((t.planner.proposals as Json[]).flatMap((p) => (p.tasks ?? []).flatMap((x: Json) => x.allowedCapabilities)));
      const queries = (t.planner.proposals as Json[]).flatMap((p) => p.queries ?? []);
      ev.push(`accepted outcome ${outcome}; knowledge queries ${JSON.stringify(queries)}; capabilities ${[...caps].join(', ')}`);
      const after = await serverInventory();
      ev.push(`RCON inventory after: ${JSON.stringify(after)}`);
      assert(/minecraft:stone"/.test(outcome) && !/cobblestone/.test(outcome), 'the outcome is about stone items, not cobblestone');
      assert([...caps].some((c) => c.startsWith('furnace_')), 'the planner chose furnace processing');
      assert(g.state === 'completed' && g.reason === 'outcome_verified', `goal ${g.state} (${g.reason})`);
      assert((after['minecraft:stone'] ?? 0) >= 2, 'RCON: two stone items');
    });

    // ------------------------------------------------------------ P10: unsupported mechanic -> exact evidence, no action
    await check('P10', 'an instruction needing an unimplemented mechanic gets an exact cannot-execute explanation (not a keyword rejection) and no action', async (ev, trials) => {
      await resetScene();
      await setup('give Chunkbot minecraft:wooden_pickaxe 1');
      await sleep(800);
      const before = await serverPos();
      const { goalId, from } = await submit('enchant your pickaxe with efficiency', 'chat', owner);
      const g = await waitTerminal(goalId, from, 6 * 60_000);
      summarize(g, ev, trials);
      const after = await serverPos();
      const detail = String(g.events.find((e) => e.type === 'goal_terminal')?.detail ?? '');
      ev.push(`terminal detail: ${detail.slice(0, 400)}; moved ${dist(before, after).toFixed(2)}`);
      assert(g.reason === 'cannot_execute', `goal ${g.state} (${g.reason})`);
      assert(detail.length > 30 && /enchant/i.test(detail), 'the missing mechanic is named');
      assert(!g.events.some((e) => e.type === 'task_admitted') || g.events.filter((e) => e.type === 'task_action').length === 0, 'no world action for an unsupported mechanic');
    });

    // ------------------------------------------------------------ P7: stop/replacement during planning; anchor
    await check('P7', 'stop and replacement while a planner turn is in flight: own process group killed, no late output/action; admission anchor survives a server correction and a replacement gets a fresh anchor', async (ev, trials) => {
      await resetScene();
      await setup(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
      await sleep(1_000);
      // Stop during planning.
      const a = await submit('collect three oak logs', 'terminal');
      await chunkbot.waitSince(/planner_turn_started|Planning/, a.from, 5_000).catch(() => undefined);
      await sleep(1_500);
      const stopAt = chunkbot.send('stop');
      const stopLine = await chunkbot.waitSince(new RegExp(`Goal ${a.goalId} cancelled \\(owner_stop\\)`), a.from, 10_000);
      ev.push(`stop during planning -> cancelled in ${(chunkbot.lines.find((l) => l.text === stopLine)?.atMs ?? Date.now()) - stopAt} ms`);
      await sleep(3_000);
      const ga = await waitTerminal(a.goalId, a.from, 5_000);
      const cleanupA = runEvents().filter((e) => e.type === 'planner_process_cleanup' && e.goalId === a.goalId);
      ev.push(`planner process cleanup: ${JSON.stringify(cleanupA.map((c) => ({ pid: c.pid, signals: c.signals, elapsedMs: c.elapsedMs, remaining: c.remaining, ownedBefore: c.ownedBefore })))}`);
      assert(cleanupA.length >= 1 && cleanupA.every((c) => (c.remaining as number[]).length === 0), 'owned planner process group terminated with nothing left');
      assert(!ga.events.some((e) => e.type === 'task_admitted' || e.type === 'planner_proposal'), 'no proposal/task from the aborted turn');
      summarize(ga, ev, trials);
      // Anchor: admission position kept through a server correction during planning; replacement re-anchors.
      const b = await submit('collect three oak logs', 'terminal');
      await sleep(1_200);
      await intervene(`tp Chunkbot ${SCENE.start.x + 6} ${SCENE.start.y} ${SCENE.start.z} 0 0`, 'server correction (teleport) while the planner turn is in flight');
      await sleep(1_500);
      const c = await submit('come here', 'chat', owner);
      const replaced = await chunkbot.waitSince(new RegExp(`Goal ${b.goalId} cancelled \\(replaced\\)`), b.from, 15_000);
      ev.push(replaced);
      const anchors = runEvents().filter((e) => e.type === 'goal_travel_anchor');
      const aB = anchors.find((e) => e.goalId === b.goalId)?.anchor;
      const aC = anchors.find((e) => e.goalId === c.goalId)?.anchor;
      ev.push(`anchor of the replaced goal ${JSON.stringify(aB)} (admitted at the start position); replacement anchor ${JSON.stringify(aC)} (after the correction)`);
      assert(aB && Math.abs(aB.x - SCENE.start.x) < 0.6, 'admission anchor at the admission position');
      assert(aC && Math.abs(aC.x - (SCENE.start.x + 6)) < 1.0, 'fresh anchor for the replacement at the corrected position');
      const cleanupB = runEvents().filter((e) => e.type === 'planner_process_cleanup' && e.goalId === b.goalId);
      ev.push(`replaced goal planner cleanup: ${JSON.stringify(cleanupB.map((x) => ({ signals: x.signals, remaining: x.remaining })))}`);
      const gc = await waitTerminal(c.goalId, c.from, 6 * 60_000);
      summarize(gc, ev, trials);
      const firstAction = gc.events.find((e) => e.type === 'task_action');
      ev.push(`replacement first action: ${firstAction ? `${firstAction.capability} ${firstAction.status}` : 'none'}; anchor unchanged after it: ${JSON.stringify(runEvents().filter((e) => e.type === 'goal_travel_anchor' && e.goalId === c.goalId).map((e) => e.anchor))}`);
    });

    // ------------------------------------------------------------ P11: death during planning
    await check('P11', 'death while a planner turn is in flight ends goal ownership (failed: death), kills the planner process group, admits no task; respawn stays idle', async (ev, trials) => {
      await resetScene();
      await sleep(500);
      const { goalId, from } = await submit('collect three oak logs', 'terminal');
      await sleep(2_000);
      await intervene('kill Chunkbot', 'lifecycle fault: the bot dies while the planner turn is in flight');
      const g = await waitTerminal(goalId, from, 30_000);
      summarize(g, ev, trials);
      const cleanup = g.events.filter((e) => e.type === 'planner_process_cleanup');
      ev.push(`planner cleanup ${JSON.stringify(cleanup.map((c) => ({ signals: c.signals, remaining: c.remaining, elapsedMs: c.elapsedMs })))}`);
      assert(g.state === 'failed' && g.reason === 'death', `goal ${g.state} (${g.reason})`);
      assert(cleanup.length >= 1 && cleanup.every((c) => (c.remaining as number[]).length === 0), 'planner process group cleaned');
      assert(!g.events.some((e) => e.type === 'task_admitted'), 'no task after death');
      await chunkbot.waitSince(/\[chunkbot\] respawned in .*idle/, from, 20_000);
      chunkbot.send('status');
      ev.push(await chunkbot.waitSince(new RegExp(`\\[status\\] goal: ${goalId} failed`), from, 10_000));
    });
  } finally {
    try {
      owner?.quit();
    } catch {
      // ignore
    }
    chunkbot.send('/quit');
    const exited = await Promise.race([chunkbot.exited, sleep(15_000).then(() => undefined)]);
    if (!exited) chunkbot.child.kill('SIGKILL');
    chunkbot.save(outDir);
    process.stdout.write(`main CLI exited ${JSON.stringify(exited)}; evidence ${mainEvents()}\n`);
  }

  // ------------------------------------------------------------ planner FAULT FIXTURE process (labeled)
  const faultDir = join(outDir, 'fault-planner');
  mkdirSync(faultDir, { recursive: true });
  const faultCodex = writeFaultCodex(faultDir, REAL_CODEX);
  const faultCfg = { ...cfg, models: { ...cfg.models, planner: { ...cfg.models.planner, command: faultCodex } }, limits: { ...cfg.limits, plannerTimeoutMs: 4_000, plannerTurnsPerGoal: 5 } };
  const faultConfigPath = join(faultDir, 'fixture-fault-planner.json');
  writeFileSync(faultConfigPath, `${JSON.stringify(faultCfg, null, 2)}\n`);
  const turnsFor = (turns: FaultTurn[], authMode: FaultAuthMode = 'passthrough') => setFaultTurns(faultDir, REAL_CODEX, turns, authMode);
  const valid = (interpretation: string): Json => ({
    disposition: 'plan',
    interpretation,
    outcome: { kind: 'finite', predicate: wp({ predicate: 'near_target', target: wt({ kind: 'owner' }), within: 3 }) },
    tasks: [{ objective: 'Walk to the owner.', decisionInstruction: 'Move next to the owner.', allowedCapabilities: ['move_near'], targetSelectors: [wt({ kind: 'owner' })], parameters: [], completion: wp({ predicate: 'near_target', target: wt({ kind: 'owner' }), within: 3 }) }],
    morePlanningNeeded: false,
    queries: [],
    question: null,
    missing: null,
    missingCapabilities: [],
    verifiedProgress: null,
  });
  setRunLimits(faultCfg.limits);
  chunkbot = await startChunkbot('run-fault-planner', faultConfigPath, env);
  try {
    await check('F1', 'PLANNER FAULT FIXTURE: code-bearing text, an invented observation handle and invented owner coordinates are rejected before any action; bounded repairs; Chunkbot stays put (RCON)', async (ev, trials) => {
      const invented = valid('Go somewhere.');
      invented.tasks[0].targetSelectors = [wt({ kind: 'observed', snapshotId: 'snap-inventedx', handle: 'blk-424242' })];
      const coords = valid('Walk to the meeting point.');
      coords.outcome.predicate = wp({ predicate: 'near_target', target: wt({ kind: 'owner_destination', dimension: 'overworld', at: { x: 300, y: -60, z: 300 }, ownerText: 'the meeting point at 300 -60 300' }), within: 2 });
      turnsFor([
        { kind: 'proposal', proposal: { ...valid('Run this: function go() { bot.dig(block) }') } },
        { kind: 'proposal', proposal: invented },
        { kind: 'proposal', proposal: coords },
      ]);
      await setup(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
      await sleep(1_000);
      const before = await serverPos();
      const { goalId, from } = await submit('go to the meeting point', 'terminal');
      const g = await waitTerminal(goalId, from, 60_000);
      summarize(g, ev, trials);
      const after = await serverPos();
      const rejected = g.events.filter((e) => e.type === 'planner_proposal_rejected');
      ev.push(`rejections: ${rejected.map((r) => `${r.kind}`).join(', ')}; moved ${dist(before, after).toFixed(2)} blocks`);
      assert(g.state === 'blocked' && g.reason === 'invalid_proposal', `goal ${g.state} (${g.reason})`);
      assert(rejected.length === 3 && !g.events.some((e) => e.type === 'task_admitted'), 'three rejections, no task admitted');
      assert(dist(before, after) < 0.5, 'stationary');
      assert(/not supplied by the owner/.test(JSON.stringify(rejected.at(-1)?.problems)), 'invented coordinates rejected even with an ownerText label');
    });

    await check('F2', 'PLANNER FAULT FIXTURE: subscription quota and auth failures block with actionable evidence and no fallback; no action', async (ev) => {
      for (const kind of ['quota', 'auth'] as const) {
        turnsFor([{ kind }]);
        const { goalId, from } = await submit(`walk around a bit (${kind} fault)`, 'terminal');
        const g = await waitTerminal(goalId, from, 30_000);
        ev.push(g.terminalLine.replace(/^\[chunkbot\] /, '').slice(0, 300));
        assert(g.state === 'blocked' && g.reason === 'planner_not_ready', `${kind}: ${g.state} (${g.reason})`);
        const detail = String(g.events.find((e) => e.type === 'goal_terminal')?.detail ?? '');
        ev.push(`  full detail: ${detail}`);
        assert(new RegExp(kind === 'quota' ? 'usage limit.*no paid or alternative planner' : 'codex login.*no API-key or other planner').test(detail), `${kind}: actionable text`);
        assert(!g.events.some((e) => e.type === 'task_admitted'), 'no task');
      }
    });

    await check('F3', 'PLANNER FAULT FIXTURE: a hanging planner (with an attributable child process) hits the turn timeout, is killed with its group/children, retried once, then the goal fails; nothing left running', async (ev) => {
      turnsFor([{ kind: 'hang' }]);
      const { goalId, from } = await submit('do something slow', 'terminal');
      const g = await waitTerminal(goalId, from, 60_000);
      ev.push(g.terminalLine.replace(/^\[chunkbot\] /, '').slice(0, 300));
      const cleanups = g.events.filter((e) => e.type === 'planner_process_cleanup');
      ev.push(`cleanups: ${JSON.stringify(cleanups.map((c) => ({ pid: c.pid, ownedBefore: c.ownedBefore, signals: c.signals, remaining: c.remaining, elapsedMs: c.elapsedMs })))}`);
      const child = JSON.parse(readFileSync(join(faultDir, 'fault-codex-hang-child.json'), 'utf8')) as { child: number };
      let alive = true;
      try {
        process.kill(child.child, 0);
      } catch {
        alive = false;
      }
      ev.push(`attributable child ${child.child} alive after cleanup: ${alive}`);
      assert(g.state === 'failed' && g.reason === 'planner_error', `goal ${g.state} (${g.reason})`);
      assert(cleanups.length === 2 && cleanups.every((c) => (c.remaining as number[]).length === 0 && (c.ownedBefore as number[]).length >= 2), 'two timed-out turns, each group (with its child) fully cleaned');
      assert(!alive, 'the attributable child process is gone');
      assert((g.events.find((e) => e.type === 'goal_terminal')?.counters?.retries ?? 0) === 1, 'one bounded retry counted');
    });

    await check('F4', 'PLANNER FAULT FIXTURE: knowledge rounds count toward the turn limit; the goal ends limit_exhausted with counters preserved', async (ev) => {
      const info = { disposition: 'needs_information', interpretation: 'I need the recipe first.', outcome: null, tasks: [], morePlanningNeeded: false, queries: [{ kind: 'recipe', key: 'minecraft:crafting_table' }], question: null, missing: null, missingCapabilities: [], verifiedProgress: null };
      turnsFor([{ kind: 'proposal', proposal: info }]);
      const { goalId, from } = await submit('make a crafting table', 'terminal');
      const g = await waitTerminal(goalId, from, 60_000);
      const c = g.events.find((e) => e.type === 'goal_terminal')?.counters;
      ev.push(`${g.terminalLine.replace(/^\[chunkbot\] /, '').slice(0, 300)}; counters ${JSON.stringify(c)}`);
      assert(g.reason === 'limit_exhausted' && c?.plannerTurns === 5 && c?.knowledgeRounds === 5, 'five knowledge turns exhausted the configured limit of 5');
    });

    await check('F7', 'PLANNER FAULT FIXTURE (MB-PLAN-002): a login switched to a persisted API key after startup is refused before any planner exec (mode-only evidence, no fallback); the subscription login then works again', async (ev) => {
      turnsFor([{ kind: 'proposal', proposal: valid('Walk to the owner.') }], 'api_key');
      const { goalId, from } = await submit('walk to me (api-key login fault)', 'terminal');
      const g = await waitTerminal(goalId, from, 30_000);
      const detail = String(g.events.find((e) => e.type === 'goal_terminal')?.detail ?? '');
      ev.push(`${g.terminalLine.replace(/^\[chunkbot\] /, '').slice(0, 200)}`);
      ev.push(`full detail: ${detail}`);
      const rejected = g.events.filter((e) => e.type === 'planner_auth_rejected');
      assert(g.state === 'blocked' && g.reason === 'planner_not_ready' && /auth mode api_key/.test(detail), `goal ${g.state} (${g.reason})`);
      assert(rejected.length === 1 && rejected[0]!.authMode === 'api_key' && !g.events.some((e) => e.type === 'planner_turn_started'), 'refused before any exec turn');
      assert(!/sk-fixtu/.test(JSON.stringify(runEvents())), 'no key fragment in evidence');
      assert(JSON.parse(readFileSync(join(faultDir, 'fault-codex-counter.json'), 'utf8')).n === 0, 'the fixture exec was never invoked');
      turnsFor([{ kind: 'proposal', proposal: { disposition: 'cannot_execute', interpretation: 'nothing', outcome: null, tasks: [], morePlanningNeeded: false, queries: [], question: null, missing: 'fixture: no action wanted', missingCapabilities: [], verifiedProgress: null } }], 'chatgpt');
      const again = await submit('anything (subscription login restored)', 'terminal');
      const g2 = await waitTerminal(again.goalId, again.from, 30_000);
      ev.push(`after restoring the subscription login: ${g2.terminalLine.replace(/^\[chunkbot\] /, '').slice(0, 160)}`);
      assert(g2.reason === 'cannot_execute', 'the planner ran again on the subscription login');
    });

    await check('F5', 'PLANNER FAULT FIXTURE: a model-reroute event rejects the turn even though a valid plan followed; the planner is disabled for the run (no fallback)', async (ev) => {
      turnsFor([{ kind: 'reroute', proposal: valid('Walk to the owner.') }]);
      const { goalId, from } = await submit('walk to me', 'terminal');
      const g = await waitTerminal(goalId, from, 30_000);
      ev.push(g.terminalLine.replace(/^\[chunkbot\] /, '').slice(0, 300));
      assert(g.reason === 'planner_error' && /model_mismatch/.test(g.terminalLine), 'model mismatch');
      assert(!g.events.some((e) => e.type === 'task_admitted'), 'no task from the rerouted turn');
      chunkbot.send('status');
      ev.push(await chunkbot.waitFor(/\[status\] planner: not-ready — Codex subscription planner disabled for this run/, 10_000));
    });
  } finally {
    chunkbot.send('/quit');
    const exited = await Promise.race([chunkbot.exited, sleep(15_000).then(() => undefined)]);
    if (!exited) chunkbot.child.kill('SIGKILL');
    chunkbot.save(outDir);
  }

  // A separate fault process for the prohibited tool event (the reroute disabled the previous one).
  chunkbot = await startChunkbot('run-fault-planner-tool', faultConfigPath, env);
  try {
    await check('F6', 'PLANNER FAULT FIXTURE: a prohibited tool event (command_execution) rejects the turn even with a valid final plan; planner disabled; no action', async (ev) => {
      turnsFor([{ kind: 'tool', proposal: valid('Walk to the owner.') }]);
      const { goalId, from } = await submit('walk to me', 'terminal');
      const g = await waitTerminal(goalId, from, 30_000);
      ev.push(g.terminalLine.replace(/^\[chunkbot\] /, '').slice(0, 300));
      assert(g.reason === 'planner_error' && /prohibited_event/.test(g.terminalLine), 'prohibited event');
      assert(!g.events.some((e) => e.type === 'task_admitted'), 'no task');
    });
  } finally {
    chunkbot.send('/quit');
    const exited = await Promise.race([chunkbot.exited, sleep(15_000).then(() => undefined)]);
    if (!exited) chunkbot.child.kill('SIGKILL');
    chunkbot.save(outDir);
    faultServer?.close();
  }

  const passed = results.filter((r) => r.pass).length;
  const report = {
    kind: 'mb-v1-04-planner-live-check',
    planner: 'REAL Codex subscription planner (isolated codex exec) for P*; scripted PLANNER FAULT FIXTURE (real CLI gate) for F*',
    jevMode,
    acceptanceEvidence: jevMode === 'real' ? 'real Codex planner + real OpenRouter Jev + real Minecraft (P*)' : 'real Codex planner with a FAULT-FIXTURE Jev provider (harness validation only, NOT Jev acceptance)',
    startedAt: stamp,
    fixture: { host: FIXTURE_PINS.host, port: FIXTURE_PINS.port, version: FIXTURE_PINS.minecraftVersion, pid: fixturePid },
    passed,
    total: results.length,
    results,
    setupCommands: setupLog,
    inTrialInterventions: interventions,
    interScenarioQuiescence: quiesceLog,
    submissions,
    faultHangChildFile: existsSync(join(faultDir, 'fault-codex-hang-child.json')) ? JSON.parse(readFileSync(join(faultDir, 'fault-codex-hang-child.json'), 'utf8')) : null,
  };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\n${passed}/${results.length} planner scenarios passed (Jev ${jevMode}); report ${join(outDir, 'report.json')}\n`);
  process.exitCode = passed === results.length ? 0 : 1;
}

/** Wire predicate with all nullable fields (fault fixture proposals use the real wire format). */
function wp(p: Json): Json {
  const base: Json = { predicate: null, selector: null, atLeast: null, mode: null, mayBeConsumedLater: null, slot: null, target: null, within: null, expect: null, output: null, outcome: null, of: null };
  return { ...base, ...p };
}
function wt(t: Json): Json {
  const base: Json = { kind: null, key: null, snapshotId: null, handle: null, anchorId: null, dimension: null, at: null, ownerText: null, actionId: null };
  return { ...base, ...t };
}

main().catch((error: unknown) => {
  process.stderr.write(`planner-live-check error: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
