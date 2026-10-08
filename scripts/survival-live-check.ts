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
// Gates (none claims integrated-application acceptance; this is a module gate):
//   G1  death order: kill-packet freeze before clearing slots, server death
//       GlobalPos vs RCON LastDeathLocation, memory records the same capture,
//       fresh respawn assessment (missing manifest), death cause key.
//   G2  C3 mixed piles: a foreign 64-bread pile (oversized), unrelated dirt and
//       a diamond sword with a DIFFERENT enchantment are refused BEFORE any
//       collection (server-stated stacks/identity; RCON confirms none taken)
//   G2b C3 ordinary recovery after the foreign piles are removed: own drops,
//       including the enchanted sword (identity match), are collected with
//       server collect evidence; recovered vs concluded reported honestly
//   [--with-settings only]
//   G1k keep_inventory=true death: retained inventory, no trip
//   G3  Easy difficulty: eating completes ONLY at the admitted threshold
//       (survival_state eat satisfied, food >= eatUntil); a necessary low-health
//       eat runs through the allowance (check, reserve-before-dispatch); with
//       natural_health_regeneration verified TRUE rest must raise server health by >= 1;
//       with it verified FALSE rest must end `no_regeneration` (bounded)
//   G4  R8 OBSERVATION (no routine, no R8 claim): daytime set explicitly, bed
//       use via interact_block; server respawn data recorded
//   G4n R8 OBSERVATION: night set explicitly; server sleeping position, bed
//       occupancy and daytime after 6 s recorded (sole-player only, never
//       generalized to multiplayer)
//
//   npm run fixture -- status                     (fixture lease required)
//   node scripts/survival-live-check.ts --fixture-lease <granted id> [--fixture 26.2] [--with-settings]
//
// OWNED WRITE FOOTPRINT (C6) — every block/entity write stays inside these:
//   scene   x 196..224, y -61..-50, z 190..224 (blocks and item/xp entities)
//   backup  x 196..224, y 200..211, z 190..224 (pre-trial scene copy; must be
//           verified EMPTY before use, else the trial refuses to start;
//           restored/cleared and re-verified at the end)
//   forceload: only chunks this trial added are removed again
//   bot: inventory/effects/position/health/food of the fixture bot only; G4/G4n
//        may set its respawn point to the trial bed (recorded before/after)
//   settings [--with-settings]: difficulty, gamerules keep_inventory and
//        natural_health_regeneration, time of day — read first, restored in `finally`
//        and re-verified; ANY failed restoration or verification fails the report
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
import { MemoryFileStore, scopeDirectory } from '../src/memory/store.ts';
import { installedMemoryWorld } from '../src/memory/world.ts';
import { allSkills } from '../src/skills/index.ts';
import { survivalSkills } from '../src/skills/survival.ts';
import type { SurvivalService } from '../src/survival/service.ts';
import { createSurvivalService } from '../src/survival/wiring.ts';
import { sameDimension } from '../src/survival/items.ts';
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
const SCENE_Y = { y1: -61, y2: -50 };
const BACKUP_Y = { y1: 200, y2: 211 };
/** Entity selector volume == the declared owned scene (C6). */
const ITEM_AREA = `x=${AREA.x1},y=${SCENE_Y.y1},z=${AREA.z1},dx=${AREA.x2 - AREA.x1},dy=${SCENE_Y.y2 - SCENE_Y.y1},dz=${AREA.z2 - AREA.z1}`;
const SCENE_BOX = `${AREA.x1} ${SCENE_Y.y1} ${AREA.z1} ${AREA.x2} ${SCENE_Y.y2} ${AREA.z2}`;
const BACKUP_BOX = `${AREA.x1} ${BACKUP_Y.y1} ${AREA.z1} ${AREA.x2} ${BACKUP_Y.y2} ${AREA.z2}`;
/** Unique per-run tag for foreign test piles (never matches another run's or harness's entities). */
// MB-FLOW-003-C8: settings command names for 26.1.2 AND 26.2, checked against
// the official server command reports (generated commands.json): gamerules are
// snake_case (`keepInventory`/`naturalRegeneration` no longer exist; the
// leased trial's SETUP read failed on them) and `time query daytime` was
// replaced by `time query time` (world clocks). Query replies are recorded.
const RULE_KEEP = 'keep_inventory';
const RULE_REGEN = 'natural_health_regeneration';
const TIME_QUERY = 'time query time';
/** The overworld day timeline (26.1.2/26.2 `data/minecraft/timeline/day.json`: clock minecraft:overworld, period 24000). */
const DAY_TIMELINE = 'minecraft:day';
const DAY_QUERY = `time query ${DAY_TIMELINE}`;
const DAY_TICKS = 24_000;

// ---- MB-FLOW-003-C8: official reply forms (26.1.2 and 26.2 server.jar en_us.json; identical in both) ----
//   commands.time.query.absolute  "Clock %s is at %s tick(s)"      (time query time; trial 2 got exactly this)
//   commands.time.query           "The time is %s"                 (legacy form, still accepted)
//   commands.time.query.timeline  "Timeline %s is at %s tick(s)"   (time query <timeline>)
//   commands.time.set.absolute    "Set %s to %s tick(s)"           (time of <clock> set <time>)
//   commands.time.set             "Set the time to %s"
//   commands.gamerule.query       "Gamerule %s is currently set to: %s"
//   commands.difficulty.query     "The difficulty is %s"
/** `time query time` reply -> absolute clock ticks (and the clock id when stated). */
export function parseClockReply(reply: string): { clock?: string; ticks: number } | undefined {
  const abs = /^Clock (\S+) is at (\d+) tick\(s\)\s*$/.exec(reply.trim());
  if (abs) return { clock: abs[1] as string, ticks: Number(abs[2]) };
  const legacy = /^The time is (\d+)\s*$/.exec(reply.trim());
  return legacy ? { ticks: Number(legacy[1]) } : undefined;
}
/** `time query <timeline>` reply -> position in that timeline (only for the named timeline). */
export function parseTimelineReply(reply: string, timeline: string): number | undefined {
  const m = /^Timeline (\S+) is at (\d+) tick\(s\)\s*$/.exec(reply.trim());
  return m && m[1] === timeline ? Number(m[2]) : undefined;
}
/** `time [of <clock>] set` reply -> the ticks the server says it set (absolute form names the clock). */
export function parseClockSetReply(reply: string): { clock?: string; ticks: number } | undefined {
  const abs = /^Set (\S+) to (\d+) tick\(s\)\s*$/.exec(reply.trim());
  if (abs) return { clock: abs[1] as string, ticks: Number(abs[2]) };
  const plain = /^Set the time to (\d+)\s*$/.exec(reply.trim());
  return plain ? { ticks: Number(plain[1]) } : undefined;
}
export function parseRuleReply(reply: string, rule: string): string | undefined {
  const m = /^Gamerule (\S+) is currently set to: (\S+)\s*$/.exec(reply.trim());
  return m && m[1] === rule ? (m[2] as string) : undefined;
}
export function parseDifficultyReply(reply: string): string | undefined {
  return /^The difficulty is (\w+)\s*$/.exec(reply.trim())?.[1]?.toLowerCase();
}
/**
 * Clock restoration target: the original absolute ticks advanced by the clock's
 * MEASURED rate over the elapsed wall time (a paused clock has rate 0), so a
 * restored world neither rewinds nor skips the time that passed in the trial.
 */
