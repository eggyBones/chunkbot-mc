// MB-SERVER-001: reproducibly builds the vendored Minecraft Java 26.2
// compatibility packages (vendor/*.tgz) from PINNED inputs only:
//
//   - the released npm registry tarball of each base version, verified against
//     its recorded sha512 integrity (the same value the original lockfile had);
//   - upstream files fetched by exact git commit and verified by git blob SHA-1;
//   - the recorded patches in vendor/patches/ (upstream pull-request/commit
//     hunks, plus the MB-SERVER-002 26.2 attribute-id correction), applied with
//     `patch --forward --batch --fuzz=0`; every patched file must have its recorded
//     git blob SHA-1 before AND after, so any drift fails the build.
//
// The package.json of every output gets version `<base>+chunkbot.26.2.1` and a
// `chunkbotCompat` provenance block, then `npm pack --ignore-scripts`
// produces the tarball. Output integrities are recorded in vendor/compat-lock.json
// and pinned again by package-lock.json, so `npm ci` installs exactly these bytes
// (and fails with EINTEGRITY otherwise). No node_modules hand edits are involved.
//
//   node scripts/vendor-compat.ts           rebuild vendor/*.tgz + vendor/compat-lock.json
//   node scripts/vendor-compat.ts --check   rebuild into a scratch dir and compare byte-for-byte
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';

interface OverlayFile {
  from: string;
  to: string;
  blob: string;
  note?: string;
}
interface PackageSource {
  name: string;
  baseVersion: string;
  baseTarball: string;
  baseIntegrity: string;
  upstream: Record<string, string>;
  overlay?: OverlayFile[];
  edits?: Array<{ file: string; description: string; upstreamBlob?: string }>;
  patches?: Array<{ file: string; scope: string; fileBlobs: Record<string, { before: string; after: string }> }>;
}
interface Sources {
  id: string;
  profile: string;
  buildSuffix: string;
  packages: PackageSource[];
}
export interface LockEntry {
  name: string;
  version: string;
  file: string;
  integrity: string;
  size: number;
  baseIntegrity: string;
  changedFiles: Record<string, string>;
}

const VENDOR = join(PROJECT_ROOT, 'vendor');
const SOURCES_FILE = join(VENDOR, 'compat-sources.json');
const LOCK_FILE = join(VENDOR, 'compat-lock.json');
const WORK = join(PROJECT_ROOT, 'var', 'compatibility', 'vendor-build');
const CACHE = join(WORK, 'cache');

function log(line: string): void {
  process.stdout.write(`[vendor-compat] ${line}\n`);
}

const sha512 = (buf: Buffer) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
/** Git's blob object id: sha1("blob <len>\0<content>"). */
const gitBlob = (buf: Buffer) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

async function fetchCached(url: string, verify: (buf: Buffer) => boolean, label: string): Promise<Buffer> {
  const file = join(CACHE, createHash('sha256').update(url).digest('hex').slice(0, 24));
  if (existsSync(file)) {
    const cached = readFileSync(file);
    if (verify(cached)) return cached;
    rmSync(file);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!verify(buf)) throw new Error(`${label}: content from ${url} does not match its pinned digest`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, buf);
  return buf;
}

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} (in ${cwd}) exited ${r.status}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function rawUrl(repository: string, commit: string, path: string): string {
  const slug = repository.replace(/^https:\/\/github\.com\//, '');
  return `https://raw.githubusercontent.com/${slug}/${commit}/${path}`;
}

async function upstreamFile(pkg: PackageSource, path: string, blob: string): Promise<Buffer> {
  const repository = pkg.upstream['repository'];
  const commit = pkg.upstream['commit'];
  if (!repository || !commit) throw new Error(`${pkg.name}: overlay needs upstream.repository and upstream.commit`);
  return fetchCached(rawUrl(repository, commit, path), (b) => gitBlob(b) === blob, `${pkg.name} ${path}`);
}

/** Inserts pc["26.2"] after pc["26.1"] in dataPaths.json, preserving the released file's exact formatting. */
async function editDataPaths(pkg: PackageSource, dir: string, blob: string, profile: string): Promise<void> {
  const file = join(dir, 'minecraft-data', 'data', 'dataPaths.json');
  const text = readFileSync(file, 'utf8');
  const parsed = JSON.parse(text) as { pc: Record<string, Record<string, string>> };
  if (`${JSON.stringify(parsed, null, 2)}\n` !== text) throw new Error('dataPaths.json formatting is not 2-space JSON; refusing to rewrite');
  if (parsed.pc[profile]) throw new Error(`dataPaths.json already has pc.${profile}`);
  const upstream = JSON.parse((await upstreamFile(pkg, 'data/dataPaths.json', blob)).toString('utf8')) as typeof parsed;
  const entry = upstream.pc[profile];
  if (!entry) throw new Error(`upstream dataPaths.json has no pc.${profile}`);
  // Installed at pc/<profile>/proto.yml (see compat-sources.json overlay note), not pc/latest.
  const ours = { ...entry, proto: `pc/${profile}` };
  const pc: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(parsed.pc)) {
    pc[k] = v;
    if (k === '26.1') pc[profile] = ours;
  }
  if (!pc[profile]) throw new Error('dataPaths.json has no pc.26.1 to insert after');
  writeFileSync(file, `${JSON.stringify({ ...parsed, pc }, null, 2)}\n`);
}

