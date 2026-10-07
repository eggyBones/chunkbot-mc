// In-process dashboard publisher (runs inside the Chunkbot application).
//
// At a fixed cadence (default 2 Hz) it assembles the bounded public status
// snapshot from typed, already-existing state - the game session and its
// server evidence journal, the goal engine's status, adapter readiness, the
// spend ledger, planner totals and validated usage events - and writes it
// atomically under `<dataDir>/dashboard/status.json`. Publishing never calls a
// model, selects a game action, acquires the actuator lease, or opens/resyncs
// an interface; it only reads. Transient world state is tied to its connection
// epoch: a new epoch keeps the previous readings only as historical (older
// epoch) until the new connection reports its own.
import {
  DASHBOARD_STATUS_SCHEMA,
  DASHBOARD_STATUS_VERSION,
  DashboardStatusSchema,
  known,
  unknown,
  type DashboardMemorySummary,
  type DashboardPause,
  type DashboardPendingDirective,
  type DashboardStatus,
  type Known,
} from '../contracts/dashboard.ts';
import type { EvidenceEvent, GameLifecycleEvent, Readiness, Unsubscribe } from '../contracts/index.ts';
import type { EngineStatus } from '../goals/goal-engine.ts';
import { clipText, projectDirective, projectMemory, projectReadiness, type AutonomyView, type SurvivalSummary } from './directive.ts';
import { writeAtomic } from './files.ts';
import { InventoryTracker, type EvidenceSource } from './inventory.ts';
import { ChangeClock, readVitals, type BotView, type VitalsEvidence } from './vitals.ts';
import { UsageAccumulator, type PlannerTotalsLike, type SpendSnapshotLike, type UsageSink } from './usage.ts';

/** The session slice the publisher reads (GameSession satisfies it structurally). */
export interface DashboardSession {
  readonly bot: unknown;
  readonly connectionEpoch: number;
  readonly evidence: EvidenceSource & VitalsEvidence;
}

/** The game port slice the publisher reads (MineflayerConnection satisfies it). */
export interface DashboardGame {
  readonly state: 'disconnected' | 'joining' | 'ready' | 'ended';
  readonly connectionEpoch: number;
  onLifecycle(listener: (event: GameLifecycleEvent) => void): Unsubscribe;
  session(): DashboardSession | undefined;
}

export interface DashboardPublisherOptions {
  statusPath: string;
  runId: string;
  pid: number;
  now: () => number;
  game: DashboardGame;
  profile: { version: string; supportLevel: string };
  /** Goal engine status (lazy: the engine is created after the publisher). */
  engine?: () => EngineStatus | undefined;
  decisionReadiness?: () => Readiness;
  spend?: () => SpendSnapshotLike;
  planner?: () => PlannerTotalsLike | undefined;
  /** MB-FLOW-002 seam. Undefined: not installed. */
  pending?: () => DashboardPendingDirective | undefined;
  /** MB-MEM-001 seam. Undefined: not installed. */
  memory?: () => DashboardMemorySummary | undefined;
  /** MB-FLOW-003 seam. Undefined: not installed. */
  survival?: () => SurvivalSummary | undefined;
  /** Pause latch seam (automatic work paused; manual goals may still run). Undefined: not reported. */
  pause?: () => DashboardPause | undefined;
  /** MB-FLOW-001 read-only supervisor status (undefined: not composed). */
  autonomy?: () => AutonomyView | undefined;
  usageSink?: UsageSink;
  intervalMs?: number;
  log?: (line: string) => void;
}

type Sections = { vitals: DashboardStatus['vitals']; inventory: DashboardStatus['inventory'] };

const NOT_CONNECTED = 'not connected';
type Vec = { x: number; y: number; z: number };
const round = (p: Vec): Vec => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 });

function emptySections(epoch: number, reason: string): Sections {
  return {
    vitals: { epoch, health: unknown(reason), maxHealth: unknown(reason), food: unknown(reason), saturation: unknown(reason), xp: unknown(reason) },
    inventory: { epoch, contents: unknown(reason), selectedHotbar: unknown(reason), openContainer: null },
  };
}

