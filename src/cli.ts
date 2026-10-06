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
import { createInterface } from 'node:readline';
import { ConfigError, configPathFrom, loadConfigFile, type LoadedConfig } from './config/load.ts';
import { LOCAL_COMPAT_PROFILE, PINNED_PACKAGES, installedPackageVersion, resolveVersionProfile, supportLevel } from './config/versions.ts';
import { randomIds, systemClock } from './contracts/index.ts';
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
import { FileRunStore } from './telemetry/run-store.ts';
import { redact } from './telemetry/redact.ts';
import { JevDecisionAdapter } from './decision/jev-adapter.ts';
import { SpendLedger } from './decision/spend.ts';
import { runJevCheck } from './decision/jev-check.ts';
import { CodexPlanner } from './planner/codex-planner.ts';
import { runPlannerCheck } from './planner/planner-check.ts';
import { NotReadyPlanner } from './goals/not-ready.ts';
import { PlannerJournal } from './telemetry/planner-journal.ts';
import type { PlannerPort } from './contracts/index.ts';

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

Options:
  --config <file>   Configuration file (default: $CHUNKBOT_CONFIG or ./chunkbot.config.json)
  --no-terminal     (run) do not read terminal commands from stdin; exit 3 when the connection ends
  --json            (doctor) machine-readable output
  --probe           (planner-check) also run the isolation and cancellation probes
`;

interface Args {
  command: string;
  sub: string | undefined;
  config: string | undefined;
  noTerminal: boolean;
  json: boolean;
  help: boolean;
  probe: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = { command: 'run', sub: undefined, config: undefined, noTerminal: false, json: false, help: false, probe: false };
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

function buildApp(loaded: LoadedConfig, exitOnConnectionEnd = false): { app: ChunkbotApp; store: FileRunStore; game: MineflayerConnection } {
  const { config } = loaded;
  const store = new FileRunStore({
    runsDir: loaded.runsDir,
    runId: randomIds.next('run'),
    clock: systemClock,
    maxEvents: config.storage.maxEventsPerRun,
    maxEventChars: config.storage.maxEventChars,
    keepRuns: config.storage.keepRuns,
  });
  const game = new MineflayerConnection({
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
  const runtime = new SkillRuntime({
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
  });
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
      if (codex) {
        const t = codex.totals;
        lines.push(`planner usage this run: ${t.turns} turn(s) (${t.completedTurns} completed, ${t.failedTurns} failed), input ${t.inputTokens} (cached ${t.cachedInputTokens}), output ${t.outputTokens}, reasoning ${t.reasoningOutputTokens} tokens (subscription usage; no API charges)`);
      }
      return lines;
    },
    adapters: { ...runtime.adapters(), planner },
    extensions: {
      onLifecycle: (event) => {
        if (event.type === 'death' || event.type === 'dimension_change' || event.type === 'ended') diagnostics?.cancel(`lifecycle_${event.type}`);
        runtime.onLifecycle(event);
      },
      cancelControl: (reason) => diagnostics?.cancel(reason) ?? false,
      onGoalAdmitted: (admission) => runtime.onGoalAdmitted(admission),
      diagnostic: (args) => diagnostics!.handle(args),
    },
  });
  appRef = app;
  out(`[chunkbot] decision: ${decision.readiness().detail}`);
  out(`[chunkbot] run ${store.runId}; evidence: ${store.eventsPath}`);
  out(`[chunkbot] skills: ${runtime.registry.catalog().capabilities.length} capabilities (${runtime.registry.catalog().catalogVersion}); natural-language goals use the ${config.models.planner.mode === 'codex' ? 'Codex subscription planner' : 'DISABLED planner profile'}; operator mechanic diagnostics: /diag; task controller diagnostic (real Jev): /task`);
  return { app, store, game };
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

async function commandRun(loaded: LoadedConfig, noTerminal: boolean): Promise<void> {
  const { app } = buildApp(loaded, noTerminal);
  installSignalHandlers(app);
  let rl: ReturnType<typeof createInterface> | undefined;
  if (!noTerminal) {
    rl = createInterface({ input: process.stdin, terminal: false });
    out('[chunkbot] terminal ready: type instructions, stop, status, answer [qN] <reply>, or /help');
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
    out(JSON.stringify(catalog, null, 2));
  } else {
    out(`catalog ${catalog.catalogVersion} (${catalog.capabilities.length} capabilities, generated from registered skill definitions; version ${version})`);
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

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
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
      await commandRun(loadOrExit(configPath), parsed.noTerminal);
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

main().catch((error: unknown) => {
  err(`[chunkbot] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT.failure;
});
