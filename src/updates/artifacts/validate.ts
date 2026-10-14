import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArtifactError, ArtifactManifestSchema, CoordinatorAcceptanceSchema, DataVersionsSchema,
  type ArtifactManifest, type VerifiedArtifact, type PromotableArtifact, type PromotionPolicy,
} from './model.ts';
import { assertInventoryPaths, inventory, publicInputPath, readRegular, safeDirectory, treeDigest } from './files.ts';
import { artifactDigest } from './package.ts';

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

function checkManifest(manifest: ArtifactManifest): void {
  for (const group of [manifest.source.tree, manifest.build, manifest.dependencies, manifest.data, manifest.inputs]) {
    assertInventoryPaths(group.files);
    if (treeDigest(group.files) !== group.sha256) throw new ArtifactError('manifest_invalid', 'Inventory digest does not match its declared group');
  }
  assertInventoryPaths(manifest.files);
  const ordered = (files: ArtifactManifest['files']) => [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!same(manifest.files, ordered(manifest.files))) throw new ArtifactError('manifest_invalid', 'Payload inventory is not canonical');
  const build = manifest.files.filter((file) => file.path.startsWith('dist/'));
  const deps = manifest.files.filter((file) => file.path.startsWith('node_modules/'));
  const inputs = manifest.files.filter((file) => publicInputPath(file.path));
  const data = manifest.files.filter((file) => file.path.startsWith('dist/knowledge/data/') || file.path.startsWith('node_modules/minecraft-data/'));
  const required = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', '.gitignore', 'vendor/compat-lock.json', 'vendor/compat-sources.json'];
  if (!required.every((path) => inputs.some((file) => file.path === path)) || build.length + deps.length + inputs.length !== manifest.files.length ||
      !same(build, manifest.build.files) || !same(deps, manifest.dependencies.files) || !same(inputs, manifest.inputs.files) || !same(data, manifest.data.files)) {
    throw new ArtifactError('manifest_invalid', 'Payload groups are incomplete or contain unapproved paths');
  }
  const expectedBuild = manifest.source.tree.files.filter((file) => file.path.startsWith('src/') && file.path.endsWith('.ts') && !file.path.endsWith('.d.ts'))
    .flatMap((file) => [`dist/${file.path.slice(4, -3)}.js`, `dist/${file.path.slice(4, -3)}.js.map`]).sort();
  if (!same(build.map((file) => file.path).sort(), expectedBuild) || !build.some((file) => file.path === 'dist/cli.js') ||
      !data.some((file) => file.path === 'dist/knowledge/data/vanilla-26.1.2.js') || !data.some((file) => file.path === 'dist/knowledge/data/vanilla-26.2.js') ||
      manifest.compatibility.minecraft[0]?.version !== '26.1.2' || manifest.compatibility.minecraft[1]?.version !== '26.2') {
    throw new ArtifactError('manifest_invalid', 'Build or compatibility declaration is incomplete');
  }
  if (artifactDigest(manifest) !== manifest.artifactSha256) throw new ArtifactError('manifest_invalid', 'Manifest identity does not bind its complete content');
}

function checkReadOnly(root: string): void {
  const stat = lstatSync(root);
  if ((stat.mode & 0o222) !== 0) throw new ArtifactError('artifact_tampered', 'Artifact permissions allow mutation');
  if (stat.isDirectory()) for (const name of readdirSync(root)) checkReadOnly(join(root, name));
}

function checkDirectories(root: string, files: ArtifactManifest['files']): void {
  const expected = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/'); parts.pop();
    while (parts.length) { expected.add(parts.join('/')); parts.pop(); }
  }
  function walk(prefix: string): void {
    for (const name of readdirSync(join(root, prefix))) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!lstatSync(join(root, path)).isDirectory()) continue;
      if (!expected.has(path)) throw new ArtifactError('artifact_incomplete', 'Artifact contains an undeclared directory');
      walk(path);
    }
  }
  walk('');
}

/** No candidate code is executed and no self-declared acceptance is trusted. */
export async function validateArtifact(directory: string): Promise<VerifiedArtifact> {
  let root: string;
  let raw: unknown;
  try {
    root = safeDirectory(directory);
    raw = JSON.parse(readRegular(root, 'manifest.json').toString('utf8'));
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError('artifact_incomplete', 'Artifact completion manifest is absent or unreadable');
  }
  const result = ArtifactManifestSchema.safeParse(raw);
  if (!result.success) throw new ArtifactError('manifest_invalid', 'Artifact manifest schema is invalid');
  const manifest = result.data;
  checkManifest(manifest);
  let actual: ArtifactManifest['files'];
  try { actual = inventory(root, { omitManifest: true }); }
  catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError('artifact_incomplete', 'Artifact payload is incomplete');
  }
  if (!same(actual.map((file) => file.path), manifest.files.map((file) => file.path))) {
    throw new ArtifactError('artifact_incomplete', 'Artifact is missing declared files or contains undeclared files');
  }
  if (!same(actual, manifest.files)) throw new ArtifactError('artifact_tampered', 'Artifact payload bytes or executable identity differ');
  checkDirectories(root, manifest.files);
  checkReadOnly(root);
  return { directory: root, entryPoint: join(root, manifest.entryPoint), manifest };
}

/** Manager-facing authorization seam: policy must come from trusted coordinator state. */
export async function validatePromotableArtifact(directory: string, policy: PromotionPolicy): Promise<PromotableArtifact> {
  const verified = await validateArtifact(directory);
  const { manifest } = verified;
  const receipts = policy.acceptedReceipts.map((receipt) => {
    const parsed = CoordinatorAcceptanceSchema.safeParse(receipt);
    if (!parsed.success) throw new ArtifactError('not_accepted', 'Trusted acceptance input has an invalid schema');
    return parsed.data;
  }).filter((receipt) => receipt.artifactSha256 === manifest.artifactSha256);
  if (receipts.length !== 1 || !policy.requiredCriteria.length || new Set(policy.requiredCriteria).size !== policy.requiredCriteria.length) {
    throw new ArtifactError('not_accepted', 'Exactly one external acceptance receipt and explicit required criteria are necessary');
  }
  const acceptance = receipts[0];
  if (!acceptance || !policy.requiredCriteria.every((criterion) => acceptance.evidence.some((evidence) => evidence.criterion === criterion))) {
    throw new ArtifactError('not_accepted', 'Coordinator acceptance does not cover all required criteria');
  }
  const dataVersions = DataVersionsSchema.safeParse(policy.dataVersions);
  const compat = manifest.compatibility;
  if (!dataVersions.success || !same(dataVersions.data, compat.dataVersions) || process.versions.node.split('.')[0] !== String(compat.node.major) ||
      process.platform !== compat.platform || process.arch !== compat.arch || !compat.minecraft.some((profile) => profile.version === policy.minecraftVersion)) {
    throw new ArtifactError('incompatible', 'Runtime, exact Minecraft profile or durable data versions are incompatible');
  }
  return { ...verified, acceptance };
}
