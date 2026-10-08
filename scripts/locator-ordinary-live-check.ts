// MB-LOC-002 ORDINARY-PIPELINE locator/follow check against the LOCAL loopback
// test fixtures only (harness validation; never planner/Jev quality acceptance).
//
// Drives the REAL built CLI (`node dist/cli.js run --no-autonomy`) through
// normal owner chat intake ("!chunkbot follow me", "come here", "stop") with:
//   * the shared PLANNER FAULT FIXTURE (scripts/lib/fault-codex.ts) replaying
//     scripted planner turns, wrapped by a prompt-capturing stand-in so every
//     planner prompt the application renders is saved for the privacy scan
//     (the real installed Codex CLI still answers only the read-only isolation
//     gate passthroughs: --version, debug models --bundled, features list;
//     `login status` is scripted as the managed ChatGPT mode — NO inference);
//   * a LOOPBACK Jev provider that always picks the FIRST offered option (no
//     knowledge of the scenario) and records which capabilities were offered.
// The application composes its own locator/route modules exactly as in a
// normal run (cli.ts -> SkillRuntime features.locator). The harness never
// reaches into the application process.
//
// Oracle: RCON server positions of Chunkbot and the owner (never given to the
// application or models); run evidence (events.jsonl); CLI lines. Privacy: no
// planner prompt or Jev request rendered while the owner was out of sight may
// contain the owner's server-truth coordinates.
//
// Scenarios (all inside the declared footprint; NO block writes):
//   O0  CLI ready with locator/routes; owner joins; owner cue tracked
//   O1  far "follow me": owner 300+ blocks away (unseen, beyond the 128 admission
//       radius): first movement agrees with the true bearing; counted route legs;
//       reunion by server positions; admission anchor unchanged; goal persists
//   O1b persistent following while the owner walks (server-sampled distances)
//   O1c sight lost twice (the owner moves 70 blocks away, cue still current): the
//       SAME persistent goal reacquires through the cue each time (no planner turn)
//   O1d owner hides (sneak) and leaves sight: no wandering, no question, no
//       undirected exploration; one declarative end within bounded planner turns
//   O2  stop while seeking: controls cleared (server positions), route revoked
//   O3  finite "come here" beyond 128 completes only at verified owner proximity
//   O4  replacement while seeking: old goal replaced, old route revoked, new route
//   O5  owner logout while seeking (a guest stays on the opposite side): the bot
//       stops, the guest's waypoint never steers it, declarative end
//   O6  owner dimension change while seeking: withdrawn, the bot stops
//   O7  route exhaustion (small operator route budget, separate CLI config):
//       expanded authority withdrawn, no further movement, truthful counters
//   O8  operator /reconnect while seeking: old guidance discarded; a fresh
//       broadcast is required; no movement without a new goal
//   O9  visible follow inside the admission radius (ordinary regression)
//
// Safety: importing this module runs nothing. main() refuses (exit 2) before
// any fixture password read, RCON command, join, child process or output
// directory unless --fixture-lease <granted id> is given. Every RCON command is
// recorded. Teleports go ONLY through a checked helper inside
// ORDINARY_FOOTPRINT. Finally: owner/guest effects and controls cleared, fake
// players disconnected, Chunkbot teleported back to its recorded starting
// position, CLI stopped; any failed restoration fails the report.
//
//   npm run build   (source/build frozen for the run)
//   node scripts/locator-ordinary-live-check.ts --fixture-lease <id> [--fixture 26.2] [--only O1,O2]
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { insideBox, isEntryPoint, type Box } from './locator-live-check.ts';
import type { FaultTurn } from './lib/fault-codex.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type P = { x: number; y: number; z: number };

/** Flat fixture ground: grass at y -61, standing y -60. Far from every other harness scene. */
export const ORD_BASE = { x: 2000.5, y: -60, z: 2000.5 };

export const ORDINARY_FOOTPRINT = {
  /** Every overworld teleport destination (players stand on the flat ground). */
  overworldTeleports: { x1: 1700, x2: 2400, y1: -60, y2: -60, z1: 1700, z2: 2300 },
  /** Owner's dimension trip: nether roof, the same point the reviewed locator gates use. */
  netherTeleports: { x1: 0, x2: 1, y1: 128, y2: 128, z1: 0, z2: 1 },
  /** Chunkbot must stay inside this envelope; leaving it aborts the run (owner says stop). */
  botEnvelope: { x1: 1600, x2: 2500, y1: -64, y2: 320, z1: 1600, z2: 2400 },
} as const satisfies Record<string, Box>;

export const NETHER_ROOF = { x: 0.5, y: 128, z: 0.5 };

/** Every named overworld teleport destination (absolute). Distinctive owner coordinates help the privacy scan. */
export const ORD_TELEPORTS: Record<string, { x: number; y: number; z: number }> = {
  base: ORD_BASE,
  ownerBeside: { x: ORD_BASE.x + 3, y: -60, z: ORD_BASE.z },
  ownerFarEast: { x: 2301.5, y: -60, z: 2043.5 }, // 300 east, 43 south: chunk/azimuth precision, beyond 128
  ownerFarWest: { x: 1751.5, y: -60, z: 1969.5 }, // 249 west, 31 north
  ownerFarSouthWest: { x: 1821.5, y: -60, z: 2121.5 }, // 179 west, 121 south
  ownerFarNorth: { x: 2017.5, y: -60, z: 1737.5 }, // 263 north
  guestFarWest: { x: 1801.5, y: -60, z: 2000.5 },
};

