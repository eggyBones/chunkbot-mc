// MB-MEM-001 live memory check against the LOCAL loopback test fixture only.
//
// PRE-INTEGRATION harness: until the designated writer installs memory in the
// shared app/CLI, this script composes the REAL connection, SkillRuntime
// (perception, knowledge, ledger, actuator lease), the registered skills plus
// the memory skills, and the MemoryService itself, wiring exactly the hooks
// proposed for the writer (memory.onLifecycle FIRST, recordOutcome after every
// executed action, onGoalAdmitted/beginGoal, onGoalTerminal). No model is
// called: the harness acts as the owner (fixed owner words per goal) and as a
// fixed decision (one grounded candidate per step). Every RCON setup command
// is recorded; server truth is cross-checked over RCON.
//
// An application RESTART is a real process boundary: the orchestrator runs
// `--phase seed` and later `--phase recall` as separate Node processes sharing
// only the run's memory directory. Between them it changes the world over RCON
// (destroys the crafting table, empties the chest) to prove memory is revised
// from fresh evidence instead of asserted.
//
//   npm run build && npm run fixture -- status   (fixture lease required)
//   node scripts/memory-live-check.ts --fixture-lease <lease id> [--fixture 26.2]
//
// Report: var/live-check/<stamp>[-26.2]-memory/report.json (+ phase logs, memory dir).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { randomIds, systemClock, type ActionCandidate, type ExecutionOwner, type ObservationSnapshot, type SkillOutcome } from '../src/contracts/index.ts';
import { MemoryConfigSchema, type MemoryConfig, type MemoryView } from '../src/contracts/memory.ts';
import { SkillExecutorImpl } from '../src/execution/executor.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { MineflayerConnection } from '../src/game/connection.ts';
import { installedMemoryWorld } from '../src/memory/world.ts';
import { inspectMemory } from '../src/memory/report.ts';
import { MemoryService } from '../src/memory/service.ts';
import { allSkills } from '../src/skills/index.ts';
import { memorySkills } from '../src/skills/memory.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { rconCommand } from './lib/rcon.ts';
import { SCENE, sceneClearCommands, sceneCommands } from './lib/scene.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const SUFFIX = PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${PINS.profile}`;
const fx = fixturePaths(PROJECT_ROOT, PINS);
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PHASE = arg('--phase');

// Scene additions (inside the reset area x 196..224, z 190..224).
const TABLE = { x: 207, y: -60, z: 207 };
const HOME = { x: 205.5, y: -60, z: 205.5 }; // = scene start
const WALL = [
  { x: 206, y: -60, z: 200 },
  { x: 207, y: -60, z: 200 },
];
const AWAY = { x: 214.5, y: -60, z: 196.5 }; // ~13 blocks from home, inside the scene area

interface Result {
  id: string;
  title: string;
  pass: boolean;
  evidence: string[];
}

