// MB-PLAN-006 combined ORDINARY-GOAL live check against a LOCAL TEST FIXTURE.
//
// Drives the REAL built CLI (`node dist/cli.js run`) through ordinary owner chat
// (`!chunkbot <words>`) with the REAL Codex subscription planner and Jev
// (`--jev real`, default; the coordinator injects OPENROUTER_API_KEY) or a
// LOOPBACK Jev fault provider (`--jev fault`: first-ranked option; harness
// validation only, never Jev acceptance). Workers never run it: it performs
// real subscription planner inference. World truth comes from RCON.
//
// The commands are REGRESSION EXAMPLES of open-ended goals (no phrase handler
// exists); every scenario asserts the MB-PLAN-006 no-question boundary: no
// question/answer prompt on chat or terminal, never `awaiting_owner`, and
// counted planner refusals recorded as evidence.
//
//   O1  one visible chicken: "kill that chicken" -> that chicken defeated (server death
//       status in the action evidence, RCON entity gone); the owner is never attacked
//   O2  two chickens + a nearer cow: "kill the chicken" -> exactly the CLOSER chicken defeated;
//       the farther chicken and the cow stay alive (RCON)
//   O3  floating birch remnant beside grounded oak trees: "remove that floating tree" -> every
//       birch log position no longer birch (RCON); every oak log intact
//   O4  "set up your house here" with the owner visible at a vacant flat site: a verified home
//       (structure_state complete) near the owner's position; `--house-materials provided`
//       (default: cobblestone + table/furnace/chest given, recorded) or `gather` (nothing given;
//       the full acceptance trial)
//   O5  absent target: "kill that rabbit" with no rabbit -> one declarative blocker, no attack
//       on any other entity, no question
//   O6  stop during work: "remove that floating tree", owner `stop` after the first goal action
//       -> goal cancelled (owner_stop), no later goal action, latch paused; no question
//
// Footprint (complete; restored and verified at cleanup):
//   blocks    x 196..224, z 190..224, y -63..-50 (the standard skills scene area): reset to
//             dirt (y -63..-62), grass (y -61), air (y -60..-50) plus the standard oak trunk at
//             208,-60..-58,202, and per scenario: oak trees (x 198..200, z 196..198 / 214..216),
//             a floating birch remnant (x 211..213, z 204..206, y -57..-54). Cleanup re-applies
//             the standard reset and verifies sample positions.
//   entities  kills ONLY inside the box x 196..224, y -64..-24, z 190..224; NoAI chickens/cow
//             summoned inside it with tags `og_*`.
//   players   Chunkbot and FixtureOwner: inventories cleared (bot: 8 bread given so survival
//             upkeep never competes; O4 materials when provided), Chunkbot effects/gamemode,
//             positions inside the area.
//   forceload chunks covering the area; the existing set is queried BEFORE any change and only
//             this run's additions are removed and verified at the end.
// No difficulty, gamerule or time change. Independent data directory and a fresh memory/
// autonomy scope under the report directory. The automatic pause latch is set right after
// ready (`stop`), so no automatic progression/support runs; manual owner goals still act.
//
//   npm run build && npm run fixture -- status            (under the granted lease)
//   node scripts/ordinary-goal-live-check.ts --fixture-lease <granted id> [--fixture 26.2] [--jev real|fault]
//        [--only O1,O3] [--house-materials provided|gather]
//
// Report: var/live-check/<stamp>[-26.2]-ordinary-goals/report.json
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';
import { MemoryConfigSchema } from '../src/contracts/memory.ts';
import { smallShelterCells, type Facing } from '../src/autonomy/blueprint.ts';
import { CLI, CliProcess } from './lib/cli-process.ts';
import { rconCommand } from './lib/rcon.ts';
import { SCENE } from './lib/scene.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Bot = ReturnType<typeof mineflayer.createBot>;
type V3 = { x: number; y: number; z: number };

const PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const SUFFIX = PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${PINS.profile}`;
const VERSION_RE = PINS.minecraftVersion.replace(/\./g, '\\.');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const BOT = 'Chunkbot';
const OWNER = 'FixtureOwner';
const AREA = SCENE.area;
const ENTITY_BOX = `x=${AREA.x1},y=-64,z=${AREA.z1},dx=${AREA.x2 - AREA.x1},dy=40,dz=${AREA.z2 - AREA.z1}`;
const GOAL_TIMEOUT_MS = 12 * 60_000;
const AREA_CHUNKS: string[] = (() => {
  const out: string[] = [];
  for (let cx = Math.floor(AREA.x1 / 16); cx <= Math.floor(AREA.x2 / 16); cx += 1) for (let cz = Math.floor(AREA.z1 / 16); cz <= Math.floor(AREA.z2 / 16); cz += 1) out.push(`${cx},${cz}`);
  return out;
})();

/** Scenario geometry (all inside the footprint). */
export const LAYOUT = {
  chickenNear: { x: 208.5, y: -60, z: 205.5 },
  o2: { near: { x: 207.5, y: -60, z: 207.5 }, far: { x: 213.5, y: -60, z: 205.5 }, cow: { x: 203.5, y: -60, z: 205.5 } },
  birchLogs: [
    { x: 212, y: -57, z: 205 },
    { x: 212, y: -56, z: 205 },
    { x: 212, y: -55, z: 205 },
  ],
  birchLeaves: { x1: 211, x2: 213, y: -54, z1: 204, z2: 206 },
  oakTrees: [
    { logs: [{ x: 199, y: -60, z: 197 }, { x: 199, y: -59, z: 197 }, { x: 199, y: -58, z: 197 }], leaves: { x1: 198, x2: 200, y: -57, z1: 196, z2: 198 } },
    { logs: [{ x: 199, y: -60, z: 215 }, { x: 199, y: -59, z: 215 }, { x: 199, y: -58, z: 215 }], leaves: { x1: 198, x2: 200, y: -57, z1: 214, z2: 216 } },
  ],
  houseOwner: { x: 216.5, y: -60, z: 216.5 },
  ownerDefault: { x: 202.5, y: -60, z: 209.5 },
} as const;

/** Owner-facing question/answer prompts in CLI output lines (MB-PLAN-006 boundary). */
export function questionLines(lines: readonly string[]): string[] {
  return lines.filter((l) => /^\[chunkbot\] /.test(l) && (/Question q\d+|answer q\d+|reply: answer/i.test(l) || (/\?/.test(l) && !/^\[chunkbot\] \[chat\]/.test(l))));
}

/** Parses `forceload query`; null when unrecognized. */
export function parseForceloadQuery(reply: string): Set<string> | null {
  const pairs = [...reply.matchAll(/\[(-?\d+), (-?\d+)\]/g)].map((m) => `${m[1]},${m[2]}`);
  if (pairs.length > 0) return new Set(pairs);
  if (/^no\b.*force ?load/i.test(reply.trim())) return new Set();
  return null;
}

interface Result {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skipped';
  evidence: string[];
}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

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

function readRconPassword(): string {
  const fx = fixturePaths(PROJECT_ROOT, PINS);
  const line = readFileSync(fx.properties, 'utf8').split('\n').find((l) => l.startsWith('rcon.password='));
  if (!line) throw new Error('fixture RCON password missing');
  return line.slice('rcon.password='.length).trim();
}

class Harness {
  readonly results: Result[] = [];
  readonly setupLog: Array<{ atMs: number; scenario: string; command: string; reply: string }> = [];
  readonly interventions: Array<{ atMs: number; scenario: string; command: string; reply: string; why: string }> = [];
  readonly cleanup: Array<{ atMs: number; step: string; ok: boolean; detail: string }> = [];
  readonly runs: Array<{ name: string; pid: number | undefined; events: string; exit: Json | null }> = [];
  readonly outDir: string;
  readonly dataDir: string;
  scenario = 'preflight';
  cli: CliProcess | undefined;
  eventsPath = '';
  owner: Bot | undefined;
  configPath = '';
  forceloadBefore: Set<string> | null = null;
  jevServer: Server | undefined;
  jevCalls = 0;
  houseInterior = 3;
  memoryConfig = MemoryConfigSchema.parse({ worldProfile: `ordinary-goals-${PINS.profile.replace(/\./g, '-')}-${Date.now().toString(36)}`, worldRevision: 1, botProfile: 'chunkbot-ordinary-goals' });
  private readonly password: string;
  private rconQueue: Promise<unknown> = Promise.resolve();

  constructor(outDir: string) {
    this.outDir = outDir;
    this.dataDir = join(outDir, 'data');
    // Created only by run() after the lease check (see main()).
    this.password = readRconPassword();
  }

  private rconRaw(command: string): Promise<string> {
    const r = this.rconQueue.then(() => rconCommand(PINS.host, PINS.rconPort, this.password, command));
    this.rconQueue = r.catch(() => undefined);
    return r;
  }
  async setup(command: string): Promise<string> {
    const reply = await this.rconRaw(command);
    this.setupLog.push({ atMs: Date.now(), scenario: this.scenario, command, reply: reply.slice(0, 200) });
    return reply;
  }
  query(command: string): Promise<string> {
    return this.rconRaw(command);
  }
  note(step: string, ok: boolean, detail: string): void {
    this.cleanup.push({ atMs: Date.now(), step, ok, detail: detail.slice(0, 300) });
  }
  async blockIs(p: V3, key: string): Promise<boolean> {
    return /Test passed/i.test(await this.query(`execute if block ${p.x} ${p.y} ${p.z} ${key}`));
  }
  async entityExists(tag: string): Promise<boolean> {
    return /Test passed/i.test(await this.query(`execute if entity @e[tag=${tag},${ENTITY_BOX}]`));
  }
  async health(name: string): Promise<number> {
    const r = await this.query(`data get entity ${name} Health`);
    return Number(/(-?[\d.]+)f?$/.exec(r.trim())?.[1] ?? NaN);
  }

  async recordForceload(): Promise<void> {
    const reply = await this.query('forceload query');
    const set = parseForceloadQuery(reply);
    if (!set) throw new Error(`unrecognized \`forceload query\` reply; refusing to change the world: ${reply.slice(0, 160)}`);
    this.forceloadBefore = set;
    this.setupLog.push({ atMs: Date.now(), scenario: 'preflight', command: 'forceload query (read-only, before any change)', reply: reply.slice(0, 200) });
  }
  async restoreForceload(): Promise<void> {
    const before = this.forceloadBefore;
    if (!before) {
      this.note('forceload', true, 'not recorded and never changed');
      return;
    }
    const added = AREA_CHUNKS.filter((c) => !before.has(c));
    for (const c of added) {
      const [cx, cz] = c.split(',').map(Number) as [number, number];
      await this.setup(`forceload remove ${cx * 16} ${cz * 16}`);
    }
    const after = parseForceloadQuery(await this.query('forceload query'));
    const same = after !== null && after.size === before.size && [...before].every((c) => after.has(c));
    this.note('forceload', same, same ? `restored: removed ${added.length} added chunk(s)` : `NOT restored: recorded [${[...before].join(' ')}], now ${after ? `[${[...after].join(' ')}]` : 'unrecognized'}`);
  }

  /** Standard area reset (blocks/entities/players); the forceload set must be recorded first. */
  async resetScene(): Promise<void> {
    const { x1, z1, x2, z2 } = AREA;
    check(this.forceloadBefore, 'the forceloaded set must be recorded before the first forceload change');
    await this.setup(`forceload add ${x1} ${z1} ${x2} ${z2}`);
    await this.setup(`tp ${BOT} ${SCENE.start.x} ${SCENE.start.y + 30} ${SCENE.start.z}`);
    await this.setup(`effect give ${BOT} slow_falling 5 0 true`);
    await this.setup(`kill @e[type=!player,${ENTITY_BOX}]`);
    await sleep(1_600);
    for (const c of this.blockResetCommands()) await this.setup(c);
    for (const c of [`clear ${BOT}`, `give ${BOT} minecraft:bread 8`, `clear ${OWNER}`, `effect clear ${BOT}`, `gamemode survival ${BOT}`, `tp ${BOT} ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`, `tp ${OWNER} ${LAYOUT.ownerDefault.x} ${LAYOUT.ownerDefault.y} ${LAYOUT.ownerDefault.z} 0 0`]) await this.setup(c);
    await sleep(1_500);
  }
  blockResetCommands(): string[] {
    const { x1, z1, x2, z2 } = AREA;
    return [
      `kill @e[type=item,${ENTITY_BOX}]`,
      `kill @e[type=experience_orb,${ENTITY_BOX}]`,
      `fill ${x1} -60 ${z1} ${x2} -50 ${z2} air`,
      `fill ${x1} -61 ${z1} ${x2} -61 ${z2} grass_block`,
      `fill ${x1} -63 ${z1} ${x2} -62 ${z2} dirt`,
      ...SCENE.logs.map((p) => `setblock ${p.x} ${p.y} ${p.z} oak_log`),
    ];
  }
  async buildTrees(): Promise<void> {
    for (const t of LAYOUT.oakTrees) {
      const l = t.leaves;
      await this.setup(`fill ${l.x1} ${l.y} ${l.z1} ${l.x2} ${l.y} ${l.z2} oak_leaves[persistent=true]`);
      for (const p of t.logs) await this.setup(`setblock ${p.x} ${p.y} ${p.z} oak_log`);
    }
    const b = LAYOUT.birchLeaves;
    await this.setup(`fill ${b.x1} ${b.y} ${b.z1} ${b.x2} ${b.y} ${b.z2} birch_leaves[persistent=true]`);
    for (const p of LAYOUT.birchLogs) await this.setup(`setblock ${p.x} ${p.y} ${p.z} birch_log`);
    await sleep(800);
  }

  async startJev(): Promise<string> {
    this.jevServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        this.jevCalls += 1;
        const parsed = JSON.parse(body) as Json;
        const all = Object.keys(parsed.questions.next_action.criteria as Record<string, string>);
        const pick = all[0]!;
        const bytes = Buffer.byteLength(body);
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              model: 'typesafe/jev-1.13-20260917',
              provider: 'TypeSafe',
              id: 'gen-dec-FAULT-FIXTURE',
              answers: { next_action: { type: 'choice', choice: pick, probabilities: Object.fromEntries(all.map((k) => [k, k === pick ? 1 : 0])), confidence: 1 } },
              usage: { input_tokens: Math.round(bytes / 3), output_tokens: 10, cost: Math.round(bytes / 3) * 4.2e-8 },
            }),
          );
        }, 40);
      });
    });
    await new Promise<void>((r) => this.jevServer!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(this.jevServer.address() as AddressInfo).port}/api/alpha/decisions`;
  }

  events(): Json[] {
    return readJsonl(this.eventsPath);
  }
  async waitEvent(pred: (e: Json) => boolean, timeoutMs: number, what: string): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.events().find(pred);
      if (hit) return hit;
      await sleep(200);
    }
    throw new Error(`timed out (${Math.round(timeoutMs / 1000)} s) waiting for ${what}`);
  }

  async start(name: string, env: NodeJS.ProcessEnv): Promise<CliProcess> {
    const p = new CliProcess(name, ['run', '--config', this.configPath], env);
    this.cli = p;
    const runLine = await p.waitSince(/\[chunkbot\] run \S+; evidence: /, 0, 40_000);
    this.eventsPath = /evidence: (\S+)$/.exec(runLine)?.[1] ?? '';
    await p.waitSince(new RegExp(`\\[chunkbot\\] ready: version=${VERSION_RE}`), 0, 60_000);
    this.runs.push({ name, pid: p.pid, events: this.eventsPath, exit: null });
    return p;
  }
  async quit(): Promise<void> {
    const p = this.cli;
    if (!p) return;
    p.send('/quit');
    let exited = await Promise.race([p.exited, sleep(20_000).then(() => undefined)]);
    let killed = false;
    // Only the harness's own child is ever signalled; its exit is still awaited.
    if (!exited && p.child.exitCode === null) {
      killed = p.child.kill('SIGKILL');
      exited = await Promise.race([p.exited, sleep(10_000).then(() => undefined)]);
    }
    const run = this.runs.find((r) => r.pid === p.pid);
    const exit = exited ? { code: exited.code, signal: exited.signal, ...(killed ? { sigkillAfterMs: 20_000 } : {}) } : { notExited: true, sigkill: killed };
    if (run) run.exit = exit;
    this.note(`cli-exit pid ${p.pid ?? '?'}`, Boolean(exited) && !killed, exited ? (killed ? `exited only after SIGKILL (${JSON.stringify(exit)})` : `exited (${JSON.stringify(exit)})`) : 'did NOT exit');
    p.save(this.outDir);
    this.cli = undefined;
  }

  /** Owner chat; returns the CLI line index before sending. */
  say(text: string): number {
    const from = this.cli!.length;
    this.owner!.chat(`!chunkbot ${text}`);
    return from;
  }
  /** Ordinary owner goal through chat; returns the admitted goal id. */
  async goal(text: string): Promise<{ goalId: string; from: number }> {
    const from = this.say(text);
    const line = await this.cli!.waitSince(/\[chunkbot\] (Goal (goal-\S+) accepted: |Instruction not accepted: |Preparing your new instruction)/, from, 20_000);
    check(!/Instruction not accepted/.test(line), `instruction rejected: ${line}`);
    const accepted = /Goal (goal-\S+) accepted/.test(line) ? line : await this.cli!.waitSince(/\[chunkbot\] Goal (goal-\S+) accepted: /, from, 10 * 60_000);
    return { goalId: /Goal (goal-\S+) accepted/.exec(accepted)![1]!, from };
  }
  /** Quiesce: stop any active work (sets the automatic pause latch, which stays set). */
  async quiesce(): Promise<void> {
    if (!this.cli) return;
    const from = this.cli.length;
    this.cli.send('stop');
    await this.cli.waitSince(/\[chunkbot\] (Stopped|Nothing (to stop|was running)|Goal goal-\S+ cancelled)/, from, 15_000).catch(() => undefined);
    await sleep(800);
  }
  /** MB-PLAN-006 boundary for one goal: no question/answer prompt, never awaiting the owner. */
  noQuestions(goalId: string, from: number, ev: string[]): void {
    const shown = questionLines(this.cli!.since(from));
    const evs = this.events().filter((e) => e.goalId === goalId);
    const awaiting = evs.some((e) => e.type === 'clarification_requested' || (e.type === 'goal_state' && e.state === 'awaiting_owner'));
    const refusals = evs.filter((e) => e.type === 'planner_question_refused').length;
    ev.push(`no-question boundary: ${shown.length} question/answer line(s); awaiting_owner ${awaiting}; counted planner refusals ${refusals}`);
    check(shown.length === 0, `owner-facing question/answer prompt shown: ${shown[0]?.slice(0, 200)}`);
    check(!awaiting, 'the goal never waited for the owner');
  }
  goalActions(goalId: string): Json[] {
    return this.events().filter((e) => e.type === 'task_action' && e.goalId === goalId);
  }

  async scenarioRun(id: string, title: string, only: Set<string> | undefined, fn: (ev: string[]) => Promise<void>): Promise<void> {
    if (only && !only.has(id)) return;
    this.scenario = id;
    const evidence: string[] = [];
    const started = Date.now();
    process.stdout.write(`RUN  ${id} ${title}\n`);
    try {
      await this.quiesce();
      await fn(evidence);
      this.results.push({ id, title, status: 'pass', evidence });
      process.stdout.write(`PASS ${id} (${Math.round((Date.now() - started) / 1000)} s)\n`);
    } catch (error) {
      evidence.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
      this.results.push({ id, title, status: 'fail', evidence });
      process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)?.slice(0, 800)}\n`);
    }
    for (const line of evidence.slice(0, 40)) process.stdout.write(`     ${line.slice(0, 300)}\n`);
  }
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);

