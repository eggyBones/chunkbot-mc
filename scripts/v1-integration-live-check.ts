// Ordinary-pipeline acceptance PREPARATION. No fixture/provider access during
// --stage, import, or a rejected lease/grant. Live mode is coordinator-only.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactAt } from './lib/v1-integration/artifact.ts';
import { captureReader } from './lib/v1-integration/capture.ts';
import { parseOptions, verifyGrant } from './lib/v1-integration/guards.ts';
import { reportDirectory, runScenarios, saveReport } from './lib/v1-integration/runner.ts';
import { selectScenarios } from './lib/v1-integration/scenarios.ts';
import type { RunReport } from './lib/v1-integration/types.ts';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  // Parse before even source/build inspection or output creation. A lease
  // string alone never grants a fixture password read, join or provider call.
  const options = parseOptions(argv);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const composition = options.compositionFile ? JSON.parse(readFileSync(options.compositionFile, 'utf8')) as { instruction: string; outputs: Record<string, number>; returnToOwner?: boolean } : undefined;
  const scenarios = selectScenarios(options.only, composition);
  const artifact = artifactAt(root);
  const grant = options.stage ? undefined : verifyGrant(JSON.parse(readFileSync(options.grantFile!, 'utf8')) as unknown, options.fixture, options.leaseId!, artifact, Date.now(), Boolean(process.env['OPENROUTER_API_KEY']));
  const dir = reportDirectory(root);
  const report: RunReport = {
    version: 1, mode: options.stage ? 'preparation' : 'real', fixture: options.fixture, artifact, leaseId: grant?.leaseId ?? null, scenarios,
    results: scenarios.map((s) => ({ id: s.id, phase: 'planned', autonomous: false, problems: [] })), cleanup: null, acceptance: false,
    blockers: options.stage ? ['no world/provider scenarios executed; no fixture authority used', 'real frozen-artifact, subscription/Jev, server outcome and cleanup acceptance remains pending'] : [],
  };
  const save = () => saveReport(dir, report);
  save();
  if (!options.stage) {
    // Dynamic import ONLY after the entire authority/artifact/key gate.
    await runScenarios(report, scenarios, async () => { const { openOrdinarySession } = await import('./lib/v1-integration/ordinary.ts'); return openOrdinarySession(root, dir, grant!, options.captureFile ? captureReader(root, options.captureFile) : undefined); }, save);
  }
  process.stdout.write(`${options.stage ? 'PREPARED (unexecuted)' : 'RECORDED (coordinator review required)'} V1 integration: ${dir}\n`);
  return options.stage ? 0 : report.results.every((r) => r.phase === 'verified') && report.cleanup?.reconciled ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`refusing/failing V1 integration: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
