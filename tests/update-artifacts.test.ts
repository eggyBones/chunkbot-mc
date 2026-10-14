import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, linkSync, chmodSync, readdirSync, lstatSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ArtifactError, type CoordinatorAcceptance, type DataVersions, type PromotionPolicy, type ArtifactManifest } from '../src/updates/artifacts/model.ts';
import { inspectRelease, packageRelease, validateArtifact, validatePromotableArtifact, artifactDigest } from '../src/updates/artifacts/index.ts';
import { inventory, readRegular, relativePath, treeDigest, assertInventoryPaths, sha256 } from '../src/updates/artifacts/files.ts';

mkdirSync('var/packaging-tests', { recursive: true });
function sandbox(): string { return mkdtempSync(resolve('var/packaging-tests/case-')); }

const versions: DataVersions = { checkpoint: 1, session: 1, memory: 1 };
function put(root: string, path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes);
}
function writable(root: string): void {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return;
  chmodSync(root, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of readdirSync(root)) writable(join(root, name));
}
function cleanup(root: string): void { writable(root); rmSync(root, { recursive: true, force: true }); }
function gitFixture(root: string, ...argv: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Packaging Fixture', '-c', 'user.email=fixture@example.invalid', ...argv],
    { cwd: root, stdio: 'ignore' });
}
// Deliberately tiny, credential-free artifact inputs. These prove packaging
// mechanics, never Minecraft/real-provider acceptance or a production release.
function project(): string {
  const root = sandbox();
  const packages = { 'minecraft-data': '3.117.0+chunkbot.26.2.1', 'prismarine-chunk': '1.41.0+chunkbot.26.2.1', 'prismarine-physics': '1.11.1+chunkbot.26.2.1', mineflayer: '4.39.0+chunkbot.26.2.1' };
  const dependencies: Record<string, string> = { 'fake-runtime': '1.0.0' };
  const lockPackages: Record<string, unknown> = {};
  const vendor: unknown[] = [];
  for (const [name, version] of Object.entries(packages)) {
    const file = `vendor/${name}-${version}.tgz`;
    const bytes = Buffer.from(`DUMMY test tarball ${name}`);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    put(root, file, bytes); dependencies[name] = `file:${file}`;
    const pkgBytes = JSON.stringify({ name, version, chunkbotCompat: { id: 'MB-SERVER-001', profile: '26.2' } });
    put(root, `node_modules/${name}/package.json`, pkgBytes);
    lockPackages[`node_modules/${name}`] = { version, resolved: `file:${file}`, integrity };
    vendor.push({ name, version, file, integrity, changedFiles: { 'package.json': sha256(pkgBytes) } });
  }
  put(root, 'node_modules/fake-runtime/package.json', JSON.stringify({ name: 'fake-runtime', version: '1.0.0', type: 'module', main: 'index.js' }));
  put(root, 'node_modules/fake-runtime/index.js', 'export default "frozen dependency";');
  lockPackages['node_modules/fake-runtime'] = { version: '1.0.0', resolved: 'https://example.invalid/fake-runtime.tgz', integrity: 'sha512-DUMMY' };
  put(root, 'package.json', JSON.stringify({ name: 'packaging-fixture', version: '0.0.0', type: 'module', dependencies }));
  put(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies }, ...lockPackages } }));
  put(root, 'vendor/compat-lock.json', JSON.stringify({ packages: vendor })); put(root, 'vendor/compat-sources.json', '{}');
  put(root, 'tsconfig.json', '{}'); put(root, 'tsconfig.build.json', '{}');
  put(root, '.gitignore', 'var/\nnode_modules/\ndist/\nconfig/\n.env\nchunkbot.config.json\n');
  for (const name of ['cli', 'knowledge/data/vanilla-26.1.2', 'knowledge/data/vanilla-26.2']) {
    const code = name === 'cli' ? 'import value from "fake-runtime"; console.log(JSON.stringify({value, cwd:process.cwd(), config:process.argv.slice(2)}));' : 'export default {};';
    put(root, `src/${name}.ts`, code); put(root, `dist/${name}.js`, code); put(root, `dist/${name}.js.map`, '{}');
  }
  put(root, 'node_modules/.bin/real-tool.js', 'dummy');
  symlinkSync('real-tool.js', join(root, 'node_modules/.bin/tool'));
  // Excluded even when present next to otherwise runnable release inputs.
  for (const path of ['.env', 'chunkbot.config.json', 'var/auth/microsoft/cache.json', 'var/fixture/world/level.dat', 'config/private.json']) put(root, path, 'DUMMY_PRIVATE_DO_NOT_COPY');
  gitFixture(root, 'init', '-q'); gitFixture(root, 'add', 'src', 'vendor', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', '.gitignore');
  gitFixture(root, 'commit', '-qm', 'credential-free packaging fixture');
  return root;
}
function output(root: string, name = 'candidate'): string { return join(root, 'var/packaging-artifacts', name); }
function receipt(manifest: ArtifactManifest): CoordinatorAcceptance {
  return { schemaVersion: 1, receiptId: 'DUMMY offline component test', acceptedBy: 'coordinator', artifactSha256: manifest.artifactSha256,
    acceptedAt: '2026-10-14T00:00:00Z', featureSummary: ['DUMMY packaging fixture only'], evidence: [{ criterion: 'DUMMY-U1', reference: 'dummy component oracle', sha256: 'a'.repeat(64), exitCode: 0 }] };
}
function policy(manifest: ArtifactManifest): PromotionPolicy {
  return { acceptedReceipts: [receipt(manifest)], requiredCriteria: ['DUMMY-U1'], minecraftVersion: '26.2', dataVersions: versions };
}
const code = (expected: string) => (error: unknown): boolean => error instanceof ArtifactError && error.code === expected;

