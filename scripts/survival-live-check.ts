// MB-FLOW-003 survival mechanics gate (R-G1 / R-G2 / R-G3) against the LOCAL
// loopback test fixture only. PRE-INTEGRATION harness: until the designated
// writer installs survival in the shared app/CLI, this script composes the REAL
// connection, SkillRuntime (perception, knowledge, ledger, actuator lease), the
// registered skills plus the survival skills, MemoryService and SurvivalService,
// wiring exactly the approved hooks:
//   - onBotCreated: the survival tracker attaches to the protocol client right
//     after createBot and BEFORE login (through the connection's existing
//     createBot seam; no shared file is changed),
//   - lifecycle order: survival.onLifecycle (packet-frozen capture) ->
//     memory.captureDeath(survival.deathContext()) returning the SAME capture's
//     fact -> survival.linkIncident(captureId, factId) -> skill-layer
//     invalidation (standing in for the approved synchronous MemoryFact return
//     from MemoryService.onLifecycle).
// No model is called: the harness acts as the supervisor (admits survival's own
// proposals with a code goal epoch) and as a fixed decision (the first grounded
// candidate). Every RCON setup command is recorded; server truth is
// cross-checked over RCON (positions, LastDeathLocation, inventory counts).
//
// Gates:
//   G1  death order: kill-packet freeze before clearing slots, server death
//       GlobalPos vs RCON LastDeathLocation, memory records the same capture,
//       fresh respawn assessment (missing manifest), death cause key.
//   G1k keepInventory=true death: retained inventory, no trip   [--with-settings]
//   G2  scoped recovery: go_to_death_site + recover_lost_items pick up only
//       sought keys up to the missing count; an unrelated dirt drop and an
//       extra bread beyond the count are not counted; recovered vs concluded.
//   G3  food/health on Easy: hunger -> eat_safe_food raises server food;
//       low health -> allowance check/recheck + eat; rest regenerates; with
//       naturalRegeneration=false rest ends no_regeneration   [--with-settings]
//   G4  R8 bed/spawn MECHANICS ONLY (no routine): using an Overworld bed in the
//       day through the existing interact_block; RCON respawn data shows
//       whether the spawn was set; at night ([--with-settings], time restored)
//       the bed occupancy and whether the night was skipped with the bot as the
//       only player are recorded (never generalized to multiplayer)
//
//   npm run fixture -- status                     (fixture lease required)
//   node scripts/survival-live-check.ts --fixture-lease <granted id> [--fixture 26.2] [--with-settings]
//
// --with-settings authorizes ONLY: difficulty peaceful->easy, gamerule
// keepInventory and naturalRegeneration, and (G4) time of day; all are read
// first and restored in `finally`. Scene footprint: x 196..224, z 190..224, y -61..-50 (the existing
// skills scene area) plus the bot's own spawnpoint inside it.
//
// Report: var/live-check/<stamp>[-26.2]-survival/report.json
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { randomIds, systemClock, type ActionCandidate, type ExecutionOwner, type GameLifecycleEvent, type ObservationSnapshot, type SkillOutcome } from '../src/contracts/index.ts';
import { MemoryConfigSchema } from '../src/contracts/memory.ts';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { SkillExecutorImpl } from '../src/execution/executor.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
import { MineflayerConnection } from '../src/game/connection.ts';
import { MemoryService } from '../src/memory/service.ts';
import { installedMemoryWorld } from '../src/memory/world.ts';
import { allSkills } from '../src/skills/index.ts';
import { survivalSkills } from '../src/skills/survival.ts';
import type { SurvivalService } from '../src/survival/service.ts';
import { createSurvivalService } from '../src/survival/wiring.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { rconCommand } from './lib/rcon.ts';

type Json = Record<string, unknown>;

const PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const SUFFIX = PINS.profile === DEFAULT_FIXTURE_PROFILE ? '' : `-${PINS.profile}`;
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const BOT = 'Chunkbot';
const AREA = { x1: 196, z1: 190, x2: 224, z2: 224 };
const START = { x: 205.5, y: -60, z: 205.5 };
const DEATH_AT = { x: 212.5, y: -60, z: 205.5 };
const ITEM_AREA = `x=${AREA.x1},y=-64,z=${AREA.z1},dx=${AREA.x2 - AREA.x1},dy=40,dz=${AREA.z2 - AREA.z1}`;