export class DashboardStatusPublisher {
  private readonly o: DashboardPublisherOptions;
  readonly usage: UsageAccumulator;
  private readonly startedAtMs: number;
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: Unsubscribe | undefined;
  private state: 'running' | 'stopping' | 'stopped' = 'running';
  private stoppedReason: string | undefined;
  private connectionChangedAtMs: number;
  private lastEnd: { reason: string; detail: string; atMs: number } | undefined;
  private tracker: InventoryTracker | undefined;
  private trackerEpoch = -1;
  private readonly changes = new ChangeClock();
  /** Last published world sections (may belong to an older epoch = historical). */
  private sections: Sections;
  private names = { botName: unknown(NOT_CONNECTED) as Known<string>, dimension: unknown(NOT_CONNECTED) as Known<string>, gameMode: unknown(NOT_CONNECTED) as Known<string>, alive: unknown(NOT_CONNECTED) as Known<boolean> };
  private position: Known<Vec> = unknown(NOT_CONNECTED);
  private serverPosition: Known<Vec> = unknown(NOT_CONNECTED);
  private moveTap: { bot: BotView; listener: () => void } | undefined;
  private writeProblem: string | undefined;

  constructor(options: DashboardPublisherOptions) {
    this.o = options;
    this.startedAtMs = options.now();
    this.connectionChangedAtMs = this.startedAtMs;
    this.sections = emptySections(options.game.connectionEpoch, NOT_CONNECTED);
    this.usage = new UsageAccumulator({
      now: options.now,
      ...(options.spend ? { spend: options.spend } : {}),
      ...(options.planner ? { planner: options.planner } : {}),
      ...(options.usageSink ? { sink: options.usageSink } : {}),
    });
  }

  get intervalMs(): number {
    return Math.min(60_000, Math.max(100, this.o.intervalMs ?? 500));
  }

  /** Observes one evidence event (wired through the store tee). */
  observe(event: EvidenceEvent): void {
    this.usage.observe(event);
  }

  start(): void {
    if (this.timer || this.state !== 'running') return;
    this.unsubscribe = this.o.game.onLifecycle((e) => this.onLifecycle(e));
    this.publish();
    this.timer = setInterval(() => this.publish(), this.intervalMs);
    this.timer.unref();
  }

  private onLifecycle(e: GameLifecycleEvent): void {
    const now = this.o.now();
    this.connectionChangedAtMs = now;
    switch (e.type) {
      case 'joining':
        this.detachTracker();
        this.changes.reset();
        break;
      case 'death':
        // Same epoch: the previous stock is no longer current. The server restates the inventory
        // around respawn (often BEFORE the respawn lifecycle event), so only death clears it.
        this.tracker?.invalidate('the bot died; waiting for the server to restate the inventory');
        break;
      case 'dimension_change':
        // Emitted on the respawn/login packet itself, before the new inventory sync arrives.
        this.tracker?.invalidate('dimension changed; waiting for the server inventory sync');
        break;
      case 'ended':
        this.lastEnd = { reason: e.reason, detail: clipText(e.detail), atMs: now };
        this.detachTracker();
        break;
    }
    this.publish();
  }

  private detachTracker(): void {
    this.tracker?.detach();
    this.tracker = undefined;
    this.trackerEpoch = -1;
    if (this.moveTap) this.moveTap.bot.removeListener?.('forcedMove', this.moveTap.listener);
    this.moveTap = undefined;
    this.serverPosition = unknown('no server position packet on this connection yet');
  }

  private readWorld(now: number): void {
    const s = this.o.game.state === 'ready' ? this.o.game.session() : undefined;
    if (!s) return;
    const bot = s.bot as BotView;
    if (this.trackerEpoch !== s.connectionEpoch) {
      this.detachTracker();
      const tracker = new InventoryTracker(() => {
        const w = bot.currentWindow;
        return w && typeof w.id === 'number' && typeof w.inventoryStart === 'number' ? { id: w.id, inventoryStart: w.inventoryStart } : undefined;
      });
      tracker.attach(s.evidence);
      this.tracker = tracker;
      this.trackerEpoch = s.connectionEpoch;
      // Mineflayer emits forcedMove right after applying a SERVER position packet (relative teleports resolved).
      const listener = () => {
        const p = bot.entity?.position;
        if (p && Number.isFinite(p.x + p.y + p.z)) this.serverPosition = known(round(p), 'server_packet', this.o.now());
      };
      bot.on?.('forcedMove', listener);
      this.moveTap = { bot, listener };
    }
    const pos = bot.entity?.position;
    this.position = pos && Number.isFinite(pos.x + pos.y + pos.z) ? known(round(pos), 'client_model', now) : unknown('position not known yet');
    const v = readVitals(bot, s.evidence, now, this.changes);
    const epoch = s.connectionEpoch;
    const anyNew = v.health.known || v.xp.known || this.tracker!.contents().known;
    const prev = this.sections;
    const prevHasData = prev.vitals.health.known || prev.vitals.xp.known || prev.inventory.contents.known;
    // Keep the previous epoch's readings (historical) until this epoch reports something of its own.
    if (prev.vitals.epoch !== epoch && !anyNew && prevHasData) return;
    this.sections = {
      vitals: { epoch, health: v.health, maxHealth: v.maxHealth, food: v.food, saturation: v.saturation, xp: v.xp },
      inventory: {
        epoch,
        contents: this.tracker!.contents(),
        selectedHotbar: v.selectedHotbar,
        openContainer: this.tracker!.container(),
      },
    };
    this.names = { botName: v.botName, dimension: v.dimension, gameMode: v.gameMode, alive: v.alive };
  }