function editVersions(dir: string, profile: string): void {
  const file = join(dir, 'minecraft-data', 'data', 'pc', 'common', 'versions.json');
  const text = readFileSync(file, 'utf8');
  const tail = '  "26.1"\n]';
  if (!text.endsWith(tail)) throw new Error('pc/common/versions.json does not end with "26.1"; refusing to edit');
  writeFileSync(file, `${text.slice(0, -tail.length)}  "26.1",\n  "${profile}"\n]`);
}

async function build(outDir: string): Promise<LockEntry[]> {
  const sources = JSON.parse(readFileSync(SOURCES_FILE, 'utf8')) as Sources;
  const stageRoot = join(WORK, 'stage');
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const entries: LockEntry[] = [];
  for (const pkg of sources.packages) {
    const tgz = await fetchCached(pkg.baseTarball, (b) => sha512(b) === pkg.baseIntegrity, `${pkg.name}@${pkg.baseVersion}`);
    const stage = join(stageRoot, pkg.name);
    mkdirSync(stage, { recursive: true });
    const tgzFile = join(stage, 'base.tgz');
    writeFileSync(tgzFile, tgz);
    run('tar', ['xzf', tgzFile, '-C', stage], stage);
    rmSync(tgzFile);
    const dir = join(stage, 'package');
    const before = snapshot(dir);

    for (const file of pkg.overlay ?? []) {
      const content = await upstreamFile(pkg, file.from, file.blob);
      const dest = join(dir, file.to);
      if (existsSync(dest)) throw new Error(`${pkg.name}: overlay target ${file.to} already exists in the released package`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    for (const patch of pkg.patches ?? []) {
      const blobOf = (f: string) => gitBlob(readFileSync(join(dir, f)));
      for (const [f, b] of Object.entries(patch.fileBlobs)) {
        if (blobOf(f) !== b.before) throw new Error(`${pkg.name}: ${f} is not the recorded base (blob ${blobOf(f)} != ${b.before}) for ${patch.file}`);
      }
      run('patch', ['-p1', '--forward', '--batch', '--fuzz=0', '--no-backup-if-mismatch', '-i', join(PROJECT_ROOT, patch.file)], dir);
      const leftovers = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.orig') || f.endsWith('.rej'));
      if (leftovers.length) throw new Error(`${pkg.name}: patch left ${leftovers.join(', ')}`);
      for (const [f, b] of Object.entries(patch.fileBlobs)) {
        if (blobOf(f) !== b.after) throw new Error(`${pkg.name}: ${f} after ${patch.file} is blob ${blobOf(f)}, recorded ${b.after}`);
      }
    }
    for (const edit of pkg.edits ?? []) {
      if (edit.file.endsWith('dataPaths.json')) await editDataPaths(pkg, dir, edit.upstreamBlob ?? '', sources.profile);
      else if (edit.file.endsWith('versions.json')) editVersions(dir, sources.profile);
      else if (edit.file === 'data.js') run(process.execPath, ['bin/generate_data.js'], dir);
      else throw new Error(`${pkg.name}: no edit handler for ${edit.file}`);
    }

    const pjFile = join(dir, 'package.json');
    const pj = JSON.parse(readFileSync(pjFile, 'utf8')) as Record<string, unknown>;
    if (pj['version'] !== pkg.baseVersion) throw new Error(`${pkg.name}: base tarball is ${String(pj['version'])}, expected ${pkg.baseVersion}`);
    const version = `${pkg.baseVersion}+${sources.buildSuffix}`;
    pj['version'] = version;
    // A registry tarball never runs `prepare` on install, but npm treats it as an install
    // script for non-registry (file:) sources. minecraft-data's `prepare` regenerates files
    // from devDependencies that are not installed, so it is removed (data.js is regenerated
    // above instead). Recorded in the provenance block.
    const scripts = (pj['scripts'] ?? {}) as Record<string, string>;
    const removedScripts: Record<string, string> = {};
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (scripts[name] !== undefined) {
        removedScripts[name] = scripts[name];
        delete scripts[name];
      }
    }
    const changed = diffSnapshots(before, snapshot(dir)).filter((f) => f !== 'package.json');
    pj['chunkbotCompat'] = {
      id: sources.id,
      profile: sources.profile,
      note: 'LOCAL compatibility build for Minecraft Java 26.2; not an upstream release. Built by scripts/vendor-compat.ts from vendor/compat-sources.json.',
      base: { version: pkg.baseVersion, tarball: pkg.baseTarball, integrity: pkg.baseIntegrity },
      upstream: pkg.upstream,
      changedFiles: changed,
      ...(Object.keys(removedScripts).length ? { removedInstallScripts: removedScripts } : {}),
    };
    writeFileSync(pjFile, `${JSON.stringify(pj, null, 2)}\n`);

    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outDir], dir)) as Array<{
      filename: string;
      integrity: string;
    }>;
    const filename = packed[0]?.filename;
    if (!filename) throw new Error(`${pkg.name}: npm pack produced no tarball`);
    const out = readFileSync(join(outDir, filename));
    const changedFiles: Record<string, string> = {};
    for (const f of [...changed, 'package.json']) changedFiles[f] = sha256(readFileSync(join(dir, f)));
    entries.push({ name: pkg.name, version, file: `vendor/${filename}`, integrity: sha512(out), size: out.length, baseIntegrity: pkg.baseIntegrity, changedFiles });
    log(`${pkg.name}@${version}: ${filename} ${sha512(out)} (${changed.length} changed files besides package.json)`);
  }
  return entries;
}

