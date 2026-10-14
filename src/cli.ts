#!/usr/bin/env node
// Chunkbot command-line entry point.
//
//   chunkbot run           [--config <file>] [--no-terminal]   join and accept owner commands
//   chunkbot connect-check [--config <file>]                   join, report, disconnect, exit
//   chunkbot doctor        [--config <file>] [--json]          read-only diagnostics
//   chunkbot auth login    [--config <file>]                   explicit Microsoft sign-in for the BOT account
//   chunkbot catalog       [--config <file>] [--json]          capability catalog from registered skills (offline)
//   chunkbot knowledge     '<query json>' [--config <file>]    version knowledge query (offline, read-only)
//   chunkbot jev-check     [--config <file>] [--json]          ONE live Jev provider request (reads the key env var; spends ~USD 0.00002)
//   chunkbot planner-check [--config <file>] [--json] [--probe] ONE isolated Codex subscription planner turn (+ optional isolation/cancel probes)
//   chunkbot dashboard     [--config <file>] [--port <n>]      local read-only status viewer (never joins Minecraft or calls a model)
//   chunkbot memory        [--config <file>]                   read-only inspection of the configured memory scope
import { createInterface } from 'node:readline';
import { ConfigError, configPathFrom, loadConfigFile, type LoadedConfig } from './config/load.ts';
import { LOCAL_COMPAT_PROFILE, PINNED_PACKAGES, installedPackageVersion, resolveVersionProfile, supportLevel } from './config/versions.ts';
import { randomIds, systemClock } from './contracts/index.ts';
import { homeConstructionWanted } from './app/composition.ts';
import { managedAppPort } from './app/managed-child.ts';
import { inspectReleaseReadiness } from './app/release-readiness.ts';
import type { DeploymentFence, ManagedChildAppPort, ManagedScope } from './contracts/index.ts';
import { ChunkbotApp } from './app/app.ts';
import { DiagnosticConsole } from './app/diagnostics.ts';
import { SkillRuntime } from './app/skill-runtime.ts';
import { KnowledgeQuerySchema } from './contracts/index.ts';
import { SkillRegistry } from './execution/registry.ts';
import { VersionKnowledge } from './knowledge/knowledge.ts';
import { allSkills } from './skills/index.ts';
import { doctorExitCode, runDoctor } from './app/doctor.ts';
import { IdentityConflictError, interactiveBotLogin } from './game/auth.ts';
import { MineflayerConnection } from './game/connection.ts';
import { codecSummary } from './game/codec-audit.ts';
import { FileRunStore, teeRunStore } from './telemetry/run-store.ts';
import { redact } from './telemetry/redact.ts';
import { JevDecisionAdapter } from './decision/jev-adapter.ts';
import { SpendLedger } from './decision/spend.ts';
import { runJevCheck } from './decision/jev-check.ts';
import { CodexPlanner } from './planner/codex-planner.ts';
import { runPlannerCheck } from './planner/planner-check.ts';
import { NotReadyPlanner } from './goals/not-ready.ts';
import { PlannerJournal } from './telemetry/planner-journal.ts';
import type { PlannerPort, RunStore } from './contracts/index.ts';
import { continuationPort } from './survival/wiring.ts';
import { createDashboardRuntime, type DashboardRuntime } from './dashboard/runtime.ts';
import { VIEWER_USAGE, parseViewerArgs, runDashboardViewer } from './dashboard/viewer-command.ts';
import { memorySummaryFrom, pauseFrom, pendingDirectiveFrom, safetyStatusLine } from './app/status.ts';
import { inspectMemory, renderMemoryReport } from './memory/report.ts';
import { memoryRoot } from './memory/service.ts';
import { join } from 'node:path';
import { AutonomyConfigSchema } from './contracts/autonomy.ts';
import { AutonomyControl } from './autonomy/control.ts';
import { AutonomySupervisor } from './autonomy/supervisor.ts';
import { recoveryAdmissionBarrier } from './autonomy/barrier.ts';
import { resolveAutonomyScope, type ScopeResolution } from './autonomy/scope.ts';
import { autonomyStatusChat, autonomyStatusLines, navigationStatusLines } from './autonomy/status-text.ts';
import { JEV_CONTEXT_TOKENS, PROMPT_USD_PER_TOKEN } from './decision/pricing.ts';
import { createHash } from 'node:crypto';

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  connectFailed: 3,
  authRequired: 4,
  identityConflict: 5,
  decisionNotConfigured: 6,
  decisionFailed: 7,
  plannerNotReady: 8,
  plannerFailed: 9,
  forced: 130,
} as const;

