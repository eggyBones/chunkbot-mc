#!/usr/bin/env node
// Standalone entry for the dashboard viewer until it is wired as
// `chunkbot dashboard`:  node dist/dashboard/main.js [--config <file>] [--port <n>]
import { ConfigError, configPathFrom, loadConfigFile } from '../config/load.ts';
import { VIEWER_USAGE, parseViewerArgs, runDashboardViewer } from './viewer-command.ts';

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

async function main(): Promise<number> {
  const parsed = parseViewerArgs(process.argv.slice(2));
  if (typeof parsed === 'string') {
    err(parsed);
    err(VIEWER_USAGE);
    return 2;
  }
  if (parsed.help) {
    out(VIEWER_USAGE);
    return 0;
  }
  let loaded;
  try {
    loaded = loadConfigFile(configPathFrom(parsed.config, process.env));
  } catch (error) {
    if (error instanceof ConfigError) {
      err(error.message);
      return 1;
    }
    throw error;
  }
  return runDashboardViewer(loaded, parsed.options, { out, err, env: process.env });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    err(`[dashboard] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