export function clockRestoreTarget(original: { ticks: number; atMs: number; ticksPerMs: number }, nowMs: number): number {
  return Math.max(0, Math.round(original.ticks + Math.max(0, original.ticksPerMs) * Math.max(0, nowMs - original.atMs)));
}
const FOREIGN_TAG = `cbsurv_${Date.now().toString(36)}_${process.pid.toString(36)}`;
const BED = { foot: { x: 208, y: -60, z: 208 }, head: { x: 208, y: -60, z: 209 } };
/** Items whose server counts the C10 oracle compares (kit + foreign piles). */
const TRACKED_ITEMS = ['bread', 'cobblestone', 'iron_pickaxe', 'diamond_sword', 'dirt'] as const;
const LOST_KIT: Record<string, number> = { bread: 4, cobblestone: 20, iron_pickaxe: 1, diamond_sword: 1 };

/**
 * C10 truthfulness oracle (pure): the server inventory change since the
 * pre-recovery baseline must equal what survival COUNTED as regained plus what
 * it REPORTED as incidental during the attempt, key by key. Anything else is an
 * unreported or misattributed effect.
 */
export function deltaMismatches(baseline: Record<string, number>, now: Record<string, number>, regained: Record<string, number>, incidental: Record<string, number>): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(baseline), ...Object.keys(now)])) {
    const delta = (now[k] ?? 0) - (baseline[k] ?? 0);
    const explained = (regained[k] ?? 0) + (incidental[k] ?? 0);
    if (delta !== explained) out.push(`${k}: server delta ${delta} != regained ${regained[k] ?? 0} + incidental ${incidental[k] ?? 0}`);
  }
  return out;
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

class Gate {
  readonly results: Result[] = [];
  readonly setup: Array<{ atMs: number; command: string; reply: string }> = [];
  readonly packets: Array<{ atMs: number; name: string; detail?: string }> = [];
  /** Settings/clock/inventory observations that are not gate results (recorded in the report). */
  readonly notes: string[] = [];
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
  /** The recovery proposal admitted in G2 (continued in G2b). */
  recovery: SurvivalProposal | undefined;
  /** C10: RCON inventory immediately before the recovery admission (the delta oracle's baseline). */
  baseline: Record<string, number> | undefined;
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
      // C5 pre-integration stand-in for the proposed MemoryService.factDurability seam: a fact is
      // `durable` only when memory's last COMPLETE on-disk revision contains it (read-only inspection).
      memory: {
        facts: () => this.memory.facts(),
        // C1: `retained` passes through unchanged (integrated memory, P c704, accepts it; an older memory ignores it and G1k then fails honestly).
        updateDeathRecovery: (factId, update, evidence) => (this.memory.updateDeathRecovery as (f: string, u: typeof update, e: typeof evidence) => Promise<{ ok: boolean; detail: string }>)(factId, update, evidence),
        factDurability: (factId) => {
          // Integrated memory (canonical seam): use its own string result directly.
          const canonical = (this.memory as unknown as { factDurability?: (id: string) => unknown }).factDurability;
          if (typeof canonical === 'function') {
            const r = canonical.call(this.memory, factId);
            return r === 'durable' || r === 'pending' || r === 'failed' ? r : 'unknown';
          }
          // Pre-integration stand-in: durable only when the last COMPLETE on-disk revision holds the fact at its CURRENT revision.
          const current = this.memory.facts().find((f) => f.id === factId);
          if (!current) return 'unknown';
          const load = new MemoryFileStore({ dir: scopeDirectory(join(outDir, 'memory'), memoryConfig), scope: memoryConfig, clock: systemClock }).open({ readOnly: true });
          const onDisk = load.body?.facts.find((f) => f.id === factId);
          if (onDisk && onDisk.revision >= current.revision) return 'durable';
          const st = this.memory.status();
          return st.pendingWrites > 0 || onDisk ? 'pending' : st.lastError ? 'failed' : 'pending';
        },
      },
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
          // C10: slot packets carry the server-stated item and count; collect packets their entity ids and count.
          const item = (raw: unknown) => {
            const it = raw as { itemCount?: number; itemId?: number } | undefined;
            return it && it.itemCount ? `${this.survival.registry().nameOf(it.itemId as number) ?? `id${String(it.itemId)}`}x${it.itemCount}` : 'empty';
          };
          const detail =
            meta.name === 'update_health'
              ? `health=${String(data['health'])} food=${String(data['food'])}`
              : meta.name === 'set_slot'
                ? `w=${String(data['windowId'])} slot=${String(data['slot'])} ${item(data['item'])}`
                : meta.name === 'collect'
                  ? `entity=${String(data['collectedEntityId'])} collector=${String(data['collectorEntityId'])} count=${String(data['pickupItemCount'])}`
                  : meta.name === 'window_items' && data['windowId'] === 0
                    ? `w=0 nonEmpty=${(Array.isArray(data['items']) ? (data['items'] as unknown[]) : []).filter((x) => (x as { itemCount?: number })?.itemCount).map(item).join(',') || 'none'}`
                    : undefined;
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

  /** Trial scene inside the owned footprint (blocks + item/xp entities only); the pre-trial copy is in the backup volume. */
  async scene(): Promise<void> {
    const { x1, z1, x2, z2 } = AREA;
    for (const c of [
      `kill @e[type=item,${ITEM_AREA}]`,
      `kill @e[type=experience_orb,${ITEM_AREA}]`,
      `fill ${x1} -60 ${z1} ${x2} ${SCENE_Y.y2} ${z2} air`,
      `fill ${x1} ${SCENE_Y.y1} ${z1} ${x2} ${SCENE_Y.y1} ${z2} grass_block`,
      `clear ${BOT}`,
      `effect clear ${BOT}`,
      `tp ${BOT} ${START.x} ${START.y} ${START.z} 0 20`,
    ])
      await this.rcon(c);
    await sleep(1_000);
  }

  /** Non-destructive count of non-air blocks in a box (clone onto itself, masked). */
  async nonAirBlocks(box: string): Promise<number | undefined> {
    const [x1, y1, z1] = box.split(' ');
    const r = await this.rcon(`clone ${box} ${x1} ${y1} ${z1} masked force`, false);
    const m = /cloned (\d+) block/i.exec(r);
    if (m) return Number(m[1]);
    return /no blocks/i.test(r) ? 0 : undefined;
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
    return { nowMs: Date.now(), connection: { ready: this.game.state === 'ready', connectionEpoch: this.game.connectionEpoch, dimension: s.dimension }, snapshot: s, autonomyAllowed: true, active: { kind: 'none' }, ownerIntakePending: false, ownerIntentInterrupted: false, goalLimits: { plannerTurns: 20, tasks: 64, replans: 8, deadlineMs: 20 * 60_000 }, ...over };
  }

