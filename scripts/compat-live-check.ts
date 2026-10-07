// MB-SERVER-001 / MB-SERVER-002 live compatibility checks against a running
// LOCAL TEST FIXTURE only (default 26.1.2; `--fixture 26.2` for the distinct
// 26.2 fixture). No model is called (inference-free profile).
//
//   C1  server attribute values decoded from real packets equal the server's
//       own values (RCON `attribute ... get`) for distinct attributes, under
//       both the legacy label and the registry resource that physics reads;
//   C2  a server-side movement-speed change reaches the physics key live;
//   C3  PRODUCTION movement (built CLI, /diag move_near through mineflayer-
//       pathfinder and prismarine-physics) honours the server movement speed:
//       halving the bot's speed attribute roughly doubles the travel time, the
//       server-confirmed position matches, and the server logs no
//       moved-wrongly/too-quickly corrections;
//   C4  (26.2 only) blocks that exist only in 26.2 decode from real chunk /
//       block-change packets with their exact properties, in the harness bot
//       and in Chunkbot's own perception;
//   C5  status reports clean codec health and the version support level.
//
// Setup uses loopback RCON inside the reset scene area (x 196..224, z 190..224)
// of the fixture world; every command is recorded in the report.
//
//   npm run build && npm run fixture -- start --fixture 26.2 && node scripts/compat-live-check.ts --fixture 26.2
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';
import { CliProcess } from './lib/cli-process.ts';
import { rconCommand } from './lib/rcon.ts';
import { SCENE, sceneClearCommands, sceneCommands } from './lib/scene.ts';

type Bot = ReturnType<typeof mineflayer.createBot>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const FIXTURE_PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const FIXTURE_SUFFIX = FIXTURE_PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${FIXTURE_PINS.profile}`;
const FIXTURE_VERSION_RE = FIXTURE_PINS.minecraftVersion.replace(/\./g, '\\.');
const fx = fixturePaths(PROJECT_ROOT, FIXTURE_PINS);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${FIXTURE_SUFFIX}-compat`);
mkdirSync(outDir, { recursive: true });
const CONFIG = join(PROJECT_ROOT, FIXTURE_PINS.inferenceFreeConfig);

interface Result {
  id: string;
  title: string;
  pass: boolean;
  evidence: string[];
}
const results: Result[] = [];
const setupLog: Array<{ atMs: number; command: string; reply: string }> = [];

const password = (() => {
  const line = readFileSync(fx.properties, 'utf8').split('\n').find((l) => l.startsWith('rcon.password='));
  if (!line) throw new Error('fixture RCON password missing');
  return line.slice('rcon.password='.length).trim();
})();
let rconQueue: Promise<unknown> = Promise.resolve();
async function rcon(command: string, record = true): Promise<string> {
  const run = rconQueue.then(() => rconCommand(FIXTURE_PINS.host, FIXTURE_PINS.rconPort, password, command));
  rconQueue = run.catch(() => undefined);
  const reply = await run;
  if (record) setupLog.push({ atMs: Date.now(), command, reply: reply.slice(0, 300) });
  return reply;
}