test('packaging paths reject traversal, alternate separators, collisions and aliased ancestors', () => {
  for (const path of ['../key', '/key', 'C:/key', 'a\\key', './key', 'a//key', 'a/../key', 'a/secret\0', 'a./key']) {
    assert.throws(() => relativePath(path), ArtifactError);
  }
  const dir = sandbox();
  try {
    mkdirSync(join(dir, 'real')); writeFileSync(join(dir, 'real/file'), 'safe');
    symlinkSync('real', join(dir, 'link'));
    assert.throws(() => readRegular(dir, 'link/file'), ArtifactError);
    assert.throws(() => inventory(join(dir, 'link')), ArtifactError);
    const item = { path: 'File', size: 0, sha256: '0'.repeat(64), executable: false };
    assert.throws(() => assertInventoryPaths([item, { ...item, path: 'file' }]), ArtifactError);
    assert.throws(() => assertInventoryPaths([item, { ...item, path: 'File/child' }]), ArtifactError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('packaging never follows file symlinks or adopts a hardlinked mutable file', () => {
  const dir = sandbox();
  try {
    writeFileSync(join(dir, 'original'), 'safe');
    symlinkSync('original', join(dir, 'symlink'));
    assert.throws(() => readRegular(dir, 'symlink'), ArtifactError);
    linkSync(join(dir, 'original'), join(dir, 'hardlink'));
    assert.throws(() => readRegular(dir, 'hardlink'), ArtifactError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tree identity is deterministic and binds bytes, paths and executable bits', () => {
  const a = { path: 'a', size: 1, sha256: 'a'.repeat(64), executable: false };
  const b = { ...a, path: 'b' };
  assert.equal(treeDigest([a, b]), treeDigest([b, a]));
  assert.notEqual(treeDigest([a]), treeDigest([{ ...a, executable: true }]));
  assert.notEqual(treeDigest([a]), treeDigest([{ ...a, sha256: 'b'.repeat(64) }]));
});

test('actual packaging produces a sealed independent runnable artifact and excludes private runtime data', async () => {
  const root = project();
  try {
    const initialSource = treeDigest(inventory(join(root, 'dist')));
    const initialDeps = treeDigest(inventory(join(root, 'node_modules'), { skipBins: true }));
    const manifest = await packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions });
    const verified = await validateArtifact(output(root));
    assert.equal(verified.manifest.artifactSha256, manifest.artifactSha256);
    assert.equal(treeDigest(inventory(join(root, 'dist'))), initialSource);
    assert.equal(treeDigest(inventory(join(root, 'node_modules'), { skipBins: true })), initialDeps);
    const names = inventory(output(root)).map((file) => file.path);
    assert.ok(!names.some((path) => path.includes('/.bin/') || path.startsWith('var/') || path.startsWith('config/') || path === '.env' || path === 'chunkbot.config.json'));
    assert.ok(!names.some((path) => readFileSync(join(output(root), path), 'utf8').includes('DUMMY_PRIVATE_DO_NOT_COPY')));
    const externalConfig = join(root, 'config/private.json');
    // Source dependencies change after freezing. Candidate resolves its own copy.
    put(root, 'node_modules/fake-runtime/index.js', 'export default "mutated source";');
    const child = spawnSync(process.execPath, [verified.entryPoint, '--config', externalConfig], { cwd: output(root), encoding: 'utf8', env: {} });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { value: 'frozen dependency', cwd: output(root), config: ['--config', externalConfig] });
    assert.ok((lstatSync(output(root)).mode & 0o222) === 0);
    assert.ok((lstatSync(verified.entryPoint).mode & 0o222) === 0);
  } finally { cleanup(root); }
});

test('same frozen inputs reproduce identities regardless of destination and mtime', async () => {
  const root = project();
  try {
    const a = await packageRelease({ sourceDir: root, outputDir: output(root, 'a'), dataVersions: versions });
    const b = await packageRelease({ sourceDir: root, outputDir: output(root, 'b'), dataVersions: versions });
    assert.deepEqual(a, b);
    assert.deepEqual(await validateArtifact(output(root, 'a')).then((v) => v.manifest), b);
    assert.notEqual(a.artifactSha256, inspectRelease({ sourceDir: root, dataVersions: { ...versions, session: 2 } }).artifactSha256);
  } finally { cleanup(root); }
});

test('passing packaging cannot manufacture promotion authority or omit coordinator-required criteria', async () => {
  const root = project();
  try {
    const manifest = await packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions });
    assert.ok(await validateArtifact(output(root)));
    await assert.rejects(validatePromotableArtifact(output(root), { ...policy(manifest), acceptedReceipts: [] }), code('not_accepted'));
    await assert.rejects(validatePromotableArtifact(output(root), { ...policy(manifest), requiredCriteria: [] }), code('not_accepted'));
    await assert.rejects(validatePromotableArtifact(output(root), { ...policy(manifest), requiredCriteria: ['REAL both-version U-G1'] }), code('not_accepted'));
    await assert.rejects(validatePromotableArtifact(output(root), { ...policy(manifest), acceptedReceipts: [{ ...receipt(manifest), artifactSha256: '0'.repeat(64) }] }), code('not_accepted'));
    await assert.rejects(validatePromotableArtifact(output(root), { ...policy(manifest), acceptedReceipts: [receipt(manifest), receipt(manifest)] }), code('not_accepted'));
    const dummy = await validatePromotableArtifact(output(root), policy(manifest));
    assert.equal(dummy.acceptance.receiptId, 'DUMMY offline component test');
    await assert.rejects(validatePromotableArtifact(output(root), { ...policy(manifest), dataVersions: { ...versions, checkpoint: 2 } }), code('incompatible'));
    await assert.rejects(validatePromotableArtifact(output(root), { ...policy(manifest), minecraftVersion: '26.2.1' as '26.2' }), code('incompatible'));
  } finally { cleanup(root); }
});

test('dirty or untracked source and incomplete/extra/stale build membership fail before publication', async () => {
  const root = project();
  try {
    put(root, 'untracked.ts', '// unaccepted');
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('source_dirty'));
    rmSync(join(root, 'untracked.ts'));
    const old = readFileSync(join(root, 'src/cli.ts'));
    put(root, 'src/cli.ts', '// dirty');
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('source_dirty'));
    put(root, 'src/cli.ts', old);
    rmSync(join(root, 'dist/cli.js'));
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('build_incomplete'));
    put(root, 'dist/cli.js', old); put(root, 'dist/old.js', '// stale output');
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('build_incomplete'));
    assert.equal(existsSync(output(root)), false);
    rmSync(join(root, 'dist'), { recursive: true });
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('build_incomplete'));
  } finally { cleanup(root); }
});