function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }).map(String)) {
    const full = join(dir, rel);
    try {
      map.set(rel, sha256(readFileSync(full)));
    } catch {
      // directory
    }
  }
  return map;
}

function diffSnapshots(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of b) if (a.get(k) !== v) out.push(k);
  for (const k of a.keys()) if (!b.has(k)) out.push(`(removed) ${k}`);
  return out.sort();
}

async function main(): Promise<void> {
  if (process.argv.includes('--check')) {
    const scratch = join(WORK, 'check-out');
    rmSync(scratch, { recursive: true, force: true });
    const rebuilt = await build(scratch);
    const recorded = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as { packages: LockEntry[] };
    let ok = true;
    for (const entry of rebuilt) {
      const want = recorded.packages.find((p) => p.name === entry.name);
      const vendored = join(PROJECT_ROOT, entry.file);
      const vendoredIntegrity = existsSync(vendored) ? sha512(readFileSync(vendored)) : 'missing';
      const same = want?.integrity === entry.integrity && vendoredIntegrity === entry.integrity;
      log(`${same ? 'OK  ' : 'DIFF'} ${entry.name}: rebuilt ${entry.integrity}; recorded ${want?.integrity ?? 'none'}; vendored ${vendoredIntegrity}`);
      ok &&= same;
    }
    if (!ok) process.exitCode = 1;
    return;
  }
  const staging = join(WORK, 'out');
  rmSync(staging, { recursive: true, force: true });
  const entries = await build(staging);
  for (const old of readdirSync(VENDOR).filter((f) => f.endsWith('.tgz'))) rmSync(join(VENDOR, old));
  for (const entry of entries) copyFileSync(join(staging, entry.file.slice('vendor/'.length)), join(PROJECT_ROOT, entry.file));
  writeFileSync(
    LOCK_FILE,
    `${JSON.stringify({ $comment: 'GENERATED by scripts/vendor-compat.ts: output digests of the vendored 26.2 compatibility tarballs. package-lock.json pins the same integrities.', packages: entries }, null, 2)}\n`,
  );
  log(`wrote ${LOCK_FILE}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`[vendor-compat] error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
