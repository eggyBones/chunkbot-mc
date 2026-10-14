import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ArtifactError, DataVersionsSchema, ArtifactManifestSchema, type ArtifactManifest, type PackageReleaseOptions, type FileIdentity } from './model.ts';
import { assertInventoryPaths, identity, inventory, publicInputPath, readRegular, relativePath, safeDirectory, sha256, treeDigest } from './files.ts';

const LocalPackages = {
  'minecraft-data': '3.117.0+chunkbot.26.2.1',
  'prismarine-chunk': '1.41.0+chunkbot.26.2.1',
  'prismarine-physics': '1.11.1+chunkbot.26.2.1',
  mineflayer: '4.39.0+chunkbot.26.2.1',
} as const;
const PackageSchema = z.object({
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  chunkbotCompat: z.object({ id: z.string(), profile: z.string() }).optional(),
});
const LockSchema = z.object({
  lockfileVersion: z.literal(3),
  packages: z.record(z.string(), z.object({
    version: z.string().optional(), resolved: z.string().optional(), integrity: z.string().optional(),
    link: z.boolean().optional(), optional: z.boolean().optional(),
    dependencies: z.record(z.string(), z.string()).optional(), devDependencies: z.record(z.string(), z.string()).optional(),
  })),
});
const VendorSchema = z.object({ packages: z.array(z.object({
  name: z.string(), version: z.string(), file: z.string(), integrity: z.string(),
  changedFiles: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).refine((value) => Object.keys(value).length > 0),
})).length(4) });

function json(root: string, path: string): unknown {
  try {
    const value: unknown = JSON.parse(readRegular(root, path).toString('utf8'));
    rejectPrivateJSON(value);
    return value;
  }
  catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError('dependency_mismatch', 'Required packaging input is missing or invalid JSON');
  }
}

function rejectPrivateJSON(value: unknown, depth = 0): void {
  if (depth > 100) throw new ArtifactError('manifest_invalid', 'JSON input exceeds nesting bounds');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:_auth|_authToken|api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|credentials)$/i.test(key)) {
      throw new ArtifactError('unsafe_path', 'Packaging metadata contains a private credential field');
    }
    rejectPrivateJSON(child, depth + 1);
  }
}

function git(root: string, args: string[]): string {
  // No checkout/install/build/hooks, account access, network, or config mutation.
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], {
      cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { throw new ArtifactError('source_dirty', 'Cannot prove the source Git identity'); }
}