const USAGE = `Usage: chunkbot <command> [--config <file>]

Commands:
  run            Join the configured server and accept owner commands (default)
  connect-check  Join, wait for a valid spawn, report version/dimension, disconnect
  doctor         Read-only diagnostics (config, versions, binaries, readiness); never joins or calls models
  auth login     Explicit Microsoft device-code sign-in for the BOT's own account
  catalog        Print the capability catalog generated from the registered skills (offline)
  knowledge      Answer one version-knowledge query, e.g. '{"kind":"recipe","output":"minecraft:furnace"}' (offline)
  jev-check      Send ONE minimal live Jev decision through the real adapter (needs the configured key env var)
  planner-check  Verify the Codex planner isolation gate and run ONE small isolated subscription turn
                 (--probe adds a tool-exposure self-report turn and an in-flight cancellation probe)
  dashboard      Local read-only status viewer for a second monitor (loopback only; see chunkbot dashboard --help)
  memory         Read-only inspection of the configured memory scope (state, revision, recent facts)

Options:
  --config <file>   Configuration file (default: $CHUNKBOT_CONFIG or ./chunkbot.config.json)
  --no-terminal     (run) do not read terminal commands from stdin; exit 3 when the connection ends
  --no-autonomy     (run) no automatic progression/survival scheduling (manual goals only; harnesses use this)
  --json            (doctor) machine-readable output
  --probe           (planner-check) also run the isolation and cancellation probes
`;

interface Args {
  command: string;
  sub: string | undefined;
  config: string | undefined;
  noTerminal: boolean;
  noAutonomy: boolean;
  json: boolean;
  help: boolean;
  probe: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = { command: 'run', sub: undefined, config: undefined, noTerminal: false, noAutonomy: false, json: false, help: false, probe: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    if (a === '--config') {
      const value = argv[i + 1];
      if (!value) return '--config requires a path';
      args.config = value;
      i += 1;
    } else if (a.startsWith('--config=')) args.config = a.slice('--config='.length);
    else if (a === '--no-terminal') args.noTerminal = true;
    else if (a === '--no-autonomy') args.noAutonomy = true;
    else if (a === '--json') args.json = true;
    else if (a === '--probe') args.probe = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('-')) return `unknown option ${a}`;
    else positional.push(a);
  }
  if (positional[0]) args.command = positional[0];
  args.sub = positional[1];
  return args;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

function loadOrExit(path: string): LoadedConfig {
  try {
    return loadConfigFile(path);
  } catch (error) {
    if (error instanceof ConfigError) {
      err(error.message);
      err('No connection was attempted.');
      process.exit(EXIT.failure);
    }
    throw error;
  }
}

function runFacts(loaded: LoadedConfig): Record<string, unknown> {
  const { config } = loaded;
  const profile = resolveVersionProfile(config.minecraft.version);
  return {
    node: process.version,
    packages: Object.fromEntries(
      [...new Set([...PINNED_PACKAGES, ...Object.keys(LOCAL_COMPAT_PROFILE.packages)])].map((p) => [p, installedPackageVersion(p) ?? 'missing']),
    ),
    minecraft: {
      host: config.minecraft.host,
      port: config.minecraft.port,
      version: config.minecraft.version,
      protocol: profile?.protocolVersion,
      // upstream-tested (released Mineflayer) or local-compat (MB-SERVER-001 vendored 26.2 stack)
      supportLevel: supportLevel(config.minecraft.version) ?? 'unsupported',
    },
    auth: config.bot.auth,
    trustedOfflineFixture: config.bot.trustedOfflineFixture,
    ownerAdmission: config.bot.auth === 'offline' ? 'exact_name_trusted_offline_fixture' : 'verified_sender_uuid',
    limits: config.limits,
  };
}

/**
 * MB-FLOW-001 autonomy enablement: only a normal `run` with the real planner and
 * no `--no-autonomy`; connect-check/diagnostics/inference-free profiles never schedule.
 */
function autonomyEnablement(loaded: LoadedConfig, requested: boolean): { enabled: boolean; reason: string } {
  const cfg = AutonomyConfigSchema.parse(loaded.config.autonomy ?? {});
  if (!requested) return { enabled: false, reason: 'automatic work is off for this command (run --no-autonomy, connect-check or a diagnostic)' };
  if (!cfg.enabled) return { enabled: false, reason: 'automatic work disabled by configuration (autonomy.enabled = false)' };
  if (loaded.config.models.planner.mode !== 'codex') return { enabled: false, reason: 'inference-free profile (models.planner.mode = "disabled"): no automatic work' };
  return { enabled: true, reason: 'enabled for this run' };
}

/** Explicit durable scope (C5): autonomy.scope and an enabled memory profile must agree; never derived from the endpoint. */
function autonomyScope(loaded: LoadedConfig): ScopeResolution {
  const cfg = AutonomyConfigSchema.parse(loaded.config.autonomy ?? {});
  return resolveAutonomyScope(cfg.scope, loaded.config.memory);
}

