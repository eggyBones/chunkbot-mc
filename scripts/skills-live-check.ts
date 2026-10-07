// MB-V1-02 live skill checks against the running LOCAL TEST FIXTURE only.
//
// Drives the real built CLI (`node dist/cli.js run`) over its terminal, using
// the operator mechanic diagnostics (`/diag ...`) that run the SAME registered
// skill definitions, candidate resolvers, executor, actuator lease, perception,
// knowledge and predicate evaluator as goal execution. No model is called.
// Scene setup uses loopback RCON in a reset area of the isolated fixture world;
// every setup command is recorded in the report. Server-side truth (position,
// inventory, blocks) is cross-checked over RCON, independently of the bot.
//
//   npm run build && npm run fixture -- start && npm run skills-live-check
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import mineflayer from 'mineflayer';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';

// Fixture profile: default 26.1.2 (unchanged); `--fixture 26.2` selects the distinct 26.2 fixture (MB-SERVER-001).
const FIXTURE_PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const FIXTURE_SUFFIX = FIXTURE_PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${FIXTURE_PINS.profile}`;
/** Regex-escaped fixture version for expected output lines. */
const FIXTURE_VERSION_RE = FIXTURE_PINS.minecraftVersion.replace(/\./g, '\\.');
import { CliProcess, CLI } from './lib/cli-process.ts';
import { rconCommand } from './lib/rcon.ts';
import { SCENE, sceneClearCommands, sceneCommands } from './lib/scene.ts';

type Bot = ReturnType<typeof mineflayer.createBot>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fx = fixturePaths(PROJECT_ROOT, FIXTURE_PINS);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${FIXTURE_SUFFIX}-skills`);
mkdirSync(outDir, { recursive: true });
// Mechanic checks run the INFERENCE-FREE profile (planner disabled by explicit configuration).
const CONFIG = join(PROJECT_ROOT, FIXTURE_PINS.inferenceFreeConfig);

interface Result {
  id: string;
  title: string;
  pass: boolean;
  evidence: string[];
}
const results: Result[] = [];
const setupLog: Array<{ atMs: number; command: string; reply: string }> = [];
const STOP_TARGET_MS = 250;

function rconPassword(): string {
  const line = readFileSync(fx.properties, 'utf8').split('\n').find((l) => l.startsWith('rcon.password='));
  if (!line) throw new Error('fixture RCON password missing');
  return line.slice('rcon.password='.length).trim();
}
const password = rconPassword();
/**
 * Setup/verification command over loopback RCON; recorded (never the password).
 * Commands are SERIALIZED through one queue (one command, one reply, in order),
 * so concurrent truth queries cannot be confused with each other.
 */
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

// ---------------------------------------------------------------- server truth over RCON

/** Server-side position; the reply must name the queried player (attribution check). */
async function serverPos(name = 'Chunkbot'): Promise<{ x: number; y: number; z: number }> {
  const r = await rcon(`data get entity ${name} Pos`, false);
  if (!r.startsWith(`${name} has the following entity data:`)) throw new Error(`RCON reply not attributed to ${name}: ${r.slice(0, 120)}`);
  const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(r);
  if (!m) throw new Error(`cannot read position: ${r}`);
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

async function serverInventory(name = 'Chunkbot'): Promise<Record<string, number>> {
  const r = await rcon(`data get entity ${name} Inventory`, false);
  if (!r.startsWith(`${name} has the following entity data:`) && !/has no/.test(r)) throw new Error(`RCON reply not attributed to ${name}: ${r.slice(0, 120)}`);
  const out: Record<string, number> = {};
  for (const entry of r.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) ?? []) {
    const id = /id: "([^"]+)"/.exec(entry)?.[1];
    const count = Number(/count: (\d+)/.exec(entry)?.[1] ?? 0);
    if (id) out[id] = (out[id] ?? 0) + count;
  }
  return out;
}

async function blockIs(x: number, y: number, z: number, block: string): Promise<boolean> {
  const r = await rcon(`execute if block ${x} ${y} ${z} ${block}`, false);
  return /passed/i.test(r);
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

// ---------------------------------------------------------------- CLI helpers

let chunkbot: CliProcess;

async function observe(): Promise<Json> {
  chunkbot.send('/diag observe');
  return (await chunkbot.json<Json>('observe')).snapshot as Json;
}

async function act(capability: string, params: unknown, timeoutMs = 120_000): Promise<Json> {
  chunkbot.send(`/diag do ${capability} ${JSON.stringify(params)}`);
  return (await chunkbot.json<Json>('outcome', timeoutMs)).outcome as Json;
}

async function candidates(task: unknown): Promise<Json> {
  chunkbot.send(`/diag candidates ${JSON.stringify(task)}`);
  return (await chunkbot.json<Json>('candidates')).set as Json;
}

function handleOf(snap: Json, key: string, at?: { x: number; y: number; z: number }, list: 'blocks' | 'entities' | 'drops' = 'blocks'): { snapshotId: string; handle: string } {
  const thing = (snap[list] as Json[]).find((b) => b.key === key && (!at || (b.at.x === at.x && b.at.y === at.y && b.at.z === at.z)));
  assert(thing, `no ${key}${at ? ` at ${at.x},${at.y},${at.z}` : ''} in snapshot ${snap.id} ${list}`);
  return { snapshotId: snap.id as string, handle: thing.handle as string };
}

/**
 * MB-PLAN-004: interface diagnostics (X4, I1) must not inherit wherever the
 * previous scenario left Chunkbot (after X2/X3 it stands behind the furnace and
 * wool, which occlude the chest). Stage an independent, RECORDED, safe view of
 * the scene chest, then assert from an actual snapshot that the chest is
 * visible and in reach. Perception, reach and handle rules are unchanged.
 */
const CHEST_VIEW = { x: 203.5, y: -60, z: 205.5 }; // 1.5 blocks north of the chest at 203,-60,207, facing it (+z)
async function stageVisibleChest(ev: string[], scenario: string): Promise<{ snap: Json; chest: { snapshotId: string; handle: string } }> {
  const c = SCENE.chest;
  assert(await blockIs(c.x, c.y, c.z, 'chest'), `${scenario}: RCON: the scene chest exists at ${c.x},${c.y},${c.z}`);
  // standing cell (feet/head) and the cell between Chunkbot and the chest must be clear; clear them (recorded) only if not
  for (const [x, y, z] of [[203, -60, 205], [203, -59, 205], [203, -60, 206], [203, -59, 206]] as const) {
    if (!(await blockIs(x, y, z, 'air'))) await rcon(`setblock ${x} ${y} ${z} air`);
  }
  assert(await blockIs(203, -61, 205, 'grass_block'), `${scenario}: solid floor under the staging position`);
  await rcon(`tp Chunkbot ${CHEST_VIEW.x} ${CHEST_VIEW.y} ${CHEST_VIEW.z} 0 30`);
  await sleep(900);
  const snap = await observe();
  const thing = (snap['blocks'] as Json[]).find((b) => b.key === 'minecraft:chest' && b.at.x === c.x && b.at.y === c.y && b.at.z === c.z);
  const self = (snap['self'] as Json)['at'] as Json;
  const server = await serverPos();
  ev.push(`${scenario} staging: RCON Chunkbot position ${server.x.toFixed(2)},${server.y.toFixed(2)},${server.z.toFixed(2)}`);
  ev.push(`${scenario} staged (recorded setup): Chunkbot at ${self.x.toFixed(1)},${self.y.toFixed(1)},${self.z.toFixed(1)}; chest ${thing ? `${thing.handle} distance ${thing.distance} inReach ${thing.inReach}` : 'NOT visible'} in ${snap.id}`);
  assert(thing, `${scenario}: the chest is visible in the staged snapshot`);
  assert(thing.inReach === true, `${scenario}: the chest is within reach from the staged position`);
  return { snap, chest: { snapshotId: snap.id as string, handle: thing.handle as string } };
}

function outcomeLine(o: Json): string {
  return `${o.capability} -> ${o.status}${o.reason ? ` (${o.reason})` : ''}: ${String(o.effect).slice(0, 220)} [confirmation=${o.confirmation}, ${o.elapsedMs}ms]`;
}

async function expectStatus(o: Json, status: string | string[], ev: string[]): Promise<void> {
  ev.push(outcomeLine(o));
  const ok = Array.isArray(status) ? status.includes(o.status) : o.status === status;
  assert(ok, `expected ${String(status)}, got ${o.status}: ${o.effect} ${JSON.stringify(o.evidence).slice(0, 400)}`);
}

/** Sends `stop` and returns latency to the diagnostic stop line plus the lease report. */
async function stopAndMeasure(ev: string[]): Promise<Json> {
  chunkbot.mark();
  const sentAt = chunkbot.send('stop');
  const stopped = await chunkbot.json<Json>('stop', 5_000);
  const line = [...chunkbot.lines].reverse().find((l) => l.text.startsWith('[diag-json] {"kind":"stop"'));
  const latency = (line?.atMs ?? Date.now()) - sentAt;
  ev.push(`stop: terminal->stop-line ${latency}ms; lease revoke clearMs=${stopped.clearMs} steps=${(stopped.steps as string[]).join(',')} clearedShared=${stopped.clearedShared}`);
  assert(latency <= STOP_TARGET_MS, `stop took ${latency}ms (target ${STOP_TARGET_MS}ms)`);
  assert((stopped.clearMs as number) <= STOP_TARGET_MS, `control clear took ${stopped.clearMs}ms`);
  return { ...stopped, latency };
}

/**
 * Sends `stop` while an action may be finishing. Returns the action outcome and,
 * if the stop reached a running action, its latency and lease report. Searches
 * from `fromIndex` (the line index where the action was started).
 */
async function stopRace(ev: string[], fromIndex: number): Promise<{ outcome: Json; stopped?: Json & { latency: number } }> {
  const sentAt = chunkbot.send('stop');
  await chunkbot.waitSince(/^\[diag-json\] \{"kind":"outcome"/, fromIndex, 30_000);
  await sleep(50);
  const since = chunkbot.lines.slice(fromIndex);
  const outLine = since.find((l) => l.text.startsWith('[diag-json] {"kind":"outcome"'));
  const stopLine = since.find((l) => l.text.startsWith('[diag-json] {"kind":"stop"'));
  chunkbot.mark();
  const outcome = JSON.parse((outLine as { text: string }).text.slice('[diag-json] '.length)).outcome as Json;
  if (!stopLine) {
    ev.push('stop arrived after the action had already finished');
    return { outcome };
  }
  const stopped = JSON.parse(stopLine.text.slice('[diag-json] '.length)) as Json;
  const latency = stopLine.atMs - sentAt;
  ev.push(`stop: terminal->stop-line ${latency}ms; lease revoke clearMs=${stopped.clearMs} steps=${(stopped.steps as string[]).join(',')} clearedShared=${stopped.clearedShared}`);
  assert(latency <= STOP_TARGET_MS, `stop took ${latency}ms (target ${STOP_TARGET_MS}ms)`);
  assert((stopped.clearMs as number) <= STOP_TARGET_MS, `control clear took ${stopped.clearMs}ms`);
  return { outcome, stopped: { ...stopped, latency } };
}

/**
 * Picks up visible drops of `key`. A drop can merge into a neighbouring stack
 * (vanilla) between observation and execution; the skill then refuses the
 * stale handle (target_gone) and we re-observe, like a decision loop would.
 */
async function pickupAll(key: string, ev: string[]): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    const snap = await observe();
    const drop = (snap.drops as Json[]).find((d) => d.key === key);
    if (!drop) return;
    const o = await act('pickup_item', { target: { snapshotId: snap.id, handle: drop.handle } });
    // Vanilla merges nearby identical item entities: the targeted entity is then destroyed without a
    // collect packet and the skill honestly reports item_vanished (failed) / target_gone (precondition).
    if ((o.status === 'precondition_failed' || o.status === 'failed') && (o.reason === 'target_gone' || o.reason === 'item_vanished')) {
      ev.push(`revalidation: ${outcomeLine(o)} -> re-observing`);
      continue;
    }
    await expectStatus(o, 'succeeded', ev);
  }
}

