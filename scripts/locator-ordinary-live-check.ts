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
//   O8  ready /reconnect no-op, then an owned kick and disconnected-to-reconnect:
//       old guidance discarded; fresh broadcast required; no unrequested work
//   O9  visible follow inside the admission radius (ordinary regression)
//
// Safety: importing this module runs nothing. main() refuses (exit 2) before
// any fixture password read, RCON command, join, child process or output
// directory unless --fixture-lease <granted id> is given. Setup/cleanup RCON
// commands are durably recorded before dispatch and after reply. Teleports go
// ONLY through a checked helper inside ORDINARY_FOOTPRINT. Finally: owner/guest effects and controls cleared, fake
// players cleaned while online and disconnected, Chunkbot returned to its
// recorded origin, CLI shutdown/exit 0 verified; failures fail the report.
// Future coordinator lease must cover the owned kick and online inventory/
// effect cleanup; no settings, blocks, clock or foreign-entity writes occur.
//
//   npm run build   (source/build frozen for the run)
//   node scripts/locator-ordinary-live-check.ts --fixture-lease <id> [--fixture 26.2] [--only O1,O2]
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { insideBox, isEntryPoint, type Box } from './locator-live-check.ts';
import type { FaultTurn } from './lib/fault-codex.ts';
import { actionIntervals, modelObservationBinding, parseOwnerServerRead, parsePlannerInput, privacyOracle, reacquisitionProof, reconnectProblems, shutdownProblems, verifiedHistory, visibleOwnerConsistency, type ObserverSample } from './lib/locator-ordinary-oracles.ts';
import { startVisibilityCapture } from './lib/locator-ordinary-visibility-capture.ts';
import { captureStationaryPosition, originalPositionTarget, POSITION_SETTLE, type PlayerPositionRead, type PositionScope, type PositionTarget, type StationaryPositionProof } from './lib/locator-ordinary-origin.ts';

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
  const { offlinePlayerUuid } = await import('../src/game/identity.ts');
  const mineflayer = (await import('mineflayer')).default;
  type Bot = ReturnType<typeof mineflayer.createBot>;

  const PINS = fixturePins(fixtureProfileFromArgv(argv));
  // Fail closed before password reads, output, child processes or network work.
  const base = JSON.parse(readFileSync(join(PROJECT_ROOT, PINS.config), 'utf8')) as Json;
  assert(base.minecraft.host === PINS.host && base.minecraft.port === PINS.port && base.minecraft.version === PINS.minecraftVersion && base.bot.auth === 'offline' && base.bot.trustedOfflineFixture === true && base.bot.username === 'Chunkbot' && base.owner.name === 'FixtureOwner', 'ordinary locator profile must be the exact trusted loopback fixture and owned dummy identities');
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
  const rcon = async (command: string, record = true, timeoutMs = 5_000): Promise<string> => {
    if (record) appendFileSync(join(outDir, 'commands.jsonl'), `${JSON.stringify({ atMs: Date.now(), scenario, phase: 'intent', command })}\n`);
    const job = rconQueue.then(() => rconCommand(PINS.host, PINS.rconPort, password, command, timeoutMs));
    rconQueue = job.catch(() => undefined);
    const reply = await job;
    if (record) {
      const row = { atMs: Date.now(), scenario, command, reply };
      setupLog.push(row);
      appendFileSync(join(outDir, 'commands.jsonl'), `${JSON.stringify({ ...row, phase: 'reply' })}\n`);
    }
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
  const ownerIdentity = { name: OWNER, uuid: offlinePlayerUuid(OWNER) };
  // Separate read-only truth for a diagnostic interval; never sent to the app/models.
  const ownerServerRead = async () => {
    const fromMs = Date.now();
    const field = (name: string) => {
      const remainingMs = fromMs + 1_500 - Date.now();
      assert(remainingMs > 0, 'owner visibility read exceeded its bounded interval');
      return rcon(`data get entity ${OWNER} ${name}`, false, remainingMs);
    };
    const position = await field('Pos');
    const uuid = await field('UUID');
    const dimension = await field('Dimension');
    return parseOwnerServerRead(OWNER, { position, uuid, dimension }, fromMs, Date.now());
  };
  const botServerRead = async () => {
    const fromMs = Date.now();
    const field = (name: string) => {
      const remainingMs = fromMs + 1_500 - Date.now();
      assert(remainingMs > 0, 'bot visibility read exceeded its bounded interval');
      return rcon(`data get entity ${BOT} ${name}`, false, remainingMs);
    };
    const position = await field('Pos');
    const uuid = await field('UUID');
    const dimension = await field('Dimension');
    return parseOwnerServerRead(BOT, { position, uuid, dimension }, fromMs, Date.now());
  };
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
        appendFileSync(join(outDir, 'jev-requests.jsonl'), `${JSON.stringify(jevLog.at(-1))}\n`);
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
  const keyEnv = String(base.models?.decision?.apiKeyEnv ?? 'OPENROUTER_API_KEY');
  const env: NodeJS.ProcessEnv = { ...process.env, [keyEnv]: 'loopback-fixture-placeholder-key' };
  const decision = { ...base.models.decision, endpoint: '' };
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
  let normalConfig = '';
  // O7: a deliberately small operator route budget (code-owned config; the planner cannot change it).
  let exhaustConfig = '';

  // ------------------------------------------------------------ CLI helpers
  let cli!: InstanceType<typeof CliProcess>;
  let cliStarted = false;
  let eventsPath = '';
  let dashboardPath = '';
  const cliExits: Json[] = [];
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
  const positionChecks: Json[] = [];
  let visibilityCapture: ReturnType<typeof startVisibilityCapture> | undefined;
  const positionScope = (): PositionScope => {
    const ev = events(), ready = ev.filter((e) => e.type === 'connection_ready').at(-1);
    assert(ready && !ev.some((e) => e.type === 'connection_ended' && e.connectionEpoch === ready.connectionEpoch && tOf(e) >= tOf(ready)), 'position capture requires a current owned ready connection');
    return { runId: basename(dirname(eventsPath)), connectionEpoch: ready.connectionEpoch };
  };
  // Dedicated server evidence only: no diagnostic snapshot, memory/handle refresh or app/model input.
  const captureBotPosition = async (phase: 'pre-staging origin' | 'original restoration', target?: PositionTarget) => {
    const scope = positionScope(), identity = { name: BOT, uuid: offlinePlayerUuid(BOT) };
    const evidence: Json = { phase, scope, identity, target: target ?? null, startedAtMs: Date.now(), reads: [], pass: false };
    positionChecks.push(evidence);
    try {
      const proof = await captureStationaryPosition({
        now: Date.now, wait: (ms) => sleep(ms),
        read: async (deadlineMs): Promise<PlayerPositionRead> => {
          const scopeBefore = positionScope(), fromMs = Date.now();
          const readField = (field: 'Pos' | 'Dimension' | 'UUID' | 'OnGround') => {
            const remainingMs = Math.min(deadlineMs, fromMs + POSITION_SETTLE.maxReadMs) - Date.now();
            assert(remainingMs > 0, 'bot position read exceeded its bounded interval');
            return rcon(`data get entity ${BOT} ${field}`, true, remainingMs);
          };
          const positionBefore = await readField('Pos');
          const dimensionBefore = await readField('Dimension');
          const uuid = await readField('UUID');
          const onGround = await readField('OnGround');
          const dimensionAfter = await readField('Dimension');
          const positionAfter = await readField('Pos');
          return { scopeBefore, scopeAfter: positionScope(), fromMs, toMs: Date.now(), replies: { positionBefore, positionAfter, dimensionBefore, dimensionAfter, uuid, onGround } };
        },
        record: (read) => {
          evidence.reads.push(read);
          appendFileSync(join(outDir, 'position-reads.jsonl'), `${JSON.stringify({ phase, scenario, ...read })}\n`);
        },
      }, identity, scope, target);
      evidence.pass = true;
      evidence.proof = proof;
      return proof;
    } catch (error) {
      evidence.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      evidence.finishedAtMs = Date.now();
      appendFileSync(join(outDir, 'position-reads.jsonl'), `${JSON.stringify({ phase, scenario, result: evidence })}\n`);
    }
  };
  const startCli = async (name: string, configPath: string) => {
    const p = new CliProcess(name, ['run', '--no-autonomy', '--config', configPath], env);
    cli = p; // owned immediately: a failed start is still stopped in finally
    cliStarted = true;
    await p.waitFor(/\[chunkbot\] planner: /, 30_000);
    const runLine = await p.waitFor(/\[chunkbot\] run \S+; evidence: /, 10_000);
    eventsPath = /evidence: (\S+)$/.exec(runLine)?.[1] ?? '';
    dashboardPath = join(dirname(dirname(dirname(eventsPath))), 'dashboard', 'status.json');
    await p.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${VERSION_RE}`), 40_000);
    return p;
  };
  const stopCli = async () => {
    const p = cli;
    const path = eventsPath;
    ownerScript.push({ atMs: Date.now(), scenario, action: `terminal /quit (${p.name})` });
    p.send('/quit');
    p.child.stdin?.end();
    const exited = await Promise.race([p.exited, sleep(15_000).then(() => undefined)]);
    // exit precedes the stdio close event: allow buffered terminal lines to drain.
    if (exited && p.child.stdout && !p.child.stdout.destroyed) await sleep(100);
    p.save(outDir);
    const summaryPath = join(dirname(path), 'summary.json');
    const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) as Json : undefined;
    const problems = shutdownProblems(exited, p.lines.map((l) => l.text), readJsonl(path), summary);
    cliExits.push({ name: p.name, pid: p.pid, eventsPath: path, exit: exited ?? null, summaryPath, problems, forcedKill: false });
    if (exited) cliStarted = false;
    assert(problems.length === 0, problems.join('; '));
  };
  const fixturePlayer = async (username: string): Promise<Bot> => {
    const bot = mineflayer.createBot({ host: PINS.host, port: PINS.port, username, auth: 'offline', version: PINS.minecraftVersion, hideErrors: true });
    ownedPlayers.push(bot); // own the handle even if spawn fails
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
  const observations: ObserverSample[] = [];
  // Read-only application observation: never /diag run/do, no actuator lease.
  // Captures real LOS/identity and historical anchors; RCON truth stays in this harness.
  const observe = async (bot: P, ownerAt: P | null, serverAtMs: number) => {
    assert(Date.now() - serverAtMs <= 1_500, 'observation bot sample is stale');
    const before = await ownerServerRead();
    const botBefore = await botServerRead();
    const readyBefore = events().filter((e) => e.type === 'connection_ready').at(-1);
    const from = cli.length;
    const requestedAtMs = Date.now();
    cli.send('/diag observe');
    const line = await lineSince(/^\[diag-json\] \{"kind":"observe"/, from, 10_000);
    const snapshot = (JSON.parse(line.text.slice('[diag-json] '.length)) as Json).snapshot as Json;
    const after = await ownerServerRead();
    const botAfter = await botServerRead();
    const readyAfter = events().filter((e) => e.type === 'connection_ready').at(-1);
    const dashboard = existsSync(dashboardPath) ? JSON.parse(readFileSync(dashboardPath, 'utf8')) as Json : {};
    const runId = basename(dirname(eventsPath));
    const row: ObserverSample = { runId, atMs: snapshot.takenAtMs, serverAtMs: before.toMs, bot, owner: ownerAt, snapshot, dashboard, scenario,
      capture: { requestedAtMs, receivedAtMs: line.atMs, runId, connectionEpochBefore: readyBefore?.connectionEpoch, connectionEpochAfter: readyAfter?.connectionEpoch, before, after, botBefore, botAfter } };
    observations.push(row);
    appendFileSync(join(outDir, 'observations.jsonl'), `${JSON.stringify(row)}\n`);
    return snapshot;
  };
  const sampleUntil = async (t0: number, until: (b: P, o: P | null) => boolean, timeoutMs: number, ownerOnline = true): Promise<{ bot: P; owner: P | null; ok: boolean }> => {
    const deadline = Date.now() + timeoutMs;
    let last: { bot: P; owner: P | null } | undefined;
    while (Date.now() < deadline) {
      const b = await serverPos(BOT);
      const o = ownerOnline ? await serverPos(OWNER).catch(() => null) : null;
      const serverAtMs = Date.now();
      const d = o ? Math.hypot(b.x - o.x, b.y - o.y, b.z - o.z) : null;
      samples.push({ scenario, atMs: Date.now(), dtMs: Date.now() - t0, bot: b, owner: o, distance: d === null ? null : Math.round(d * 10) / 10 });
      if (!insideBox(ORDINARY_FOOTPRINT.botEnvelope, b)) throw new Error(`Chunkbot left the declared envelope at ${b.x.toFixed(0)}, ${b.z.toFixed(0)}`);
      last = { bot: b, owner: o };
      if (o && (d! <= 32 || scenario === 'O1c')) await observe(b, o, serverAtMs);
      if (until(b, o)) return { ...last, ok: true };
      await sleep(1_000);
    }
    return { ...(last ?? { bot: await serverPos(BOT), owner: null }), ok: false };
  };
  const goalEvents = (goalId: string, type: string) => events().filter((e) => e.type === type && e.goalId === goalId);
  const routeEvents = (sinceMs: number) => events().filter((e) => String(e.type).startsWith('route_') && tOf(e) >= sinceMs);
  const actionsSince = (sinceMs: number) => events().filter((e) => e.type === 'skill_outcome' && tOf(e) >= sinceMs).map((e) => ({ capability: (e.outcome ?? e).capability, status: (e.outcome ?? e).status, reason: (e.outcome ?? e).reason ?? null }));

  // Field-level privacy scan, retaining both matches and their provenance.
  const privacyFindings: Json[] = [];
  const privacyScans: Json[] = [];
  const scanPrivacy = (fromMs: number, owner: P, untilMs = Date.now()) => {
    const window = samples.filter((x) => x.atMs >= fromMs && x.atMs <= untilMs);
    const toMs = untilMs;
    const ps = prompts().filter((x) => x.atMs >= fromMs && x.atMs <= toMs);
    const js = jevLog.filter((x) => x.atMs >= fromMs && x.atMs <= toMs);
    const history = verifiedHistory(observations, ownerIdentity);
    const allowed: Json[] = [];
    let hiddenRequests = 0;
    const scan = (text: string, atMs: number, source: 'jev_request' | 'planner_prompt') => {
      const input = source === 'planner_prompt' ? parsePlannerInput(text) : JSON.parse(text) as Json;
      const sample = window.filter((x) => x.atMs <= atMs + 1_500).sort((a, b) => Math.abs(a.atMs - atMs) - Math.abs(b.atMs - atMs))[0];
      const own = input.observation?.self?.at ?? input.state?.observation?.self?.at;
      // Every scanned request needs server truth; use its own bounded current
      // point only after independently matching it to a nearby server sample.
      assert(sample && Math.abs(sample.atMs - atMs) <= 2_000, `privacy scan lacks contemporaneous server sample: ${source} ${atMs}`);
      const ready = events().filter((e) => e.type === 'connection_ready' && tOf(e) <= atMs).at(-1);
      assert(ready && own, 'privacy scan lacks current connection/self');
      const obs = input.observation ?? input.state?.observation;
      let visibility;
      if (obs.owner?.visible === true) {
        const runId = basename(dirname(eventsPath));
        const binding = modelObservationBinding(obs, events(), { source, runId, atMs, connectionEpoch: ready.connectionEpoch });
        const consistency = binding
          ? visibleOwnerConsistency(obs, observations, { ...binding, binding, runId, atMs, ownerIdentity, botIdentity: { name: BOT, uuid: offlinePlayerUuid(BOT) } }, visibilityCapture?.reads ?? [])
          : { errors: ['visible_owner_journal_binding_unproven'], proof: undefined };
        visibility = consistency.proof;
        if (!visibility) privacyFindings.push({ scenario, source, atMs, path: 'observation.owner', value: JSON.stringify(obs.owner), reason: consistency.errors.join('; '), snapshotId: obs.snapshotId, claimedTakenAtMs: obs.takenAtMs ?? null });
        else allowed.push({ source, atMs, path: 'observation.owner.at', reason: 'identified visible owner independently bracketed at observation time', visibility });
      } else hiddenRequests += 1;
      // A visibility flag never exempts the rest of the actual model-visible request.
      const result = privacyOracle(input, { runId: basename(dirname(eventsPath)), atMs, owner: sample.owner ?? owner, bot: visibility?.bot ?? sample.bot, ownerIdentity, connectionEpoch: ready.connectionEpoch, dimension: obs.dimension, history, ...(visibility ? { visibility } : {}) });
      for (const hit of result.findings) privacyFindings.push({ scenario, source, atMs, ...hit });
      for (const hit of result.allowed) allowed.push({ source, atMs, ...hit });
    };
    for (const p of ps) scan(p.text, p.atMs, 'planner_prompt');
    for (const j of js) scan(j.body, j.atMs, 'jev_request');
    privacyScans.push({ scenario, fromMs, toMs, prompts: ps.length, jev: js.length, hiddenOwner: owner, allowed, historyProofs: history.length, hiddenRequests });
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
  const cleanup: Json[] = [];
  const ownedPlayers: Bot[] = [];
  const finalPositions: Json[] = [];
  const cleanupPlayer = async (name: string, player?: Bot) => {
    player?.clearControlStates();
    player?.setControlState('sneak', false);
    ownerScript.push({ atMs: Date.now(), scenario, action: `${name}: controls/sneak off` });
    assert(/Test passed/i.test(await rcon(`execute if entity @a[name=${name}]`)), `${name} must be online for cleanup`);
    await rcon(`clear ${name}`);
    await rcon(`effect clear ${name}`);
    const inventory = await rcon(`data get entity ${name} Inventory`);
    const effects = await rcon(`data get entity ${name} active_effects`);
    assert(/\[\]$/.test(inventory.trim()), `${name} online Inventory/head not verified empty: ${inventory}`);
    assert(/\[\]$|Found no elements matching/i.test(effects), `${name} online effects not verified empty: ${effects}`);
    if (player) assert(player.controlState.sneak === false && Object.values(player.controlState).every((v) => v === false), `${name} dummy controls/sneak remain active`);
    if (player) {
      // Read-only server entity predicate; absence or a command error is not standing.
      await sleep(250);
      const sneak = await rcon(`execute as @a[name=${name}] if predicate {condition:"minecraft:entity_properties",entity:"this",predicate:{flags:{is_sneaking:false}}}`);
      assert(/Test passed/i.test(sneak), `${name} server sneak state not verified clear: ${sneak}`);
    }
    cleanup.push({ atMs: Date.now(), step: `${name} online inventory/head/effects/controls`, ok: true, inventory, effects });
  };
  const quitPlayer = async (player: Bot) => {
    if (!player._client.ended) {
      const ended = new Promise<boolean>((r) => player.once('end', () => r(true)));
      ownerScript.push({ atMs: Date.now(), scenario, action: `${player.username}: quit` });
      player.quit();
      assert(await Promise.race([ended, sleep(10_000).then(() => false)]), `${player.username} disconnect did not settle`);
    }
  };
  let owner: Bot | undefined;
  let guest: Bot | undefined;
  let botStart: StationaryPositionProof | undefined;
  process.stdout.write(`locator ordinary live check (${PINS.profile}, lease ${lease}; PLANNER FAULT FIXTURE + loopback first-option Jev; harness validation) -> ${outDir}\n`);
  try {
    assert(/^There are 0 of /i.test(await rcon('list')), 'exclusive fixture must have zero players before joining');
    decision.endpoint = await startJev();
    normalConfig = makeConfig('ordinary', undefined);
    exhaustConfig = makeConfig('exhaust', { routes: { maxTotalDistance: 192, maxLegs: 3 } });
    turnsFor([]);
    await startCli('run-locator-ordinary', normalConfig);
    assert(!events().some((e) => ['goal_admitted', 'skill_started', 'planner_turn_started', 'route_authorized'].includes(e.type)), 'origin must precede any gameplay work');
    botStart = await captureBotPosition('pre-staging origin');
    assert(!events().some((e) => ['goal_admitted', 'skill_started', 'planner_turn_started', 'route_authorized'].includes(e.type)), 'gameplay work started during origin capture');
    owner = await fixturePlayer(OWNER);
    const o = () => owner as Bot;
    const visibilityScope = () => ({ ...positionScope(), goalEpoch: events().filter((e) => e.type === 'goal_admitted').at(-1)?.epoch ?? 0 });
    visibilityCapture = startVisibilityCapture({
      read: async () => {
        const scopeBefore = visibilityScope();
        const owner = await ownerServerRead(), bot = await botServerRead();
        return { scopeBefore, scopeAfter: visibilityScope(), owner, bot };
      },
      wait: (ms) => sleep(ms),
      record: (row) => appendFileSync(join(outDir, 'visibility-reads.jsonl'), `${JSON.stringify({ scenario, ...row })}\n`),
    });

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
        const atMs = Date.now();
        samples.push({ scenario, atMs, dtMs: atMs - t0, bot: b, owner: ow, distance: dist(b, ow) });
        await observe(b, ow, atMs);
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
      const admission = events().find((e) => e.type === 'goal_admitted' && e.goalId === goalId)!;
      const ready = events().filter((e) => e.type === 'connection_ready').at(-1)!;
      const turnsBefore = events().filter((e) => e.type === 'planner_turn_started').length;
      const trips: Json[] = [];
      for (const [dx, dz] of [[70, 20], [-20, 75]] as const) {
        const t0 = Date.now();
        const ow = await serverPos(OWNER);
        await ownerStep({ x: ow.x + dx, z: ow.z + dz }, `leave sight (${dx}, ${dz})`);
        const away = await serverPos(OWNER);
        const again = await sampleUntil(t0, (b, o2) => !!o2 && dist(b, o2) <= 4.5, 120_000);
        scanPrivacy(t0, away);
        const toMs = Date.now();
        const proof = reacquisitionProof(events(), observations, { fromMs: t0, toMs, goalId, goalEpoch: admission.epoch, connectionEpoch: ready.connectionEpoch });
        trips.push({ ok: again.ok, fromMs: t0, toMs, seconds: Math.round((toMs - t0) / 1000), proof, intervals: actionIntervals(events()).filter((a) => proof.actionIds.includes(a.actionId)), completedActions: actionsSince(t0).map((a) => a.capability).slice(0, 12) });
        if (!again.ok) break;
      }
      const turnsAfter = events().filter((e) => e.type === 'planner_turn_started').length;
      ev.push(`trips ${JSON.stringify(trips)}; planner turns during reacquisition ${turnsAfter - turnsBefore}`);
      data.trips = trips;
      assert(trips.length === 2 && trips.every((t) => t.ok), 'reacquired both times');
      assert(trips.every((t) => t.proof.pass), `cue-owned reacquisition proof: ${trips.flatMap((t) => t.proof.errors).join('; ')}`);
      assert(turnsAfter === turnsBefore, 'no extra planner turn during both reacquisitions');
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
      const { g, t0, ownerAt } = await farSeek(ev, data, 'ownerFarWest', 0, 'come here', comeHere());
      assert(actionIntervals(events()).some((a) => a.goalId === g.goalId && a.capability === 'seek_owner' && a.endMs === null), 'stop stages an actual active owned seek');
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
      scanPrivacy(t0, ownerAt);
      say(o(), 'resume');
      await sleep(1_000);
    });

    await check('O3', 'finite "come here" beyond 128: completes only at verified owner proximity', async (ev, data) => {
      const { g, t0, ownerAt, s } = await farSeek(ev, data, 'ownerFarSouthWest', 180, 'come here', comeHere());
      await sampleUntil(t0, (b, ow) => !!ow && dist(b, ow) <= 4.5, 240_000);
      await sampleUntil(t0, () => !!terminalOf(g.goalId), 60_000);
      const term = await goalTerminal(g.goalId, s.from, 200);
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
      const { g, t0, ownerAt } = await farSeek(ev, data, 'ownerFarNorth', -90, 'follow me', followMe());
      turnsFor([{ kind: 'proposal', proposal: comeHere() }, { kind: 'proposal', proposal: blockedTurn('fixture') }]);
      const s = say(o(), 'come here instead');
      const g2 = await goalAccepted(s.from, 30_000);
      const old = await goalTerminal(g.goalId, s.from, 30_000);
      const oldRoute = events().find((e) => e.type === 'route_authorized' && e.goalId === g.goalId)!;
      const revoked = events().filter((e) => e.type === 'route_revoked' && e.routeId === oldRoute.routeId && e.goalEpoch === oldRoute.goalEpoch && tOf(e) >= s.at - 500);
      const authorized = events().filter((e) => e.type === 'route_authorized' && e.goalId === g2.goalId);
      ev.push(`old ${g.goalId} ${old.state} (${old.reason}); new ${g2.goalId}; revoked ${revoked.map((e) => e.reason).join(',')}; new authorizations ${authorized.length}`);
      data.replacement = { old, revoked: revoked.length, authorized: authorized.length };
      assert(old.reason === 'replaced', 'old goal replaced');
      assert(revoked.length >= 1 && authorized.length === 1, 'old route revoked; one new authorization for the new goal');
      const terminal = await sampleUntil(s.at, () => !!terminalOf(g2.goalId), 240_000);
      scanPrivacy(t0, ownerAt);
      assert(terminal.ok, 'replacement finite goal did not become terminal within the unchanged 240s bound');
      const term = await goalTerminal(g2.goalId, s.from, 200);
      ev.push(`new goal ${term.state} (${term.reason})`);
      assert(term.state === 'completed', 'replacement finite goal completes by its unchanged within-3 outcome');
    });

    await check('O5', "owner logout while seeking (a guest stays on the opposite side): the bot stops; the guest's waypoint never steers it", async (ev, data) => {
      await settle(o());
      guest = await fixturePlayer(GUEST);
      await tp(GUEST, 'guestFarWest');
      const { g, t0 } = await farSeek(ev, data, 'ownerFarEast', 90, 'follow me', followMe());
      const ownerLast = await serverPos(OWNER);
      await cleanupPlayer(OWNER, o());
      await quitPlayer(o());
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
      await cleanupPlayer(GUEST, guest);
      await tp(GUEST, 'base');
      finalPositions.push({ player: GUEST, at: await serverPos(GUEST), phase: 'O5 logout' });
      await quitPlayer(guest);
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

    await check('O8', 'ready /reconnect is a no-op; owned disconnect/rejoin revokes old goal/route/cue with no unrequested work', async (ev, data) => {
      await settle(o());
      const { g, t0, ownerAt } = await farSeek(ev, data, 'ownerFarEast', 90, 'follow me', followMe());
      const admission = events().find((e) => e.type === 'goal_admitted' && e.goalId === g.goalId)!;
      const oldReady = events().filter((e) => e.type === 'connection_ready').at(-1)!;
      const route = events().find((e) => e.type === 'route_authorized' && e.goalId === g.goalId)!;
      const noopAtMs = Date.now(), noopFrom = cli.length;
      cli.send('/reconnect');
      await cli.waitSince(/^\[chunkbot\] already ready$/, noopFrom, 5_000);
      await sleep(300);
      const noop = events().filter((e) => tOf(e) >= noopAtMs && ['connection_joining', 'connection_ended', 'locator_detached', 'goal_admitted', 'route_revoked'].includes(e.type));
      assert(noop.length === 0 && !terminalOf(g.goalId), 'ready reconnect keeps the current connection and goal');
      ev.push(`ready /reconnect: already ready, zero lifecycle/admission/revocation events`);
      scanPrivacy(t0, ownerAt);

      // Only this harness-owned dummy is disconnected; no server/client restart.
      const from = cli.length, disconnectedAtMs = Date.now();
      await rcon(`kick ${BOT} locator-ordinary-owned-disconnect`);
      const term = await goalTerminal(g.goalId, from, 20_000);
      await cli.waitSince(/disconnected; idle\. Use \/reconnect/, from, 10_000);
      await waitEvent((e) => e.type === 'locator_detached' && e.connectionEpoch === oldReady.connectionEpoch && tOf(e) >= disconnectedAtMs, 5_000);
      // Join while the owner is hidden: proves the old cue cannot be recycled.
      o().setControlState('sneak', true);
      ownerScript.push({ atMs: Date.now(), scenario, action: 'owner sneak on for fresh-connection no-cue control' });
      await sleep(500);
      const reconnectFrom = cli.length;
      cli.send('/reconnect');
      await cli.waitSince(new RegExp(`\\[chunkbot\\] ready: version=${VERSION_RE}`), reconnectFrom, 40_000);
      const freshReady = events().filter((e) => e.type === 'connection_ready').at(-1)!;
      const dashboard = () => JSON.parse(readFileSync(dashboardPath, 'utf8')) as Json;
      await sleep(1_000);
      const noCue = dashboard();
      assert(noCue.connection.epoch === freshReady.connectionEpoch && noCue.directive.autonomy.locator.actionable === false, 'fresh ready connection has no actionable old/hidden owner cue');
      const freshAtMs = Date.now();
      o().setControlState('sneak', false);
      ownerScript.push({ atMs: freshAtMs, scenario, action: 'owner sneak off: require fresh server broadcast' });
      let freshCue: Json | undefined;
      for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(100)) {
        const d = dashboard();
        const hint = d.directive.autonomy.locator;
        if (d.connection.epoch === freshReady.connectionEpoch && hint.actionable === true && hint.ageMs <= Date.now() - freshAtMs + 1_500) { freshCue = d; break; }
      }
      assert(freshCue, 'fresh connection receives a fresh owner cue after hiding is cleared');
      const p0 = await serverPos(BOT);
      await sleep(15_000);
      const p1 = await serverPos(BOT);
      const problems = reconnectProblems(events(), { goalId: g.goalId, goalEpoch: admission.epoch, oldEpoch: oldReady.connectionEpoch, newEpoch: freshReady.connectionEpoch, routeId: route.routeId, disconnectedAtMs, readyAtMs: tOf(freshReady), untilMs: Date.now() });
      data.reconnect = { term, readyNoopEvents: noop, oldEpoch: oldReady.connectionEpoch, newEpoch: freshReady.connectionEpoch, noCue, freshCue, moved: dist(p0, p1), problems };
      ev.push(`old goal ${term.state} (${term.reason}); epochs ${oldReady.connectionEpoch}->${freshReady.connectionEpoch}; hidden cue unavailable, fresh cue age ${freshCue.directive.autonomy.locator.ageMs}ms; moved ${dist(p0, p1).toFixed(1)}; ${problems.join('; ') || 'ownership evidence complete'}`);
      assert(problems.length === 0, problems.join('; '));
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
      await cleanupPlayer(BOT);
      await stopCli();
      await startCli('run-locator-ordinary-exhaust', exhaustConfig);
      const { g, t0, s } = await farSeek(ev, data, 'ownerFarEast', 90, 'follow me', followMe());
      const exhaustedEvent = () => events().find((e) => (e.type === 'route_exhausted' || e.type === 'route_leg_refused') && tOf(e) >= t0);
      const reached = await sampleUntil(t0, () => !!exhaustedEvent(), 240_000);
      assert(reached.ok, 'route exhaustion did not occur within the unchanged 240s bound');
      const exhausted = exhaustedEvent()!;
      const p0 = await serverPos(BOT);
      await sleep(15_000);
      const p1 = await serverPos(BOT);
      const term = terminalOf(g.goalId);
      ev.push(`route ${exhausted.type} (${exhausted.blocker ?? '-'}; used ${exhausted.distanceUsed ?? '-'}); after: moved ${dist(p0, p1).toFixed(1)} blocks in 15s; bot ${dist(p1, ORD_BASE).toFixed(0)} from the admission anchor; goal ${term?.text ?? 'active'}`);
      data.exhaustion = { type: exhausted.type, blocker: exhausted.blocker ?? null, moved: dist(p0, p1), fromAnchor: dist(p1, ORD_BASE) };
      scanPrivacy(t0, await serverPos(OWNER));
      assert(dist(p0, p1) <= 2, 'no movement after the route budget is spent');
      void s;
    });
  } catch (error) {
    results.push({ id: 'FATAL', title: 'ordinary harness run settled', pass: false, evidence: [error instanceof Error ? error.stack ?? error.message : String(error)], data: {} });
  } finally {
    // Settle this harness-owned read tail before online cleanup, origin restoration or child shutdown.
    await visibilityCapture?.stop();
    scenario = 'restore';
    const step = async (label: string, fn: () => Promise<unknown>) => {
      appendFileSync(join(outDir, 'commands.jsonl'), `${JSON.stringify({ atMs: Date.now(), scenario, phase: 'cleanup_intent', label })}\n`);
      try {
        const detail = await fn();
        const row = { atMs: Date.now(), step: label, ok: true, detail: detail ?? null };
        cleanup.push(row);
        appendFileSync(join(outDir, 'commands.jsonl'), `${JSON.stringify(row)}\n`);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        restoreFailures.push(`${label}: ${why}`);
        const row = { atMs: Date.now(), step: label, ok: false, detail: why };
        cleanup.push(row);
        appendFileSync(join(outDir, 'commands.jsonl'), `${JSON.stringify(row)}\n`);
      }
    };
    if (cliStarted) {
      await step('stop goal/route/controls before online cleanup', async () => {
        const atMs = Date.now();
        ownerScript.push({ atMs, scenario, action: 'terminal stop for final cleanup' });
        cli.send('stop');
        await waitEvent((e) => e.type === 'stop_requested' && tOf(e) >= atMs, 5_000);
        for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(100)) {
          const ev = events();
          if (ev.filter((e) => e.type === 'lease_acquired').every((l) => ev.some((e) => e.type === 'lease_revoked' && e.leaseId === l.leaseId))) return 'all actuator leases revoked';
        }
        throw new Error('actuator lease still active after stop');
      });
    }
    for (const player of ownedPlayers) {
      if (player._client.ended) continue; // logout paths already prove online cleanup before quit
      await step(`${player.username} online cleanup and declared base position`, async () => {
        await cleanupPlayer(player.username, player);
        await tp(player.username, 'base');
        await sleep(250);
        const at = await serverPos(player.username);
        assert(Math.hypot(at.x - ORD_BASE.x, at.y - ORD_BASE.y, at.z - ORD_BASE.z) <= 1.5, `${player.username} final base position not verified`);
        finalPositions.push({ player: player.username, at, phase: 'final cleanup' });
        return at;
      });
    }
    if (cliStarted) {
      await step('Chunkbot online inventory/head/effects and original position', async () => {
        await cleanupPlayer(BOT);
        assert(botStart, 'original bot position was not recorded');
        // Exact recorded origin is the existing restoration exception, never a new destination.
        const target = originalPositionTarget(botStart);
        await rcon(`execute in ${target.dimension} run tp ${BOT} ${target.at.x} ${target.at.y} ${target.at.z}`);
        const restored = await captureBotPosition('original restoration', target);
        finalPositions.push({ player: BOT, at: restored.at, dimension: restored.dimension, phase: 'final cleanup', proof: restored });
        return restored;
      });
      await step('ordinary CLI complete graceful shutdown/exit 0', stopCli);
    }
    for (const player of ownedPlayers) await step(`${player.username} owned connection ended`, () => quitPlayer(player));
    await step('loopback Jev callbacks/connections closed', async () => {
      if (jevServer) {
        jevServer.closeAllConnections();
        await new Promise<void>((r, j) => jevServer!.close((error) => error ? j(error) : r()));
      }
      assert(!visibilityCapture || visibilityCapture.status().settled, 'visibility read callbacks remain active');
      assert(!visibilityCapture?.status().failure && !visibilityCapture?.status().capped, 'visibility capture failed or reached its bounded read limit');
    });
    await step('zero final players', async () => {
      let list = '';
      for (let i = 0; i < 40; i++) {
        list = await rcon('list');
        if (/^There are 0 of /i.test(list)) return list;
        await sleep(100);
      }
      throw new Error(`zero players not verified: ${list}`);
    });
  }

  const pass = results.length > 0 && results.every((r) => r.pass) && restoreFailures.length === 0 && privacyFindings.length === 0;
  if (privacyFindings.length > 0) results.push({ id: 'PRIVACY', title: 'no hidden owner coordinates in model-visible texts', pass: false, evidence: privacyFindings.map((p) => `${p.scenario} ${p.source} ${p.path}: ${p.value} (${p.reason})`), data: {} });
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
        retainedFailure: { report: 'acceptance-native/var/live-check/2026-10-08T06-09-31-852Z-locator-ordinary/report.json', sha256: 'a2d00c656945a63eb083e170668f536f44cae08b29dcf94ecebb81f1fb255e6c', result: 'exit 1; 10/14; original evidence unchanged' },
        retainedLH9Failure: { report: 'acceptance-planner/var/live-check/2026-10-08T07-37-15-110Z-locator-ordinary/report.json', sha256: '3c76d9f6d18036dc802e1f9f46170d07247793857aa668a7de246a1d368074c3', result: '17d0c08; exit 1; 7/14; original evidence unchanged' },
        retainedLH11Failure: { report: 'acceptance-native/var/live-check/2026-10-08T18-10-33-695Z-locator-ordinary/report.json', sha256: 'c2cbcc87f47c7cd6b309303f0e9007b4d81a3b33c631cb38f9359f7b2bb0c131', result: '26f1fa0/application88ebfc9; 26.1.2; exit 1; O1c fails; twelve behavior gates and RESTORE pass, both CLI exits 0 and all14 cleanup; original unchanged' },
        retainedLH10Failures: [
          { report: 'acceptance-native/var/live-check/2026-10-08T16-29-13-690Z-locator-ordinary/report.json', sha256: '747f92e663d6a5eefaa20757271c40e098b05c6303ffc9307acacfc97517b5ba', result: 'a0ae3f8; 26.1.2; exit 1; thirteen behavior gates pass, RESTORE fails; original evidence unchanged' },
          { report: 'acceptance-planner/var/live-check/2026-10-08T16-29-13-689Z-26.2-locator-ordinary/report.json', sha256: '0e39aa4353ce6476206d180253f42af19b4821725cbd23c6764c3cba79f52001', result: 'a0ae3f8; 26.2; exit 1; thirteen behavior gates pass, RESTORE fails; original evidence unchanged' },
        ],
        privacyScans,
        restoreFailures,
        results,
        setup: setupLog,
        ownerScript,
        samples,
        jev: jevLog.map((j) => ({ dtMs: j.atMs - (jevLog[0]?.atMs ?? j.atMs), scenario: j.scenario, offered: j.offered, chosen: j.chosen })),
        plannerPrompts: prompts().map((p) => ({ atMs: p.atMs, chars: p.text.length })),
        cliExits,
        cleanup,
        finalPositions,
        botOrigin: botStart ?? null,
        positionChecks,
        visibilityCapture: visibilityCapture?.status() ?? null,
        observations,
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