/** Current-process composition. Managed restart CLI still requires accepted accounting/launcher bindings. */
export function buildApp(loaded: LoadedConfig, exitOnConnectionEnd = false, options: { autonomy?: boolean; managed?: { fence: DeploymentFence; scope: ManagedScope } } = {}): { app: ChunkbotApp; store: RunStore; game: MineflayerConnection; disposed: Promise<void>; managed?: ManagedChildAppPort } {
  const { config } = loaded;
  const autonomyConfig = AutonomyConfigSchema.parse(config.autonomy ?? {});
  const autonomy = autonomyEnablement(loaded, options.autonomy === true);
  // Coordinator decision (MB-PLAN-006): home construction serves ordinary OWNER goals whenever an explicit
  // durable world scope is configured, independently of automatic progression (never an invented scope).
  const homeWanted = homeConstructionWanted(config);
  const scopeResolution = autonomy.enabled || homeWanted ? autonomyScope(loaded) : undefined;
  const scope = scopeResolution?.scope;
  const fileStore = new FileRunStore({
    runsDir: loaded.runsDir,
    runId: randomIds.next('run'),
    clock: systemClock,
    maxEvents: config.storage.maxEventsPerRun,
    maxEventChars: config.storage.maxEventChars,
    keepRuns: config.storage.keepRuns,
  });
  // MB-UI-001: ONE tee for every runtime store user (app, skills, tasks, Jev, planner, diagnostics):
  // each event is forwarded once, unchanged, to the run store, then observed by the dashboard
  // publisher (installed below, after the planner exists; events before that are run-store only).
  let dashboard: DashboardRuntime | undefined;
  const store: RunStore & { readonly dir: string; readonly eventsPath: string } = {
    ...teeRunStore(fileStore, () => dashboard?.observe),
    dir: fileStore.dir,
    eventsPath: fileStore.eventsPath,
  };
  let runtimeRef: SkillRuntime | undefined;
  const game = new MineflayerConnection({
    onBotCreated: (bot, epoch) => runtimeRef?.onBotCreated(bot as never, epoch),
    host: config.minecraft.host,
    port: config.minecraft.port,
    version: config.minecraft.version,
    auth: config.bot.auth,
    username: config.bot.username,
    authDir: loaded.authDir,
    joinTimeoutMs: config.minecraft.joinTimeoutMs,
    replyMode: config.chat.replyMode,
    log: (line) => out(`[game] ${line}`),
    ...(config.owner.uuid ? { ownerUuid: config.owner.uuid } : {}),
    ...(config.bot.auth === 'offline' && config.owner.name ? { ownerName: config.owner.name } : {}),
  });
  // MB-V1-02 skill layer: perception, knowledge, catalog, candidates, predicates, lease, executor.
  // The goal engine is created inside ChunkbotApp; epochs are read lazily through `appRef`.
  let appRef: ChunkbotApp | undefined;
  let diagnostics: DiagnosticConsole | undefined;
  // MB-V1-03: ONE spend ledger for the whole application run (not per goal).
  const spend = new SpendLedger(config.limits.openRouterSpendCapUsd);
  const decision = new JevDecisionAdapter({
    endpoint: config.models.decision.endpoint,
    model: config.models.decision.model,
    apiKeyEnv: config.models.decision.apiKeyEnv,
    env: () => process.env,
    expectedProvider: config.models.decision.expectedProvider,
    spend,
    store,
    clock: systemClock,
    timeoutMs: config.limits.decisionTimeoutMs,
    minIntervalMs: config.limits.decisionMinIntervalMs,
    attemptsPerGoal: config.limits.decisionRequestsPerGoal,
  });
  const control = new AutonomyControl({ scope, ...(scopeResolution?.conflict ? { scopeConflict: scopeResolution.conflict } : {}), rootDir: join(loaded.dataDir, autonomyConfig.dir), endpoint: `${config.minecraft.host}:${config.minecraft.port}`, rebindEndpoint: autonomyConfig.rebindEndpoint, clock: systemClock, record: (e) => store.record(e) });
  // A scope conflict blocks every persistence-dependent automatic feature (survival episodes, home project).
  const survivalWanted = autonomy.enabled && config.survival?.enabled !== false && !scopeResolution?.conflict;
  const runtime = new SkillRuntime({
    features: {
      safety: true,
      ...(config.locator?.enabled === false ? {} : { locator: true }),
      ...(survivalWanted ? { survival: { config: config.survival, scope } } : {}),
      ...(homeWanted && scope && !scopeResolution?.conflict ? { home: { control, interior: autonomyConfig.home.interior as 2 | 3, maxSiteDistance: autonomyConfig.home.maxSiteDistance } } : {}),
    },
    config,
    session: () => game.session(),
    connectionEpoch: () => game.connectionEpoch,
    goalEpoch: () => appRef?.engine.currentEpoch ?? 0,
    diagnosticCurrent: (id) => diagnostics?.isCurrent(id) ?? false,
    admission: () => game.admissionContext(),
    store,
    clock: systemClock,
    ids: randomIds,
    decision,
    spendRemainingUsd: () => Math.round(spend.remainingUsd() * 1e6) / 1e6,
    emitTask: (kind, data) => out(`[task-json] ${JSON.stringify(redact({ kind, ...data }, { maxStringChars: 600, maxArrayItems: 32, maxDepth: 6 }))}`),
    dataDir: loaded.dataDir,
    sessionId: store.runId,
    safetyAuthority: () => appRef?.safetyAuthority() ?? { basis: 'none', detail: 'application not composed', connection: null, alive: false, goal: null, travel: null },
  });
  runtimeRef = runtime;
  const memory = runtime.memory;
  if (memory) for (const line of memory.statusLines()) out(`[chunkbot] ${line}`);
  else out(`[chunkbot] memory: ${config.memory ? 'disabled by configuration (memory.enabled = false)' : 'not configured (no memory section); no memory capability is registered'}`);
  diagnostics = new DiagnosticConsole({
    runtime: () => runtime,
    out,
    store,
    clock: systemClock,
    ids: randomIds,
    goalEpoch: () => appRef?.engine.currentEpoch ?? 0,
    goalActive: () => appRef?.engine.hasActiveGoal ?? false,
  });
  // MB-V1-04: the real Codex SUBSCRIPTION planner on normal goal intake, unless the
  // configuration selects the explicit inference-free profile (foundation/mechanic checks).
  const journal = new PlannerJournal(store.dir, systemClock);
  let planner: PlannerPort;
  let codex: CodexPlanner | undefined;
  if (config.models.planner.mode === 'codex') {
    codex = new CodexPlanner({
      command: config.models.planner.command,
      model: config.models.planner.model,
      effort: config.models.planner.reasoningEffort,
      env: process.env,
      denyEnv: [config.models.decision.apiKeyEnv],
      store,
      journal,
      timeoutMs: config.limits.plannerTimeoutMs,
      windowSteps: config.limits.planWindowSteps,
    });
    const gate = codex.prepare();
    planner = codex;
    out(`[chunkbot] planner: ${gate.ok ? codex.readiness().detail : `NOT READY — ${gate.detail}`}`);
  } else {
    planner = new NotReadyPlanner('Codex subscription planner disabled by configuration (models.planner.mode = "disabled": inference-free test profile); goals end planner_not_ready');
    out('[chunkbot] planner: disabled by configuration (inference-free profile)');
  }
  let supervisor: AutonomySupervisor | undefined;
  // MB-UI-001 local dashboard publisher (read-only; no inference, actuator or network).
  dashboard = createDashboardRuntime({
    dataDir: loaded.dataDir,
    runId: store.runId,
    now: () => systemClock.now(),
    game,
    profile: { version: config.minecraft.version, supportLevel: supportLevel(config.minecraft.version) ?? 'unsupported' },
    engine: () => appRef?.engine.status(),
    decisionReadiness: () => decision.readiness(),
    spend,
    planner: () => codex,
    pending: () => pendingDirectiveFrom(appRef?.engine.status()),
    pause: () => pauseFrom(appRef?.engine.status()),
    ...(runtime.safety ? { safety: () => runtime.safety!.status(systemClock.now()) } : {}),
    // MB-FLOW-001/003/LOC-001 read-only status (no controls).
    autonomy: () => {
      if (!supervisor) return undefined;
      const epoch = appRef?.engine.currentEpoch;
      const view = epoch !== undefined ? runtime.routeView(epoch) : undefined;
      return { status: supervisor.status(), admission: view?.admission ?? null, locator: runtime.locator?.ownerHint() ?? null };
    },
    ...(runtime.survival
      ? {
          survival: () => {
            const st = runtime.survival?.status(systemClock.now());
            const active = st?.activeRoutine;
            if (!active) return undefined;
            const incident = st.incidents[0];
            return { routine: active.routine, reason: st.lastDecision?.reason ?? 'support routine running', ...(incident ? { phase: incident.phase, attempt: incident.attempts.used } : {}), sinceMs: active.since };
          },
        }
      : {}),
    ...(memory ? { memory: () => memorySummaryFrom(memory.facts(), memory.scope, systemClock.now(), config.memory?.staleAfterMs ?? 24 * 3_600_000) } : {}),
    log: (line) => out(line),
  });
  const reservationUsd = JEV_CONTEXT_TOKENS * PROMPT_USD_PER_TOKEN;
  const app = new ChunkbotApp({
    config,
    game,
    store,
    clock: systemClock,
    ids: randomIds,
    out,
    runFacts: { ...runFacts(loaded), catalogVersion: runtime.registry.catalog().catalogVersion, plannerMode: config.models.planner.mode },
    exitOnConnectionEnd,
    journal,
    statusExtras: () => {
      const lines = [`network: ${codecSummary(game.codecHealth())} (version support: ${supportLevel(config.minecraft.version) ?? 'unsupported'})`];
      if (dashboard) lines.push(dashboard.statusLine());
      if (memory) lines.push(...memory.statusLines());
      if (runtime.safety) {
        const s = runtime.safety.status(systemClock.now());
        lines.push(safetyStatusLine(s));
      }
      const navigation = runtime.routeView(appRef?.engine.currentEpoch ?? 0);
      lines.push(...navigationStatusLines(navigation?.status ?? null, { locator: runtime.locator?.ownerHint() ?? null, admission: navigation?.admission ?? null }));
      if (codex) {
        const t = codex.totals;
        const cov = (known: number) => (known === t.completedTurns ? '' : ` [reported for ${known}/${t.completedTurns} completed turns]`);
        lines.push(`planner usage this run: ${t.turns} turn(s) (${t.completedTurns} completed, ${t.failedTurns} failed), input ${t.inputTokens}${cov(t.usageKnownTurns)} (cached ${t.cachedInputTokens}${cov(t.cachedInputKnownTurns)}), output ${t.outputTokens}, reasoning ${t.reasoningOutputTokens}${cov(t.reasoningKnownTurns)} tokens (observed subscription usage; no API charges)`);
      }
      return lines;
    },
    adapters: { ...runtime.adapters(), planner },
    extensions: {
      onLifecycle: (event) => {
        if (event.type === 'death' || event.type === 'dimension_change' || event.type === 'ended') diagnostics?.cancel(`lifecycle_${event.type}`);
        runtime.onLifecycle(event);
        supervisor?.onLifecycle(event);
      },
      cancelControl: (reason) => diagnostics?.cancel(reason) ?? false,
      closeControl: () => runtime.closeSafety(),
      releaseDrainProof: () => runtime.releaseDrainProof(),
      onSafetyAuthorityChanged: (cause) => runtime.safety?.onAuthorityChanged(cause),
      travelBounds: () => runtime.perception.travelBounds(),
      onGoalAdmitted: (admission) => {
        runtime.onGoalAdmitted(admission);
        supervisor?.onGoalAdmitted(admission);
      },
      onGoalTerminal: (end) => {
        runtime.onGoalTerminal(end);
        supervisor?.onGoalTerminal(end);
      },
      onLatchChanged: (latch, cause) => supervisor?.onLatchChanged(latch, cause),
      onPreparationDiscarded: (p) => supervisor?.onPreparationDiscarded(p),
      ...(runtime.routes ? { routeView: (goalEpoch: number) => runtime.routeView(goalEpoch) } : {}),
      ...(runtime.locator ? { locatorHint: () => runtime.locator?.ownerHint() } : {}),
      installed: { structures: Boolean(runtime.home), survival: Boolean(runtime.survival) },
      ...(runtime.survival
        ? {
            admissionBarrier: recoveryAdmissionBarrier({
              survival: runtime.survival,
              connection: () => {
                const s = game.session();
                return s ? { connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension) } : null;
              },
              record: (e) => store.record(e),
            }),
          }
        : {}),
      autonomyStatus: () => {
        if (!supervisor) return undefined;
        const s = supervisor.status();
        const epoch = appRef?.engine.currentEpoch;
        const view = epoch !== undefined ? runtime.routeView(epoch) : undefined;
        return { lines: autonomyStatusLines(s, { admission: view?.admission ?? null }).filter((line) => !line.startsWith('route: ') && !line.startsWith('locator: ')), chat: autonomyStatusChat(s), automatic: s.mode !== 'disabled' && s.mode !== 'scope_blocked' };
      },
      diagnostic: (args) => diagnostics!.handle(args),
      // MB-FLOW-003-C12 same-session continuation of held owner jobs. In memory and independent of
      // memory/autonomy/survival configuration; the survival port is attached when S's service provides it.
      continuation: {
        sessionId: store.runId,
        ...(continuationPort(runtime.survival) ? { survival: continuationPort(runtime.survival)! } : {}),
        captureAnchor: (goalEpoch) => runtime.continuationAnchor(goalEpoch),
        captureRoute: (goalEpoch) => runtime.continuationRoute(goalEpoch),
        isAlive: () => (game.statusInfo().health ?? 0) > 0,
        currentDimension: () => {
          const d = game.statusInfo().dimension;
          return d === undefined ? undefined : String(d);
        },
        matches: (selector, key) => (selector.startsWith('#') ? Boolean(runtime.knowledge.recipes?.matches(selector, key)) : selector === key),
      },
      decisionBudget: decision,
    },
  });
  appRef = app;
  runtime.startSafety();
  supervisor = new AutonomySupervisor({
    engine: app.engine,
    control,
    config: autonomyConfig,
    enabled: autonomy,
    clock: systemClock,
    record: (e) => store.record(e),
    notify: (text) => {
      out(`[chunkbot] ${text}`);
      game.replyToOwner(text);
    },
    connection: () => {
      const info = game.statusInfo();
      return game.state === 'ready' ? { ready: true, connectionEpoch: game.connectionEpoch, dimension: String(info.dimension ?? 'unknown') } : null;
    },
    observe: () => runtime.perception.snapshot(0),
    providers: () => {
      const planner = app.engine.status().readiness.planner;
      const jev = decision.readiness();
      // Jev decisions (code tasks included) all reserve in the SAME per-run SpendLedger.
      const spendOk = spend.remainingUsd() >= reservationUsd;
      const decisionReady = jev.ready && spendOk;
      if (!jev.ready) return { ready: false, decisionReady: false, code: 'decision_not_ready', detail: `Jev: ${jev.detail}` };
      if (!spendOk) return { ready: false, decisionReady: false, code: 'spend_cap', detail: `the per-run OpenRouter cap cannot cover another Jev reservation (USD ${spend.remainingUsd().toFixed(6)} left)` };
      if (!planner.ready) return { ready: false, decisionReady, code: 'planner_not_ready', detail: `planner: ${planner.detail} (code-built support tasks may still use Jev)` };
      return { ready: true, decisionReady, detail: 'planner and Jev ready' };
    },
    stateFingerprint: () => {
      const s = game.session();
      if (!s) return 'disconnected';
      const inv = [...(s.bot.inventory?.items?.() ?? [])].map((i) => `${i.name}:${i.count}`).sort().join(',');
      const p = s.bot.entity.position;
      const h = runtime.home?.project();
      return createHash('sha256').update(`${String(s.bot.game.dimension)}|${Math.floor(p.x / 8)},${Math.floor(p.z / 8)}|${inv}|${h ? `${h.state}:${h.checkpoints.length}` : 'nohome'}`).digest('hex').slice(0, 16);
    },
    goalLimits: { plannerTurns: config.limits.plannerTurnsPerGoal, tasks: config.limits.totalTaskCeiling, replans: config.limits.replans, deadlineMs: config.limits.goalDeadlineMs },
    home: () => runtime.home?.summary() ?? null,
    ...(runtime.survival ? { survival: runtime.survival } : {}),
    ...(runtime.routes ? { route: runtime.routes } : {}),
  });
  supervisor.start();
  out(`[chunkbot] autonomy: ${autonomy.enabled ? `enabled; scope ${scope ? `${scope.worldProfile}@r${scope.worldRevision}/${scope.botProfile}` : scopeResolution?.conflict ? `CONFLICT — ${scopeResolution.conflict}` : 'MISSING (automatic work blocked; manual goals work)'}; ${control.persistence().state}${control.latch().paused ? '; PAUSED (stop latch restored; say resume)' : ''}` : autonomy.reason}`);
  if (runtime.survival) out(`[chunkbot] survival: ${runtime.survival.status(systemClock.now()).store.state}`);
  if (runtime.routes) out(`[chunkbot] locator: ${runtime.locator?.enabled ? 'enabled' : 'codec unavailable/disabled'}; routes ${runtime.routes.policy.enabled ? `enabled for ${runtime.routes.policy.sources.join('/')}` : 'disabled'}`);
  const publisher = dashboard;
  publisher.start();
  // Final snapshot (marked stopped) only after the app's full teardown.
  const disposed = app.closed.then(async (code) => {
    // Supervisor timers and durable control state close after the app's owned gameplay cleanup.
    await supervisor?.close().catch((error: unknown) => out(`[chunkbot] autonomy close failed: ${error instanceof Error ? error.message : String(error)}`));
    if (runtime.survival) await runtime.survival.close().catch((error: unknown) => out(`[chunkbot] survival close failed: ${error instanceof Error ? error.message : String(error)}`));
    // Durable memory is flushed and its writer lock released after the final teardown.
    if (memory) await memory.close().catch((error: unknown) => out(`[chunkbot] memory close failed: ${error instanceof Error ? error.message : String(error)}`));
    publisher.stop(`shutdown (exit ${code})`);
  });
  out(`[chunkbot] decision: ${decision.readiness().detail}`);
  out(`[chunkbot] run ${store.runId}; evidence: ${store.eventsPath}`);
  out(`[chunkbot] skills: ${runtime.registry.catalog().capabilities.length} capabilities (${runtime.registry.catalog().catalogVersion}); natural-language goals use the ${config.models.planner.mode === 'codex' ? 'Codex subscription planner' : 'DISABLED planner profile'}; operator mechanic diagnostics: /diag; task controller diagnostic (real Jev): /task`);
  const managed = options.managed ? managedAppPort(app, { ...options.managed, probeReadiness: () => inspectReleaseReadiness({ app, game, runtime, config, decision, scope: options.managed!.scope }) }) : undefined;
  return { app, store, game, disposed, ...(managed ? { managed } : {}) };
}

