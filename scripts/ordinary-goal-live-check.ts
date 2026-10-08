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
//       birch log and canopy position removed (RCON); every oak log intact
//   O3u unreachable floating remnant -> bounded declarative blocker; no substitute cutting
//   O4  "set up your house here" with the owner visible at a vacant flat site: a verified home
//       (structure_state complete) near the owner's position; `--house-materials provided`
//       (default: cobblestone + table/furnace/chest given, recorded) or `gather` (nothing given;
//       the full acceptance trial)
//   O5  absent target: "kill that rabbit" with no rabbit -> one declarative blocker, no attack
//       on any other entity, no question
//   O6  stop during work: "remove that floating tree", owner `stop` after the first goal action
//       -> goal cancelled (owner_stop), no later goal action, latch paused; no question
//   O7W manual follow without memory/autonomy: submerged outside an 8-block normal
//       anchor -> finite safety grant; stop revokes it; a new manual goal grants fresh safety
//   O8M/O8A/O8D ordinary follow: unarmed avoidance, equipped non-engaging
//       avoidance, then equipped defense with server engagement proven BEFORE admission
//   O7P/O7R/O7F: real planner-wait water, active same-goal resumption, far cue withdrawal
//   O8C/O8N: effect-free equipped creeper retreat; unprovoked wolf/cow/owner refusal
//       These five cases share ONE CLI/safety history at the original default radius 128.
//   RC1  partial additional-log job -> death -> actual own recovery -> remaining original job
//   RC2/RC2H/RC2C persistent follow, partial construction and craft/equipment continuation
//   RC3/RC3N/RC3D stop/resume/restart, new owner supersession, another recovery death
//   RC4  no held owner job: actual recovery -> fresh useful progression
// Recovery uses the fixture's UNCHANGED respawn point and finite own-death route;
// no spawnpoint/bed/world-spawn mutation, teleport rescue or restored gear.
//
// Footprint (complete; restored and verified at cleanup):
//   blocks    x 196..224, z 190..224, y -63..-50 (the standard skills scene area): reset to
//             dirt (y -63..-62), grass (y -61), air (y -60..-50) plus the standard oak trunk at
//             208,-60..-58,202, and per scenario: oak trees (x 198..200, z 196..198 / 214..216),
//             a floating birch remnant (x 211..213, z 204..206, y -58..-55;
//             O3u shifts it up one); gather sources x 197..213,z 192..199,y -60..-55;
//             O7W dirt platform x 200..223,z 194..219,y -60..-57, 7x7 water pool.
//             Cleanup re-applies
//             the standard reset and verifies sample positions.
//   entities  removes recorded summoned UUIDs and declared scene items/orbs ONLY inside
//             x 196..224, y -64..-24, z 190..224. Ambient/unknown occupants fail staging.
//   players   Chunkbot and FixtureOwner: inventories cleared (bot: 8 bread given so survival
//             upkeep never competes; O4 materials when provided), Chunkbot effects/gamemode,
//             positions inside the area.
//             O7F additionally moves ONLY FixtureOwner to 350.5,-60,198.5 after loaded
//             support/empty-body server proofs. No block footprint extension; bot stops
//             before leaving the scene and owner returns while the goal is stopped.
//   forceload chunks covering the area; the existing set is queried BEFORE any change and only
//             this run's additions are removed and verified at the end.
// No difficulty, gamerule or time change. Independent data directory and a fresh memory/
// autonomy scope under the report directory. The automatic pause latch is set right after
// ready (`stop`); recovery cases explicitly resume support, and RC4 allows progression.
// O7W removes memory/autonomy/locator/survival from its generated fixture profile.
// Dummy player travel for recovery includes the unchanged respawn-to-site path;
// all block/entity mutations stay in the declared scene. Each operator trigger is recorded.
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
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';
import { MemoryConfigSchema } from '../src/contracts/memory.ts';
import { DashboardStatusSchema } from '../src/contracts/dashboard.ts';
import { smallShelterCells, type Facing } from '../src/autonomy/blueprint.ts';
import { serverWaterSupport, type TrialWaterSupport } from '../src/safety/trial-water.ts';
import { parseTrialUuid, serverUnprovokedWolf } from '../src/safety/trial-arena.ts';
import { CLI, CliProcess } from './lib/cli-process.ts';
import { rconCommand } from './lib/rcon.ts';
import { SCENE } from './lib/scene.ts';
import { distance, ownerStandingCommands, pendingRealTurn, timeOf, verifyFiniteEpisode, verifyHiddenOwner, verifyNoAttacks, verifyPlannerWaterRace, verifyPreemption, verifySafetyOwnership, verifySharedSafetyHistory } from './lib/ordinary-safety-oracles.ts';

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
    { x: 212, y: -58, z: 205 },
    { x: 212, y: -57, z: 205 },
    { x: 212, y: -56, z: 205 },
  ],
  birchLeaves: { x1: 211, x2: 213, y: -55, z1: 204, z2: 206 },
  oakTrees: [
    { logs: [{ x: 199, y: -60, z: 197 }, { x: 199, y: -59, z: 197 }, { x: 199, y: -58, z: 197 }], leaves: { x1: 198, x2: 200, y: -57, z1: 196, z2: 198 } },
    { logs: [{ x: 199, y: -60, z: 215 }, { x: 199, y: -59, z: 215 }, { x: 199, y: -58, z: 215 }], leaves: { x1: 198, x2: 200, y: -57, z1: 214, z2: 216 } },
  ],
  houseOwner: { x: 216.5, y: -60, z: 216.5 },
  ownerDefault: { x: 202.5, y: -60, z: 209.5 },
  gather: {
    trunks: [{ x: 198, z: 193 }, { x: 202, z: 193 }, { x: 206, z: 193 }, { x: 198, z: 198 }, { x: 202, z: 198 }, { x: 206, z: 198 }],
    stone: { x1: 210, x2: 213, z1: 193, z2: 195, y: -60 },
  },
  water: { platform: { x1: 200, x2: 223, z1: 194, z2: 219, y1: -60, y2: -57 }, pool: { x1: 204, x2: 210, z1: 203, z2: 209 }, bot: { x: 218.5, y: -56, z: 200.5 }, owner: { x: 218.5, y: -56, z: 198.5 }, submerged: { x: 207.5, y: -60, z: 206.5 } },
  safety: { farOwner: { x: 350.5, y: -60, z: 198.5 }, eastOwner: { x: 221.5, y: -56, z: 204.5 }, dryBot: { x: 205.5, y: -60, z: 205.5 }, creeper: { x: 210.5, y: -60, z: 205.5 }, cow: { x: 207.5, y: -60, z: 206.5 }, wolf: { x: 203.5, y: -60, z: 205.5 } },
} as const;

/** RCON entity truth: an unreadable/error reply never proves absence. */
export function fixtureEntityTest(reply: string): boolean | null {
  if (/^Test passed[.,] Count: [1-9]\d*\.?$/i.test(reply.trim())) return true;
  if (/^Test failed\.?$/i.test(reply.trim())) return false;
  return null;
}

/** A y-only surface bob inside the pool cannot satisfy the escape oracle. */
export function onWaterBank(p: V3): boolean {
  const { platform, pool } = LAYOUT.water;
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && Math.abs(p.y - (-56)) <= 0.2 &&
    p.x >= platform.x1 && p.x < platform.x2 + 1 && p.z >= platform.z1 && p.z < platform.z2 + 1 &&
    (p.x < pool.x1 || p.x >= pool.x2 + 1 || p.z < pool.z1 || p.z >= pool.z2 + 1);
}

/** Independent actual server facts, using W's reviewed support oracle. */
export function ordinaryDryBankSupport(p: V3, support: TrialWaterSupport, air: number | null): boolean {
  return onWaterBank(p) && serverWaterSupport(support) === 'dry' && air === 300;
}

export function currentMeleeDamage(damage: { entityId: number; sourceCauseId: number; atMs: number }, selfId: number, threatId: number, now: number): boolean {
  return Number.isInteger(selfId) && Number.isInteger(threatId) && damage.entityId === selfId && damage.sourceCauseId > 0 && damage.sourceCauseId - 1 === threatId && now >= damage.atMs && now - damage.atMs <= 6_000;
}

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