function rconPassword(): string {
  const line = readFileSync(fx.properties, 'utf8').split('\n').find((l) => l.startsWith('rcon.password='));
  if (!line) throw new Error('fixture RCON password missing');
  return line.slice('rcon.password='.length).trim();
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function memoryConfig(revision = 1): MemoryConfig {
  return MemoryConfigSchema.parse({ worldProfile: `memory-live-${PINS.profile.replace(/\./g, '-')}`, worldRevision: revision, botProfile: 'chunkbot' });
}

// ====================================================================== shared phase runtime

class Phase {
  readonly results: Result[] = [];
  readonly setupLog: Array<{ atMs: number; command: string; reply: string }> = [];
  readonly outDir: string;
  readonly store = new MemoryRunStore();
  readonly game: MineflayerConnection;
  readonly memory: MemoryService;
  readonly runtime: SkillRuntime;
  readonly executor: SkillExecutorImpl;
  epoch = 0;
  goalId = '';
  private rconQueue: Promise<unknown> = Promise.resolve();
  private readonly password = rconPassword();
  readonly outcomes: SkillOutcome[] = [];

  constructor(outDir: string, memoryRoot: string) {
    this.outDir = outDir;
    const loaded = loadConfigFile(join(PROJECT_ROOT, PINS.inferenceFreeConfig));
    const config = loaded.config;
    this.game = new MineflayerConnection({
      host: config.minecraft.host,
      port: config.minecraft.port,
      version: config.minecraft.version,
      auth: config.bot.auth,
      username: config.bot.username,
      authDir: loaded.authDir,
      joinTimeoutMs: config.minecraft.joinTimeoutMs,
      replyMode: config.chat.replyMode,
      log: () => undefined,
      ...(config.owner.name ? { ownerName: config.owner.name } : {}),
    });
    this.memory = new MemoryService({ config: memoryConfig(), rootDir: memoryRoot, endpoint: `${config.minecraft.host}:${config.minecraft.port}`, clock: systemClock, record: (e) => this.store.record(e) });
    this.runtime = new SkillRuntime({
      config,
      session: () => this.game.session(),
      connectionEpoch: () => this.game.connectionEpoch,
      goalEpoch: () => this.epoch,
      diagnosticCurrent: () => false,
      admission: () => this.game.admissionContext(),
      store: this.store,
      clock: systemClock,
      ids: randomIds,
    });
    this.memory.attachWorld(installedMemoryWorld({ session: () => this.game.session(), perception: this.runtime.perception, ledger: this.runtime.ledger, clock: systemClock }));
    // Proposed writer wiring: memory FIRST (sync death capture before invalidation), then the skill layer.
    this.game.onLifecycle((event) => {
      this.memory.onLifecycle(event);
      this.runtime.onLifecycle(event);
    });
    this.executor = new SkillExecutorImpl({
      registry: new SkillRegistry([...allSkills(), ...memorySkills(this.memory)]),
      leases: this.runtime.leases,
      session: () => this.game.session(),
      services: this.runtime.services,
      goalEpoch: () => this.epoch,
      store: this.store,
    });
  }

  async rcon(command: string, record = true): Promise<string> {
    const run = this.rconQueue.then(() => rconCommand(PINS.host, PINS.rconPort, this.password, command));
    this.rconQueue = run.catch(() => undefined);
    const reply = await run;
    if (record) this.setupLog.push({ atMs: Date.now(), command, reply: reply.slice(0, 300) });
    return reply;
  }

  async serverPos(): Promise<{ x: number; y: number; z: number }> {
    const r = await this.rcon('data get entity Chunkbot Pos', false);
    const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(r);
    if (!r.startsWith('Chunkbot has the following entity data:') || !m) throw new Error(`cannot read Chunkbot position: ${r.slice(0, 120)}`);
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  }

  async blockIs(p: { x: number; y: number; z: number }, block: string): Promise<boolean> {
    return /passed/i.test(await this.rcon(`execute if block ${p.x} ${p.y} ${p.z} ${block}`, false));
  }

  async check(id: string, title: string, fn: (ev: string[]) => Promise<void>): Promise<void> {
    const evidence: string[] = [];
    const started = Date.now();
    try {
      await fn(evidence);
      this.results.push({ id, title, pass: true, evidence });
      process.stdout.write(`PASS ${id} ${title} (${Date.now() - started}ms)\n`);
    } catch (error) {
      evidence.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
      this.results.push({ id, title, pass: false, evidence });
      process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)?.slice(0, 600)}\n`);
    }
  }

  async connect(): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 40_000);
    try {
      await this.game.connect(abort.signal);
    } finally {
      clearTimeout(timer);
    }
    await sleep(1_500);
  }

  /** Goal admission as the goal engine would do it: new epoch, travel anchor, owner words. */
  admit(goalId: string, instruction: string): void {
    this.epoch += 1;
    this.goalId = goalId;
    this.runtime.onGoalAdmitted({ goalId, epoch: this.epoch, admittedAtMs: Date.now() });
    this.memory.beginGoal({ goalId, epoch: this.epoch, instruction });
  }

  end(reason: string, detail: string): void {
    this.memory.onGoalTerminal({ goalId: this.goalId, reason, detail });
  }

  snapshot(): ObservationSnapshot {
    const s = this.runtime.perception.take(this.epoch);
    assert(s, 'no observation (not connected)');
    return s;
  }

  view(instruction: string, requestId: string): MemoryView {
    const s = this.snapshot();
    return this.memory.view({ subject: { kind: 'goal', goalId: this.goalId as `goal-${string}`, goalEpoch: this.epoch }, requestId, instruction, observation: { dimension: s.dimension, self: s.self, connectionEpoch: s.connectionEpoch } });
  }

  /** Executes one grounded candidate for the current goal (fixed decision), then records it in memory. */
  async act(capability: string, parameters: Record<string, unknown>, snapshot?: ObservationSnapshot, timeoutMs = 60_000): Promise<SkillOutcome> {
    const snap = snapshot ?? this.snapshot();
    const candidate: ActionCandidate = {
      id: randomIds.next('act') as ActionCandidate['id'],
      capability,
      parameters: parameters as ActionCandidate['parameters'],
      snapshotId: snap.id,
      connectionEpoch: snap.connectionEpoch,
      goalEpoch: this.epoch,
      description: `${capability} (memory live check)`,
      criteria: [],
      preconditions: [],
      timeoutMs,
    };
    const owner: ExecutionOwner = { kind: 'goal', goalEpoch: this.epoch, goalId: this.goalId, taskId: randomIds.next('task') };
    const outcome = await this.executor.execute(candidate, new AbortController().signal, owner);
    this.outcomes.push(outcome);
    this.memory.recordOutcome(outcome); // proposed ExecutorDeps.onOutcome
    return outcome;
  }

  handle(snap: ObservationSnapshot, key: string, at: { x: number; y: number; z: number }): { snapshotId: string; handle: string } {
    const b = snap.blocks.find((t) => t.key === key && t.at.x === at.x && t.at.y === at.y && t.at.z === at.z);
    const h = b?.handle ?? this.runtime.perception.blockHandle(snap.id, at.x, at.y, at.z);
    assert(h, `${key} at ${at.x},${at.y},${at.z} is not visible in ${snap.id}`);
    return { snapshotId: snap.id, handle: h };
  }

  async tp(at: { x: number; y: number; z: number }, yaw = 0, pitch = 20): Promise<void> {
    await this.rcon(`tp Chunkbot ${at.x} ${at.y} ${at.z} ${yaw} ${pitch}`);
    await sleep(1_000);
  }

  async finish(name: string): Promise<void> {
    await this.memory.close();
    await this.game.disconnect('operator_stop').catch(() => undefined);
    writeFileSync(join(this.outDir, `phase-${name}.json`), `${JSON.stringify({ phase: name, results: this.results, setup: this.setupLog, outcomes: this.outcomes.map((o) => ({ capability: o.capability, status: o.status, reason: o.reason ?? null, confirmation: o.confirmation, effect: o.effect.slice(0, 300) })), memoryEvents: this.store.events.filter((e) => String(e.type).startsWith('memory_')).slice(-80), status: this.memory.status() }, null, 2)}\n`);
  }
}

const line = (o: SkillOutcome) => `${o.capability} -> ${o.status}${o.reason ? ` (${o.reason})` : ''} [${o.confirmation}]: ${o.effect.slice(0, 200)}`;

// ====================================================================== phase: seed (first app run)

async function seed(outDir: string, memoryRoot: string): Promise<void> {
  const p = new Phase(outDir, memoryRoot);
  const open = p.memory.open();
  for (const c of sceneClearCommands()) await p.rcon(c);
  await sleep(1_600);
  for (const c of sceneCommands()) await p.rcon(c);
  await p.rcon(`setblock ${TABLE.x} ${TABLE.y} ${TABLE.z} crafting_table`);
  await p.rcon(`item replace block ${SCENE.chest.x} ${SCENE.chest.y} ${SCENE.chest.z} container.0 with minecraft:oak_planks 12`);
  await p.rcon(`item replace block ${SCENE.chest.x} ${SCENE.chest.y} ${SCENE.chest.z} container.1 with minecraft:cobblestone 20`);
  await p.connect();
  await p.tp(HOME);

  await p.check('S0', 'fresh scope starts empty (fresh assessment, no imported facts)', async (ev) => {
    ev.push(`open: ${open.state} — ${open.detail}`);
    assert(open.state === 'empty', `expected an empty store, got ${open.state}`);
  });

  await p.check('S1', 'owner designates home: trusted owner_statement, durable, LOCAL memory confirmation (not a server packet)', async (ev) => {
    p.admit('goal-memhome01', 'remember this spot as home');
    const base = p.memory.memoryBaseline();
    const o = await p.act('remember_location', { label: 'home', category: 'home' });
    ev.push(line(o));
    assert(o.status === 'succeeded' && o.confirmation === 'none', 'remember_location succeeded without claiming a world effect');
    const mem = (o.evidence as Json)['memory'] as Json;
    assert(mem?.['confirmation'] === 'local_memory_store' && mem['trust'] === 'trusted', `memory evidence ${JSON.stringify(mem)}`);
    const ev2 = p.memory.evaluateMemoryState({ predicate: 'memory_state', label: 'home', expect: 'recorded' }, { memoryBaseline: base });
    ev.push(`memory_state recorded: ${ev2.status} — ${ev2.detail}`);
    assert(ev2.status === 'satisfied', 'memory_state recorded is satisfied by the durable write');
    const server = await p.serverPos();
    const fact = p.memory.facts().find((f) => f.category === 'home');
    ev.push(`server position ${JSON.stringify(server)}; remembered ${JSON.stringify(fact?.location)}`);
    assert(fact?.location && Math.hypot(fact.location.at.x - server.x, fact.location.at.z - server.z) < 1, 'remembered home matches the server position');
    p.end('outcome_verified', 'home remembered');
  });

  await p.check('S2', 'an ungrounded label (owner never said it) is only an UNVERIFIED note', async (ev) => {
    p.admit('goal-memnote01', 'follow me for a bit');
    const o = await p.act('remember_location', { label: 'treasure', category: 'location' });
    ev.push(line(o));
    assert(o.status === 'partial' && o.reason === 'not_owner_grounded', 'downgraded to a note');
    assert(p.memory.facts().some((f) => f.label === 'treasure' && f.source === 'unverified_note' && !f.location), 'note has no typed location');
    p.end('owner_stop', 'stopped');
  });

  await p.check('S3', 'observed workstation/container and server-synced chest contents (historical) are recorded', async (ev) => {
    p.admit('goal-memchest1', 'check what is in the chest');
    await p.tp({ x: 203.5, y: -60, z: 205.5 }, 0, 30);
    const snap = p.snapshot();
    p.memory.ingestObservation();
    const o = await p.act('inspect_container', { container: p.handle(snap, 'minecraft:chest', SCENE.chest) }, snap);
    ev.push(line(o));
    assert(o.status === 'succeeded' && o.confirmation === 'server_sync', 'inspection server-confirmed');
    const chest = p.memory.facts().find((f) => f.key === 'minecraft:chest' && f.status === 'active');
    ev.push(`chest fact: source=${chest?.source} contents=${JSON.stringify(chest?.container?.contents)}`);
    assert(chest?.container?.contents['minecraft:oak_planks'] === 12, 'historical contents recorded from the server window');
    const table = p.memory.facts().find((f) => f.key === 'minecraft:crafting_table');
    ev.push(`crafting table fact: ${table ? `${table.source} ${JSON.stringify(table.location)}` : 'not seen'}`);
    assert(table?.source === 'observation', 'the visible crafting table is an observation fact');
    p.end('outcome_verified', 'inspected');
  });

  await p.check('S4', 'mined log is a verified resource location (server block update)', async (ev) => {
    p.admit('goal-memwood01', 'get some wood');
    await p.tp({ x: 208.5, y: -60, z: 204.5 }, 180, 10);
    const snap = p.snapshot();
    const o = await p.act('mine_block', { target: p.handle(snap, 'minecraft:oak_log', SCENE.logs[0]!) }, snap, 30_000);
    ev.push(line(o));
    assert(o.status === 'succeeded' || o.status === 'partial', 'log mined');
    const log = p.memory.facts().find((f) => f.key === 'minecraft:oak_log' && f.source === 'verified_skill');
    ev.push(`resource: ${JSON.stringify(log?.location)} (${log?.evidence.at(-1)?.detail})`);
    assert(log, 'verified resource fact');
    p.end('outcome_verified', 'wood');
  });

  await p.check('S5', 'construction stopped after two server-confirmed placements persists only those checkpoints (interrupted project)', async (ev) => {
    p.admit('goal-memwall01', 'build a little cobblestone wall here');
    await p.rcon('give Chunkbot cobblestone 4');
    await p.tp({ x: 206.5, y: -60, z: 198.5 }, 0, 40);
    await sleep(500);
    for (const at of WALL) {
      const snap = p.snapshot();
      const ground = { x: at.x, y: at.y - 1, z: at.z };
      const o = await p.act('place_block', { item: 'minecraft:cobblestone', against: p.handle(snap, 'minecraft:grass_block', ground), face: 'up' }, snap, 15_000);
      ev.push(line(o));
      assert(o.status === 'succeeded' && o.confirmation === 'server_packet', 'placement server-confirmed');
      assert(await p.blockIs(at, 'cobblestone'), `RCON: cobblestone at ${at.x},${at.y},${at.z}`);
    }
    p.end('owner_stop', 'owner said stop mid-build');
    const project = p.memory.facts().find((f) => f.category === 'project');
    ev.push(`project: state=${project?.project?.state} checkpoints=${project?.project?.checkpoints.length} unknown=${project?.project?.unknownEffects.length}`);
    assert(project?.project?.state === 'interrupted' && project.project.checkpoints.length === 2, 'interrupted project with exactly the confirmed checkpoints');
  });

  await p.check('S6', 'own death is captured synchronously before invalidation and persisted (MB-FLOW-003 seam; no recovery policy)', async (ev) => {
    p.admit('goal-memdead01', 'stay here');
    await p.rcon('give Chunkbot iron_pickaxe 1');
    await sleep(500);
    await p.act('inspect_inventory', {}); // a server-confirmed last-alive inventory
    const before = await p.serverPos();
    await p.rcon('kill Chunkbot');
    await sleep(3_000);
    const deaths = p.memory.facts().filter((f) => f.category === 'death');
    const d = deaths.at(-1);
    ev.push(`server position before death ${JSON.stringify(before)}; incident ${JSON.stringify(d?.location)} accuracy=${d?.death?.accuracy} inventory=${d?.death?.lastAliveInventory.source} items=${JSON.stringify(d?.death?.lastAliveInventory.items)}`);
    assert(d?.death && d.location && Math.hypot(d.location.at.x - before.x, d.location.at.z - before.z) < 2, 'incident location matches the server');
    assert(d.death.lastAliveInventory.items.some((i) => i.key === 'minecraft:iron_pickaxe'), 'last-alive inventory recorded with its source');
    p.end('lifecycle_death', 'died');
  });

  await p.finish('seed');
}

// ====================================================================== phase: recall (after restart)

async function recall(outDir: string, memoryRoot: string): Promise<void> {
  const p = new Phase(outDir, memoryRoot);
  const open = p.memory.open();
  await p.check('R0', 'restart: the same scoped facts load from disk with provenance and status', async (ev) => {
    ev.push(`open: ${open.state} rev ${open.revision} — ${open.detail}`);
    ev.push(...p.memory.statusLines());
    assert(open.state === 'ready', `expected ready, got ${open.state}`);
    const f = p.memory.facts();
    assert(f.some((x) => x.category === 'home' && x.source === 'owner_statement' && x.status === 'active'), 'home');
    assert(f.some((x) => x.key === 'minecraft:oak_log' && x.source === 'verified_skill'), 'verified resource');
    assert(f.some((x) => x.category === 'project' && x.project?.state === 'interrupted'), 'interrupted project');
    assert(f.some((x) => x.category === 'death' && x.death?.recovery.status === 'unresolved'), 'unresolved death incident');
  });

  await p.connect();
  await p.check('R1', 'restart replays nothing: no action, no block change after reconnect while idle', async (ev) => {
    const ledgerBefore = p.runtime.ledger.since(0).length;
    await sleep(3_000);
    ev.push(`ledger entries after idle reconnect: ${p.runtime.ledger.since(0).length - ledgerBefore}; skill outcomes: ${p.outcomes.length}`);
    assert(p.outcomes.length === 0 && p.runtime.ledger.since(0).length === ledgerBefore, 'nothing executed');
    for (const at of WALL) assert(await p.blockIs(at, 'cobblestone'), 'confirmed wall blocks unchanged (server truth)');
  });

  await p.check('R2', 'go home from a remembered, request-bound ref (bounded travel; presence not claimed)', async (ev) => {
    await p.tp(AWAY);
    p.admit('goal-memgohome', 'go home');
    const view = p.view('go home', 'req-memhome1');
    const home = view.facts.find((f) => f.category === 'home');
    ev.push(`view: ${view.facts.length} facts, ${view.notes.length} notes, omitted ${view.omitted.count}; home ref ${home?.ref}`);
    assert(home?.ref, 'home has a fresh executable ref');
    assert(!view.facts.some((f) => f.label === 'treasure'), 'the unverified note is not a fact');
    const o = await p.act('go_to_memory', { ref: home.ref, within: 2 }, undefined, 60_000);
    ev.push(line(o));
    assert(o.status === 'succeeded' && o.confirmation === 'client_only' && /presence not verified/.test(o.effect), 'arrival labeled as remembered');
    const server = await p.serverPos();
    ev.push(`server position ${JSON.stringify(server)}`);
    assert(Math.hypot(server.x - HOME.x, server.z - HOME.z) <= 3, 'server confirms the bot is at the remembered home');
    // A ref of this goal cannot be used by another goal epoch.
    const foreign = p.memory.resolveRef(home.ref, { goalEpoch: p.epoch + 1, goalId: 'goal-other001', connectionEpoch: p.game.connectionEpoch, dimension: view.scope?.dimension ?? '' });
    ev.push(`foreign resolution: ${'error' in foreign ? foreign.error : 'RESOLVED'}`);
    assert('error' in foreign, 'cross-goal ref use fails closed');
    p.end('outcome_verified', 'home');
  });

  await p.check('R3', 'emptied chest: memory shows HISTORICAL contents until a fresh inspection revises them', async (ev) => {
    p.admit('goal-memchest2', 'craft sticks from the planks in the chest');
    const before = p.view('planks in the chest', 'req-memchest');
    const chest = before.facts.find((f) => f.key === 'minecraft:chest');
    ev.push(`view chest: ${JSON.stringify(chest?.container)}`);
    assert(chest?.container?.historical === true && chest.container.contents['minecraft:oak_planks'] === 12, 'historical contents shown, labeled');
    await p.tp({ x: 203.5, y: -60, z: 205.5 }, 0, 30);
    const snap = p.snapshot();
    const o = await p.act('inspect_container', { container: p.handle(snap, 'minecraft:chest', SCENE.chest) }, snap);
    ev.push(line(o));
    const fact = p.memory.facts().find((f) => f.key === 'minecraft:chest' && f.status === 'active');
    ev.push(`revised contents: ${JSON.stringify(fact?.container?.contents)}`);
    assert(fact?.container && Object.keys(fact.container.contents).length === 0, 'memory revised to the fresh (empty) server contents');
    p.end('outcome_verified', 'checked');
  });

  await p.check('R4', 'destroyed crafting table: direct observation invalidates the remembered workstation and its ref', async (ev) => {
    p.admit('goal-memtable1', 'use the crafting table');
    await p.tp({ x: 205.5, y: -60, z: 205.5 }, -45, 20);
    const view = p.view('use the crafting table', 'req-memtable');
    const ref = view.facts.find((f) => f.key === 'minecraft:crafting_table')?.ref;
    p.snapshot();
    p.memory.ingestObservation();
    const table = p.memory.facts().find((f) => f.key === 'minecraft:crafting_table');
    ev.push(`table fact: ${table?.status} — ${table?.statusDetail}`);
    assert(table?.status === 'invalid', 'workstation revised from direct observation');
    if (ref) {
      const r = p.memory.resolveRef(ref, { goalEpoch: p.epoch, goalId: p.goalId, connectionEpoch: p.game.connectionEpoch, dimension: view.scope?.dimension ?? '' });
      ev.push(`old ref ${ref}: ${'error' in r ? r.error : 'RESOLVED'}`);
      assert('error' in r, 'ref to the destroyed workstation fails closed');
    }
    p.end('owner_stop', 'stopped');
  });

  await p.check('R5', 'another world revision (same endpoint) sees none of these facts', async (ev) => {
    const other = inspectMemory(memoryRoot, memoryConfig(2), systemClock);
    ev.push(`revision 2: ${other.state}, ${other.counts.total} facts`);
    assert(other.state === 'empty' && other.counts.total === 0, 'isolated scope');
  });

  await p.finish('recall');
}

// ====================================================================== orchestrator

async function runPhase(name: string, outDir: string): Promise<number> {
  const args = [join(PROJECT_ROOT, 'scripts', 'memory-live-check.ts'), '--phase', name, '--out', outDir, '--fixture-lease', arg('--fixture-lease') as string, ...(PINS.profile === DEFAULT_FIXTURE_PROFILE ? [] : ['--fixture', PINS.profile])];
  const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  child.stdout.on('data', (b: Buffer) => {
    process.stdout.write(b);
    lines.push(b.toString('utf8'));
  });
  child.stderr.on('data', (b: Buffer) => lines.push(`stderr: ${b.toString('utf8')}`));
  const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
  writeFileSync(join(outDir, `phase-${name}.log`), lines.join(''));
  return code;
}

async function orchestrate(): Promise<number> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${SUFFIX}-memory`);
  mkdirSync(outDir, { recursive: true });
  const between: Array<{ atMs: number; command: string; reply: string }> = [];
  const password = rconPassword();
  const rcon = async (command: string) => {
    const reply = await rconCommand(PINS.host, PINS.rconPort, password, command);
    between.push({ atMs: Date.now(), command, reply: reply.slice(0, 300) });
  };
  process.stdout.write(`memory live check (${PINS.profile}) -> ${outDir}\n`);
  const seedCode = await runPhase('seed', outDir);
  // Between app runs: the world changes while Chunkbot is offline.
  await rcon(`setblock ${TABLE.x} ${TABLE.y} ${TABLE.z} air`);
  await rcon(`data merge block ${SCENE.chest.x} ${SCENE.chest.y} ${SCENE.chest.z} {Items:[]}`);
  const recallCode = await runPhase('recall', outDir);
  const phases = ['seed', 'recall'].map((n) => {
    try {
      return JSON.parse(readFileSync(join(outDir, `phase-${n}.json`), 'utf8')) as Json;
    } catch {
      return { phase: n, results: [{ id: n, title: 'phase did not finish', pass: false, evidence: [] }] };
    }
  });
  const results = phases.flatMap((ph) => ph['results'] as Result[]);
  const pass = seedCode === 0 && recallCode === 0 && results.length > 0 && results.every((r) => r.pass);
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify({ check: 'MB-MEM-001 memory live check (pre-integration harness)', fixture: PINS.profile, pass, phaseExitCodes: { seed: seedCode, recall: recallCode }, betweenRuns: between, results, phases }, null, 2)}\n`);
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} memory live check: ${results.filter((r) => r.pass).length}/${results.length} — ${outDir}\n`);
  return pass ? 0 : 1;
}

async function main(): Promise<number> {
  // Shared fixtures are leased: nothing (no RCON, no password read, no join) happens without an explicit lease id.
  const lease = arg('--fixture-lease');
  if (!lease || !/^[A-Za-z0-9._-]{2,64}$/.test(lease)) {
    process.stderr.write('refusing to run: pass --fixture-lease <granted lease id> (the shared loopback fixtures are leased by the coordinator)\n');
    return 2;
  }
  if (!PHASE) return orchestrate();
  const outDir = arg('--out');
  assert(outDir, '--out required for a phase');
  const memoryRoot = join(outDir, 'memory');
  if (PHASE === 'seed') await seed(outDir, memoryRoot);
  else if (PHASE === 'recall') await recall(outDir, memoryRoot);
  else throw new Error(`unknown phase ${PHASE}`);
  const json = JSON.parse(readFileSync(join(outDir, `phase-${PHASE}.json`), 'utf8')) as { results: Result[] };
  return json.results.every((r) => r.pass) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(2);
  },
);