test('dependency version, nested unlocked packages, tarball and local compatibility patch drift are refused', async () => {
  const root = project();
  try {
    const path = 'node_modules/fake-runtime/package.json';
    const initial = readFileSync(join(root, path));
    put(root, path, '{"version":"2.0.0"}');
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('dependency_mismatch'));
    put(root, path, initial);
    put(root, 'node_modules/fake-runtime/node_modules/rogue/file.js', '// unlocked');
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('dependency_mismatch'));
    rmSync(join(root, 'node_modules/fake-runtime/node_modules'), { recursive: true });
    const installed = 'node_modules/minecraft-data/package.json';
    const before = readFileSync(join(root, installed));
    put(root, installed, `${before.toString()}\n`);
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('dependency_mismatch'));
    put(root, installed, before);
    put(root, 'node_modules/fake-runtime/.env', 'DUMMY credential');
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('unsafe_path'));
    rmSync(join(root, 'node_modules/fake-runtime/.env'));
    put(root, 'vendor/minecraft-data-3.117.0+chunkbot.26.2.1.tgz', 'wrong tarball');
    gitFixture(root, 'add', 'vendor'); gitFixture(root, 'commit', '-qm', 'tampered dummy tarball');
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('dependency_mismatch'));
    assert.equal(existsSync(output(root)), false);
  } finally { cleanup(root); }
});