/** Shared ordinary-pipeline continuation oracle; supporting recovery is a separate goal. */
export function verifyOrdinaryContinuation(events: Json[], goalId: string): { capture: Json; bound: Json; admission: Json } {
  const capture = events.find((e) => e.type === 'continuation_checkpoint' && e.goalId === goalId && e.state === 'held');
  const original = events.find((e) => e.type === 'goal_admitted' && e.goalId === goalId);
  const admission = events.find((e) => e.type === 'goal_admitted' && e.goalId === goalId && e.continuation);
  const bound = events.find((e) => e.type === 'goal_continuation_bound' && e.goalId === goalId && e.epoch === admission?.epoch);
  check(capture && original && admission && bound, 'held, original, continued admission and fresh binding are all recorded');
  check(admission.epoch > original.epoch && admission.continuation.number >= 1, 'same logical goal receives a fresh epoch');
  for (const field of ['outcomeCanonical', 'caps', 'deadlineAtMs', 'admissionBaseline']) check(capture[field] !== undefined && JSON.stringify(capture[field]) === JSON.stringify(bound[field]), `original ${field} is immutable`);
  check(bound.carriedTasks === 0 && bound.carriedHandles === 0, 'no executable task/handle replay');
  const anchors = events.filter((e) => e.type === 'goal_travel_anchor' && e.goalId === goalId);
  const oldAnchor = anchors.find((e) => e.epoch === original.epoch);
  const freshAnchor = anchors.find((e) => e.epoch === admission.epoch);
  check(oldAnchor?.admitted && freshAnchor?.admitted && JSON.stringify(oldAnchor.anchor) === JSON.stringify(freshAnchor.anchor) && oldAnchor.radius === freshAnchor.radius, 'original admission travel anchor/radius preserved');
  for (const [k, v] of Object.entries(capture.counters)) check(Number(admission.continuation.counters[k]) >= Number(v), `${k} cannot refill`);
  const oldTasks = new Set(events.filter((e) => e.type === 'task_admitted' && e.goalId === goalId && e.epoch === original.epoch).map((e) => e.taskId));
  check(events.filter((e) => e.type === 'task_admitted' && e.goalId === goalId && e.epoch === admission.epoch).every((e) => !oldTasks.has(e.taskId)), 'continued tasks have fresh identities');
  return { capture, bound, admission };
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
  readonly readbacks: Json[] = [];
  readonly safetySamples: Json[] = [];
  readonly sceneActors = new Map<string, { uuid: string; nbt: string }>();
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
    const tag = /^summon \w+ .+Tags:\["([a-zA-Z0-9_]+)"\]/.exec(command)?.[1];
    if (tag) {
      check(/^Summoned new /i.test(reply), `summon failed: ${reply}`);
      const count = await this.read(`execute if entity @e[tag=${tag},${ENTITY_BOX}]`);
      check(/^Test passed[.,] Count: 1\.?$/i.test(count.trim()), `one uniquely tagged actor required: ${count}`);
      const raw = await this.read(`data get entity @e[tag=${tag},limit=1,${ENTITY_BOX}] UUID`);
      const uuid = parseTrialUuid(raw);
      const nbt = /\[I;[^\]]+\]$/.exec(raw.trim())?.[0];
      check(uuid && nbt && !this.sceneActors.has(tag), 'fresh recorded actor UUID/tag required');
      this.sceneActors.set(tag, { uuid, nbt });
    }
    return reply;
  }
  query(command: string): Promise<string> {
    return this.rconRaw(command);
  }
  async read(command: string): Promise<string> {
    const startedAtMs = Date.now();
    const reply = await this.query(command);
    this.readbacks.push({ scenario: this.scenario, startedAtMs, atMs: Date.now(), command, reply });
    return reply;
  }
  async noForeignSceneActors(): Promise<void> {
    for (const [tag, actor] of this.sceneActors) {
      const count = await this.read(`execute if entity @e[tag=${tag},${ENTITY_BOX}]`);
      const present = fixtureEntityTest(count);
      check(present !== null, 'staging_unready: unknown actor presence');
      if (present) check(/^Test passed[.,] Count: 1\.?$/i.test(count.trim()) && parseTrialUuid(await this.read(`data get entity @e[tag=${tag},limit=1,${ENTITY_BOX}] UUID`)) === actor.uuid, 'staging_unready: actor count/identity changed');
    }
    const excludes = [...this.sceneActors.keys()].map((tag) => `tag=!${tag}`).join(',');
    const reply = await this.read(`execute if entity @e[type=!player,type=!item,type=!experience_orb,${ENTITY_BOX}${excludes ? `,${excludes}` : ''}]`);
    check(fixtureEntityTest(reply) === false, `staging_unready: foreign/ambient/group/cloud occupancy; never removed: ${reply}`);
  }
  async removeSceneActors(): Promise<void> {
    await this.noForeignSceneActors();
    for (const [tag, actor] of this.sceneActors) {
      await this.setup(`kill @e[tag=${tag},nbt={UUID:${actor.nbt}},${ENTITY_BOX}]`);
      check(fixtureEntityTest(await this.read(`execute if entity @e[nbt={UUID:${actor.nbt}}]`)) === false, 'owned scene actor escaped the authorized removal box; cleanup not reconciled');
    }
    for (const type of ['item', 'experience_orb']) await this.setup(`kill @e[type=${type},${ENTITY_BOX}]`);
    await sleep(1_600);
    check(fixtureEntityTest(await this.read(`execute if entity @e[type=!player,${ENTITY_BOX}]`)) === false, 'no scene entities after bounded owned cleanup');
    this.sceneActors.clear();
  }
  journal(): Json[] { return readJsonl(join(dirname(this.eventsPath), 'planner.jsonl')); }
  dashboard(): Json {
    const d = DashboardStatusSchema.parse(JSON.parse(readFileSync(join(this.dataDir, 'dashboard', 'status.json'), 'utf8')));
    check(d.publisher.runId === this.events()[0]?.run && d.connection.state === 'ready' && Date.now() >= d.publisher.publishedAtMs && Date.now()-d.publisher.publishedAtMs <= 1_500, 'fresh dashboard from this actual ready CLI required');
    this.safetySamples.push({ scenario: this.scenario, atMs: Date.now(), dashboard: d });
    return d;
  }
  async observe(): Promise<Json> {
    const from = this.cli!.length;
    this.cli!.send('/diag observe');
    const line = await this.cli!.waitSince(/^\[diag-json\] \{"kind":"observe"/, from, 10_000);
    const snapshot = JSON.parse(line.slice('[diag-json] '.length)).snapshot as Json;
    check(snapshot.connectionEpoch === this.dashboard().connection.epoch && Date.now()-snapshot.takenAtMs <= 1_500 && Date.now() >= snapshot.takenAtMs, 'fresh actual filtered observation required');
    this.safetySamples.push({ scenario: this.scenario, atMs: Date.now(), snapshot });
    return snapshot;
  }
  note(step: string, ok: boolean, detail: string): void {
    this.cleanup.push({ atMs: Date.now(), step, ok, detail: detail.slice(0, 300) });
  }
  async blockIs(p: V3, key: string): Promise<boolean> {
    return /Test passed/i.test(await this.query(`execute if block ${p.x} ${p.y} ${p.z} ${key}`));
  }
  async entityExists(tag: string): Promise<boolean> {
    const reply = await this.query(`execute if entity @e[tag=${tag},${ENTITY_BOX}]`);
    const exists = fixtureEntityTest(reply);
    check(exists !== null, `entity presence unreadable; no absence credit: ${reply}`);
    return exists;
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
    await this.noForeignSceneActors();
    await this.setup(`forceload add ${x1} ${z1} ${x2} ${z2}`);
    await this.setup(`tp ${BOT} ${SCENE.start.x} ${SCENE.start.y + 30} ${SCENE.start.z}`);
    await this.setup(`effect give ${BOT} slow_falling 5 0 true`);
    await this.removeSceneActors();
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
  async buildTrees(unreachable = false): Promise<void> {
    for (const t of LAYOUT.oakTrees) {
      const l = t.leaves;
      await this.setup(`fill ${l.x1} ${l.y} ${l.z1} ${l.x2} ${l.y} ${l.z2} oak_leaves[persistent=true]`);
      for (const p of t.logs) await this.setup(`setblock ${p.x} ${p.y} ${p.z} oak_log`);
    }
    const b = LAYOUT.birchLeaves;
    const offset = unreachable ? 1 : 0;
    await this.setup(`fill ${b.x1} ${b.y + offset} ${b.z1} ${b.x2} ${b.y + offset} ${b.z2} birch_leaves[persistent=true]`);
    for (const p of LAYOUT.birchLogs) await this.setup(`setblock ${p.x} ${p.y + offset} ${p.z} birch_log`);
    await sleep(800);
  }

  async buildGatherSources(): Promise<void> {
    // Reachable natural trunks supply 30 logs; planks can build/furnish the
    // shelter. An exposed stone outcrop supplies the furnace after tool craft.
    for (const t of LAYOUT.gather.trunks) {
      await this.setup(`fill ${t.x - 1} -55 ${t.z - 1} ${t.x + 1} -55 ${t.z + 1} oak_leaves[persistent=true]`);
      await this.setup(`fill ${t.x} -60 ${t.z} ${t.x} -56 ${t.z} oak_log`);
    }
    const s = LAYOUT.gather.stone;
    await this.setup(`fill ${s.x1} ${s.y} ${s.z1} ${s.x2} ${s.y} ${s.z2} stone`);
  }

  async inventory(name = BOT): Promise<Record<string, number>> {
    const reply = await this.query(`data get entity ${name} Inventory`);
    check(/has the following entity data:/.test(reply), `server inventory unreadable: ${reply}`);
    const out: Record<string, number> = {};
    for (const entry of reply.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) ?? []) {
      const key = /id: "([^"]+)"/.exec(entry)?.[1];
      if (key) out[key] = (out[key] ?? 0) + Number(/count: (\d+)/.exec(entry)?.[1] ?? 0);
    }
    return out;
  }

  async position(name = BOT): Promise<V3> {
    const reply = await this.query(`data get entity ${name} Pos`);
    const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(reply);
    check(m, `server position unreadable: ${reply}`);
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  }

  async waitForTruth(label: string, fn: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await fn()) return; await sleep(200); }
    throw new Error(`bounded server-truth wait expired: ${label}`);
  }

  async waterScene(): Promise<void> {
    const { platform: p, pool } = LAYOUT.water;
    await this.setup(`fill ${p.x1} ${p.y1} ${p.z1} ${p.x2} ${p.y2} ${p.z2} dirt`);
    await this.setup(`fill ${pool.x1} ${p.y1} ${pool.z1} ${pool.x2} ${p.y2} ${pool.z2} water`);
    for (const [name, at] of [[BOT, LAYOUT.water.bot], [OWNER, LAYOUT.water.owner]] as const) await this.setup(`tp ${name} ${at.x} ${at.y} ${at.z}`);
    await sleep(800);
  }

  async triggerTeleport(name: typeof BOT | typeof OWNER, p: V3, why: string): Promise<void> {
    const command = `tp ${name} ${p.x} ${p.y} ${p.z}`;
    const reply = await this.setup(command);
    this.interventions.push({ atMs: Date.now(), scenario: this.scenario, command, reply, why });
    check(/^Teleported /i.test(reply), `staging_unready: teleport failed: ${reply}`);
  }
  async verifyWaterGeometry(): Promise<void> {
    const { platform: p, pool } = LAYOUT.water;
    for (const x of [pool.x1, 207, pool.x2]) for (const z of [pool.z1, 206, pool.z2]) for (const y of [p.y1, p.y2]) {
      check(fixtureEntityTest(await this.read(`execute if loaded ${x} ${y} ${z} if block ${x} ${y} ${z} minecraft:water`)) === true, 'staging_unready: original deep pool geometry unverified');
    }
    for (const at of [LAYOUT.water.bot, LAYOUT.water.owner, LAYOUT.safety.eastOwner, { x: 211.5, y: -56, z: 206.5 }, { x: 203.5, y: -56, z: 206.5 }]) {
      const x = Math.floor(at.x), z = Math.floor(at.z);
      for (const [y, key] of [[-57, 'dirt'], [-56, 'air'], [-55, 'air']] as const) check(fixtureEntityTest(await this.read(`execute if loaded ${x} ${y} ${z} if block ${x} ${y} ${z} minecraft:${key}`)) === true, 'staging_unready: dry supported bank/corridor unverified');
    }
    await this.noForeignSceneActors();
  }
  async armSafetyControl(): Promise<void> {
    for (const command of [`item replace entity ${BOT} hotbar.0 with minecraft:iron_sword`, `item replace entity ${BOT} armor.head with minecraft:iron_helmet`, `item replace entity ${BOT} armor.chest with minecraft:iron_chestplate`]) check(/^Replaced /i.test(await this.setup(command)), 'staging_unready: declared equipment placement failed');
    await this.waitForTruth('actual equipped sword/armor observation', async () => {
      const s = await this.observe();
      return s.equipment.hand === 'minecraft:iron_sword' && s.equipment.head === 'minecraft:iron_helmet' && s.equipment.torso === 'minecraft:iron_chestplate';
    }, 5_000);
  }
  async verifyDryMobGeometry(): Promise<void> {
    // All supported/sight/escape cells used by the original dry scene. Read
    // them again after any creeper response; an explosion is never hidden by reset.
    for (const x of [201, 203, 205, 207, 210, 213, 216]) for (const z of [203, 205, 206, 208]) for (const [y, key] of [[-61, 'grass_block'], [-60, 'air'], [-59, 'air']] as const) {
      check(fixtureEntityTest(await this.read(`execute if loaded ${x} ${y} ${z} if block ${x} ${y} ${z} minecraft:${key}`)) === true, 'staging_unready: original dry mob standing/sight/escape geometry unverified');
    }
    await this.noForeignSceneActors();
  }
  async mobIdentity(tag: string, key: string): Promise<{ uuid: string; entityId: number; position: V3; health: number }> {
    const actor = this.sceneActors.get(tag);
    check(actor, 'staging_unready: only this harness recorded actor can be inspected');
    const count = await this.read(`execute if entity @e[tag=${tag},type=${key},${ENTITY_BOX}]`);
    check(/^Test passed[.,] Count: 1\.?$/i.test(count.trim()), 'staging_unready: exactly one current supported mob required');
    const uuid = parseTrialUuid(await this.read(`data get entity @e[tag=${tag},limit=1,${ENTITY_BOX}] UUID`));
    check(uuid === actor.uuid, 'staging_unready: current tagged UUID changed');
    const position = await this.entityPosition(`@e[tag=${tag},limit=1,${ENTITY_BOX}]`);
    const raw = Object.values(this.owner!.entities).find((e) => e.uuid === uuid && `minecraft:${e.name}` === key);
    check(raw, 'staging_unready: UUID/species absent from current observer packets');
    const s = await this.observe();
    check(s.entities.filter((e: Json) => e.key === key && distance(e.at, position) < 1).length === 1, 'staging_unready: actual CLI LOS/visible target correlation missing');
    check(!s.entities.some((e: Json) => e.key !== 'minecraft:player' && ![...this.sceneActors.values()].some((a) => Object.values(this.owner!.entities).some((r) => r.uuid === a.uuid && `minecraft:${r.name}` === e.key && distance(r.position, e.at) < 1))), 'staging_unready: unexpected visible nonplayer group');
    const reply = await this.read(`data get entity @e[tag=${tag},limit=1,${ENTITY_BOX}] Health`);
    const m = /has the following entity data: ([\d.]+)f$/.exec(reply.trim());
    check(m && Number(m[1]) > 0, 'staging_unready: current living mob health unreadable');
    const result = { uuid: uuid!, entityId: raw.id, position, health: Number(m[1]) };
    this.safetySamples.push({ scenario: this.scenario, atMs: Date.now(), tag, key, identity: result });
    return result;
  }
  async entityPosition(selector: string): Promise<V3> {
    const r = await this.read(`data get entity ${selector} Pos`);
    const m = /has the following entity data: \[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]$/.exec(r.trim());
    check(m, `staging_unready: entity position unreadable: ${r}`);
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  }
  async effectFreeCreeper(tag: string): Promise<void> {
    check(fixtureEntityTest(await this.read(`execute if data entity @e[tag=${tag},limit=1,${ENTITY_BOX}] active_effects[0]`)) === false, 'staging_unready: creeper effects present/unknown; never remove effects/clouds');
  }
  async unprovokedWolf(tag: string): Promise<void> {
    check(serverUnprovokedWolf(await this.read(`data get entity @e[tag=${tag},limit=1,${ENTITY_BOX}] anger_end_time`), await this.read(`execute if data entity @e[tag=${tag},limit=1,${ENTITY_BOX}] persistentAngerTarget`)), 'staging_unready: current wolf anger/target not proven neutral');
  }
  async ownedMotion(goalId: string, origin: V3, sinceMs: number, capabilities: string[], ms = 20_000): Promise<Json> {
    const until = Date.now()+ms;
    while (Date.now() < until) {
      const events = this.events();
      check(!events.some((e) => e.type === 'goal_terminal' && e.goalId === goalId), 'staging_unready: ordinary owner goal ended before active motion');
      const choices = events.filter((e) => e.goalId === goalId && ['task_choice', 'task_local_continuation'].includes(e.type)).map((e) => e.candidateId ?? e.actionId);
      const action = events.findLast((e) => e.type === 'skill_started' && e.owner === 'goal' && capabilities.includes(e.capability) && timeOf(e) >= sinceMs && choices.includes(e.actionId) && !events.some((end) => end.type === 'skill_outcome' && end.actionId === e.actionId));
      const p = await this.position();
      check(p.x >= AREA.x1 && p.x < AREA.x2+1 && p.z >= AREA.z1 && p.z < AREA.z2+1, 'staging_unready: route must stop before leaving the original bot scene');
      if (action && distance(origin, p) >= 0.6) return action;
      await sleep(50);
    }
    throw new Error('staging_unready: actual active owned skill/lease and server motion missing');
  }
  /** Scoped read-only position watcher. Its sole mutation is explicit stop on
   * the owned CLI at a two-block margin, and its promise ALWAYS settles before
   * the case returns. No separate fixture/controller/process is launched. */
  guardFarScene(): { close(): Promise<void>; assert(): void } {
    let closed = false, failure: Error | undefined;
    const done = (async () => {
      try {
        while (!closed) {
          const p = await this.position();
          if (p.x >= AREA.x2-1 || p.x <= AREA.x1+1 || p.z >= AREA.z2-1 || p.z <= AREA.z1+1) {
            failure = new Error(`staging_unready: far-route scene margin reached; stopped before scene exit: ${JSON.stringify(p)}`);
            this.interventions.push({ atMs: Date.now(), scenario: this.scenario, command: 'owned CLI stop (scene-margin guard)', reply: 'must await acknowledgement', why: failure.message });
            await this.quiesce();
            break;
          }
          await sleep(50);
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        try { await this.quiesce(); } catch (stopError) {
          failure = new Error(`${failure.message}; owned margin-stop failed: ${String(stopError)}`);
        }
      }
    })();
    return { close: async () => { closed = true; await done; }, assert: () => { if (failure) throw failure; } };
  }

  async waterExitSettled(ev: string[]): Promise<void> {
    const started = Date.now();
    let samples = 0;
    let previous: V3 | undefined;
    do {
      const p = await this.position();
      check(onWaterBank(p), `episode released before reaching a dry bank: ${JSON.stringify(p)}`);
      const x = Math.floor(p.x), z = Math.floor(p.z);
      const groundReply = await this.query(`execute if entity @a[name=${BOT},nbt={OnGround:1b},limit=1,${ENTITY_BOX}]`);
      const onGround = fixtureEntityTest(groundReply);
      check(onGround !== null, `server ground reply unreadable: ${groundReply}`);
      const support: TrialWaterSupport = {
        onGround,
        floor: await this.blockIs({ x, y: -57, z }, 'minecraft:dirt') ? 'solid' : 'other',
        feet: await this.blockIs({ x, y: -56, z }, 'minecraft:air') ? 'air' : 'other',
        eye: await this.blockIs({ x, y: -55, z }, 'minecraft:air') ? 'air' : 'other',
      };
      const airReply = await this.query(`data get entity ${BOT} Air`);
      const airMatch = /(-?\d+)s\s*$/.exec(airReply);
      const air = airMatch ? Number(airMatch[1]) : null;
      check(ordinaryDryBankSupport(p, support, air), `server confirms dry stable support/full air after release: ${JSON.stringify({ p, support, air })}`);
      if (previous) check(Math.hypot(p.x-previous.x, p.z-previous.z) < 0.8, 'dry supported position stays settled after controls release');
      ev.push(`settled server sample ${++samples}: ${JSON.stringify({ p, support, air })}`);
      previous = p;
      if (Date.now() - started >= 3_000 && samples >= 4) break;
      await sleep(250);
    } while (true);
    check(await this.health(BOT) > 0, 'bot survives the settled water exit');
    ev.push(`server dry support retained ${Date.now()-started}ms after release over ${samples} samples`);
  }

  /** No owner goal/safety authority yet. Prove the actual zombie hurt the bot. */
  async stageMeleeEngagement(tag: string, summon: () => Promise<void>, ev: string[]): Promise<void> {
    check(this.owner, 'owned observer must be online');
    const observer = this.owner;
    const damage: Array<{ entityId: number; sourceCauseId: number; atMs: number }> = [];
    const onDamage = (p: { entityId: number; sourceCauseId: number }) => {
      damage.push({ entityId: p.entityId, sourceCauseId: p.sourceCauseId, atMs: Date.now() });
      if (damage.length > 32) damage.shift();
    };
    observer._client.on('damage_event', onDamage);
    try {
      await summon();
      const reply = await this.query(`data get entity @e[tag=${tag},limit=1,${ENTITY_BOX}] UUID`);
      const parts = /\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]/.exec(reply);
      check(parts, `staging UUID unreadable: ${reply}`);
      const uuid = parts.slice(1).map((n) => (Number(n) >>> 0).toString(16).padStart(8, '0')).join('');
      await this.waitForTruth('current server-attributed zombie melee engagement before admission', async () => {
        const self = observer.players[BOT]?.entity;
        const threat = Object.values(observer.entities).find((e) => e.uuid?.replaceAll('-', '').toLowerCase() === uuid);
        if (!self || !threat || threat.name !== 'zombie') return false;
        const hit = damage.findLast((d) => currentMeleeDamage(d, self.id, threat.id, Date.now()));
        if (!hit) return false;
        const p = await this.position();
        const r = await this.query(`data get entity @e[tag=${tag},limit=1,${ENTITY_BOX}] Pos`);
        const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(r);
        check(m, `staging threat position unreadable: ${r}`);
        const distance = Math.hypot(p.x-Number(m[1]), p.y-Number(m[2]), p.z-Number(m[3]));
        if (distance > 3.5 || !currentMeleeDamage(hit, self.id, threat.id, Date.now())) return false;
        check(await this.health(BOT) >= 14, 'staged engagement retains defense health readiness');
        ev.push(`PRECONDITION: server damage_event victim ${self.id}, cause ${threat.id}, tagged UUID ${uuid}, age ${Date.now()-hit.atMs}ms, current RCON distance ${distance.toFixed(2)}; no goal/safety authority during staging`);
        return true;
      }, 10_000);
    } finally { observer._client.removeListener('damage_event', onDamage); }
  }

  async interruptByDeath(goalId: string): Promise<void> {
    check(/false\b/.test(await this.query('gamerule keep_inventory')), 'loss recovery requires unchanged keep_inventory=false');
    await this.setup(`kill ${BOT}`); // Bounded operator trigger, never recovery credit.
    await this.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goalId && e.reason === 'death', 20_000, 'owned death revocation');
    await this.waitEvent((e) => e.type === 'continuation_checkpoint' && e.goalId === goalId && e.state === 'held', 20_000, 'held semantic checkpoint');
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
    this.runs.push({ name, pid: p.pid, events: '', exit: null });
    const runLine = await p.waitSince(/\[chunkbot\] run \S+; evidence: /, 0, 40_000);
    this.eventsPath = /evidence: (\S+)$/.exec(runLine)?.[1] ?? '';
    this.runs.at(-1)!.events = this.eventsPath;
    await p.waitSince(new RegExp(`\\[chunkbot\\] ready: version=${VERSION_RE}`), 0, 60_000);
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
    this.note(`cli-exit pid ${p.pid ?? '?'}`, Boolean(exited) && !killed && exited?.code === 0, exited ? (killed ? `exited only after SIGKILL (${JSON.stringify(exit)})` : `exited (${JSON.stringify(exit)})`) : 'did NOT exit');
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
    await this.cli.waitSince(/\[chunkbot\] (Stopped|Nothing (to stop|was running)|Goal goal-\S+ cancelled)/, from, 15_000);
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
  check(/^There are 0 of /i.test(list), 'exclusive fixture must have zero players before joining');
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
    // Recovery may return from the fixture's unchanged respawn point using L's
    // finite own-death route. No spawnpoint/bed/world-spawn mutation or RCON rescue.
    locator: { ...base.locator, routes: { ...base.locator?.routes, sources: ['owner', 'support'], destinations: ['owner', 'owner_destination', 'own_death'] } },
  };
  h.configPath = join(outDir, 'ordinary-goals.config.json');
  writeFileSync(h.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const env: NodeJS.ProcessEnv = jevMode === 'fault' ? { ...process.env, OPENROUTER_API_KEY: 'fault-fixture-placeholder-key' } : { ...process.env };
  let activeProfile = cfg;

  const freshCli = async (label: string, freshScope = true, plain = false) => {
    if (h.cli) {
      await h.quiesce();
      await h.setup(`clear ${BOT}`); await h.setup(`effect clear ${BOT}`);
      check(/\[\]$/.test((await h.query(`data get entity ${BOT} Inventory`)).trim()), 'empty online inventory before CLI replacement');
      check(/\[\]$|Found no elements matching/i.test(await h.query(`data get entity ${BOT} active_effects`)), 'empty online effects before CLI replacement');
      await h.quit();
    }
    const profile: Json = JSON.parse(JSON.stringify(freshScope || plain ? cfg : activeProfile)) as Json;
    if (freshScope) profile.memory.worldProfile += `-${label}-${h.runs.length}`;
    if (plain) {
      delete profile.memory; delete profile.autonomy; delete profile.survival; delete profile.locator;
      profile.limits.travelRadius = 8;
    }
    h.configPath = join(outDir, `${label}.config.json`);
    writeFileSync(h.configPath, JSON.stringify(profile, null, 2));
    activeProfile = profile;
    await h.start(`run-${label}`, env);
    await h.quiesce();
  };

  const startFollowing = async () => {
    const goal = await h.goal('follow me');
    await h.waitEvent((e) => e.type === 'task_admitted' && e.goalId === goal.goalId, GOAL_TIMEOUT_MS, 'ordinary follow task');
    return goal;
  };

  const waitContinued = async (goalId: string) => {
    await h.waitEvent((e) => e.type === 'goal_continuation_bound' && e.goalId === goalId, GOAL_TIMEOUT_MS, 'recovery then fresh same-goal binding');
    return verifyOrdinaryContinuation(h.events(), goalId);
  };

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
      const b = LAYOUT.birchLeaves;
      for (let x = b.x1; x <= b.x2; x++) for (let z = b.z1; z <= b.z2; z++) if (await h.blockIs({ x, y: b.y, z }, 'minecraft:birch_leaves')) birchLeft.push({ x, y: b.y, z });
      const oakMissing = [];
      for (const t of LAYOUT.oakTrees) for (const p of t.logs) if (!(await h.blockIs(p, 'minecraft:oak_log'))) oakMissing.push(p);
      for (const p of SCENE.logs) if (!(await h.blockIs(p, 'minecraft:oak_log'))) oakMissing.push(p);
      ev.push(`RCON: birch log/canopy blocks left ${birchLeft.length}/12; oak logs missing ${oakMissing.length}`);
      h.noQuestions(goalId, from, ev);
      check(oakMissing.length === 0, 'no unrelated tree was cut');
      check(end.state === 'completed' && end.reason === 'outcome_verified', 'removal verified by code');
      check(birchLeft.length === 0, 'RCON: every bound floating birch log and canopy block removed');
    });

    await h.scenarioRun('O3u', 'unreachable floating remnant: bounded declarative blocker, no substitute cutting', only, async (ev) => {
      await h.resetScene(); await h.buildTrees(true);
      const { goalId, from } = await h.goal('remove that floating tree');
      const end = await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goalId, GOAL_TIMEOUT_MS, `blocked remnant ${goalId}`);
      h.noQuestions(goalId, from, ev);
      check(end.state !== 'completed' && end.reason !== 'outcome_verified', 'uncleared remnant never completes');
      check(String(end.detail ?? '').length > 0, 'declarative blocker reported');
      const b = LAYOUT.birchLeaves;
      check(await h.blockIs({ x: b.x1, y: b.y + 1, z: b.z1 }, 'minecraft:birch_leaves'), 'unreachable canopy remains');
      for (const p of [...SCENE.logs, ...LAYOUT.oakTrees.flatMap((t) => [...t.logs])]) check(await h.blockIs(p, 'minecraft:oak_log'), 'unrelated oak stays intact');
      ev.push(`${goalId}: ${end.reason}; original canopy remains, all unrelated oak logs intact`);
    });

    await h.scenarioRun('O4', `"set up your house here": verified home near the VISIBLE owner (materials ${materials}); no question`, only, async (ev) => {
      await h.resetScene();
      if (materials === 'gather') await h.buildGatherSources(); else await h.buildTrees();
      if (materials === 'provided') for (const c of [`give ${BOT} minecraft:cobblestone 64`, `give ${BOT} minecraft:crafting_table 1`, `give ${BOT} minecraft:furnace 1`, `give ${BOT} minecraft:chest 1`]) await h.setup(c);
      const before = await h.inventory();
      if (materials === 'gather') check(Object.keys(before).every((k) => k === 'minecraft:bread'), 'gather trial begins without materials, tools or furnishings');
      const setupAtGoal = h.setupLog.length;
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
      if (materials === 'gather') {
        check(!h.setupLog.slice(setupAtGoal).some((s) => /^(give|item replace|setblock|fill)\b/.test(s.command)), 'no in-trial materials or world rescue');
        const actions = h.goalActions(goalId);
        check(actions.some((a) => a.capability === 'mine_block' && a.status === 'succeeded'), 'ordinary pipeline mined source materials');
        check(actions.some((a) => a.capability === 'craft_item' && a.status === 'succeeded'), 'ordinary pipeline crafted prerequisites');
        ev.push('gather acceptance: empty material baseline, reachable trunks/stone, ordinary mining/crafting, no supplied prerequisites or rescue');
      }
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

    await h.scenarioRun('O7W', 'ordinary manual follow without memory/autonomy: finite water escape outside the normal anchor; stop and fresh authorization', only, async (ev) => {
      await freshCli('plain-water', true, true);
      await h.resetScene(); await h.waterScene();
      const first = await startFollowing();
      const before = Date.now();
      const at = LAYOUT.water.submerged;
      await h.setup(`tp ${BOT} ${at.x} ${at.y} ${at.z}`);
      const episode = await h.waitEvent((e) => e.type === 'safety_episode_started' && Date.parse(String(e.t)) >= before, 30_000, 'local water preemption');
      check(episode.suspended?.goalId === first.goalId, 'safety retains the active owner job');
      const stopAt = Date.now(); h.say('stop');
      await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === first.goalId && e.reason === 'owner_stop', 15_000, 'stop revocation');
      const revoked = await h.waitEvent((e) => e.type === 'safety_grant_revoked' && e.grantId === episode.grantId && e.reason === 'owner_stop', 15_000, 'safety stop revoke');
      check(Date.parse(String(revoked.t)) - stopAt <= 250, 'stop synchronously revokes safety within the target');
      await sleep(1_000);
      const p0 = await h.position(); await sleep(1_000); const p1 = await h.position();
      check(Math.hypot(p1.x-p0.x, p1.z-p0.z) < 0.6, 'no horizontal motion after stop');
      const second = await h.goal('follow me');
      const next = await h.waitEvent((e) => e.type === 'safety_episode_started' && e.grantId !== episode.grantId && e.suspended?.goalId === second.goalId, 30_000, 'new manual finite safety grant');
      const ended = await h.waitEvent((e) => e.type === 'safety_episode_ended' && e.episodeId === next.episodeId, 60_000, 'finite water episode');
      check(['resolved', 'improved'].includes(ended.outcome), `water episode did not resolve: ${ended.outcome}`);
      await h.waterExitSettled(ev);
      check(!h.events().some((e) => e.type === 'safety_episode_started' && Date.parse(String(e.t)) > Date.parse(String(ended.t))), 'a replacement episode cannot rescue premature release');
      const anchor = h.events().find((e) => e.type === 'goal_travel_anchor' && e.goalId === first.goalId)!;
      check(anchor.radius === 8 && Math.hypot(at.x-anchor.anchor.x,at.z-anchor.anchor.z) > anchor.radius, 'hazard staging really lies outside the original normal bound');
      check(h.events().filter((e) => e.type === 'goal_travel_anchor' && e.goalId === first.goalId).length === 1, 'safety never reanchors the interrupted job');
      h.noQuestions(second.goalId, second.from, ev);
      check(!h.events().some((e) => e.type === 'goal_terminal' && e.goalId === second.goalId && e.reason === 'outcome_verified'), 'water safety never completes persistent follow');
      ev.push(`no memory/autonomy, original normal radius 8; first grant ${episode.grantId} stopped; fresh grant ${next.grantId}; dry server position ${JSON.stringify(await h.position())}`);
    });

    for (const mode of [
      { id: 'O8M', armed: false, engaging: false, title: 'unarmed avoidance of a visible zombie' },
      { id: 'O8A', armed: true, engaging: false, title: 'equipped avoidance of a non-engaging adult zombie' },
      { id: 'O8D', armed: true, engaging: true, title: 'equipped defense of an already-engaging adult zombie' },
    ]) await h.scenarioRun(mode.id, `ordinary follow: ${mode.title} through the single safety actuator`, only, async (ev) => {
      const { armed, engaging } = mode;
      await freshCli(`mob-${mode.id.toLowerCase()}`); await h.resetScene();
      check(!/peaceful/i.test(await h.query('difficulty')), 'mob trial needs an unchanged non-peaceful fixture; no automatic settings change');
      for (const c of [`effect give ${BOT} minecraft:instant_health 1 4 true`, `effect give ${BOT} minecraft:saturation 1 10 true`]) await h.setup(c);
      if (armed) for (const c of [`item replace entity ${BOT} hotbar.0 with minecraft:iron_sword`, `item replace entity ${BOT} armor.head with minecraft:iron_helmet`, `item replace entity ${BOT} armor.chest with minecraft:iron_chestplate`]) await h.setup(c);
      const tag = `og_${mode.id.toLowerCase()}`;
      const summon = async () => {
        const at = await h.position();
        await h.setup(`summon zombie ${at.x+2.5} ${at.y} ${at.z} {IsBaby:0b,PersistenceRequired:1b,${mode.id === 'O8A' ? 'NoAI:1b,' : ''}Tags:["${tag}"]}`);
        await h.setup(`effect give @e[tag=${tag},${ENTITY_BOX}] minecraft:fire_resistance infinite 0 true`);
      };
      let goal: { goalId: string; from: number };
      const since = Date.now();
      if (engaging) {
        await h.stageMeleeEngagement(tag, summon, ev);
        // Admission immediately authorizes safety; waiting for a planner/task
        // first could expire the already-proven engagement.
        goal = await h.goal('follow me');
      } else {
        goal = await startFollowing();
        await summon();
        if (armed) ev.push('CONTROL: equipped but NoAI adult zombie has no attack/engagement; retreat remains required');
      }
      const ep = await h.waitEvent((e) => e.type === 'safety_episode_started' && e.suspended?.goalId === goal.goalId && Date.parse(String(e.t)) >= since, 30_000, 'local mob episode');
      check(ep.response === (engaging ? 'defend' : 'retreat'), `expected code-owned ${engaging ? 'defense' : 'retreat'}, got ${ep.response}`);
      const ended = await h.waitEvent((e) => e.type === 'safety_episode_ended' && e.episodeId === ep.episodeId, 60_000, 'finite mob episode');
      check(await h.health(BOT) > 0, 'bot survived');
      const actions = h.events().filter((e) => e.type === 'skill_outcome' && e.owner === 'safety' && Date.parse(String(e.t)) >= since);
      if (engaging) {
        check(!await h.entityExists(tag), 'server confirms zombie absent');
        check(actions.some((a) => a.evidence?.defeatedByServerStatus === true), 'defeat requires server status evidence');
      } else {
        check(!actions.some((a) => a.evidence?.attacksSent > 0), 'avoidance response sends no attacks');
        const reply = await h.query(`data get entity @e[tag=${tag},limit=1,${ENTITY_BOX}] Pos`);
        const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(reply);
        check(m, 'threat position readable after retreat');
        const p = await h.position(); check(Math.hypot(p.x-Number(m[1]),p.z-Number(m[3])) >= 4.5, 'server separation increased from initial 2.5');
      }
      h.noQuestions(goal.goalId, goal.from, ev);
      ev.push(`episode ${ep.episodeId}, ${ep.response}->${ended.outcome}; same owner goal ${goal.goalId}; health ${await h.health(BOT)}`);
    });

    // One process/service/history for ALL new controls. Stop/new manual
    // admission is allowed; a failed episode is never erased by restarting.
    let extendedSafetyStarted = false;
    const extendedSafety = async () => {
      if (!extendedSafetyStarted) {
        await freshCli('safety-ordinary');
        check(activeProfile.limits.travelRadius === 128 && activeProfile.limits.observationRadius === 32 && activeProfile.locator?.enabled !== false, 'original default 128/32 and locator profile required');
        extendedSafetyStarted = true;
      }
      await h.resetScene();
    };
    const waterTrigger = async (goalId: string) => {
      const atMs = Date.now();
      await h.triggerTeleport(BOT, LAYOUT.water.submerged, 'recorded water hazard trigger; not autonomous movement/outcome credit');
      const episode = await h.waitEvent((e) => e.type === 'safety_episode_started' && e.suspended?.goalId === goalId && timeOf(e) >= atMs, 10_000, 'current local water episode');
      check(episode.response === 'escape_water', 'only water escape response expected');
      return { atMs, episode };
    };
    const waterFinished = async (episode: Json, ev: string[]) => {
      const end = await h.waitEvent((e) => e.type === 'safety_episode_ended' && e.episodeId === episode.episodeId, 60_000, 'original finite water grant settlement');
      verifyFiniteEpisode(episode, end);
      check(['resolved', 'improved'].includes(end.outcome), `original episode must improve/resolve: ${end.outcome}`);
      await h.waterExitSettled(ev);
      check(!h.events().some((e) => e.type === 'safety_episode_started' && timeOf(e) > timeOf(end)), 'no replacement episode rescues premature release');
      return end;
    };
    const currentProtectedStatus = (goalId: string, episode: Json) => {
      const d = h.dashboard(), s = d.directive.safety;
      return s?.state === 'responding' && s.episodeId === episode.episodeId && s.suspendedGoalId === goalId && s.authority === 'owner_goal' && s.connectionEpoch === d.connection.epoch ? d : undefined;
    };

    await h.scenarioRun('O7P', 'water intervention during an actual in-flight subscription planner request, before its real response', only, async (ev) => {
      await extendedSafety(); await h.waterScene(); await h.verifyWaterGeometry();
      const goal = await h.goal('follow me');
      let pending: Json | undefined;
      await h.waitForTruth('genuine current subscription planner turn', async () => {
        pending = pendingRealTurn(h.events(), h.journal(), goal.goalId);
        return Boolean(pending);
      }, 30_000);
      // No simulated delay, extra turn or retry to manufacture the race.
      check(pendingRealTurn(h.events(), h.journal(), goal.goalId)?.requestId === pending!.requestId, 'staging_unready: real planner already settled before trigger');
      const { atMs, episode } = await waterTrigger(goal.goalId);
      await h.waitForTruth('fresh planner-wait safety status', async () => Boolean(currentProtectedStatus(goal.goalId, episode)), 2_000);
      await h.waitEvent((e) => e.type === 'planner_turn_completed' && e.requestId === pending!.requestId, 60_000, 'same actual planner completion');
      await h.waitForTruth('same actual raw planner response retained', async () => h.journal().some((e) => e.type === 'planner_proposal_raw' && e.requestId === pending!.requestId), 2_000);
      verifyPlannerWaterRace(h.events(), h.journal(), goal.goalId, pending!.requestId, episode, atMs);
      const end = await waterFinished(episode, ev);
      h.noQuestions(goal.goalId, goal.from, ev);
      check(h.events().filter((e) => e.type === 'goal_admitted' && e.goalId === goal.goalId).length === 1 && !h.events().some((e) => e.type === 'goal_terminal' && e.goalId === goal.goalId && e.reason === 'outcome_verified'), 'planner-wait water never readmits/completes follow');
      ev.push(`actual request ${pending!.requestId}: start ${pending!.t}, intervention ${episode.t}, completion ${h.events().find((e) => e.type === 'planner_turn_completed' && e.requestId === pending!.requestId)!.t}; original episode ${end.outcome}`);
    });

    await h.scenarioRun('O7R', 'active ordinary follow lease preempted by water then freshly resumes the same goal/epoch/counters', only, async (ev) => {
      await extendedSafety(); await h.waterScene(); await h.verifyWaterGeometry();
      await h.triggerTeleport(OWNER, LAYOUT.safety.eastOwner, 'visible owner staging for actual ordinary movement');
      const origin = await h.position(), motionSince = Date.now();
      const goal = await h.goal('follow me');
      const action = await h.ownedMotion(goal.goalId, origin, motionSince, ['follow_entity', 'move_near', 'seek_owner']);
      const before = h.dashboard();
      check(before.directive.goal?.id === goal.goalId && before.directive.goal.outcome, 'code-bound ordinary outcome before preemption');
      check(!h.events().some((e) => e.type === 'skill_outcome' && e.actionId === action.actionId), 'staging_unready: original action no longer active');
      const { episode } = await waterTrigger(goal.goalId);
      verifyPreemption(h.events(), episode, action, before.directive.goal.epoch);
      await h.waitForTruth('fresh active-work safety status', async () => Boolean(currentProtectedStatus(goal.goalId, episode)), 2_000);
      const end = await waterFinished(episode, ev);
      // Same instruction; the owned owner's movement only tests continuation.
      // No replacement goal or fresh admission/grant is supplied here.
      const p = await h.position();
      const ownerAt = distance(p, LAYOUT.water.owner) > 4 ? LAYOUT.water.owner : LAYOUT.safety.eastOwner;
      await h.triggerTeleport(OWNER, ownerAt, 'compatible original follow after water release; no new owner command');
      const resumed = await h.ownedMotion(goal.goalId, p, timeOf(end), ['follow_entity', 'move_near', 'seek_owner'], 30_000);
      check(resumed.leaseId !== action.leaseId && resumed.actionId !== action.actionId, 'fresh fenced lease/action after preemption');
      verifySafetyOwnership(h.events(), h.journal(), goal.goalId, before, h.dashboard());
      h.noQuestions(goal.goalId, goal.from, ev);
      ev.push(`active ${action.capability}/${action.actionId}/lease${action.leaseId} revoked; ${episode.episodeId} settled; ${resumed.capability}/${resumed.actionId}/lease${resumed.leaseId} resumed SAME owner job`);
    });

    await h.scenarioRun('O7F', 'far unseen owner route/cue water protection survives genuine cue withdrawal with finite unchanged authority', only, async (ev) => {
      await extendedSafety(); await h.waterScene(); await h.verifyWaterGeometry();
      const commands = ownerStandingCommands(LAYOUT.safety.farOwner, OWNER);
      for (const command of [commands.support, commands.feet, commands.head]) check(fixtureEntityTest(await h.read(command)) === true, 'staging_unready: additional OWNER-only point must be loaded, supported and air');
      check(fixtureEntityTest(await h.read(commands.occupants)) === false, 'staging_unready: additional OWNER-only body occupied/unknown');
      await h.triggerTeleport(OWNER, LAYOUT.safety.farOwner, 'approved owner-only far cue point; no block writes or bot travel outside scene');
      const guard = h.guardFarScene();
      try {
        await h.waitForTruth('fresh actionable far owner cue', async () => h.dashboard().directive.autonomy?.locator?.actionable === true, 15_000);
        const ownerBefore = await h.entityPosition(OWNER);
        const snapshot = await h.observe(); verifyHiddenOwner(snapshot, LAYOUT.safety.farOwner);
        check(distance(ownerBefore, LAYOUT.safety.farOwner) < 0.1 && distance(await h.entityPosition(OWNER), LAYOUT.safety.farOwner) < 0.1, 'staging_unready: grounded owned far player readbacks must surround the actual observation');
        const origin = await h.position(), since = Date.now();
        const goal = await h.goal('follow me');
        const action = await h.ownedMotion(goal.goalId, origin, since, ['seek_owner']);
        const before = h.dashboard(), route = before.directive.autonomy?.route;
        check(route?.state === 'leg_active' && route.legsUsed >= 1 && before.directive.autonomy.locator.actionable && before.directive.autonomy.locator.direction?.includes('east'), 'actual current counted route leg toward a fresh coarse east cue');
        verifyHiddenOwner(await h.observe(), LAYOUT.safety.farOwner);
        check(!h.events().some((e) => e.type === 'skill_outcome' && e.actionId === action.actionId), 'staging_unready: far route action must still be active');
        const { episode } = await waterTrigger(goal.goalId);
        verifyPreemption(h.events(), episode, action, before.directive.goal.epoch);
        const withdrawalAtMs = Date.now();
        h.owner!.setControlState('sneak', true);
        h.interventions.push({ atMs: withdrawalAtMs, scenario: h.scenario, command: 'FixtureOwner setControlState(sneak,true)', reply: 'owned client request; server untrack must independently follow', why: 'genuine cue withdrawal while water safety still owns its finite grant' });
        const withdrawn = await h.waitEvent((e) => e.type === 'locator_owner_state' && timeOf(e) >= withdrawalAtMs && /^(untracked:|none:)/.test(e.state), 10_000, 'actual server cue withdrawal');
        check(!h.events().some((e) => e.type === 'safety_episode_ended' && e.episodeId === episode.episodeId), 'staging_unready: cue withdrawal occurred after the water episode');
        await h.waitForTruth('withdrawn cue plus current protected water status', async () => {
          const d = h.dashboard();
          if (d.directive.autonomy?.locator?.actionable !== false || d.directive.safety?.episodeId !== episode.episodeId) return false;
          if (!currentProtectedStatus(goal.goalId, episode)) return false;
          verifySafetyOwnership(h.events(), h.journal(), goal.goalId, before, d);
          return true;
        }, 2_000);
        const end = await waterFinished(episode, ev);
        const after = h.dashboard(), nextRoute = after.directive.autonomy?.route;
        check(nextRoute && nextRoute.maxLegs === route.maxLegs && nextRoute.maxTotalDistance === route.maxTotalDistance && nextRoute.legsUsed === route.legsUsed && nextRoute.distanceUsed >= route.distanceUsed && nextRoute.remainingMs <= route.remainingMs, 'cue withdrawal/safety never refills route allowance or starts an undirected leg');
        verifyHiddenOwner(await h.observe(), LAYOUT.safety.farOwner);
        check(!h.events().some((e) => e.type === 'goal_terminal' && e.goalId === goal.goalId && e.reason === 'outcome_verified'), 'unseen-owner safety cannot complete follow');
        h.noQuestions(goal.goalId, goal.from, ev);
        await h.quiesce(); // before route travel can ever leave the original scene
        guard.assert();
        const stopped = await h.position(); await sleep(1_000);
        check(distance(stopped, await h.position()) < 0.6, 'explicit stop leaves no far-route/safety motion');
        ev.push(`route ${route.legsUsed}/${route.maxLegs} used ${route.distanceUsed}->${nextRoute.distanceUsed}, cue withdrawn ${withdrawn.t} before finite ${end.t}; hidden current owner protected`);
      } finally {
        await h.quiesce();
        await guard.close();
        h.owner!.setControlState('sneak', false);
        await h.triggerTeleport(OWNER, LAYOUT.water.owner, 'return owned far player only after explicit goal stop');
      }
      guard.assert();
    });

    await h.scenarioRun('O8C', 'equipped ordinary follow retreats from an effect-free tagged visible creeper without attacks', only, async (ev) => {
      await extendedSafety(); await h.verifyDryMobGeometry();
      await h.triggerTeleport(BOT, LAYOUT.safety.dryBot, 'original dry mob origin');
      await h.armSafetyControl();
      check(!/peaceful/i.test(await h.read('difficulty')), 'staging_unready: unchanged non-peaceful fixture required');
      await h.setup(`summon creeper ${LAYOUT.safety.creeper.x} ${LAYOUT.safety.creeper.y} ${LAYOUT.safety.creeper.z} {PersistenceRequired:1b,Tags:["og_o8c"]}`);
      await h.waitForTruth('actual visible tagged creeper packets', async () => Boolean(Object.values(h.owner!.entities).find((e) => e.uuid === h.sceneActors.get('og_o8c')?.uuid)), 5_000);
      await h.effectFreeCreeper('og_o8c');
      const staged = await h.mobIdentity('og_o8c', 'minecraft:creeper');
      check(distance(await h.position(), staged.position) >= 4.5, 'staging_unready: initial non-exploding visible creeper separation required');
      await h.verifyDryMobGeometry(); await h.effectFreeCreeper('og_o8c');
      const since = Date.now(), goal = await h.goal('follow me');
      const ep = await h.waitEvent((e) => e.type === 'safety_episode_started' && e.suspended?.goalId === goal.goalId && timeOf(e) >= since, 15_000, 'ordinary local creeper retreat');
      check(ep.response === 'retreat' && ep.hazards.includes('creeper'), 'equipped creeper must remain avoidance-only');
      const end = await h.waitEvent((e) => e.type === 'safety_episode_ended' && e.episodeId === ep.episodeId, 60_000, 'finite creeper response');
      verifyFiniteEpisode(ep, end); verifyNoAttacks(h.events(), since);
      check(['resolved', 'improved'].includes(end.outcome) && await h.health(BOT) > 0, 'bot survives original bounded retreat');
      const current = await h.mobIdentity('og_o8c', 'minecraft:creeper');
      check(current.uuid === staged.uuid && distance(await h.position(), current.position) >= 4.5, 'same server creeper and safe final separation required');
      await h.effectFreeCreeper('og_o8c'); await h.verifyDryMobGeometry();
      check(!h.events().some((e) => e.type === 'goal_terminal' && e.goalId === goal.goalId && e.reason === 'outcome_verified'), 'creeper safety does not complete follow');
      h.noQuestions(goal.goalId, goal.from, ev);
      ev.push(`tagged current creeper ${staged.uuid}; effect-free before/after; equipped ${ep.response}->${end.outcome}; no attacks, supported dry geometry retained`);
    });

    await h.scenarioRun('O8N', 'verified unprovoked wolf, passive cow and visible owner: no intervention, attacks or damage', only, async (ev) => {
      await extendedSafety(); await h.verifyDryMobGeometry();
      await h.triggerTeleport(BOT, LAYOUT.safety.dryBot, 'original dry neutral-control origin');
      await h.triggerTeleport(OWNER, { x: 205.5, y: -60, z: 207.5 }, 'owned visible passive-control owner within follow radius');
      await h.armSafetyControl();
      for (const [kind, at, tag] of [['cow', LAYOUT.safety.cow, 'og_o8n_cow'], ['wolf', LAYOUT.safety.wolf, 'og_o8n_wolf']] as const) await h.setup(`summon ${kind} ${at.x} ${at.y} ${at.z} {PersistenceRequired:1b,Tags:["${tag}"]}`);
      await h.waitForTruth('both current tagged neutral/passive observer identities', async () => ['og_o8n_cow', 'og_o8n_wolf'].every((tag) => Object.values(h.owner!.entities).some((e) => e.uuid === h.sceneActors.get(tag)?.uuid)), 5_000);
      const cow = await h.mobIdentity('og_o8n_cow', 'minecraft:cow'), wolf = await h.mobIdentity('og_o8n_wolf', 'minecraft:wolf');
      await h.unprovokedWolf('og_o8n_wolf'); await h.verifyDryMobGeometry();
      const snapshot = await h.observe(); check(snapshot.owner.visible === true, 'staging_unready: actual owner visibility required');
      const health = { bot: await h.health(BOT), owner: await h.health(OWNER) };
      check(health.bot === 20 && health.owner === 20, 'staging_unready: full stable control-player health required before the no-damage window');
      const damage: Json[] = [];
      const onDamage = (p: { entityId: number; sourceCauseId: number }) => { damage.push({ ...p, atMs: Date.now() }); };
      h.owner!._client.on('damage_event', onDamage);
      try {
        const since = Date.now(), episodes = h.events().filter((e) => e.type === 'safety_episode_started').length;
        const goal = await startFollowing();
        await sleep(4_000);
        await h.quiesce();
        const nowCow = await h.mobIdentity('og_o8n_cow', 'minecraft:cow'), nowWolf = await h.mobIdentity('og_o8n_wolf', 'minecraft:wolf');
        await h.unprovokedWolf('og_o8n_wolf'); await h.verifyDryMobGeometry();
        verifyNoAttacks(h.events(), since);
        check(h.events().filter((e) => e.type === 'safety_episode_started').length === episodes, 'unprovoked wolf/cow/owner never authorize a safety intervention');
        check(damage.length === 0 && nowCow.uuid === cow.uuid && nowWolf.uuid === wolf.uuid && nowCow.health === cow.health && nowWolf.health === wolf.health && await h.health(BOT) === health.bot && await h.health(OWNER) === health.owner, 'no control entity/player damage or identity substitution');
        check(h.dashboard().directive.safety?.counters.attacksSent === 0, 'same service history records zero attacks across these controls');
        h.noQuestions(goal.goalId, goal.from, ev);
        ev.push(`unprovoked UUID ${wolf.uuid}, passive UUID ${cow.uuid}, owner visible; no damage packets/health loss/attacks/episodes, explicit stop retained`);
      } finally { h.owner!._client.removeListener('damage_event', onDamage); }
    });

    await h.scenarioRun('RC1', 'resource job: partial new logs, death, own recovery, same-goal remaining work without double credit', only, async (ev) => {
      await freshCli('rc1'); await h.resetScene(); await h.buildGatherSources();
      await h.setup(`give ${BOT} minecraft:oak_log 8`);
      const goal = await h.goal('Gather ten additional oak logs.'); h.say('resume');
      await h.waitForTruth('verified partial acquisition before death', async () => { const n = (await h.inventory())['minecraft:oak_log'] ?? 0; return n > 8 && n < 18; }, GOAL_TIMEOUT_MS);
      const held = (await h.inventory())['minecraft:oak_log']!;
      await h.interruptByDeath(goal.goalId);
      const continued = await waitContinued(goal.goalId);
      const own = h.events().filter((e) => e.type === 'survival_regained' || e.type === 'survival_incident_return');
      check(own.some((e) => e.key === 'minecraft:oak_log'), 'actual server-attributed own returns occurred');
      const line = continued.bound.counts.find((c: Json) => c.basis === 'possession');
      // The kill may race one last pickup after the pre-death RCON sample.
      // Use the packet-frozen held count at interruption for exact credit.
      check(line && line.held > 8 && line.credited > 0 && line.credited <= line.held-8, 'restored credit excludes the eight old logs from the frozen count');
      const end = await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goal.goalId && Date.parse(String(e.t)) > Date.parse(String(continued.bound.t)), GOAL_TIMEOUT_MS, 'continued original resource outcome');
      check(end.reason === 'outcome_verified' && end.state === 'completed', 'original resource outcome verified');
      check((await h.inventory())['minecraft:oak_log']! >= 18, 'server holds original eight plus ten new logs');
      h.noQuestions(goal.goalId, goal.from, ev);
      ev.push(`baseline 8, pre-death ${held}, carried credit ${line.credited}; same goal ${goal.goalId}, epoch ${continued.admission.epoch}; final ${JSON.stringify(await h.inventory())}`);
    });

    await h.scenarioRun('RC2', 'persistent follow: own recovery freshly resumes the same logical job without claiming completion', only, async (ev) => {
      await freshCli('rc2-follow'); await h.resetScene();
      const goal = await startFollowing(); h.say('resume');
      await h.interruptByDeath(goal.goalId);
      const c = await waitContinued(goal.goalId);
      await h.waitEvent((e) => e.type === 'task_admitted' && e.goalId === goal.goalId && e.epoch === c.admission.epoch, GOAL_TIMEOUT_MS, 'fresh follow task');
      await sleep(2_000);
      check(!h.events().some((e) => e.type === 'goal_terminal' && e.goalId === goal.goalId && e.reason === 'outcome_verified'), 'recovery never completes persistent follow');
      h.noQuestions(goal.goalId, goal.from, ev);
      ev.push(`same follow ${goal.goalId} resumed epoch ${c.admission.epoch}; original outcome/baseline/caps/deadline preserved; fresh task identity`);
    });

    await h.scenarioRun('RC2H', 'partial house: original durable project and verified placements survive death, recovery and fresh continuation', only, async (ev) => {
      await freshCli('rc2-house'); await h.resetScene();
      for (const c of [`give ${BOT} minecraft:cobblestone 64`, `give ${BOT} minecraft:crafting_table 1`, `give ${BOT} minecraft:furnace 1`, `give ${BOT} minecraft:chest 1`]) await h.setup(c);
      const at = LAYOUT.houseOwner; await h.setup(`tp ${OWNER} ${at.x} ${at.y} ${at.z}`);
      const goal = await h.goal('Set up your house here.'); h.say('resume');
      const placed = await h.waitEvent((e) => e.type === 'task_action' && e.goalId === goal.goalId && e.evidence?.placed && e.status === 'succeeded', GOAL_TIMEOUT_MS, 'first server-confirmed construction cell');
      await h.interruptByDeath(goal.goalId);
      const c = await waitContinued(goal.goalId);
      const end = await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goal.goalId && Date.parse(String(e.t)) > Date.parse(String(c.bound.t)), 30*60_000, 'remaining original construction');
      check(end.reason === 'outcome_verified' && end.state === 'completed', 'same home outcome verified');
      const builds = h.goalActions(goal.goalId).filter((a) => a.evidence?.placed && a.status === 'succeeded');
      const coordinate = (a: Json) => JSON.stringify(a.evidence.at);
      check(builds.filter((a) => coordinate(a) === coordinate(placed) && a.evidence.placed === placed.evidence.placed).length === 1, 'verified original cell was not placed again');
      check(await h.blockIs(placed.evidence.at, placed.evidence.placed), 'original placed cell still agrees with server');
      h.noQuestions(goal.goalId, goal.from, ev);
      ev.push(`partial placement ${coordinate(placed)} preserved; same project/outcome/job ${goal.goalId}; ${builds.length} server-confirmed cells; no duplicate original placement`);
    });

    await h.scenarioRun('RC2C', 'craft/equipment: historical craft credit survives death while current equipment is freshly verified', only, async (ev) => {
      await freshCli('rc2-craft'); await h.resetScene();
      await h.setup(`give ${BOT} minecraft:oak_log 6`);
      const goal = await h.goal('Craft sixteen oak planks and equip a wooden pickaxe.'); h.say('resume');
      const first = await h.waitEvent((e) => e.type === 'task_action' && e.goalId === goal.goalId && e.capability === 'craft_item' && e.status === 'succeeded', GOAL_TIMEOUT_MS, 'first verified craft');
      await h.interruptByDeath(goal.goalId);
      const c = await waitContinued(goal.goalId);
      const end = await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === goal.goalId && Date.parse(String(e.t)) > Date.parse(String(c.bound.t)), GOAL_TIMEOUT_MS, 'remaining craft and current equipment');
      check(end.state === 'completed' && end.reason === 'outcome_verified', 'original compound outcome verified');
      check(/minecraft:wooden_pickaxe/.test(await h.query(`data get entity ${BOT} SelectedItem.id`)), 'server confirms currently equipped pickaxe');
      const originalEffects = c.bound.counts.filter((n: Json) => n.basis === 'effect');
      check(originalEffects.length > 0 && originalEffects.some((n: Json) => n.credited > 0), 'verified historical craft credit carried rather than replayed');
      h.noQuestions(goal.goalId, goal.from, ev);
      ev.push(`first craft ${first.actionId}; original effect credit ${JSON.stringify(originalEffects)}; current server equipment verified`);
    });

    await h.scenarioRun('RC3', 'held job: stop/resume, new owner intake and process restart never replay the checkpoint', only, async (ev) => {
      await freshCli('rc3'); await h.resetScene();
      const goal = await startFollowing();
      await h.interruptByDeath(goal.goalId); // Automatic latch remains paused: hold recovery for this adverse gate.
      h.say('stop');
      await h.waitEvent((e) => e.type === 'continuation_checkpoint' && e.goalId === goal.goalId && e.state === 'stopped_by_owner', 15_000, 'explicit checkpoint fence');
      h.say('resume'); await sleep(3_000);
      check(!h.events().some((e) => e.type === 'goal_admitted' && e.goalId === goal.goalId && e.continuation), 'resume cannot revive the stopped job');
      const replacement = await h.goal('Stand next to me.');
      check(replacement.goalId !== goal.goalId, 'new owner command has a distinct job');
      await h.quiesce();
      h.noQuestions(goal.goalId, goal.from, ev);
      // Keep the same durable scope, but start an actual new CLI session.
      const prior = h.events(); await freshCli('rc3-restart', false);
      h.cli!.send('status'); await sleep(1_000);
      check(!h.events().some((e) => e.type === 'goal_admitted' && [goal.goalId,replacement.goalId].includes(e.goalId)), 'restart replays neither checkpoint nor replacement');
      check(prior.some((e) => e.type === 'continuation_checkpoint' && e.goalId === goal.goalId), 'original failed/held evidence retained in the first run');
      check(questionLines(h.cli!.since(0)).length === 0, 'no question after process restart');
      ev.push(`stopped ${goal.goalId}; resume did not revive it; new job ${replacement.goalId}; separate CLI process restart has no replay`);
    });

    await h.scenarioRun('RC3N', 'new owner command synchronously supersedes an unfenced held checkpoint', only, async (ev) => {
      await freshCli('rc3-new-owner'); await h.resetScene();
      const old = await startFollowing(); await h.interruptByDeath(old.goalId);
      const next = await h.goal('Stand next to me.');
      await h.waitEvent((e) => e.type === 'continuation_checkpoint' && e.goalId === old.goalId && e.state === 'superseded_by_owner', 15_000, 'new intake fences held work');
      check(next.goalId !== old.goalId && !h.events().some((e) => e.type === 'goal_admitted' && e.goalId === old.goalId && e.continuation), 'held old job never reacquires ownership');
      h.noQuestions(old.goalId, old.from, ev);
      ev.push(`held ${old.goalId} superseded by ${next.goalId}, no continuation or old task replay`);
    });

    await h.scenarioRun('RC3D', 'another death during actual recovery retains the owner checkpoint and bounded recovery allowance', only, async (ev) => {
      await freshCli('rc3-recovery-death'); await h.resetScene();
      const old = await startFollowing(); h.say('resume'); await h.interruptByDeath(old.goalId);
      const recovery = await h.waitEvent((e) => e.type === 'survival_support_admitted' && e.routine === 'death_recovery', GOAL_TIMEOUT_MS, 'first actual supporting recovery');
      const original = h.events().find((e) => e.type === 'continuation_checkpoint' && e.goalId === old.goalId && e.state === 'held')!;
      await h.setup(`kill ${BOT}`);
      await h.waitEvent((e) => e.type === 'goal_terminal' && e.goalId === recovery.goalId && e.reason === 'death', 20_000, 'support death revocation');
      await sleep(5_000);
      const linked = h.events().filter((e) => e.type === 'survival_death_captured');
      check(linked.length >= 2, 'both own deaths were packet-captured');
      const attempts = h.events().filter((e) => e.type === 'survival_support_admitted' && e.routine === 'death_recovery');
      for (const id of new Set(attempts.map((e) => e.episodeId ?? h.events().find((a) => a.type === 'goal_admitted' && a.goalId === e.goalId)?.source?.episodeId))) check(attempts.filter((e) => (e.episodeId ?? h.events().find((a) => a.type === 'goal_admitted' && a.goalId === e.goalId)?.source?.episodeId) === id).length <= 2, 'each recovery episode keeps its finite attempt ceiling');
      for (const cp of h.events().filter((e) => e.type === 'continuation_checkpoint' && e.goalId === old.goalId)) {
        check(cp.deadlineAtMs === original.deadlineAtMs && cp.outcomeCanonical === original.outcomeCanonical && JSON.stringify(cp.caps) === JSON.stringify(original.caps), 'another recovery death never refills owner authority');
      }
      h.noQuestions(old.goalId, old.from, ev);
      ev.push(`owner ${old.goalId} retained; ${linked.length} actual deaths; ${attempts.length} recovery admissions; original owner deadline/outcome/caps unchanged`);
    });

    await h.scenarioRun('RC4', 'without a held owner job: actual recovery concludes then fresh useful progression is admitted', only, async (ev) => {
      await freshCli('rc4'); await h.resetScene(); await h.buildGatherSources();
      // Fresh process/scope with no manual directive. Death is the only operator
      // trigger; no old sentence, handle, inventory or task is replayed.
      await h.setup(`kill ${BOT}`); h.say('resume');
      const recovery = await h.waitEvent((e) => e.type === 'survival_support_admitted' && e.routine === 'death_recovery', GOAL_TIMEOUT_MS, 'ordinary automatic recovery');
      const done = await h.waitEvent((e) => e.type === 'survival_support_ended' && e.goalId === recovery.goalId && e.state === 'completed', GOAL_TIMEOUT_MS, 'code-verified recovery conclusion');
      const next = await h.waitEvent((e) => e.type === 'goal_admitted' && e.source?.kind === 'progression' && Date.parse(String(e.t)) > Date.parse(String(done.t)), GOAL_TIMEOUT_MS, 'fresh progression after recovery');
      await h.waitEvent((e) => e.type === 'task_action' && e.goalId === next.goalId && e.status === 'succeeded', GOAL_TIMEOUT_MS, 'useful ordinary progression action');
      check(!h.events().some((e) => e.type === 'goal_continuation_bound'), 'no held owner job invented');
      ev.push(`support recovery ${recovery.goalId} completed, fresh progression ${next.goalId} performed verified work`);
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
        await h.quiesce();
        return 'owned CLI acknowledged stop before restoration';
      });
    }
    if (h.forceloadBefore) {
      await step('entities', async () => {
        await h.removeSceneActors();
        check(/Test passed/i.test(await h.query(`execute unless entity @e[type=!player,${ENTITY_BOX}]`)), 'no scene entities after cleanup');
        return 'bounded recorded-UUID/drop removal and server proof of no scene entities; foreign occupancy refuses removal';
      });
      await step('blocks', async () => {
        await h.noForeignSceneActors();
        for (const c of h.blockResetCommands()) await h.setup(c);
        const samples: V3[] = [...LAYOUT.birchLogs, ...LAYOUT.oakTrees.flatMap((t): V3[] => [...t.logs]), ...LAYOUT.gather.trunks.map((p) => ({ ...p, y: -60 })), LAYOUT.water.submerged, { x: LAYOUT.houseOwner.x - 0.5, y: -60, z: LAYOUT.houseOwner.z - 0.5 }];
        for (const p of samples) if (!(await h.blockIs({ x: Math.floor(p.x), y: p.y, z: Math.floor(p.z) }, 'minecraft:air'))) throw new Error(`area not restored at ${p.x},${p.y},${p.z}`);
        return `standard area reset applied and ${samples.length} sample positions verified air`;
      });
      for (const [name, command] of [['bot-inventory', `clear ${BOT}`], ['owner-inventory', `clear ${OWNER}`], ['bot-effects', `effect clear ${BOT}`], ['owner-effects', `effect clear ${OWNER}`]] as const) {
        await step(name, async () => {
          const player = name.startsWith('owner-') ? OWNER : BOT;
          check(/Test passed/i.test(await h.query(`execute if entity @a[name=${player}]`)), 'cleanup player is online');
          const r = await h.setup(command);
          check(/^Removed |^No items were found|no effects to remove/i.test(r.trim()), `${command} failed: ${r}`);
          const field = name.endsWith('effects') ? 'active_effects' : 'Inventory';
          const proof = await h.query(`data get entity ${player} ${field}`);
          check(field === 'Inventory' ? /\[\]$/.test(proof.trim()) : /\[\]$|Found no elements matching/i.test(proof), `server ${field} was not verified empty while ${player} was online: ${proof}`);
          h.note(name, true, `${command}: ${r.slice(0, 80)}; ${proof.slice(0, 120)}`);
        });
      }
      await step('forceload-restore', async () => {
        await h.restoreForceload();
      });
    }
    if (h.cli) await step('cli-quit', async () => { await h.quit(); });
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
    await step('zero-players', async () => {
      let list = '';
      for (let i = 0; i < 40; i++) { list = await h.query('list'); if (/^There are 0 of /i.test(list)) break; await sleep(100); }
      check(/^There are 0 of /i.test(list), `zero players after logout: ${list}`);
      return list;
    });
    const extendedCases = h.results.filter((r) => ['O7P', 'O7R', 'O7F', 'O8C', 'O8N'].includes(r.id)).map((r) => r.id);
    if (extendedCases.length) await step('single-safety-history', async () => {
      check(h.runs.filter((r) => r.name === 'run-safety-ordinary').length === 1, 'exactly one actual CLI for all extended controls');
      verifySharedSafetyHistory(h.safetySamples, extendedCases);
      return `${extendedCases.join(',')} retained one run/connection, monotonic safety counters and original spend cap`;
    });
    const counted = h.results.filter((r) => r.status !== 'skipped');
    const scenariosPass = counted.length > 0 && counted.every((r) => r.status === 'pass');
    const cleanupFailures = h.cleanup.filter((c) => !c.ok);
    const ev = h.runs.flatMap((r) => readJsonl(r.events));
    report = {
      check: `MB-PLAN-006 ordinary-goal live check (REAL subscription planner; Jev ${jevMode === 'real' ? 'REAL' : 'LOOPBACK FAULT (harness validation only)'})`,
      fixture: PINS.profile,
      sourceFreeze: freeze,
      config: { path: h.configPath, base: basePath, dataDir: h.dataDir, houseMaterials: materials, houseInterior: h.houseInterior },
      houseAcceptance: materials === 'gather' ? 'gather and construction' : 'provided-material construction only; does not prove gather acceptance',
      pass: scenariosPass && cleanupFailures.length === 0,
      scenariosPass,
      cleanup: { reconciled: cleanupFailures.length === 0, failures: cleanupFailures, steps: h.cleanup, forceloadBefore: h.forceloadBefore ? [...h.forceloadBefore] : null, areaChunks: AREA_CHUNKS },
      footprint: { blocks: { x: [AREA.x1, AREA.x2], y: [-63, -50], z: [AREA.z1, AREA.z2] }, entityBox: ENTITY_BOX, players: [BOT, OWNER], additionalOwnerOnlyPoint: h.results.some((r) => r.id === 'O7F') ? LAYOUT.safety.farOwner : null },
      results: h.results,
      setup: h.setupLog,
      interventions: h.interventions,
      readbacks: h.readbacks,
      safetySamples: h.safetySamples,
      extendedSafety: { executedCases: extendedCases, runs: h.runs.filter((r) => r.name === 'run-safety-ordinary'), originalRadius: 128, originalO7WRadius: 8 },
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