function sourceIdentity(root: string): ArtifactManifest['source'] {
  if (safeDirectory(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root ||
      git(root, ['status', '--porcelain=v1', '--untracked-files=all']).length) {
    throw new ArtifactError('source_dirty', 'Packaging requires an exact clean source checkout');
  }
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new ArtifactError('source_dirty', 'Source commit is invalid');
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const files = paths.map((path) => identity(root, relativePath(path)));
  assertInventoryPaths(files);
  return { commit, tree: tree(files) };
}

function tree(files: FileIdentity[]): { sha256: string; files: FileIdentity[] } {
  return { sha256: treeDigest(files), files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')) };
}

function prefix(files: FileIdentity[], directory: string): FileIdentity[] {
  return files.map((file) => ({ ...file, path: `${directory}/${file.path}` }));
}

function checkBuild(root: string, source: ArtifactManifest['source']): FileIdentity[] {
  if (!existsSync(join(root, 'dist'))) throw new ArtifactError('build_incomplete', 'Build output is absent');
  const actual = prefix(inventory(join(root, 'dist')), 'dist');
  const expected = source.tree.files.filter((file) => file.path.startsWith('src/') && file.path.endsWith('.ts') && !file.path.endsWith('.d.ts'))
    .flatMap((file) => {
      const js = `dist/${file.path.slice(4, -3)}.js`;
      return [js, `${js}.map`];
    }).sort();
  if (!expected.includes('dist/cli.js') || JSON.stringify(actual.map((file) => file.path).sort()) !== JSON.stringify(expected)) {
    throw new ArtifactError('build_incomplete', 'Build output does not exactly cover the tracked application source');
  }
  return actual;
}

function checkDependencies(root: string): FileIdentity[] {
  const pkgResult = PackageSchema.safeParse(json(root, 'package.json'));
  const lockResult = LockSchema.safeParse(json(root, 'package-lock.json'));
  const vendorResult = VendorSchema.safeParse(json(root, 'vendor/compat-lock.json'));
  if (!pkgResult.success || !lockResult.success || !vendorResult.success) throw new ArtifactError('dependency_mismatch', 'Dependency inputs do not match the required schemas');
  const pkg = pkgResult.data; const lock = lockResult.data; const vendor = vendorResult.data;
  const lockRoot = lock.packages[''];
  if (!lockRoot || JSON.stringify(lockRoot.dependencies ?? {}) !== JSON.stringify(pkg.dependencies ?? {}) ||
      JSON.stringify(lockRoot.devDependencies ?? {}) !== JSON.stringify(pkg.devDependencies ?? {})) {
    throw new ArtifactError('dependency_mismatch', 'Package declarations and lockfile root differ');
  }
  const paths = Object.keys(lock.packages).filter(Boolean);
  if (!paths.length) throw new ArtifactError('dependency_mismatch', 'Dependency lock is empty');
  for (const path of paths) {
    relativePath(path);
    if (!/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path)) {
      throw new ArtifactError('dependency_mismatch', 'Lockfile dependency path is outside the installed tree');
    }
    const entry = lock.packages[path];
    if (!entry?.version || entry.link) throw new ArtifactError('dependency_mismatch', 'Linked or unversioned dependency is not allowed');
    if (entry.resolved?.startsWith('file:')) {
      const target = relativePath(entry.resolved.slice(5));
      if (!Object.entries(LocalPackages).some(([name, version]) => target === `vendor/${name}-${version}.tgz` &&
          (path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)))) {
        throw new ArtifactError('dependency_mismatch', 'Local dependency download identity is outside the pinned vendor inputs');
      }
    }
    if (entry.resolved && !entry.resolved.startsWith('file:vendor/')) {
      let url: URL;
      try { url = new URL(entry.resolved); }
      catch { throw new ArtifactError('dependency_mismatch', 'Dependency download identity is not a public URL'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new ArtifactError('unsafe_path', 'Dependency download identity contains credentials or private parameters');
      }
    }
    if (!existsSync(join(root, path)) && entry.optional) continue;
    const installed = PackageSchema.safeParse(json(root, `${path}/package.json`));
    if (!installed.success || installed.data.version !== entry.version) throw new ArtifactError('dependency_mismatch', 'Installed dependency does not match its locked version');
  }
  for (const [name, version] of Object.entries(LocalPackages)) {
    const records = vendor.packages.filter((entry) => entry.name === name);
    const record = records[0];
    if (records.length !== 1 || !record || record.version !== version || record.file !== `vendor/${name}-${version}.tgz`) {
      throw new ArtifactError('dependency_mismatch', 'Vendored compatibility profile differs from the admitted builds');
    }
    const locked = lock.packages[`node_modules/${name}`];
    const installed = PackageSchema.parse(json(root, `node_modules/${name}/package.json`));
    const integrity = `sha512-${createHash('sha512').update(readRegular(root, record.file)).digest('base64')}`;
    if (locked?.resolved !== `file:${record.file}` || locked.integrity !== record.integrity || integrity !== record.integrity ||
        installed.version !== version || installed.chunkbotCompat?.id !== 'MB-SERVER-001' || installed.chunkbotCompat.profile !== '26.2') {
      throw new ArtifactError('dependency_mismatch', 'Vendored tarball, lock integrity or installed compatibility marker differs');
    }
    for (const [path, digest] of Object.entries(record.changedFiles)) {
      if (sha256(readRegular(root, `node_modules/${name}/${relativePath(path)}`)) !== digest) {
        throw new ArtifactError('dependency_mismatch', 'Installed compatibility patch bytes differ from the vendor record');
      }
    }
  }
  const files = prefix(inventory(join(root, 'node_modules'), { skipBins: true }), 'node_modules');
  for (const file of files) {
    if (file.path === 'node_modules/.package-lock.json') { json(root, file.path); continue; }
    // Resolve the NEAREST package root, not an enclosing package whose prefix
    // would accidentally admit arbitrary nested node_modules.
    const parts = file.path.split('/');
    const last = parts.lastIndexOf('node_modules');
    const count = parts[last + 1]?.startsWith('@') ? 3 : 2;
    const owner = parts.slice(0, last + count).join('/');
    if (!paths.includes(owner)) throw new ArtifactError('dependency_mismatch', 'Installed tree contains an unlocked package');
    if (file.path.split('/').some((part) => /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_rsa|auth\.json|credentials\.json|.*\.(?:pem|key))$/i.test(part))) {
      throw new ArtifactError('unsafe_path', 'Installed tree contains a private credential file');
    }
  }
  return files;
}

export function artifactDigest(manifest: Omit<ArtifactManifest, 'artifactSha256'> | ArtifactManifest): string {
  const { artifactSha256: _ignored, ...rest } = manifest as ArtifactManifest;
  return sha256(JSON.stringify(rest));
}