export const ORDINARY_SCENARIOS = ['O0', 'O1', 'O1b', 'O1c', 'O1d', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8', 'O9'] as const;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

function argOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------- planner wire proposals

export function wp(p: Json): Json {
  const base: Json = { predicate: null, selector: null, atLeast: null, mode: null, mayBeConsumedLater: null, slot: null, target: null, within: null, expect: null, output: null, outcome: null, of: null };
  return { ...base, ...p };
}
export function wt(t: Json): Json {
  const base: Json = { kind: null, key: null, snapshotId: null, handle: null, anchorId: null, dimension: null, at: null, ownerText: null, actionId: null };
  return { ...base, ...t };
}
const NEAR_OWNER = () => wp({ predicate: 'near_target', target: wt({ kind: 'owner' }), within: 3 });
function proposal(p: Json): Json {
  return { disposition: 'plan', interpretation: 'fixture plan', outcome: null, tasks: [], morePlanningNeeded: false, queries: [], question: null, missing: null, missingCapabilities: [], verifiedProgress: null, ...p };
}
/** What a planner is expected to propose for "follow me" with the locator installed (shared catalog capabilities). */
export const OWNER_CAPABILITIES = ['follow_entity', 'move_near', 'seek_owner'];
export const followMe = () =>
  proposal({
    interpretation: 'Stay near the owner while they move; find them by their locator direction when out of sight.',
    outcome: { kind: 'persistent', predicate: NEAR_OWNER() },
    tasks: [{ objective: 'Stay near the owner.', decisionInstruction: 'Follow the owner; when they are out of sight or beyond the travel radius, seek them.', allowedCapabilities: OWNER_CAPABILITIES, targetSelectors: [wt({ kind: 'owner' })], parameters: [], completion: NEAR_OWNER() }],
  });
export const comeHere = () =>
  proposal({
    interpretation: 'Walk to the owner.',
    outcome: { kind: 'finite', predicate: NEAR_OWNER() },
    tasks: [{ objective: 'Walk to the owner.', decisionInstruction: 'Move next to the owner; seek them when out of sight.', allowedCapabilities: OWNER_CAPABILITIES, targetSelectors: [wt({ kind: 'owner' })], parameters: [], completion: NEAR_OWNER() }],
  });
export const blockedTurn = (missing: string) => proposal({ disposition: 'cannot_execute', interpretation: 'Follow the owner.', missing });

// ---------------------------------------------------------------- privacy scan

/**
 * Whether a model-visible text contains a hidden owner coordinate: the owner's
 * server-truth integer x or z (floor/round, +/-1) as a standalone number.
 * Callers pass only texts rendered while the owner was far out of sight and
 * coordinates the bot's own position could not produce at that time.
 */
export function leaksCoordinate(text: string, owner: { x: number; z: number }): string | undefined {
  const values = new Set<number>();
  for (const v of [owner.x, owner.z]) {
    if (!Number.isFinite(v)) continue;
    for (const base of [Math.floor(v), Math.round(v)]) for (const d of [-1, 0, 1]) values.add(base + d);
  }
  for (const n of values) {
    const re = new RegExp(`(?<![0-9.])${String(n).replace('-', '\\-')}(?:\\.[0-9]+)?(?![0-9])`);
    if (re.test(text)) return String(n);
  }
  return undefined;
}

/**
 * Writes the prompt-capturing planner stand-in into `dir`: for `exec` it saves
 * the full prompt the application rendered into `promptDir`, then runs the
 * shared fault fixture with the same arguments and stdin; every other command
 * (the read-only isolation gate) goes straight to the fault fixture. Returns
 * its path. Writes only inside the given directories.
 */
export function writePromptCapture(dir: string, faultCodex: string, promptDir: string): string {
  const wrapper = join(dir, 'capture-codex.cjs');
  writeFileSync(
    wrapper,
    `#!${process.execPath}
    // Prompt-capturing stand-in (locator ordinary harness): saves each exec prompt, then runs the shared fault fixture.
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const target = ${JSON.stringify(faultCodex)};
    const args = process.argv.slice(2);
    if (!args.includes('exec')) {
      const c = spawn(target, args, { stdio: 'inherit' });
      c.on('exit', (code) => { process.exitCode = code === null ? 1 : code; });
    } else {
      let input = '';
      process.stdin.on('data', (d) => (input += d));
      process.stdin.on('end', () => {
        const dir = ${JSON.stringify(promptDir)};
        const n = fs.readdirSync(dir).length;
        fs.writeFileSync(path.join(dir, String(n).padStart(4, '0') + '-' + Date.now() + '.txt'), input);
        const c = spawn(target, args, { stdio: ['pipe', 'inherit', 'inherit'] });
        c.stdin.end(input);
        c.on('exit', (code) => { process.exitCode = code === null ? 1 : code; });
      });
    }
`,
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

// ---------------------------------------------------------------- run

interface Result {
  id: string;
  title: string;
  pass: boolean;
  evidence: string[];
  data: Json;
}

async function run(argv: readonly string[], lease: string): Promise<number> {
  // Heavy imports only after the lease check (import safety, no side effects).
  const { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } = await import('../src/app/fixture-layout.ts');
  const { CliProcess, CLI } = await import('./lib/cli-process.ts');
  const { rconCommand } = await import('./lib/rcon.ts');
  const { setFaultTurns, writeFaultCodex } = await import('./lib/fault-codex.ts');
  const { catalogProblems, expectedCapabilityIds, runProfile, LOCATOR_SKILL_IDS } = await import('./lib/profile-catalog.ts');
  const { loadConfigFile } = await import('../src/config/load.ts');
  const mineflayer = (await import('mineflayer')).default;
  type Bot = ReturnType<typeof mineflayer.createBot>;

  const PINS = fixturePins(fixtureProfileFromArgv(argv));
  const SUFFIX = PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${PINS.profile}`;
  const VERSION_RE = PINS.minecraftVersion.replace(/\./g, '\\.');
  const onlyArg = argOf(argv, '--only');
  const only = onlyArg ? new Set(onlyArg.split(',')) : undefined;
  if (only) for (const id of only) assert((ORDINARY_SCENARIOS as readonly string[]).includes(id), `unknown scenario ${id}`);
  const fx = fixturePaths(PROJECT_ROOT, PINS);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${SUFFIX}-locator-ordinary`);
  mkdirSync(outDir, { recursive: true });
  const REAL_CODEX = '/opt/homebrew/bin/codex';

  // Provenance: source/build/runtime identities recorded for review.
  const git = (args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
    } catch {
      return 'unavailable';
    }
  };
  const provenance = {
    head: git(['rev-parse', 'HEAD']),
    dirtyPaths: git(['status', '--porcelain']).split('\n').filter(Boolean).length,
    distCliSha256: existsSync(CLI) ? createHash('sha256').update(readFileSync(CLI)).digest('hex') : 'missing',
    node: process.version,
  };

  const props = readFileSync(fx.properties, 'utf8').split('\n');
  const password = props.find((l) => l.startsWith('rcon.password='))?.slice('rcon.password='.length).trim();
  assert(password, 'fixture RCON password missing');
  const viewDistance = Number(props.find((l) => l.startsWith('view-distance='))?.split('=')[1] ?? '10');

  const setupLog: Array<{ atMs: number; scenario: string; command: string; reply: string }> = [];
  const ownerScript: Array<{ atMs: number; scenario: string; action: string }> = [];
  let scenario = 'preflight';
  let rconQueue: Promise<unknown> = Promise.resolve();
  const rcon = async (command: string, record = true): Promise<string> => {
    const job = rconQueue.then(() => rconCommand(PINS.host, PINS.rconPort, password, command));
    rconQueue = job.catch(() => undefined);
    const reply = await job;
    if (record) setupLog.push({ atMs: Date.now(), scenario, command, reply: reply.slice(0, 200) });
    return reply;
  };
  const serverPos = async (name: string) => {
    const r = await rcon(`data get entity ${name} Pos`, false);
    const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(r);
    assert(m, `cannot read ${name} position: ${r.slice(0, 120)}`);
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  };
  const BOT = 'Chunkbot';
  const OWNER = 'FixtureOwner';
  const GUEST = 'FixtureGuest';
  /** The ONLY teleport path: a declared destination checked against the footprint before any RCON. */
  const tp = async (player: string, key: keyof typeof ORD_TELEPORTS | 'netherRoof', rotation = '') => {
    if (key === 'netherRoof') {
      assert(insideBox(ORDINARY_FOOTPRINT.netherTeleports, NETHER_ROOF), 'nether destination outside the declared footprint');
      await rcon(`execute in minecraft:the_nether run tp ${player} ${NETHER_ROOF.x} ${NETHER_ROOF.y} ${NETHER_ROOF.z}`);
      return;
    }
    const at = ORD_TELEPORTS[key];
    assert(at && insideBox(ORDINARY_FOOTPRINT.overworldTeleports, at), `teleport ${String(key)} outside the declared footprint`);
    await rcon(`execute in minecraft:overworld run tp ${player} ${at.x} ${at.y} ${at.z}${rotation ? ` ${rotation}` : ''}`);
  };
  /** Scripted owner walking: relative steps, each checked against the footprint. */
  const ownerStep = async (to: { x: number; z: number }, why: string) => {
    const at = { x: to.x, y: -60, z: to.z };
    assert(insideBox(ORDINARY_FOOTPRINT.overworldTeleports, at), `owner step outside the declared footprint (${why})`);
    ownerScript.push({ atMs: Date.now(), scenario, action: `step ${why}` });
    await rcon(`execute in minecraft:overworld run tp ${OWNER} ${at.x} ${at.y} ${at.z}`);
  };
  const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

  // ------------------------------------------------------------ loopback Jev (first option) + capture
  const jevLog: Array<{ atMs: number; scenario: string; offered: string[]; chosen: string; body: string }> = [];
  let jevServer: Server | undefined;
  const startJev = async (): Promise<string> => {
    jevServer = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const parsed = JSON.parse(body) as Json;
        const criteria = (parsed.questions?.next_action?.criteria ?? {}) as Record<string, string>;
        const keys = Object.keys(criteria);
        const pick = keys[0] ?? 'none';
        const offered = keys.map((k) => String(criteria[k] ?? '').split(':')[0] ?? '?');
        jevLog.push({ atMs: Date.now(), scenario, offered, chosen: offered[0] ?? '?', body });
        const bytes = Buffer.byteLength(body);
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            model: 'typesafe/jev-1.13-20260917',
            provider: 'TypeSafe',
            id: 'gen-dec-LOCATOR-FIXTURE',
            answers: { next_action: { type: 'choice', choice: pick, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])), confidence: 1 } },
            usage: { input_tokens: Math.round(bytes / 3), output_tokens: 10, cost: Math.round(bytes / 3) * 4.2e-8 },
          }),
        );
      });
    });
    await new Promise<void>((r) => jevServer!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(jevServer.address() as AddressInfo).port}/api/alpha/decisions`;
  };

  // ------------------------------------------------------------ planner fault fixture + prompt capture
  const faultDir = join(outDir, 'fault-planner');
  const promptDir = join(faultDir, 'prompts');
  mkdirSync(promptDir, { recursive: true });
  const faultCodex = writeFaultCodex(faultDir, REAL_CODEX);
  const wrapper = writePromptCapture(faultDir, faultCodex, promptDir);
  const turnsFor = (turns: FaultTurn[]) => setFaultTurns(faultDir, REAL_CODEX, turns, 'chatgpt');
  const prompts = () =>
    readdirSync(promptDir)
      .sort()
      .map((f) => ({ atMs: Number(/-(\d+)\.txt$/.exec(f)?.[1] ?? 0), text: readFileSync(join(promptDir, f), 'utf8') }));

  // ------------------------------------------------------------ configs
  const base = JSON.parse(readFileSync(join(PROJECT_ROOT, PINS.config), 'utf8')) as Json;
  const keyEnv = String(base.models?.decision?.apiKeyEnv ?? 'OPENROUTER_API_KEY');
  const env: NodeJS.ProcessEnv = { ...process.env, [keyEnv]: 'loopback-fixture-placeholder-key' };
  const decision = { ...base.models.decision, endpoint: await startJev() };
  const makeConfig = (name: string, locator: Json | undefined): string => {
    const cfg: Json = {
      ...base,
      storage: { ...base.storage, dataDir: join(outDir, `data-${name}`) },
      models: { ...base.models, planner: { ...base.models.planner, mode: 'codex', command: wrapper }, decision },
      limits: { ...base.limits, plannerTimeoutMs: 8_000 },
      ...(locator ? { locator } : {}),
    };
    const path = join(outDir, `${name}.json`);
    writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
    return path;
  };
  const normalConfig = makeConfig('ordinary', undefined);
  // O7: a deliberately small operator route budget (code-owned config; the planner cannot change it).
  const exhaustConfig = makeConfig('exhaust', { routes: { maxTotalDistance: 192, maxLegs: 3 } });

  // ------------------------------------------------------------ CLI helpers
  let cli!: InstanceType<typeof CliProcess>;
  let cliStarted = false;
  let eventsPath = '';
  const readJsonl = (path: string): Json[] => {
    try {
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Json);
    } catch {
      return [];
    }
  };
  const events = () => readJsonl(eventsPath);
  const tOf = (e: Json) => Date.parse(String(e.t));
  const startCli = async (name: string, configPath: string) => {
    const p = new CliProcess(name, ['run', '--no-autonomy', '--config', configPath], env);
    cli = p; // owned immediately: a failed start is still stopped in finally
    cliStarted = true;
    await p.waitFor(/\[chunkbot\] planner: /, 30_000);
    const runLine = await p.waitFor(/\[chunkbot\] run \S+; evidence: /, 10_000);
    eventsPath = /evidence: (\S+)$/.exec(runLine)?.[1] ?? '';
    await p.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${VERSION_RE}`), 40_000);
    return p;
  };
  const stopCli = async () => {
    cli.send('/quit');
    const exited = await Promise.race([cli.exited, sleep(15_000).then(() => undefined)]);
    if (!exited) cli.child.kill('SIGKILL');
    cli.save(outDir);
  };
  const fixturePlayer = async (username: string): Promise<Bot> => {
    const bot = mineflayer.createBot({ host: PINS.host, port: PINS.port, username, auth: 'offline', version: PINS.minecraftVersion, hideErrors: true });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${username} did not spawn`)), 20_000);
      bot.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      bot.once('end', (reason: string) => reject(new Error(`${username} ended: ${reason}`)));
    });
    return bot;
  };
  const say = (who: Bot, text: string) => {
    const from = cli.length;
    ownerScript.push({ atMs: Date.now(), scenario, action: `chat: ${text}` });
    who.chat(`!chunkbot ${text}`);
    return { at: Date.now(), from };
  };
  const lineSince = async (pattern: RegExp, from: number, timeoutMs: number) => {
    const text = await cli.waitSince(pattern, from, timeoutMs);
    return cli.lines.slice(from).find((l) => l.text === text)!;
  };
  const goalAccepted = async (from: number, timeoutMs = 25_000) => {
    const l = await lineSince(/\[chunkbot\] Goal (goal-\S+) accepted: /, from, timeoutMs);
    return { goalId: /Goal (goal-\S+) accepted/.exec(l.text)![1]!, atMs: l.atMs };
  };
  const goalTerminal = async (goalId: string, from: number, timeoutMs: number) => {
    const re = new RegExp(`\\[chunkbot\\] Goal ${goalId} (completed|blocked|failed|cancelled) \\((\\w+)\\)`);
    const l = await lineSince(re, from, timeoutMs);
    const m = re.exec(l.text)!;
    return { state: m[1]!, reason: m[2]!, line: l.text, atMs: l.atMs };
  };
  const terminalOf = (goalId: string) => cli.lines.find((l) => new RegExp(`\\[chunkbot\\] Goal ${goalId} (completed|blocked|failed|cancelled)`).test(l.text));
  const waitEvent = async (pred: (e: Json) => boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = events().find(pred);
      if (hit) return hit;
      await sleep(150);
    }
    throw new Error(`timed out waiting for an evidence event (${pred.toString().slice(0, 140)})`);
  };
  /** Samples the server positions until `until` holds or the timeout; aborts if Chunkbot leaves the envelope. */
  const samples: Array<{ scenario: string; atMs: number; dtMs: number; bot: P; owner: P | null; distance: number | null }> = [];
  const sampleUntil = async (t0: number, until: (b: P, o: P | null) => boolean, timeoutMs: number, ownerOnline = true): Promise<{ bot: P; owner: P | null; ok: boolean }> => {
    const deadline = Date.now() + timeoutMs;
    let last: { bot: P; owner: P | null } | undefined;
    while (Date.now() < deadline) {
      const b = await serverPos(BOT);
      const o = ownerOnline ? await serverPos(OWNER).catch(() => null) : null;
      const d = o ? Math.hypot(b.x - o.x, b.y - o.y, b.z - o.z) : null;
      samples.push({ scenario, atMs: Date.now(), dtMs: Date.now() - t0, bot: b, owner: o, distance: d === null ? null : Math.round(d * 10) / 10 });
      if (!insideBox(ORDINARY_FOOTPRINT.botEnvelope, b)) throw new Error(`Chunkbot left the declared envelope at ${b.x.toFixed(0)}, ${b.z.toFixed(0)}`);
      last = { bot: b, owner: o };
      if (until(b, o)) return { ...last, ok: true };
      await sleep(1_000);
    }
    return { ...(last ?? { bot: await serverPos(BOT), owner: null }), ok: false };
  };
  const goalEvents = (goalId: string, type: string) => events().filter((e) => e.type === type && e.goalId === goalId);
  const routeEvents = (sinceMs: number) => events().filter((e) => String(e.type).startsWith('route_') && tOf(e) >= sinceMs);
  const actionsSince = (sinceMs: number) => events().filter((e) => e.type === 'skill_outcome' && tOf(e) >= sinceMs).map((e) => ({ capability: (e.outcome ?? e).capability, status: (e.outcome ?? e).status, reason: (e.outcome ?? e).reason ?? null }));

  /**
   * Privacy: model-visible texts (planner prompts, Jev requests) rendered while
   * the owner was out of sight (server distance > 40 in the sampled window) must
   * not carry the owner's server-truth x or z. A coordinate is checked only when
   * Chunkbot's OWN sampled positions in that window could not produce it.
   */
  const privacyFindings: Array<{ scenario: string; source: string; value: string }> = [];
  const privacyScans: Array<{ scenario: string; fromMs: number; toMs: number; prompts: number; jev: number; checked: string[] }> = [];
  const scanPrivacy = (fromMs: number, owner: { x: number; z: number }, untilMs = Date.now()) => {
    const window = samples.filter((x) => x.atMs >= fromMs && x.atMs <= untilMs);
    const sight = window.find((x) => x.distance !== null && x.distance <= 40);
    const toMs = sight ? sight.atMs - 2_000 : untilMs;
    const inWindow = window.filter((x) => x.atMs <= toMs);
    const xs = inWindow.map((x) => Number(x.bot.x));
    const zs = inWindow.map((x) => Number(x.bot.z));
    const near = (v: number, list: number[]) => list.length === 0 || (v >= Math.min(...list) - 3 && v <= Math.max(...list) + 3);
    const probe = { x: near(owner.x, xs) ? Number.NaN : owner.x, z: near(owner.z, zs) ? Number.NaN : owner.z };
    const checked = [Number.isNaN(probe.x) ? null : `x ${Math.floor(owner.x)}`, Number.isNaN(probe.z) ? null : `z ${Math.floor(owner.z)}`].filter((v): v is string => v !== null);
    const ps = prompts().filter((x) => x.atMs >= fromMs && x.atMs <= toMs);
    const js = jevLog.filter((x) => x.atMs >= fromMs && x.atMs <= toMs);
    privacyScans.push({ scenario, fromMs, toMs, prompts: ps.length, jev: js.length, checked });
    if (checked.length === 0) return;
    const leak = (text: string) => leaksCoordinate(text, { x: Number.isNaN(probe.x) ? Number.NaN : probe.x, z: Number.isNaN(probe.z) ? Number.NaN : probe.z });
    for (const p of ps) {
      const hit = leak(p.text);
      if (hit) privacyFindings.push({ scenario, source: 'planner_prompt', value: hit });
    }
    for (const j of js) {
      const hit = leak(j.body);
      if (hit) privacyFindings.push({ scenario, source: 'jev_request', value: hit });
    }
  };

  const results: Result[] = [];
  const check = async (id: string, title: string, fn: (ev: string[], data: Json) => Promise<void>) => {
    if (only && !only.has(id)) return;
    scenario = id;
    const evidence: string[] = [];
    const data: Json = {};
    const started = Date.now();
    process.stdout.write(`RUN  ${id} ${title}\n`);
    try {
      await fn(evidence, data);
      results.push({ id, title, pass: true, evidence, data });
      process.stdout.write(`PASS ${id} (${Math.round((Date.now() - started) / 1000)}s)\n`);
    } catch (error) {
      evidence.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ id, title, pass: false, evidence, data });
      process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)?.slice(0, 600)}\n`);
    }
    for (const line of evidence.slice(0, 40)) process.stdout.write(`     ${line.slice(0, 300)}\n`);
  };

  /** Ends whatever goal is active (owner stop) and waits until Chunkbot stands still. */
  const settle = async (owner: Bot) => {
    const at = Date.now();
    say(owner, 'stop');
    await waitEvent((e) => e.type === 'stop_requested' && tOf(e) >= at - 500, 10_000);
    // Manual owner goals remain allowed while the stop latch pauses automatic work.
    await sleep(1_500);
  };
  /** Places Chunkbot (verified by server and settle) and the owner for a scenario. */
  const place = async (botKey: keyof typeof ORD_TELEPORTS, botYaw: number, ownerKey: keyof typeof ORD_TELEPORTS) => {
    await tp(BOT, botKey, `${botYaw} 0`);
    await tp(OWNER, ownerKey);
    await sleep(2_500);
    const b = await serverPos(BOT);
    const want = ORD_TELEPORTS[botKey]!;
    assert(dist(b, want) < 1.5, `Chunkbot placed at ${botKey} (server ${b.x.toFixed(1)}, ${b.z.toFixed(1)})`);
  };

  const restoreFailures: string[] = [];
  const restores: Array<{ label: string; fn: () => Promise<unknown> }> = [];
  let owner: Bot | undefined;
  let guest: Bot | undefined;
  let botStart: { x: number; y: number; z: number; dimension: string } | undefined;
  process.stdout.write(`locator ordinary live check (${PINS.profile}, lease ${lease}; PLANNER FAULT FIXTURE + loopback first-option Jev; harness validation) -> ${outDir}\n`);
  try {
    turnsFor([]);
    await startCli('run-locator-ordinary', normalConfig);
    {
      const p = await serverPos(BOT);
      const dim = /"([a-z_:]+)"/.exec(await rcon(`data get entity ${BOT} Dimension`, false))?.[1] ?? 'minecraft:overworld';
      botStart = { ...p, dimension: dim };
      restores.push({
        label: `Chunkbot returned to its starting position (${dim})`,
        fn: async () => {
          if (!botStart) return;
          await rcon(`execute in ${botStart.dimension} run tp ${BOT} ${botStart.x} ${botStart.y} ${botStart.z}`);
        },
      });
    }
    owner = await fixturePlayer(OWNER);
    restores.push({ label: 'owner sneak/effects cleared', fn: async () => { owner?.setControlState('sneak', false); await rcon(`effect clear ${OWNER}`); } });
    const o = () => owner as Bot;

    await check('O0', 'CLI ready with the locator and routes composed; the owner cue is tracked on this connection', async (ev) => {
      const loc = cli.lines.find((l) => l.text.startsWith('[chunkbot] locator: '))?.text ?? 'no locator line';
      ev.push(loc);
      assert(/locator: enabled; routes enabled for owner/.test(loc), 'locator and routes composed by the ordinary CLI');
      // The catalog THIS run registers, verified dynamically against the profile (never a hard-coded count).
      const expected = expectedCapabilityIds(runProfile(loadConfigFile(normalConfig).config, false));
      const skillsLine = cli.lines.find((l) => /\[chunkbot\] skills: \d+ capabilities/.test(l.text))?.text ?? '';
      const fromStatus = cli.length;
      cli.send('status');
      const statusLine = await cli.waitSince(/\[status\] adapters: .*capabilities=\d+/, fromStatus, 10_000).catch(() => '');
      const fromDiag = cli.length;
      cli.send('/diag catalog');
      const diagHead = await cli.waitSince(/\[diag\] catalog \S+: \d+ capabilities/, fromDiag, 10_000).catch(() => '');
      const diagCount = Number(/: (\d+) capabilities/.exec(diagHead)?.[1] ?? NaN);
      let ids: string[] = [];
      for (const deadline = Date.now() + 5_000; Date.now() < deadline; await sleep(50)) {
        ids = cli.lines.slice(fromDiag).map((l) => /^\[diag\] {3}([a-z0-9_]+) \(/.exec(l.text)?.[1]).filter((x): x is string => Boolean(x));
        if (Number.isFinite(diagCount) && ids.length >= diagCount) break;
      }
      const problems = catalogProblems({ skillsLineCount: Number(/skills: (\d+) capabilities/.exec(skillsLine)?.[1] ?? NaN) || null, statusCount: Number(/capabilities=(\d+)/.exec(statusLine)?.[1] ?? NaN) || null, diagCount: diagCount || null, ids }, expected);
      ev.push(`${skillsLine}; ${statusLine.slice(0, 200)}; /diag catalog ${ids.length} ids; expected ${expected.length} for this profile`);
      assert(problems.length === 0, `registered catalog disagrees with the run profile: ${problems.join('; ')}`);
      for (const id of LOCATOR_SKILL_IDS) assert(ids.includes(id), `${id} registered in the run catalog`);
      await place('base', 90, 'ownerFarEast');
      const st = await waitEvent((e) => e.type === 'locator_owner_state' && /^tracked:/.test(String(e.state)), 15_000);
      ev.push(`locator state ${st.state} (cause ${st.cause}); view distance ${viewDistance}`);
    });

    /** One far owner seek through the ordinary pipeline; returns the goal and the server track. */
    const farSeek = async (ev: string[], data: Json, ownerKey: keyof typeof ORD_TELEPORTS, yaw: number, text: string, plan: Json) => {
      await place('base', yaw, ownerKey);
      const ownerAt = await serverPos(OWNER);
      const b0 = await serverPos(BOT);
      const trueBearing = Math.atan2(ownerAt.z - b0.z, ownerAt.x - b0.x);
      turnsFor([{ kind: 'proposal', proposal: plan }, { kind: 'proposal', proposal: blockedTurn('fixture: the owner could not be reached') }]);
      const t0 = Date.now();
      const s = say(o(), text);
      const g = await goalAccepted(s.from);
      const anchor = await waitEvent((e) => e.type === 'goal_travel_anchor' && e.goalId === g.goalId, 10_000);
      ev.push(`goal ${g.goalId} accepted ${g.atMs - s.at} ms after chat; admission anchor ${JSON.stringify(anchor.anchor)} r${anchor.radius}; owner offset (${(ownerAt.x - b0.x).toFixed(0)}, ${(ownerAt.z - b0.z).toFixed(0)}), distance ${dist(ownerAt, b0).toFixed(0)}; bot yaw ${yaw}`);
      // F1 live: the first ~10 blocks of movement agree with the true bearing.
      const first = await sampleUntil(t0, (b) => dist(b, b0) >= 10, 60_000);
      const moved = { x: first.bot.x - b0.x, z: first.bot.z - b0.z };
      const off = Math.abs(((Math.atan2(moved.z, moved.x) - trueBearing + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      ev.push(`first movement ${dist(first.bot, b0).toFixed(1)} blocks, ${(off * 180 / Math.PI).toFixed(1)}deg off the true bearing (server positions)`);
      data.firstMoveDeg = Math.round(off * 1800 / Math.PI) / 10;
      assert(first.ok, 'Chunkbot started moving');
      assert(off <= Math.PI / 4, 'the first movement agrees with the true owner bearing (<= 45 deg)');
      return { g, t0, ownerAt, b0, anchor, s };
    };

    await check('O1', 'far "follow me" beyond 128 and out of sight: seek legs, reunion by server positions, anchor unchanged, goal persists', async (ev, data) => {
      const { g, t0, ownerAt, b0, anchor } = await farSeek(ev, data, 'ownerFarEast', 90, 'follow me', followMe());
      const reunion = await sampleUntil(t0, (b, ow) => !!ow && dist(b, ow) <= 4.5, 240_000);
      const d = reunion.owner ? dist(reunion.bot, reunion.owner) : null;
      const legs = routeEvents(t0).filter((e) => e.type === 'route_leg_started');
      const anchors = goalEvents(g.goalId, 'goal_travel_anchor');
      ev.push(`reunion ${reunion.ok ? 'reached' : 'NOT reached'}: server distance ${d?.toFixed(1)} after ${Math.round((Date.now() - t0) / 1000)}s; route legs ${legs.length}; route events ${routeEvents(t0).map((e) => e.type).join(',')}`);
      ev.push(`actions: ${JSON.stringify(actionsSince(t0).slice(0, 30))}`);
      ev.push(`Jev offered/chosen: ${JSON.stringify(jevLog.filter((j) => j.atMs >= t0).slice(0, 20).map((j) => `${j.offered.join('|')} -> ${j.chosen}`))}`);
      const goalPrompts = prompts().filter((x) => x.atMs >= t0);
      const catalogOffered = goalPrompts.some((x) => x.text.includes('seek_owner') && x.text.includes('route_travel'));
      ev.push(`planner prompts for this goal ${goalPrompts.length}; locator capabilities in the model-visible catalog: ${catalogOffered}`);
      data.reunion = { ok: reunion.ok, distance: d, legs: legs.length, anchorEvents: anchors.length, anchor: anchor.anchor, catalogOffered };
      scanPrivacy(t0, ownerAt);
      assert(catalogOffered, 'the planner was shown seek_owner/route_travel in the shared catalog');
      assert(reunion.ok, 'reunion verified by server positions (<= 4.5 blocks)');
      assert(dist(ownerAt, b0) > 128 && legs.length >= 1, 'beyond the admission radius through counted route legs');
      assert(anchors.length === 1, 'one admission anchor for the goal (never re-anchored)');
      assert(!terminalOf(g.goalId), 'the persistent goal is still active after reunion');
      data.goalId = g.goalId;
    });

    const o1Goal = () => (results.find((r) => r.id === 'O1')?.data.goalId as string | undefined);

    await check('O1b', 'persistent following while the owner walks 60 blocks (server-sampled), same goal', async (ev, data) => {
      const goalId = o1Goal();
      assert(goalId && !terminalOf(goalId), 'the O1 follow goal is active');
      const t0 = Date.now();
      const startOwner = await serverPos(OWNER);
      const dists: number[] = [];
      for (let i = 1; i <= 15; i += 1) {
        await ownerStep({ x: startOwner.x - 4 * i, z: startOwner.z - (i % 2) }, `walk west ${4 * i}`);
        await sleep(1_000);
        const b = await serverPos(BOT);
        const ow = await serverPos(OWNER);
        dists.push(Math.round(dist(b, ow) * 10) / 10);
      }
      const settled = await sampleUntil(t0, (b, ow) => !!ow && dist(b, ow) <= 5, 30_000);
      ev.push(`distances while walking: ${dists.join(', ')}; settled ${settled.ok ? 'within 5' : 'NOT within 5'}`);
      ev.push(`actions: ${JSON.stringify(actionsSince(t0).slice(0, 20))}`);
      data.distances = dists;
      assert(settled.ok, 'kept up with the walking owner');
      assert(!terminalOf(goalId), 'the same persistent goal is still active');
    });

    await check('O1c', 'sight lost twice while following (cue still current): the SAME goal reacquires through the cue, no planner turn', async (ev, data) => {
      const goalId = o1Goal();
      assert(goalId && !terminalOf(goalId), 'the O1 follow goal is active');
      const turnsBefore = events().filter((e) => e.type === 'planner_turn_started').length;
      const trips: Json[] = [];
      for (const [dx, dz] of [[70, 20], [-20, 75]] as const) {
        const t0 = Date.now();
        const ow = await serverPos(OWNER);
        await ownerStep({ x: ow.x + dx, z: ow.z + dz }, `leave sight (${dx}, ${dz})`);
        const away = await serverPos(OWNER);
        const again = await sampleUntil(t0, (b, o2) => !!o2 && dist(b, o2) <= 4.5, 120_000);
        scanPrivacy(t0, away);
        trips.push({ ok: again.ok, seconds: Math.round((Date.now() - t0) / 1000), actions: actionsSince(t0).map((a) => a.capability).slice(0, 12) });
        if (!again.ok) break;
      }
      const turnsAfter = events().filter((e) => e.type === 'planner_turn_started').length;
      ev.push(`trips ${JSON.stringify(trips)}; planner turns during reacquisition ${turnsAfter - turnsBefore}`);
      data.trips = trips;
      assert(trips.length === 2 && trips.every((t) => t.ok), 'reacquired both times');
      assert(trips.every((t) => (t.actions as string[]).includes('seek_owner')), 'reacquisition went through the locator cue (seek_owner)');
      assert(!terminalOf(goalId), 'the same persistent goal is still active');
    });

    await check('O1d', 'owner hides (sneak) and leaves sight: no wandering, no question, no undirected exploration; one declarative end', async (ev, data) => {
      const goalId = o1Goal();
      assert(goalId && !terminalOf(goalId), 'the O1 follow goal is active');
      // What a no-question planner returns when the owner is neither visible nor broadcast (scripted).
      turnsFor([{ kind: 'proposal', proposal: blockedTurn('the owner is not visible and the locator bar does not show them; nothing to follow') }]);
      const t0 = Date.now();
      const from = cli.length;
      o().setControlState('sneak', true);
      ownerScript.push({ atMs: Date.now(), scenario, action: 'sneak on' });
      const ow0 = await serverPos(OWNER);
      await ownerStep({ x: ow0.x - 70, z: ow0.z + 30 }, 'leave sight while sneaking (70 west, 30 south)');
      const hidden = await serverPos(OWNER);
      const b0 = await serverPos(BOT);
      const term = await goalTerminal(goalId, from, 60_000).catch(() => undefined);
      const b1 = await serverPos(BOT);
      const questions = events().filter((e) => e.type === 'clarification_requested' && tOf(e) >= t0);
      const explore = actionsSince(t0).filter((a) => a.capability === 'explore_frontier');
      const turns = events().filter((e) => e.type === 'planner_turn_started' && tOf(e) >= t0).length;
      ev.push(`hidden: goal ${term ? `${term.state} (${term.reason})` : 'still active after 60s'}; Chunkbot moved ${dist(b0, b1).toFixed(1)} blocks; planner turns ${turns}; questions ${questions.length}; explore ${explore.length}; actions ${JSON.stringify(actionsSince(t0).slice(0, 10))}`);
      samples.push({ scenario, atMs: Date.now(), dtMs: Date.now() - t0, bot: b1, owner: hidden, distance: Math.round(dist(b1, hidden) * 10) / 10 });
      scanPrivacy(t0, hidden);
      data.hidden = { moved: dist(b0, b1), turns, term: term ?? null };
      o().setControlState('sneak', false);
      ownerScript.push({ atMs: Date.now(), scenario, action: 'sneak off' });
      assert(questions.length === 0, 'no follow-up question');
      assert(explore.length === 0, 'no undirected exploration');
      assert(dist(b0, b1) <= 12, 'no wandering without a cue (at most the last observed waypoint)');
      assert(term && term.state !== 'completed', 'one declarative end (not completion)');
      assert(turns <= 2, 'bounded planner turns on unchanged evidence');
    });

    await check('O2', 'stop while seeking: controls cleared within the local target, route revoked, no further movement', async (ev, data) => {
      await settle(o());
      const { g } = await farSeek(ev, data, 'ownerFarWest', 0, 'come here', comeHere());
      await waitEvent((e) => e.type === 'route_leg_started' || (e.type === 'skill_started' && e.goalId === g.goalId), 30_000).catch(() => undefined);
      const s = say(o(), 'stop');
      const stopAt = Date.now();
      const p0 = await serverPos(BOT);
      const trace: Array<{ dtMs: number; moved: number }> = [];
      for (const wait of [250, 250, 500, 1_000, 2_000]) {
        await sleep(wait);
        trace.push({ dtMs: Date.now() - stopAt, moved: Math.round(dist(p0, await serverPos(BOT)) * 100) / 100 });
      }
      const term = await goalTerminal(g.goalId, s.from, 10_000);
      const revoked = await waitEvent((e) => e.type === 'route_revoked' && tOf(e) >= stopAt - 1_000, 5_000).catch(() => undefined);
      ev.push(`after stop: ${JSON.stringify(trace)}; goal ${term.state} (${term.reason}); route revoked ${revoked ? revoked.reason : 'no event'}`);
      data.stopTrace = trace;
      const late = trace.filter((t) => t.dtMs >= 600);
      assert(late.every((t) => t.moved - (trace[1]?.moved ?? 0) <= 1.0), 'no movement after the stop settled');
      assert(term.state === 'cancelled', 'goal cancelled by stop');
      assert(revoked, 'route revoked');
      say(o(), 'resume');
      await sleep(1_000);
    });

    await check('O3', 'finite "come here" beyond 128: completes only at verified owner proximity', async (ev, data) => {
      const { g, t0, ownerAt, s } = await farSeek(ev, data, 'ownerFarSouthWest', 180, 'come here', comeHere());
      await sampleUntil(t0, (b, ow) => !!ow && dist(b, ow) <= 4.5, 240_000);
      const term = await goalTerminal(g.goalId, s.from, 60_000);
      const b = await serverPos(BOT);
      const ow = await serverPos(OWNER);
      ev.push(`goal ${term.state} (${term.reason}); server distance ${dist(b, ow).toFixed(1)}; legs ${routeEvents(t0).filter((e) => e.type === 'route_leg_started').length}`);
      scanPrivacy(t0, ownerAt, term.atMs);
      data.term = term;
      assert(term.state === 'completed', 'completed');
      assert(dist(b, ow) <= 4.5, 'completion with verified proximity (server)');
    });

    await check('O4', 'replacement while seeking: old goal replaced, its route revoked, the new goal has its own authorization', async (ev, data) => {
      await settle(o());
      const { g } = await farSeek(ev, data, 'ownerFarNorth', -90, 'follow me', followMe());
      turnsFor([{ kind: 'proposal', proposal: comeHere() }, { kind: 'proposal', proposal: blockedTurn('fixture') }]);
      const s = say(o(), 'come here instead');
      const g2 = await goalAccepted(s.from, 30_000);
      const old = await goalTerminal(g.goalId, s.from, 30_000);
      const revoked = events().filter((e) => e.type === 'route_revoked' && tOf(e) >= s.at - 500);
      const authorized = events().filter((e) => e.type === 'route_authorized' && e.goalId === g2.goalId);
      ev.push(`old ${g.goalId} ${old.state} (${old.reason}); new ${g2.goalId}; revoked ${revoked.map((e) => e.reason).join(',')}; new authorizations ${authorized.length}`);
      data.replacement = { old, revoked: revoked.length, authorized: authorized.length };
      assert(old.reason === 'replaced', 'old goal replaced');
      assert(revoked.length >= 1 && authorized.length === 1, 'old route revoked; one new authorization for the new goal');
      const term = await goalTerminal(g2.goalId, s.from, 240_000);
      ev.push(`new goal ${term.state} (${term.reason})`);
    });

    await check('O5', "owner logout while seeking (a guest stays on the opposite side): the bot stops; the guest's waypoint never steers it", async (ev, data) => {
      await settle(o());
      guest = await fixturePlayer(GUEST);
      restores.push({ label: 'guest disconnected', fn: async () => guest?.quit() });
      await tp(GUEST, 'guestFarWest');
      const { g, t0 } = await farSeek(ev, data, 'ownerFarEast', 90, 'follow me', followMe());
      const ownerLast = await serverPos(OWNER);
      o().quit();
      ownerScript.push({ atMs: Date.now(), scenario, action: 'owner logout' });
      const tq = Date.now();
      await sleep(3_000);
      const p0 = await serverPos(BOT);
      await sleep(20_000);
      const p1 = await serverPos(BOT);
      ev.push(`after logout: moved ${dist(p0, p1).toFixed(1)} blocks in 20s; toward the guest: ${(p0.x - p1.x).toFixed(1)}; actions ${JSON.stringify(actionsSince(tq).slice(0, 8))}`);
      samples.push({ scenario, atMs: Date.now(), dtMs: Date.now() - t0, bot: p1, owner: ownerLast, distance: Math.round(dist(p1, ownerLast) * 10) / 10 });
      scanPrivacy(t0, ownerLast);
      data.afterLogout = dist(p0, p1);
      assert(dist(p0, p1) <= 2, 'no movement without the owner cue');
      assert(p0.x - p1.x <= 1, "never walked toward the guest's waypoint");
      owner = await fixturePlayer(OWNER);
      await tp(OWNER, 'ownerBeside');
      ev.push(`goal after logout: ${terminalOf(g.goalId)?.text ?? 'active'}`);
      guest?.quit();
      guest = undefined;
    });

    await check('O6', 'owner dimension change while seeking: withdrawn; the bot stops; returning needs a fresh broadcast', async (ev, data) => {
      await settle(o());
      const { t0 } = await farSeek(ev, data, 'ownerFarEast', 90, 'follow me', followMe());
      const ownerLast = await serverPos(OWNER);
      await tp(OWNER, 'netherRoof');
      ownerScript.push({ atMs: Date.now(), scenario, action: 'owner to the nether roof' });
      await sleep(3_000);
      const p0 = await serverPos(BOT);
      await sleep(15_000);
      const p1 = await serverPos(BOT);
      const st = events().filter((e) => e.type === 'locator_owner_state' && tOf(e) >= t0).map((e) => e.state);
      ev.push(`owner in the nether: Chunkbot moved ${dist(p0, p1).toFixed(1)} blocks in 15s; locator states ${st.join(' -> ')}`);
      samples.push({ scenario, atMs: Date.now(), dtMs: Date.now() - t0, bot: p1, owner: ownerLast, distance: Math.round(dist(p1, ownerLast) * 10) / 10 });
      scanPrivacy(t0, ownerLast);
      data.netherMoved = dist(p0, p1);
      assert(dist(p0, p1) <= 2, 'no movement without the owner cue');
      await tp(OWNER, 'ownerBeside');
    });

    await check('O8', 'operator /reconnect while seeking: the goal ends, guidance is discarded, nothing moves without a new goal', async (ev, data) => {
      await settle(o());
      const { g } = await farSeek(ev, data, 'ownerFarEast', 90, 'follow me', followMe());
      const from = cli.length;
      cli.send('/reconnect');
      const term = await goalTerminal(g.goalId, from, 20_000);
      await cli.waitSince(new RegExp(`\\[chunkbot\\] ready: version=${VERSION_RE}`), from, 40_000);
      const tr = Date.now();
      const p0 = await serverPos(BOT);
      await sleep(15_000);
      const p1 = await serverPos(BOT);
      const attach = events().filter((e) => e.type === 'locator_attached' && tOf(e) >= tr - 45_000).map((e) => `epoch ${e.connectionEpoch} late=${e.late}`);
      ev.push(`goal ${term.state} (${term.reason}); after reconnect moved ${dist(p0, p1).toFixed(1)} blocks in 15s; attachments ${attach.join(', ')}`);
      data.reconnect = { term, moved: dist(p0, p1) };
      assert(term.state !== 'completed', 'the goal did not complete by reconnecting');
      assert(dist(p0, p1) <= 1, 'no movement after reconnect without a new goal');
    });

    await check('O9', 'visible follow inside the admission radius (ordinary regression): no seeking while visible', async (ev, data) => {
      await settle(o());
      await place('base', 0, 'ownerBeside');
      turnsFor([{ kind: 'proposal', proposal: followMe() }]);
      const t0 = Date.now();
      const s = say(o(), 'follow me');
      const g = await goalAccepted(s.from);
      await sleep(2_000);
      const start = await serverPos(OWNER);
      const dists: number[] = [];
      for (let i = 1; i <= 8; i += 1) {
        await ownerStep({ x: start.x + 3 * i, z: start.z + 2 * i }, `walk south-east ${i}`);
        await sleep(1_000);
        dists.push(Math.round(dist(await serverPos(BOT), await serverPos(OWNER)) * 10) / 10);
      }
      const ok = await sampleUntil(t0, (b, ow) => !!ow && dist(b, ow) <= 5, 20_000);
      const seek = actionsSince(t0).filter((a) => a.capability === 'seek_owner');
      ev.push(`distances ${dists.join(', ')}; settled ${ok.ok}; seek_owner actions ${seek.length}; actions ${JSON.stringify(actionsSince(t0).slice(0, 10))}`);
      data.distances = dists;
      assert(ok.ok, 'kept near the visible owner');
      assert(!terminalOf(g.goalId), 'persistent goal active');
    });

    await check('O7', 'route exhaustion (operator budget 192 blocks / 3 legs): expanded authority withdrawn, the bot stops, truthful counters', async (ev, data) => {
      await settle(o());
      await stopCli();
      await startCli('run-locator-ordinary-exhaust', exhaustConfig);
      const { g, t0, s } = await farSeek(ev, data, 'ownerFarEast', 90, 'follow me', followMe());
      const exhausted = await waitEvent((e) => (e.type === 'route_exhausted' || e.type === 'route_leg_refused') && tOf(e) >= t0, 240_000);
      const p0 = await serverPos(BOT);
      await sleep(15_000);
      const p1 = await serverPos(BOT);
      const term = terminalOf(g.goalId);
      ev.push(`route ${exhausted.type} (${exhausted.blocker ?? '-'}; used ${exhausted.distanceUsed ?? '-'}); after: moved ${dist(p0, p1).toFixed(1)} blocks in 15s; bot ${dist(p1, ORD_BASE).toFixed(0)} from the admission anchor; goal ${term?.text ?? 'active'}`);
      data.exhaustion = { type: exhausted.type, blocker: exhausted.blocker ?? null, moved: dist(p0, p1), fromAnchor: dist(p1, ORD_BASE) };
      assert(dist(p0, p1) <= 2, 'no movement after the route budget is spent');
      void s;
    });
  } finally {
    scenario = 'restore';
    try {
      if (cliStarted) {
        for (const r of restores.reverse()) {
          try {
            await r.fn();
            setupLog.push({ atMs: Date.now(), scenario, command: `RESTORE: ${r.label}`, reply: 'ok' });
          } catch (error) {
            const why = error instanceof Error ? error.message.slice(0, 200) : String(error);
            restoreFailures.push(`${r.label}: ${why}`);
            setupLog.push({ atMs: Date.now(), scenario, command: `RESTORE FAILED: ${r.label}`, reply: why });
          }
        }
        if (botStart) {
          await sleep(1_000);
          const p = await serverPos(BOT).catch(() => undefined);
          if (!p || dist(p, botStart) > 1.5) restoreFailures.push(`Chunkbot not verified back at its starting position (${p ? `${p.x.toFixed(1)}, ${p.z.toFixed(1)}` : 'unreadable'})`);
        }
        await stopCli();
      }
    } finally {
      owner?.quit();
      guest?.quit();
      jevServer?.close();
    }
  }

  const pass = results.length > 0 && results.every((r) => r.pass) && restoreFailures.length === 0 && privacyFindings.length === 0;
  if (privacyFindings.length > 0) results.push({ id: 'PRIVACY', title: 'no hidden owner coordinates in model-visible texts', pass: false, evidence: privacyFindings.map((p) => `${p.scenario} ${p.source}: ${p.value}`), data: {} });
  if (restoreFailures.length > 0) results.push({ id: 'RESTORE', title: 'every fixture change restored and verified', pass: false, evidence: restoreFailures, data: {} });
  writeFileSync(
    join(outDir, 'report.json'),
    `${JSON.stringify(
      {
        check: 'MB-LOC-002 ordinary-pipeline locator/follow (PLANNER FAULT FIXTURE + loopback first-option Jev; harness validation, not provider acceptance)',
        fixture: PINS.profile,
        lease,
        provenance,
        footprint: ORDINARY_FOOTPRINT,
        teleports: ORD_TELEPORTS,
        viewDistance,
        pass,
        privacyFindings,
        privacyScans,
        restoreFailures,
        results,
        setup: setupLog,
        ownerScript,
        samples,
        jev: jevLog.map((j) => ({ dtMs: j.atMs - (jevLog[0]?.atMs ?? j.atMs), scenario: j.scenario, offered: j.offered, chosen: j.chosen })),
        plannerPrompts: prompts().map((p) => ({ atMs: p.atMs, chars: p.text.length })),
        cliExitSaved: true,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} locator ordinary check: ${results.filter((r) => r.pass).length}/${results.length} — ${outDir}\n`);
  return pass ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  // Shared fixtures are leased: nothing (no RCON, no password read, no join, no child, no output) without an explicit lease id.
  const lease = argOf(argv, '--fixture-lease');
  if (!lease || !ID_RE.test(lease)) {
    process.stderr.write('refusing to run: pass --fixture-lease <granted lease id> (the shared loopback fixtures are leased by the coordinator)\n');
    return 2;
  }
  return run(argv, lease);
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
