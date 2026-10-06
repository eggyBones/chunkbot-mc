// Read-only diagnostics: configuration, versions, binaries, storage, and
// adapter readiness. Doctor never joins a server, never signs in, never calls
// a model, and never writes files. It is useful without model credentials.
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { ConfigError, loadConfigFile, type LoadedConfig } from '../config/load.ts';
import { DEFAULT_DECISION_ENDPOINT, isLoopbackHost } from '../config/schema.ts';
import {
  LOCAL_COMPAT_PROFILE,
  PINNED_PACKAGES,
  installedPackageVersion,
  localCompatProblem,
  resolveVersionProfile,
  supportDescription,
  supportLevel,
  upstreamTestedVersions,
} from '../config/versions.ts';
import { hasMicrosoftTokenCache } from '../game/auth.ts';
import { maxAttemptChargeUsd, verifiedProfile } from '../decision/pricing.ts';
import { verifyIsolation, plannerEnv } from '../planner/codex-cli.ts';
import { SkillRegistry } from '../execution/registry.ts';
import { VersionKnowledge } from '../knowledge/knowledge.ts';
import { allSkills } from '../skills/index.ts';
import { NAVIGATION_POLICY } from '../skills/navigation.ts';
import { inspectMemory, renderMemoryReport } from '../memory/report.ts';
import { memoryRoot } from '../memory/service.ts';
import { systemClock } from '../contracts/index.ts';
import { FIXTURE_PINS, PROJECT_ROOT, fixtureProfileFor, fixturePaths } from './fixture-layout.ts';

export type CheckLevel = 'pass' | 'warn' | 'fail' | 'info';
export interface DoctorCheck {
  level: CheckLevel;
  area: string;
  message: string;
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return undefined;
}

function pidAlive(pidFile: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    process.kill(pid, 0); // signal 0: existence check only
    return pid;
  } catch {
    return undefined;
  }
}

function isIgnoredByGit(root: string, path: string): boolean {
  try {
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel)) return true; // outside the project
    const patterns = readFileSync(join(root, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const top = `${rel.split('/')[0]}/`;
    return patterns.includes(top) || patterns.includes(rel) || patterns.includes(`${rel}/`);
  } catch {
    return false;
  }
}

