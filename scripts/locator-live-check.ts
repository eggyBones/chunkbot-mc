// MB-LOC-001 locator gate harness against the LOCAL loopback test fixtures only.
//
// PRE-INTEGRATION harness: until the designated writer installs the locator
// hooks (H1 packet tap, H2 perception route bounds, H3 composition), this
// script composes the REAL connection, SkillRuntime (perception, knowledge,
// ledger, single actuator lease), the registered skills plus seek_owner /
// route_travel, the LocatorService (attached to the connection's client right
// after ready: "late" attach, reported) and the RouteController, wiring exactly
// the proposed hooks. No model is called: the harness is the owner (a separate
// offline fixture player "FixtureOwner" it controls) and a fixed decision.
//
// Gates (official-source expectations from the static 26.x class inspection
// recorded in docs/reviews/mb-loc-001-locator.md):
//   G1  variants/attribution/hiding: block precision while the owner's chunk is
//       in view distance, chunk precision beyond it, azimuth beyond 332 blocks;
//       a second player is never the owner; crouch / invisibility / head item /
//       logout / dimension change withdraw the owner (untrack) and restore.
//   G2  (needs --approve-rules <id>) locator_bar gamerule off/on and the
//       waypoint_transmit_range attribute; originals restored in finally.
//   G3  route: owner 300 blocks away beyond the 128 admission radius; seek_owner
//       through counted legs, reunion verified by SERVER positions (RCON).
//   G5  (needs --approve-scene <id>) negative route scenes inside the declared
//       footprint (lava / wall / drop), restored in finally.
//   G6  MB-LOC-002 F1 direction matrix at a NEGATIVE-coordinate base: the owner
//       in all eight directions plus bearing wraparound at block (40), chunk
//       (200) and azimuth (400) distance with varied bot yaw; the coarse cue
//       sector and server-chosen variant are checked against SERVER positions;
//       then a short seek_owner window per direction: the first movement
//       (server positions) must agree with the true bearing. No block writes.
//
// Safety: importing this module runs nothing. main() refuses (exit 2) before
// any fixture password read, RCON command, join or output setup unless
// --fixture-lease <granted id> is given. Rule/attribute changes and scene
// fills need their own explicit approval ids. Every RCON command is recorded
// in the report. Reports carry coarse cues, counts, offsets and distances —
// never raw waypoint coordinates.
//
//   npm run build   (source/build frozen for the run)
//   node scripts/locator-live-check.ts --fixture-lease <id> --fixture 26.2 [--gates g1,g2,g3,g5] [--approve-rules <id>] [--approve-scene <id>]
//   node scripts/locator-live-check.ts --fixture-lease <id> --gates g1   (26.1.2 broadcast sanity)
//   node scripts/locator-live-check.ts --fixture-lease <id> [--fixture 26.2] --gates g6   (MB-LOC-002 F1 direction matrix)
//
// Footprint (MB-LOC-001-C4; every bound is declared in LOCATOR_FOOTPRINT and
// enforced before any RCON teleport/fill):
//   overworldTeleports  every player teleport destination: x 600..1301,
//                       y -60..-46, z 958..1201 (named in TELEPORTS)
//   netherTeleports     the dimension trip: nether (0.5, 128, 0.5) on the
//                       bedrock roof, x 0..1, y 128, z 0..1
//   g3BotEnvelope       G3 seeking aborts if the bot leaves x 900..1400, z 900..1140
//   f1Teleports         G6 destinations: x -1401..-600, y -60, z -1401..-600
//   g6BotEnvelope       G6 seeking aborts if the bot leaves x -1100..-900, z -1100..-900
//   scene               G5 writes ONLY x 1000..1040, y -64..-50, z 1100..1140
//   sceneReference      read-only comparison region x 1060..1100 (same y/z)
// G3 makes no block writes. G5 first proves the scene equals the dedicated flat
// baseline (FLAT_BASELINE: official FlatLevelGeneratorSettings.getDefault +
// scripts/fixture.ts level-type=minecraft:flat; verified at runtime against
// the untouched reference region and per-layer probes) and refuses to write if
// it does not; restoration rewrites EVERY layer and re-verifies. Any failed
// restoration or verification fails the whole report.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { EventEmitter } from 'node:events';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Result {
  id: string;
  title: string;
  pass: boolean | 'skipped';
  evidence: string[];
}

export interface Box {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  z1: number;
  z2: number;
}

export const LOCATOR_FOOTPRINT = {
  overworldTeleports: { x1: 600, x2: 1301, y1: -60, y2: -46, z1: 958, z2: 1201 },
  netherTeleports: { x1: 0, x2: 1, y1: 128, y2: 128, z1: 0, z2: 1 },
  g3BotEnvelope: { x1: 900, x2: 1400, y1: -64, y2: 320, z1: 900, z2: 1140 },
  f1Teleports: { x1: -1401, x2: -600, y1: -60, y2: -60, z1: -1401, z2: -600 },
  g6BotEnvelope: { x1: -1100, x2: -900, y1: -64, y2: 320, z1: -1100, z2: -900 },
  scene: { x1: 1000, x2: 1040, y1: -64, y2: -50, z1: 1100, z2: 1140 },
  sceneReference: { x1: 1060, x2: 1100, y1: -64, y2: -50, z1: 1100, z2: 1140 },
} as const satisfies Record<string, Box>;

/**
 * The dedicated fixture's flat baseline: scripts/fixture.ts writes
 * level-type=minecraft:flat with no generator settings, so the official
 * default applies (26.2 jar, FlatLevelGeneratorSettings.getDefault: 1 bedrock,
 * 2 dirt, 1 grass_block from the minimum build height -64), air above.
 * Verified at runtime before any write.
 */
export const FLAT_BASELINE: ReadonlyArray<{ y: number; block: string }> = [
  { y: -64, block: 'bedrock' },
  { y: -63, block: 'dirt' },
  { y: -62, block: 'dirt' },
  { y: -61, block: 'grass_block' },
];
export const FLAT_AIR_FROM = -60;

export const BASE = { x: 1000.5, y: -60, z: 1000.5 };
// MB-LOC-001-C5: the bot starts WEST of every obstacle (obstacles begin at x 1003);
// the owner stands on intact ground east of them; the drop is a stone platform
// (never a hole through bedrock).
export const SCENE_BASE = { x: 1000.5, y: -60, z: 1120.5 };
export const SCENE_PLATFORM = { x1: 1000, x2: 1002, y1: -60, y2: -56, z1: 1118, z2: 1122 };
export const NETHER_ROOF = { x: 0.5, y: 128, z: 0.5 };

