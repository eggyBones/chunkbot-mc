// Thin scenario adapter over the EXISTING exported ordinary harness and CLI.
// It supplies no planner turns, Jev choices, fake outcomes or resource loops.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Harness } from '../../ordinary-goal-live-check.ts';
import type { FixturePins } from '../../../src/app/fixture-layout.ts';
import { artifactAt } from './artifact.ts';
import { verifyGrant } from './guards.ts';
import { atMs } from './oracles.ts';
import type { Cleanup, Event, Evidence, Grant, Intervention, ModelCaptureReader, Scenario, Session } from './types.ts';

function ensure(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function eventsAt(path: string): Event[] {
  const text = readFileSync(path, 'utf8');
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  return complete.split('\n').filter(Boolean).map((line) => {
    const event = JSON.parse(line) as Event;
    ensure(typeof event.type === 'string', 'unreadable evidence event'); return event;
  });
}
const SKILLS = { movement: ['move_near', 'follow_entity'], mining: ['mine_block'], crafting: ['craft_item'], furnace: ['furnace_wait'] } as const;

class OrdinarySession implements Session {
  private readonly changes: Intervention[] = [];
  private changesFrom = 0;
  private baseline: Record<string, number> = {};
  private startLine = 0;
  private stageAtMs = 0;
  private readonly rawPath: string;
  private connected = false;
  private closed = false;
  private readonly root: string;
  private readonly out: string;
  private readonly grant: Grant;
  private readonly h: Harness;
  private readonly pins: FixturePins;
  private readonly capture: ModelCaptureReader | undefined;
  private attempt: { scenario: string; goalId: string; admittedAtMs: number } | null = null;
  private readonly attempts: Array<{ scenario: string; goalId: string; admittedAtMs: number }> = [];
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(root: string, out: string, grant: Grant, h: Harness, pins: FixturePins, capture?: ModelCaptureReader) {
    this.root = root; this.out = out; this.grant = grant; this.h = h; this.pins = pins; this.capture = capture; this.rawPath = join(out, 'ordinary-driver.json');
  }
  private authority(freeze = false): void {
    ensure(Date.now() < this.grant.expiresAtMs, 'fixture lease expired; no new scenario work permitted');
    if (freeze) verifyGrant(this.grant, this.pins.profile, this.grant.leaseId, artifactAt(this.root), Date.now(), Boolean(process.env['OPENROUTER_API_KEY']));
  }
  private retain(): void {
    writeFileSync(this.rawPath, JSON.stringify({ attempt: this.attempt, attempts: this.attempts, setup: this.h.setupLog, readbacks: this.h.readbacks, interventions: this.changes, runs: this.h.runs, cleanup: this.h.cleanup }, null, 2), { mode: 0o600 });
  }
  async connect(): Promise<void> {
    this.authority(true);
    // Expiry revokes the harness's owned work even while a helper is awaiting
    // a long provider/goal timeout. Never signal a server, DSH or other child.
    this.leaseTimer = setTimeout(() => { this.h.cli?.send('/quit'); }, Math.max(1, this.grant.expiresAtMs - Date.now()));
    this.leaseTimer.unref();
    const list = await this.h.read('list');
    ensure(/^There are 0 of /i.test(list), 'exclusive fixture must have zero players; never adopt an existing player');
    const { loadConfigFile } = await import('../../../src/config/load.ts');
    const base = loadConfigFile(join(this.root, this.pins.config)).config;
    const { DEFAULT_JEV_ENDPOINT } = await import('../../../src/decision/wire.ts');
    ensure(base.minecraft.host === this.pins.host && base.minecraft.port === this.pins.port && base.minecraft.version === this.pins.minecraftVersion && base.bot.auth === 'offline' && base.bot.trustedOfflineFixture && base.bot.username === 'Chunkbot' && base.owner.name === 'FixtureOwner' && base.models.planner.mode === 'codex' && base.models.planner.model === 'gpt-6.1-sol' && base.models.planner.reasoningEffort === 'low' && base.models.decision.endpoint === DEFAULT_JEV_ENDPOINT && base.models.decision.apiKeyEnv === 'OPENROUTER_API_KEY', 'exact trusted fixture and unchanged real gameplay route required');
    const config = { ...base, storage: { ...base.storage, dataDir: this.h.dataDir, keepRuns: 100, maxEventsPerRun: 100_000, maxEventChars: 40_000 } };
    this.h.configPath = join(this.out, 'v1.config.json');
    writeFileSync(this.h.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    // CliProcess is the shared normal `node dist/cli.js run` launcher.
    this.authority();
    await this.h.start('v1-ordinary', { ...process.env });
    this.connected = true;
    await this.h.quiesce();
    this.authority();
    const mineflayer = (await import('mineflayer')).default;
    const owner = mineflayer.createBot({ host: this.pins.host, port: this.pins.port, version: this.pins.minecraftVersion, username: 'FixtureOwner', auth: 'offline', hideErrors: true });
    this.h.owner = owner;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { finish(); reject(new Error('owned fixture observer spawn timed out')); }, 20_000);
      const finish = () => { clearTimeout(timer); owner.off('spawn', spawned); owner.off('error', failed); };
      const spawned = () => { finish(); resolve(); };
      const failed = (error: Error) => { finish(); reject(error); };
      owner.once('spawn', spawned); owner.once('error', failed);
    });
    this.authority(); await this.h.recordForceload();
    this.retain();
  }
  private async emptyActors(): Promise<void> {
    // Strict negative ALL non-player census: even a foreign drop/orb refuses
    // staging/cleanup. We never use the old area-wide entity kill helper.
    for (let cx = 12; cx <= 14; cx++) for (let cz = 11; cz <= 14; cz++) {
      this.authority();
      const reply = await this.h.read(`execute if loaded ${Math.max(196, cx * 16)} -60 ${Math.max(190, cz * 16)}`);
      ensure(/^Test passed\.?$/i.test(reply.trim()), 'unloaded/unknown scene chunk cannot prove foreign actor absence');
    }
    this.authority(); const reply = await this.h.read('execute if entity @e[type=!player,x=196,y=-64,z=190,dx=28,dy=40,dz=34]');
    ensure(/^Test failed\.?$/i.test(reply.trim()), 'foreign/unknown scene occupancy: no entity removed, moved or adopted');
  }
  private async setup(command: string): Promise<void> {
    this.authority();
    this.changes.push({ atMs: Date.now(), kind: 'setup', detail: command }); this.retain();
    await this.h.setup(command); this.retain();
  }
  async stage(s: Scenario): Promise<void> {
    this.authority(true);
    ensure(this.connected, 'owned CLI session is not connected');
    await this.h.quiesce();
    this.h.scenario = s.id; this.changesFrom = this.changes.length; this.attempt = null;
    await this.setup('forceload add 196 190 224 224');
    await this.emptyActors();
    for (const name of ['Chunkbot', 'FixtureOwner']) {
      await this.setup(`effect give ${name} slow_falling 5 0 true`);
      await this.setup(`tp ${name} 205.5 -30 205.5`);
    }
    // Reuse the reviewed scene's block reset; explicitly exclude its entity
    // deletion commands, because no unknown actor/drop is ours to remove.
    for (const command of this.h.blockResetCommands().filter((c) => !c.startsWith('kill '))) { await this.emptyActors(); await this.setup(command); }
    // Same exported ordinary geometry, dispatched through shared setup one
    // command at a time so authority and attempted writes stay journaled.
    const { LAYOUT } = await import('../../ordinary-goal-live-check.ts');
    for (const p of LAYOUT.gather.trunks) {
      await this.emptyActors();
      await this.setup(`fill ${p.x - 1} -55 ${p.z - 1} ${p.x + 1} -55 ${p.z + 1} oak_leaves[persistent=true]`);
      await this.setup(`fill ${p.x} -60 ${p.z} ${p.x} -56 ${p.z} oak_log`);
    }
    const stone = LAYOUT.gather.stone;
    await this.setup(`fill ${stone.x1} ${stone.y} ${stone.z1} ${stone.x2} ${stone.y} ${stone.z2} stone`);
    for (const command of ['clear Chunkbot', ...(s.trigger === 'death' ? [] : ['give Chunkbot minecraft:bread 8']), 'clear FixtureOwner', 'gamemode survival Chunkbot', 'tp Chunkbot 205.5 -60 205.5 0 0', 'tp FixtureOwner 219.5 -60 219.5 0 0', 'effect clear Chunkbot', 'effect clear FixtureOwner']) await this.setup(command);
    for (const [key, count] of Object.entries(s.supplies)) await this.setup(`give Chunkbot ${key} ${count}`);
    if (s.family === 'privacy') {
      await this.setup('fill 203 -60 212 208 -57 212 stone_bricks');
      await this.setup('setblock 205 -60 214 diamond_ore');
      ensure(await this.h.blockIs({ x: 205, y: -60, z: 214 }, 'minecraft:diamond_ore'), 'hidden target server readback failed');
    }
    await sleep(800);
    this.authority(); this.baseline = await this.h.inventory();
    this.stageAtMs = Date.now(); this.startLine = this.h.cli!.length; this.retain();
  }
  private events(): Event[] { return eventsAt(this.h.eventsPath); }
  private async active(goalId: string, s: Scenario): Promise<Event> {
    const deadline = Math.min(this.grant.expiresAtMs, Date.now() + 12 * 60_000);
    while (Date.now() < deadline) {
      this.authority();
      const events = this.events();
      const starts = s.trigger === 'planner' ? events.filter((v) => v.type === 'planner_turn_started' && v.goalId === goalId && !events.some((end) => end.requestId === v.requestId && ['planner_turn_completed', 'planner_turn_failed', 'planner_response_started'].includes(end.type)))
        : s.trigger === 'decision' ? events.filter((v) => v.type === 'jev_request' && v.goalId === goalId && !events.some((end) => end.requestId === v.requestId && ['jev_response', 'jev_failure', 'task_reply_discarded'].includes(end.type)))
        : events.filter((v) => v.type === 'skill_started' && v.owner === 'goal' && (s.trigger === 'remove_target' ? v.capability === 'mine_block' : s.family === 'lifecycle' ? SKILLS.movement.includes(v.capability as 'move_near') : (SKILLS[s.trigger as keyof typeof SKILLS] as readonly string[] | undefined)?.includes(String(v.capability))) && !events.some((end) => end.type === 'skill_outcome' && end.actionId === v.actionId));
      const found = starts.at(-1);
      // skill_started lacks goalId: bind actionId via the same goal's frozen
      // task_round candidate set, rather than borrowing another owner's skill.
      if (found && (found.goalId === goalId || events.some((v) => v.type === 'task_round' && v.goalId === goalId && Array.isArray(v.offered) && v.offered.some((option: unknown) => option && typeof option === 'object' && (option as Record<string, unknown>).id === found.actionId)))) return found;
      if (events.some((v) => v.type === 'goal_terminal' && v.goalId === goalId)) throw new Error('not_exercised: goal ended before required active trigger');
      await sleep(20);
    }
    throw new Error(`not_exercised: no current ${s.trigger} trigger before bounded deadline`);
  }
  async execute(s: Scenario, onAdmitted?: () => void): Promise<Evidence> {
    this.authority(true);
    const { goalId } = await this.h.goal(s.instruction);
    this.attempt = { scenario: s.id, goalId, admittedAtMs: Date.now() }; this.attempts.push(this.attempt); this.retain(); onAdmitted?.();
    const admission = this.events().find((v) => v.type === 'goal_admitted' && v.goalId === goalId)!;
    ensure(admission && typeof admission.epoch === 'number', 'ordinary admission identity missing');
    let stop: Evidence['stop'];
    if (s.trigger) {
      const active = await this.active(goalId, s);
      this.authority();
      const sentAtMs = Date.now();
      // The second read refuses a trigger that settled during oracle sampling.
      if (active.actionId) ensure(!this.events().some((v) => v.type === 'skill_outcome' && v.actionId === active.actionId), 'not_exercised: skill already settled');
      if (s.trigger === 'remove_target') {
        this.changes.push({ atMs: sentAtMs, kind: 'fault', detail: 'remove only the declared stone-source row; alternate visible stone remains' }); this.retain();
        await this.h.setup('fill 210 -60 193 213 -60 193 air');
      } else {
        stop = { activeAtMs: atMs(active), sentAtMs, family: s.trigger, ...(typeof active.requestId === 'string' ? { requestId: active.requestId } : {}), ...(typeof active.actionId === 'string' ? { actionId: active.actionId } : {}) };
        this.changes.push({ atMs: sentAtMs, kind: 'fault', detail: `ordinary ${s.trigger} interruption` }); this.retain();
        if (s.trigger === 'disconnect') {
          const reply = await this.h.query('kick Chunkbot v1_owned_fixture_disconnect');
          ensure(/^Kicked Chunkbot/.test(reply.trim()), 'owned kick reply unreadable');
        }
        else if (s.trigger === 'death') { const reply = await this.h.query('kill Chunkbot'); ensure(/^Killed Chunkbot/.test(reply.trim()), 'owned death reply unreadable'); }
        else if (s.trigger === 'restart') this.h.cli!.send('/quit');
        else this.h.say('stop');
      }
    }
    if (s.persistent) {
      await this.h.waitForTruth('owner proximity while persistent goal remains live', async () => {
        this.authority(); const p = await this.h.position(), o = await this.h.position('FixtureOwner'); return Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z) <= 3;
      }, 12 * 60_000);
      await sleep(3_000);
    } else {
      await this.h.waitEvent((v) => v.type === 'goal_terminal' && v.goalId === goalId, Math.min(12 * 60_000, Math.max(1, this.grant.expiresAtMs - Date.now())), 'ordinary goal terminal');
      await sleep(800);
    }
    const previousEvents = this.events();
    const previousJournal = eventsAt(join(dirname(this.h.eventsPath), 'planner.jsonl'));
    let freshIdle: Evidence['freshIdle'];
    if (s.family === 'lifecycle') {
      this.authority();
      ensure(previousEvents.some((v) => v.type === 'goal_cleanup' && v.goalId === goalId && v.failed === 0), 'old cleanup not settled; no restart/reconnect');
      if (s.trigger === 'restart') { await this.h.quit(); ensure(this.h.runs.at(-1)?.exit?.code === 0, 'old CLI did not gracefully exit'); await this.h.start(`v1-restarted-${this.h.runs.length}`, { ...process.env }); }
      else if (s.trigger === 'disconnect') { const from = this.h.cli!.length; this.h.cli!.send('/reconnect'); await this.h.cli!.waitSince(/\[chunkbot\] ready: version=/, from, 60_000); }
      else await this.h.cli!.waitSince(/\[chunkbot\] respawned in .*idle/, this.startLine, 60_000);
      const sinceMs = Date.now(); await sleep(3_000);
      freshIdle = { sinceMs, untilMs: Date.now(), events: this.events().filter((v) => atMs(v) >= sinceMs) };
    }
    this.authority(); const inventory = await this.h.inventory();
    const captured = this.capture ? await this.capture.read(goalId) : { captures: [], complete: false };
    this.authority(); const helmet = await this.h.read('execute if entity @a[name=Chunkbot,nbt={Inventory:[{Slot:103b,id:"minecraft:iron_helmet"}]}]');
    const evidence: Evidence = {
      goalId, epoch: admission.epoch, events: previousEvents.filter((v) => atMs(v) >= this.stageAtMs), journal: previousJournal,
      lines: this.h.cli!.since(this.startLine), baseline: this.baseline, inventory, equipped: /^Test passed[.,] Count: 1\.?$/i.test(helmet.trim()) ? { head: 'minecraft:iron_helmet' } : {},
      position: await this.h.position(), ownerPosition: await this.h.position('FixtureOwner'), interventions: this.changes.slice(this.changesFrom), captures: captured.captures, captureComplete: captured.complete,
      hiddenFacts: s.family === 'privacy' ? ['205,-60,214'] : [], ...(s.family === 'privacy' ? { hiddenLocations: [{ x: 205, y: -60, z: 214 }] } : {}), ...(stop ? { stop } : {}), ...(freshIdle ? { freshIdle } : {}),
    };
    writeFileSync(join(this.out, `${s.id}.evidence.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 }); this.retain();
    return evidence;
  }
  async close(): Promise<Cleanup> {
    if (this.closed) throw new Error('session cleanup already attempted');
    this.closed = true;
    clearTimeout(this.leaseTimer);
    const steps: Cleanup['steps'] = [];
    const step = async (name: string, fn: () => Promise<void>) => {
      try { await fn(); steps.push({ step: name, ok: true, detail: 'verified' }); }
      catch (error) { steps.push({ step: name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
      this.h.note(name, steps.at(-1)!.ok, steps.at(-1)!.detail); this.retain();
    };
    await step('quiesce', async () => { await this.h.quiesce(); });
    // Each cleanup is independent: foreign occupancy refuses block restoration
    // but cannot prevent owned-child/observer teardown. No settings changed.
    if (this.h.forceloadBefore && Date.now() < this.grant.expiresAtMs) {
      await step('blocks', async () => {
        await this.emptyActors();
        for (const name of ['Chunkbot', 'FixtureOwner']) { await this.setup(`effect give ${name} slow_falling 5 0 true`); await this.setup(`tp ${name} 205.5 -30 205.5`); }
        for (const command of this.h.blockResetCommands().filter((c) => !c.startsWith('kill '))) { await this.emptyActors(); await this.setup(command); }
        ensure(await this.h.blockIs({ x: 205, y: -60, z: 214 }, 'minecraft:air'), 'hidden target restoration unknown');
        ensure(await this.h.blockIs({ x: 197, y: -60, z: 192 }, 'minecraft:air'), 'source restoration unknown');
        for (const name of ['Chunkbot', 'FixtureOwner']) await this.setup(`tp ${name} 205.5 -60 205.5`);
      });
      for (const name of ['Chunkbot', 'FixtureOwner']) await step(`${name}-inventory/effects`, async () => {
        await this.setup(`clear ${name}`); await this.setup(`effect clear ${name}`);
        ensure(/\[\]$/.test((await this.h.read(`data get entity ${name} Inventory`)).trim()), 'inventory not server-proved empty');
        ensure(/\[\]$|Found no elements matching/i.test(await this.h.read(`data get entity ${name} active_effects`)), 'effects not server-proved empty');
      });
      await step('forceload', async () => {
        // Shared restoration can dispatch 12 removals + one read, each with a
        // 5 s RCON bound. Reserve that whole bound before entering it.
        ensure(Date.now() + 70_000 < this.grant.expiresAtMs, 'insufficient remaining fixture authority for bounded shared forceload restoration');
        await this.h.restoreForceload(); ensure(this.h.cleanup.at(-1)?.ok === true, 'shared helper reported an unreconciled forceload set');
      });
    }
    else if (this.h.forceloadBefore) { steps.push({ step: 'world-restoration', ok: false, detail: 'fixture lease expired; world/player/RCON cleanup deferred for a renewed coordinator lease, owned processes still torn down' }); this.retain(); }
    await step('cli-exit', async () => { await this.h.quit(); ensure(this.h.runs.every((r) => r.exit?.code === 0 && r.exit?.signal === null), 'CLI failed graceful exit'); });
    await step('evidence-complete', async () => {
      for (const run of this.h.runs) { const summary = JSON.parse(readFileSync(join(dirname(run.events), 'summary.json'), 'utf8')) as Record<string, unknown>; ensure(summary.eventsDropped === 0, 'dropped event evidence cannot verify acceptance'); }
    });
    await step('observer-exit', async () => {
      const owner = this.h.owner; if (!owner) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('owned observer exit timed out')), 10_000);
        owner.once('end', () => { clearTimeout(timer); resolve(); }); owner.quit();
      });
    });
    await step('zero-players', async () => { this.authority(); ensure(/^There are 0 of /i.test(await this.h.read('list')), 'players remain after cleanup'); });
    return { reconciled: steps.length > 0 && steps.every((s) => s.ok), steps };
  }
}

export async function openOrdinarySession(root: string, out: string, grant: Grant, capture?: ModelCaptureReader): Promise<Session> {
  // The existing Harness's constructor reads the password. Recheck first;
  // imports alone are safe, and no worker execution reaches this path.
  verifyGrant(grant, grant.fixture, grant.leaseId, artifactAt(root), Date.now(), Boolean(process.env['OPENROUTER_API_KEY']));
  const { fixturePins, fixtureProfileFromArgv, PROJECT_ROOT } = await import('../../../src/app/fixture-layout.ts');
  ensure(root === PROJECT_ROOT, 'shared ordinary CLI is bound to another checkout');
  ensure(fixtureProfileFromArgv(process.argv) === grant.fixture, 'shared ordinary Harness is argv-scoped; fixture must match the actual entry-point argv');
  const { Harness } = await import('../../ordinary-goal-live-check.ts');
  ensure(Date.now() < grant.expiresAtMs, 'fixture lease expired before credential read');
  const h = new Harness(out);
  const session = new OrdinarySession(root, out, grant, h, fixturePins(grant.fixture), capture);
  try { await session.connect(); return session; }
  catch (error) { await session.close(); throw error; }
}
