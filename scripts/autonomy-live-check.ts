// MB-FLOW-001 automatic progression live check against a LOCAL TEST FIXTURE.
//
// Drives the REAL built CLI (`node dist/cli.js run`, autonomy ENABLED, no
// --no-autonomy) end to end with:
//   * the PLANNER FAULT FIXTURE (scripts/lib/fault-codex.ts) replaying scripted
//     planner turns (the real installed CLI answers only the read-only
//     isolation-gate commands; `login status` is scripted as the managed
//     ChatGPT mode); it records only structural metadata of each planner input
//     (goal origin, which context blocks were present), never content;
//   * a LOOPBACK Jev fault provider that always picks the first (best-ranked)
//     code-generated option,
// so it is HARNESS VALIDATION of ownership, durability and code verification,
// never planner/Jev quality acceptance (that is the coordinator's real-provider
// A3 run). World truth comes from RCON (blocks, inventory, positions); durable
// state from read-only inspection of the autonomy and memory stores between
// processes; behavior from the run evidence.
//
// Scenarios (report.json records every setup command, intervention and event excerpt):
//   U0  ready with autonomy enabled; operator stop BEFORE the first assessment sets the durable
//       latch; owner joins; scene reset; no automatic goal starts while paused
//   U1  A1/A2: bare resume -> fresh assessment -> automatic progression admitted through the single
//       engine path (surface supervisor, source progression); the planner input is labelled
//       automatic and carries the autonomy context; outcome code-verified; RCON inventory confirms
//   U2  A4 owner priority: an owner instruction during an automatic task takes over (old goal
//       replaced, no automatic task after the switch); the owner goal completes and progression
//       returns after it
//   U3  A5 durable stop: owner stop DURING an automatic planner turn cancels it; latch durable on
//       disk; restart -> latch restored (no automatic goal); bare resume -> fresh assessment
//   U4  A3/A6 home: the automatic goal approves a site and builds small_shelter_v1; outcome
//       structure_state complete verified by code; EVERY blueprint cell confirmed over RCON;
//       verified home recorded in memory; project durable on disk
//   U5  restart + repair: a wall block removed while the bot is offline (recorded intervention);
//       after restart the stored project is historical, build_home inspects afresh, re-places the
//       missing cell and code re-verifies completion; RCON confirms
//
// Requires an exclusive coordinator lease on the fixture. Footprint (P-C8, complete):
//   blocks    x 196..224, z 190..224, y -63..-50 (the existing skills scene area): reset to dirt
//             (y -63..-62), grass (y -61) and air (y -60..-50) plus one oak trunk at 208,-60..-58,202;
//             the shelter the bot builds stays there for later inspection (the next standard reset
//             clears it; no baseline clone).
//   entities  kills (non-player in the reset, items at cleanup) ONLY inside the selector box
//             x 196..224, y -64..-24, z 190..224 (`x=196,y=-64,z=190,dx=28,dy=40,dz=34`).
//   players   Chunkbot and FixtureOwner: inventories cleared/given (bot: 8 bread above the default
//             safe-food reserve, then 64 cobblestone + crafting table, furnace, chest), Chunkbot
//             effects (slow_falling during the reset, `effect clear`; cleared again at cleanup),
//             Chunkbot gamemode survival, positions teleported inside the block area.
//   forceload the chunks covering the block area (x 12..14, z 11..14). The existing forceloaded set
//             is queried BEFORE any change; at finalization only the chunks this run newly added are
//             removed, and the full set is verified equal to the recorded one.
// No difficulty, gamerule or time change. Independent data directory under the report directory
// (fresh memory/autonomy scope per run). Never rebuild dist while it runs.
//
// Cleanup is reconciled, never best effort: every cleanup step (owned CLI exit, awaited even
// after the bounded SIGKILL fallback; item/inventory/effect cleanup; forceload restoration and
// verification; owner bot and loopback Jev shutdown) is recorded, and any unreconciled step makes
// the report and the exit code fail, while the scenario evidence is kept unchanged.
//
//   npm run build && npm run fixture -- status            (under the granted lease)
//   node scripts/autonomy-live-check.ts --fixture-lease <granted id> [--fixture 26.2]
//
// Scenarios are sequential (one CLI, one scope, one world state); after a failure the rest are skipped.
//
// Report: var/live-check/<stamp>[-26.2]-autonomy/report.json
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
import { systemClock } from '../src/contracts/index.ts';
import type { AutonomyScope } from '../src/contracts/autonomy.ts';
import { MemoryConfigSchema } from '../src/contracts/memory.ts';
import { smallShelterCells, type Facing } from '../src/autonomy/blueprint.ts';
import { ControlFileStore, autonomyScopeDirectory } from '../src/autonomy/store.ts';
import { inspectMemory } from '../src/memory/report.ts';
import { memoryRoot } from '../src/memory/service.ts';
import { CLI, CliProcess } from './lib/cli-process.ts';
import { rconCommand } from './lib/rcon.ts';
import { SCENE } from './lib/scene.ts';
import { setFaultTurns, writeFaultCodex, type FaultTurn } from './lib/fault-codex.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Bot = ReturnType<typeof mineflayer.createBot>;

const PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const SUFFIX = PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${PINS.profile}`;
const VERSION_RE = PINS.minecraftVersion.replace(/\./g, '\\.');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const REAL_CODEX = '/opt/homebrew/bin/codex';
const BOT = 'Chunkbot';
const OWNER = 'FixtureOwner';
const AREA = SCENE.area;
const ITEM_AREA = `x=${AREA.x1},y=-64,z=${AREA.z1},dx=${AREA.x2 - AREA.x1},dy=40,dz=${AREA.z2 - AREA.z1}`;
const INTERIOR = 2 as const;
const START_DELAY_MS = 8_000;
const AFTER_COMPLETION_MS = 5_000;
const BUILD_MATERIAL = 'minecraft:cobblestone';
/** Chunks covering the block area (the only chunks this harness forceloads). */
const AREA_CHUNKS: string[] = (() => {
  const out: string[] = [];
  for (let cx = Math.floor(AREA.x1 / 16); cx <= Math.floor(AREA.x2 / 16); cx += 1) for (let cz = Math.floor(AREA.z1 / 16); cz <= Math.floor(AREA.z2 / 16); cz += 1) out.push(`${cx},${cz}`);
  return out;
})();

/**
 * Truthful label for a `clear` / `effect clear` reply. Only a reply that states the outcome for
 * the named player is verification; "no player found" means the player was absent (e.g. logged
 * out), which proves nothing about the inventory/effects (the next standard setup resets them).
 */
export function playerCleanupLabel(reply: string): { ok: boolean; label: 'verified_removed' | 'verified_none' | 'player_absent' | 'unrecognized'; detail: string } {
  const r = reply.trim();
  if (/^No (player|entity) was found/i.test(r)) return { ok: true, label: 'player_absent', detail: `player absent (not online): NOT verified — ${r.slice(0, 80)}` };
  if (/^Removed \d+ item/i.test(r) || /^Removed every effect/i.test(r) || /^Removed effect/i.test(r)) return { ok: true, label: 'verified_removed', detail: `verified by the server reply — ${r.slice(0, 80)}` };
  if (/^No items were found/i.test(r) || /no effects to remove/i.test(r)) return { ok: true, label: 'verified_none', detail: `verified nothing to remove — ${r.slice(0, 80)}` };
  return { ok: false, label: 'unrecognized', detail: `unrecognized reply (unreconciled) — ${r.slice(0, 80)}` };
}

/** Parses `forceload query` (all chunks in the executing dimension); null when unrecognized. */
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

// ---------------------------------------------------------------- planner fault proposals (wire format)

function wp(p: Json): Json {
  const base: Json = { predicate: null, selector: null, atLeast: null, mode: null, mayBeConsumedLater: null, slot: null, target: null, within: null, expect: null, output: null, outcome: null, of: null };
  return { ...base, ...p };
}
function wt(t: Json): Json {
  return { kind: null, key: null, snapshotId: null, handle: null, anchorId: null, dimension: null, at: null, ownerText: null, actionId: null, ...t };
}
function proposal(p: Json): Json {
  return { disposition: 'plan', interpretation: 'fixture plan', outcome: null, tasks: [], morePlanningNeeded: false, queries: [], question: null, missing: null, missingCapabilities: [], verifiedProgress: null, ...p };
}
const NEAR_OWNER = () => wp({ predicate: 'near_target', target: wt({ kind: 'owner' }), within: 3 });
const HOME = (expect: 'site_approved' | 'enclosed' | 'complete') => ({ predicate: 'structure_state', structure: 'home', expect });
const collectLogs = (n: number, interpretation: string) =>
  proposal({
    interpretation,
    outcome: { kind: 'finite', predicate: wp({ predicate: 'inventory_amount', selector: '#minecraft:logs', atLeast: n, mode: 'collect_additional' }) },
    tasks: [
      {
        objective: `Collect ${n} oak log(s).`,
        decisionInstruction: 'Mine a visible oak log, then pick up its drop.',
        allowedCapabilities: ['move_near', 'mine_block', 'pickup_item'],
        targetSelectors: [wt({ kind: 'registry', key: '#minecraft:logs' })],
        parameters: [],
        completion: wp({ predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: n, mayBeConsumedLater: false }),
      },
    ],
  });
const comeHere = () =>
  proposal({
    interpretation: 'Walk to the owner.',
    outcome: { kind: 'finite', predicate: NEAR_OWNER() },
    tasks: [{ objective: 'Walk to the owner.', decisionInstruction: 'Move next to the owner.', allowedCapabilities: ['move_near'], targetSelectors: [wt({ kind: 'owner' })], parameters: [], completion: NEAR_OWNER() }],
  });
const nothingAttainable = () => proposal({ disposition: 'cannot_execute', interpretation: 'Nothing scripted for this turn (fixture).', missing: 'fixture: no scripted milestone for this assessment' });
const buildTask = () => ({
  objective: 'Build and furnish the small home shelter.',
  decisionInstruction: 'Do the next construction step of the home (place, move, or remove the own aid).',
  allowedCapabilities: ['build_home'],
  targetSelectors: [],
  parameters: [],
  completion: HOME('complete'),
});
const buildHome = () =>
  proposal({
    interpretation: 'Build the small verified home shelter from the cobblestone and furnishings in the inventory.',
    outcome: { kind: 'finite', predicate: HOME('complete') },
    tasks: [
      { objective: 'Choose a vacant home site nearby.', decisionInstruction: 'Approve the best vacant site.', allowedCapabilities: ['select_home_site'], targetSelectors: [], parameters: [], completion: HOME('site_approved') },
      buildTask(),
    ],
  });
const repairHome = () =>
  proposal({
    interpretation: 'Inspect the home afresh and restore whatever is missing.',
    outcome: { kind: 'finite', predicate: HOME('complete') },
    tasks: [buildTask()],
  });

// ---------------------------------------------------------------- harness

class Harness {
  readonly results: Result[] = [];
  readonly setupLog: Array<{ atMs: number; scenario: string; command: string; reply: string }> = [];
  readonly interventions: Array<{ atMs: number; scenario: string; command: string; reply: string; why: string }> = [];
  readonly runs: Array<{ name: string; pid: number | undefined; events: string; exit: Json | null }> = [];
  /** Reconciled cleanup record; any `ok: false` fails the report and the exit code. */
  readonly cleanup: Array<{ atMs: number; step: string; ok: boolean; detail: string }> = [];
  /** Forceloaded chunks recorded before any change (null until recorded). */
  forceloadBefore: Set<string> | null = null;
  readonly outDir: string;
  readonly dataDir: string;
  readonly faultDir: string;
  scenario = 'preflight';
  cli: CliProcess | undefined;
  eventsPath = '';
  owner: Bot | undefined;
  configPath = '';
  memoryConfig = MemoryConfigSchema.parse({ worldProfile: `autonomy-live-${PINS.profile.replace(/\./g, '-')}-${Date.now().toString(36)}`, worldRevision: 1, botProfile: 'chunkbot-autonomy-live' });
  jevServer: Server | undefined;
  jevCalls = 0;
  home: { id: string; origin: { x: number; y: number; z: number }; facing: Facing } | undefined;
  private readonly password: string;
  private rconQueue: Promise<unknown> = Promise.resolve();

  constructor(outDir: string) {
    this.outDir = outDir;
    this.dataDir = join(outDir, 'data');
    this.faultDir = join(outDir, 'fault-planner');
    // Created only by run() after the lease check (see main()).
    this.password = readRconPassword();
  }

  get scope(): AutonomyScope {
    return { worldProfile: this.memoryConfig.worldProfile, worldRevision: this.memoryConfig.worldRevision, botProfile: this.memoryConfig.botProfile };
  }

  // ------------------------------------------------------------ RCON

  private rconRaw(command: string): Promise<string> {
    const run = this.rconQueue.then(() => rconCommand(PINS.host, PINS.rconPort, this.password, command));
    this.rconQueue = run.catch(() => undefined);
    return run;
  }
  async setup(command: string): Promise<string> {
    const reply = await this.rconRaw(command);
    this.setupLog.push({ atMs: Date.now(), scenario: this.scenario, command, reply: reply.slice(0, 200) });
    return reply;
  }
  async intervene(command: string, why: string): Promise<string> {
    const reply = await this.rconRaw(command);
    this.interventions.push({ atMs: Date.now(), scenario: this.scenario, command, reply: reply.slice(0, 200), why });
    return reply;
  }
  /** Read-only server queries (not world changes). */
  query(command: string): Promise<string> {
    return this.rconRaw(command);
  }
  async inventory(name = BOT): Promise<Record<string, number>> {
    const r = await this.query(`data get entity ${name} Inventory`);
    const out: Record<string, number> = {};
    for (const entry of r.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) ?? []) {
      const id = /id: "([^"]+)"/.exec(entry)?.[1];
      const count = Number(/count: (\d+)/.exec(entry)?.[1] ?? 0);
      if (id) out[id] = (out[id] ?? 0) + count;
    }
    return out;
  }
  note(step: string, ok: boolean, detail: string): void {
    this.cleanup.push({ atMs: Date.now(), step, ok, detail: detail.slice(0, 300) });
  }

  /** Read-only: records the forceloaded set before any world change (fails closed if unrecognized). */
  async recordForceload(): Promise<void> {
    const reply = await this.query('forceload query');
    const set = parseForceloadQuery(reply);
    if (!set) throw new Error(`unrecognized \`forceload query\` reply; refusing to change the world: ${reply.slice(0, 160)}`);
    this.forceloadBefore = set;
    this.setupLog.push({ atMs: Date.now(), scenario: 'preflight', command: 'forceload query (read-only, before any change)', reply: reply.slice(0, 200) });
  }

  /** Removes only the area chunks this run newly forceloaded, then verifies the full set equals the recorded one. */
  async restoreForceload(): Promise<void> {
    const before = this.forceloadBefore;
    if (!before) {
      this.note('forceload', true, 'not recorded and never changed (no scene reset ran)');
      return;
    }
    const added = AREA_CHUNKS.filter((c) => !before.has(c));
    for (const c of added) {
      const [cx, cz] = c.split(',').map(Number) as [number, number];
      await this.setup(`forceload remove ${cx * 16} ${cz * 16}`);
    }
    const after = parseForceloadQuery(await this.query('forceload query'));
    const same = after !== null && after.size === before.size && [...before].every((c) => after.has(c));
    this.note('forceload', same, same ? `restored: removed ${added.length} newly added chunk(s); set equals the recorded ${before.size}` : `NOT restored: recorded [${[...before].join(' ')}], now ${after ? `[${[...after].join(' ')}]` : 'unrecognized'}`);
  }

  async blockIs(p: { x: number; y: number; z: number }, key: string): Promise<boolean> {
    const r = await this.query(`execute if block ${p.x} ${p.y} ${p.z} ${key}`);
    return /Test passed/i.test(r);
  }

  // ------------------------------------------------------------ scene

  async resetScene(): Promise<void> {
    const { x1, z1, x2, z2 } = AREA;
    check(this.forceloadBefore, 'the forceloaded set must be recorded before the first forceload change');
    await this.setup(`forceload add ${x1} ${z1} ${x2} ${z2}`);
    await this.setup(`tp ${BOT} ${SCENE.start.x} ${SCENE.start.y + 30} ${SCENE.start.z}`);
    await this.setup(`effect give ${BOT} slow_falling 5 0 true`);
    await this.setup(`kill @e[type=!player,${ITEM_AREA}]`);
    await sleep(1_600);
    for (const c of [
      `kill @e[type=item,${ITEM_AREA}]`,
      `kill @e[type=experience_orb,${ITEM_AREA}]`,
      `fill ${x1} -60 ${z1} ${x2} -50 ${z2} air`,
      `fill ${x1} -61 ${z1} ${x2} -61 ${z2} grass_block`,
      `fill ${x1} -63 ${z1} ${x2} -62 ${z2} dirt`,
      ...SCENE.logs.map((p) => `setblock ${p.x} ${p.y} ${p.z} oak_log`),
      `clear ${BOT}`,
      // Above survival's default safe-food reserve (low 2, high 6), so no resupply support goal
      // competes with the scripted progression turns (survival behavior is MB-FLOW-003's gate).
      `give ${BOT} minecraft:bread 8`,
      `clear ${OWNER}`,
      `effect clear ${BOT}`,
      `gamemode survival ${BOT}`,
      `tp ${BOT} ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`,
      `tp ${OWNER} 199.5 -60 211.5 0 0`,
    ])
      await this.setup(c);
    await sleep(1_500);
  }

  // ------------------------------------------------------------ loopback Jev fault provider

  async startJev(): Promise<string> {
    this.jevServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        this.jevCalls += 1;
        const parsed = JSON.parse(body) as Json;
        const criteria = parsed.questions.next_action.criteria as Record<string, string>;
        const all = Object.keys(criteria);
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

  // ------------------------------------------------------------ CLI

  turns(turns: FaultTurn[]): void {
    setFaultTurns(this.faultDir, REAL_CODEX, turns, 'chatgpt');
  }
  prompts(): Json[] {
    return readJsonl(join(this.faultDir, 'fault-codex-prompts.jsonl'));
  }
  events(): Json[] {
    return readJsonl(this.eventsPath);
  }
  async waitEvent(pred: (e: Json) => boolean, timeoutMs: number, what: string): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.events().find(pred);
      if (hit) return hit;
      await sleep(150);
    }
    throw new Error(`timed out (${Math.round(timeoutMs / 1000)} s) waiting for ${what}`);
  }
  admitted(pred: (e: Json) => boolean = () => true): Json[] {
    return this.events().filter((e) => e.type === 'goal_admitted' && pred(e));
  }
  terminal(goalId: string): Json | undefined {
    return this.events().find((e) => e.type === 'goal_terminal' && e.goalId === goalId);
  }
  async waitTerminal(goalId: string, timeoutMs: number): Promise<Json> {
    return this.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goalId, timeoutMs, `goal ${goalId} to end`);
  }

  async start(name: string): Promise<CliProcess> {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENROUTER_API_KEY: 'fault-fixture-placeholder-key' };
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
    // Only the harness's own child (spawned above) is ever signalled; its exit is still awaited.
    if (!exited && p.child.exitCode === null) {
      killed = p.child.kill('SIGKILL');
      exited = await Promise.race([p.exited, sleep(10_000).then(() => undefined)]);
    }
    const run = this.runs.find((r) => r.pid === p.pid);
    const exit = exited ? { code: exited.code, signal: exited.signal, ...(killed ? { sigkillAfterMs: 20_000 } : {}) } : { notExited: true, sigkill: killed };
    if (run) run.exit = exit;
    this.note(`cli-exit pid ${p.pid ?? '?'}`, Boolean(exited) && !killed, exited ? (killed ? `exited only after SIGKILL (${JSON.stringify(exit)})` : `exited (${JSON.stringify(exit)})`) : 'did NOT exit within 10 s after SIGKILL');
    p.save(this.outDir);
    this.cli = undefined;
  }

  async status(): Promise<string[]> {
    const p = this.cli!;
    const from = p.length;
    p.send('status');
    await p.waitSince(/\[status\] autonomy session: /, from, 10_000);
    await sleep(200);
    return p.lines.slice(from).map((l) => l.text).filter((t) => t.startsWith('[status] '));
  }

  say(text: string): number {
    const from = this.cli!.length;
    this.owner!.chat(`!chunkbot ${text}`);
    return from;
  }

  /** Read-only durable autonomy state (only while no CLI process holds the writer lock). */
  controlOnDisk(): Json {
    const store = new ControlFileStore({ dir: autonomyScopeDirectory(join(this.dataDir, 'autonomy'), this.scope), scope: this.scope, clock: systemClock });
    const load = store.open({ readOnly: true });
    return { state: load.state, revision: load.revision, detail: load.detail, latch: load.body?.latch ?? null, home: load.body?.home ? { id: load.body.home.id, state: load.body.home.state, verified: load.body.home.verified ?? null, checkpoints: load.body.home.checkpoints.length, origin: load.body.home.origin, facing: load.body.home.entranceFacing } : null };
  }

  memoryHomeFacts(): Json[] {
    const report = inspectMemory(memoryRoot(this.dataDir, this.memoryConfig), this.memoryConfig, systemClock, { includeInactive: true, limit: 200 });
    return report.facts.filter((f) => (f.category === 'home' || f.label === 'chunkbot shelter') && f.source === 'verified_skill').map((f) => ({ id: f.id, category: f.category, label: f.label, source: f.source, status: f.status, location: f.location ?? null }));
  }

  async scenarioRun(id: string, title: string, fn: (ev: string[]) => Promise<void>): Promise<void> {
    if (this.results.some((r) => r.status === 'fail')) {
      // Scenarios build on each other (one CLI, one scope); after a failure the rest are skipped.
      this.results.push({ id, title, status: 'skipped', evidence: ['skipped: an earlier scenario failed'] });
      return;
    }
    this.scenario = id;
    const evidence: string[] = [];
    const started = Date.now();
    process.stdout.write(`RUN  ${id} ${title}\n`);
    try {
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

function readRconPassword(): string {
  const fx = fixturePaths(PROJECT_ROOT, PINS);
  const line = readFileSync(fx.properties, 'utf8').split('\n').find((l) => l.startsWith('rcon.password='));
  if (!line) throw new Error('fixture RCON password missing');
  return line.slice('rcon.password='.length).trim();
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

// ---------------------------------------------------------------- scenarios

async function run(outDir: string): Promise<Json> {
  const h = new Harness(outDir);
  const freeze = sourceFreeze();
  check(freeze.distCli, 'dist/cli.js is missing: run `npm run build` before the lease window (never during it)');
  const list = await h.query('list').catch((error: unknown) => {
    throw new Error(`fixture not reachable over RCON (${String(error)}); the coordinator starts it under the lease`);
  });
  process.stdout.write(`fixture: ${list}\n`);
  await h.recordForceload();

  // Generated config: the fixture autonomy profile with an independent data dir, a fresh scope,
  // the planner fault fixture and the loopback Jev endpoint. No secrets (the Jev key is a placeholder).
  mkdirSync(h.faultDir, { recursive: true });
  const faultCodex = writeFaultCodex(h.faultDir, REAL_CODEX);
  h.turns([{ kind: 'proposal', proposal: nothingAttainable() }]);
  const basePath = join(PROJECT_ROOT, PINS.config.replace(/\.json$/, '-autonomy.json'));
  const base = JSON.parse(readFileSync(basePath, 'utf8')) as Json;
  const endpoint = await h.startJev();
  const cfg: Json = {
    ...base,
    storage: { ...base.storage, dataDir: h.dataDir, maxEventsPerRun: 50_000 },
    models: { ...base.models, planner: { ...base.models.planner, mode: 'codex', command: faultCodex }, decision: { ...base.models.decision, endpoint } },
    limits: { ...base.limits, plannerTimeoutMs: 15_000 },
    memory: { worldProfile: h.memoryConfig.worldProfile, worldRevision: h.memoryConfig.worldRevision, botProfile: h.memoryConfig.botProfile },
    autonomy: { ...base.autonomy, startDelayMs: START_DELAY_MS, afterCompletionMs: AFTER_COMPLETION_MS, afterBlockedMs: 60_000, home: { enabled: true, interior: INTERIOR, maxSiteDistance: 12 } },
  };
  h.configPath = join(outDir, 'autonomy-live.config.json');
  writeFileSync(h.configPath, `${JSON.stringify(cfg, null, 2)}\n`);

  let report: Json = {};
  try {
    await h.scenarioRun('U0', 'ready with autonomy enabled; operator stop before the first assessment latches durably; no automatic goal while paused', async (ev) => {
      const cli = await h.start('run-1');
      const autonomyLine = cli.lines.find((l) => l.text.startsWith('[chunkbot] autonomy: '))?.text ?? '';
      ev.push(autonomyLine);
      check(/autonomy: enabled; scope autonomy-live-/.test(autonomyLine), 'autonomy enabled with the fresh scope');
      const from = cli.length;
      cli.send('stop');
      await sleep(500);
      const st = await h.status();
      ev.push(...st.filter((l) => /autonomy/.test(l)));
      check(st.some((l) => /stop latch PAUSED/.test(l)), 'latch paused after the operator stop');
      ev.push(`stop reply: ${cli.lines.slice(from).find((l) => /\[chunkbot\] (stop|Nothing to stop|Nothing was running|Stopped)/.test(l.text))?.text ?? 'n/a'}`);
      h.owner = await fixtureBot(OWNER);
      await h.resetScene();
      await sleep(START_DELAY_MS + 3_000);
      const auto = h.admitted((e) => e.source?.kind !== 'owner' && e.source !== undefined);
      ev.push(`automatic admissions while paused: ${auto.length}`);
      check(auto.length === 0, 'no automatic goal while paused');
    });

    let firstAuto: Json | undefined;
    await h.scenarioRun('U1', 'resume -> fresh assessment -> automatic progression via the single admission path; code-verified', async (ev) => {
      const logs0 = (await h.inventory())['minecraft:oak_log'] ?? 0;
      h.turns([{ kind: 'proposal', proposal: collectLogs(1, 'Collect one oak log as a first supply milestone.') }]);
      const promptsBefore = h.prompts().length;
      const from = h.cli!.length;
      h.cli!.send('resume');
      ev.push(await h.cli!.waitSince(/\[chunkbot\] Resumed: /, from, 5_000));
      const submitted = await h.waitEvent((e) => e.type === 'autonomy_goal_submitted' && e.source?.kind === 'progression', 30_000, 'an automatic progression submission');
      firstAuto = h.admitted((e) => e.goalId === submitted.goalId)[0];
      check(firstAuto, 'the automatic goal was admitted by the engine');
      ev.push(`admitted ${firstAuto.goalId}: surface ${firstAuto.surface}, source ${JSON.stringify(firstAuto.source)}, ceilings ${JSON.stringify(firstAuto.ceilings ?? null)}`);
      check(firstAuto.surface === 'supervisor' && firstAuto.source?.kind === 'progression', 'admitted on the supervisor surface with a progression source');
      const end = await h.waitTerminal(firstAuto.goalId, 120_000);
      ev.push(`terminal: ${end.state} (${end.reason}) ${String(end.detail ?? '').slice(0, 200)}`);
      const prompt = h.prompts().slice(promptsBefore)[0];
      ev.push(`planner input metadata: ${JSON.stringify(prompt ?? null)}`);
      check(prompt?.origin === 'automatic_progression' && prompt.autonomy?.source === 'progression', 'the planner input is labelled automatic and carries the autonomy context');
      check(end.state === 'completed' && end.reason === 'outcome_verified', 'outcome verified by code');
      const logs1 = (await h.inventory())['minecraft:oak_log'] ?? 0;
      ev.push(`RCON oak_log ${logs0} -> ${logs1}`);
      check(logs1 >= logs0 + 1, 'server inventory confirms the log');
    });

    let inFlight: string | undefined;
    await h.scenarioRun('U2', 'owner priority: an owner instruction during an automatic task takes over; the owner goal completes', async (ev) => {
      const sinceMs = Date.now();
      h.turns([
        { kind: 'proposal', proposal: collectLogs(2, 'Collect two more oak logs.') },
        { kind: 'proposal', proposal: comeHere() },
        // The assessment after the owner's verified completion: a slow planner turn, stopped in U3.
        { kind: 'proposal', proposal: nothingAttainable(), delayMs: 12_000 },
      ]);
      const sub = await h.waitEvent((e) => e.type === 'autonomy_goal_submitted' && e.source?.kind === 'progression' && Date.parse(String(e.t)) >= sinceMs, 30_000, 'the next automatic progression');
      const autoId = String(sub.goalId);
      await h.waitEvent((e) => e.type === 'task_admitted' && e.goalId === autoId, 30_000, 'the automatic task to start');
      const from = h.say('come here');
      const ownerAdm = await h.waitEvent((e) => e.type === 'goal_admitted' && e.source?.kind === 'owner' && Date.parse(String(e.t)) >= sinceMs, 30_000, 'the owner goal admission');
      const ownerAt = Date.parse(String(ownerAdm.t));
      const autoEnd = h.terminal(autoId) ?? (await h.waitTerminal(autoId, 10_000));
      const lateAuto = h.events().filter((e) => e.type === 'task_admitted' && e.goalId === autoId && Date.parse(String(e.t)) > ownerAt);
      ev.push(`automatic ${autoId} ended ${autoEnd.state} (${autoEnd.reason}); owner goal ${ownerAdm.goalId} admitted (replaced ${ownerAdm.replacedGoalId ?? 'none'}); automatic tasks after the switch: ${lateAuto.length}`);
      check(autoEnd.reason === 'replaced' || ownerAdm.replacedGoalId === autoId, 'the automatic goal was replaced by the owner goal');
      check(lateAuto.length === 0, 'no automatic task after the owner took over');
      const st = await h.status();
      ev.push(...st.filter((l) => /^\[status\] autonomy: /.test(l)));
      const ownerEnd = await h.waitTerminal(String(ownerAdm.goalId), 90_000);
      ev.push(`owner goal ${ownerEnd.state} (${ownerEnd.reason}); chat line: ${h.cli!.lines.slice(from).find((l) => /owner: !chunkbot come here/.test(l.text))?.text ?? 'n/a'}`);
      check(ownerEnd.state === 'completed', 'the owner goal completed');
      const ownerEndAt = Date.parse(String(ownerEnd.t));
      const back = await h.waitEvent((e) => e.type === 'autonomy_goal_submitted' && e.source?.kind === 'progression' && Date.parse(String(e.t)) >= ownerEndAt, AFTER_COMPLETION_MS + 15_000, 'progression to return after the owner goal');
      ev.push(`progression returned ${Date.parse(String(back.t)) - ownerEndAt} ms after the owner goal: ${back.goalId}`);
      await h.waitEvent((e) => e.type === 'planner_request' && e.goalId === back.goalId, 15_000, 'its planner turn to start');
      inFlight = String(back.goalId);
    });

    await h.scenarioRun('U3', 'durable stop: latch on disk, restored after restart (no automatic goal), resume reassesses afresh', async (ev) => {
      check(inFlight, 'U2 left an automatic goal planning');
      const stopAt = Date.now();
      const from = h.say('stop');
      await h.cli!.waitSince(/\[chat\] owner: !chunkbot stop/, from, 10_000);
      const cancelled = await h.waitTerminal(inFlight, 10_000);
      const plannerEnd = h.events().find((e) => (e.type === 'planner_turn_failed' || e.type === 'planner_turn_completed' || e.type === 'goal_cleanup') && (e.goalId === inFlight || e.goalId === undefined) && Date.parse(String(e.t)) >= stopAt);
      ev.push(`stop during automatic planning: ${inFlight} ${cancelled.state} (${cancelled.reason}) ${Date.parse(String(cancelled.t)) - stopAt} ms after the stop; planner turn end: ${plannerEnd ? `${plannerEnd.type} ${String(plannerEnd.failure ?? plannerEnd.kind ?? '')}`.trim() : 'n/a'}`);
      check(cancelled.state === 'cancelled', 'the planning automatic goal was cancelled by the stop');
      await sleep(800);
      const st = await h.status();
      ev.push(...st.filter((l) => /stop latch/.test(l)));
      check(st.some((l) => /stop latch PAUSED .*durable written/.test(l)), 'latch paused and durably written');
      await h.quit();
      const disk = h.controlOnDisk();
      ev.push(`on disk after quit: ${JSON.stringify(disk)}`);
      check(disk.latch?.paused === true, 'the durable store holds the paused latch');
      // While paused and offline-restarting, hand the bot the home materials (setup).
      const cli = await h.start('run-2');
      const line = cli.lines.find((l) => l.text.startsWith('[chunkbot] autonomy: '))?.text ?? '';
      ev.push(line);
      check(/PAUSED \(stop latch restored; say resume\)/.test(line), 'latch restored at startup');
      await h.setup(`clear ${BOT}`);
      await h.setup(`give ${BOT} minecraft:bread 8`);
      await h.setup(`give ${BOT} ${BUILD_MATERIAL} 64`);
      for (const item of ['minecraft:crafting_table', 'minecraft:furnace', 'minecraft:chest']) await h.setup(`give ${BOT} ${item} 1`);
      await h.setup(`tp ${BOT} ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
      await h.setup(`tp ${OWNER} 198.5 -60 222.5 0 0`);
      await sleep(START_DELAY_MS + 3_000);
      const auto = h.admitted((e) => e.source?.kind !== 'owner' && e.source !== undefined);
      ev.push(`automatic admissions after restart while paused: ${auto.length}`);
      check(auto.length === 0, 'no automatic goal while the restored latch is set');
      h.turns([{ kind: 'proposal', proposal: buildHome() }]);
      const promptsBefore = h.prompts().length;
      const f2 = h.say('resume');
      ev.push(await cli.waitSince(/\[chunkbot\] Resumed: /, f2, 10_000));
      const sub = await h.waitEvent((e) => e.type === 'autonomy_goal_submitted' && e.source?.kind === 'progression', 30_000, 'a fresh automatic assessment after resume');
      ev.push(`fresh assessment admitted ${sub.goalId}`);
      // The fault planner has read its scripted turn once the input metadata line exists.
      const deadline = Date.now() + 20_000;
      while (h.prompts().length <= promptsBefore && Date.now() < deadline) await sleep(150);
      ev.push(`planner input metadata: ${JSON.stringify(h.prompts().slice(promptsBefore)[0] ?? null)}`);
    });

    await h.scenarioRun('U4', 'home: site approved and small_shelter_v1 built by the automatic goal; structure_state complete verified by code; every cell confirmed over RCON', async (ev) => {
      const goal = h.admitted((e) => e.source?.kind === 'progression').at(-1);
      check(goal, 'the home goal was admitted in U3');
      const cobble0 = (await h.inventory())[BUILD_MATERIAL] ?? 0;
      h.turns([{ kind: 'proposal', proposal: repairHome() }]);
      const end = await h.waitTerminal(String(goal.goalId), 10 * 60_000);
      ev.push(`home goal ${goal.goalId}: ${end.state} (${end.reason}) ${String(end.detail ?? '').slice(0, 240)}`);
      const builds = h.events().filter((e) => e.type === 'task_action' && e.goalId === goal.goalId).length;
      ev.push(`task actions: ${builds}; Jev calls so far: ${h.jevCalls}`);
      // Stop further automatic work before inspecting (the scripted next turn is a no-op repair anyway).
      h.say('stop');
      await sleep(800);
      const st = await h.status();
      const homeLine = st.find((l) => /^\[status\] home: /.test(l)) ?? '';
      ev.push(homeLine);
      check(end.state === 'completed' && end.reason === 'outcome_verified', 'the home outcome was verified by code');
      const m = /home: (proj-\S+) (\w+) at (-?\d+),(-?\d+),(-?\d+) \S+ \(\d+x\d+, entrance (\w+)\)/.exec(homeLine);
      check(m && m[2] === 'complete', 'status shows the home project complete');
      h.home = { id: m[1]!, origin: { x: Number(m[3]), y: Number(m[4]), z: Number(m[5]) }, facing: m[6] as Facing };
      const cells = smallShelterCells(h.home.origin, INTERIOR, h.home.facing).filter((c) => c.role !== 'aid');
      const wrong: string[] = [];
      for (const c of cells) {
        const want = c.role === 'entrance' ? 'minecraft:air' : c.role === 'wall' || c.role === 'roof' ? BUILD_MATERIAL : c.accept[0]!;
        if (!(await h.blockIs(c.at, want))) wrong.push(`${c.role}@${c.at.x},${c.at.y},${c.at.z}!=${want}`);
      }
      const cobble1 = (await h.inventory())[BUILD_MATERIAL] ?? 0;
      ev.push(`RCON: ${cells.length - wrong.length}/${cells.length} blueprint cells as required${wrong.length ? `; wrong: ${wrong.slice(0, 8).join(' ')}` : ''}; cobblestone ${cobble0} -> ${cobble1}`);
      check(wrong.length === 0, 'every blueprint cell confirmed by the server');
    });

    await h.scenarioRun('U5', 'restart + repair: offline damage, stored project historical, fresh inspection re-places the missing cell, code re-verifies', async (ev) => {
      check(h.home, 'U4 produced a verified home');
      await h.quit();
      const disk = h.controlOnDisk();
      ev.push(`on disk: ${JSON.stringify(disk)}`);
      check(disk.home?.state === 'complete' && disk.latch?.paused === true, 'project complete and latch paused on disk');
      const facts = h.memoryHomeFacts();
      ev.push(`memory verified-home facts: ${JSON.stringify(facts)}`);
      check(facts.length >= 1, 'the verified home was recorded in memory');
      const wall = smallShelterCells(h.home.origin, INTERIOR, h.home.facing).find((c) => c.role === 'wall' && c.at.y === h.home!.origin.y + 1)!;
      await h.intervene(`setblock ${wall.at.x} ${wall.at.y} ${wall.at.z} air`, 'simulated damage while the bot is offline (repair trial)');
      const cli = await h.start('run-3');
      ev.push(cli.lines.find((l) => l.text.startsWith('[chunkbot] autonomy: '))?.text ?? '');
      await h.setup(`tp ${BOT} ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
      await sleep(2_000);
      h.turns([{ kind: 'proposal', proposal: repairHome() }, { kind: 'proposal', proposal: nothingAttainable(), delayMs: 6_000 }]);
      const promptsBefore = h.prompts().length;
      const sinceMs = Date.now();
      h.say('resume');
      const sub = await h.waitEvent((e) => e.type === 'autonomy_goal_submitted' && e.source?.kind === 'progression' && Date.parse(String(e.t)) >= sinceMs, 30_000, 'the automatic repair assessment');
      const end = await h.waitTerminal(String(sub.goalId), 5 * 60_000);
      const prompt = h.prompts().slice(promptsBefore)[0];
      ev.push(`planner input metadata: ${JSON.stringify(prompt ?? null)} (stored home state is historical)`);
      ev.push(`repair goal ${sub.goalId}: ${end.state} (${end.reason}) ${String(end.detail ?? '').slice(0, 200)}`);
      h.say('stop');
      const restored = await h.blockIs(wall.at, BUILD_MATERIAL);
      ev.push(`RCON: damaged wall cell ${wall.at.x},${wall.at.y},${wall.at.z} restored: ${restored}`);
      check(prompt?.autonomy?.home === 'complete', 'the planner saw the stored (historical) home state');
      check(end.state === 'completed' && end.reason === 'outcome_verified', 'repair verified by code');
      check(restored, 'the server confirms the repaired cell');
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
        await h.quit(); // records its own cli-exit entry
      });
    }
    await step('items', async () => `kill items in the entity box: ${(await h.setup(`kill @e[type=item,${ITEM_AREA}]`)).slice(0, 80)}`);
    // P-C8: a reply for an absent player is labelled as such, never as a verified empty inventory.
    for (const [name, command] of [['bot-inventory', `clear ${BOT}`], ['owner-inventory', `clear ${OWNER}`], ['bot-effects', `effect clear ${BOT}`]] as const) {
      await step(name, async () => {
        const l = playerCleanupLabel(await h.setup(command));
        h.note(name, l.ok, `${command}: ${l.label}: ${l.detail}`);
      });
    }
    await step('forceload-restore', async () => {
      await h.restoreForceload(); // records its own forceload entry
    });
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
      if (!srv) return 'loopback Jev never started';
      srv.closeAllConnections();
      await new Promise<void>((r, j) => srv.close((e) => (e ? j(e) : r())));
      return 'loopback Jev closed';
    });
    const counted = h.results.filter((r) => r.status !== 'skipped');
    const scenariosPass = counted.length > 0 && counted.every((r) => r.status === 'pass');
    const cleanupFailures = h.cleanup.filter((c) => !c.ok);
    report = {
      check: 'MB-FLOW-001 automatic progression live check (PLANNER FAULT FIXTURE + loopback Jev; harness validation, no inference)',
      fixture: PINS.profile,
      sourceFreeze: freeze,
      config: { path: h.configPath, base: basePath, scope: h.scope, dataDir: h.dataDir, interior: INTERIOR, material: BUILD_MATERIAL },
      // An unreconciled cleanup fails the run even when every scenario passed (never silently).
      pass: scenariosPass && cleanupFailures.length === 0,
      scenariosPass,
      cleanup: { reconciled: cleanupFailures.length === 0, failures: cleanupFailures, steps: h.cleanup, forceloadBefore: h.forceloadBefore ? [...h.forceloadBefore] : null, areaChunks: AREA_CHUNKS },
      footprint: { blocks: { x: [AREA.x1, AREA.x2], y: [-63, -50], z: [AREA.z1, AREA.z2] }, entitySelector: ITEM_AREA, entityBox: { x: [AREA.x1, AREA.x2], y: [-64, -24], z: [AREA.z1, AREA.z2] }, players: [BOT, OWNER], shelterLeftForInspection: h.home ?? null },
      results: h.results,
      setup: h.setupLog,
      interventions: h.interventions,
      runs: h.runs.map((r) => {
        const ev = readJsonl(r.events);
        const bySource: Record<string, number> = {};
        for (const e of ev.filter((x) => x.type === 'goal_admitted')) bySource[String(e.source?.kind ?? 'none')] = (bySource[String(e.source?.kind ?? 'none')] ?? 0) + 1;
        return { ...r, admissionsBySource: bySource, plannerRequests: ev.filter((x) => x.type === 'planner_request').length, terminals: ev.filter((x) => x.type === 'goal_terminal').map((x) => ({ goalId: x.goalId, state: x.state, reason: x.reason })) };
      }),
      plannerInputs: h.prompts(),
      jevCalls: h.jevCalls,
      home: h.home ?? null,
    };
  }
  return report;
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

async function main(): Promise<number> {
  // Shared fixtures are leased: nothing (no password read, RCON, join, config or output) happens without an explicit lease id.
  const lease = arg('--fixture-lease');
  if (!lease || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(lease)) {
    process.stderr.write('refusing to run: pass --fixture-lease <granted lease id> (the shared loopback fixtures are leased by the coordinator)\n');
    return 2;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${SUFFIX}-autonomy`);
  mkdirSync(outDir, { recursive: true });
  process.stdout.write(`autonomy live check (${PINS.profile}, lease ${lease}) -> ${outDir}\n`);
  const report = await run(outDir);
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify({ ...report, lease }, null, 2)}\n`);
  const cleanup = report['cleanup'] as { reconciled: boolean; failures: Array<{ step: string; detail: string }> } | undefined;
  if (cleanup && !cleanup.reconciled) for (const f of cleanup.failures) process.stdout.write(`CLEANUP NOT RECONCILED: ${f.step} — ${f.detail}\n`);
  process.stdout.write(`${report['pass'] ? 'PASS' : 'FAIL'} autonomy live check — ${outDir}\n`);
  return report['pass'] ? 0 : 1;
}

/**
 * Import safety: importing this module never runs anything. main() starts only
 * when this file is the process entry point, and main() refuses (exit 2)
 * before any fixture password read, RCON command, join, config or
 * output-directory write unless --fixture-lease <granted id> is given.
 */
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