  /** C5: settle memory and survival writes (the harness stands in for the integrated async barrier before planning/action). */
  async durable(): Promise<void> {
    await this.memory.flush();
    await this.survival.flush();
  }

  /** Harness-as-supervisor: admit survival's own proposal under a fresh code goal epoch. */
  admitProposal(p: SurvivalProposal): ReturnType<SurvivalService['onSupportAdmitted']> {
    this.admit(randomIds.next('goal'));
    return this.survival.onSupportAdmitted({ proposalId: p.proposalId, goalId: this.goalId, goalEpoch: this.epoch, connectionEpoch: this.game.connectionEpoch, admittedAtMs: Date.now() });
  }

  endSupport(p: SurvivalProposal, reason: string): void {
    this.survival.onSupportTerminal({ proposalId: p.proposalId, goalId: this.goalId, goalEpoch: this.epoch, state: reason === 'outcome_verified' ? 'completed' : 'blocked', reason, detail: reason, counters: { plannerTurns: 0, tasksAdmitted: 1, replans: 0 }, endedAtMs: Date.now() });
  }

  /** RCON `clear <bot> <item> 0` counts of every kit / foreign-pile item (read-only). */
  async inventoryCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const k of TRACKED_ITEMS) out[k] = await this.count(k);
    return out;
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

/** Survival's own accounting for the current episode, in RCON item names (no namespace). */
function recoveryAccounting(g: Gate): { regained: Record<string, number>; duringAttempt: Record<string, number>; afterSync: Record<string, number> } {
  const inc = g.survival.status(Date.now()).incidents.at(-1);
  const bare = (k: string) => k.replace(/^minecraft:/, '');
  const sum = (rows: Array<{ key?: string; count: number }>) => {
    const out: Record<string, number> = {};
    for (const r of rows) if (r.key) out[bare(r.key)] = (out[bare(r.key)] ?? 0) + r.count;
    return out;
  };
  const incidental = inc?.incidental ?? [];
  return { regained: sum(inc?.regained ?? []), duringAttempt: sum(incidental.filter((x) => x.source === 'unplanned_collect')), afterSync: sum(incidental.filter((x) => x.source === 'after_respawn_sync')) };
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
  // Valuable with identity (C3): an enchanted diamond sword; the reply is recorded (component syntax is version-checked here).
  await g.rcon(`give ${BOT} minecraft:diamond_sword[minecraft:enchantments={"minecraft:sharpness":3}] 1`);
  await g.waitFor('kit in the tracked inventory', () => (g.survival.inventory(g.game.connectionEpoch)?.stacks.length ?? 0) >= 3);
  await sleep(500);
  const before = g.survival.inventory(g.game.connectionEpoch);
  ev.push(`tracked before death: ${before?.stacks.map((s) => `${s.key}x${s.count}${s.meta.damage !== undefined ? `(damage ${s.meta.damage}/${s.meta.maxDurability})` : ''}`).join(', ')} source=${before?.source}`);
  const mark = g.packets.length;
  await g.rcon(`kill ${BOT}`);
  await g.waitFor('respawn ready', () => g.survival.tracker.life === 'alive' && g.packets.slice(mark).some((p) => p.name === 'respawn'), 15_000);
  await sleep(1_000);
  // C10 (read-only): where the bot respawned and what loose items lie around it there (passive pickup source).
  ev.push(`respawned at (RCON): ${(await g.rcon(`data get entity ${BOT} Pos`, false)).slice(0, 160)}`);
  ev.push(`item entities within 6 blocks of the respawn point (RCON, read-only): ${(await g.rcon(`execute as ${BOT} at @s if entity @e[type=item,distance=..6]`, false)).slice(0, 80)}`);
  ev.push(`inventory right after respawn (RCON, before any recovery): ${JSON.stringify(await g.inventoryCounts())}`);
  // No spawnpoint change: return the respawned bot to the scene start (its own position only).
  await g.rcon(`tp ${BOT} ${START.x} ${START.y} ${START.z} 0 20`);
  await sleep(1_000);
  ev.push(`packet order around death: ${g.packets.slice(mark, mark + 40).map((p) => `${p.name}${p.detail ? `[${p.detail}]` : ''}`).join(' > ')}`);
  const d = g.survival.tracker.latest();
  const status = g.survival.status(Date.now());
  const inc = status.incidents.at(-1);
  return { captureId: d?.captureId, factId: inc?.incidentFactId };
}

interface RestoreCheck {
  what: string;
  ok: boolean;
  detail: string;
}

/** Chunks of the owned scene (x/z); each is queried before forceloading so only trial-added ones are removed. */
function sceneChunks(): Array<{ cx: number; cz: number }> {
  const out: Array<{ cx: number; cz: number }> = [];
  for (let cx = Math.floor(AREA.x1 / 16); cx <= Math.floor(AREA.x2 / 16); cx += 1) for (let cz = Math.floor(AREA.z1 / 16); cz <= Math.floor(AREA.z2 / 16); cz += 1) out.push({ cx, cz });
  return out;
}

/** Time of day: the day timeline position when stated, else the absolute overworld clock modulo one day. */
async function timeOfDay(g: Gate): Promise<number | undefined> {
  const day = parseTimelineReply(await g.rcon(DAY_QUERY), DAY_TIMELINE);
  if (day !== undefined) return day % DAY_TICKS;
  const abs = parseClockReply(await g.rcon(TIME_QUERY));
  return abs === undefined ? undefined : abs.ticks % DAY_TICKS;
}

/** Absolute clock read (recorded) with its local receive time. */
async function readClock(g: Gate): Promise<{ clock?: string; ticks: number; atMs: number } | undefined> {
  const r = parseClockReply(await g.rcon(TIME_QUERY));
  return r ? { ...r, atMs: Date.now() } : undefined;
}