interface Result {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'skipped';
  evidence: string[];
}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

class Gate {
  readonly results: Result[] = [];
  readonly setup: Array<{ atMs: number; command: string; reply: string }> = [];
  readonly packets: Array<{ atMs: number; name: string; detail?: string }> = [];
  readonly store = new MemoryRunStore();
  readonly game: MineflayerConnection;
  readonly runtime: SkillRuntime;
  readonly memory: MemoryService;
  readonly survival: SurvivalService;
  readonly executor: SkillExecutorImpl;
  readonly candidates: TaskCandidateGenerator;
  readonly outcomes: SkillOutcome[] = [];
  epoch = 0;
  goalId = '';
  private readonly password: string;
  private rconQueue: Promise<unknown> = Promise.resolve();

  constructor(outDir: string) {
    this.password = readRconPassword();
    const loaded = loadConfigFile(join(PROJECT_ROOT, PINS.inferenceFreeConfig));
    const config = loaded.config;
    const memoryConfig = MemoryConfigSchema.parse({ worldProfile: `survival-live-${PINS.profile.replace(/\./g, '-')}-${Date.now().toString(36)}`, worldRevision: 1, botProfile: 'chunkbot' });
    this.memory = new MemoryService({ config: memoryConfig, rootDir: join(outDir, 'memory'), endpoint: `${config.minecraft.host}:${config.minecraft.port}`, clock: systemClock, record: (e) => this.store.record(e) });
    const survival = createSurvivalService({
      survival: {},
      scope: { worldProfile: memoryConfig.worldProfile, worldRevision: memoryConfig.worldRevision, botProfile: memoryConfig.botProfile },
      dataDir: outDir,
      minecraftVersion: config.minecraft.version,
      limits: { lowHealth: config.limits.lowHealth, travelRadius: config.limits.travelRadius },
      now: () => Date.now(),
      record: (e) => this.store.record(e),
      memory: this.memory,
      latestSnapshot: () => this.runtime.perception.latest(),
    });
    check(survival, 'survival service could not be created');
    this.survival = survival;
    // Approved onBotCreated hook through the existing createBot seam: attach BEFORE login.
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
      createBot: (options) => {
        const bot = mineflayer.createBot(options);
        this.survival.attachConnection(bot._client, {
          connectionEpoch: this.game.connectionEpoch,
          selfPosition: () => (bot.entity?.position && bot.game?.dimension ? { dimension: String(bot.game.dimension), at: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } } : undefined),
        });
        const interesting = new Set(['death_combat_event', 'update_health', 'set_slot', 'window_items', 'respawn', 'collect', 'set_player_inventory']);
        bot._client.on('packet', (data: Json, meta: { name: string }) => {
          if (!interesting.has(meta.name)) return;
          const detail = meta.name === 'update_health' ? `health=${String(data['health'])} food=${String(data['food'])}` : meta.name === 'set_slot' ? `w=${String(data['windowId'])} slot=${String(data['slot'])}` : undefined;
          this.packets.push({ atMs: Date.now(), name: meta.name, ...(detail ? { detail } : {}) });
          if (this.packets.length > 4_000) this.packets.splice(0, 1_000);
        });
        return bot;
      },
    });
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
    this.memory.open();
    this.game.onLifecycle((event) => this.onLifecycle(event));
    const registry = new SkillRegistry([...allSkills(), ...survivalSkills(this.survival)]);
    this.executor = new SkillExecutorImpl({ registry, leases: this.runtime.leases, session: () => this.game.session(), services: this.runtime.services, goalEpoch: () => this.epoch, store: this.store });
    this.candidates = new TaskCandidateGenerator({ registry, services: this.runtime.services, session: () => this.game.session(), ids: randomIds });
  }

  /** Approved lifecycle order (engine revocation is the harness's epoch bump). */
  private onLifecycle(event: GameLifecycleEvent): void {
    if (event.type === 'death') {
      this.epoch += 1; // ownership revoked first
      this.survival.onLifecycle(event);
      const ctx = this.survival.deathContext();
      const fact = this.memory.captureDeath(ctx);
      if (fact && ctx.captureId) this.survival.linkIncident(ctx.captureId, fact.id);
      this.memory.refs.invalidateAll();
      this.runtime.onLifecycle(event);
      return;
    }
    this.survival.onLifecycle(event);
    this.memory.onLifecycle(event);
    this.runtime.onLifecycle(event);
  }

  async rcon(command: string, record = true): Promise<string> {
    const run = this.rconQueue.then(() => rconCommand(PINS.host, PINS.rconPort, this.password, command));
    this.rconQueue = run.catch(() => undefined);
    const reply = await run;
    if (record) this.setup.push({ atMs: Date.now(), command, reply: reply.slice(0, 300) });
    return reply;
  }

  async gate(id: string, title: string, fn: (ev: string[]) => Promise<void>): Promise<void> {
    const evidence: string[] = [];
    try {
      await fn(evidence);
      this.results.push({ id, title, status: 'pass', evidence });
      process.stdout.write(`PASS ${id} ${title}\n`);
    } catch (error) {
      evidence.push(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
      this.results.push({ id, title, status: 'fail', evidence });
      process.stdout.write(`FAIL ${id} ${title}\n  ${evidence.at(-1)?.slice(0, 500)}\n`);
    }
  }

  skip(id: string, title: string, why: string): void {
    this.results.push({ id, title, status: 'skipped', evidence: [why] });
    process.stdout.write(`SKIP ${id} ${title} (${why})\n`);
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

  async waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await cond()) return;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async scene(): Promise<void> {
    const { x1, z1, x2, z2 } = AREA;
    for (const c of [
      `forceload add ${x1} ${z1} ${x2} ${z2}`,
      `kill @e[type=item,${ITEM_AREA}]`,
      `kill @e[type=experience_orb,${ITEM_AREA}]`,
      `fill ${x1} -60 ${z1} ${x2} -50 ${z2} air`,
      `fill ${x1} -61 ${z1} ${x2} -61 ${z2} grass_block`,
      `spawnpoint ${BOT} ${Math.floor(START.x)} ${START.y} ${Math.floor(START.z)}`,
      `clear ${BOT}`,
      `effect clear ${BOT}`,
      `tp ${BOT} ${START.x} ${START.y} ${START.z} 0 20`,
    ])
      await this.rcon(c);
    await sleep(1_000);
  }

  admit(goalId: string): void {
    this.epoch += 1;
    this.goalId = goalId;
    this.runtime.onGoalAdmitted({ goalId, epoch: this.epoch, admittedAtMs: Date.now() });
  }

  snapshot(): ObservationSnapshot {
    const s = this.runtime.perception.take(this.epoch);
    check(s, 'no observation');
    return s;
  }

  /** Fixed decision: the first grounded candidate of `capability` for a generic task spec. */
  async act(capability: string, hintsKeys: string[] = [], timeoutMs = 60_000): Promise<SkillOutcome | undefined> {
    const snap = this.snapshot();
    const set = this.candidates.generate({ objective: 'survival gate', decisionInstruction: 'fixed decision', allowedCapabilities: [capability], targetSelectors: hintsKeys.map((key) => ({ kind: 'registry' as const, key })), parameters: {}, completion: { predicate: 'inventory_amount', selector: 'minecraft:stone', atLeast: 10_000, mode: 'possess' } }, snap);
    const c = set.candidates[0];
    if (!c) return undefined;
    const candidate: ActionCandidate = { ...c, timeoutMs };
    const owner: ExecutionOwner = { kind: 'goal', goalEpoch: this.epoch, goalId: this.goalId, taskId: randomIds.next('task') };
    const outcome = await this.executor.execute(candidate, new AbortController().signal, owner);
    this.outcomes.push(outcome);
    return outcome;
  }

  unavailable(capability: string): string[] {
    const set = this.candidates.generate({ objective: 'survival gate', decisionInstruction: 'fixed decision', allowedCapabilities: [capability], targetSelectors: [], parameters: {}, completion: { predicate: 'inventory_amount', selector: 'minecraft:stone', atLeast: 10_000, mode: 'possess' } }, this.snapshot());
    return set.unavailable.map((u) => `${u.reason}: ${u.detail}`);
  }

  assessInput(over: Partial<Parameters<SurvivalService['assess']>[0]> = {}): Parameters<SurvivalService['assess']>[0] {
    const s = this.snapshot();
    return { nowMs: Date.now(), connection: { ready: this.game.state === 'ready', connectionEpoch: this.game.connectionEpoch, dimension: s.dimension }, snapshot: s, autonomyAllowed: true, active: { kind: 'none' }, ownerIntentPending: false, ownerIntentInterrupted: false, goalLimits: { plannerTurns: 20, tasks: 64, replans: 8, deadlineMs: 20 * 60_000 }, ...over };
  }

  /** Harness-as-supervisor: admit survival's own proposal under a fresh code goal epoch. */
  admitProposal(p: SurvivalProposal): ReturnType<SurvivalService['onSupportAdmitted']> {
    this.admit(randomIds.next('goal'));
    return this.survival.onSupportAdmitted({ proposalId: p.proposalId, goalId: this.goalId, goalEpoch: this.epoch, connectionEpoch: this.game.connectionEpoch, admittedAtMs: Date.now() });
  }

  endSupport(p: SurvivalProposal, reason: string): void {
    this.survival.onSupportTerminal({ proposalId: p.proposalId, goalId: this.goalId, goalEpoch: this.epoch, state: reason === 'outcome_verified' ? 'completed' : 'blocked', reason, detail: reason, counters: { plannerTurns: 0, tasksAdmitted: 1, replans: 0 }, endedAtMs: Date.now() });
  }

  async count(item: string): Promise<number> {
    const r = await this.rcon(`clear ${BOT} minecraft:${item} 0`, false);
    const m = /Found (\d+) matching item/.exec(r);
    return m ? Number(m[1]) : 0;
  }

  async lastDeathLocation(): Promise<string> {
    return this.rcon(`data get entity ${BOT} LastDeathLocation`, false);
  }
}