async function check(id: string, title: string, fn: (ev: string[]) => Promise<void>): Promise<void> {
  const evidence: string[] = [];
  const started = Date.now();
  try {
    await fn(evidence);
    results.push({ id, title, pass: true, evidence });
    process.stdout.write(`PASS ${id} ${title} (${Date.now() - started}ms)\n`);
  } catch (error) {
    evidence.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    results.push({ id, title, pass: false, evidence });
    process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)?.slice(0, 600)}\n`);
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function serverLog(): string[] {
  try {
    return readFileSync(fx.latestLog, 'utf8').split('\n');
  } catch {
    return [];
  }
}

async function serverPos(name: string): Promise<{ x: number; y: number; z: number }> {
  const r = await rcon(`data get entity ${name} Pos`, false);
  if (!r.startsWith(`${name} has the following entity data:`)) throw new Error(`RCON reply not attributed to ${name}: ${r.slice(0, 120)}`);
  const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(r);
  if (!m) throw new Error(`cannot read position: ${r}`);
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/** The server's own value of a player's attribute (`attribute <p> <id> get`). */
async function serverAttribute(player: string, id: string): Promise<number> {
  const r = await rcon(`attribute ${player} minecraft:${id} get`, false);
  const m = /is (-?[\d.E-]+)/.exec(r);
  if (!m) throw new Error(`cannot read attribute ${id}: ${r}`);
  return Number(m[1]);
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

/**
 * Attributes given DISTINCT non-default base values for C1, so a shifted id
 * mapping cannot match by accident. The server syncs only client-syncable
 * attributes; every attribute it actually sends is compared.
 */
const DISTINCT_BASES: Record<string, number> = {
  movement_speed: 0.0875,
  step_height: 0.65,
  jump_strength: 0.47,
  gravity: 0.085,
  block_interaction_range: 5.25,
  entity_interaction_range: 3.75,
  scale: 1.05,
  safe_fall_distance: 3.5,
  attack_speed: 4.5,
  sneaking_speed: 0.35,
  mining_efficiency: 0.5,
  movement_efficiency: 0.25,
  oxygen_bonus: 0.5,
  water_movement_efficiency: 0.2,
  submerged_mining_speed: 0.3,
  fall_damage_multiplier: 0.9,
  armor: 2,
  armor_toughness: 1,
  luck: 0.5,
  max_health: 22,
};

let chunkbot: CliProcess;

async function act(capability: string, params: unknown, timeoutMs = 120_000): Promise<Json> {
  chunkbot.send(`/diag do ${capability} ${JSON.stringify(params)}`);
  return (await chunkbot.json<Json>('outcome', timeoutMs)).outcome as Json;
}

async function observe(): Promise<Json> {
  chunkbot.send('/diag observe');
  return (await chunkbot.json<Json>('observe')).snapshot as Json;
}

async function main(): Promise<void> {
  process.stdout.write(`compat-live-check: fixture ${FIXTURE_PINS.profile} ${FIXTURE_PINS.host}:${FIXTURE_PINS.port}; report dir ${outDir}\n`);
  process.stdout.write(`fixture: ${await rcon('list')}\n`);
  const fixturePid = Number(readFileSync(fx.pidFile, 'utf8').trim());
  let owner: Bot | undefined;
  chunkbot = new CliProcess('run-compat', ['run', '--no-autonomy', '--config', CONFIG]);
  try {
    await chunkbot.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), 30_000);
    owner = await fixtureBot('FixtureOwner');
    for (const c of sceneClearCommands()) await rcon(c);
    await sleep(1_600);
    for (const c of sceneCommands()) await rcon(c);
    // A clear straight corridor for the movement trials (scene area, ground y=-61).
    await rcon(`fill 196 -60 196 224 -50 200 air`);
    await rcon(`attribute Chunkbot minecraft:movement_speed base reset`);
    await rcon(`attribute FixtureOwner minecraft:movement_speed base reset`);
    await sleep(1_500);

    await check('C1', 'real attribute packets decode to the server values at the official ids, under the legacy label AND the physics resource key', async (ev) => {
      const bot = owner as Bot;
      for (const [id, value] of Object.entries(DISTINCT_BASES)) await rcon(`attribute FixtureOwner minecraft:${id} base set ${value}`);
      await sleep(1_500);
      const attrs = (bot.entity as unknown as { attributes?: Record<string, { value: number }> }).attributes ?? {};
      const registry = (bot as unknown as { registry: { attributesArray: Array<{ resource: string }> } }).registry;
      const resources = new Set(registry.attributesArray.map((a) => a.resource));
      const labels = Object.keys(attrs).filter((k) => !k.startsWith('minecraft:'));
      let compared = 0;
      for (const label of labels.sort()) {
        const id = label.replace(/^(generic|player|zombie)\./, '');
        assert(resources.has(`minecraft:${id}`), `decoded label ${label} is not a registry attribute`);
        const server = await serverAttribute('FixtureOwner', id);
        const legacy = attrs[label]?.value as number;
        const resource = attrs[`minecraft:${id}`]?.value;
        ev.push(`${label}: server ${server}; decoded ${legacy}; minecraft:${id}=${resource}${DISTINCT_BASES[id] !== undefined ? ` (set ${DISTINCT_BASES[id]})` : ''}`);
        assert(Math.abs(legacy - server) < 1e-6, `${label} decoded ${legacy}, server ${server}`);
        assert(resource !== undefined && Math.abs(resource - server) < 1e-6, `minecraft:${id} decoded ${resource}, server ${server}`);
        compared += 1;
      }
      const notSynced = Object.keys(DISTINCT_BASES).filter((id) => !labels.some((l) => l.replace(/^(generic|player|zombie)\./, '') === id));
      ev.push(`compared ${compared} server-synced attributes; set but not synced to clients by the server: ${notSynced.join(', ') || 'none'}`);
      assert(compared >= 8, `only ${compared} attributes were synced`);
      assert(labels.includes('generic.movement_speed'), 'movement speed not synced');
      for (const id of Object.keys(DISTINCT_BASES)) await rcon(`attribute FixtureOwner minecraft:${id} base reset`);
    });

    await check('C2', 'a live server movement-speed change reaches the physics key', async (ev) => {
      const bot = owner as Bot;
      const changed = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no attribute update')), 5_000);
        bot.on('entityAttributes', (e: unknown) => {
          const v = (e as { attributes?: Record<string, { value: number }> }).attributes?.['minecraft:movement_speed']?.value;
          if (e === bot.entity && v !== undefined && Math.abs(v - 0.05) < 1e-9) {
            clearTimeout(timer);
            resolve(v);
          }
        });
      });
      ev.push(await rcon('attribute FixtureOwner minecraft:movement_speed base set 0.05'));
      ev.push(`decoded minecraft:movement_speed after change: ${await changed}`);
      ev.push(await rcon('attribute FixtureOwner minecraft:movement_speed base reset'));
    });

    const trial = async (label: string, speed: number | undefined, ev: string[]): Promise<number> => {
      await rcon(`tp Chunkbot 198.5 -60 198.5 -90 0`);
      await sleep(1_200);
      if (speed === undefined) await rcon('attribute Chunkbot minecraft:movement_speed base reset');
      else await rcon(`attribute Chunkbot minecraft:movement_speed base set ${speed}`);
      await sleep(800);
      chunkbot.send('/diag anchor');
      await chunkbot.json('anchor');
      const logBefore = serverLog().length;
      const o = await act('move_near', { target: { kind: 'destination', dimension: 'overworld', x: 220.5, y: -60, z: 198.5 }, within: 1 });
      const pos = await serverPos('Chunkbot');
      const corrections = serverLog()
        .slice(logBefore)
        .filter((l) => /Chunkbot moved (wrongly|too quickly)/.test(l));
      ev.push(`${label}: server speed ${await serverAttribute('Chunkbot', 'movement_speed')}; move_near ${o.status} in ${o.elapsedMs}ms; server pos ${pos.x.toFixed(2)},${pos.y},${pos.z.toFixed(2)}; corrections ${corrections.length}`);
      assert(o.status === 'succeeded', `move_near ${o.status}: ${o.effect}`);
      assert(Math.hypot(pos.x - 220.5, pos.z - 198.5) <= 1.6, 'server-confirmed position is not at the destination');
      assert(corrections.length === 0, `server corrected movement: ${corrections.join(' | ')}`);
      return o.elapsedMs as number;
    };

    await check('C3', 'production pathfinder/physics movement honours the server movement speed (half speed ~ double time, no server corrections)', async (ev) => {
      const normal = await trial('default speed', undefined, ev);
      const half = await trial('half speed 0.05', 0.05, ev);
      await rcon('attribute Chunkbot minecraft:movement_speed base reset');
      const ratio = half / normal;
      ev.push(`travel-time ratio half/default = ${ratio.toFixed(2)} (physics ignoring the server value would give ~1.0)`);
      assert(ratio > 1.6 && ratio < 2.6, `ratio ${ratio.toFixed(2)} not ~2`);
    });

    if (FIXTURE_PINS.profile === '26.2') {
      await check('C4', '26.2-only blocks decode with exact properties from real packets (harness bot and Chunkbot perception)', async (ev) => {
        const placed = [
          { at: { x: 210, y: -60, z: 196 }, block: 'sulfur_bricks', props: {} },
          { at: { x: 211, y: -60, z: 196 }, block: 'potent_sulfur', props: {} },
          { at: { x: 212, y: -60, z: 196 }, block: 'polished_sulfur_stairs', props: { facing: 'east', half: 'top', shape: 'straight', waterlogged: 'false' } },
        ];
        await rcon('tp Chunkbot 211.5 -60 199.5 180 0');
        await rcon('tp FixtureOwner 214.5 -60 199.5 180 0');
        await sleep(2_000);
        for (const p of placed) {
          const state = Object.keys(p.props).length ? `[${Object.entries(p.props).map(([k, v]) => `${k}=${v}`).join(',')}]` : '';
          ev.push(await rcon(`setblock ${p.at.x} ${p.at.y} ${p.at.z} minecraft:${p.block}${state}`));
        }
        await sleep(1_500);
        const { Vec3 } = await import('vec3');
        for (const p of placed) {
          const b = owner?.blockAt(new Vec3(p.at.x, p.at.y, p.at.z));
          const props = (b as unknown as { getProperties(): Record<string, unknown> } | null)?.getProperties() ?? {};
          ev.push(`harness bot sees ${b?.name} ${JSON.stringify(props)} at ${p.at.x},${p.at.y},${p.at.z}`);
          assert(b?.name === p.block, `expected ${p.block}, decoded ${b?.name}`);
          for (const [k, v] of Object.entries(p.props)) assert(String(props[k]) === v, `${p.block}.${k}=${String(props[k])}, expected ${v}`);
        }
        const snap = await observe();
        const seen = (snap.blocks as Json[]).filter((b) => placed.some((p) => b.at.x === p.at.x && b.at.y === p.at.y && b.at.z === p.at.z));
        ev.push(`Chunkbot perception: ${seen.map((b) => `${b.key}@${b.at.x},${b.at.y},${b.at.z}`).join(', ')}`);
        for (const p of placed) assert(seen.some((b) => b.key === `minecraft:${p.block}` && b.at.x === p.at.x), `Chunkbot did not perceive minecraft:${p.block}`);
        for (const p of placed) await rcon(`setblock ${p.at.x} ${p.at.y} ${p.at.z} air`);
      });
    }

    await check('C5', 'status shows clean codec health and the version support level', async (ev) => {
      chunkbot.mark();
      chunkbot.send('status');
      const line = await chunkbot.waitFor(/\[status\] network: codec=/);
      ev.push(line);
      const m = /codec=decoded:(\d+),trailing:(\d+),failed:(\d+)/.exec(line);
      assert(m && Number(m[1]) > 500 && m[2] === '0' && m[3] === '0', 'codec health not clean');
      assert(line.includes(FIXTURE_PINS.profile === '26.2' ? 'version support: local-compat' : 'version support: upstream-tested'), 'support level');
    });
  } finally {
    await rcon('attribute Chunkbot minecraft:movement_speed base reset').catch(() => undefined);
    owner?.quit();
    chunkbot.send('/quit');
    const exit = await Promise.race([chunkbot.exited, sleep(15_000).then(() => ({ code: null, signal: null }))]);
    chunkbot.save(outDir);
    results.push({ id: 'X', title: 'Chunkbot exits cleanly after /quit', pass: exit.code === 0, evidence: [`exit=${exit.code}`] });
  }
  const passed = results.filter((r) => r.pass).length;
  const report = {
    stamp,
    fixture: { profile: FIXTURE_PINS.profile, host: FIXTURE_PINS.host, port: FIXTURE_PINS.port, version: FIXTURE_PINS.minecraftVersion, pid: fixturePid },
    config: FIXTURE_PINS.inferenceFreeConfig,
    note: 'Inference-free profile; no model calls. Setup only inside the fixture world scene area.',
    passed,
    total: results.length,
    results,
    setupCommands: setupLog,
  };
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`compat-live-check: ${passed}/${results.length} passed; report ${join(outDir, 'report.json')}\n`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`compat-live-check error: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