/** Installs SIGINT/SIGTERM handlers: first signal shuts down cleanly, second forces exit. */
function installSignalHandlers(app: ChunkbotApp): void {
  let signals = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    signals += 1;
    if (signals > 1) {
      err(`[chunkbot] second ${signal}; forcing exit`);
      process.exit(EXIT.forced);
    }
    out(`[chunkbot] received ${signal}`);
    void app.shutdown('signal');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

/** Sets the exit code and lets the event loop drain; force-exits if a handle lingers. */
function finish(code: number): void {
  process.exitCode = code;
  process.stdin.pause();
  setTimeout(() => {
    err('[chunkbot] exit watchdog: a handle did not close within 5s; exiting');
    process.exit(code);
  }, 5_000).unref();
}

async function commandRun(loaded: LoadedConfig, noTerminal: boolean, noAutonomy: boolean): Promise<void> {
  const { app } = buildApp(loaded, noTerminal, { autonomy: !noAutonomy });
  installSignalHandlers(app);
  let rl: ReturnType<typeof createInterface> | undefined;
  if (!noTerminal) {
    rl = createInterface({ input: process.stdin, terminal: false });
    out('[chunkbot] terminal ready: type instructions, stop, resume, status, or /help');
    rl.on('line', (line) => {
      void app.handleTerminalLine(line);
    });
    // End of terminal input (Ctrl-D / closed pipe) is an operator shutdown.
    rl.on('close', () => {
      void app.shutdown('terminal_closed');
    });
  }
  void app.closed.then((code) => {
    rl?.removeAllListeners('close');
    rl?.close();
    finish(code);
  });
  await app.connect();
}

async function commandConnectCheck(loaded: LoadedConfig): Promise<void> {
  const { app, game } = buildApp(loaded);
  installSignalHandlers(app);
  const info = await app.connect();
  if (info) {
    out(
      `[connect-check] OK version=${info.serverVersion} protocol=${info.protocolVersion} dimension=${info.dimension} ` +
        `position=${info.position.x},${info.position.y},${info.position.z} gameMode=${info.gameMode} serverOnlineMode=${info.serverOnlineMode} ` +
        `support=${supportLevel(loaded.config.minecraft.version) ?? 'unsupported'} ${codecSummary(game.codecHealth())}`,
    );
    finish(await app.shutdown('connect_check'));
    return;
  }
  const end = app.lastConnectionEnd;
  out(`[connect-check] FAILED ${end?.reason ?? 'unknown'}: ${end?.detail ?? ''}`);
  await app.shutdown('connect_check');
  finish(end?.reason === 'auth_required' ? EXIT.authRequired : end?.reason === 'identity_conflict' ? EXIT.identityConflict : EXIT.connectFailed);
}

function commandDoctor(configPath: string, json: boolean): void {
  const checks = runDoctor(configPath);
  if (json) out(JSON.stringify({ checks }, null, 2));
  else for (const c of checks) out(`${c.level.toUpperCase().padEnd(4)} ${c.area.padEnd(9)} ${c.message}`);
  const code = doctorExitCode(checks);
  if (!json) out(code === 0 ? 'doctor: no failures (warnings describe readiness gaps)' : 'doctor: failures found');
  process.exitCode = code;
}

async function commandAuthLogin(loaded: LoadedConfig): Promise<void> {
  const { config } = loaded;
  if (config.bot.auth !== 'microsoft') {
    err('auth login applies to bot.auth "microsoft" configurations only; this configuration is an offline loopback fixture.');
    process.exitCode = EXIT.usage;
    return;
  }
  out(`Signing in the BOT account for label "${config.bot.username}". Use the bot's own Microsoft account, not the owner's.`);
  out(`Tokens are cached under ${loaded.authDir} (git-ignored).`);
  try {
    const profile = await interactiveBotLogin(config.bot.username, loaded.authDir, config.owner.uuid, (prompt) => {
      // Shown on the operator terminal only; never written to evidence.
      out(`Open ${prompt.verificationUri} and enter code ${prompt.userCode}`);
    });
    out(`Signed in. Bot Minecraft profile: ${profile.name} (${profile.uuid}). It differs from the configured owner UUID.`);
    process.exitCode = EXIT.ok;
  } catch (error) {
    if (error instanceof IdentityConflictError) {
      err(`Refused: ${error.message}. Remove ${loaded.authDir} and sign in with a separate bot account.`);
      process.exitCode = EXIT.identityConflict;
      return;
    }
    err(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT.failure;
  }
}

function commandCatalog(configPath: string, json: boolean): void {
  let version = '26.1.2';
  try {
    version = loadConfigFile(configPath).config.minecraft.version;
  } catch {
    // the catalog itself is version-independent; fall back to the fixture version for knowledge flags
  }
  const registry = new SkillRegistry(allSkills());
  const catalog = registry.catalog();
  if (json) {
    err('foundation catalog only; use /diag catalog in a run for its configured locator, safety, survival, memory and construction capabilities');
    out(JSON.stringify(catalog, null, 2));
  } else {
    out(`foundation catalog ${catalog.catalogVersion} (${catalog.capabilities.length} capabilities, generated from foundation skill definitions; version ${version}; /diag catalog shows configured run capabilities)`);
    for (const c of catalog.capabilities) {
      out(`- ${c.id} [${c.family}] ${c.purpose}`);
      out(`    params: ${c.parameters.map((p) => `${p.name}${p.required ? '' : '?'}:${p.type}`).join(', ') || '(none)'}; predicates: ${c.supportedPredicates.join(', ') || '(none)'}`);
    }
  }
  process.exitCode = EXIT.ok;
}

function commandKnowledge(configPath: string, queryText: string | undefined): void {
  let version = '26.1.2';
  try {
    version = loadConfigFile(configPath).config.minecraft.version;
  } catch {
    // knowledge needs only a version; default to the fixture version
  }
  let raw: unknown;
  try {
    raw = JSON.parse(queryText ?? '');
  } catch {
    err('knowledge: pass one JSON query, e.g. \'{"kind":"recipe","output":"minecraft:furnace"}\'');
    process.exitCode = EXIT.usage;
    return;
  }
  const query = KnowledgeQuerySchema.safeParse(raw);
  if (!query.success) {
    err(`knowledge: invalid query: ${query.error.issues[0]?.message ?? 'invalid'}`);
    process.exitCode = EXIT.usage;
    return;
  }
  const registry = new SkillRegistry(allSkills());
  const knowledge = new VersionKnowledge({ version, catalog: () => registry.catalog(), execution: { crafting: 'craft_item', cooking: ['furnace_insert', 'furnace_wait', 'furnace_take'] } });
  out(JSON.stringify(knowledge.answerOne(query.data), null, 2));
  process.exitCode = EXIT.ok;
}

/** `chunkbot memory`: read-only inspection of the configured memory scope (MB-MEM-001; no write, no lock, no world access). */
function commandMemory(loaded: LoadedConfig): void {
  const cfg = loaded.config.memory;
  const report = inspectMemory(memoryRoot(loaded.dataDir, cfg?.enabled ? cfg : undefined), cfg?.enabled ? cfg : undefined, systemClock, { limit: 40 });
  for (const line of renderMemoryReport(report)) out(line);
  process.exitCode = EXIT.ok;
}

/** `chunkbot dashboard`: the separately launched local read-only viewer (MB-UI-001). */
async function commandDashboard(argv: string[]): Promise<number> {
  const parsed = parseViewerArgs(argv);
  if (typeof parsed === 'string') {
    err(parsed);
    err(VIEWER_USAGE);
    return EXIT.usage;
  }
  if (parsed.help) {
    out(VIEWER_USAGE);
    return EXIT.ok;
  }
  let loaded: LoadedConfig;
  try {
    loaded = loadConfigFile(configPathFrom(parsed.config, process.env));
  } catch (error) {
    if (error instanceof ConfigError) {
      err(error.message);
      return EXIT.failure;
    }
    throw error;
  }
  return runDashboardViewer(loaded, parsed.options, { out, err, env: process.env });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'dashboard') {
    process.exitCode = await commandDashboard(argv.slice(1));
    return;
  }
  const parsed = parseArgs(argv);
  if (typeof parsed === 'string') {
    err(parsed);
    err(USAGE);
    process.exitCode = EXIT.usage;
    return;
  }
  if (parsed.help) {
    out(USAGE);
    return;
  }
  const configPath = configPathFrom(parsed.config, process.env);
  switch (parsed.command) {
    case 'doctor':
      commandDoctor(configPath, parsed.json);
      return;
    case 'run':
      await commandRun(loadOrExit(configPath), parsed.noTerminal, parsed.noAutonomy);
      return;
    case 'connect-check':
      await commandConnectCheck(loadOrExit(configPath));
      return;
    case 'catalog':
      commandCatalog(configPath, parsed.json);
      return;
    case 'knowledge':
      commandKnowledge(configPath, parsed.sub);
      return;
    case 'jev-check':
      process.exitCode = await runJevCheck(loadOrExit(configPath), { json: parsed.json, out, err, exit: EXIT });
      return;
    case 'planner-check':
      process.exitCode = await runPlannerCheck(loadOrExit(configPath), { json: parsed.json, probe: parsed.probe, out, err, exit: EXIT });
      return;
    case 'memory':
      commandMemory(loadOrExit(configPath));
      return;
    case 'auth':
      if (parsed.sub !== 'login') {
        err('usage: chunkbot auth login [--config <file>]');
        process.exitCode = EXIT.usage;
        return;
      }
      await commandAuthLogin(loadOrExit(configPath));
      return;
    default:
      err(`unknown command ${parsed.command}`);
      err(USAGE);
      process.exitCode = EXIT.usage;
  }
}

if (import.meta.main) main().catch((error: unknown) => {
  err(`[chunkbot] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT.failure;
});
