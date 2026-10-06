// Integration facade for the Chunkbot application (installed by the designated
// app/CLI writer in `buildApp`). One instance per application run.
//
//   const dashboard = createDashboardRuntime({ dataDir: loaded.dataDir, runId: store.runId, game, spend,
//     planner: codex, engine: () => appRef?.engine.status(), decisionReadiness: () => decision.readiness(),
//     profile: { version, supportLevel }, now: () => systemClock.now() });
//   const tapped = dashboard.tapStore(store);   // pass `tapped` to JevDecisionAdapter and CodexPlanner
//   ...after the app exists: dashboard.start();
//   ...when the app has closed: dashboard.stop(`shutdown (${reason})`);
//
// Read-only towards the game and every adapter. It never calls a model, the
// actuator, an interface resync, or the network. Failures are reported once
// on the operator log and never break the application.
import type { DashboardMemorySummary, DashboardPendingDirective } from '../contracts/dashboard.ts';
import type { EvidenceEvent, Readiness, RunStore } from '../contracts/index.ts';
import type { EngineStatus } from '../goals/goal-engine.ts';
import type { SurvivalSummary } from './directive.ts';
import { dashboardPaths, type DashboardPaths } from './files.ts';
import { UsageHistoryStore } from './history.ts';
import { DashboardStatusPublisher, type DashboardGame } from './publisher.ts';
import type { PlannerTotalsLike, SpendSnapshotLike } from './usage.ts';

export interface DashboardRuntimeDeps {
  /** `LoadedConfig.dataDir` (ignored runtime storage). Files go to `<dataDir>/dashboard/`. */
  dataDir: string;
  runId: string;
  now: () => number;
  game: DashboardGame;
  /** Configured version and support level (never the server address). */
  profile: { version: string; supportLevel: string };
  engine?: () => EngineStatus | undefined;
  decisionReadiness?: () => Readiness;
  /** The run's single SpendLedger. */
  spend?: { snapshot(): SpendSnapshotLike };
  /** The CodexPlanner (its `totals`), when composed. */
  planner?: { readonly totals: PlannerTotalsLike };
  /** Optional companion seams; leave undefined until the feature is installed. */
  pending?: () => DashboardPendingDirective | undefined;
  memory?: () => DashboardMemorySummary | undefined;
  survival?: () => SurvivalSummary | undefined;
  pid?: number;
  intervalMs?: number;
  timeZone?: string;
  log?: (line: string) => void;
}

export interface DashboardRuntime {
  readonly paths: DashboardPaths;
  /** Tee: forwards every event to `store` unchanged and observes typed usage events. */
  tapStore(store: RunStore): RunStore;
  observe(event: EvidenceEvent): void;
  start(): void;
  /** Final snapshot marked stopped + final history flush. Idempotent. */
  stop(reason: string): void;
  /** One operator status line (no inference). */
  statusLine(): string;
}

export function createDashboardRuntime(deps: DashboardRuntimeDeps): DashboardRuntime {
  const paths = dashboardPaths(deps.dataDir);
  const pid = deps.pid ?? process.pid;
  const now = deps.now;
  let history: UsageHistoryStore | undefined;
  let historyProblem: string | undefined;
  try {
    history = new UsageHistoryStore({ path: paths.history, runId: deps.runId, pid, startedAtMs: now(), now, ...(deps.timeZone ? { timeZone: deps.timeZone } : {}), ...(deps.log ? { log: deps.log } : {}) });
  } catch (error) {
    historyProblem = `usage history unavailable: ${error instanceof Error ? error.message.slice(0, 160) : 'error'}`;
    deps.log?.(`[dashboard] ${historyProblem}`);
  }
  const spend = deps.spend;
  const planner = deps.planner;
  const publisher = new DashboardStatusPublisher({
    statusPath: paths.status,
    runId: deps.runId,
    pid,
    now,
    game: deps.game,
    profile: deps.profile,
    ...(deps.engine ? { engine: deps.engine } : {}),
    ...(deps.decisionReadiness ? { decisionReadiness: deps.decisionReadiness } : {}),
    ...(spend ? { spend: () => spend.snapshot() } : {}),
    ...(planner ? { planner: () => ({ ...planner.totals }) } : {}),
    ...(deps.pending ? { pending: deps.pending } : {}),
    ...(deps.memory ? { memory: deps.memory } : {}),
    ...(deps.survival ? { survival: deps.survival } : {}),
    ...(history ? { usageSink: history } : {}),
    ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  let flushTimer: NodeJS.Timeout | undefined;
  let stopped = false;

  const observe = (event: EvidenceEvent) => {
    try {
      publisher.observe(event);
    } catch {
      // observation must never break evidence recording
    }
  };

  return {
    paths,
    tapStore(store: RunStore): RunStore {
      return {
        runId: store.runId,
        record(event: EvidenceEvent): void {
          store.record(event);
          observe(event);
        },
        close: (summary: Record<string, unknown>) => store.close(summary),
      };
    },
    observe,
    start(): void {
      if (stopped) return;
      publisher.start();
      if (history && !flushTimer) {
        flushTimer = setInterval(() => history?.flush(false), 2_000);
        flushTimer.unref();
      }
    },
    stop(reason: string): void {
      if (stopped) return;
      stopped = true;
      if (flushTimer) clearInterval(flushTimer);
      flushTimer = undefined;
      publisher.stop(reason);
      history?.close();
    },
    statusLine(): string {
      const problem = publisher.lastProblem ?? history?.problem ?? historyProblem;
      return `dashboard: publishing ${paths.status} every ${publisher.intervalMs} ms${problem ? ` — problem: ${problem}` : ''}; viewer: node dist/dashboard/main.js --config <file>`;
    },
  };
}
