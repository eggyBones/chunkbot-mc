import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Artifact } from './types.ts';

function digest(root: string, paths: string[]): string {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    if (!lstatSync(join(root, path)).isFile()) throw new Error('artifact contains non-regular file');
    const body = readFileSync(join(root, path));
    hash.update(`${path}\0${body.length}\0`).update(body);
  }
  return hash.digest('hex');
}
export function artifactAt(root: string): Artifact {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const paths = [...new Set(git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter((p) => /^(src\/|scripts\/|tests\/|config\/|vendor\/|package(?:-lock)?\.json$|tsconfig.*\.json$)/.test(p)))];
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((p) => p.isDirectory() ? walk(`${dir}/${p.name}`) : [`${dir}/${p.name}`]);
  let distSha256: string | null = null;
  try { const dist = walk('dist'); if (!dist.includes('dist/cli.js')) throw new Error('CLI missing'); distSha256 = digest(root, dist); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { head: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0, sourceSha256: digest(root, paths), distSha256 };
}