test('unsafe output, symlinked parents and duplicate publication never mutate another destination', async () => {
  const root = project();
  try {
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: join(root, 'dist'), dataVersions: versions }), code('unsafe_path'));
    mkdirSync(join(root, 'var/elsewhere'));
    symlinkSync('elsewhere', join(root, 'var/packaging-artifacts'));
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('unsafe_path'));
    assert.deepEqual(readdirSync(join(root, 'var/elsewhere')), []);
    rmSync(join(root, 'var/packaging-artifacts'));
    const manifest = await packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions });
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('output_exists'));
    assert.equal((await validateArtifact(output(root))).manifest.artifactSha256, manifest.artifactSha256);
  } finally { cleanup(root); }
});

test('incomplete, changed bytes, undeclared files and mutable permissions are distinct validation failures', async () => {
  const root = project();
  try {
    mkdirSync(output(root), { recursive: true });
    await assert.rejects(validateArtifact(output(root)), code('artifact_incomplete'));
    rmSync(output(root), { recursive: true });
    await packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions });
    const entry = join(output(root), 'dist/cli.js'); const before = readFileSync(entry);
    chmodSync(entry, 0o644); writeFileSync(entry, 'changed'); chmodSync(entry, 0o444);
    await assert.rejects(validateArtifact(output(root)), code('artifact_tampered'));
    chmodSync(entry, 0o644); writeFileSync(entry, before); chmodSync(entry, 0o444);
    chmodSync(output(root), 0o755); put(output(root), 'private.json', 'DUMMY');
    await assert.rejects(validateArtifact(output(root)), code('artifact_incomplete'));
    rmSync(join(output(root), 'private.json')); chmodSync(output(root), 0o555);
    chmodSync(output(root), 0o755); mkdirSync(join(output(root), 'private-empty')); chmodSync(join(output(root), 'private-empty'), 0o555); chmodSync(output(root), 0o555);
    await assert.rejects(validateArtifact(output(root)), code('artifact_incomplete'));
    chmodSync(output(root), 0o755); rmSync(join(output(root), 'private-empty'), { recursive: true }); chmodSync(output(root), 0o555);
    chmodSync(entry, 0o644);
    await assert.rejects(validateArtifact(output(root)), code('artifact_tampered'));
    chmodSync(entry, 0o444);
    chmodSync(join(output(root), 'dist'), 0o755); rmSync(entry); chmodSync(join(output(root), 'dist'), 0o555);
    await assert.rejects(validateArtifact(output(root)), code('artifact_incomplete'));
  } finally { cleanup(root); }
});

test('manifest traversal, forged acceptance, checksum edits and schema additions fail closed', async () => {
  const root = project();
  try {
    const manifest = await packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions });
    const path = join(output(root), 'manifest.json');
    function change(raw: unknown): void { chmodSync(path, 0o644); writeFileSync(path, JSON.stringify(raw)); chmodSync(path, 0o444); }
    change({ ...manifest, acceptance: receipt(manifest) });
    await assert.rejects(validateArtifact(output(root)), code('manifest_invalid'));
    change({ ...manifest, artifactSha256: 'a'.repeat(64) });
    await assert.rejects(validateArtifact(output(root)), code('manifest_invalid'));
    const hostile = structuredClone(manifest); hostile.files[0]!.path = '../outside';
    hostile.artifactSha256 = artifactDigest(hostile); change(hostile);
    await assert.rejects(validateArtifact(output(root)), code('unsafe_path'));
    const forged = structuredClone(manifest); forged.source.commit = 'a'.repeat(40); forged.artifactSha256 = artifactDigest(forged); change(forged);
    await assert.rejects(validatePromotableArtifact(output(root), policy(manifest)), code('not_accepted'));
  } finally { cleanup(root); }
});