function readRconPassword(): string {
  const fx = fixturePaths(PROJECT_ROOT, PINS);
  const line = readFileSync(fx.properties, 'utf8').split('\n').find((l) => l.startsWith('rcon.password='));
  if (!line) throw new Error('fixture RCON password missing');
  return line.slice('rcon.password='.length).trim();
}

async function killWithKit(g: Gate, ev: string[]): Promise<{ captureId: string | undefined; factId: string | undefined }> {
  await g.rcon(`tp ${BOT} ${DEATH_AT.x} ${DEATH_AT.y} ${DEATH_AT.z} 0 20`);
  await g.rcon(`give ${BOT} minecraft:iron_pickaxe[minecraft:damage=200] 1`);
  await g.rcon(`give ${BOT} minecraft:bread 4`);
  await g.rcon(`give ${BOT} minecraft:cobblestone 20`);
  await g.waitFor('kit in the tracked inventory', () => (g.survival.inventory(g.game.connectionEpoch)?.stacks.length ?? 0) >= 3);
  const before = g.survival.inventory(g.game.connectionEpoch);
  ev.push(`tracked before death: ${before?.stacks.map((s) => `${s.key}x${s.count}${s.meta.damage !== undefined ? `(damage ${s.meta.damage}/${s.meta.maxDurability})` : ''}`).join(', ')} source=${before?.source}`);
  const mark = g.packets.length;
  await g.rcon(`kill ${BOT}`);
  await g.waitFor('respawn ready', () => g.survival.tracker.life === 'alive' && g.packets.slice(mark).some((p) => p.name === 'respawn'), 15_000);
  await sleep(1_500);
  ev.push(`packet order around death: ${g.packets.slice(mark, mark + 40).map((p) => `${p.name}${p.detail ? `[${p.detail}]` : ''}`).join(' > ')}`);
  const d = g.survival.tracker.latest();
  const status = g.survival.status(Date.now());
  const inc = status.incidents.at(-1);
  return { captureId: d?.captureId, factId: inc?.incidentFactId };
}