  /** Assembles the snapshot (pure read). */
  snapshot(): DashboardStatus {
    const now = this.o.now();
    this.usage.syncLedger();
    try {
      this.readWorld(now);
    } catch (error) {
      this.writeProblem = `world read failed: ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`;
    }
    let engine: EngineStatus | undefined;
    try {
      engine = this.o.engine?.();
    } catch {
      engine = undefined;
    }
    let decision: Readiness | undefined;
    try {
      decision = this.o.decisionReadiness?.();
    } catch {
      decision = { ready: false, detail: 'decision readiness unavailable' };
    }
    const safe = <T>(f: (() => T | undefined) | undefined): T | undefined => {
      try {
        return f?.();
      } catch {
        return undefined;
      }
    };
    const memory = safe(this.o.memory);
    const ready = this.o.game.state === 'ready';
    const status: DashboardStatus = {
      schema: DASHBOARD_STATUS_SCHEMA,
      version: DASHBOARD_STATUS_VERSION,
      publisher: {
        runId: this.o.runId,
        pid: this.o.pid,
        startedAtMs: this.startedAtMs,
        seq: this.seq + 1,
        publishedAtMs: now,
        heartbeatIntervalMs: this.intervalMs,
        state: this.state,
        ...(this.stoppedReason ? { stoppedReason: this.stoppedReason } : {}),
      },
      connection: {
        state: this.o.game.state,
        epoch: this.o.game.connectionEpoch,
        botName: ready ? this.names.botName : unknown(NOT_CONNECTED),
        profile: { version: clipText(this.o.profile.version, 200), supportLevel: clipText(this.o.profile.supportLevel, 200) },
        dimension: ready ? this.names.dimension : unknown(NOT_CONNECTED),
        gameMode: ready ? this.names.gameMode : unknown(NOT_CONNECTED),
        changedAtMs: this.connectionChangedAtMs,
        ...(this.lastEnd ? { lastEnd: this.lastEnd } : {}),
        alive: ready ? this.names.alive : unknown(NOT_CONNECTED),
        position: ready ? this.position : unknown(NOT_CONNECTED),
        serverPosition: ready ? this.serverPosition : unknown(NOT_CONNECTED),
      },
      vitals: this.sections.vitals,
      inventory: this.sections.inventory,
      directive: projectDirective(engine, safe(this.o.pending), safe(this.o.survival), safe(this.o.pause), safe(this.o.autonomy)),
      readiness: projectReadiness(engine, decision),
      usage: { jev: this.usage.jevUsage(), planner: this.usage.plannerUsage() },
      memory: !this.o.memory ? unknown('memory feature not installed') : memory ? known(projectMemory(memory), 'app_state', now) : unknown('memory summary unavailable'),
      integrations: { handoff: Boolean(this.o.pending), memory: Boolean(this.o.memory), survival: Boolean(this.o.survival), pause: Boolean(this.o.pause), autonomy: Boolean(this.o.autonomy) },
    };
    return status;
  }

  /** Validates and atomically writes one snapshot. Never throws. */
  publish(): void {
    let status: DashboardStatus;
    try {
      status = this.snapshot();
    } catch (error) {
      this.problem(`snapshot failed: ${error instanceof Error ? error.message.slice(0, 160) : 'error'}`);
      return;
    }
    const parsed = DashboardStatusSchema.safeParse(status);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.problem(`snapshot rejected by the dashboard schema (${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}); not published`);
      return;
    }
    try {
      writeAtomic(this.o.statusPath, `${JSON.stringify(parsed.data)}\n`);
      this.seq = parsed.data.publisher.seq;
      this.writeProblem = undefined;
    } catch (error) {
      this.problem(`status write failed (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
  }

  private lastLogged: string | undefined;

  private problem(detail: string): void {
    this.writeProblem = detail;
    if (detail !== this.lastLogged) this.o.log?.(`[dashboard] ${detail}`);
    this.lastLogged = detail;
  }

  get lastProblem(): string | undefined {
    return this.writeProblem;
  }

  /** Graceful stop: one final snapshot marked stopped (readings stay, labeled historical by the viewer). */
  stop(reason: string): void {
    if (this.state === 'stopped') return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.state = 'stopped';
    this.stoppedReason = clipText(reason, 200);
    this.publish();
    this.detachTracker();
  }
}