async function run(outDir: string, withSettings: boolean): Promise<Json> {
  const g = new Gate(outDir);
  /** Settings to restore in `finally` (command, and how to verify it). */
  const restore: Array<{ what: string; command: string | (() => string); verify: () => Promise<boolean> }> = [];
  const restoreChecks: RestoreCheck[] = [];
  const addedForceload: Array<{ cx: number; cz: number }> = [];
  let backupTaken = false;
  let source = { head: 'unknown', dirty: -1 };
  try {
    source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).length };
  } catch {
    // source identity unavailable
  }
  try {
    await g.connect();
    // ---- footprint preconditions (C6): forceload only what is missing; the backup volume must be empty.
    for (const ch of sceneChunks()) {
      const r = await g.rcon(`forceload query ${ch.cx * 16} ${ch.cz * 16}`, false);
      if (/is not marked/i.test(r)) {
        await g.rcon(`forceload add ${ch.cx * 16} ${ch.cz * 16}`);
        addedForceload.push(ch);
      }
    }
    await sleep(1_000);
    const backupNonAir = await g.nonAirBlocks(BACKUP_BOX);
    check(backupNonAir === 0, `backup volume ${BACKUP_BOX} is not verified empty (${backupNonAir ?? 'unknown'} non-air blocks); refusing to change the scene`);
    const backupReply = await g.rcon(`clone ${SCENE_BOX} ${AREA.x1} ${BACKUP_Y.y1} ${AREA.z1}`);
    check(/cloned/i.test(backupReply) || /no blocks/i.test(backupReply), `scene backup failed: ${backupReply.slice(0, 120)}`);
    backupTaken = true;
    await g.scene();

    await g.gate('G1', 'death order, server death location, same-capture memory link, fresh loss assessment', async (ev) => {
      const { captureId, factId } = await killWithKit(g, ev);
      const d = g.survival.tracker.latest();
      check(d, 'no captured death');
      ev.push(`capture ${captureId}: frozenAt=${d.lastAlive.frozenAt} clearingPacketsAfterFreeze=${d.lastAlive.clearingPacketsAfterFreeze} lastAlive=${d.lastAlive.stacks.map((s) => `${s.key}x${s.count}${s.meta.digest ? '#' : ''}`).join(',')} cause=${d.cause.translationKey ?? d.cause.kind} site=${d.site.source} ${JSON.stringify(d.site.at)} offBy=${d.site.clientEstimateOffBy ?? 'n/a'}`);
      const ldl = await g.lastDeathLocation();
      ev.push(`RCON LastDeathLocation: ${ldl.slice(0, 200)}`);
      const pos = /pos: \[I; (-?\d+), (-?\d+), (-?\d+)\]/.exec(ldl);
      const dim = /dimension: "([^"]+)"/.exec(ldl)?.[1];
      ev.push(`memory fact ${factId}; memory status ${g.memory.status().state}`);
      check(d.lastAlive.stacks.length >= 3, 'last-alive inventory kept the kit (frozen before clearing)');
      check(d.site.source === 'server_death_location' && d.site.at, 'the server stated the own death location');
      check(pos && dim, `RCON LastDeathLocation is readable (${ldl.slice(0, 120)})`);
      const block = { x: Math.floor(d.site.at.x), y: Math.floor(d.site.at.y), z: Math.floor(d.site.at.z) };
      // C7: RCON states the namespaced id, the capture holds the session spelling; identity is compared canonically.
      check(sameDimension(dim, d.site.dimension) && block.x === Number(pos[1]) && block.y === Number(pos[2]) && block.z === Number(pos[3]), `captured GlobalPos ${d.site.dimension} ${block.x},${block.y},${block.z} equals RCON LastDeathLocation ${dim} ${pos[1]},${pos[2]},${pos[3]}`);
      check(factId && /^mf-/.test(factId), 'memory recorded the SAME capture and it was linked exactly');
      const inc = g.survival.status(Date.now()).incidents.at(-1);
      ev.push(`incident: ${JSON.stringify(inc)}`.slice(0, 900));
      check(inc && inc.missing.length >= 3, 'fresh respawn assessment lists the missing kit');
      const items = await g.rcon(`execute if entity @e[type=item,${ITEM_AREA}]`, false);
      ev.push(`item entities in the owned scene (RCON): ${items.slice(0, 120)}`);
    });

    await g.gate('G2', 'C3 mixed piles: oversized pile, unrelated loot and a different-identity valuable are refused before collection', async (ev) => {
      await g.rcon(`summon item ${DEATH_AT.x + 3} ${DEATH_AT.y} ${DEATH_AT.z + 3} {Item:{id:"minecraft:bread",count:64},PickupDelay:0s,Tags:["${FOREIGN_TAG}","${FOREIGN_TAG}_bread"]}`);
      await g.rcon(`summon item ${DEATH_AT.x - 3} ${DEATH_AT.y} ${DEATH_AT.z + 3} {Item:{id:"minecraft:dirt",count:3},PickupDelay:0s,Tags:["${FOREIGN_TAG}","${FOREIGN_TAG}_dirt"]}`);
      await g.rcon(`summon item ${DEATH_AT.x} ${DEATH_AT.y} ${DEATH_AT.z - 4} {Item:{id:"minecraft:diamond_sword",count:1,components:{"minecraft:enchantments":{"minecraft:sharpness":1}}},PickupDelay:0s,Tags:["${FOREIGN_TAG}","${FOREIGN_TAG}_sword"]}`);
      await sleep(1_500);
      // C10: what the SERVER states for each pile (RCON entity data) and what the bot's packets state (tracker drop facts).
      for (const pile of ['bread', 'dirt', 'sword']) ev.push(`foreign ${pile} pile (RCON entity data): ${(await g.rcon(`data get entity @e[type=item,tag=${FOREIGN_TAG}_${pile},limit=1,${ITEM_AREA}] Item`, false)).slice(0, 200)}`);
      const drops = g.survival.tracker.dropStacks().filter((d) => d.atMs > 0);
      ev.push(`server-stated drop stacks seen by the bot (packets): ${drops.map((d) => `#${d.entityId} ${d.key}x${d.count}${d.meta.digest ? ` ${d.meta.digest}` : ''}`).join(', ') || 'none'}`);
      await g.durable();
      ev.push(`durability before recovery: survival=${g.survival.durability()}`);
      const decision = g.survival.assess(g.assessInput());
      ev.push(`decision: ${decision.kind} ${decision.kind === 'propose' ? decision.proposal.routine : 'reason' in decision ? decision.reason : ''}`);
      check(decision.kind === 'propose' && decision.proposal.routine === 'death_recovery', 'recovery proposed');
      g.recovery = decision.proposal;
      // C10 baseline: the server inventory right before the recovery admission (respawn-point pickups are already in it).
      g.baseline = await g.inventoryCounts();
      ev.push(`pre-recovery server inventory baseline (RCON): ${JSON.stringify(g.baseline)}`);
      g.admitProposal(decision.proposal);
      const before = g.survival.recoveryTarget({ goalEpoch: g.epoch, connectionEpoch: g.game.connectionEpoch, dimension: g.snapshot().dimension });
      ev.push(`authority before the attempt is durable: ${'error' in before ? before.error : 'authorized'}`);
      check('error' in before && before.error === 'attempt_write_pending', 'NOT authorized immediately after admission (attempt not yet saved)');
      await g.durable();
      const afterCommit = g.survival.recoveryTarget({ goalEpoch: g.epoch, connectionEpoch: g.game.connectionEpoch, dimension: g.snapshot().dimension });
      ev.push(`authority after the attempt is durable: ${'error' in afterCommit ? afterCommit.error : 'authorized'}`);
      check(!('error' in afterCommit), 'recovery authorized only after the durable commit');
      const go = await g.act('go_to_death_site', [], 60_000);
      ev.push(`go_to_death_site: ${go?.status} ${go?.effect.slice(0, 160)}`);
      for (let i = 0; i < 8; i += 1) {
        const o = await g.act('recover_lost_items', [], 30_000);
        if (!o) break;
        ev.push(`recover_lost_items: ${o.status}${o.reason ? ` (${o.reason})` : ''} ${o.effect.slice(0, 220)}`);
        await sleep(300);
      }
      ev.push(`resolver refusals now: ${g.unavailable('recover_lost_items').join(' | ').slice(0, 600)}`);
      const counts = await g.inventoryCounts();
      ev.push(`server inventory (RCON clear 0): ${JSON.stringify(counts)}`);
      ev.push(`foreign piles still on the ground (RCON): ${(await g.rcon(`execute if entity @e[type=item,tag=${FOREIGN_TAG},${ITEM_AREA}]`, false)).slice(0, 120)}`);
      const acc = recoveryAccounting(g);
      ev.push(`survival accounting: regained ${JSON.stringify(acc.regained)}; incidental during the attempt ${JSON.stringify(acc.duringAttempt)}; incidental after the respawn sync ${JSON.stringify(acc.afterSync)}`);
      const base = g.baseline as Record<string, number>;
      check((counts['dirt'] ?? 0) === (base['dirt'] ?? 0), 'no unrelated dirt was collected (server delta 0)');
      check((counts['bread'] ?? 0) - (base['bread'] ?? 0) <= 4, 'the oversized 64-bread pile was not collected (bread delta <= the 4 lost)');
      const mismatch = deltaMismatches(base, counts, acc.regained, acc.duringAttempt);
      check(mismatch.length === 0, `every server inventory change is reported truthfully (regained or incidental): ${mismatch.join('; ')}`);
      const foreignSword = await g.rcon(`execute if entity @e[type=item,tag=${FOREIGN_TAG},nbt={Item:{id:"minecraft:diamond_sword"}},${ITEM_AREA}]`, false);
      ev.push(`foreign (wrong-identity) sword on the ground (RCON): ${foreignSword.slice(0, 80)}`);
      check(/passed/i.test(foreignSword), 'the wrong-identity foreign sword is still on the ground (not collected)');
      const lostSword = g.survival.tracker.latest()?.lastAlive.stacks.find((x) => x.key === 'minecraft:diamond_sword');
      const heldSwords = (g.survival.inventory(g.game.connectionEpoch)?.stacks ?? []).filter((x) => x.key === 'minecraft:diamond_sword');
      ev.push(`lost sword digest ${lostSword?.meta.digest ?? 'none'}; held sword digests ${heldSwords.map((x) => x.meta.digest ?? 'none').join(',') || 'none'}`);
      check(heldSwords.every((x) => lostSword?.meta.digest && x.meta.digest === lostSword.meta.digest), 'any sword now held is the lost one (same server identity digest)');
      check(g.outcomes.every((o) => o.capability !== 'recover_lost_items' || o.reason !== 'unscoped_item_collected'), 'no unplanned loot was collected');
    });

    await g.gate('G2b', 'C3 ordinary unambiguous recovery with server-confirmed collection; recovered vs concluded', async (ev) => {
      check(g.recovery, 'G2 admitted the recovery goal');
      await g.rcon(`kill @e[type=item,tag=${FOREIGN_TAG},${ITEM_AREA}]`);
      await sleep(1_000);
      for (let i = 0; i < 10; i += 1) {
        const o = await g.act('recover_lost_items', [], 30_000);
        if (!o) break;
        ev.push(`recover_lost_items: ${o.status}${o.reason ? ` (${o.reason})` : ''} ${o.effect.slice(0, 220)}`);
        await sleep(300);
      }
      ev.push(`still unavailable: ${g.unavailable('recover_lost_items').join(' | ').slice(0, 300)}`);
      const owner = { goalId: g.goalId, goalEpoch: g.epoch };
      const recovered = g.survival.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'recovered' }, owner);
      const concluded = g.survival.evaluateSurvivalState({ predicate: 'survival_state', routine: 'death_recovery', expect: 'concluded' }, owner);
      ev.push(`recovered: ${recovered.status} ${recovered.detail}; concluded: ${concluded.status} ${concluded.detail}`);
      const counts = await g.inventoryCounts();
      const base = g.baseline ?? {};
      const acc = recoveryAccounting(g);
      ev.push(`server inventory (RCON clear 0): ${JSON.stringify(counts)}; pre-recovery baseline ${JSON.stringify(base)}`);
      ev.push(`survival accounting: regained ${JSON.stringify(acc.regained)}; incidental during the attempt ${JSON.stringify(acc.duringAttempt)}; incidental after the respawn sync ${JSON.stringify(acc.afterSync)}`);
      g.endSupport(g.recovery, recovered.status === 'satisfied' || concluded.status === 'satisfied' ? 'outcome_verified' : 'no_progress');
      const inc = g.survival.status(Date.now()).incidents.at(-1);
      ev.push(`episode: ${inc?.status} regained=${JSON.stringify(inc?.regained)} missing=${JSON.stringify(inc?.missing)}`);
      const collected = g.outcomes.filter((o) => o.capability === 'recover_lost_items' && (o.status === 'succeeded' || o.status === 'partial'));
      check(collected.length > 0, 'at least one server-confirmed collection');
      check(collected.every((o) => o.confirmation === 'server_sync' || o.confirmation === 'server_packet'), 'collections are server-confirmed');
      const lost = g.survival.tracker.latest()?.lastAlive.stacks ?? [];
      const lostSword = lost.find((x) => x.key === 'minecraft:diamond_sword');
      check(lostSword, `the kit's enchanted sword was not in the last-alive record (give reply in setup log) — the matching-valuable trial is unsupported here, not a full recovery`);
      check(lostSword.meta.metadata === 'server_slot' && lostSword.meta.digest, `the lost sword has no server identity metadata (${JSON.stringify(lostSword.meta)}) — identity-matched recovery unsupported, not a full recovery`);
      const heldSword = (g.survival.inventory(g.game.connectionEpoch)?.stacks ?? []).find((x) => x.key === 'minecraft:diamond_sword');
      ev.push(`held sword digest ${heldSword?.meta.digest ?? 'none'} vs lost ${lostSword.meta.digest}`);
      const gained = Object.fromEntries(Object.keys(LOST_KIT).map((k) => [k, (counts[k] ?? 0) - (base[k] ?? 0)]));
      const mismatch = deltaMismatches(base, counts, acc.regained, acc.duringAttempt);
      check(mismatch.length === 0, `every server inventory change since the baseline is reported truthfully: ${mismatch.join('; ')}`);
      check(Object.entries(LOST_KIT).every(([k, n]) => gained[k] === n && acc.regained[k] === n), `full recovery requires the server to gain exactly the lost kit since the pre-recovery baseline (bread 4, cobblestone 20, iron_pickaxe 1, diamond_sword 1; got ${JSON.stringify(gained)}, counted ${JSON.stringify(acc.regained)}); a partial collection is NOT a full trial`);
      // The respawn-point pickups (if any) were reported as incidental, never retained/regained.
      check(Object.keys(base).every((k) => (base[k] ?? 0) === (acc.afterSync[k] ?? 0)), `pre-recovery inventory equals the reported after-respawn-sync incidental effects (respawn sync was empty): baseline ${JSON.stringify(base)} vs reported ${JSON.stringify(acc.afterSync)}`);
      check(heldSword?.meta.digest === lostSword.meta.digest, 'the recovered sword is the lost one (same server identity digest)');
      check(recovered.status === 'satisfied' && inc?.status === 'recovered', `survival_state recovered satisfied and episode recovered (got ${recovered.status}/${inc?.status})`);
    });

    if (!withSettings) {
      for (const [id, title] of [['G1k', 'keep_inventory death'], ['G3', 'food/health on Easy'], ['G4', 'R8 day bed observation'], ['G4n', 'R8 night bed observation']] as const) g.skip(id, title, 'requires --with-settings (difficulty, gamerules, time of day)');
    } else {
      // C8: every original is read with the CURRENT official reply forms BEFORE any write; a failed read changes nothing.
      const difficulty = parseDifficultyReply(await g.rcon('difficulty'));
      const keep = parseRuleReply(await g.rcon(`gamerule ${RULE_KEEP}`), RULE_KEEP);
      const regen = parseRuleReply(await g.rcon(`gamerule ${RULE_REGEN}`), RULE_REGEN);
      const clock0 = await readClock(g);
      await sleep(1_000);
      const clock1 = await readClock(g);
      const clockId = clock0?.clock ?? clock1?.clock;
      check(difficulty && keep && regen && clock0 && clock1 && clockId, `could not read original settings (difficulty=${difficulty} ${RULE_KEEP}=${keep} ${RULE_REGEN}=${regen} clock=${clock0 ? `${clock0.clock ?? '?'}@${clock0.ticks}` : 'undefined'}); nothing changed; replies: ${JSON.stringify(g.setup.slice(-5).map((r) => `${r.command} -> ${r.reply.slice(0, 120)}`))}`);
      // Measured clock rate (ticks per ms; 0 when the clock is paused or advance_time is off).
      const original = { ticks: clock0.ticks, atMs: clock0.atMs, ticksPerMs: clock1.atMs > clock0.atMs ? Math.max(0, (clock1.ticks - clock0.ticks) / (clock1.atMs - clock0.atMs)) : 0 };
      g.notes.push(`original settings: difficulty=${difficulty} ${RULE_KEEP}=${keep} ${RULE_REGEN}=${regen} clock ${clockId}=${clock0.ticks} (rate ${(original.ticksPerMs * 1000).toFixed(2)} ticks/s measured over ${clock1.atMs - clock0.atMs} ms)`);
      let clockTarget = clock0.ticks;
      restore.push(
        { what: 'difficulty', command: `difficulty ${difficulty}`, verify: async () => parseDifficultyReply(await g.rcon('difficulty')) === difficulty },
        { what: RULE_KEEP, command: `gamerule ${RULE_KEEP} ${keep}`, verify: async () => parseRuleReply(await g.rcon(`gamerule ${RULE_KEEP}`), RULE_KEEP) === keep },
        { what: RULE_REGEN, command: `gamerule ${RULE_REGEN} ${regen}`, verify: async () => parseRuleReply(await g.rcon(`gamerule ${RULE_REGEN}`), RULE_REGEN) === regen },
        {
          what: `clock ${clockId}`,
          command: () => {
            clockTarget = clockRestoreTarget(original, Date.now());
            return `time of ${clockId} set ${clockTarget}`;
          },
          verify: async () => {
            const set = parseClockSetReply(g.setup.at(-1)?.reply ?? '');
            const now = await readClock(g);
            const drift = now ? Math.abs(now.ticks - clockTarget) : Number.POSITIVE_INFINITY;
            g.notes.push(`clock restore: target ${clockTarget} (original ${original.ticks} + measured elapsed), server set reply ${set ? `${set.clock ?? ''} ${set.ticks}` : 'unparsed'}, re-read ${now?.ticks ?? 'unreadable'} (drift ${drift})`);
            return set !== undefined && set.ticks === clockTarget && drift <= 100;
          },
        },
      );

      await g.gate('G1k', 'keep_inventory death retains inventory (no trip)', async (ev) => {
        await g.scene();
        await g.rcon(`gamerule ${RULE_KEEP} true`);
        check(parseRuleReply(await g.rcon(`gamerule ${RULE_KEEP}`), RULE_KEEP) === 'true', `${RULE_KEEP} verified true for the trial`);
        const { factId } = await killWithKit(g, ev);
        const inc = g.survival.status(Date.now()).incidents.at(-1);
        ev.push(`incident ${factId}: ${inc?.status} missing=${JSON.stringify(inc?.missing)}`);
        await g.rcon(`gamerule ${RULE_KEEP} ${keep}`);
        check(inc?.status === 'no_loss', 'retained inventory: no_loss, no trip');
        // C1 truthfulness on the ACTUAL memory fact: retained, not regained/recovered.
        await g.durable();
        const fact = g.memory.facts().find((f) => f.id === factId);
        const rec = fact?.death?.recovery as { status?: string; regained?: unknown[]; retained?: Array<{ key: string; count: number }> } | undefined;
        ev.push(`memory death fact ${factId}: recovery ${JSON.stringify(rec).slice(0, 300)}`);
        check(rec && (rec.regained?.length ?? 0) === 0, 'memory reports nothing regained');
        check(rec && (rec.retained?.reduce((n, r) => n + r.count, 0) ?? 0) >= 3, 'memory reports the kit as retained through respawn (requires the integrated memory retained/no_loss API)');
        check(rec?.status === 'no_loss', 'memory recovery status is no_loss, not recovered');
      });

      await g.gate('G3', 'Easy: eat to the admitted threshold; necessary low-health eat; verified regeneration on/off', async (ev) => {
        await g.scene();
        await g.rcon('difficulty easy');
        check(parseDifficultyReply(await g.rcon('difficulty')) === 'easy', 'difficulty verified easy');
        await g.rcon(`gamerule ${RULE_REGEN} true`);
        check(parseRuleReply(await g.rcon(`gamerule ${RULE_REGEN}`), RULE_REGEN) === 'true', `${RULE_REGEN} verified true`);
        await g.rcon(`give ${BOT} minecraft:bread 12`);
        await g.rcon(`effect give ${BOT} minecraft:hunger 30 120 true`);
        await g.waitFor('food at or below 10', () => (g.survival.vitals(g.game.connectionEpoch)?.food ?? 20) <= 10, 40_000);
        await g.rcon(`effect clear ${BOT} minecraft:hunger`);
        await sleep(500);
        // (a) ordinary eat: complete ONLY when survival_state eat is satisfied (food >= eatUntil).
        const cfg = g.survival.config();
        check(cfg, 'survival config');
        let d = g.survival.assess(g.assessInput());
        ev.push(`food ${g.survival.vitals(g.game.connectionEpoch)?.food}: decision ${d.kind} ${d.kind === 'propose' ? d.proposal.routine : 'reason' in d ? d.reason : ''}`);
        check(d.kind === 'propose' && d.proposal.routine === 'eat', 'eat proposed at low food');
        g.admitProposal(d.proposal);
        const owner = { goalId: g.goalId, goalEpoch: g.epoch };
        let eatState = g.survival.evaluateSurvivalState({ predicate: 'survival_state', routine: 'eat', expect: 'satisfied' }, owner);
        for (let i = 0; i < 4 && eatState.status !== 'satisfied'; i += 1) {
          const o = await g.act('eat_safe_food');
          await sleep(600);
          eatState = g.survival.evaluateSurvivalState({ predicate: 'survival_state', routine: 'eat', expect: 'satisfied' }, owner);
          ev.push(`eat ${i + 1}: ${o?.status} ${o?.effect.slice(0, 120)}; server food ${g.survival.vitals(g.game.connectionEpoch)?.food}; eat state ${eatState.status}`);
        }
        g.endSupport(d.proposal, eatState.status === 'satisfied' ? 'outcome_verified' : 'no_progress');
        check(eatState.status === 'satisfied' && (g.survival.vitals(g.game.connectionEpoch)?.food ?? 0) >= cfg.food.eatUntil, `eat completed only at the admitted threshold (food >= ${cfg.food.eatUntil})`);
        // (b) necessary low-health eat right after (the ordinary eat cooldown must NOT suppress it).
        await g.rcon(`damage ${BOT} 13 minecraft:generic`);
        await g.waitFor('health <= 8', () => (g.survival.vitals(g.game.connectionEpoch)?.health ?? 20) <= 8, 10_000);
        await g.rcon(`effect give ${BOT} minecraft:hunger 10 60 true`);
        await g.waitFor('food below 18', () => (g.survival.vitals(g.game.connectionEpoch)?.food ?? 20) < 18, 40_000);
        await g.rcon(`effect clear ${BOT} minecraft:hunger`);
        d = g.survival.assess(g.assessInput());
        ev.push(`low health decision: ${d.kind} ${d.kind === 'propose' ? `${d.proposal.routine} allowance=${JSON.stringify(d.proposal.lowHealthAllowance)}` : 'reason' in d ? d.reason : ''}`);
        check(d.kind === 'propose' && d.proposal.routine === 'eat' && d.proposal.lowHealthAllowance, 'a necessary low-health eat with a narrow allowance is proposed despite the earlier eat cooldown');
        const grant = g.admitProposal(d.proposal);
        check(grant, 'grant issued once for the admitted support epoch');
        const ref = { goalId: g.goalId, goalEpoch: g.epoch, taskId: 'task-gate1', connectionEpoch: g.game.connectionEpoch, allowedCapabilities: grant.capabilities };
        const c1 = g.survival.check(ref, g.snapshot());
        ev.push(`check: ${JSON.stringify(c1).slice(0, 200)}`);
        check(c1.allowed, 'allowance check passes with fresh vitals and no threat');
        const cand = g.candidates.generate({ objective: 'eat', decisionInstruction: 'eat', allowedCapabilities: [...grant.capabilities], targetSelectors: [], parameters: {}, completion: { predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 1, mode: 'possess' } }, g.snapshot()).candidates[0];
        check(cand, 'a grounded eat candidate exists');
        const rc = g.survival.reserve(c1.allowanceId, ref, cand, g.snapshot());
        ev.push(`reserve (recheck + count before dispatch): ${JSON.stringify(rc).slice(0, 200)}`);
        check(rc.allowed, 'post-choice recheck/reservation passes');
        const foodBefore = g.survival.vitals(g.game.connectionEpoch)?.food ?? 0;
        const out = await g.executor.execute(cand, new AbortController().signal, { kind: 'goal', goalEpoch: g.epoch, goalId: g.goalId, taskId: 'task-gate1' });
        g.survival.consumed(c1.allowanceId, { actionId: out.actionId, capability: cand.capability, status: out.status });
        await sleep(600);
        const foodAfter = g.survival.vitals(g.game.connectionEpoch)?.food ?? 0;
        ev.push(`low-health eat: ${out.status} ${out.effect.slice(0, 160)}; server food ${foodBefore} -> ${foodAfter}`);
        check(foodAfter > foodBefore, 'the low-health eat raised the server food level');
        g.endSupport(d.proposal, 'no_progress'); // one dispatch observed; not labeled a completed routine
        // (c) regeneration ON (verified above): resting must raise server health by >= 1.
        for (let i = 0; i < 4 && (g.survival.vitals(g.game.connectionEpoch)?.food ?? 0) < 18; i += 1) {
          g.admit(randomIds.next('goal'));
          await g.act('eat_safe_food');
          await sleep(600);
        }
        check((g.survival.vitals(g.game.connectionEpoch)?.food ?? 0) >= 18, 'food >= 18 before the regeneration trial');
        const h0 = g.survival.vitals(g.game.connectionEpoch)?.health ?? 0;
        g.admit(randomIds.next('goal'));
        const restOn = await g.act('rest_in_place', [], 20_000);
        const h1 = g.survival.vitals(g.game.connectionEpoch)?.health ?? 0;
        ev.push(`rest (regen verified on): ${restOn?.status} ${restOn?.effect.slice(0, 160)}; server health ${h0} -> ${h1}`);
        check(restOn?.status === 'succeeded' && h1 - h0 >= 1, 'meaningful server-confirmed health gain (>= 1) while resting');
        // (d) regeneration OFF (verified): bounded honest failure, no gain.
        await g.rcon(`damage ${BOT} 4 minecraft:generic`);
        await g.rcon(`gamerule ${RULE_REGEN} false`);
        check(parseRuleReply(await g.rcon(`gamerule ${RULE_REGEN}`), RULE_REGEN) === 'false', `${RULE_REGEN} verified false`);
        await sleep(500);
        const h2 = g.survival.vitals(g.game.connectionEpoch)?.health ?? 0;
        const t0 = Date.now();
        g.admit(randomIds.next('goal'));
        const restOff = await g.act('rest_in_place', [], 20_000);
        const h3 = g.survival.vitals(g.game.connectionEpoch)?.health ?? 0;
        ev.push(`rest (regen verified off): ${restOff?.status} ${restOff?.reason ?? ''} after ${Date.now() - t0}ms; server health ${h2} -> ${h3}`);
        await g.rcon(`gamerule ${RULE_REGEN} ${regen}`);
        check(restOff?.status === 'failed' && restOff.reason === 'no_regeneration' && h3 <= h2 && Date.now() - t0 < 20_000, 'no regeneration ends honestly within the bounded window');
      });

      await g.gate('G4', 'R8 OBSERVATION: daytime bed use; server respawn data recorded (no routine, no R8 claim)', async (ev) => {
        await g.scene();
        await g.rcon(`difficulty ${difficulty}`);
        await g.rcon('time set 1000');
        const t = await timeOfDay(g);
        check(t !== undefined && t >= 0 && t < 12_000, `day established at trial start (time of day ${t})`);
        await g.rcon(`setblock ${BED.foot.x} ${BED.foot.y} ${BED.foot.z} red_bed[facing=south,part=foot]`);
        await g.rcon(`setblock ${BED.head.x} ${BED.head.y} ${BED.head.z} red_bed[facing=south,part=head]`);
        await g.rcon(`tp ${BOT} 208.5 -60 206.5 0 40`);
        await sleep(1_500);
        ev.push(`respawn before: ${(await g.rcon(`data get entity ${BOT} respawn`, false)).slice(0, 200)}`);
        g.admit(randomIds.next('goal'));
        const used = await g.act('interact_block', ['minecraft:red_bed'], 15_000);
        ev.push(`interact_block bed (day): ${used?.status} ${used?.reason ?? ''} ${used?.effect.slice(0, 200)}`);
        await sleep(1_000);
        const after = await g.rcon(`data get entity ${BOT} respawn`, false);
        ev.push(`respawn after: ${after.slice(0, 200)}`);
        const spawnSetToBed = new RegExp(`${BED.foot.x}, ${BED.foot.y}, ${BED.foot.z}|${BED.head.x}, ${BED.head.y}, ${BED.head.z}`).test(after);
        ev.push(`OBSERVED: respawn point at the bed = ${spawnSetToBed} (observation only; R8 remains gated)`);
        check(used, 'a bed candidate existed (bed visible and in reach)');
      });

      await g.gate('G4n', 'R8 OBSERVATION: night sleep, sole player (recorded, not generalized)', async (ev) => {
        await g.scene();
        await g.rcon(`setblock ${BED.foot.x} ${BED.foot.y} ${BED.foot.z} red_bed[facing=south,part=foot]`);
        await g.rcon(`setblock ${BED.head.x} ${BED.head.y} ${BED.head.z} red_bed[facing=south,part=head]`);
        await g.rcon('time set 13000');
        const t = await timeOfDay(g);
        check(t !== undefined && t >= 12_542 && t < 23_460, `night established at trial start (time of day ${t})`);
        await g.rcon(`tp ${BOT} 208.5 -60 206.5 0 40`);
        await sleep(1_500);
        g.admit(randomIds.next('goal'));
        const used = await g.act('interact_block', ['minecraft:red_bed'], 15_000);
        ev.push(`interact_block bed (night): ${used?.status} ${used?.reason ?? ''} ${used?.effect.slice(0, 200)}`);
        await sleep(1_000);
        const sleeping = await g.rcon(`data get entity ${BOT} sleeping_pos`, false);
        const occupied = /passed/i.test(await g.rcon(`execute if block ${BED.foot.x} ${BED.foot.y} ${BED.foot.z} red_bed[occupied=true]`, false));
        ev.push(`OBSERVED: server sleeping_pos: ${sleeping.slice(0, 160)}; bed occupied=${occupied}`);
        await sleep(6_000);
        ev.push(`OBSERVED: time after ~7 s: ${(await g.rcon(TIME_QUERY, false)).slice(0, 80)}; players online: ${(await g.rcon('list', false)).slice(0, 120)}`);
        ev.push('R8 sleep/spawn remains gated: these are sole-player observations, not a supported routine');
        check(used, 'a bed candidate existed at night');
      });
    }
  } catch (error) {
    g.results.push({ id: 'SETUP', title: 'trial setup/preconditions', status: 'fail', evidence: [error instanceof Error ? error.message : String(error)] });
  } finally {
    // ---- restoration (C6): every step verified; any failure fails the report.
    const step = async (what: string, fn: () => Promise<boolean | string>) => {
      try {
        const r = await fn();
        restoreChecks.push({ what, ok: r === true, detail: r === true ? 'verified' : String(r) });
      } catch (error) {
        restoreChecks.push({ what, ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    };
    for (const r of restore) {
      await step(`setting ${r.what}`, async () => {
        const command = typeof r.command === 'function' ? r.command() : r.command;
        return (await g.rcon(command)) !== undefined && (await r.verify()) ? true : `not restored (${command})`;
      });
    }
    await step('foreign test piles removed', async () => {
      await g.rcon(`kill @e[type=item,tag=${FOREIGN_TAG},${ITEM_AREA}]`);
      return /failed|no entity|0/i.test(await g.rcon(`execute if entity @e[type=item,tag=${FOREIGN_TAG}]`, false)) || 'tagged piles remain';
    });
    await step('bot state cleared', async () => {
      await g.rcon(`clear ${BOT}`);
      await g.rcon(`effect clear ${BOT}`);
      await g.rcon(`tp ${BOT} ${START.x} ${SCENE_Y.y2 + 1} ${START.z} 0 20`);
      return true;
    });
    if (backupTaken) {
      await step('scene item/xp entities removed', async () => {
        await g.rcon(`kill @e[type=item,${ITEM_AREA}]`);
        await g.rcon(`kill @e[type=experience_orb,${ITEM_AREA}]`);
        return true;
      });
      await step('scene restored from backup', async () => {
        await g.rcon(`clone ${AREA.x1} ${BACKUP_Y.y1} ${AREA.z1} ${AREA.x2} ${BACKUP_Y.y2} ${AREA.z2} ${AREA.x1} ${SCENE_Y.y1} ${AREA.z1} replace force`);
        const v = await g.rcon(`execute if blocks ${AREA.x1} ${BACKUP_Y.y1} ${AREA.z1} ${AREA.x2} ${BACKUP_Y.y2} ${AREA.z2} ${AREA.x1} ${SCENE_Y.y1} ${AREA.z1} all`, false);
        return /passed/i.test(v) || `scene differs from the pre-trial copy: ${v.slice(0, 120)}`;
      });
      await step('backup volume cleared and verified empty', async () => {
        await g.rcon(`fill ${BACKUP_BOX} air`);
        const n = await g.nonAirBlocks(BACKUP_BOX);
        return n === 0 || `backup volume still has ${n ?? 'unknown'} non-air blocks`;
      });
    }
    for (const ch of addedForceload) {
      await step(`forceload ${ch.cx},${ch.cz} removed (trial-added)`, async () => {
        await g.rcon(`forceload remove ${ch.cx * 16} ${ch.cz * 16}`);
        return /is not marked/i.test(await g.rcon(`forceload query ${ch.cx * 16} ${ch.cz * 16}`, false)) || 'still force-loaded';
      });
    }
    await g.memory.close().catch(() => undefined);
    await g.survival.close().catch(() => undefined);
    await g.game.disconnect('operator_stop').catch(() => undefined);
  }
  const restoreOk = restoreChecks.every((c) => c.ok);
  g.results.push({ id: 'RESTORE', title: 'verified restoration of settings, scene, entities and forceload', status: restoreOk ? 'pass' : 'fail', evidence: restoreChecks.map((c) => `${c.ok ? 'OK' : 'FAILED'} ${c.what}: ${c.detail}`) });
  const counted = g.results.filter((r) => r.status !== 'skipped');
  return {
    check: 'MB-FLOW-003 survival mechanics gate (pre-integration module harness; no model calls; NOT integrated-application acceptance)',
    fixture: PINS.profile,
    source,
    withSettings,
    footprint: { scene: SCENE_BOX, backup: BACKUP_BOX, foreignTag: FOREIGN_TAG, addedForceload },
    restoration: restoreChecks,
    pass: counted.length > 0 && counted.every((r) => r.status === 'pass'),
    results: g.results,
    setup: g.setup,
    notes: g.notes,
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