/** Every overworld teleport destination of the harness (offsets from BASE unless absolute). */
export const TELEPORTS: Record<string, { x: number; y: number; z: number }> = {
  base: BASE,
  ownerStart: { x: BASE.x + 24, y: BASE.y, z: BASE.z },
  ownerEast40: { x: BASE.x + 40, y: BASE.y, z: BASE.z },
  ownerSouth200: { x: BASE.x, y: BASE.y, z: BASE.z + 200 },
  ownerWest400: { x: BASE.x - 400, y: BASE.y, z: BASE.z },
  ownerNorthEast60: { x: BASE.x + 42, y: BASE.y, z: BASE.z - 42 },
  ownerAbove: { x: BASE.x + 30, y: BASE.y + 14, z: BASE.z },
  ownerLevel30: { x: BASE.x + 30, y: BASE.y, z: BASE.z },
  ownerBack26: { x: BASE.x + 26, y: BASE.y, z: BASE.z },
  ownerRule28: { x: BASE.x + 28, y: BASE.y, z: BASE.z },
  ownerRange60: { x: BASE.x + 60, y: BASE.y, z: BASE.z },
  ownerRange61: { x: BASE.x + 61, y: BASE.y, z: BASE.z },
  ownerRange62: { x: BASE.x + 62, y: BASE.y, z: BASE.z },
  ownerG3: { x: BASE.x + 300, y: BASE.y, z: BASE.z + 40 },
  guestWest30: { x: BASE.x - 30, y: BASE.y, z: BASE.z },
  sceneBot: SCENE_BASE,
  scenePlatform: { x: 1001.5, y: -55, z: 1120.5 },
  sceneOwner: { x: 1034.5, y: -60, z: 1120.5 },
};

/**
 * MB-LOC-002 F1 (G6): a negative-coordinate base, eight bearings plus
 * wraparound (degrees, +x east / +z south: +/-179 straddle due west, -89/-91
 * straddle due north = the azimuth payload's +/-pi) and one distance per
 * server-selected variant (view distance 6 in the dedicated fixtures).
 */
export const F1_BASE = { x: -1000.5, y: -60, z: -1000.5 };
export const F1_BEARINGS = [0, 45, 90, 135, 180, -135, -90, -45, 179, -179, -89, -91] as const;
export const F1_DISTANCES = { vec3i: 40, chunk: 200, azimuth: 400 } as const;
export const F1_YAWS = [0, 90, 180, -90, 135, -45] as const;
export const f1Key = (variant: keyof typeof F1_DISTANCES, bearing: number) => `f1_${variant}_${bearing < 0 ? `m${-bearing}` : bearing}`;
export const F1_TELEPORTS: Record<string, { x: number; y: number; z: number }> = Object.fromEntries([
  ['f1Base', F1_BASE],
  ...(Object.keys(F1_DISTANCES) as Array<keyof typeof F1_DISTANCES>).flatMap((variant) =>
    F1_BEARINGS.map((b) => [f1Key(variant, b), { x: F1_BASE.x + Math.round(Math.cos((b * Math.PI) / 180) * F1_DISTANCES[variant]), y: F1_BASE.y, z: F1_BASE.z + Math.round(Math.sin((b * Math.PI) / 180) * F1_DISTANCES[variant]) }] as const),
  ),
]);

export function insideBox(b: Box, p: { x: number; y: number; z: number }): boolean {
  return p.x >= b.x1 && p.x <= b.x2 + 1 && p.y >= b.y1 && p.y <= b.y2 && p.z >= b.z1 && p.z <= b.z2 + 1;
}

/** Restoration commands for every layer of a box over the flat baseline (bottom up). */
export function baselineRestoreCommands(b: Box): string[] {
  const out: string[] = [];
  for (const layer of FLAT_BASELINE) if (layer.y >= b.y1 && layer.y <= b.y2) out.push(`fill ${b.x1} ${layer.y} ${b.z1} ${b.x2} ${layer.y} ${b.z2} ${layer.block}`);
  const airFrom = Math.max(b.y1, FLAT_AIR_FROM);
  if (airFrom <= b.y2) out.push(`fill ${b.x1} ${airFrom} ${b.z1} ${b.x2} ${b.y2} ${b.z2} air`);
  return out;
}

function argOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const SECTORS = ['east', 'south_east', 'south', 'south_west', 'west', 'north_west', 'north', 'north_east'];
const sectorOf = (dx: number, dz: number) => SECTORS[((Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) % 8) + 8) % 8] as string;

