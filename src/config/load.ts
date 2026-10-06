// Loads and validates configuration. Errors name the field and rule but never
// echo received values, so a mistakenly pasted secret is not printed.
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { z } from 'zod';
import { ConfigSchema, type ChunkbotConfig } from './schema.ts';
import { checkVersionSupport } from './versions.ts';

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(source: string, problems: string[]) {
    super(`Invalid configuration (${source}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export interface LoadedConfig {
  config: ChunkbotConfig;
  /** Absolute path of the configuration file. */
  path: string;
  /** Absolute data directory (run evidence, auth caches). */
  dataDir: string;
  runsDir: string;
  authDir: string;
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    let message = issue.message;
    if (issue.code === 'unrecognized_keys') {
      message = `unknown field(s): ${issue.keys.join(', ')} (secrets must be supplied through environment variables, not config)`;
    }
    return `${path}: ${message}`;
  });
}

/** Validates an already-parsed object. Used by tests and the file loader. */
export function parseConfig(raw: unknown, source = 'inline'): ChunkbotConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(source, formatIssues(result.error.issues));
  const versionProblem = checkVersionSupport(result.data.minecraft.version);
  if (versionProblem) throw new ConfigError(source, [`minecraft.version: ${versionProblem}`]);
  return result.data;
}

export function resolveProjectRoot(configPath: string): string {
  // Configs live in <root>/ or <root>/config/(examples/); data paths resolve against the root.
  const dir = dirname(configPath);
  if (dir.endsWith('/config/examples')) return resolve(dir, '..', '..');
  if (dir.endsWith('/config')) return resolve(dir, '..');
  return dir;
}

export function loadConfigFile(path: string): LoadedConfig {
  const absolute = resolve(path);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new ConfigError(absolute, [`cannot read configuration file (${code})`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(absolute, ['configuration file is not valid JSON']);
  }
  if (raw && typeof raw === 'object' && '$comment' in raw) {
    delete (raw as Record<string, unknown>)['$comment'];
  }
  const config = parseConfig(raw, absolute);
  const root = resolveProjectRoot(absolute);
  const dataDir = isAbsolute(config.storage.dataDir) ? config.storage.dataDir : resolve(root, config.storage.dataDir);
  return {
    config,
    path: absolute,
    dataDir,
    runsDir: resolve(dataDir, 'runs'),
    authDir: resolve(dataDir, 'auth', 'microsoft'),
  };
}

export const DEFAULT_CONFIG_PATH = 'chunkbot.config.json';

export function configPathFrom(argvPath: string | undefined, env: NodeJS.ProcessEnv): string {
  return argvPath ?? env['CHUNKBOT_CONFIG'] ?? DEFAULT_CONFIG_PATH;
}