export function runDoctor(configPath: string, env: NodeJS.ProcessEnv = process.env): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (level: CheckLevel, area: string, message: string) => checks.push({ level, area, message });

  // Runtime and pins
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  add(major === 24 ? 'pass' : 'fail', 'node', `Node ${process.version} at ${process.execPath}${major === 24 ? '' : ' (Node 24 LTS required)'}`);
  let expected: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expected = pkg.dependencies ?? {};
  } catch {
    add('fail', 'packages', 'cannot read package.json');
  }
  // Vendored (file:vendor/*.tgz) dependencies pin the build version recorded in vendor/compat-lock.json.
  let vendored: Record<string, string> = {};
  try {
    const lock = JSON.parse(readFileSync(join(PROJECT_ROOT, 'vendor', 'compat-lock.json'), 'utf8')) as { packages?: Array<{ name: string; version: string; file: string }> };
    vendored = Object.fromEntries((lock.packages ?? []).map((p) => [`file:${p.file}`, p.version]));
  } catch {
    // no vendored stack recorded
  }
  for (const name of PINNED_PACKAGES) {
    const installed = installedPackageVersion(name);
    const spec = expected[name];
    const want = spec?.startsWith('file:') ? (vendored[spec] ?? spec) : spec;
    if (!installed) add('fail', 'packages', `${name} is not installed (run npm ci)`);
    else if (want && installed !== want) add('fail', 'packages', `${name} ${installed} installed; package.json pins ${want}`);
    else add('pass', 'packages', `${name} ${installed}`);
  }
  const tested = upstreamTestedVersions();
  add('info', 'versions', `upstream Mineflayer-tested Java versions: ${tested.slice(-4).join(', ')} (newest ${tested.at(-1) ?? '?'})`);
  const compatProblem = localCompatProblem();
  add(
    compatProblem ? 'warn' : 'pass',
    'versions',
    compatProblem ?? `local compatibility profile ${LOCAL_COMPAT_PROFILE.id}: Minecraft ${LOCAL_COMPAT_PROFILE.minecraftVersion} (protocol ${LOCAL_COMPAT_PROFILE.protocolVersion}) via vendored ${Object.entries(LOCAL_COMPAT_PROFILE.packages).map(([n, v]) => `${n}@${v}`).join(', ')} (not an upstream release)`,
  );

  // Configuration
  let loaded: LoadedConfig | undefined;
  try {
    loaded = loadConfigFile(configPath);
    add('pass', 'config', `valid configuration: ${loaded.path}`);
  } catch (error) {
    if (error instanceof ConfigError) {
      add('fail', 'config', `invalid configuration: ${error.problems.length} problem(s)`);
      for (const problem of error.problems) add('fail', 'config', problem);
    } else {
      add('fail', 'config', `cannot load configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (loaded) {
    const { config } = loaded;
    const profile = resolveVersionProfile(config.minecraft.version);
    if (profile && supportLevel(config.minecraft.version)) {
      add('pass', 'versions', `configured ${config.minecraft.version} -> data ${profile.dataVersion}, protocol ${profile.protocolVersion}; ${supportDescription(config.minecraft.version)}`);
    }
    add('info', 'server', `target ${config.minecraft.host}:${config.minecraft.port} (doctor does not connect)`);

    // Auth and identity
    if (config.bot.auth === 'offline') {
      const loopback = isLoopbackHost(config.minecraft.host);
      add(loopback && config.bot.trustedOfflineFixture ? 'pass' : 'fail', 'auth', `offline auth for a trusted loopback fixture; bot name ${config.bot.username}`);
      add('pass', 'owner', `owner admission by exact name "${config.owner.name ?? '?'}" (trusted offline fixture only)`);
    } else {
      const cached = hasMicrosoftTokenCache(config.bot.username, loaded.authDir);
      add(
        cached ? 'pass' : 'warn',
        'auth',
        cached
          ? `Microsoft token cache present for bot label "${config.bot.username}"`
          : `no Microsoft token cache for bot label "${config.bot.username}": run \`npm run chunkbot -- auth login --config ${configPath}\` before connecting`,
      );
      add('pass', 'owner', `owner admission by verified sender UUID${config.chat.requireSignedChat ? ' with signed chat required' : ''}`);
    }

    // Storage
    for (const [label, path] of [
      ['data', loaded.dataDir],
      ['runs', loaded.runsDir],
      ['auth', loaded.authDir],
    ] as const) {
      const ignored = isIgnoredByGit(PROJECT_ROOT, path);
      if (!existsSync(path)) {
        add(ignored ? 'info' : 'warn', 'storage', `${label} dir ${path} does not exist yet (created on first run)${ignored ? '' : '; NOT covered by .gitignore'}`);
        continue;
      }
      let writable = true;
      try {
        accessSync(path, constants.W_OK);
      } catch {
        writable = false;
      }
      add(writable && ignored ? 'pass' : 'warn', 'storage', `${label} dir ${path}${writable ? ' writable' : ' NOT writable'}${ignored ? ', git-ignored' : ', NOT git-ignored'}`);
    }

    // Model routes: readiness and key presence only — never values, never inference.
    const pl = config.models.planner;
    const codex = findOnPath(pl.command, env);
    add('info', 'planner', `route ${pl.provider} (managed ChatGPT sign-in; no API key, no fallback); mode ${pl.mode}; binary ${codex ?? `${pl.command} not found on PATH`}; selected ${pl.model}/${pl.reasoningEffort} (the CLI does not echo a server-resolved model)`);
    if (pl.mode === 'disabled') {
      add('info', 'planner', 'planner DISABLED by configuration (inference-free profile): natural-language goals end planner_not_ready');
    } else {
      // Read-only: --version and the bundled catalog only (no sign-in, refresh, inference or setup writes).
      const gate = verifyIsolation({ command: pl.command, model: pl.model, effort: pl.reasoningEffort, env, denyEnv: [config.models.decision.apiKeyEnv], featureGate: false }, false);
      for (const c of gate.ok ? gate.isolation.checks : gate.checks) add(c.ok ? 'pass' : 'fail', 'planner', `${c.name}: ${c.detail}`);
      add('info', 'planner', `planner subprocess environment allowlist: ${Object.keys(plannerEnv(env, [config.models.decision.apiKeyEnv])).sort().join(', ')} (${config.models.decision.apiKeyEnv} and all key/token/session/billing inputs excluded)`);
      if (!gate.ok) add('fail', 'planner', `planner isolation gate failed: ${gate.detail}; natural-language goals will report planner_not_ready`);
      else add('info', 'planner', 'live subscription turn/isolation/cancellation probe: npm run chunkbot -- planner-check --probe --config <file> (doctor never calls the model)');
    }
    const keyPresent = Boolean(env[config.models.decision.apiKeyEnv]);
    const d = config.models.decision;
    const official = d.endpoint === DEFAULT_DECISION_ENDPOINT;
    add('info', 'decision', `route ${d.provider} model ${d.model}; ${d.apiKeyEnv} ${keyPresent ? 'is set' : 'is not set'} (value never read by doctor)`);
    const jevProfile = verifiedProfile(d.model);
    const verified = jevProfile !== undefined && jevProfile.provider === d.expectedProvider;
    add(
      official && verified ? 'pass' : 'warn',
      'decision',
      `Jev adapter installed (raw HTTP ${official ? 'OpenRouter Decisions route' : `LOOPBACK FAULT-FIXTURE endpoint ${d.endpoint}`}); provider.allow_fallbacks=false${jevProfile ? `, max_price prompt ${jevProfile.maxPrice.prompt}/M completion ${jevProfile.maxPrice.completion} request ${jevProfile.maxPrice.request}` : ''}; expected provider ${d.expectedProvider}`,
    );
    if (!verified || !jevProfile) {
      add('warn', 'decision', `no verified pricing/context profile for model ${d.model} with provider ${d.expectedProvider}: every Jev request is refused (the pre-dispatch charge bound cannot be guaranteed)`);
    } else {
      add('info', 'decision', `per-run spend cap USD ${config.limits.openRouterSpendCapUsd}; each attempt first reserves the full serving-context maximum USD ${maxAttemptChargeUsd(jevProfile).toFixed(6)} (${jevProfile.contextTokens} tokens x ${jevProfile.maxPrice.prompt}/M); ${config.limits.decisionRequestsPerGoal} attempts/goal; ${config.limits.decisionMinIntervalMs}ms interval; ${config.limits.decisionTimeoutMs}ms timeout; one in flight`);
    }
    if (!keyPresent) add('warn', 'decision', `${d.apiKeyEnv} is not set: task controller decisions will be refused (decision_not_ready); live check: npm run chunkbot -- jev-check --config <file>`);
    // Skill layer (MB-V1-02): catalog generated from registered definitions; knowledge from installed data.
    try {
      const catalog = new SkillRegistry(allSkills()).catalog();
      add('pass', 'skills', `${catalog.capabilities.length} capabilities registered (${catalog.catalogVersion}): ${catalog.capabilities.map((c) => c.id).join(', ')}`);
    } catch (error) {
      add('fail', 'skills', `capability catalog invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const knowledge = new VersionKnowledge({ version: config.minecraft.version });
    const kr = knowledge.readiness();
    add(kr.ready ? (knowledge.recipes ? 'pass' : 'warn') : 'fail', 'knowledge', kr.detail);
    add('info', 'perceive', `line-of-sight perception, radius ${config.limits.observationRadius}, travel radius ${config.limits.travelRadius}; no hidden ores, no global player positions`);
    add('info', 'navigate', `pathfinder policy: ${Object.entries(NAVIGATION_POLICY).map(([k, v]) => `${k}=${Array.isArray(v) ? (v.length ? `[${v.length} items]` : "[]") : String(v)}`).join(' ')}`);
    add('info', 'goals', `open-ended goal intake with the ${pl.mode === 'codex' ? 'Codex subscription planner' : 'planner DISABLED'}, rolling task windows (<= ${config.limits.planWindowSteps} steps, <= ${config.limits.totalTaskCeiling} tasks, <= ${config.limits.plannerTurnsPerGoal} planner turns incl. knowledge/repairs/retries/clarifications/replans, deadline ${Math.round(config.limits.goalDeadlineMs / 60_000)} min), the generic Jev task controller and code-verified outcomes; /diag runs operator mechanic diagnostics; /task runs operator task-controller diagnostics`);
    // MB-MEM-001: read-only inspection (no writer lock, no write, no world data, no inference).
    if (config.memory?.enabled) {
      try {
        const report = inspectMemory(memoryRoot(loaded.dataDir, config.memory), config.memory, systemClock, { limit: 0 });
        const healthy = report.state === 'ready' || report.state === 'empty';
        add(healthy ? 'pass' : 'warn', 'memory', renderMemoryReport(report).slice(0, 3).join('; '));
      } catch (error) {
        add('warn', 'memory', `memory store could not be inspected: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      }
    } else add('info', 'memory', config.memory ? 'disabled by configuration (memory.enabled = false); no memory capability is registered' : 'not configured (no memory section); no memory capability is registered');
    const fl = config.flow;
    add('info', 'flow', `directive handoff ${fl.handoff === 'smooth' ? 'SMOOTH: a new owner instruction is prepared while the current task continues and switches after fresh revalidation' : 'IMMEDIATE: a new owner instruction replaces the current goal at once'}; window lookahead ${fl.lookahead ? 'on (counted planner turns, revalidated before use)' : 'off'}; discarded-preparation allowance ${fl.preparationTurnsPerRun} planner turns per run; one planner process at a time`);

    // Local fixture
    if (config.bot.auth === 'offline') {
      // The fixture profile whose loopback endpoint and version match this configuration (default 26.1.2).
      const pins = fixtureProfileFor(config.minecraft.host, config.minecraft.port, config.minecraft.version) ?? FIXTURE_PINS;
      const flag = pins.profile === FIXTURE_PINS.profile ? '' : ` --fixture ${pins.profile}`;
      const fx = fixturePaths(PROJECT_ROOT, pins);
      add('info', 'fixture', `fixture profile ${pins.profile}: ${pins.host}:${pins.port}, RCON ${pins.rconPort}, var/${pins.varDir}/`);
      add(existsSync(fx.java) ? 'pass' : 'warn', 'fixture', `JRE ${pins.jreRelease}: ${existsSync(fx.java) ? fx.java : `missing (npm run fixture -- setup${flag})`}`);
      add(
        existsSync(fx.serverJar) ? 'pass' : 'warn',
        'fixture',
        `vanilla server ${pins.minecraftVersion}: ${existsSync(fx.serverJar) ? fx.serverJar : `missing (npm run fixture -- setup${flag})`}`,
      );
      const pid = pidAlive(fx.pidFile);
      add('info', 'fixture', pid ? `fixture server process running (pid ${pid})` : `fixture server not running (npm run fixture -- start${flag})`);
    }
  }
  return checks;
}

export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}