async function run(argv: readonly string[], lease: string): Promise<number> {
  // Heavy imports only after the lease check (import safety and no side effects).
  const { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } = await import('../src/app/fixture-layout.ts');
  const { SkillRuntime } = await import('../src/app/skill-runtime.ts');
  const { loadConfigFile } = await import('../src/config/load.ts');
  const { randomIds, systemClock } = await import('../src/contracts/index.ts');
  const { DEFAULT_LOCATOR_CONFIG, RoutePolicySchema } = await import('../src/contracts/locator.ts');
  const { SkillExecutorImpl } = await import('../src/execution/executor.ts');
  const { TaskCandidateGenerator } = await import('../src/execution/candidates.ts');
  const { SkillRegistry } = await import('../src/execution/registry.ts');
  const { MineflayerConnection } = await import('../src/game/connection.ts');
  const { ownerPolicyFromConfig, offlinePlayerUuid } = await import('../src/game/identity.ts');
  const { LocatorService } = await import('../src/locator/service.ts');
  const { RouteController } = await import('../src/locator/routes.ts');
  const { allSkills } = await import('../src/skills/index.ts');
  const { locatorSkills } = await import('../src/skills/locator.ts');
  const { MemoryRunStore } = await import('../src/telemetry/run-store.ts');
  const { rconCommand } = await import('./lib/rcon.ts');
  const mineflayer = (await import('mineflayer')).default;

  const PINS = fixturePins(fixtureProfileFromArgv(argv));
  const SUFFIX = PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${PINS.profile}`;
  const gates = new Set((argOf(argv, '--gates') ?? (PINS.profile === '26.2' ? 'g1,g3' : 'g1')).split(','));
  const approveRules = argOf(argv, '--approve-rules');
  const approveScene = argOf(argv, '--approve-scene');
  if (approveRules !== undefined && !ID_RE.test(approveRules)) throw new Error('invalid --approve-rules id');
  if (approveScene !== undefined && !ID_RE.test(approveScene)) throw new Error('invalid --approve-scene id');
  const fx = fixturePaths(PROJECT_ROOT, PINS);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${SUFFIX}-locator`);
  mkdirSync(outDir, { recursive: true });
  const props = readFileSync(fx.properties, 'utf8').split('\n');
  const password = props.find((l) => l.startsWith('rcon.password='))?.slice('rcon.password='.length).trim();
  assert(password, 'fixture RCON password missing');
  const viewDistance = Number(props.find((l) => l.startsWith('view-distance='))?.split('=')[1] ?? '10');

  const setupLog: Array<{ atMs: number; command: string; reply: string }> = [];
  let rconQueue: Promise<unknown> = Promise.resolve();
  const rcon = async (command: string, record = true): Promise<string> => {
    const job = rconQueue.then(() => rconCommand(PINS.host, PINS.rconPort, password, command));
    rconQueue = job.catch(() => undefined);
    const reply = await job;
    if (record) setupLog.push({ atMs: Date.now(), command, reply: reply.slice(0, 200) });
    return reply;
  };
  const serverPos = async (name: string) => {
    const r = await rcon(`data get entity ${name} Pos`, false);
    const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(r);
    assert(m, `cannot read ${name} position`);
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  };

  const results: Result[] = [];
  const check = async (id: string, title: string, fn: (ev: string[]) => Promise<void>) => {
    const evidence: string[] = [];
    try {
      await fn(evidence);
      results.push({ id, title, pass: true, evidence });
      process.stdout.write(`PASS ${id} ${title}\n`);
    } catch (error) {
      evidence.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ id, title, pass: false, evidence });
      process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)?.slice(0, 400)}\n`);
    }
  };
  const skip = (id: string, title: string, why: string) => {
    results.push({ id, title, pass: 'skipped', evidence: [why] });
    process.stdout.write(`SKIP ${id} ${title}: ${why}\n`);
  };

  // ------------------------------------------------------------ composition (proposed hooks)
  const loaded = loadConfigFile(join(PROJECT_ROOT, PINS.inferenceFreeConfig));
  const config = loaded.config;
  const OWNER = config.owner.name ?? 'FixtureOwner';
  const OWNER_UUID = offlinePlayerUuid(OWNER);
  const BOT = config.bot.username;
  const store = new MemoryRunStore();
  const game = new MineflayerConnection({ host: config.minecraft.host, port: config.minecraft.port, version: config.minecraft.version, auth: config.bot.auth, username: BOT, authDir: loaded.authDir, joinTimeoutMs: config.minecraft.joinTimeoutMs, replyMode: config.chat.replyMode, log: () => undefined, ownerName: OWNER });
  let epoch = 0;
  const runtime = new SkillRuntime({ config, session: () => game.session(), connectionEpoch: () => game.connectionEpoch, goalEpoch: () => epoch, diagnosticCurrent: () => false, admission: () => game.admissionContext(), store, clock: systemClock, ids: randomIds });
  const locator = new LocatorService({ config: DEFAULT_LOCATOR_CONFIG, version: config.minecraft.version, ownerPolicy: ownerPolicyFromConfig(config), admission: () => game.admissionContext(), session: () => game.session(), clock: systemClock, record: (e) => store.record(e) });
  const routes = new RouteController({ policy: RoutePolicySchema.parse({}), clock: systemClock, record: (e) => store.record(e) });
  game.onLifecycle((event) => {
    locator.onLifecycle(event); // proposed H3
    if (event.type === 'death' || event.type === 'respawn' || event.type === 'dimension_change' || event.type === 'ended') routes.revoke(`lifecycle_${event.type}`);
    runtime.onLifecycle(event);
  });
  const registry = new SkillRegistry([...allSkills(), ...locatorSkills({ locator, routes })]);
  const executor = new SkillExecutorImpl({ registry, leases: runtime.leases, session: () => game.session(), services: runtime.services, goalEpoch: () => epoch, store });
  const candidates = new TaskCandidateGenerator({ registry, services: runtime.services, session: () => game.session(), ids: randomIds });

  // Bounded packet evidence: operation, variant, attribution class (never coordinates).
  const packets: Array<{ t: number; op: string; variant: string; who: string }> = [];
  let guestUuid: string | undefined;
  const tapPackets = (client: EventEmitter) =>
    client.on('tracked_waypoint', (d: { operation?: unknown; waypoint?: { hasUUID?: boolean; uuid?: string; type?: unknown } }) => {
      const uuid = d.waypoint?.hasUUID ? String(d.waypoint.uuid ?? '').toLowerCase() : undefined;
      const who = uuid === undefined ? 'string_id' : uuid === OWNER_UUID ? 'owner_uuid' : uuid === guestUuid ? 'guest' : 'other_uuid';
      if (packets.length < 2_000) packets.push({ t: Date.now(), op: String(d.operation), variant: String(d.waypoint?.type), who });
    });
  const sinceOwner = (t0: number) => packets.filter((p) => p.t >= t0 && p.who === 'owner_uuid');
  const waitOwner = async (t0: number, test: (p: { op: string; variant: string }) => boolean, timeoutMs = 4_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = sinceOwner(t0).find(test);
      if (hit) return hit;
      await sleep(100);
    }
    return undefined;
  };

  const fixturePlayer = async (username: string) => {
    const bot = mineflayer.createBot({ host: PINS.host, port: PINS.port, username, auth: 'offline', version: PINS.minecraftVersion, hideErrors: true });
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${username} did not spawn`)), 20_000);
      bot.once('spawn', () => {
        clearTimeout(timer);
        res();
      });
      bot.once('end', (reason: string) => rej(new Error(`${username} ended: ${reason}`)));
    });
    return bot;
  };

  const restores: Array<{ label: string; fn: () => Promise<unknown> }> = [];
  const startedAt = Date.now();
  const lifecycleLog: Array<{ dtMs: number; type: string }> = [];
  /**
   * Official-rule oracle from SERVER positions of both players (C6): expected
   * variant (azimuth > 332; chunk when the owner's chunk is clearly outside the
   * view distance; block when clearly inside; either near the border) and the
   * true relative sector. Positions stay in the harness; only offsets are reported.
   */
  const oracle = async () => {
    const b = await serverPos(BOT);
    const o = await serverPos(OWNER);
    const d = Math.hypot(o.x - b.x, o.y - b.y, o.z - b.z);
    const chunks = Math.hypot(Math.floor(o.x / 16) - Math.floor(b.x / 16), Math.floor(o.z / 16) - Math.floor(b.z / 16));
    const variants = d > 332 ? ['azimuth'] : chunks <= viewDistance - 1 ? ['vec3i'] : chunks >= viewDistance + 2 ? ['chunk'] : ['vec3i', 'chunk'];
    return { variants, sector: sectorOf(o.x - b.x, o.z - b.z), dy: o.y - b.y, text: `server offset owner-bot (${(o.x - b.x).toFixed(1)}, ${(o.y - b.y).toFixed(1)}, ${(o.z - b.z).toFixed(1)}), distance ${d.toFixed(1)}, chunk distance ${chunks.toFixed(1)}` };
  };
  const restoreFailures: string[] = [];
  let owner: Awaited<ReturnType<typeof fixturePlayer>> | undefined;
  let guest: Awaited<ReturnType<typeof fixturePlayer>> | undefined;
  /** The ONLY teleport path: declared destination, checked against the declared footprint before any RCON. */
  const tp = async (player: string, key: keyof typeof TELEPORTS | 'netherRoof', extra = '') => {
    if (key === 'netherRoof') {
      assert(insideBox(LOCATOR_FOOTPRINT.netherTeleports, NETHER_ROOF), 'nether destination outside the declared footprint');
      await rcon(`execute in minecraft:the_nether run tp ${player} ${NETHER_ROOF.x} ${NETHER_ROOF.y} ${NETHER_ROOF.z}`);
      return;
    }
    // MB-LOC-002 G6 destinations live in their own declared (negative-coordinate) box.
    const f1 = key in F1_TELEPORTS;
    const at = f1 ? F1_TELEPORTS[key] : TELEPORTS[key];
    assert(at && insideBox(f1 ? LOCATOR_FOOTPRINT.f1Teleports : LOCATOR_FOOTPRINT.overworldTeleports, at), `teleport ${String(key)} outside the declared footprint`);
    await rcon(`execute in minecraft:overworld run tp ${player} ${at.x} ${at.y} ${at.z}${extra}`);
  };
  const ownerAt = (key: keyof typeof TELEPORTS) => tp(OWNER, key);
  /** Region equality with the untouched read-only reference region (execute if blocks). */
  const sceneEqualsReference = async () => {
    const sc = LOCATOR_FOOTPRINT.scene;
    const ref = LOCATOR_FOOTPRINT.sceneReference;
    const r = await rcon(`execute if blocks ${sc.x1} ${sc.y1} ${sc.z1} ${sc.x2} ${sc.y2} ${sc.z2} ${ref.x1} ${ref.y1} ${ref.z1} all`);
    return /passed/i.test(r);
  };
  /** Per-layer probes of the expected flat baseline at three columns of a box. */
  const layersMatchBaseline = async (b: Box) => {
    const columns = [[b.x1, b.z1], [Math.floor((b.x1 + b.x2) / 2), Math.floor((b.z1 + b.z2) / 2)], [b.x2, b.z2]] as const;
    const misses: string[] = [];
    for (const [x, z] of columns) {
      for (const layer of FLAT_BASELINE) if (!/passed/i.test(await rcon(`execute if block ${x} ${layer.y} ${z} minecraft:${layer.block}`))) misses.push(`${layer.block}@y${layer.y}`);
      for (const y of [FLAT_AIR_FROM, b.y2]) if (!/passed/i.test(await rcon(`execute if block ${x} ${y} ${z} minecraft:air`))) misses.push(`air@y${y}`);
    }
    return misses;
  };
  const hint = () => locator.ownerHint();

  try {
    process.stdout.write(`locator live check (${PINS.profile}, lease ${lease}) -> ${outDir}\n`);
    // Join Chunkbot, then attach the locator to its client (pre-H1 late attach).
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 40_000);
    try {
      await game.connect(abort.signal);
    } finally {
      clearTimeout(timer);
    }
    const session = game.session();
    assert(session, 'Chunkbot not ready');
    const client = (session.bot as unknown as { _client: EventEmitter })._client;
    locator.attach(client, session.connectionEpoch, true);
    tapPackets(client);
    routes.attachMovement(session, () => epoch);
    // MB-LOC-001-C6: settle (alive, no pending respawn) and PROVE the bot's server
    // position before any oracle; never assume where the server has it.
    game.onLifecycle((e) => lifecycleLog.push({ dtMs: Date.now() - startedAt, type: e.type }));
    const settle = Date.now() + 15_000;
    while (Date.now() < settle && !((game.session()?.bot.health ?? 0) > 0)) await sleep(250);
    await sleep(2_000);
    let placed = false;
    for (let attempt = 0; attempt < 3 && !placed; attempt += 1) {
      await tp(BOT, 'base', ' -90 0');
      await sleep(1_500);
      const sp = await serverPos(BOT);
      const cp = game.session()?.bot.entity.position;
      placed = Math.hypot(sp.x - BASE.x, sp.z - BASE.z) < 1.5 && !!cp && Math.hypot(cp.x - sp.x, cp.z - sp.z) < 1.5;
      lifecycleLog.push({ dtMs: Date.now() - startedAt, type: `bot_placement_attempt_${attempt + 1}:${placed ? 'verified' : 'mismatch'}` });
    }
    assert(placed, 'the bot could not be verified at the base position (server and client)');
    owner = await fixturePlayer(OWNER);
    restores.push({ label: 'owner effects/head/sneak cleared', fn: async () => { owner?.setControlState('sneak', false); await rcon(`effect clear ${OWNER}`); await rcon(`item replace entity ${OWNER} armor.head with air`); } });
    await sleep(1_500);
    await ownerAt('ownerStart');
    await sleep(1_500);

    if (gates.has('g1')) {
      await check('G1-1', 'owner attribution: verified owner UUID + exact listed name; codec gate', async (ev) => {
        const st = locator.status();
        ev.push(`support ${st.support}, codec ${st.codecVersion}, late attach ${locator.attachedLate}`);
        assert(st.support === 'available', 'locator available');
        const h = hint();
        ev.push(`hint ${h.reason} ${h.direction ?? '-'} ${h.distanceBand} ${h.elevation} ${h.precision}`);
        assert(h.actionable, `owner hint actionable (${h.note})`);
      });

      for (const [label, key, expect] of [
        ['east 40 (owner chunk in view distance)', 'ownerEast40', 'vec3i'],
        [`south 200 (beyond view distance ${viewDistance})`, 'ownerSouth200', 'chunk'],
        ['west 400 (beyond 332)', 'ownerWest400', 'azimuth'],
        ['north_east 60', 'ownerNorthEast60', 'vec3i'],
      ] as const) {
        await check(`G1-${label.split(' ')[0]}-${expect}`, `variant and coarse cue for owner offset ${label}`, async (ev) => {
          const t0 = Date.now();
          await ownerAt(key);
          await sleep(500);
          const or = await oracle();
          ev.push(`oracle: ${or.text}; official rule expects ${or.variants.join(' or ')}; planned ${expect}`);
          assert(or.variants.includes(expect), `the setup produced the planned geometry for ${expect}`);
          const p = await waitOwner(t0, (x) => x.variant === expect);
          ev.push(`owner statements since move: ${sinceOwner(t0).map((x) => `${x.op}:${x.variant}`).join(', ') || 'none'}`);
          assert(p, `a ${expect} statement for the owner`);
          await sleep(300);
          const h = hint();
          const want = (await oracle()).sector;
          ev.push(`cue ${h.direction} ${h.distanceBand} ${h.elevation} (${h.precision}); expected sector ${want}`);
          assert(h.actionable && h.direction === want, 'cue sector matches the true relative direction');
          if (expect === 'azimuth') assert(h.distanceBand === 'unknown' && h.elevation === 'unknown', 'azimuth: no distance/height');
          if (expect === 'chunk') assert(h.elevation === 'unknown', 'chunk: no height');
        });
      }

      await check('G1-above', 'block precision states height (owner above, slow falling)', async (ev) => {
        const t0 = Date.now();
        await rcon(`effect give ${OWNER} slow_falling 10 0 true`);
        await ownerAt('ownerAbove');
        await waitOwner(t0, (x) => x.variant === 'vec3i');
        await sleep(300);
        const or = await oracle();
        const h = hint();
        ev.push(`oracle: ${or.text}; cue ${h.direction} ${h.elevation}`);
        assert(or.dy > 3, 'the owner is actually more than 3 blocks above (server positions)');
        assert(h.elevation === 'above', 'above');
        await rcon(`effect clear ${OWNER}`);
        await ownerAt('ownerLevel30');
      });

      await check('G1-guest', 'a second player is tracked but never the owner', async (ev) => {
        guestUuid = offlinePlayerUuid('FixtureGuest'); // before the join: its join-time track packet is attributed (C6)
        guest = await fixturePlayer('FixtureGuest');
        await tp('FixtureGuest', 'guestWest30');
        await sleep(1_500);
        const st = locator.status();
        ev.push(`others tracked ${st.counters.otherTracked}; guest statements ${packets.filter((p) => p.who === 'guest').length}`);
        assert(packets.some((p) => p.who === 'guest'), 'guest waypoint received');
        const or = await oracle();
        ev.push(`oracle: ${or.text}; cue ${hint().direction}`);
        assert(hint().direction === or.sector, 'owner cue unaffected by the guest (west of the bot)');
      });

      for (const [id, title, hide, show] of [
        ['G1-crouch', 'crouching withdraws the owner; standing restores', async () => owner!.setControlState('sneak', true), async () => owner!.setControlState('sneak', false)],
        ['G1-invisible', 'invisibility withdraws the owner; clearing restores', async () => void (await rcon(`effect give ${OWNER} invisibility 30 0 true`)), async () => void (await rcon(`effect clear ${OWNER} invisibility`))],
        ['G1-head', 'a carved pumpkin on the head withdraws the owner; removing restores', async () => void (await rcon(`item replace entity ${OWNER} armor.head with carved_pumpkin`)), async () => void (await rcon(`item replace entity ${OWNER} armor.head with air`))],
      ] as const) {
        await check(id, title, async (ev) => {
          const t0 = Date.now();
          await hide();
          const u = await waitOwner(t0, (x) => x.op === 'untrack');
          await sleep(200);
          ev.push(`after hide: ${u ? 'untrack received' : 'no untrack'}; hint ${hint().reason}`);
          assert(u && !hint().actionable && hint().reason === 'untracked', 'withdrawn, no direction');
          const t1 = Date.now();
          await show();
          const t = await waitOwner(t1, (x) => x.op === 'track');
          await sleep(200);
          ev.push(`after show: ${t ? `track ${t.variant}` : 'no track'}; hint ${hint().reason} ${hint().direction}`);
          assert(t && hint().actionable, 'restored');
        });
      }

      await check('G1-logout', 'owner logout withdraws the owner; rejoin needs a fresh broadcast', async (ev) => {
        const t0 = Date.now();
        owner!.quit();
        const u = await waitOwner(t0, (x) => x.op === 'untrack');
        await sleep(300);
        ev.push(`after logout: ${u ? 'untrack' : 'none'}; hint ${hint().reason}`);
        assert(!hint().actionable, 'no direction after logout');
        owner = await fixturePlayer(OWNER);
        await ownerAt('ownerStart');
        const t = await waitOwner(t0, (x) => x.op === 'track', 6_000);
        await sleep(300);
        ev.push(`after rejoin: ${t ? `track ${t.variant}` : 'none'}; hint ${hint().reason}`);
        assert(hint().actionable, 'fresh broadcast after rejoin');
      });

      await check('G1-dimension', 'owner dimension change withdraws; Chunkbot dimension change voids statements', async (ev) => {
        const t0 = Date.now();
        await tp(OWNER, 'netherRoof');
        const u = await waitOwner(t0, (x) => x.op === 'untrack', 6_000);
        await sleep(300);
        ev.push(`owner to nether: ${u ? 'untrack' : 'none'}; hint ${hint().reason}`);
        assert(!hint().actionable, 'withdrawn');
        await ownerAt('ownerStart');
        await waitOwner(t0, (x) => x.op === 'track', 6_000);
        await sleep(500);
        assert(hint().actionable, 'restored in the overworld');
        await tp(BOT, 'netherRoof');
        await sleep(3_000);
        ev.push(`Chunkbot in ${game.session()?.bot.game.dimension}: hint ${hint().reason}`);
        assert(!hint().actionable, 'no overworld cue in the nether');
        await tp(BOT, 'base');
        await sleep(3_000);
        await ownerAt('ownerBack26');
        await sleep(1_000);
        ev.push(`back in the overworld: hint ${hint().reason}`);
      });
    }

    if (gates.has('g2')) {
      if (!approveRules) skip('G2', 'locator_bar gamerule and waypoint range attribute', 'not run: requires --approve-rules <coordinator approval id>');
      else {
        const original = /(true|false)/.exec(await rcon('gamerule locator_bar'))?.[1] ?? 'true';
        restores.push({ label: `gamerule locator_bar restored to ${original}`, fn: () => rcon(`gamerule locator_bar ${original}`) });
        restores.push({ label: 'owner waypoint_transmit_range attribute reset', fn: () => rcon(`attribute ${OWNER} minecraft:waypoint_transmit_range base reset`) });
        await check('G2-gamerule', 'locator_bar false withdraws every waypoint; true restores', async (ev) => {
          const t0 = Date.now();
          await rcon('gamerule locator_bar false');
          const u = await waitOwner(t0, (x) => x.op === 'untrack');
          await sleep(300);
          ev.push(`rule off: ${u ? 'untrack' : 'none'}; hint ${hint().reason}`);
          assert(u && !hint().actionable, 'withdrawn when disabled');
          const t1 = Date.now();
          await rcon(`gamerule locator_bar ${original}`);
          await ownerAt('ownerRule28');
          const t = await waitOwner(t1, (x) => x.op === 'track', 6_000);
          ev.push(`rule restored: ${t ? 'track' : 'none'}`);
          assert(t, 'restored');
        });
        await check('G2-range', 'transmit range below the distance withdraws (range-limited); reset restores', async (ev) => {
          await ownerAt('ownerRange60');
          await sleep(500);
          const t0 = Date.now();
          await rcon(`attribute ${OWNER} minecraft:waypoint_transmit_range base set 30`);
          await ownerAt('ownerRange61');
          const u = await waitOwner(t0, (x) => x.op === 'untrack', 6_000);
          await sleep(300);
          ev.push(`range 30 at 60: ${u ? 'untrack' : 'none'}; hint ${hint().reason}`);
          assert(!hint().actionable, 'range-limited: no direction');
          const t1 = Date.now();
          await rcon(`attribute ${OWNER} minecraft:waypoint_transmit_range base reset`);
          await ownerAt('ownerRange62');
          assert(await waitOwner(t1, (x) => x.op === 'track', 6_000), 'restored');
        });
      }
    }

    if (gates.has('g3')) {
      await check('G3-route', 'owner 300 blocks away: seek_owner through counted legs, reunion by server positions', async (ev) => {
        await tp(BOT, 'base');
        await ownerAt('ownerG3');
        await sleep(2_000);
        epoch += 1;
        const goalId = `goal-loc${epoch}`;
        runtime.onGoalAdmitted({ goalId, epoch, admittedAtMs: Date.now() });
        const bounds = runtime.perception.travelBounds();
        assert(bounds, 'admission anchor');
        const s = game.session()!;
        const auth = routes.admit({ goalId, goalEpoch: epoch, admittedAtMs: Date.now(), source: 'owner', goalDeadlineMs: Date.now() + config.limits.goalDeadlineMs, connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension), admissionAnchor: bounds.anchor, admissionRadius: bounds.radius, ownerCoordinates: [] });
        assert(auth, 'route authorized');
        const task = { objective: 'Rejoin the owner.', decisionInstruction: 'Seek the owner.', allowedCapabilities: ['seek_owner'], targetSelectors: [{ kind: 'owner' as const }], parameters: {}, completion: { predicate: 'near_target' as const, target: { kind: 'owner' as const }, within: 3 } };
        let reached = false;
        // Declared envelope: seeking is aborted (lease revoked) if the bot leaves it.
        const envelope = new AbortController();
        let left: string | undefined;
        const watch = setInterval(() => {
          const p = game.session()?.bot.entity.position;
          if (p && !insideBox(LOCATOR_FOOTPRINT.g3BotEnvelope, p) && !left) {
            left = `bot left the declared G3 envelope at x ${p.x.toFixed(0)}, z ${p.z.toFixed(0)}`;
            envelope.abort();
          }
        }, 250);
        try {
        for (let window = 0; window < 14 && !reached && !left; window += 1) {
          const snap = runtime.perception.take(epoch);
          assert(snap, 'observation');
          const set = candidates.generate(task, snap);
          const c = set.candidates.find((x) => x.capability === 'seek_owner');
          if (!c) {
            ev.push(`window ${window}: no option (${set.unavailable.map((u) => `${u.capability}:${u.reason}`).join(', ')})`);
            break;
          }
          const o = await executor.execute(c, envelope.signal, { kind: 'goal', goalEpoch: epoch, goalId, taskId: randomIds.next('task') });
          const r = (o.evidence['route'] ?? {}) as Json;
          ev.push(`window ${window}: ${o.status}${o.reason ? ` (${o.reason})` : ''}; legs ${r['legsUsed'] ?? 0}/${r['maxLegs'] ?? '-'}, route blocks ${r['distanceUsed'] ?? 0}`);
          if (o.status === 'succeeded') reached = true;
          else if (!(o.status === 'partial' && o.reason === 'route_window_elapsed')) break;
        }
        } finally {
          clearInterval(watch);
        }
        assert(!left, left ?? '');
        const [b, w] = [await serverPos(BOT), await serverPos(OWNER)];
        const d = Math.hypot(b.x - w.x, b.y - w.y, b.z - w.z);
        const st = routes.status(epoch)!;
        ev.push(`server distance bot-owner ${d.toFixed(1)}; route ${st.state}, legs ${st.legsUsed}/${st.maxLegs}, distance ${st.distanceUsed}/${st.maxTotalDistance} (corrections ${st.distanceSources.correctionCount}); admission anchor unchanged ${JSON.stringify(routes.legBounds({ goalEpoch: epoch, connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension) })?.admissionAnchor) === JSON.stringify(bounds.anchor)}`);
        assert(reached && d <= 4.5, 'reunion verified by server positions');
        assert(st.legsUsed >= 2, 'legs were needed beyond the admission radius');
        routes.revoke('goal_terminal', epoch);
      });
    }

    if (gates.has('g6')) {
      // MB-LOC-002 F1 live: cue sector/variant for every direction and yaw at a negative base, then first movement.
      await tp(BOT, 'f1Base', ' 0 0');
      await tp(OWNER, 'f1Base');
      await sleep(3_000);
      const placed = await serverPos(BOT);
      lifecycleLog.push({ dtMs: Date.now() - startedAt, type: `g6_base:${Math.hypot(placed.x - F1_BASE.x, placed.z - F1_BASE.z) < 1.5 ? 'verified' : 'mismatch'}` });
      let yawIndex = 0;
      for (const variant of Object.keys(F1_DISTANCES) as Array<keyof typeof F1_DISTANCES>) {
        await check(`G6-cue-${variant}`, `F1 cue sector and server variant for 8 directions + wraparound at ${F1_DISTANCES[variant]} blocks (negative coordinates, varied yaw)`, async (ev) => {
          const misses: string[] = [];
          for (const bearing of F1_BEARINGS) {
            const yaw = F1_YAWS[yawIndex++ % F1_YAWS.length]!;
            await tp(BOT, 'f1Base', ` ${yaw} 0`);
            const t0 = Date.now();
            await tp(OWNER, f1Key(variant, bearing));
            await sleep(600);
            const or = await oracle();
            const p = await waitOwner(t0, (x) => or.variants.includes(x.variant), 5_000);
            await sleep(300);
            const h = hint();
            const want = (await oracle()).sector;
            const ok = Boolean(p) && h.actionable && h.direction === want;
            ev.push(`${bearing}deg yaw ${yaw}: ${or.text}; expected ${or.variants.join('/')} ${want}; got ${p ? `${p.op}:${p.variant}` : 'no statement'} cue ${h.reason} ${h.direction ?? '-'} ${h.distanceBand} ${h.precision}${ok ? '' : '  <-- MISMATCH'}`);
            if (!ok) misses.push(`${bearing}`);
          }
          assert(misses.length === 0, `cue/variant mismatches at bearings ${misses.join(', ')}`);
        });
      }
      await check('G6-first-move', 'F1 first movement of a short seek_owner window agrees with the true bearing (server positions), 8 directions + wraparound', async (ev) => {
        const misses: string[] = [];
        for (const bearing of F1_BEARINGS) {
          const variant = bearing % 2 === 0 ? 'chunk' : 'azimuth';
          const yaw = F1_YAWS[yawIndex++ % F1_YAWS.length]!;
          await tp(BOT, 'f1Base', ` ${yaw} 0`);
          await tp(OWNER, f1Key(variant, bearing));
          await sleep(1_500);
          const b0 = await serverPos(BOT);
          const o0 = await serverPos(OWNER);
          const truth = Math.atan2(o0.z - b0.z, o0.x - b0.x);
          epoch += 1;
          const goalId = `goal-locf${epoch}`;
          runtime.onGoalAdmitted({ goalId, epoch, admittedAtMs: Date.now() });
          const bounds = runtime.perception.travelBounds();
          const s = game.session()!;
          assert(bounds, 'admission anchor');
          routes.admit({ goalId, goalEpoch: epoch, admittedAtMs: Date.now(), source: 'owner', goalDeadlineMs: Date.now() + config.limits.goalDeadlineMs, connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension), admissionAnchor: bounds.anchor, admissionRadius: bounds.radius, ownerCoordinates: [] });
          const snap = runtime.perception.take(epoch);
          assert(snap, 'observation');
          const task = { objective: 'Rejoin the owner.', decisionInstruction: 'Seek the owner.', allowedCapabilities: ['seek_owner'], targetSelectors: [{ kind: 'owner' as const }], parameters: { durationMs: 6_000 }, completion: { predicate: 'near_target' as const, target: { kind: 'owner' as const }, within: 3 } };
          const set = candidates.generate(task, snap);
          const c = set.candidates.find((x) => x.capability === 'seek_owner');
          if (!c) {
            ev.push(`${bearing}deg: no seek option (${set.unavailable.map((u) => `${u.capability}:${u.reason}`).join(', ')})  <-- MISS`);
            misses.push(`${bearing}`);
            continue;
          }
          const envelope = new AbortController();
          const watch = setInterval(() => {
            const p = game.session()?.bot.entity.position;
            if (p && !insideBox(LOCATOR_FOOTPRINT.g6BotEnvelope, p)) envelope.abort();
          }, 250);
          let o;
          try {
            o = await executor.execute(c, envelope.signal, { kind: 'goal', goalEpoch: epoch, goalId, taskId: randomIds.next('task') });
          } finally {
            clearInterval(watch);
            routes.revoke('goal_terminal', epoch);
          }
          const b1 = await serverPos(BOT);
          const moved = Math.hypot(b1.x - b0.x, b1.z - b0.z);
          const off = Math.abs(((Math.atan2(b1.z - b0.z, b1.x - b0.x) - truth + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
          const progress = (b1.x - b0.x) * Math.cos(truth) + (b1.z - b0.z) * Math.sin(truth);
          const ok = moved >= 6 && off <= Math.PI / 4 && progress >= 5;
          ev.push(`${bearing}deg (${variant}, yaw ${yaw}): ${o.status}${o.reason ? `/${o.reason}` : ''}; moved ${moved.toFixed(1)} blocks, ${(off * 180 / Math.PI).toFixed(1)}deg off, progress ${progress.toFixed(1)}${ok ? '' : '  <-- MISS'}${envelope.signal.aborted ? ' (envelope abort)' : ''}`);
          if (!ok) misses.push(`${bearing}`);
        }
        assert(misses.length === 0, `first movement disagreed with the true bearing at ${misses.join(', ')}`);
      });
      await tp(OWNER, 'ownerStart');
      await tp(BOT, 'base');
    }

    if (gates.has('g5')) {
      if (!approveScene) skip('G5', 'negative route scenes (lava/wall/drop)', 'not run: requires --approve-scene <coordinator approval id> for the declared footprint');
      else {
        const sc = LOCATOR_FOOTPRINT.scene;
        // Players near the scene keep both regions loaded for the comparisons.
        await tp(BOT, 'sceneBot');
        await tp(OWNER, 'sceneOwner');
        await sleep(2_000);
        const baselineMisses = await layersMatchBaseline(sc);
        const refMisses = await layersMatchBaseline(LOCATOR_FOOTPRINT.sceneReference);
        const equal = await sceneEqualsReference();
        await check('G5-baseline', 'the scene equals the dedicated flat baseline before any write', async (ev) => {
          ev.push(`scene probe misses: ${baselineMisses.join(', ') || 'none'}; reference probe misses: ${refMisses.join(', ') || 'none'}; scene==reference: ${equal}`);
          assert(baselineMisses.length === 0 && refMisses.length === 0 && equal, 'baseline proven (nothing was written)');
        });
        const restoreScene = async () => {
          for (const cmd of baselineRestoreCommands(sc)) await rcon(cmd);
          const misses = await layersMatchBaseline(sc);
          const same = await sceneEqualsReference();
          if (misses.length > 0 || !same) throw new Error(`scene restoration not verified (probe misses: ${misses.join(', ') || 'none'}; equals reference: ${same})`);
        };
        if (baselineMisses.length === 0 && refMisses.length === 0 && equal) {
        restores.push({ label: 'G5 scene restored to the flat baseline (every layer) and verified', fn: restoreScene });
        /**
         * One negative scene. Valid L5 outcomes: the expected specific blocker, or a
         * SAFE detour (route progress/success) — in both cases with no obstacle
         * contact, no damage and no death, monitored for the whole scenario.
         */
        const scenario = async (id: string, title: string, setup: string[], expect: string, start: 'sceneBot' | 'scenePlatform', contact: (p: { x: number; y: number; z: number }) => boolean) =>
          check(id, title, async (ev) => {
            await restoreScene();
            for (const cmd of setup) await rcon(cmd);
            await tp(BOT, start);
            await tp(OWNER, 'sceneOwner');
            await sleep(2_000);
            const bot0 = game.session()?.bot;
            const health0 = bot0?.health ?? 0;
            let minHealth = health0;
            let touched: string | undefined;
            let died = false;
            const offLife = game.onLifecycle((e) => {
              if (e.type === 'death') died = true;
            });
            const mon = setInterval(() => {
              const b = game.session()?.bot;
              if (!b) return;
              minHealth = Math.min(minHealth, b.health ?? minHealth);
              const p = b.entity.position;
              if (!touched && contact(p)) touched = `obstacle contact at x ${p.x.toFixed(1)}, y ${p.y.toFixed(1)}, z ${p.z.toFixed(1)}`;
            }, 100);
            epoch += 1;
            const goalId = `goal-locn${epoch}`;
            runtime.onGoalAdmitted({ goalId, epoch, admittedAtMs: Date.now() });
            const snap = runtime.perception.take(epoch)!;
            const set = candidates.generate({ objective: 'o', decisionInstruction: 'd', allowedCapabilities: ['seek_owner'], targetSelectors: [{ kind: 'owner' }], parameters: {}, completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } }, snap);
            const c = set.candidates.find((x) => x.capability === 'seek_owner');
            assert(c, `seek option (${set.unavailable.map((u) => u.reason).join(', ')})`);
            let o;
            try {
              o = await executor.execute(c, new AbortController().signal, { kind: 'goal', goalEpoch: epoch, goalId, taskId: randomIds.next('task') });
            } finally {
              clearInterval(mon);
              offLife();
            }
            const p = await serverPos(BOT);
            const detour = o.status === 'partial' || o.status === 'succeeded';
            ev.push(`${o.status} (${o.reason ?? '-'}): ${o.effect.slice(0, 160)}; server position offset x ${(p.x - TELEPORTS[start]!.x).toFixed(1)}, y ${(p.y - TELEPORTS[start]!.y).toFixed(1)}; health ${health0} -> min ${minHealth}; death ${died}; ${touched ?? 'no obstacle contact'}`);
            assert(!died && !touched && minHealth >= health0, 'no obstacle contact, damage or death');
            assert((o.status === 'failed' && o.reason === expect) || detour, `specific blocker ${expect} or a safe detour (got ${o.status}/${o.reason ?? '-'})`);
            if (detour) ev.push('outcome: safe detour around the obstacle (valid L5 outcome)');
          });
        const inBand = (p: { x: number; z: number }, x1: number, x2: number) => Math.floor(p.x) >= x1 && Math.floor(p.x) <= x2 && Math.floor(p.z) >= sc.z1 && Math.floor(p.z) <= sc.z2;
        await scenario('G5-lava', 'lava band across the cue', [`fill ${sc.x1 + 3} -61 ${sc.z1} ${sc.x1 + 12} -61 ${sc.z2} lava`], 'hazard_lava', 'sceneBot', (p) => inBand(p, sc.x1 + 3, sc.x1 + 12) && p.y < -60.2);
        await scenario('G5-wall', 'wall higher than one block across the cue', [`fill ${sc.x1 + 3} -60 ${sc.z1} ${sc.x1 + 4} -54 ${sc.z2} stone`], 'wall', 'sceneBot', (p) => inBand(p, sc.x1 + 3, sc.x1 + 4) && p.y < -53);
        const pf = SCENE_PLATFORM;
        await scenario('G5-drop', 'drop deeper than 3 blocks (5-high platform) all around', [`fill ${pf.x1} ${pf.y1} ${pf.z1} ${pf.x2} ${pf.y2} ${pf.z2} stone`], 'cliff_drop', 'scenePlatform', (p) => p.y < -55.5);
        }
      }
    }
  } finally {
    for (const r of restores.reverse()) {
      try {
        await r.fn();
        setupLog.push({ atMs: Date.now(), command: `RESTORE: ${r.label}`, reply: 'ok' });
      } catch (error) {
        const why = error instanceof Error ? error.message.slice(0, 200) : String(error);
        restoreFailures.push(`${r.label}: ${why}`);
        setupLog.push({ atMs: Date.now(), command: `RESTORE FAILED: ${r.label}`, reply: why });
      }
    }
    owner?.quit();
    guest?.quit();
    await game.disconnect('operator_stop').catch(() => undefined);
  }

  const counted = results.filter((r) => r.pass !== 'skipped');
  // A failed restoration fails the whole report (never just a warning).
  if (restoreFailures.length > 0) results.push({ id: 'RESTORE', title: 'every fixture change restored and verified', pass: false, evidence: restoreFailures });
  const pass = counted.length > 0 && counted.every((r) => r.pass === true) && restoreFailures.length === 0;
  const locatorEvents = store.events.filter((e) => String(e.type).startsWith('locator_') || String(e.type).startsWith('route_')).slice(-200);
  writeFileSync(
    join(outDir, 'report.json'),
    `${JSON.stringify({ check: 'MB-LOC-001/002 locator live gates (module harness)', fixture: PINS.profile, lease, approvals: { rules: approveRules ?? null, scene: approveScene ?? null }, footprint: LOCATOR_FOOTPRINT, teleports: TELEPORTS, f1Teleports: F1_TELEPORTS, flatBaseline: FLAT_BASELINE, viewDistance, pass, restoreFailures, lifecycle: lifecycleLog, results, setup: setupLog, packetEvidence: { count: packets.length, sample: packets.slice(0, 400).map((p) => ({ dtMs: p.t - (packets[0]?.t ?? p.t), op: p.op, variant: p.variant, who: p.who })) }, locatorEvents }, null, 2)}\n`,
  );
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} locator live check: ${counted.filter((r) => r.pass === true).length}/${counted.length} (${results.length - counted.length} skipped) — ${outDir}\n`);
  return pass ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  // Shared fixtures are leased: nothing (no RCON, no password read, no join, no output) without an explicit lease id.
  const lease = argOf(argv, '--fixture-lease');
  if (!lease || !ID_RE.test(lease)) {
    process.stderr.write('refusing to run: pass --fixture-lease <granted lease id> (the shared loopback fixtures are leased by the coordinator)\n');
    return 2;
  }
  return run(argv, lease);
}

/** Import safety: importing this module never runs anything; main() starts only as the process entry point. */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  return argv1 !== undefined && moduleUrl === pathToFileURL(resolve(argv1)).href;
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