test('dedicated script creates/verifies actual artifacts, rejects bad args and reports non-promotable output', () => {
  const root = project();
  try {
    const script = resolve('scripts/package-release.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: resolve('.'), encoding: 'utf8', env: { PATH: process.env['PATH'] } });
    const inspected = run('inspect', '--source', root, '--data-versions', JSON.stringify(versions));
    assert.equal(inspected.status, 0, inspected.stderr); assert.equal(JSON.parse(inspected.stdout).promotable, false);
    const created = run('create', '--source', root, '--output', output(root), '--data-versions', JSON.stringify(versions));
    assert.equal(created.status, 0, created.stderr);
    const data = JSON.parse(created.stdout); assert.equal(data.integrityVerified, true); assert.equal(data.promotable, false);
    const verified = run('verify', '--artifact', output(root));
    assert.equal(verified.status, 0, verified.stderr); assert.equal(JSON.parse(verified.stdout).artifactSha256, data.artifactSha256);
    const duplicate = run('create', '--source', root, '--output', output(root), '--data-versions', JSON.stringify(versions));
    assert.equal(duplicate.status, 1); assert.equal(JSON.parse(duplicate.stderr).code, 'output_exists');
    const bad = run('verify', '--artifact', output(root), '--unknown', 'DUMMY_SECRET');
    assert.equal(bad.status, 1); assert.ok(!bad.stderr.includes('DUMMY_SECRET'));
  } finally { cleanup(root); }
});

test('credential-bearing lock URLs and metadata are refused before any bytes are published', async () => {
  const root = project();
  try {
    const path = join(root, 'package-lock.json');
    const original = readFileSync(path, 'utf8');
    for (const resolved of ['https://DUMMY:SECRET@example.invalid/pkg.tgz', 'https://example.invalid/pkg.tgz?token=DUMMY']) {
      const lock = JSON.parse(original); lock.packages['node_modules/fake-runtime'].resolved = resolved;
      writeFileSync(path, JSON.stringify(lock)); gitFixture(root, 'add', 'package-lock.json'); gitFixture(root, 'commit', '-qm', 'dummy credential URL');
      await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('unsafe_path'));
    }
    const lock = JSON.parse(original); lock._authToken = 'DUMMY_SECRET';
    writeFileSync(path, JSON.stringify(lock)); gitFixture(root, 'add', 'package-lock.json'); gitFixture(root, 'commit', '-qm', 'dummy private metadata');
    await assert.rejects(packageRelease({ sourceDir: root, outputDir: output(root), dataVersions: versions }), code('unsafe_path'));
    assert.equal(existsSync(output(root)), false);
  } finally { cleanup(root); }
});

test('startup-crash and not-ready fixtures keep packaging integrity distinct from runtime acceptance', async () => {
  const root = project();
  try {
    for (const [name, codeText] of [['crash', 'throw new Error("DUMMY startup crash");'], ['not-ready', 'console.log(JSON.stringify({ready:false,reason:"DUMMY readiness failure"}));']] as const) {
      put(root, 'src/cli.ts', codeText); put(root, 'dist/cli.js', codeText);
      gitFixture(root, 'add', 'src/cli.ts'); gitFixture(root, 'commit', '-qm', `dummy ${name} candidate`);
      const manifest = await packageRelease({ sourceDir: root, outputDir: output(root, name), dataVersions: versions });
      const verified = await validateArtifact(output(root, name));
      await assert.rejects(validatePromotableArtifact(output(root, name), { ...policy(manifest), acceptedReceipts: [] }), code('not_accepted'));
      const child = spawnSync(process.execPath, [verified.entryPoint], { cwd: output(root, name), encoding: 'utf8', env: {} });
      if (name === 'crash') { assert.equal(child.status, 1); assert.match(child.stderr, /DUMMY startup crash/); }
      else { assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).ready, false); }
    }
  } finally { cleanup(root); }
});
