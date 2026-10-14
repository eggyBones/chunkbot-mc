#!/usr/bin/env node
// Dedicated owned entry point. No npm alias/shared CLI edit or deployment.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { ArtifactError, DataVersionsSchema, inspectRelease, packageRelease, validateArtifact } from '../src/updates/artifacts/index.ts';

const usage = `Usage:
  node scripts/package-release.ts inspect --source <clean-checkout> --data-versions '<json>'
  node scripts/package-release.ts create --source <clean-checkout> --output <checkout>/var/packaging-artifacts/<name> --data-versions '<json>'
  node scripts/package-release.ts verify --artifact <directory>

Data versions are explicit coordinator decisions: {"checkpoint":1,"session":1,"memory":1}.
Inspection/creation do not build, install, connect, infer, deploy, or grant acceptance.
Verification checks every packaged file. Promotion requires the external trusted receipt API.
Run the application with Node 24 and the returned entryPoint, passing an absolute external --config.
`;

try {
  const { values, positionals } = parseArgs({
    options: { source: { type: 'string' }, output: { type: 'string' }, artifact: { type: 'string' }, 'data-versions': { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: true, strict: true,
  });
  const command = positionals[0];
  if (values.help) process.stdout.write(usage);
  else if (positionals.length !== 1 || !['inspect', 'create', 'verify'].includes(command ?? '')) { process.stderr.write(usage); process.exitCode = 2; }
  else if (command === 'verify') {
    if (!values.artifact || values.source || values.output || values['data-versions']) throw new ArtifactError('manifest_invalid', 'verify requires only --artifact');
    const verified = await validateArtifact(resolve(values.artifact));
    process.stdout.write(`${JSON.stringify({ artifactSha256: verified.manifest.artifactSha256, entryPoint: verified.entryPoint, integrityVerified: true, promotable: false })}\n`);
  } else {
    if (!values.source || !values['data-versions'] || values.artifact || (command === 'create' ? !values.output : Boolean(values.output))) {
      throw new ArtifactError('manifest_invalid', 'inspect/create require explicit source, data versions and command-appropriate output');
    }
    const parsed = DataVersionsSchema.safeParse(JSON.parse(values['data-versions']));
    if (!parsed.success) throw new ArtifactError('incompatible', 'Durable data version input is invalid');
    const sourceDir = resolve(values.source);
    const manifest = command === 'inspect' ? inspectRelease({ sourceDir, dataVersions: parsed.data }) :
      await packageRelease({ sourceDir, outputDir: resolve(values.output ?? ''), dataVersions: parsed.data });
    if (command === 'create') await validateArtifact(resolve(values.output ?? ''));
    process.stdout.write(`${JSON.stringify({ artifactSha256: manifest.artifactSha256, sourceCommit: manifest.source.commit,
      sourceSha256: manifest.source.tree.sha256, buildSha256: manifest.build.sha256, dependencySha256: manifest.dependencies.sha256,
      dataSha256: manifest.data.sha256, entryPoint: command === 'create' ? resolve(values.output ?? '', manifest.entryPoint) : manifest.entryPoint,
      integrityVerified: command === 'create', promotable: false })}\n`);
  }
} catch (error) {
  // Never echo arbitrary JSON/input values, filesystem contents or child stderr.
  const code = error instanceof ArtifactError ? error.code : 'io_error';
  const message = error instanceof ArtifactError ? error.message : 'Packaging input or filesystem operation failed';
  process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  process.exitCode = 1;
}
