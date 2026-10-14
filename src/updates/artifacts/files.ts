import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { ArtifactError, type FileIdentity } from './model.ts';

export const MAX_FILES = 50_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Explicit sorted inventories, independent of timestamps and machine paths.
export function treeDigest(files: readonly FileIdentity[]): string {
  return sha256(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path, 'en'))));
}

export function relativePath(path: string): string {
  if (path.length > 1024 || !path || isAbsolute(path) || /[\\:\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new ArtifactError('unsafe_path', 'Non-canonical relative file path');
  }
  return path;
}

// Check EVERY ancestor, including the supplied root. realpath alone hides links.
export function safeDirectory(path: string): string {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ArtifactError('unsafe_path', 'Directory ancestor is not a physical directory');
  }
  if (realpathSync(absolute) !== absolute) throw new ArtifactError('unsafe_path', 'Directory path is aliased');
  return absolute;
}

export function readRegular(root: string, path: string): Buffer {
  relativePath(path);
  const absolute = join(safeDirectory(root), path);
  safeDirectory(join(absolute, '..'));
  const before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024 * 1024) {
    throw new ArtifactError('unsafe_path', 'Payload must contain bounded independent regular files');
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new ArtifactError('artifact_tampered', 'File changed while opening');
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const named = lstatSync(absolute);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        named.ino !== before.ino || named.dev !== before.dev || named.isSymbolicLink()) {
      throw new ArtifactError('artifact_tampered', 'File changed while reading');
    }
    safeDirectory(join(absolute, '..'));
    return bytes;
  } finally { closeSync(fd); }
}

export function identity(root: string, path: string): FileIdentity {
  const bytes = readRegular(root, path);
  return { path, size: bytes.length, sha256: sha256(bytes), executable: (lstatSync(join(root, path)).mode & 0o111) !== 0 };
}

export function inventory(root: string, options: { skipBins?: boolean; omitManifest?: boolean } = {}): FileIdentity[] {
  safeDirectory(root);
  const files: FileIdentity[] = [];
  const names = new Set<string>();
  let total = 0;
  function walk(prefix: string): void {
    const dir = join(root, prefix);
    safeDirectory(dir);
    for (const name of readdirSync(dir).sort()) {
      const path = relativePath(prefix ? `${prefix}/${name}` : name);
      if (options.skipBins && name === '.bin') continue;
      if (options.omitManifest && path === 'manifest.json') continue;
      if (names.has(path.toLowerCase())) throw new ArtifactError('unsafe_path', 'Case-colliding payload paths');
      names.add(path.toLowerCase());
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory() && !stat.isSymbolicLink()) { walk(path); continue; }
      const file = identity(root, path);
      total += file.size;
      if (files.length >= MAX_FILES || total > MAX_TOTAL_BYTES) throw new ArtifactError('manifest_invalid', 'Artifact inventory exceeds bounds');
      files.push(file);
    }
  }
  walk('');
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function assertInventoryPaths(files: readonly FileIdentity[]): void {
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    relativePath(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new ArtifactError('manifest_invalid', 'Duplicate or case-colliding inventory path');
    seen.add(key);
    total += file.size;
    if (total > MAX_TOTAL_BYTES) throw new ArtifactError('manifest_invalid', 'Artifact inventory exceeds bounds');
  }
  // A regular file cannot also be the parent of another file.
  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join('/').toLowerCase())) throw new ArtifactError('manifest_invalid', 'File/directory inventory collision');
      parts.pop();
    }
  }
}