async function setupScene(): Promise<void> {
  for (const c of sceneClearCommands()) await rcon(c);
  await sleep(1_600);
  for (const c of sceneCommands()) await rcon(c);
  await sleep(1_200);
  chunkbot.send('/diag anchor');
  await chunkbot.json('anchor');
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

function offline(name: string, args: string[]): { code: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  writeFileSync(join(outDir, `${name}.log`), `${r.stdout}\n${r.stderr}`);
  return { code: r.status, stdout: r.stdout };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  process.stdout.write(`skills-live-check: fixture ${FIXTURE_PINS.host}:${FIXTURE_PINS.port}; report dir ${outDir}\n`);
  const list = await rcon('list').catch((error: unknown) => {
    throw new Error(`fixture not reachable over RCON (${String(error)}); run npm run fixture -- start`);
  });
  process.stdout.write(`fixture: ${list}\n`);
  const fixturePid = Number(readFileSync(fx.pidFile, 'utf8').trim());

  // ---------------------------------------------------------------- K1 offline knowledge (built CLI)
  await check('K1', 'knowledge: recipes/requirements while prerequisites are absent; harvest, smelting, fuel; unknowns stay unknown', async (ev) => {
    const q = (name: string, query: unknown) => {
      const r = offline(`knowledge-${name}`, ['knowledge', JSON.stringify(query), '--config', CONFIG]);
      assert(r.code === 0, `knowledge ${name} exit ${r.code}`);
      return JSON.parse(r.stdout) as Json;
    };
    const chest = q('iron_chestplate', { kind: 'recipe', output: 'minecraft:iron_chestplate' });
    assert(chest.status === 'known' && chest.data.recipes[0].ingredients[0].count === 8 && chest.data.recipes[0].workstations.includes('minecraft:crafting_table'), 'iron chestplate recipe');
    ev.push(`iron_chestplate: 8 x ${chest.data.recipes[0].ingredients[0].accepts} at ${chest.data.recipes[0].workstations.join('/')} (no inventory or table needed to answer)`);
    const pick = q('wooden_pickaxe', { kind: 'recipe', output: 'minecraft:wooden_pickaxe' });
    ev.push(`wooden_pickaxe: ${pick.data.recipes[0].ingredients.map((i: Json) => `${i.count} ${i.accepts}`).join(' + ')} at ${pick.data.recipes[0].workstations.join('/')}`);
    const stone = q('stone', { kind: 'recipe', output: 'minecraft:stone' });
    assert(stone.data.recipes[0].type === 'smelting' && stone.data.recipes[0].ingredients[0].accepts === 'minecraft:cobblestone', 'stone comes from smelting cobblestone');
    ev.push(`stone item: ${stone.data.recipes[0].type} of ${stone.data.recipes[0].ingredients[0].accepts}, ${stone.data.recipes[0].cookingTicks} ticks, needs fuel`);
    const harvest = q('harvest_stone', { kind: 'harvest', block: 'minecraft:stone' });
    assert(harvest.data.requiresTool && harvest.data.drops.includes('minecraft:cobblestone'), 'stone harvest');
    ev.push(`breaking stone: requiresTool=${harvest.data.requiresTool} (${harvest.data.harvestTools.length} pickaxes) drops ${harvest.data.drops.join(',')} (not stone)`);
    const fuel = q('fuel_planks', { kind: 'fuel', item: 'minecraft:oak_planks' });
    assert(fuel.data.burnTicks === 300, 'planks burn 300 ticks');
    ev.push(`fuel oak_planks: ${fuel.data.burnTicks} ticks = ${fuel.data.itemsSmeltedPerUnit} items`);
    const unknown = q('unknown', { kind: 'recipe', output: 'minecraft:not_a_real_item' });
    assert(unknown.status === 'unknown', 'unknown item stays unknown');
    ev.push(`unknown item: ${unknown.status} (${unknown.detail})`);
    const cat = offline('catalog', ['catalog', '--json', '--config', CONFIG]);
    const catalog = JSON.parse(cat.stdout) as Json;
    ev.push(`catalog ${catalog.catalogVersion}: ${catalog.capabilities.length} capabilities from registered definitions`);
    assert(catalog.capabilities.length >= 20, 'catalog size');
  });

  chunkbot = new CliProcess('run-skills', ['run', '--no-autonomy', '--config', CONFIG]);
  let owner: Bot | undefined;
  try {
    await check('S0', 'run joins the fixture with the skill layer installed; status shows skills ready, planner not ready', async (ev) => {
      ev.push(await chunkbot.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), 30_000));
      ev.push(await chunkbot.waitFor(/\[chunkbot\] skills: 20 capabilities/, 5_000).catch(() => chunkbot.lines.find((l) => /skills:/.test(l.text))?.text ?? 'skills line seen before ready'));
      chunkbot.send('status');
      ev.push(await chunkbot.waitFor(/\[status\] adapters: planner=not-ready knowledge=ready perception=ready skills=ready capabilities=20/));
      await setupScene();
      ev.push(`scene reset with ${setupLog.length} recorded RCON setup commands`);
    });

    // ---------------------------------------------------------------- G-04 perception / occlusion
    await check('P1', 'perception: walled-in ore/cow/apple hidden; glass window, pig, bread visible; handles carry snapshot/dimension; no hidden data fields', async (ev) => {
      const snap = await observe();
      const keys = (snap.blockSummary as Json[]).map((b) => b.key);
      assert(!keys.includes('minecraft:diamond_ore'), 'diamond_ore behind the wall must not be visible');
      assert(keys.includes('minecraft:emerald_block'), 'emerald block behind glass should be visible');
      assert(keys.includes('minecraft:stone_bricks') && keys.includes('minecraft:glass'), 'wall and glass visible');
      const ents = snap.entities as Json[];
      assert(ents.some((e) => e.key === 'minecraft:pig'), 'pig in front visible');
      assert(!ents.some((e) => e.key === 'minecraft:cow' && e.at.z > 212), 'cow behind wall hidden');
      const drops = snap.drops as Json[];
      assert(drops.some((d) => d.key === 'minecraft:bread'), 'bread in front visible');
      assert(!drops.some((d) => d.key === 'minecraft:apple'), 'apple behind wall hidden');
      assert(snap.dimension === 'overworld' && typeof snap.takenAtMs === 'number' && /^snap-/.test(snap.id), 'snapshot identity');
      assert(!('seed' in snap) && !('players' in snap), 'no hidden fields');
      ev.push(`visible types: ${keys.length}; diamond_ore hidden; emerald_block visible through glass; entities ${ents.map((e) => e.key.replace('minecraft:', '')).join(',')}; drops ${drops.map((d) => d.key.replace('minecraft:', '')).join(',')}`);
      ev.push(`policy: ${snap.perception.policy}; radius ${snap.perception.radius}; truncated=${snap.perception.truncated}`);
      // Hidden-ore probe from the other side of the wall: becomes visible only with line of sight.
      await rcon(`tp Chunkbot 205.5 -60 217.5 180 0`);
      await sleep(900);
      const behind = await observe();
      const k2 = (behind.blockSummary as Json[]).map((b) => b.key);
      assert(k2.includes('minecraft:diamond_ore'), 'diamond_ore visible once in line of sight');
      assert((behind.entities as Json[]).some((e) => e.key === 'minecraft:cow' && e.at.z > 212), 'cow visible from behind the wall');
      ev.push('from behind the wall (setup teleport): diamond_ore and the cow become visible — visibility follows line of sight, not loaded data');
      await rcon(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
      await sleep(900);
    });

    // ---------------------------------------------------------------- MB-SKL-002 opaque fluids (built scene)
    await check('V1', 'fluids: a gold block seen only through a glass-enclosed lava box is hidden; a lapis block behind the same water box is visible; gold visible from the side', async (ev) => {
      // Setup (recorded): two 3x3x3 glass shells, two-high fluid sources in the middle cell, targets 3 blocks behind.
      for (const c of [
        'fill 207 -60 195 209 -58 197 glass',
        'setblock 208 -60 196 lava',
        'setblock 208 -59 196 lava',
        'setblock 208 -60 193 gold_block',
        'fill 212 -60 195 214 -58 197 glass',
        'setblock 213 -60 196 water',
        'setblock 213 -59 196 water',
        'setblock 213 -60 193 lapis_block',
      ])
        await rcon(c);
      try {
        assert(await blockIs(208, -60, 196, 'lava') && await blockIs(208, -60, 193, 'gold_block'), 'RCON: lava box and gold block exist');
        await rcon('tp Chunkbot 208.5 -60 199.5 180 10');
        await sleep(900);
        const lavaView = await observe();
        const lavaKeys = (lavaView.blockSummary as Json[]).map((b) => b.key);
        ev.push(`at 208.5,199.5 (gold straight behind the lava box): lava visible=${lavaKeys.includes('minecraft:lava')} glass visible=${lavaKeys.includes('minecraft:glass')} gold visible=${lavaKeys.includes('minecraft:gold_block')}`);
        assert(lavaKeys.includes('minecraft:lava'), 'the lava itself is visible through glass');
        assert(!lavaKeys.includes('minecraft:gold_block'), 'gold behind lava must be hidden');
        await rcon('tp Chunkbot 213.5 -60 199.5 180 10');
        await sleep(900);
        const waterView = await observe();
        const waterKeys = (waterView.blockSummary as Json[]).map((b) => b.key);
        ev.push(`at 213.5,199.5 (lapis straight behind the water box): lapis visible=${waterKeys.includes('minecraft:lapis_block')}`);
        assert(waterKeys.includes('minecraft:lapis_block'), 'lapis behind water is visible (water is not opaque)');
        await rcon('tp Chunkbot 204.5 -60 193.5 270 10');
        await sleep(900);
        const side = await observe();
        const sideKeys = (side.blockSummary as Json[]).map((b) => b.key);
        ev.push(`from the side (204.5,193.5, no fluid in between): gold visible=${sideKeys.includes('minecraft:gold_block')}`);
        assert(sideKeys.includes('minecraft:gold_block'), 'gold visible without lava in the way: lava was the occluder');
      } finally {
        await rcon('fill 207 -60 193 214 -58 197 air');
        await rcon(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
        await sleep(900);
      }
    });

    // ---------------------------------------------------------------- G-06 prerequisites surface as evidence
    await check('C0', 'candidates: empty inventory yields structured missing-prerequisite evidence, not a hidden chain', async (ev) => {
      const set = await candidates({
        objective: 'Have a wooden pickaxe.',
        decisionInstruction: 'Craft it if possible.',
        allowedCapabilities: ['craft_item', 'mine_block'],
        completion: { predicate: 'crafting_result', output: 'minecraft:wooden_pickaxe', atLeast: 1 },
      });
      const craft = (set.unavailable as Json[]).find((u) => u.capability === 'craft_item');
      assert((set.candidates as Json[]).every((c) => c.capability !== 'craft_item'), 'no craft candidate without ingredients');
      assert(craft && craft.reason === 'missing_ingredients', `expected missing_ingredients, got ${JSON.stringify(craft)}`);
      ev.push(`craft_item unavailable: ${craft.reason} ${JSON.stringify(craft.evidence).slice(0, 200)}`);
      ev.push(`mine_block for the same task: ${(set.candidates as Json[]).filter((c) => c.capability === 'mine_block').length} candidates (no block drops a pickaxe; nothing invented)`);
      const stone = await candidates({
        objective: 'Collect cobblestone.',
        decisionInstruction: 'Mine visible stone.',
        allowedCapabilities: ['mine_block', 'move_near'],
        completion: { predicate: 'inventory_delta', selector: 'minecraft:cobblestone', atLeast: 2, mayBeConsumedLater: true },
      });
      const mineU = (stone.unavailable as Json[]).filter((u) => u.capability === 'mine_block');
      ev.push(`mine_block for cobblestone without a pickaxe: ${mineU.map((u) => `${u.reason} ${JSON.stringify(u.evidence).slice(0, 120)}`).join('; ')}`);
      assert(mineU.some((u) => u.reason === 'harvest_tool_missing' || u.reason === 'out_of_reach'), 'tool/out-of-reach evidence');
      const approach = (stone.candidates as Json[]).filter((c) => c.capability === 'move_near');
      ev.push(`move_near offers ${approach.length} approach candidates (${approach.slice(0, 2).map((c) => c.description).join('; ')}) — visible stone matched through installed drop data, not a resource script`);
      assert(approach.some((c) => /minecraft:stone/.test(c.description)), 'approach candidates for blocks that drop the wanted item');
    });

    // ---------------------------------------------------------------- G-01/G-05 mining two mechanically different targets
    const inventoryBefore = await serverInventory();
    await check('M1', 'mine logs by hand (no tool required) and pick up drops: server block change + collect packet + server inventory', async (ev) => {
      ev.push(`server inventory before: ${JSON.stringify(inventoryBefore)}`);
      for (const p of SCENE.logs) {
        const snap = await observe();
        let o = await act('mine_block', { target: handleOf(snap, 'minecraft:oak_log', p) });
        if (o.status === 'precondition_failed' && o.reason === 'out_of_reach') {
          await expectStatus(await act('move_near', { target: { kind: 'handle', ...handleOf(snap, 'minecraft:oak_log', p) }, within: 2 }), 'succeeded', ev);
          const s2 = await observe();
          o = await act('mine_block', { target: handleOf(s2, 'minecraft:oak_log', p) });
        }
        await expectStatus(o, 'succeeded', ev);
        assert(o.confirmation === 'server_packet' && o.evidence.serverState === 'minecraft:air', 'break confirmed by server block change');
        // The real Mineflayer dig predicted air locally (prediction tap), and the server statement resolved it.
        assert(o.evidence.clientPredictionsMarked >= 1 && o.evidence.predictionPendingAfter === false, `prediction marked and resolved: ${o.evidence.clientPredictionsMarked}/${o.evidence.predictionPendingAfter}`);
        assert(await blockIs(p.x, p.y, p.z, 'air'), `RCON: ${p.x},${p.y},${p.z} is air`);
      }
      ev.push('each break: Mineflayer marked a local air prediction (prediction tap), resolved by the server block change; unconfirmed voxels are opaque/unreported until then');
      await sleep(500);
      await pickupAll('minecraft:oak_log', ev);
      const inv = await serverInventory();
      ev.push(`RCON server inventory: ${JSON.stringify(inv)}`);
      assert((inv['minecraft:oak_log'] ?? 0) === 3, 'server holds 3 oak logs');
    });

    await check('M2', 'stone without a pickaxe is refused with harvest-tool evidence (mining would drop nothing)', async (ev) => {
      const snap = await observe();
      await act('move_near', { target: { kind: 'handle', ...handleOf(snap, 'minecraft:stone', SCENE.stone[0]) }, within: 2 });
      const s2 = await observe();
      const o = await act('mine_block', { target: handleOf(s2, 'minecraft:stone', SCENE.stone[0]) });
      await expectStatus(o, 'precondition_failed', ev);
      assert(o.reason === 'harvest_tool_missing', `reason ${o.reason}`);
      assert(await blockIs(SCENE.stone[0].x, SCENE.stone[0].y, SCENE.stone[0].z, 'stone'), 'stone untouched');
      ev.push(`valid tools reported: ${JSON.stringify(o.evidence.validTools).slice(0, 160)}`);
    });

    // ---------------------------------------------------------------- crafting / workstation
    let tableAt: { x: number; y: number; z: number } | undefined;
    await check('CR1', 'general crafting: planks (shapeless 2x2), crafting table (shaped 2x2), placed via generated candidates, sticks, wooden pickaxe (3x3 at the table)', async (ev) => {
      await expectStatus(await act('craft_item', { output: 'minecraft:oak_planks', count: 12 }), 'succeeded', ev);
      await expectStatus(await act('craft_item', { output: 'minecraft:crafting_table', count: 1 }), 'succeeded', ev);
      const noTable = await candidates({
        objective: 'Make a wooden pickaxe.',
        decisionInstruction: 'Craft it.',
        allowedCapabilities: ['craft_item'],
        completion: { predicate: 'crafting_result', output: 'minecraft:wooden_pickaxe', atLeast: 1 },
      });
      ev.push(`before placing a table: ${JSON.stringify((noTable.unavailable as Json[]).map((u) => u.reason))}`);
      const set = await candidates({
        objective: 'Put a crafting table down nearby.',
        decisionInstruction: 'Choose a free visible spot.',
        allowedCapabilities: ['place_block'],
        parameters: { item: 'minecraft:crafting_table' },
        completion: { predicate: 'block_state', target: { kind: 'registry', key: 'minecraft:crafting_table' }, expect: 'minecraft:crafting_table' },
      });
      assert((set.candidates as Json[]).length > 0, 'placement candidates');
      // Operator choice among generated candidates: plain ground, so later mining targets stay free.
      const pick = ((set.candidates as Json[]).find((c) => /face of grass_block/.test(c.description)) ?? (set.candidates as Json[])[0]) as Json;
      ev.push(`chosen candidate: ${pick.description}`);
      chunkbot.send(`/diag run ${pick.id}`);
      const placed = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(placed, 'succeeded', ev);
      tableAt = placed.evidence.at as { x: number; y: number; z: number };
      assert(await blockIs(tableAt.x, tableAt.y, tableAt.z, 'crafting_table'), 'RCON confirms the placed table');
      await expectStatus(await act('craft_item', { output: 'minecraft:stick', count: 4 }), 'succeeded', ev);
      let snap = await observe();
      let table = handleOf(snap, 'minecraft:crafting_table', tableAt);
      let o = await act('craft_item', { output: 'minecraft:wooden_pickaxe', count: 1, workstation: table });
      if (o.reason === 'out_of_reach') {
        await act('move_near', { target: { kind: 'handle', ...table }, within: 2 });
        snap = await observe();
        table = handleOf(snap, 'minecraft:crafting_table', tableAt);
        o = await act('craft_item', { output: 'minecraft:wooden_pickaxe', count: 1, workstation: table });
      }
      await expectStatus(o, 'succeeded', ev);
      const inv = await serverInventory();
      ev.push(`RCON server inventory: ${JSON.stringify(inv)}`);
      assert(inv['minecraft:wooden_pickaxe'] === 1, 'server holds the pickaxe');
    });

    await check('M3', 'equip the pickaxe; mine two stone blocks (tool required, drops cobblestone) with the same mine_block capability; pick up', async (ev) => {
      await expectStatus(await act('equip_item', { item: 'minecraft:wooden_pickaxe', slot: 'hand' }), 'succeeded', ev);
      for (const p of SCENE.stone) {
        let snap = await observe();
        let o = await act('mine_block', { target: handleOf(snap, 'minecraft:stone', p) });
        if (o.reason === 'out_of_reach') {
          await act('move_near', { target: { kind: 'handle', ...handleOf(snap, 'minecraft:stone', p) }, within: 2 });
          snap = await observe();
          o = await act('mine_block', { target: handleOf(snap, 'minecraft:stone', p) });
        }
        await expectStatus(o, 'succeeded', ev);
        assert(o.evidence.tool === 'minecraft:wooden_pickaxe', 'pickaxe used');
        assert((o.evidence.serverDrops as Json[]).some((d) => d.key === 'minecraft:cobblestone'), 'server spawned cobblestone');
      }
      // Drops next to the bot are auto-collected by the server after vanilla's 10-tick pickup delay.
      await sleep(1_200);
      await pickupAll('minecraft:cobblestone', ev);
      if (((await serverInventory())['minecraft:cobblestone'] ?? 0) < 2) {
        // A drop can be out of sight (e.g. behind a block placed earlier); look where the blocks were, as an agent would.
        for (const p of SCENE.stone) {
          ev.push('a drop is not visible from here; approaching the mined position');
          await act('move_near', { target: { kind: 'destination', dimension: 'overworld', x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, within: 1 });
          await sleep(700);
          await pickupAll('minecraft:cobblestone', ev);
        }
      }
      const confirmed = await act('inspect_inventory', {});
      ev.push(`server-confirmed via skill: cobblestone=${confirmed.evidence.counts['minecraft:cobblestone'] ?? 0} stone=${confirmed.evidence.counts['minecraft:stone'] ?? 0}`);
      const inv = await serverInventory();
      ev.push(`RCON server inventory: ${JSON.stringify(inv)}`);
      assert(inv['minecraft:cobblestone'] === 2 && !inv['minecraft:stone'], 'server holds 2 cobblestone (not stone)');
    });

    // ---------------------------------------------------------------- predicates
    await check('PR1', 'predicates: admission baseline, consumption milestone latch, final possession, crafting result, unknown without evidence', async (ev) => {
      await rcon('give Chunkbot oak_planks 8'); // setup: planks for the sword and later fuel
      await sleep(500);
      chunkbot.send(`/diag bind sticks ${JSON.stringify({ predicate: 'inventory_delta', selector: 'minecraft:stick', atLeast: 4, mayBeConsumedLater: true })}`);
      const b = await chunkbot.json<Json>('bind');
      ev.push(`bound sticks baseline ${JSON.stringify(b.baselines)}`);
      chunkbot.send(`/diag bind sword ${JSON.stringify({ predicate: 'all', of: [{ predicate: 'crafting_result', output: 'minecraft:wooden_sword', atLeast: 1 }, { predicate: 'inventory_amount', selector: 'minecraft:wooden_sword', atLeast: 1, mode: 'possess' }] })}`);
      await chunkbot.json('bind');
      chunkbot.send(`/diag bind defeat ${JSON.stringify({ predicate: 'entity_outcome', target: { kind: 'registry', key: 'minecraft:pig' }, outcome: 'observed_defeated' })}`);
      await chunkbot.json('bind');
      chunkbot.send('/diag eval sticks');
      const e0 = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`sticks before crafting: ${e0.status} (${e0.detail})`);
      assert(e0.status === 'unsatisfied', 'not yet acquired');
      await expectStatus(await act('craft_item', { output: 'minecraft:stick', count: 4 }), 'succeeded', ev);
      chunkbot.send('/diag eval sticks');
      const e1 = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`sticks after crafting 4: ${e1.status} (${e1.detail})`);
      assert(e1.status === 'satisfied', 'milestone reached');
      let snap = await observe();
      let table = handleOf(snap, 'minecraft:crafting_table', tableAt);
      let o = await act('craft_item', { output: 'minecraft:wooden_sword', count: 1, workstation: table });
      if (o.reason === 'out_of_reach') {
        await act('move_near', { target: { kind: 'handle', ...table }, within: 2 });
        snap = await observe();
        table = handleOf(snap, 'minecraft:crafting_table', tableAt);
        o = await act('craft_item', { output: 'minecraft:wooden_sword', count: 1, workstation: table });
      }
      await expectStatus(o, 'succeeded', ev);
      chunkbot.send('/diag eval sticks');
      const e2 = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`sticks after the sword consumed one: ${e2.status} (${e2.detail})`);
      assert(e2.status === 'satisfied', 'consumption milestone stays satisfied');
      chunkbot.send('/diag eval sword');
      const e3 = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`sword crafted+possessed: ${e3.status} (${e3.detail})`);
      assert(e3.status === 'satisfied', 'sword outcome satisfied');
      chunkbot.send('/diag eval defeat');
      const e4 = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`pig defeat with no evidence: ${e4.status} (${e4.detail})`);
      assert(e4.status !== 'satisfied', 'no defeat claim without evidence');
    });

    // ---------------------------------------------------------------- furnace
    let furnaceAt: { x: number; y: number; z: number } | undefined;
    await check('F1', 'furnace: craft (8 cobblestone ring at the table), place, load input+fuel, wait (no inference), collect smelted stone; server-confirmed', async (ev) => {
      await rcon('give Chunkbot cobblestone 8'); // setup: 8 more cobblestone (2 were mined in M3)
      await sleep(600);
      let snap = await observe();
      let table = handleOf(snap, 'minecraft:crafting_table', tableAt);
      let o = await act('craft_item', { output: 'minecraft:furnace', count: 1, workstation: table });
      if (o.reason === 'out_of_reach') {
        await act('move_near', { target: { kind: 'handle', ...table }, within: 2 });
        snap = await observe();
        table = handleOf(snap, 'minecraft:crafting_table', tableAt);
        o = await act('craft_item', { output: 'minecraft:furnace', count: 1, workstation: table });
      }
      await expectStatus(o, 'succeeded', ev);
      const set = await candidates({
        objective: 'Put the furnace down.',
        decisionInstruction: 'Any free visible spot.',
        allowedCapabilities: ['place_block'],
        parameters: { item: 'minecraft:furnace' },
        completion: { predicate: 'block_state', target: { kind: 'registry', key: 'minecraft:furnace' }, expect: 'minecraft:furnace' },
      });
      const furnacePick = ((set.candidates as Json[]).find((c) => /face of grass_block/.test(c.description)) ?? (set.candidates as Json[])[0]) as Json;
      ev.push(`chosen candidate: ${furnacePick.description}`);
      chunkbot.send(`/diag run ${furnacePick.id}`);
      const placed = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(placed, 'succeeded', ev);
      furnaceAt = placed.evidence.at as { x: number; y: number; z: number };
      chunkbot.send(`/diag bind smelt ${JSON.stringify({ predicate: 'smelting_result', output: 'minecraft:stone', atLeast: 2 })}`);
      await chunkbot.json('bind');
      snap = await observe();
      const furnace = handleOf(snap, 'minecraft:furnace', furnaceAt);
      await expectStatus(await act('furnace_insert', { furnace, slot: 'input', item: 'minecraft:cobblestone', count: 2 }), 'succeeded', ev);
      const notFuel = await act('furnace_insert', { furnace, slot: 'fuel', item: 'minecraft:cobblestone', count: 1 });
      await expectStatus(notFuel, 'precondition_failed', ev);
      await expectStatus(await act('furnace_insert', { furnace, slot: 'fuel', item: 'minecraft:oak_planks', count: 2 }), 'succeeded', ev);
      const waited = await act('furnace_wait', { furnace, untilOutputAtLeast: 2, maxWaitMs: 60_000 }, 90_000);
      await expectStatus(waited, 'succeeded', ev);
      const taken = await act('furnace_take', { furnace, slot: 'output' });
      await expectStatus(taken, 'succeeded', ev);
      chunkbot.send('/diag eval smelt');
      const e = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`smelting_result predicate: ${e.status} (${e.detail})`);
      assert(e.status === 'satisfied', 'smelting result satisfied');
      const inv = await serverInventory();
      ev.push(`RCON server inventory: stone=${inv['minecraft:stone'] ?? 0} cobblestone=${inv['minecraft:cobblestone'] ?? 0}`);
      assert((inv['minecraft:stone'] ?? 0) >= 2, 'server holds smelted stone items');
    });

    // ---------------------------------------------------------------- containers / transfer / drop
    owner = await fixtureBot('FixtureOwner');
    await rcon('clear FixtureOwner'); // setup: the owner's saved inventory from earlier runs (recorded)
    await check('T1', 'chest: deposit, inspect, withdraw through the visible container (server-confirmed); container_state predicate', async (ev) => {
      let snap = await observe();
      let chest = handleOf(snap, 'minecraft:chest', SCENE.chest);
      let o = await act('container_transfer', { container: chest, direction: 'deposit', item: 'minecraft:stone', count: 2 });
      if (o.reason === 'out_of_reach') {
        await act('move_near', { target: { kind: 'handle', ...chest }, within: 2 });
        snap = await observe();
        chest = handleOf(snap, 'minecraft:chest', SCENE.chest);
        o = await act('container_transfer', { container: chest, direction: 'deposit', item: 'minecraft:stone', count: 2 });
      }
      await expectStatus(o, 'succeeded', ev);
      chunkbot.send(`/diag bind chest ${JSON.stringify({ predicate: 'container_state', target: { kind: 'observed', ...chest }, selector: 'minecraft:stone', atLeast: 2 })}`);
      await chunkbot.json('bind');
      await expectStatus(await act('inspect_container', { container: chest }), 'succeeded', ev);
      chunkbot.send('/diag eval chest');
      const e = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`container_state: ${e.status} (${e.detail})`);
      assert(e.status === 'satisfied', 'chest holds 2 stone');
      await expectStatus(await act('container_transfer', { container: chest, direction: 'withdraw', item: 'minecraft:stone', count: 1 }), 'succeeded', ev);
      const inv = await serverInventory();
      ev.push(`RCON server inventory stone=${inv['minecraft:stone'] ?? 0}`);
      assert(inv['minecraft:stone'] === 1, 'one stone back in the inventory');
      // Freshness boundary: an outcome bound AFTER the last read is not proven by it.
      await sleep(300);
      chunkbot.send(`/diag bind chestLater ${JSON.stringify({ predicate: 'container_state', target: { kind: 'observed', ...chest }, selector: 'minecraft:stone', atLeast: 1 })}`);
      await chunkbot.json('bind');
      chunkbot.send('/diag eval chestLater');
      const stale = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`container_state bound after the last read, no new inspection: ${stale.status} (${stale.detail})`);
      assert(stale.status === 'unknown' && stale.evidence.historical === true, 'an earlier closed-chest view is historical, not current');
      await expectStatus(await act('inspect_container', { container: chest }), 'succeeded', ev);
      chunkbot.send('/diag eval chestLater');
      const fresh = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`after a fresh inspection: ${fresh.status} (${fresh.detail})`);
      assert(fresh.status === 'satisfied' && fresh.evidence.fresh === true, 'fresh server-synced inspection proves current contents');
    });

    await check('T2', 'drop next to the owner: server spawn evidence; receipt claimed only from a collect packet naming the owner', async (ev) => {
      assert(owner, 'owner bot');
      const p = await serverPos();
      // Setup: face south (+z) and stand the owner 1.6 blocks in front, where a thrown item lands.
      await rcon(`tp Chunkbot ${p.x.toFixed(2)} ${p.y} ${p.z.toFixed(2)} 0 30`);
      await rcon(`tp FixtureOwner ${p.x.toFixed(2)} ${p.y} ${(p.z + 1.6).toFixed(2)} 180 0`);
      await sleep(900);
      const snap = await observe();
      assert(snap.owner.visible, 'owner visible');
      const ownerBefore = (await serverInventory('FixtureOwner'))['minecraft:stone'] ?? 0;
      const o = await act('drop_item', { item: 'minecraft:stone', count: 1 });
      await expectStatus(o, ['succeeded'], ev);
      ev.push(`evidence: dropped=${o.evidence.droppedConfirmed} spawned=${o.evidence.spawnedEntities} ownerCollected=${o.evidence.ownerCollected}`);
      const ownerInv = await serverInventory('FixtureOwner');
      const ownerGained = (ownerInv['minecraft:stone'] ?? 0) - ownerBefore;
      ev.push(`RCON FixtureOwner stone ${ownerBefore} -> ${ownerInv['minecraft:stone'] ?? 0} (gained ${ownerGained})`);
      if (o.evidence.ownerCollected > 0) assert(ownerGained === o.evidence.ownerCollected, 'collect claim matches the server-side gain');
      else ev.push('owner did not pick it up in the watch window; skill made no receipt claim (honest)');
    });

    // ---------------------------------------------------------------- entities
    await check('E1', 'entities: bucket on cow -> milk (inventory), shears on sheep -> wool drops + metadata, sword on chicken -> damage + server death status', async (ev) => {
      await rcon('give Chunkbot bucket 1');
      await rcon('give Chunkbot shears 1');
      await sleep(600);
      const near = async (key: string) => {
        let snap = await observe();
        const ent = (snap.entities as Json[]).find((e) => e.key === key);
        assert(ent, `${key} visible`);
        if (!ent.inReach) {
          await expectStatus(await act('move_near', { target: { kind: 'handle', snapshotId: snap.id, handle: ent.handle }, within: 2 }), 'succeeded', ev);
          snap = await observe();
        }
        return handleOf(snap, key, undefined, 'entities');
      };
      const cow = await near('minecraft:cow');
      const milk = await act('interact_entity', { target: cow, withItem: 'minecraft:bucket' });
      await expectStatus(milk, 'succeeded', ev);
      assert(milk.evidence.inventoryChange['minecraft:milk_bucket'] === 1, 'milk bucket gained');
      const sheep = await near('minecraft:sheep');
      const shear = await act('interact_entity', { target: sheep, withItem: 'minecraft:shears' });
      await expectStatus(shear, 'succeeded', ev);
      ev.push(`shearing evidence: drops ${JSON.stringify(shear.evidence.droppedNearEntity)} metadata ${JSON.stringify(shear.evidence.metadataChanges)}`);
      const sword = await act('equip_item', { item: 'minecraft:wooden_sword', slot: 'hand' });
      await expectStatus(sword, 'succeeded', ev);
      const chicken = await near('minecraft:chicken');
      chunkbot.send(`/diag bind chicken ${JSON.stringify({ predicate: 'entity_outcome', target: { kind: 'observed', ...chicken }, outcome: 'observed_defeated' })}`);
      await chunkbot.json('bind');
      const hit = await act('attack_entity', { target: chicken, maxHits: 4 });
      await expectStatus(hit, 'succeeded', ev);
      assert(hit.evidence.defeatedByServerStatus === true && hit.evidence.damageConfirmed >= 1, 'server damage + death status');
      chunkbot.send('/diag eval chicken');
      const e = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`entity_outcome observed_defeated: ${e.status} (${e.detail})`);
      assert(e.status === 'satisfied', 'defeat predicate satisfied from server status');
      // An entity that merely leaves is not defeated.
      const snap = await observe();
      const pig = handleOf(snap, 'minecraft:pig', undefined, 'entities');
      chunkbot.send(`/diag bind pig ${JSON.stringify({ predicate: 'entity_outcome', target: { kind: 'observed', ...pig }, outcome: 'observed_defeated' })}`);
      await chunkbot.json('bind');
      await rcon('tp @e[type=pig,tag=chunkbot_front] 205 -60 400');
      await sleep(1_200);
      chunkbot.send('/diag eval pig');
      const e2 = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`pig teleported out of view (setup): ${e2.status} (${e2.detail})`);
      assert(e2.status !== 'satisfied', 'vanishing is not defeat');
    });

    await check('PL1', 'placing against an interactable block (furnace) sneaks instead of opening it; generated candidates avoid interactable faces', async (ev) => {
      await pickupAll('minecraft:white_wool', ev); // the sheared wool, unless the server already auto-collected it
      const have = (await serverInventory())['minecraft:white_wool'] ?? 0;
      if (have < 2) {
        await rcon(`give Chunkbot white_wool ${2 - have}`);
        ev.push(`setup: topped up white_wool to 2 (had ${have}; recorded)`);
        await sleep(400);
      }
      assert(furnaceAt, 'furnace placed in F1');
      // Stand 2.5 blocks east so a side or top face is visible with a free destination. (3.5 east plus
      // move_near's 1.25 arrival tolerance put the furnace 4.3 from the eye in one run: beyond the
      // 4.2 placement reach, a correct refusal; the staging point was the defect.)
      await expectStatus(await act('move_near', { target: { kind: 'destination', dimension: 'overworld', x: furnaceAt.x + 2.5, y: -60, z: furnaceAt.z + 0.5 }, within: 1 }), 'succeeded', ev);
      const staged = await serverPos();
      const ownerNow = await serverPos('FixtureOwner');
      ev.push(`staged: Chunkbot ${staged.x.toFixed(2)},${staged.z.toFixed(2)} (furnace ${furnaceAt.x},${furnaceAt.y},${furnaceAt.z}); owner ${ownerNow.x.toFixed(2)},${ownerNow.z.toFixed(2)}`);
      const generic = await candidates({
        objective: 'Place something.',
        decisionInstruction: 'Any free spot.',
        allowedCapabilities: ['place_block'],
        parameters: { item: 'minecraft:white_wool' },
        completion: { predicate: 'block_state', target: { kind: 'registry', key: 'minecraft:white_wool' }, expect: 'minecraft:white_wool' },
      });
      const usesInteractable = (generic.candidates as Json[]).filter((c) => /face of (crafting_table|furnace|chest)/.test(c.description));
      ev.push(`${(generic.candidates as Json[]).length} generic placement candidates, ${usesInteractable.length} against interactable blocks`);
      assert((generic.candidates as Json[]).length > 0 && usesInteractable.length === 0, 'generic candidates exist and avoid interactable reference faces');
      const snap = await observe();
      const furnace = handleOf(snap, 'minecraft:furnace', furnaceAt);
      const named = await candidates({
        objective: 'Put wool against the furnace.',
        decisionInstruction: 'Pick a visible free face of the named block.',
        allowedCapabilities: ['place_block'],
        targetSelectors: [{ kind: 'observed', ...furnace }],
        parameters: { item: 'minecraft:white_wool' },
        completion: { predicate: 'block_state', target: { kind: 'registry', key: 'minecraft:white_wool' }, expect: 'minecraft:white_wool' },
      });
      const pick = (named.candidates as Json[])[0];
      ev.push(`named-furnace candidates: ${(named.candidates as Json[]).length}; unavailable ${JSON.stringify(named.unavailable).slice(0, 300)}`);
      assert(pick, `placement candidates against the named furnace: ${JSON.stringify(named.unavailable)}`);
      ev.push(`candidate: ${pick.description}`);
      assert(/face of furnace/.test(pick.description), 'candidate is against the named furnace');
      chunkbot.send(`/diag run ${pick.id}`);
      const o = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(o, 'succeeded', ev);
      const at = o.evidence.at as { x: number; y: number; z: number };
      assert(await blockIs(at.x, at.y, at.z, 'white_wool'), 'RCON: wool placed against the furnace');
      assert(await blockIs(furnaceAt.x, furnaceAt.y, furnaceAt.z, 'furnace'), 'furnace unchanged');
    });

    // ---------------------------------------------------------------- owner approach / follow / explore
    await check('N1', 'movement: approach visible owner; follow the moving owner; explore a visible frontier inside travel bounds; server position agrees', async (ev) => {
      assert(owner, 'owner bot');
      const p = await serverPos();
      await rcon(`tp FixtureOwner ${p.x + 6} ${p.y} ${p.z + 2} 0 0`); // facing south (+z): an open lane east of the wall
      await sleep(800);
      await expectStatus(await act('move_near', { target: { kind: 'owner' }, within: 2 }), 'succeeded', ev);
      const sp = await serverPos();
      const op = await serverPos('FixtureOwner');
      ev.push(`server: Chunkbot ${sp.x.toFixed(1)},${sp.z.toFixed(1)} owner ${op.x.toFixed(1)},${op.z.toFixed(1)} distance ${dist(sp, op).toFixed(2)}`);
      assert(dist(sp, op) <= 2.6, 'server-side distance within range');
      // Owner walks in the open; Chunkbot follows for 6 s. Positive: Chunkbot actually moves and ends near.
      const startFollow = await serverPos();
      const follow = act('follow_entity', { target: { kind: 'owner' }, within: 3, durationMs: 6_000 }, 20_000);
      await sleep(300);
      owner.setControlState('forward', true);
      await sleep(2_500);
      owner.setControlState('forward', false);
      const f = await follow;
      await expectStatus(f, 'succeeded', ev);
      const endChunkbot = await serverPos();
      const endOwner = await serverPos('FixtureOwner');
      ev.push(`follow nearFraction=${f.evidence.nearFraction} finalDistance=${f.evidence.finalDistance} visibleSamples=${f.evidence.visibleSamples}/${f.evidence.samples}`);
      ev.push(`server (serialized, attributed): Chunkbot moved ${dist(startFollow, endChunkbot).toFixed(2)} blocks; Chunkbot ${endChunkbot.x.toFixed(1)},${endChunkbot.z.toFixed(1)} owner ${endOwner.x.toFixed(1)},${endOwner.z.toFixed(1)} distance ${dist(endChunkbot, endOwner).toFixed(2)}`);
      assert(dist(startFollow, endChunkbot) >= 3, 'Chunkbot actually moved with the owner');
      assert(dist(endChunkbot, endOwner) <= 4.5, 'server distance at the end is within the follow range');
      assert(dist(endChunkbot, endOwner) > 0.1, 'distinct server positions (query attribution)');
      await rcon(`tp FixtureOwner ${SCENE.start.x - 6} -60 ${SCENE.start.z - 10}`);
      const snap = await observe();
      const frontier = (snap.frontiers as Json[])[0];
      assert(frontier, `frontiers available (${(snap.frontiers as Json[]).length})`);
      chunkbot.send(`/diag bind visit ${JSON.stringify({ predicate: 'visited_location', target: { kind: 'observed', snapshotId: snap.id, handle: frontier.handle }, within: 3 })}`);
      await chunkbot.json('bind');
      const ex = await act('explore_frontier', { frontier: { snapshotId: snap.id, handle: frontier.handle } });
      await expectStatus(ex, 'succeeded', ev);
      chunkbot.send('/diag eval visit');
      const e = (await chunkbot.json<Json>('eval')).evaluation as Json;
      ev.push(`visited_location: ${e.status} (${e.detail}); frontier ${frontier.direction} ${frontier.distance}`);
      assert(e.status === 'satisfied', 'visit recorded');
    });

    await check('FL1', 'follow never tracks a wall-occluded owner: after the owner moves behind the wall no goal uses its hidden position; finalDistance withheld; server confirms Chunkbot stayed on this side', async (ev) => {
      assert(owner, 'owner bot');
      // Setup (recorded): close the wall's glass window for this scene, so the wall is a full occluder.
      // (A previous run showed the owner legitimately VISIBLE through that window from some standing points.)
      await rcon(`setblock ${SCENE.glass.x} ${SCENE.glass.y} ${SCENE.glass.z} stone_bricks`);
      let f: Json;
      try {
        await rcon(`tp Chunkbot 205.5 -60 209.5 0 0`);
        await rcon(`tp FixtureOwner 209.5 -60 210.5 90 0`); // visible, east of the wall end
        await sleep(900);
        const snap = await observe();
        assert(snap.owner.visible, 'owner visible before occlusion');
        const follow = act('follow_entity', { target: { kind: 'owner' }, within: 2, durationMs: 9_000 }, 25_000);
        await sleep(800);
        // Setup (recorded): the owner steps behind the solid wall, then keeps walking west behind it.
        await rcon(`tp FixtureOwner 206.5 -60 214.5 90 0`);
        await sleep(300);
        const hiddenAt = await serverPos();
        const check = await observe();
        ev.push(`scene precondition after the hidden teleport: Chunkbot at ${hiddenAt.x.toFixed(1)},${hiddenAt.z.toFixed(1)}; owner visible=${check.owner.visible}`);
        assert(!check.owner.visible, 'scene precondition: the owner is occluded after the teleport');
        owner.setControlState('forward', true);
        await sleep(1_500);
        owner.setControlState('forward', false);
        f = await follow;
      } finally {
        await rcon(`setblock ${SCENE.glass.x} ${SCENE.glass.y} ${SCENE.glass.z} glass`);
      }
      await expectStatus(f, ['failed', 'partial'], ev);
      const b = await serverPos();
      const o = await serverPos('FixtureOwner');
      ev.push(`follow reason=${f.reason} finalDistance=${JSON.stringify(f.evidence.finalDistance)} lastObservedTarget=${JSON.stringify(f.evidence.lastObservedTarget)} lastObservedAgeMs=${f.evidence.lastObservedAgeMs}`);
      ev.push(`server: Chunkbot ${b.x.toFixed(1)},${b.z.toFixed(1)} owner ${o.x.toFixed(1)},${o.z.toFixed(1)} (behind the wall at z=212)`);
      assert(f.evidence.finalDistance === null || f.evidence.finalDistance === undefined, 'no hidden final distance reported');
      assert(b.z < 212, 'Chunkbot did not path around the wall toward the hidden owner');
      assert(f.reason === 'target_lost' || f.reason === 'target_not_visible_at_end', `reason ${f.reason}`);
    });

    await check('N2', 'navigation never digs or places: unreachable pillar top -> no_safe_path; scene blocks intact', async (ev) => {
      await rcon(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
      await rcon('fill 214 -60 214 214 -57 214 stone_bricks');
      await sleep(900);
      const pillarTop = { kind: 'destination', dimension: 'overworld', x: 214.5, y: -56, z: 214.5 };
      const o = await act('move_near', { target: pillarTop, within: 1 }, 60_000);
      await expectStatus(o, 'failed', ev);
      assert(['no_safe_path', 'stuck', 'timeout'].includes(o.reason), `reason ${o.reason}`);
      assert(await blockIs(214, -57, 214, 'stone_bricks'), 'pillar intact');
      const wallIntact = await blockIs(205, -59, 212, 'stone_bricks');
      const inv = await serverInventory();
      ev.push(`pillar intact, wall intact=${wallIntact}; inventory unchanged by navigation: ${JSON.stringify(inv).slice(0, 200)}`);
      assert(wallIntact, 'wall intact');
    });

    // ---------------------------------------------------------------- cancellation
    await check('X1', `stop during navigation clears controls <= ${STOP_TARGET_MS}ms; bot stops (server position); replacement action is not cleared by old cleanup`, async (ev) => {
      await rcon(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`);
      await sleep(700);
      chunkbot.mark();
      chunkbot.send(`/diag do move_near ${JSON.stringify({ target: { kind: 'destination', dimension: 'overworld', x: 205.5, y: -60, z: 190.5 }, within: 1 })}`);
      await chunkbot.waitFor(/\[diag\] running move_near/);
      await sleep(1_000);
      const before = await serverPos();
      await stopAndMeasure(ev);
      const o = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(o, 'cancelled', ev);
      const a = await serverPos();
      await sleep(700);
      const b = await serverPos();
      ev.push(`server position at stop ${before.z.toFixed(2)} -> +0.1s ${a.z.toFixed(2)} -> +0.8s ${b.z.toFixed(2)} (moved ${dist(a, b).toFixed(2)} after stop)`);
      assert(dist(a, b) < 0.4, 'no continued walking after stop');
      assert(o.evidence.commandsAfterRevoke === 0, 'no commands after revocation');
      // Replacement immediately after: old cleanup must not clear the new lease's movement.
      const r = await act('move_near', { target: { kind: 'destination', dimension: 'overworld', x: 205.5, y: -60, z: 196.5 }, within: 1 });
      await expectStatus(r, 'succeeded', ev);
      const c = await serverPos();
      ev.push(`replacement move arrived: server z=${c.z.toFixed(2)}`);
    });

    await check('X2', 'stop during mining (obsidian by hand, ~250s dig) cancels the dig; block unchanged', async (ev) => {
      await act('equip_item', { item: 'minecraft:stick', slot: 'hand' });
      let snap = await observe();
      await act('move_near', { target: { kind: 'handle', ...handleOf(snap, 'minecraft:obsidian', SCENE.obsidian) }, within: 2 });
      snap = await observe();
      chunkbot.mark();
      chunkbot.send(`/diag do mine_block ${JSON.stringify({ target: handleOf(snap, 'minecraft:obsidian', SCENE.obsidian), allowNoDrop: true })}`);
      await chunkbot.waitFor(/\[diag\] running mine_block/);
      await sleep(1_500);
      const stopped = await stopAndMeasure(ev);
      const o = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(o, 'cancelled', ev);
      assert((stopped.steps as string[]).includes('dig_stopped'), 'dig cancel sent');
      await sleep(1_000);
      assert(await blockIs(SCENE.obsidian.x, SCENE.obsidian.y, SCENE.obsidian.z, 'obsidian'), 'obsidian still present (server)');
      ev.push('server: obsidian unchanged after cancellation');
    });

    await check('X3', 'stop during crafting: fenced clicks stop, interface closed, partial crafts reported and match server inventory', async (ev) => {
      await rcon('clear Chunkbot oak_planks');
      await rcon('clear Chunkbot stick');
      await rcon('give Chunkbot oak_planks 40');
      await sleep(600);
      const before = await serverInventory();
      chunkbot.mark();
      chunkbot.send(`/diag do craft_item ${JSON.stringify({ output: 'minecraft:stick', count: 80 })}`);
      await chunkbot.waitFor(/\[diag\] running craft_item/);
      await sleep(1_300);
      await stopAndMeasure(ev);
      const o = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(o, 'cancelled', ev);
      assert(o.evidence.commandsAfterRevoke === 0, 'no clicks after revocation');
      await sleep(800);
      const after = await serverInventory();
      // Craft counts are client-model progress: reported under localProgress (not server-confirmed) and checked against RCON here.
      const crafts = Number((o.evidence.localProgress as Json | undefined)?.craftsCompleted ?? 0);
      assert(o.confirmation === 'none', 'local craft counts never make the cancelled outcome server-confirmed');
      ev.push(`reported craftsCompleted=${crafts}; server sticks ${before['minecraft:stick'] ?? 0}->${after['minecraft:stick'] ?? 0}, planks ${before['minecraft:oak_planks']}->${after['minecraft:oak_planks']}`);
      const sticks = (after['minecraft:stick'] ?? 0) - (before['minecraft:stick'] ?? 0);
      const planksUsed = (before['minecraft:oak_planks'] ?? 0) - (after['minecraft:oak_planks'] ?? 0);
      assert(crafts > 0 && crafts < 20, 'partial');
      assert(sticks === planksUsed * 2, 'no ingredients lost in the grid or cursor (interface closed returns them)');
      assert(sticks >= crafts * 4 && sticks <= (crafts + 1) * 4, 'reported crafts match server sticks (at most one in flight)');
      const pe = o.evidence.partialEffects as Json;
      ev.push(`partialEffects: ${JSON.stringify(pe)}`);
      assert(pe.confirmed === 'none' && pe.additional === 'unknown', 'local craft clicks: no confirmed partial effect; additional effects unknown');
    });

    await check('X4', 'stop during interface use (chest, one fenced click per item) closes the container; items moved so far stay moved', async (ev) => {
      await rcon('give Chunkbot cobblestone 30');
      await sleep(500);
      let { snap, chest } = await stageVisibleChest(ev, 'X4');
      await act('move_near', { target: { kind: 'handle', ...chest }, within: 2 });
      snap = await observe();
      chest = handleOf(snap, 'minecraft:chest', SCENE.chest);
      chunkbot.mark();
      // 30 is less than the stack size of 64 only if the stack is larger; make count < stack to force single-item clicks.
      chunkbot.send(`/diag do container_transfer ${JSON.stringify({ container: chest, direction: 'deposit', item: 'minecraft:cobblestone', count: 25 })}`);
      await chunkbot.waitFor(/\[diag\] running container_transfer/);
      await sleep(700);
      await stopAndMeasure(ev);
      const o = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(o, ['cancelled', 'succeeded'], ev);
      assert(o.evidence.commandsAfterRevoke === 0 || o.status === 'succeeded', 'no clicks after revocation');
      await sleep(500);
      // Interface closed: the next interface action works without an "interface_open" refusal.
      snap = await observe();
      const look = await act('inspect_container', { container: handleOf(snap, 'minecraft:chest', SCENE.chest) });
      await expectStatus(look, 'succeeded', ev);
      ev.push(`chest after cancel: ${JSON.stringify(look.evidence.contents)}`);
    });

    await check('I1', `stop right after the open-interface use packet (before/around the server reply): late window attributed and closed; control clear <= ${STOP_TARGET_MS}ms; next interface works`, async (ev) => {
      let { snap, chest } = await stageVisibleChest(ev, 'I1');
      await act('move_near', { target: { kind: 'handle', ...chest }, within: 2 });
      let hitBeforeReply = 0;
      for (const delay of [0, 5, 10, 20, 35, 50]) {
        snap = await observe();
        chest = handleOf(snap, 'minecraft:chest', SCENE.chest);
        chunkbot.mark();
        const from = chunkbot.length;
        chunkbot.send(`/diag do inspect_container ${JSON.stringify({ container: chest })}`);
        await chunkbot.waitSince(/\[diag\] running inspect_container/, from);
        if (delay) await sleep(delay);
        const { outcome: o, stopped } = await stopRace(ev, from);
        const trace = (o.evidence.commandTrace as string[] | undefined) ?? [];
        const usedBeforeRevoke = trace.some((t) => /block_place/.test(t));
        const iface = o.evidence.interfaceAfterSettle as Json | undefined;
        ev.push(`delay ${delay}ms: ${o.status} clearMs=${stopped?.clearMs ?? 'n/a'} usePacketSent=${usedBeforeRevoke} windowAfterSettle=${JSON.stringify(iface?.currentWindow)} pending=${JSON.stringify(iface?.pendingRequests)} log=${JSON.stringify(iface?.log ?? []).slice(0, 260)}`);
        if (o.status === 'cancelled') {
          assert(o.evidence.commandsAfterRevoke === 0, 'no commands after revocation');
          assert(iface && iface.currentWindow === null, 'no interface left open after the settle');
          if (usedBeforeRevoke) hitBeforeReply += 1;
        }
        await sleep(300);
        snap = await observe();
        const next = await act('inspect_container', { container: handleOf(snap, 'minecraft:chest', SCENE.chest) });
        assert(next.status === 'succeeded', `next interface action after the stop: ${next.status} ${next.reason ?? ''}`);
      }
      ev.push(`${hitBeforeReply} stop(s) landed after the use packet was written (the late-reply path)`);
      assert(hitBeforeReply >= 1, 'at least one stop landed between the use packet and completion');
    });

    await check('PL2', 'placement: ordinary support (no sneak) server-confirmed; destination occupied by the owner refused before any packet; stop during an interactive-support placement leaves no interface and the support intact', async (ev) => {
      assert(owner, 'owner bot');
      await rcon('give Chunkbot cobblestone 3');
      await rcon(`tp Chunkbot ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 30`);
      await sleep(900);
      // Ordinary support: two generated candidates on the up face of ground blocks (free voxels per the resolver).
      const place = (extra: Json = {}) =>
        candidates({
          objective: 'Place cobblestone.',
          decisionInstruction: 'Any free spot.',
          allowedCapabilities: ['place_block'],
          parameters: { item: 'minecraft:cobblestone', face: 'up' },
          completion: { predicate: 'block_state', target: { kind: 'registry', key: 'minecraft:cobblestone' }, expect: 'minecraft:cobblestone' },
          ...extra,
        });
      const destOf = (c: Json) => {
        const m = /-> (-?\d+),(-?\d+),(-?\d+)\)/.exec(c.description as string);
        assert(m, `destination in ${c.description}`);
        return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
      };
      const set0 = await place();
      const ground = (set0.candidates as Json[]).filter((c) => /up face of grass_block/.test(c.description));
      assert(ground.length >= 2, `two ground candidates: ${JSON.stringify(set0.unavailable)}`);
      const [c1, c2] = ground as [Json, Json];
      const d1 = destOf(c1);
      const d2 = destOf(c2);
      chunkbot.send(`/diag run ${c1.id}`);
      const plain = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(plain, 'succeeded', ev);
      assert(await blockIs(d1.x, d1.y, d1.z, 'cobblestone'), 'RCON: cobblestone placed');
      ev.push(`ordinary support -> ${d1.x},${d1.y},${d1.z}: server block change + RCON agree; itemUsed=${plain.evidence.itemUsed}`);
      // Occupied destination: the owner stands on the second candidate's voxel (setup teleport, recorded).
      await rcon(`tp FixtureOwner ${d2.x + 0.5} ${d2.y} ${d2.z + 0.5} 0 0`);
      await sleep(900);
      const occupied = await act('place_block', c2.parameters);
      await expectStatus(occupied, 'precondition_failed', ev);
      assert(occupied.reason === 'destination_occupied_by_entity', `reason ${occupied.reason}`);
      assert(await blockIs(d2.x, d2.y, d2.z, 'air'), 'RCON: nothing placed into the owner');
      const g2 = { at: { x: d2.x, y: d2.y - 1, z: d2.z } };
      const set = await place();
      const intoOwner = (set.candidates as Json[]).filter((c) => c.description.includes(`-> ${g2.at.x},${g2.at.y + 1},${g2.at.z})`));
      ev.push(`${(set.candidates as Json[]).length} generated placement candidates; ${intoOwner.length} into the owner-occupied voxel`);
      assert(intoOwner.length === 0, 'generated candidates exclude the occupied voxel');
      await rcon(`tp FixtureOwner ${SCENE.start.x - 6} -60 ${SCENE.start.z - 10}`);
      // Stop during an interactive-support placement (furnace top face, sneak held until the reply).
      assert(furnaceAt, 'furnace from F1');
      await act('move_near', { target: { kind: 'destination', dimension: 'overworld', x: furnaceAt.x + 2.5, y: -60, z: furnaceAt.z + 0.5 }, within: 1 });
      let snap = await observe();
      const furnace = handleOf(snap, 'minecraft:furnace', furnaceAt);
      const named = await candidates({
        objective: 'Put cobblestone against the furnace.',
        decisionInstruction: 'A visible free face of the named block.',
        allowedCapabilities: ['place_block'],
        targetSelectors: [{ kind: 'observed', ...furnace }],
        parameters: { item: 'minecraft:cobblestone' },
        completion: { predicate: 'block_state', target: { kind: 'registry', key: 'minecraft:cobblestone' }, expect: 'minecraft:cobblestone' },
      });
      const pick = (named.candidates as Json[])[0];
      assert(pick, `a candidate against the furnace: ${JSON.stringify(named.unavailable)}`);
      ev.push(`interactive-support candidate: ${pick.description}`);
      chunkbot.mark();
      const from = chunkbot.length;
      chunkbot.send(`/diag run ${pick.id}`);
      await chunkbot.waitSince(/\[diag\] running place_block/, from);
      await sleep(60);
      const { outcome: o } = await stopRace(ev, from);
      await expectStatus(o, ['cancelled', 'succeeded'], ev);
      ev.push(`trace: ${JSON.stringify(o.evidence.commandTrace ?? []).slice(0, 300)}`);
      if (o.status === 'cancelled') {
        assert(o.evidence.commandsAfterRevoke === 0, 'no packets after revocation');
        assert((o.evidence.interfaceAfterSettle as Json).currentWindow === null, 'furnace not left open');
      }
      assert(await blockIs(furnaceAt.x, furnaceAt.y, furnaceAt.z, 'furnace'), 'support intact');
      await sleep(300);
      snap = await observe();
      const look = await act('furnace_take', { furnace: handleOf(snap, 'minecraft:furnace', furnaceAt), slot: 'output' });
      ev.push(`next interface action: ${outcomeLine(look)}`);
      assert(look.reason !== 'interface_open' && look.reason !== 'interface_reply_pending', 'no interface leaked by the stopped placement');
    });

    await check('X5', 'stop during furnace processing wait closes the interface; the furnace keeps cooking in the world (reported, not rolled back)', async (ev) => {
      let snap = await observe();
      let furnace = handleOf(snap, 'minecraft:furnace', furnaceAt);
      await act('move_near', { target: { kind: 'handle', ...furnace }, within: 2 });
      snap = await observe();
      furnace = handleOf(snap, 'minecraft:furnace', furnaceAt);
      await expectStatus(await act('furnace_insert', { furnace, slot: 'input', item: 'minecraft:cobblestone', count: 3 }), 'succeeded', ev);
      await expectStatus(await act('furnace_insert', { furnace, slot: 'fuel', item: 'minecraft:oak_planks', count: 3 }), 'succeeded', ev);
      chunkbot.mark();
      chunkbot.send(`/diag do furnace_wait ${JSON.stringify({ furnace, untilOutputAtLeast: 3, maxWaitMs: 120_000 })}`);
      await chunkbot.waitFor(/\[diag\] running furnace_wait/);
      await sleep(2_000);
      await stopAndMeasure(ev);
      const o = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(o, 'cancelled', ev);
      ev.push(`last observed furnace contents at cancel: ${JSON.stringify(o.evidence.furnace)}; partialEffects ${JSON.stringify(o.evidence.partialEffects)}`);
      assert((o.evidence.partialEffects as Json).confirmed === 'server_packet', 'server-stated furnace state is a confirmed prior effect');
      await sleep(12_000);
      snap = await observe();
      const take = await act('furnace_take', { furnace: handleOf(snap, 'minecraft:furnace', furnaceAt), slot: 'output' });
      await expectStatus(take, ['succeeded', 'partial'], ev);
      ev.push(`after 12s with the interface closed, output taken: ${take.evidence.inventoryGained} (furnace kept processing)`);
      assert(take.evidence.inventoryGained >= 1, 'processing continued after cancel');
    });

    await check('X6', 'a valid owner goal replaces a running diagnostic action (one control owner); goal then reports planner_not_ready', async (ev) => {
      assert(owner, 'owner bot');
      chunkbot.mark();
      const from = chunkbot.length;
      chunkbot.send(`/diag do move_near ${JSON.stringify({ target: { kind: 'destination', dimension: 'overworld', x: 214.5, y: -60, z: 196.5 }, within: 1 })}`);
      await chunkbot.waitFor(/\[diag\] running move_near/);
      await sleep(600);
      owner.chat('!chunkbot collect some stone and build a little wall');
      const stop = await chunkbot.json<Json>('stop', 5_000);
      ev.push(`diagnostic cancelled by goal admission: reason=${stop.reason} clearMs=${stop.clearMs}`);
      assert(stop.reason === 'replaced_by_goal', 'replacement reason');
      const o = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(o, 'cancelled', ev);
      ev.push(await chunkbot.waitSince(/blocked \(planner_not_ready\)/, from));
    });

    await check('X7', 'death during a running action revokes the lease (lifecycle), respawn starts idle', async (ev) => {
      chunkbot.mark();
      const from = chunkbot.length;
      chunkbot.send(`/diag do move_near ${JSON.stringify({ target: { kind: 'destination', dimension: 'overworld', x: 214.5, y: -60, z: 214.5 }, within: 1 })}`);
      await chunkbot.waitFor(/\[diag\] running move_near/);
      await sleep(500);
      await rcon('kill Chunkbot');
      const stop = await chunkbot.json<Json>('stop', 5_000);
      ev.push(`lifecycle stop: reason=${stop.reason} clearMs=${stop.clearMs}`);
      assert(stop.reason === 'lifecycle_death', 'death revocation');
      const o = (await chunkbot.json<Json>('outcome')).outcome as Json;
      await expectStatus(o, 'cancelled', ev);
      ev.push(await chunkbot.waitSince(/bot died/, from, 5_000));
      ev.push(await chunkbot.waitSince(/respawned in overworld; idle/, from, 10_000));
    });

    // ---------------------------------------------------------------- MB-SKL-007 travel bounds (second built session, radius 8)
    // A separate CLI run whose only config difference is limits.travelRadius = 8 (recorded in the report directory).
    chunkbot.send('/quit');
    await Promise.race([chunkbot.exited, sleep(8_000)]);
    chunkbot.save(outDir);
    const base = JSON.parse(readFileSync(CONFIG, 'utf8')) as Json;
    const travelConfig = { ...base, storage: { ...base.storage, dataDir: join(PROJECT_ROOT, 'var') }, limits: { ...base.limits, travelRadius: 8 } };
    const travelConfigPath = join(outDir, 'travel-radius-8.json');
    writeFileSync(travelConfigPath, `${JSON.stringify(travelConfig, null, 2)}\n`);
    chunkbot = new CliProcess('run-travel-radius-8', ['run', '--no-autonomy', '--config', travelConfigPath]);
    const ANCHOR = { x: 205.5, y: -60, z: 198.5 };
    await check('B0', 'second session joins with travelRadius 8; anchor set at a recorded position', async (ev) => {
      ev.push(await chunkbot.waitFor(new RegExp(`\\[chunkbot\\] ready: version=${FIXTURE_VERSION_RE}`), 30_000));
      await rcon(`tp Chunkbot ${ANCHOR.x} ${ANCHOR.y} ${ANCHOR.z} 180 0`);
      await rcon('fill 196 -60 190 224 -57 201 air'); // clear lane south of the scene (recorded)
      await sleep(1_000);
      chunkbot.send('/diag anchor');
      const a = await chunkbot.json<Json>('anchor');
      ev.push(`travel bounds: ${JSON.stringify(a.travel)}`);
      assert(a.travel && a.travel.radius === 8 && Math.abs(a.travel.anchor.z - ANCHOR.z) < 0.6, 'radius 8 at the anchor');
    });

    await check('B1', 'boundary: a destination outside the radius is refused before moving; an inside destination is reached; server position stays inside', async (ev) => {
      const out = await act('move_near', { target: { kind: 'destination', dimension: 'overworld', x: 205.5, y: -60, z: 188.5 }, within: 1 });
      await expectStatus(out, 'precondition_failed', ev);
      assert(out.reason === 'outside_travel_bounds', `reason ${out.reason}`);
      const p0 = await serverPos();
      assert(dist(p0, ANCHOR) < 0.6, 'did not move');
      const inside = await act('move_near', { target: { kind: 'destination', dimension: 'overworld', x: 199.5, y: -60, z: 198.5 }, within: 1 });
      await expectStatus(inside, 'succeeded', ev);
      const p1 = await serverPos();
      ev.push(`server: ${p1.x.toFixed(2)},${p1.z.toFixed(2)} (${dist(p1, ANCHOR).toFixed(2)} from the anchor)`);
      assert(dist(p1, ANCHOR) <= 8, 'inside the bound');
    });

    await check('B2', 'detour: an inside destination reachable only through a gap outside the radius fails with path/limit evidence (no out-of-bound walking); opening an inside gap makes it reachable', async (ev) => {
      await rcon(`tp Chunkbot ${ANCHOR.x} ${ANCHOR.y} ${ANCHOR.z} 180 0`);
      await rcon('fill 196 -60 196 224 -58 196 stone_bricks'); // wall across the lane (recorded)
      await rcon('fill 215 -60 196 215 -58 196 air'); // its only gap, 9.5+ blocks from the anchor
      await sleep(900);
      const target = { kind: 'destination', dimension: 'overworld', x: 205.5, y: -60, z: 193.5 };
      let maxFromAnchor = 0;
      const watch = (async () => {
        for (let i = 0; i < 40; i += 1) {
          const p = await serverPos().catch(() => undefined);
          if (p) maxFromAnchor = Math.max(maxFromAnchor, dist(p, ANCHOR));
          await sleep(250);
        }
      })();
      const o = await act('move_near', { target, within: 1 }, 60_000);
      await expectStatus(o, 'failed', ev);
      ev.push(`reason ${o.reason}; evidence ${JSON.stringify({ travelRadius: o.evidence.travelRadius, travelAnchor: o.evidence.travelAnchor, finalDistance: o.evidence.finalDistance })}`);
      assert(['no_safe_path', 'outside_travel_bounds', 'stuck'].includes(o.reason), `reason ${o.reason}`);
      await watch;
      ev.push(`max server distance from the anchor during the attempt: ${maxFromAnchor.toFixed(2)}`);
      assert(maxFromAnchor <= 8.5, 'never walked outside the bound');
      await rcon('fill 207 -60 196 207 -58 196 air'); // inside gap (recorded)
      await sleep(700);
      await expectStatus(await act('move_near', { target, within: 1 }, 60_000), 'succeeded', ev);
      await rcon('fill 196 -60 196 224 -58 196 air');
    });

    await check('B3', 'moving owner: following stops when the visible owner walks out of the radius; Chunkbot stays inside', async (ev) => {
      owner ??= await fixtureBot('FixtureOwner');
      await rcon(`tp Chunkbot ${ANCHOR.x} ${ANCHOR.y} ${ANCHOR.z} 270 0`);
      await rcon(`tp FixtureOwner ${ANCHOR.x + 2} ${ANCHOR.y} ${ANCHOR.z} -90 0`);
      await sleep(1_000);
      const follow = act('follow_entity', { target: { kind: 'owner' }, within: 2, durationMs: 12_000 }, 25_000);
      await sleep(500);
      owner.setControlState('forward', true);
      await sleep(3_500);
      owner.setControlState('forward', false);
      const f = await follow;
      await expectStatus(f, 'failed', ev);
      assert(f.reason === 'target_outside_travel_bounds' || f.reason === 'outside_travel_bounds', `reason ${f.reason}`);
      const b = await serverPos();
      const o = await serverPos('FixtureOwner');
      ev.push(`server: Chunkbot ${dist(b, ANCHOR).toFixed(2)} from the anchor; owner ${dist(o, ANCHOR).toFixed(2)} from the anchor`);
      assert(dist(b, ANCHOR) <= 8.5, 'Chunkbot stayed inside');
      assert(dist(o, ANCHOR) > 8, 'the owner really left the radius');
    });

    await check('B4', 'fresh anchor: after re-anchoring at a new position, a destination outside the OLD radius but inside the new one is reached', async (ev) => {
      await rcon(`tp Chunkbot 211.5 -60 198.5 270 0`);
      await rcon(`tp FixtureOwner ${SCENE.start.x - 6} -60 ${SCENE.start.z - 10}`);
      await sleep(900);
      chunkbot.send('/diag anchor');
      const a = await chunkbot.json<Json>('anchor');
      ev.push(`new anchor ${JSON.stringify(a.travel.anchor)}`);
      const o = await act('move_near', { target: { kind: 'destination', dimension: 'overworld', x: 217.5, y: -60, z: 198.5 }, within: 1 });
      await expectStatus(o, 'succeeded', ev);
      const p = await serverPos();
      ev.push(`server: ${p.x.toFixed(2)},${p.z.toFixed(2)}: ${dist(p, ANCHOR).toFixed(2)} from the old anchor (outside 8), inside the new one`);
      assert(dist(p, ANCHOR) > 8, 'outside the old anchor radius');
    });

    await check('B5', 'goal admission owns the travel anchor: captured at the admission position, unchanged when Chunkbot is moved afterwards, replaced only by a new admission; goals report planner_not_ready', async (ev) => {
      assert(owner, 'owner bot');
      await rcon(`tp Chunkbot 199.5 -60 198.5 0 0`);
      await rcon(`tp FixtureOwner 201.5 -60 198.5 90 0`);
      await sleep(900);
      let from = chunkbot.length;
      owner.chat('!chunkbot walk over to the chest');
      ev.push(await chunkbot.waitSince(/blocked \(planner_not_ready\)/, from, 10_000));
      let snap = await observe();
      const a1 = snap.perception.travel?.anchor;
      ev.push(`travel anchor after admission: ${JSON.stringify(a1)}`);
      assert(a1 && Math.abs(a1.x - 199.5) < 0.6 && Math.abs(a1.z - 198.5) < 0.6, 'anchor at the admission position');
      // Setup teleport after admission: observation and diagnostics must not re-anchor the goal's bound.
      await rcon(`tp Chunkbot 205.5 -60 198.5 0 0`);
      await sleep(900);
      snap = await observe();
      const a2 = snap.perception.travel?.anchor;
      ev.push(`after Chunkbot was moved 6 blocks: anchor ${JSON.stringify(a2)} (distanceFromAnchor ${snap.perception.travel?.distanceFromAnchor})`);
      assert(a2 && Math.abs(a2.x - 199.5) < 0.6, 'anchor unchanged by movement after admission');
      from = chunkbot.length;
      owner.chat('!chunkbot actually wait here');
      ev.push(await chunkbot.waitSince(/blocked \(planner_not_ready\)/, from, 10_000));
      snap = await observe();
      const a3 = snap.perception.travel?.anchor;
      ev.push(`after a replacement admission: anchor ${JSON.stringify(a3)}`);
      assert(a3 && Math.abs(a3.x - 205.5) < 0.6, 'the replacement got its own admission anchor');
      const runId = /\[chunkbot\] run (\S+);/.exec(chunkbot.lines.find((l) => /\[chunkbot\] run /.test(l.text))?.text ?? '')?.[1];
      assert(runId, 'run id from the CLI transcript');
      const events = readFileSync(join(PROJECT_ROOT, 'var', 'runs', runId, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l.includes('"goal_travel_anchor"'))
        .map((l) => JSON.parse(l) as Json);
      ev.push(`run evidence goal_travel_anchor: ${JSON.stringify(events.map((e) => ({ epoch: e.epoch, anchor: e.anchor })))}`);
      assert(events.length >= 2, 'admission anchors recorded in run evidence');
    });
  } finally {
    try {
      owner?.quit();
    } catch {
      // ignore
    }
    chunkbot.send('/quit');
    const exited = await Promise.race([chunkbot.exited, sleep(8_000).then(() => undefined)]);
    if (!exited) chunkbot.child.kill('SIGKILL');
    chunkbot.save(outDir);
    const passed = results.filter((r) => r.pass).length;
    const report = {
      kind: 'mb-v1-02-skills-live-check',
      startedAt: stamp,
      fixture: { host: FIXTURE_PINS.host, port: FIXTURE_PINS.port, version: FIXTURE_PINS.minecraftVersion, pid: fixturePid },
      cliPid: chunkbot.pid,
      cliRuns: ['run-skills (config/examples/fixture-inference-free.json)', 'run-travel-radius-8 (travel-radius-8.json: fixture-inference-free.json with limits.travelRadius=8, absolute dataDir)'],
      cliExit: exited ?? 'killed',
      stopTargetMs: STOP_TARGET_MS,
      passed,
      total: results.length,
      results,
      setupCommands: setupLog,
    };
    writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\n${passed}/${results.length} skill scenarios passed; report ${join(outDir, 'report.json')}\n`);
    process.exitCode = passed === results.length ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`skills-live-check error: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