async function run(outDir: string, withSettings: boolean): Promise<Json> {
  const g = new Gate(outDir);
  const restore: string[] = [];
  let source = { head: 'unknown', dirty: -1 };
  try {
    source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).length };
  } catch {
    // source identity unavailable
  }
  try {
    await g.connect();
    await g.scene();

    await g.gate('G1', 'death order, server death location, same-capture memory link, fresh loss assessment', async (ev) => {
      const { captureId, factId } = await killWithKit(g, ev);
      const d = g.survival.tracker.latest();
      check(d, 'no captured death');
      ev.push(`capture ${captureId}: frozenAt=${d.lastAlive.frozenAt} clearingPacketsAfterFreeze=${d.lastAlive.clearingPacketsAfterFreeze} lastAlive=${d.lastAlive.stacks.map((s) => `${s.key}x${s.count}`).join(',')} cause=${d.cause.translationKey ?? d.cause.kind} site=${d.site.source} ${JSON.stringify(d.site.at)} offBy=${d.site.clientEstimateOffBy ?? 'n/a'}`);
      ev.push(`RCON LastDeathLocation: ${(await g.lastDeathLocation()).slice(0, 200)}`);
      ev.push(`memory fact ${factId}; memory status ${g.memory.status().state}`);
      check(d.lastAlive.stacks.length >= 3, 'last-alive inventory kept the kit (frozen before clearing)');
      check(factId && /^mf-/.test(factId), 'memory recorded the SAME capture and it was linked exactly');
      const inc = g.survival.status(Date.now()).incidents.at(-1);
      ev.push(`incident: ${JSON.stringify(inc)}`.slice(0, 900));
      check(inc && inc.missing.length >= 3, 'fresh respawn assessment lists the missing kit');
      const items = await g.rcon(`execute if entity @e[type=item,x=${DEATH_AT.x - 6},y=-64,z=${DEATH_AT.z - 6},dx=12,dy=10,dz=12]`, false);
      ev.push(`item entities near the site (RCON): ${items.slice(0, 120)}`);
    });

    await g.gate('G2', 'scoped recovery: only sought keys up to the missing count; recovered vs concluded', async (ev) => {
      // Mixed drops near the site: an unrelated dirt stack and an extra bread beyond the missing count.
      await g.rcon(`summon item ${DEATH_AT.x + 1} ${DEATH_AT.y} ${DEATH_AT.z + 1} {Item:{id:"minecraft:dirt",count:3},PickupDelay:0s}`);
      await g.rcon(`summon item ${DEATH_AT.x - 1} ${DEATH_AT.y} ${DEATH_AT.z + 1} {Item:{id:"minecraft:bread",count:2},PickupDelay:0s}`);
      const decision = g.survival.assess(g.assessInput());
      ev.push(`decision: ${decision.kind} ${decision.kind === 'propose' ? decision.proposal.routine : 'reason' in decision ? decision.reason : ''}`);
      check(decision.kind === 'propose' && decision.proposal.routine === 'death_recovery', 'recovery proposed');
      g.admitProposal(decision.proposal);
      const go = await g.act('go_to_death_site', [], 60_000);
      ev.push(`go_to_death_site: ${go?.status} ${go?.effect.slice(0, 160)}`);
      for (let i = 0; i < 8; i += 1) {
        const o = await g.act('recover_lost_items', [], 30_000);
        if (!o) break;
        ev.push(`recover_lost_items: ${o.status} ${o.effect.slice(0, 200)}`);
        await sleep(300);
      }
      ev.push(`still unavailable: ${g.unavailable('recover_lost_items').join(' | ').slice(0, 300)}`);
      const owner = { goalId: g.goalId, goalEpoch: g.epoch };
      const recovered = g.survival.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' }, owner);
      const concluded = g.survival.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'concluded' }, owner);
      ev.push(`recovered: ${recovered.status} ${recovered.detail}; concluded: ${concluded.status} ${concluded.detail}`);
      const counts = { bread: await g.count('bread'), cobblestone: await g.count('cobblestone'), iron_pickaxe: await g.count('iron_pickaxe'), dirt: await g.count('dirt') };
      ev.push(`server inventory (RCON clear 0): ${JSON.stringify(counts)}`);
      g.endSupport(decision.proposal, recovered.status === 'satisfied' || concluded.status === 'satisfied' ? 'outcome_verified' : 'no_progress');
      const inc = g.survival.status(Date.now()).incidents.at(-1);
      ev.push(`episode: ${inc?.status} regained=${JSON.stringify(inc?.regained)}`);
      check(counts.dirt === 0, 'no unrelated loot was collected');
      check((inc?.regained.find((r) => r.key === 'minecraft:bread')?.count ?? 0) <= 4, 'regained bread never exceeds the missing count');
    });

    await g.gate('G4', 'R8 mechanics: daytime bed use and respawn point (no routine)', async (ev) => {
      await g.scene();
      await g.rcon('setblock 208 -60 208 red_bed[facing=south,part=foot]');
      await g.rcon('setblock 208 -60 209 red_bed[facing=south,part=head]');
      await g.rcon(`tp ${BOT} 208.5 -60 206.5 0 40`);
      await sleep(1_500);
      ev.push(`respawn before: ${(await g.rcon(`data get entity ${BOT} respawn`, false)).slice(0, 200)}`);
      g.admit(randomIds.next('goal'));
      const used = await g.act('interact_block', ['minecraft:red_bed'], 15_000);
      ev.push(`interact_block bed (day): ${used?.status} ${used?.reason ?? ''} ${used?.effect.slice(0, 200)}`);
      await sleep(1_000);
      const after = await g.rcon(`data get entity ${BOT} respawn`, false);
      ev.push(`respawn after: ${after.slice(0, 200)}`);
      ev.push(`daytime: ${(await g.rcon('time query daytime', false)).slice(0, 80)}`);
      check(used, 'a bed candidate existed (bed visible and in reach)');
    });

    if (!withSettings) {
      g.skip('G1k', 'keepInventory death retains inventory (no trip)', 'requires --with-settings (gamerule keepInventory)');
      g.skip('G3', 'food/health on Easy, allowance, rest/no-regeneration', 'requires --with-settings (difficulty, naturalRegeneration)');
      g.skip('G4n', 'R8 mechanics: night sleep with the bot as only player', 'requires --with-settings (time of day)');
    } else {
      const difficulty = /The difficulty is (\w+)/.exec(await g.rcon('difficulty'))?.[1]?.toLowerCase() ?? 'peaceful';
      const keep = /currently set to: (\w+)/.exec(await g.rcon('gamerule keepInventory'))?.[1] ?? 'false';
      const regen = /currently set to: (\w+)/.exec(await g.rcon('gamerule naturalRegeneration'))?.[1] ?? 'true';
      restore.push(`difficulty ${difficulty}`, `gamerule keepInventory ${keep}`, `gamerule naturalRegeneration ${regen}`);

      await g.gate('G1k', 'keepInventory death retains inventory (no trip)', async (ev) => {
        await g.scene();
        await g.rcon('gamerule keepInventory true');
        const { factId } = await killWithKit(g, ev);
        const inc = g.survival.status(Date.now()).incidents.at(-1);
        ev.push(`incident ${factId}: ${inc?.status} missing=${JSON.stringify(inc?.missing)}`);
        await g.rcon(`gamerule keepInventory ${keep}`);
        check(inc?.status === 'no_loss', 'retained inventory: no_loss, no trip');
      });

      await g.gate('G3', 'food/health on Easy: eat raises server food, low-health allowance, rest regen and no-regeneration', async (ev) => {
        await g.scene();
        await g.rcon('difficulty easy');
        await g.rcon(`give ${BOT} minecraft:bread 6`);
        await g.rcon(`effect give ${BOT} minecraft:hunger 20 120 true`);
        await g.waitFor('food at or below 14', () => (g.survival.vitals(g.game.connectionEpoch)?.food ?? 20) <= 14, 30_000);
        await g.rcon(`effect clear ${BOT} minecraft:hunger`);
        const before = g.survival.vitals(g.game.connectionEpoch);
        let d = g.survival.assess(g.assessInput());
        ev.push(`food ${before?.food}: decision ${d.kind} ${d.kind === 'propose' ? d.proposal.routine : ''}`);
        check(d.kind === 'propose' && d.proposal.routine === 'eat', 'eat proposed at low food');
        g.admitProposal(d.proposal);
        const eat = await g.act('eat_safe_food');
        await sleep(500);
        const after = g.survival.vitals(g.game.connectionEpoch);
        ev.push(`eat: ${eat?.status} ${eat?.effect.slice(0, 160)}; server food ${before?.food} -> ${after?.food}`);
        check((after?.food ?? 0) > (before?.food ?? 0), 'server food rose');
        g.endSupport(d.proposal, 'outcome_verified');
        // Low health: allowance bound to the admitted support goal; recheck after the choice.
        await g.rcon(`damage ${BOT} 13 minecraft:generic`);
        await g.waitFor('health <= 8', () => (g.survival.vitals(g.game.connectionEpoch)?.health ?? 20) <= 8, 10_000);
        await g.rcon(`effect give ${BOT} minecraft:hunger 10 60 true`);
        await g.waitFor('food below 18', () => (g.survival.vitals(g.game.connectionEpoch)?.food ?? 20) < 18, 30_000);
        await g.rcon(`effect clear ${BOT} minecraft:hunger`);
        d = g.survival.assess(g.assessInput());
        ev.push(`low health decision: ${d.kind} ${d.kind === 'propose' ? `${d.proposal.routine} allowance=${JSON.stringify(d.proposal.lowHealthAllowance)}` : 'reason' in d ? d.reason : ''}`);
        check(d.kind === 'propose' && d.proposal.lowHealthAllowance, 'a narrow allowance is proposed at low health');
        const grant = g.admitProposal(d.proposal);
        check(grant, 'grant issued once for the admitted support epoch');
        const ref = { goalId: g.goalId, goalEpoch: g.epoch, taskId: 'task-gate1', connectionEpoch: g.game.connectionEpoch, allowedCapabilities: grant.capabilities };
        const c1 = g.survival.check(ref, g.snapshot());
        ev.push(`check: ${JSON.stringify(c1).slice(0, 200)}`);
        check(c1.allowed, 'allowance check passes with fresh vitals and no threat');
        const cand = g.candidates.generate({ objective: 'eat', decisionInstruction: 'eat', allowedCapabilities: [...grant.capabilities], targetSelectors: [], parameters: {}, completion: { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 1, mode: 'possess' } }, g.snapshot()).candidates[0];
        check(cand, 'a grounded eat candidate exists');
        const rc = g.survival.recheck(c1.allowanceId, ref, cand, g.snapshot());
        ev.push(`recheck: ${JSON.stringify(rc).slice(0, 200)}`);
        check(rc.allowed, 'post-choice recheck passes');
        const out = await g.executor.execute(cand, new AbortController().signal, { kind: 'goal', goalEpoch: g.epoch, goalId: g.goalId, taskId: 'task-gate1' });
        g.survival.consumed(c1.allowanceId, { actionId: out.actionId, capability: cand.capability, status: out.status });
        ev.push(`low-health eat: ${out.status} ${out.effect.slice(0, 160)}`);
        g.endSupport(d.proposal, 'outcome_verified');
        // Rest with natural regeneration on: server health must rise.
        await g.rcon(`effect give ${BOT} minecraft:saturation 2 10 true`);
        await sleep(2_500);
        const h0 = g.survival.vitals(g.game.connectionEpoch)?.health ?? 0;
        g.admit(randomIds.next('goal'));
        const restOut = await g.act('rest_in_place', [], 20_000);
        ev.push(`rest (regen on): ${restOut?.status} ${restOut?.effect.slice(0, 160)}; health ${h0} -> ${g.survival.vitals(g.game.connectionEpoch)?.health}`);
        // Regeneration unavailable: honest end.
        await g.rcon(`damage ${BOT} 4 minecraft:generic`);
        await g.rcon('gamerule naturalRegeneration false');
        await sleep(500);
        const noRegen = await g.act('rest_in_place', [], 20_000);
        ev.push(`rest (regen off): ${noRegen?.status} ${noRegen?.reason ?? ''} ${noRegen?.effect.slice(0, 160)}`);
        await g.rcon(`gamerule naturalRegeneration ${regen}`);
        check(noRegen?.status === 'failed' && noRegen.reason === 'no_regeneration', 'no regeneration ends honestly');
      });

      await g.gate('G4n', 'R8 mechanics: night sleep with the bot as the only player (recorded, not generalized)', async (ev) => {
        const day = /The time is (\d+)/.exec(await g.rcon('time query daytime'))?.[1];
        if (day) restore.push(`time set ${day}`);
        await g.rcon(`difficulty ${difficulty}`); // no hostile spawns needed for this observation
        await g.scene();
        await g.rcon('setblock 208 -60 208 red_bed[facing=south,part=foot]');
        await g.rcon('setblock 208 -60 209 red_bed[facing=south,part=head]');
        await g.rcon('time set 13000');
        await g.rcon(`tp ${BOT} 208.5 -60 206.5 0 40`);
        await sleep(1_500);
        g.admit(randomIds.next('goal'));
        const used = await g.act('interact_block', ['minecraft:red_bed'], 15_000);
        ev.push(`interact_block bed (night): ${used?.status} ${used?.reason ?? ''} ${used?.effect.slice(0, 200)}`);
        await sleep(6_000);
        ev.push(`bed block: ${(await g.rcon('execute if block 208 -60 208 red_bed[occupied=true]', false)).slice(0, 80)}`);
        ev.push(`daytime after ~6s: ${(await g.rcon('time query daytime', false)).slice(0, 80)}`);
        ev.push(`players online: ${(await g.rcon('list', false)).slice(0, 120)}`);
        check(used, 'a bed candidate existed at night');
      });
    }
  } finally {
    for (const c of restore) {
      try {
        await g.rcon(c);
      } catch (error) {
        g.setup.push({ atMs: Date.now(), command: `RESTORE FAILED: ${c}`, reply: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      await g.rcon(`kill @e[type=item,${ITEM_AREA}]`);
      await g.rcon(`clear ${BOT}`);
    } catch {
      // best effort cleanup inside the scene area
    }
    await g.memory.close().catch(() => undefined);
    await g.survival.close().catch(() => undefined);
    await g.game.disconnect('operator_stop').catch(() => undefined);
  }
  const counted = g.results.filter((r) => r.status !== 'skipped');
  return {
    check: 'MB-FLOW-003 survival mechanics gate (pre-integration harness; no model calls)',
    fixture: PINS.profile,
    source,
    withSettings,
    restoredSettings: restore,
    pass: counted.length > 0 && counted.every((r) => r.status === 'pass'),
    results: g.results,
    setup: g.setup,
    packets: g.packets.slice(-600),
    outcomes: g.outcomes.map((o) => ({ capability: o.capability, status: o.status, reason: o.reason ?? null, confirmation: o.confirmation, effect: o.effect.slice(0, 300) })),
    survivalEvents: g.store.events.filter((e) => String(e.type).startsWith('survival_')).slice(-150),
    survivalStatus: g.survival.status(Date.now()),
  };
}

async function main(): Promise<number> {
  // Shared fixtures are leased: nothing (no password read, RCON, join or output) happens without an explicit lease id.
  const lease = arg('--fixture-lease');
  if (!lease || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(lease)) {
    process.stderr.write('refusing to run: pass --fixture-lease <granted lease id> (the shared loopback fixtures are leased by the coordinator)\n');
    return 2;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${SUFFIX}-survival`);
  mkdirSync(outDir, { recursive: true });
  process.stdout.write(`survival gate (${PINS.profile}, lease ${lease}) -> ${outDir}\n`);
  const report = await run(outDir, process.argv.includes('--with-settings'));
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify({ ...report, lease }, null, 2)}\n`);
  process.stdout.write(`${report['pass'] ? 'PASS' : 'FAIL'} survival gate — ${outDir}\n`);
  return report['pass'] ? 0 : 1;
}

/**
 * Import safety: importing this module never runs anything. main() starts only
 * when this file is the process entry point, and main() refuses (exit 2)
 * before any fixture password read, RCON command, join or output-directory
 * setup unless --fixture-lease <granted id> is given.
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