/** Inspect without writing, installing, building, connecting or executing candidate code. */
export function inspectRelease(options: Omit<PackageReleaseOptions, 'outputDir'>): ArtifactManifest {
  const root = safeDirectory(options.sourceDir);
  if (!/^24\.\d+\.\d+$/.test(process.versions.node) || !['darwin', 'linux', 'win32'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    throw new ArtifactError('incompatible', 'Packaging requires a supported Node 24 runtime');
  }
  const dataVersions = DataVersionsSchema.parse(options.dataVersions);
  const source = sourceIdentity(root);
  const build = checkBuild(root, source);
  const dependencies = checkDependencies(root);
  const inputPaths = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', '.gitignore',
    ...source.tree.files.filter((file) => file.path.startsWith('vendor/')).map((file) => file.path)];
  if (!inputPaths.every(publicInputPath)) throw new ArtifactError('unsafe_path', 'Build inputs include an unapproved vendored path');
  const inputs = inputPaths.map((path) => identity(root, path));
  const files = [...build, ...dependencies, ...inputs];
  assertInventoryPaths(files);
  const data = files.filter((file) => file.path.startsWith('dist/knowledge/data/') || file.path.startsWith('node_modules/minecraft-data/'));
  if (!data.some((file) => file.path === 'dist/knowledge/data/vanilla-26.1.2.js') || !data.some((file) => file.path === 'dist/knowledge/data/vanilla-26.2.js')) {
    throw new ArtifactError('build_incomplete', 'Both exact-version mechanics datasets are required');
  }
  const draft: Omit<ArtifactManifest, 'artifactSha256'> = {
    schemaVersion: 1, entryPoint: 'dist/cli.js', source, build: tree(build), dependencies: tree(dependencies), data: tree(data), inputs: tree(inputs),
    compatibility: {
      node: { major: 24, version: process.versions.node }, platform: process.platform as 'darwin' | 'linux' | 'win32', arch: process.arch as 'arm64' | 'x64',
      minecraft: [ { version: '26.1.2', protocol: 775, support: 'upstream-tested' }, { version: '26.2', protocol: 776, support: 'local-compat', profile: 'MB-SERVER-001' } ],
      dataVersions, planner: { cliVersion: '0.160.0', model: 'gpt-6.1-sol', effort: 'low' },
    },
    files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')),
  };
  // Schema normalization makes the identity independent of object insertion order.
  const parsed = ArtifactManifestSchema.parse({ artifactSha256: '0'.repeat(64), ...draft });
  parsed.artifactSha256 = artifactDigest(parsed);
  return parsed;
}

function ensureDirectory(path: string): void {
  if (existsSync(path)) { safeDirectory(path); return; }
  ensureDirectory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  safeDirectory(path);
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function sealDirectories(root: string): void {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (lstatSync(path).isDirectory()) sealDirectories(path);
  }
  chmodSync(root, 0o555);
  syncDirectory(root);
}

function unsealDirectories(root: string): void {
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) unsealDirectories(path);
  }
}

/** Freeze into a NEW, task-owned staging artifact. Never install/build or replace a release. */
export async function packageRelease(options: PackageReleaseOptions): Promise<ArtifactManifest> {
  const root = safeDirectory(options.sourceDir);
  const output = resolve(options.outputDir);
  const parent = join(root, 'var', 'packaging-artifacts');
  // Worker packaging cannot accidentally adopt active dist/dependencies/releases.
  if (dirname(output) !== parent || relativePath(basename(output)).startsWith('.')) throw new ArtifactError('unsafe_path', 'Output must be a new child of sourceDir/var/packaging-artifacts');
  const manifest = inspectRelease(options);
  ensureDirectory(parent);
  try { mkdirSync(output, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ArtifactError('output_exists', 'Artifact destination already exists; it will not be replaced');
    throw error;
  }
  const owned = lstatSync(output);
  try {
    for (const file of manifest.files) {
      const bytes = readRegular(root, file.path);
      if (sha256(bytes) !== file.sha256) throw new ArtifactError('artifact_tampered', 'Source payload changed during packaging');
      const target = join(output, relativePath(file.path));
      ensureDirectory(dirname(target));
      const fd = openSync(target, 'wx', file.executable ? 0o555 : 0o444);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      // Umask must not silently change the executable identity.
      chmodSync(target, file.executable ? 0o555 : 0o444);
    }
    if (JSON.stringify(inspectRelease(options)) !== JSON.stringify(manifest)) throw new ArtifactError('artifact_tampered', 'Source/build/dependency inputs changed during packaging');
    // Manifest is the completion marker. Incomplete copies have no valid marker.
    const fd = openSync(join(output, 'manifest.json'), 'wx', 0o444);
    try { writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(join(output, 'manifest.json'), 0o444);
    sealDirectories(output);
    syncDirectory(parent);
    // The library and dedicated script both expose a fully checked result.
    const { validateArtifact } = await import('./validate.ts');
    await validateArtifact(output);
    return manifest;
  } catch (error) {
    const current = lstatSync(output);
    // Never delete an externally substituted path or a different task's artifact.
    if (!current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) {
      unsealDirectories(output);
      rmSync(output, { recursive: true });
    }
    throw error;
  }
}
