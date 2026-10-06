// `chunkbot dashboard`: the separately launched local viewer. Runs with or
// without Chunkbot running. Reads the configuration only to find the ignored
// runtime storage and the NAMES of the optional metadata credentials; it never
// reads auth caches, never joins Minecraft and never starts a model.
import type { LoadedConfig } from '../config/load.ts';
import { readCodexQuota } from './codex-quota.ts';
import { dashboardPaths } from './files.ts';
import { localTimeZone, pidAlive } from './history.ts';
import { CoalescedSource, codexQuotaFetcher, openRouterKeyFetcher, type RemoteSources } from './remote.ts';
import { DEFAULT_DASHBOARD_PORT, DashboardStartError, DashboardViewer } from './server.ts';

export interface ViewerCommandOptions {
  port?: number;
  host?: string;
  /** Optional OpenRouter current-key overview (needs the configured key variable in this process). */
  openRouterKey?: boolean;
  /** Optional Codex subscription quota observer (pinned CLI, managed ChatGPT login). */
  codexQuota?: boolean;
}

export interface ViewerIo {
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
}

export const VIEWER_USAGE = `Usage: chunkbot dashboard [--config <file>] [--port <n>] [--host 127.0.0.1|::1|localhost] [--no-openrouter-key] [--no-codex-quota]

Local read-only Chunkbot dashboard for a second monitor. Binds loopback only
(default 127.0.0.1:${DEFAULT_DASHBOARD_PORT}). It follows the status Chunkbot publishes under
<dataDir>/dashboard/ and keeps working while Chunkbot is stopped. Closing it
never stops Chunkbot. Optional account metadata is read per source, shared by
all tabs and only while a tab is open: the OpenRouter key overview at most once
a minute, the Codex quota at most once every 2 minutes.`;

/** Parses viewer flags (shared by the standalone entry and the CLI integration). */
export function parseViewerArgs(argv: readonly string[]): { config?: string; options: ViewerCommandOptions; help: boolean } | string {
  const options: ViewerCommandOptions = {};
  let config: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? '';
    const value = () => {
      const v = argv[i + 1];
      i += 1;
      return v;
    };
    if (a === '--config') {
      const v = value();
      if (!v) return '--config requires a path';
      config = v;
    } else if (a === '--port') {
      const v = Number(value());
      if (!Number.isInteger(v) || v < 0 || v > 65_535) return '--port must be an integer 0..65535';
      options.port = v;
    } else if (a === '--host') {
      const v = value();
      if (!v) return '--host requires a value';
      options.host = v;
    } else if (a === '--no-openrouter-key') options.openRouterKey = false;
    else if (a === '--no-codex-quota') options.codexQuota = false;
    else if (a === '--help' || a === '-h') help = true;
    else return `unknown option ${a}`;
  }
  return { ...(config ? { config } : {}), options, help };
}

/** Starts the viewer; resolves with the running instance (the caller owns shutdown). */
export async function startDashboardViewer(loaded: LoadedConfig, options: ViewerCommandOptions, io: ViewerIo): Promise<DashboardViewer> {
  const paths = dashboardPaths(loaded.dataDir);
  const now = () => Date.now();
  const remote: RemoteSources = {};
  if (options.openRouterKey !== false) {
    const apiKeyEnv = loaded.config.models.decision.apiKeyEnv;
    remote.openRouterKey = new CoalescedSource({ name: 'openrouter-key', now, minIntervalMs: 60_000, timeoutMs: 10_000, fetch: openRouterKeyFetcher({ apiKeyEnv, env: () => io.env, now }) });
  }
  if (options.codexQuota !== false) {
    const command = loaded.config.models.planner.command;
    const denyEnv = [loaded.config.models.decision.apiKeyEnv];
    remote.codexQuota = new CoalescedSource({ name: 'codex-quota', now, minIntervalMs: 120_000, timeoutMs: 20_000, fetch: codexQuotaFetcher((signal) => readCodexQuota({ command, env: io.env, denyEnv, timeoutMs: 15_000 }, signal)) });
  }
  const viewer = new DashboardViewer({
    ...(options.host ? { host: options.host } : {}),
    port: options.port ?? DEFAULT_DASHBOARD_PORT,
    statusPath: paths.status,
    historyPath: paths.history,
    pidAlive,
    remote,
    timeZone: localTimeZone(),
    log: io.err,
  });
  const { url } = await viewer.start();
  io.out(`[dashboard] viewing ${paths.dir}`);
  io.out(`[dashboard] open ${url} (loopback only; read-only). Ctrl-C stops only the dashboard.`);
  io.out(`[dashboard] account metadata: OpenRouter key overview ${remote.openRouterKey ? 'on' : 'off'}, Codex quota ${remote.codexQuota ? 'on' : 'off'} (per source, shared by all tabs, only while a tab is open: ${[remote.openRouterKey ? `OpenRouter key at most every ${remote.openRouterKey.minIntervalMs / 1000} s` : '', remote.codexQuota ? `Codex quota at most every ${remote.codexQuota.minIntervalMs / 1000} s` : ''].filter(Boolean).join(', ') || 'no reads'})`);
  return viewer;
}

/** Runs until SIGINT/SIGTERM. Returns the process exit code. */
export async function runDashboardViewer(loaded: LoadedConfig, options: ViewerCommandOptions, io: ViewerIo): Promise<number> {
  let viewer: DashboardViewer;
  try {
    viewer = await startDashboardViewer(loaded, options, io);
  } catch (error) {
    if (error instanceof DashboardStartError) {
      io.err(`[dashboard] ${error.message}`);
      return 2;
    }
    io.err(`[dashboard] failed to start: ${error instanceof Error ? error.message.slice(0, 200) : 'error'}`);
    return 1;
  }
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await viewer.close();
  io.out('[dashboard] stopped (Chunkbot, if running, is unaffected)');
  return 0;
}
