// MB-FLOW-003-C11/C13 immediate-safety mechanics gate (W-G1/W-G2/W-G3,
// M-G1/M-G2 module evidence) against the LOCAL loopback test fixture only.
//
// PRE-INTEGRATION harness: until the shared writer (P) adds the `safety`
// ExecutionOwner variant to ports.ts/SkillOutcome and wires SafetyService into
// SkillRuntime/TaskRuntime, this script composes the REAL connection, the real
// SkillRuntime (perception, knowledge, ledger), its own single ActuatorLeases
// (goal owners fenced by the harness goal epoch, safety owners by
// SafetyService.grantCurrent), the real SkillExecutorImpl for GOAL work, and a
// labeled STAND-IN executor for safety owners that follows SkillExecutorImpl's
// order (acquire -> abort->revoke -> fenced skill -> release). No shared file
// is changed. No model is called. The harness plays the explicit authority
// provider (basis owner_goal for its admitted test goal; none after stop).
//
// Gates (module evidence; none is integrated-application or real-provider acceptance):
//   W1   deep water (4 deep): submerged bot surfaces and exits to dry ground with
//        no RCON rescue; server Air/Health/Pos via RCON; no drowning damage.
//   W1s  stop wins: with authority `none` a surfaced bot is NOT held up (sinks,
//        server air falls — W-G1 premise); then a newly admitted owner goal
//        authorizes the escape.
//   W2   unsupported water entry during ordinary goal work: a goal move_near
//        across the pool is preempted (`safety_preempt`) and the bot exits —
//        or, after P integrates the deep-water path policy, the path is
//        refused; whichever happened is recorded.
//   W3   solid ceiling, no open column: declarative blocker, no blind jump
//        (water breathing given; intervention recorded).
//   M1   unarmed + zombie: retreat increases SERVER-measured separation; no attack.
//   M2   armed (iron sword/helmet/chestplate, health 20): single zombie defended;
//        defeat only from the server death status; RCON confirms it is gone.
//   M2b  readiness change mid-fight (RCON /damage) downgrades to retreat.
//   M3   creeper with full gear: avoidance only, never an attack packet.
//   M3b  cow + wolf beside the bot: no episode, no attack.
//   M4   stop during a retreat: lease and controls cleared; no further motion.
//
//   npm run fixture -- status                               (fixture lease required)
//   node scripts/safety-live-check.ts --fixture-lease <granted id> [--fixture 26.2]
//
// OWNED WRITE FOOTPRINT — every block/entity write stays inside these:
//   scene   x 240..270, y -61..-48, z 190..220 (blocks; tagged mobs; item/xp drops)
//   backup  x 240..270, y 200..213, z 190..220 (pre-trial copy; must be verified
//           EMPTY before use, else the trial refuses to start; restored, cleared
//           and re-verified at the end)
//   forceload: only chunks this trial added are removed again
//   entities: only mobs with this run's unique tag; item/xp entities in the scene box
//   bot: inventory/effects/position/health of the fixture bot only
//   settings: difficulty is READ; only if it is peaceful (mobs cannot exist) it is
//           set to easy and restored + re-verified in `finally`. No gamerule or
//           time changes. ANY failed restoration fails the report.
//
// Report: var/live-check/<stamp>[-26.2]-safety/report.json
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { DEFAULT_FIXTURE_PROFILE, PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { loadConfigFile } from '../src/config/load.ts';
import { randomIds, systemClock, type ActionCandidate, type ExecutionOwner, type GameLifecycleEvent, type SkillOutcome } from '../src/contracts/index.ts';
import type { SafetyAuthority, SafetyExecutionOwner } from '../src/contracts/safety.ts';
import { Actuator } from '../src/execution/actuator.ts';
import { SkillExecutorImpl, clearSharedControls } from '../src/execution/executor.ts';
import { ActuatorLeases, LeaseRevokedError } from '../src/execution/lease.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { MineflayerConnection } from '../src/game/connection.ts';
import { createSafetyRuntime } from '../src/safety/wiring.ts';
import type { SafetyService } from '../src/safety/service.ts';
import { allSkills } from '../src/skills/index.ts';
import { safetySkills } from '../src/skills/safety.ts';
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
const AREA = { x1: 240, z1: 190, x2: 270, z2: 220 };
const SCENE_Y = { y1: -61, y2: -48 };
const BACKUP_Y = { y1: 200, y2: 213 };
const SCENE_BOX = `${AREA.x1} ${SCENE_Y.y1} ${AREA.z1} ${AREA.x2} ${SCENE_Y.y2} ${AREA.z2}`;
const BACKUP_BOX = `${AREA.x1} ${BACKUP_Y.y1} ${AREA.z1} ${AREA.x2} ${BACKUP_Y.y2} ${AREA.z2}`;
/** Entity selector volume == the declared owned scene. */
const ENTITY_AREA = `x=${AREA.x1},y=${SCENE_Y.y1},z=${AREA.z1},dx=${AREA.x2 - AREA.x1},dy=${SCENE_Y.y2 - SCENE_Y.y1},dz=${AREA.z2 - AREA.z1}`;
/** Unique per-run tag for every summoned mob. */
const MOB_TAG = `cbsafe_${Date.now().toString(36)}_${process.pid.toString(36)}`;
/** Raised dirt platform (feet level -56) with a 7x7, 4-deep pool. */
const PLATFORM = { y1: -60, y2: -57 };
const POOL = { x1: 252, z1: 202, x2: 258, z2: 208 };
const POOL_FLOOR = { x: 255.5, y: -60, z: 205.5 };
const POOL_SURFACE = { x: 255.5, y: -57.6, z: 205.5 };
const ARENA = { x: 264.5, y: -56, z: 195.5 };
const DIFF_REPLY = /difficulty is (\w+)/i;

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
  readonly written: Array<{ atMs: number; name: string; entityId?: number }> = [];
  readonly store = new MemoryRunStore();
  readonly game: MineflayerConnection;
  readonly runtime: SkillRuntime;
  readonly leases: ActuatorLeases;
  readonly goalExecutor: SkillExecutorImpl;
  readonly safety: SafetyService;
  readonly outcomes: SkillOutcome[] = [];
  /** Harness goal epoch (stands in for the GoalEngine). */
  epoch = 0;
  goalId = 'goal-safetygate';
  /** Explicit authority basis the harness provides (the shared writer's job after integration). */
  basis: SafetyAuthority['basis'] = 'none';
  travel: SafetyAuthority['travel'] = null;
  private readonly password: string;
  private rconQueue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.password = readRconPassword();
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
      createBot: (options) => {
        const bot = mineflayer.createBot(options);
        // Proposed onBotCreated hook: attach the safety tracker BEFORE login.
        this.safety.attachConnection(bot._client as never, { connectionEpoch: this.game.connectionEpoch, registry: () => bot.registry });
        const write = bot._client.write.bind(bot._client);
        (bot._client as unknown as { write: (n: string, d: Json) => void }).write = (name: string, data: Json) => {
          if (name === 'attack' || name === 'use_entity') this.written.push({ atMs: Date.now(), name, ...(typeof data['entityId'] === 'number' ? { entityId: data['entityId'] } : typeof data['target'] === 'number' ? { entityId: data['target'] } : {}) });
          write(name, data);
        };
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
    // ONE lease set for goal and safety work (the shared writer's ownerCurrent extension, stood in here).
    this.leases = new ActuatorLeases({
      clock: systemClock,
      ownerCurrent: (o) => {
        const owner = o as ExecutionOwner | SafetyExecutionOwner;
        if (owner.kind === 'safety') return this.safety.grantCurrent(owner.grantId);
        return owner.kind === 'goal' ? owner.goalEpoch === this.epoch : false;
      },
      connectionEpoch: () => this.game.connectionEpoch,
      clearShared: () => clearSharedControls(this.game.session()?.bot),
      record: (e) => this.store.record({ ...e, type: String(e['type'] ?? 'lease_event') }),
    });
    const sessionFn = () => this.game.session();
    const rt = createSafetyRuntime({
      config: { mobs: { maxDisplacement: 12 } },
      session: sessionFn,
      perception: this.runtime.perception,
      inTag: (tag, key) => Boolean(this.runtime.knowledge.recipes?.matches(tag, key)),
      authority: () => this.authority(),
      actuation: {
        preemptCurrent: (reason) => {
          const cur = this.leases.current;
          if (!cur || (cur.owner as { kind: string }).kind === 'safety') return { revoked: false, holder: cur ? 'safety' : null, clearMs: null };
          const r = this.leases.revoke(cur, reason);
          return { revoked: Boolean(r), holder: cur.owner.kind, clearMs: r?.clearMs ?? null };
        },
        execute: (c, s, o) => this.safetyExecute(c, s, o),
      },
      clock: systemClock,
      ids: randomIds,
      record: (e) => this.store.record(e),
    });
    this.safety = rt.service;
    const registry = new SkillRegistry([...allSkills(), ...safetySkills(this.safety)]);
    this.registry = registry;
    this.goalExecutor = new SkillExecutorImpl({ registry, leases: this.leases, session: sessionFn, services: this.runtime.services, goalEpoch: () => this.epoch, store: this.store });
    this.game.onLifecycle((event) => this.onLifecycle(event));
  }

  readonly registry: SkillRegistry;

  authority(): SafetyAuthority {
    const s = this.game.session();
    const ready = this.game.state === 'ready' && s !== undefined;
    return {
      basis: this.basis,
      detail: this.basis === 'owner_goal' ? `harness owner goal ${this.goalId} (epoch ${this.epoch})` : 'harness: no owner goal / explicit stop',
      connection: ready ? { ready: true, connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension) } : null,
      alive: ready && (s.bot.health ?? 0) > 0,
      goal: this.basis === 'owner_goal' ? { goalId: this.goalId, goalEpoch: this.epoch, source: 'owner' } : null,
      travel: this.travel,
    };
  }

  /**
   * STAND-IN for SkillExecutorImpl with the proposed `safety` owner variant
   * (same order: acquire -> abort revokes -> fenced skill -> release). Labeled
   * pre-integration; the integrated executor replaces it.
   */
  async safetyExecute(candidate: ActionCandidate, signal: AbortSignal, owner: SafetyExecutionOwner): Promise<SkillOutcome> {
    const session = this.game.session();
    const def = this.registry.get(candidate.capability);
    const base = { actionId: candidate.id, owner: 'diagnostic' as const, capability: candidate.capability, connectionEpoch: candidate.connectionEpoch, goalEpoch: candidate.goalEpoch, elapsedMs: 0 };
    if (!session || !def || signal.aborted) return { ...base, status: 'precondition_failed', effect: 'not runnable', reason: 'not_runnable', confirmation: 'none', evidence: {} };
    const lease = this.leases.acquire(owner as unknown as ExecutionOwner);
    const act = new Actuator(session, lease, systemClock);
    const onAbort = () => this.leases.revoke(lease, 'owner_stop');
    signal.addEventListener('abort', onAbort, { once: true });
    const started = Date.now();
    try {
      const r = await def.execute({ act, session, services: this.runtime.services, candidate, owner: owner as unknown as ExecutionOwner, progress: () => undefined }, def.params.parse(candidate.parameters));
      lease.fence();
      const o: SkillOutcome = { ...base, elapsedMs: Date.now() - started, status: r.status, effect: r.effect, ...(r.reason ? { reason: r.reason } : {}), confirmation: r.confirmation, evidence: { ...(r.evidence ?? {}), standIn: 'pre-integration safety executor', commandsIssued: act.issued } };
      this.outcomes.push(o);
      return o;
    } catch (error) {
      const reason = error instanceof LeaseRevokedError || lease.revocation ? (lease.revocation ?? 'cancelled') : 'runtime_error';
      const o: SkillOutcome = { ...base, elapsedMs: Date.now() - started, status: reason === 'runtime_error' ? 'failed' : 'cancelled', reason, effect: error instanceof Error ? error.message.slice(0, 300) : String(error), confirmation: 'none', evidence: { commandsIssued: act.issued } };
      this.outcomes.push(o);
      return o;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.leases.revoke(lease, 'completed');
    }
  }

  /** Proposed lifecycle order: safety revokes its grant first, then the skill layer invalidates. */
  private onLifecycle(event: GameLifecycleEvent): void {
    this.safety.onLifecycle(event);
    if (event.type === 'death' || event.type === 'dimension_change' || event.type === 'ended') this.leases.revokeCurrent(`lifecycle_${event.type}`);
    this.runtime.onLifecycle(event);
  }

  /** Harness owner goal admission (travel anchor at the bot, bounded radius). */
  admit(radius: number): void {
    this.epoch += 1;
    this.goalId = `goal-safety${this.epoch.toString().padStart(4, '0')}`;
    this.runtime.onGoalAdmitted({ goalId: this.goalId, epoch: this.epoch, admittedAtMs: Date.now() });
    const p = this.game.session()?.bot.entity.position;
    this.travel = p ? { anchor: { x: p.x, y: p.y, z: p.z }, radius } : null;
    this.basis = 'owner_goal';
    this.safety.onAuthorityChanged('owner_goal_admitted');
  }

  stop(): void {
    this.epoch += 1; // goal ownership revoked first
    this.basis = 'none';
    this.travel = null;
    this.safety.onAuthorityChanged('owner_stop');
    this.leases.revokeCurrent('owner_stop');
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
    } finally {
      this.stop();
      await sleep(300);
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

  async waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await cond()) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async nonAirBlocks(box: string): Promise<number | undefined> {
    const [x1, y1, z1] = box.split(' ');
    const r = await this.rcon(`clone ${box} ${x1} ${y1} ${z1} masked force`, false);
    const m = /cloned (\d+) block/i.exec(r);
    if (m) return Number(m[1]);
    return /no blocks/i.test(r) ? 0 : undefined;
  }

  /** SERVER facts of the bot (RCON NBT), never the client model. */
  async serverBot(): Promise<{ pos: [number, number, number] | null; air: number | null; health: number | null }> {
    const pos = /\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/.exec(await this.rcon(`data get entity ${BOT} Pos`, false));
    const air = /(-?\d+)s/.exec(await this.rcon(`data get entity ${BOT} Air`, false));
    const health = /([\d.]+)f/.exec(await this.rcon(`data get entity ${BOT} Health`, false));
    return { pos: pos ? [Number(pos[1]), Number(pos[2]), Number(pos[3])] : null, air: air ? Number(air[1]) : null, health: health ? Number(health[1]) : null };
  }

  async serverEntityPos(tag: string): Promise<[number, number, number] | null> {
    const m = /\[([-\d.]+)d, ([-\d.]+)d, ([-\d.]+)d\]/.exec(await this.rcon(`data get entity @e[tag=${tag},limit=1,${ENTITY_AREA}] Pos`, false));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  async entityExists(tag: string): Promise<boolean> {
    return !/failed|no entity|test failed|0$/i.test(await this.rcon(`execute if entity @e[tag=${tag},${ENTITY_AREA}]`, false));
  }

  /** Scene inside the owned footprint: platform, pool, cleared bot. */
  async scene(opts: { lid?: boolean } = {}): Promise<void> {
    for (const c of [
      `kill @e[tag=${MOB_TAG},${ENTITY_AREA}]`,
      `kill @e[type=item,${ENTITY_AREA}]`,
      `kill @e[type=experience_orb,${ENTITY_AREA}]`,
      `fill ${AREA.x1} ${PLATFORM.y1} ${AREA.z1} ${AREA.x2} ${SCENE_Y.y2} ${AREA.z2} air`,
      `fill ${AREA.x1} ${PLATFORM.y1} ${AREA.z1} ${AREA.x2} ${PLATFORM.y2} ${AREA.z2} dirt`,
      `fill ${POOL.x1} ${PLATFORM.y1} ${POOL.z1} ${POOL.x2} ${PLATFORM.y2} ${POOL.z2} water`,
      ...(opts.lid ? [`fill ${POOL.x1} ${PLATFORM.y2} ${POOL.z1} ${POOL.x2} ${PLATFORM.y2} ${POOL.z2} stone`] : []),
      `clear ${BOT}`,
      `effect clear ${BOT}`,
      `effect give ${BOT} minecraft:instant_health 1 4 true`,
      `effect give ${BOT} minecraft:saturation 1 10 true`,
    ])
      await this.rcon(c);
    await sleep(800);
  }

  async tp(p: { x: number; y: number; z: number }): Promise<void> {
    await this.rcon(`tp ${BOT} ${p.x} ${p.y} ${p.z} 0 0`);
    await sleep(600);
  }

  async summon(kind: string, at: { x: number; y: number; z: number }, nbt = ''): Promise<string> {
    const tag = `${MOB_TAG}_${kind}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    await this.rcon(`summon minecraft:${kind} ${at.x} ${at.y} ${at.z} {Tags:["${MOB_TAG}","${tag}"],PersistenceRequired:1b${nbt}}`);
    // Daylight must not end a zombie trial early (no time change): fire resistance on the tagged mob only.
    await this.rcon(`effect give @e[tag=${tag},${ENTITY_AREA}] minecraft:fire_resistance infinite 0 true`);
    return tag;
  }

  async arm(): Promise<void> {
    for (const c of [`item replace entity ${BOT} hotbar.0 with minecraft:iron_sword`, `item replace entity ${BOT} armor.head with minecraft:iron_helmet`, `item replace entity ${BOT} armor.chest with minecraft:iron_chestplate`]) await this.rcon(c);
    await sleep(800);
  }

  episodeAfter(startCount: number) {
    return this.safety.episodes().slice(startCount);
  }
}

function readRconPassword(): string {
  const fx = fixturePaths(PROJECT_ROOT, PINS);
  const line = readFileSync(fx.properties, 'utf8').split('\n').find((l) => l.startsWith('rcon.password='));
  if (!line) throw new Error('fixture RCON password missing');
  return line.slice('rcon.password='.length).trim();
}

function sceneChunks(): Array<{ cx: number; cz: number }> {
  const out: Array<{ cx: number; cz: number }> = [];
  for (let cx = Math.floor(AREA.x1 / 16); cx <= Math.floor(AREA.x2 / 16); cx += 1) for (let cz = Math.floor(AREA.z1 / 16); cz <= Math.floor(AREA.z2 / 16); cz += 1) out.push({ cx, cz });
  return out;
}

const inPool = (p: [number, number, number]) => p[0] >= POOL.x1 && p[0] <= POOL.x2 + 1 && p[2] >= POOL.z1 && p[2] <= POOL.z2 + 1 && p[1] < -56.2;
const dist2 = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[2] - b[2]);

interface RestoreCheck {
  what: string;
  ok: boolean;
  detail: string;
}

async function run(): Promise<Json> {
  const g = new Gate();
  const restoreChecks: RestoreCheck[] = [];
  const addedForceload: Array<{ cx: number; cz: number }> = [];
  let backupTaken = false;
  let difficulty: { original: string | undefined; changed: boolean } = { original: undefined, changed: false };
  let source = { head: 'unknown', dirty: -1 };
  try {
    source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).length };
  } catch {
    // source identity unavailable
  }
  try {
    await g.connect();
    g.safety.start();
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
    difficulty.original = DIFF_REPLY.exec(await g.rcon('difficulty'))?.[1]?.toLowerCase();
    check(difficulty.original !== undefined, 'could not read the original difficulty; refusing to continue');
    if (difficulty.original === 'peaceful') {
      await g.rcon('difficulty easy');
      difficulty = { ...difficulty, changed: true };
    }

    // ---------------------------------------------------------------- water
    await g.gate('W1', 'submerged in 4-deep water: surface and exit with no RCON rescue (server Air/Health/Pos)', async (ev) => {
      await g.scene();
      await g.tp(POOL_FLOOR);
      const before = await g.serverBot();
      ev.push(`server before: pos ${before.pos?.join(',')} air ${before.air} health ${before.health}`);
      const n = g.safety.episodes().length;
      const t0 = Date.now();
      g.admit(24);
      await g.waitFor('episode end', () => g.episodeAfter(n).length > 0 && g.safety.hold() === null, 30_000);
      const ep = g.episodeAfter(n)[0]!;
      const after = await g.serverBot();
      ev.push(`episode ${ep.outcome}/${ep.reason} in ${Date.now() - t0}ms, ${ep.actions} step(s), displacement ${ep.displacement}: ${ep.detail}`);
      ev.push(`server after: pos ${after.pos?.join(',')} air ${after.air} health ${after.health}; tracker air statements ${g.safety.tracker.counts.airStatements}, other-entity air ignored ${g.safety.tracker.counts.otherEntityAirIgnored}`);
      check(ep.outcome === 'resolved', `episode ${ep.outcome}`);
      check(after.pos && !inPool(after.pos), 'server position is out of the pool');
      check(after.health !== null && before.health !== null && after.health >= before.health, 'no drowning damage (server health)');
    });

    await g.gate('W1s', 'stop wins: no hold-up without authority (sinks, server air falls); a new owner goal then authorizes the escape', async (ev) => {
      await g.scene();
      await g.tp(POOL_SURFACE);
      g.stop();
      const p0 = await g.serverBot();
      await sleep(4_000);
      const p1 = await g.serverBot();
      ev.push(`no authority: server y ${p0.pos?.[1]} -> ${p1.pos?.[1]}, air ${p0.air} -> ${p1.air}; lease ${g.leases.current ? 'HELD' : 'none'}; tracker air ${JSON.stringify(g.safety.tracker.air)}`);
      check(!g.leases.current, 'no safety lease without authority');
      check(p0.pos && p1.pos && p1.pos[1] < p0.pos[1] - 0.5, 'the body sank with released controls (W-G1 premise)');
      check(p1.air !== null && p1.air < 300 && g.safety.tracker.air !== null, 'server air fell and the tracker saw own air metadata');
      const n = g.safety.episodes().length;
      g.admit(24);
      await g.waitFor('escape after admission', () => g.episodeAfter(n).length > 0 && g.safety.hold() === null, 30_000);
      const ep = g.episodeAfter(n)[0]!;
      const after = await g.serverBot();
      ev.push(`after admission: ${ep.outcome}/${ep.reason}; server pos ${after.pos?.join(',')} air ${after.air}`);
      check(ep.outcome === 'resolved' && after.pos && !inPool(after.pos), 'escaped once authorized');
    });

    await g.gate('W2', 'unsupported water entry during ordinary goal work: preempted (safety_preempt) or the deep path refused', async (ev) => {
      await g.scene();
      await g.tp({ x: POOL.x1 - 2.5, y: -56, z: 205.5 });
      g.admit(30);
      const s = g.game.session();
      check(s, 'session');
      const n = g.safety.episodes().length;
      const cand: ActionCandidate = {
        id: randomIds.next('act') as string,
        capability: 'move_near',
        parameters: { target: { kind: 'destination', dimension: String(s.bot.game.dimension), x: POOL.x2 + 3, y: -56, z: 205 }, within: 1 },
        snapshotId: randomIds.next('snap') as string,
        connectionEpoch: s.connectionEpoch,
        goalEpoch: g.epoch,
        description: 'walk across the pool',
        criteria: [],
        preconditions: [],
        timeoutMs: 40_000,
      };
      const out = await g.goalExecutor.execute(cand, new AbortController().signal, { kind: 'goal', goalEpoch: g.epoch, goalId: g.goalId, taskId: 'task-safety0001' });
      ev.push(`goal move_near: ${out.status}/${out.reason ?? '-'}: ${out.effect.slice(0, 200)}`);
      await g.waitFor('safety settled', () => g.safety.hold() === null, 30_000).catch(() => undefined);
      const eps = g.episodeAfter(n);
      ev.push(`safety episodes: ${eps.map((e) => `${e.response}:${e.outcome}/${e.reason}`).join(', ') || 'none'}`);
      const after = await g.serverBot();
      ev.push(`server after: pos ${after.pos?.join(',')} air ${after.air}`);
      const preempted = out.reason === 'safety_preempt' && eps.some((e) => e.outcome === 'resolved');
      const refused = out.status !== 'succeeded' && /no_safe_path|stuck/.test(out.reason ?? '') && eps.length === 0;
      check(preempted || refused || (out.status === 'succeeded' && eps.length === 0 && after.pos && !inPool(after.pos)), 'either safety preempted and exited, or the deep path was refused/avoided');
      check(after.pos && !inPool(after.pos), 'not left in the pool');
    });

    await g.gate('W3', 'solid ceiling without an open column: declarative blocker, no blind jump (water breathing given)', async (ev) => {
      await g.scene({ lid: true });
      await g.rcon(`effect give ${BOT} minecraft:water_breathing 60 0 true`);
      await g.tp(POOL_FLOOR);
      g.admit(24);
      await g.waitFor('blocker', () => g.safety.status(Date.now()).state === 'blocked', 5_000);
      const st = g.safety.status(Date.now());
      ev.push(`status ${st.state}; blocker ${st.blocker?.reason}: ${st.blocker?.detail?.slice(0, 200)}`);
      check(st.blocker?.reason === 'no_reachable_surface', 'blocker names the missing surface');
      check(!g.leases.current, 'no lease held (no blind jump)');
      g.stop();
      await g.rcon(`tp ${BOT} ${ARENA.x} ${ARENA.y} ${ARENA.z} 0 0`); // recorded intervention after the observation
    });

    // ---------------------------------------------------------------- mobs
    await g.gate('M1', 'unarmed + zombie: retreat increases SERVER-measured separation; no attack', async (ev) => {
      await g.scene();
      await g.tp(ARENA);
      const z = await g.summon('zombie', { x: ARENA.x + 4, y: ARENA.y, z: ARENA.z }, ',IsBaby:0b');
      await sleep(500);
      const b0 = await g.serverBot();
      const z0 = await g.serverEntityPos(z);
      const n = g.safety.episodes().length;
      const writes = g.written.length;
      g.admit(12);
      await g.waitFor('retreat episode', () => g.episodeAfter(n).length > 0, 25_000);
      const b1 = await g.serverBot();
      const z1 = await g.serverEntityPos(z);
      const ep = g.episodeAfter(n)[0]!;
      ev.push(`episode ${ep.response}:${ep.outcome}/${ep.reason}: ${ep.detail}`);
      ev.push(`server separation ${b0.pos && z0 ? dist2(b0.pos, z0).toFixed(1) : '?'} -> ${b1.pos && z1 ? dist2(b1.pos, z1).toFixed(1) : 'zombie not found'}; health ${b0.health} -> ${b1.health}`);
      check(g.written.slice(writes).every((w) => w.name !== 'attack'), 'no attack packet');
      check(b0.pos && z0 && b1.pos && (!z1 || dist2(b1.pos, z1) > dist2(b0.pos, z0) + 2), 'server-measured separation increased');
    });

    await g.gate('M2', 'armed + single zombie: bounded defense; defeat only from the server death status', async (ev) => {
      await g.scene();
      await g.tp(ARENA);
      await g.arm();
      const z = await g.summon('zombie', { x: ARENA.x + 2.5, y: ARENA.y, z: ARENA.z }, ',IsBaby:0b');
      await sleep(500);
      const n = g.safety.episodes().length;
      const writes = g.written.length;
      g.admit(12);
      await g.waitFor('defense episode', () => g.episodeAfter(n).length > 0, 25_000);
      const ep = g.episodeAfter(n)[0]!;
      const st = g.safety.status(Date.now());
      const after = await g.serverBot();
      const gone = !(await g.entityExists(z));
      ev.push(`episode ${ep.response}:${ep.outcome}/${ep.reason}: ${ep.detail}`);
      ev.push(`attacks sent ${g.written.slice(writes).filter((w) => w.name === 'attack').length}; counters ${JSON.stringify(st.counters)}; zombie gone (RCON) ${gone}; bot health ${after.health}`);
      check(st.counters.defeatsConfirmed >= 1, 'server death status confirmed');
      check(gone, 'RCON confirms the zombie no longer exists');
      check(g.written.slice(writes).filter((w) => w.name === 'attack').length <= 10, 'bounded attacks');
    });

    await g.gate('M2b', 'readiness change mid-fight (server damage) downgrades defense to retreat', async (ev) => {
      await g.scene();
      await g.tp(ARENA);
      await g.arm();
      await g.summon('zombie', { x: ARENA.x + 2.5, y: ARENA.y, z: ARENA.z }, ',IsBaby:0b,Health:200f,attributes:[{id:"minecraft:max_health",base:200d}]');
      await sleep(500);
      const n = g.safety.episodes().length;
      const writes = g.written.length;
      g.admit(12);
      await g.waitFor('first attack', () => g.written.slice(writes).some((w) => w.name === 'attack'), 15_000);
      await g.rcon(`damage ${BOT} 11 minecraft:generic`);
      await g.waitFor('episode end', () => g.episodeAfter(n).length > 0, 25_000);
      const ep = g.episodeAfter(n)[0]!;
      const steps = (ep.evidence['steps'] as Array<{ response: string; reason: string | null }>) ?? [];
      ev.push(`steps: ${steps.map((s) => `${s.response}(${s.reason ?? '-'})`).join(' > ')}; outcome ${ep.outcome}/${ep.reason}`);
      check(steps[0]?.response === 'defend' && steps.some((s) => s.response === 'retreat'), 'defense downgraded to retreat after the readiness change');
    });

    await g.gate('M3', 'creeper with full gear: avoidance only, never an attack', async (ev) => {
      await g.scene();
      await g.tp(ARENA);
      await g.arm();
      const c = await g.summon('creeper', { x: ARENA.x + 5, y: ARENA.y, z: ARENA.z });
      await sleep(500);
      const n = g.safety.episodes().length;
      const writes = g.written.length;
      g.admit(12);
      await g.waitFor('episode', () => g.episodeAfter(n).length > 0, 25_000);
      const ep = g.episodeAfter(n)[0]!;
      ev.push(`episode ${ep.response}:${ep.outcome}/${ep.reason}: ${ep.detail}`);
      check(ep.response === 'retreat', 'retreat chosen');
      check(g.written.slice(writes).every((w) => w.name !== 'attack'), 'no attack packet against a creeper');
      g.stop();
      await g.rcon(`kill @e[tag=${c},${ENTITY_AREA}]`);
    });

    await g.gate('M3b', 'passive cow and unprovoked wolf beside the bot: no episode, no attack', async (ev) => {
      await g.scene();
      await g.tp(ARENA);
      await g.arm();
      await g.summon('cow', { x: ARENA.x + 2, y: ARENA.y, z: ARENA.z });
      await g.summon('wolf', { x: ARENA.x - 2, y: ARENA.y, z: ARENA.z });
      await sleep(500);
      const n = g.safety.episodes().length;
      const writes = g.written.length;
      g.admit(12);
      await sleep(4_000);
      ev.push(`episodes ${g.episodeAfter(n).length}; status ${g.safety.status(Date.now()).state}; threats ${JSON.stringify(g.safety.status(Date.now()).threats)}`);
      check(g.episodeAfter(n).length === 0 && g.safety.hold() === null, 'no safety episode');
      check(g.written.slice(writes).every((w) => w.name !== 'attack'), 'no attack packet');
    });

    await g.gate('M4', 'stop during a retreat: lease/controls cleared; no further motion', async (ev) => {
      await g.scene();
      await g.tp(ARENA);
      await g.summon('zombie', { x: ARENA.x + 3, y: ARENA.y, z: ARENA.z }, ',IsBaby:0b');
      await sleep(500);
      g.admit(12);
      await g.waitFor('retreat in progress', () => g.safety.hold()?.response === 'retreat' && g.leases.current !== undefined, 15_000);
      await sleep(400);
      const t = Date.now();
      g.stop();
      const cleared = g.leases.current === undefined;
      const clearMs = g.leases.lastClear?.clearMs ?? null;
      await sleep(300);
      const a = await g.serverBot();
      await sleep(1_200);
      const b = await g.serverBot();
      ev.push(`stop -> lease cleared ${cleared} (clearMs ${clearMs}, ${Date.now() - t}ms); server pos ${a.pos?.join(',')} -> ${b.pos?.join(',')}`);
      check(cleared, 'lease revoked synchronously');
      check(a.pos && b.pos && dist2(a.pos, b.pos) < 1.0, 'no further horizontal motion after stop');
    });
  } finally {
    g.stop();
    const step = async (what: string, fn: () => Promise<boolean | string>) => {
      try {
        const r = await fn();
        restoreChecks.push({ what, ok: r === true, detail: r === true ? 'verified' : String(r) });
      } catch (error) {
        restoreChecks.push({ what, ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    };
    await step('tagged mobs removed', async () => {
      await g.rcon(`kill @e[tag=${MOB_TAG},${ENTITY_AREA}]`);
      return !(await g.entityExists(MOB_TAG)) || 'tagged mobs remain';
    });
    if (difficulty.changed && difficulty.original) {
      await step(`difficulty restored to ${difficulty.original}`, async () => {
        await g.rcon(`difficulty ${difficulty.original}`);
        return DIFF_REPLY.exec(await g.rcon('difficulty', false))?.[1]?.toLowerCase() === difficulty.original || 'difficulty differs';
      });
    }
    await step('bot state cleared', async () => {
      await g.rcon(`clear ${BOT}`);
      await g.rcon(`effect clear ${BOT}`);
      await g.rcon(`tp ${BOT} ${ARENA.x} ${SCENE_Y.y2 + 1} ${ARENA.z} 0 0`);
      return true;
    });
    if (backupTaken) {
      await step('scene item/xp entities removed', async () => {
        await g.rcon(`kill @e[type=item,${ENTITY_AREA}]`);
        await g.rcon(`kill @e[type=experience_orb,${ENTITY_AREA}]`);
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
    await g.safety.close().catch(() => undefined);
    await g.game.disconnect('operator_stop').catch(() => undefined);
  }
  const restoreOk = restoreChecks.every((c) => c.ok);
  g.results.push({ id: 'RESTORE', title: 'verified restoration of settings, scene, entities and forceload', status: restoreOk ? 'pass' : 'fail', evidence: restoreChecks.map((c) => `${c.ok ? 'OK' : 'FAILED'} ${c.what}: ${c.detail}`) });
  const counted = g.results.filter((r) => r.status !== 'skipped');
  return {
    check: 'MB-FLOW-003-C11/C13 immediate-safety mechanics gate (pre-integration module harness with a labeled safety-executor stand-in; no model calls; NOT integrated-application or real-provider acceptance)',
    fixture: PINS.profile,
    source,
    footprint: { scene: SCENE_BOX, backup: BACKUP_BOX, mobTag: MOB_TAG, addedForceload, difficulty },
    restoration: restoreChecks,
    pass: counted.length > 0 && counted.every((r) => r.status === 'pass'),
    results: g.results,
    setup: g.setup,
    attacks: g.written.slice(-200),
    episodes: g.safety.episodes(),
    safetyOutcomes: g.outcomes.map((o) => ({ capability: o.capability, status: o.status, reason: o.reason ?? null, confirmation: o.confirmation, effect: o.effect.slice(0, 300), evidence: o.evidence })),
    safetyEvents: g.store.events.filter((e) => String(e.type).startsWith('safety_') || String(e.type).startsWith('lease_')).slice(-300),
    safetyStatus: g.safety.status(Date.now()),
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
  const outDir = join(PROJECT_ROOT, 'var', 'live-check', `${stamp}${SUFFIX}-safety`);
  mkdirSync(outDir, { recursive: true });
  process.stdout.write(`safety gate (${PINS.profile}, lease ${lease}) -> ${outDir}\n`);
  const report = await run();
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify({ ...report, lease }, null, 2)}\n`);
  process.stdout.write(`${report['pass'] ? 'PASS' : 'FAIL'} safety gate — ${outDir}\n`);
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