function sourceFreeze(): Json {
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return { head: git(['rev-parse', 'HEAD']), dirtyPaths: (git(['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length, distCli: existsSync(CLI) ? { sha256: sha(CLI), mtimeMs: statSync(CLI).mtimeMs } : null };
}

async function fixtureBot(username: string): Promise<Bot> {
  const bot = mineflayer.createBot({ host: PINS.host, port: PINS.port, username, auth: 'offline', version: PINS.minecraftVersion, hideErrors: true });
  await new Promise<void>((resolveSpawn, reject) => {
    const timer = setTimeout(() => reject(new Error(`${username} did not spawn`)), 20_000);
    bot.once('spawn', () => {
      clearTimeout(timer);
      resolveSpawn();
    });
    bot.once('end', (reason: string) => reject(new Error(`${username} ended: ${reason}`)));
  });
  return bot;
}

async function run(outDir: string, jevMode: 'real' | 'fault', only: Set<string> | undefined, materials: 'provided' | 'gather'): Promise<Json> {
  const h = new Harness(outDir);
  const freeze = sourceFreeze();
  check(freeze.distCli, 'dist/cli.js is missing: run `npm run build` before the lease window (never during it)');
  if (jevMode === 'real') check(Boolean(process.env['OPENROUTER_API_KEY']), 'real Jev needs OPENROUTER_API_KEY injected by the coordinator (never stored)');
  const list = await h.query('list').catch((error: unknown) => {
    throw new Error(`fixture not reachable over RCON (${String(error)}); the coordinator starts it under the lease`);
  });
  process.stdout.write(`fixture: ${list}\n`);
  await h.recordForceload();

  // Generated config: the fixture autonomy profile (home construction registered with a fresh
  // durable scope), REAL subscription planner, independent data dir; Jev real or loopback.
  const basePath = join(PROJECT_ROOT, PINS.config.replace(/\.json$/, '-autonomy.json'));
  const base = JSON.parse(readFileSync(basePath, 'utf8')) as Json;
  const endpoint = jevMode === 'fault' ? await h.startJev() : undefined;
  h.houseInterior = Number(base.autonomy?.home?.interior ?? 3);
  const cfg: Json = {
    ...base,
    storage: { ...base.storage, dataDir: h.dataDir, maxEventsPerRun: 50_000 },
    models: { ...base.models, planner: { ...base.models.planner, mode: 'codex' }, ...(endpoint ? { decision: { ...base.models.decision, endpoint } } : {}) },
    memory: { worldProfile: h.memoryConfig.worldProfile, worldRevision: h.memoryConfig.worldRevision, botProfile: h.memoryConfig.botProfile },
    autonomy: { ...base.autonomy, startDelayMs: 20_000 },
  };
  h.configPath = join(outDir, 'ordinary-goals.config.json');
  writeFileSync(h.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const env: NodeJS.ProcessEnv = jevMode === 'fault' ? { ...process.env, OPENROUTER_API_KEY: 'fault-fixture-placeholder-key' } : { ...process.env };

  let report: Json = {};
  try {
    const cli = await h.start('run-ordinary', env);
    // Latch automatic work BEFORE its first assessment: only the owner's ordinary goals act.
    cli.send('stop');
    await sleep(500);
    h.owner = await fixtureBot(OWNER);

    await h.scenarioRun('O1', 'one visible chicken: "kill that chicken" defeats THAT chicken (server death status); owner never attacked; no question', only, async (ev) => {
      await h.resetScene();
      await h.setup(`summon chicken ${LAYOUT.chickenNear.x} ${LAYOUT.chickenNear.y} ${LAYOUT.chickenNear.z} {NoAI:1b,Tags:["og_o1"]}`);
      await sleep(800);
      const ownerHealth = await h.health(OWNER);
      const { goalId, from } = await h.goal('kill that chicken');
      const end = await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goalId, GOAL_TIMEOUT_MS, `goal ${goalId}`);
      ev.push(`goal ${goalId}: ${end.state} (${end.reason}) ${String(end.detail ?? '').slice(0, 200)}`);
      const attacks = h.goalActions(goalId).filter((a) => a.capability === 'attack_entity');
      ev.push(`attack actions: ${attacks.map((a) => `${a.status}:${JSON.stringify(a.evidence?.entity ?? null)} defeated=${a.evidence?.defeatedByServerStatus ?? null}`).join(' | ') || 'none'}`);
      const alive = await h.entityExists('og_o1');
      const ownerAfter = await h.health(OWNER);
      ev.push(`RCON: chicken present ${alive}; owner health ${ownerHealth} -> ${ownerAfter}`);
      h.noQuestions(goalId, from, ev);
      check(end.state === 'completed' && end.reason === 'outcome_verified', 'outcome verified by code');
      check(attacks.some((a) => a.evidence?.defeatedByServerStatus === true && a.evidence?.entity === 'minecraft:chicken'), 'server death status for a chicken');
      check(attacks.every((a) => a.evidence?.entity !== 'minecraft:player'), 'no player attacked');
      check(!alive, 'RCON: the chicken is gone');
      check(!(ownerAfter < ownerHealth), 'the owner took no damage');
    });

    await h.scenarioRun('O2', 'two chickens and a nearer cow: "kill the chicken" defeats exactly the CLOSER chicken; the farther chicken and the cow live', only, async (ev) => {
      await h.resetScene();
      const o = LAYOUT.o2;
      await h.setup(`summon chicken ${o.near.x} ${o.near.y} ${o.near.z} {NoAI:1b,Tags:["og_o2_near"]}`);
      await h.setup(`summon chicken ${o.far.x} ${o.far.y} ${o.far.z} {NoAI:1b,Tags:["og_o2_far"]}`);
      await h.setup(`summon cow ${o.cow.x} ${o.cow.y} ${o.cow.z} {NoAI:1b,Tags:["og_o2_cow"]}`);
      await sleep(800);
      const { goalId, from } = await h.goal('kill the chicken');
      const end = await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goalId, GOAL_TIMEOUT_MS, `goal ${goalId}`);
      ev.push(`goal ${goalId}: ${end.state} (${end.reason}) ${String(end.detail ?? '').slice(0, 200)}`);
      const [near, far, cow] = [await h.entityExists('og_o2_near'), await h.entityExists('og_o2_far'), await h.entityExists('og_o2_cow')];
      ev.push(`RCON present: near chicken ${near}, far chicken ${far}, cow ${cow}`);
      h.noQuestions(goalId, from, ev);
      check(end.state === 'completed' && end.reason === 'outcome_verified', 'outcome verified by code');
      check(!near && far && cow, 'exactly the closer chicken defeated; nothing else attacked to death');
      check(h.goalActions(goalId).every((a) => a.capability !== 'attack_entity' || a.evidence?.entity === 'minecraft:chicken'), 'only chickens attacked');
    });

    await h.scenarioRun('O3', 'floating birch beside grounded oaks: "remove that floating tree" removes THAT tree; unrelated trees intact; no question', only, async (ev) => {
      await h.resetScene();
      await h.buildTrees();
      const { goalId, from } = await h.goal('remove that floating tree');
      const end = await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goalId, GOAL_TIMEOUT_MS, `goal ${goalId}`);
      ev.push(`goal ${goalId}: ${end.state} (${end.reason}) ${String(end.detail ?? '').slice(0, 240)}`);
      const outcome = h.events().find((e) => e.type === 'goal_outcome_bound' && e.goalId === goalId);
      const record = h.events().find((e) => e.type === 'planner_proposal' && e.goalId === goalId);
      ev.push(`outcome bound: ${outcome ? 'yes' : 'no'}; first proposal disposition ${record?.disposition ?? 'n/a'}`);
      const birchLeft = [];
      for (const p of LAYOUT.birchLogs) if (await h.blockIs(p, 'minecraft:birch_log')) birchLeft.push(p);
      const oakMissing = [];
      for (const t of LAYOUT.oakTrees) for (const p of t.logs) if (!(await h.blockIs(p, 'minecraft:oak_log'))) oakMissing.push(p);
      for (const p of SCENE.logs) if (!(await h.blockIs(p, 'minecraft:oak_log'))) oakMissing.push(p);
      ev.push(`RCON: birch logs left ${birchLeft.length}/${LAYOUT.birchLogs.length}; oak logs missing ${oakMissing.length}`);
      h.noQuestions(goalId, from, ev);
      check(oakMissing.length === 0, 'no unrelated tree was cut');
      check(end.state === 'completed' && end.reason === 'outcome_verified', 'removal verified by code');
      check(birchLeft.length === 0, 'RCON: every floating birch log removed');
    });

    await h.scenarioRun('O4', `"set up your house here": verified home near the VISIBLE owner (materials ${materials}); no question`, only, async (ev) => {
      await h.resetScene();
      await h.buildTrees();
      if (materials === 'provided') for (const c of [`give ${BOT} minecraft:cobblestone 64`, `give ${BOT} minecraft:crafting_table 1`, `give ${BOT} minecraft:furnace 1`, `give ${BOT} minecraft:chest 1`]) await h.setup(c);
      const at = LAYOUT.houseOwner;
      await h.setup(`tp ${OWNER} ${at.x} ${at.y} ${at.z} 0 0`);
      await sleep(1_000);
      const { goalId, from } = await h.goal('set up your house here');
      const end = await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goalId, 30 * 60_000, `goal ${goalId}`);
      ev.push(`goal ${goalId}: ${end.state} (${end.reason}) ${String(end.detail ?? '').slice(0, 240)}`);
      const sites = h.goalActions(goalId).filter((a) => a.capability === 'select_home_site');
      ev.push(`select_home_site actions: ${sites.map((a) => `${a.status} ${String(a.effect).slice(0, 120)}`).join(' | ') || 'none'}`);
      const from2 = h.cli!.length;
      h.cli!.send('status');
      const homeLine = await h.cli!.waitSince(/^\[status\] home: /, from2, 10_000).catch(() => '');
      ev.push(homeLine);
      h.noQuestions(goalId, from, ev);
      check(end.state === 'completed' && end.reason === 'outcome_verified', 'home verified by code');
      const m = /home: (proj-\S+) (\w+) at (-?\d+),(-?\d+),(-?\d+) \S+ \(\d+x\d+, entrance (\w+)\)/.exec(homeLine);
      check(m && m[2] === 'complete', 'status shows the home project complete');
      const origin = { x: Number(m[3]), y: Number(m[4]), z: Number(m[5]) };
      const outer = h.houseInterior + 2;
      const centre = { x: origin.x + outer / 2, z: origin.z + outer / 2 };
      const fromOwner = Math.hypot(centre.x - at.x, centre.z - at.z);
      ev.push(`site centre ${centre.x},${centre.z}: ${fromOwner.toFixed(1)} blocks from where the owner stood`);
      check(fromOwner <= 16 + outer, 'the site was chosen around the visible owner ("here")');
      const cells = smallShelterCells(origin, h.houseInterior as 2 | 3, m[6] as Facing).filter((c) => c.role !== 'aid');
      const wrong: string[] = [];
      for (const c of cells) {
        if (c.role === 'entrance') {
          if (!(await h.blockIs(c.at, 'minecraft:air'))) wrong.push(`entrance@${c.at.x},${c.at.y},${c.at.z}`);
          continue;
        }
        let ok = false;
        for (const k of c.accept) if (await h.blockIs(c.at, k)) ok = true;
        if (!ok) wrong.push(`${c.role}@${c.at.x},${c.at.y},${c.at.z}`);
      }
      ev.push(`RCON: ${cells.length - wrong.length}/${cells.length} blueprint cells as required${wrong.length ? `; wrong ${wrong.slice(0, 6).join(' ')}` : ''}`);
      check(wrong.length === 0, 'every blueprint cell confirmed by the server');
    });

    await h.scenarioRun('O5', 'absent target: "kill that rabbit" with no rabbit -> one declarative blocker; nothing else attacked; no question', only, async (ev) => {
      await h.resetScene();
      const { goalId, from } = await h.goal('kill that rabbit');
      const end = await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goalId, GOAL_TIMEOUT_MS, `goal ${goalId}`);
      ev.push(`goal ${goalId}: ${end.state} (${end.reason}) ${String(end.detail ?? '').slice(0, 240)}`);
      const attacks = h.goalActions(goalId).filter((a) => a.capability === 'attack_entity');
      ev.push(`attack actions: ${attacks.length}`);
      h.noQuestions(goalId, from, ev);
      check(end.state !== 'completed', 'no fabricated completion');
      check(attacks.length === 0, 'no substitute target attacked');
    });

    await h.scenarioRun('O6', 'stop during work: owner stop after the first goal action cancels it; no later goal action; no question', only, async (ev) => {
      await h.resetScene();
      await h.buildTrees();
      const { goalId, from } = await h.goal('remove that floating tree');
      await h.waitEvent((e) => e.type === 'task_action' && e.goalId === goalId, GOAL_TIMEOUT_MS, `the first action of ${goalId}`);
      const stopAt = Date.now();
      h.say('stop');
      const end = await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goalId, 30_000, `goal ${goalId} to end after stop`);
      await sleep(3_000);
      const later = h.goalActions(goalId).filter((a) => Date.parse(String(a.t)) > Date.parse(String(end.t)));
      ev.push(`goal ${goalId}: ${end.state} (${end.reason}) ${Date.parse(String(end.t)) - stopAt} ms after stop; actions after terminal ${later.length}`);
      h.noQuestions(goalId, from, ev);
      check(end.state === 'cancelled' && end.reason === 'owner_stop', 'cancelled by the owner stop');
      check(later.length === 0, 'no goal action after the terminal');
    });
  } finally {
    const step = async (name: string, fn: () => Promise<string | void>) => {
      try {
        const detail = await fn();
        if (detail !== undefined) h.note(name, true, detail);
      } catch (error) {
        h.note(name, false, `failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (h.cli) {
      await step('cli-stop', async () => {
        h.cli!.send('stop');
        await sleep(500);
        return 'stop sent to the owned CLI';
      });
      await step('cli-quit', async () => {
        await h.quit();
      });
    }
    if (h.forceloadBefore) {
      await step('entities', async () => `kill non-players in the entity box: ${(await h.setup(`kill @e[type=!player,${ENTITY_BOX}]`)).slice(0, 80)}`);
      await step('blocks', async () => {
        for (const c of h.blockResetCommands()) await h.setup(c);
        const samples: V3[] = [...LAYOUT.birchLogs, ...LAYOUT.oakTrees.flatMap((t): V3[] => [...t.logs]), { x: LAYOUT.houseOwner.x - 0.5, y: -60, z: LAYOUT.houseOwner.z - 0.5 }];
        for (const p of samples) if (!(await h.blockIs({ x: Math.floor(p.x), y: p.y, z: Math.floor(p.z) }, 'minecraft:air'))) throw new Error(`area not restored at ${p.x},${p.y},${p.z}`);
        return `standard area reset applied and ${samples.length} sample positions verified air`;
      });
      for (const [name, command] of [['bot-inventory', `clear ${BOT}`], ['owner-inventory', `clear ${OWNER}`], ['bot-effects', `effect clear ${BOT}`]] as const) {
        await step(name, async () => {
          const r = await h.setup(command);
          const ok = /^Removed |^No items were found|no effects to remove/i.test(r.trim());
          h.note(name, ok, `${command}: ${r.slice(0, 80)}`);
        });
      }
      await step('forceload-restore', async () => {
        await h.restoreForceload();
      });
    }
    await step('owner-quit', async () => {
      const o = h.owner;
      if (!o) return 'owner bot never joined';
      const ended = new Promise<void>((r) => o.once('end', () => r()));
      o.quit();
      const ok = await Promise.race([ended.then(() => true), sleep(10_000).then(() => false)]);
      if (!ok) throw new Error('owner bot did not end within 10 s');
      return 'owner bot disconnected';
    });
    await step('jev-close', async () => {
      const srv = h.jevServer;
      if (!srv) return 'loopback Jev not used';
      srv.closeAllConnections();
      await new Promise<void>((r, j) => srv.close((e) => (e ? j(e) : r())));
      return 'loopback Jev closed';
    });
    const counted = h.results.filter((r) => r.status !== 'skipped');
    const scenariosPass = counted.length > 0 && counted.every((r) => r.status === 'pass');
    const cleanupFailures = h.cleanup.filter((c) => !c.ok);
    const ev = readJsonl(h.eventsPath);
    report = {
      check: `MB-PLAN-006 ordinary-goal live check (REAL subscription planner; Jev ${jevMode === 'real' ? 'REAL' : 'LOOPBACK FAULT (harness validation only)'})`,
      fixture: PINS.profile,
      sourceFreeze: freeze,
      config: { path: h.configPath, base: basePath, dataDir: h.dataDir, houseMaterials: materials, houseInterior: h.houseInterior },
      pass: scenariosPass && cleanupFailures.length === 0,
      scenariosPass,
      cleanup: { reconciled: cleanupFailures.length === 0, failures: cleanupFailures, steps: h.cleanup, forceloadBefore: h.forceloadBefore ? [...h.forceloadBefore] : null, areaChunks: AREA_CHUNKS },
      footprint: { blocks: { x: [AREA.x1, AREA.x2], y: [-63, -50], z: [AREA.z1, AREA.z2] }, entityBox: ENTITY_BOX, players: [BOT, OWNER] },
      results: h.results,
      setup: h.setupLog,
      interventions: h.interventions,
      runs: h.runs,
      providerCalls: { plannerRequests: ev.filter((e) => e.type === 'planner_request').length, plannerQuestionRefusals: ev.filter((e) => e.type === 'planner_question_refused').length, jevChoices: ev.filter((e) => e.type === 'task_choice').length, loopbackJevCalls: h.jevCalls },
      terminals: ev.filter((e) => e.type === 'goal_terminal').map((e) => ({ goalId: e.goalId, state: e.state, reason: e.reason, counters: e.counters ?? null })),
    };
  }
  return report;
}

async function main(): Promise<number> {
  // Shared fixtures are leased: nothing (no password read, RCON, join, config or output) happens without an explicit lease id.
  const lease = arg('--fixture-lease');
  if (!lease || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(lease)) {
    process.stderr.write('refusing to run: pass --fixture-lease <granted lease id> (the shared loopback fixtures are leased by the coordinator)\n');
    return 2;
  }
  const jevMode = (arg('--jev') ?? 'real') as 'real' | 'fault';
  const materials = (arg('--house-materials') ?? 'provided') as 'provided' | 'gather';
  if ((jevMode !== 'real' && jevMode !== 'fault') || (materials !== 'provided' && materials !== 'gather')) {
    process.stderr.write('usage: ordinary-goal-live-check --fixture-lease <id> [--fixture 26.2] [--jev real|fault] [--only O1,O2] [--house-materials provided|gather]\n');
    return 2;
  }
  const onlyArg = arg('--only');
  const only = onlyArg ? new Set(onlyArg.split(',')) : undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${SUFFIX}-ordinary-goals`);
  mkdirSync(outDir, { recursive: true });
  process.stdout.write(`ordinary-goal live check (${PINS.profile}, lease ${lease}, jev ${jevMode}) -> ${outDir}\n`);
  const report = await run(outDir, jevMode, only, materials);
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify({ ...report, lease }, null, 2)}\n`);
  const cleanup = report['cleanup'] as { reconciled: boolean; failures: Array<{ step: string; detail: string }> } | undefined;
  if (cleanup && !cleanup.reconciled) for (const f of cleanup.failures) process.stdout.write(`CLEANUP NOT RECONCILED: ${f.step} — ${f.detail}\n`);
  process.stdout.write(`${report['pass'] ? 'PASS' : 'FAIL'} ordinary-goal live check — ${outDir}\n`);
  return report['pass'] ? 0 : 1;
}

/** Import safety: importing never runs anything; main() refuses (exit 2) before any fixture access without a lease. */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && moduleUrl === pathToFileURL(resolve(argv1)).href;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
