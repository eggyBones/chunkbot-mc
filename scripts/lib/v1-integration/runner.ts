import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generalityProblems, verifyEvidence } from './oracles.ts';
import { SCENARIOS } from './scenarios.ts';
import type { RunReport, Scenario, Session } from './types.ts';

// Reports are allocated with mkdir (no reuse/overwrite), then checkpointed
// after every phase. Exceptions never erase the initial failed evidence.
export function reportDirectory(root: string): string {
  const parent = join(root, 'var', 'live-check');
  mkdirSync(parent, { recursive: true });
  const dir = join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-v1-integration`);
  mkdirSync(dir);
  return dir;
}
export function saveReport(dir: string, report: RunReport): void {
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
export async function runScenarios(report: RunReport, scenarios: Scenario[], open: () => Promise<Session>, checkpoint: () => void): Promise<void> {
  let session: Session | undefined;
  try {
    session = await open();
    for (const scenario of scenarios) {
      const result = report.results.find((r) => r.id === scenario.id)!;
      if (!scenario.instruction) { result.phase = 'deferred'; result.problems.push('composition must be chosen by the coordinator at acceptance without code/prompt changes'); checkpoint(); continue; }
      try {
        await session.stage(scenario);
        result.phase = 'staged'; result.stagedAtMs = Date.now(); checkpoint();
        const evidence = await session.execute(scenario, () => { result.phase = 'executed'; result.executedAtMs = Date.now(); checkpoint(); });
        result.phase = 'executed'; result.executedAtMs ??= Date.now(); result.evidence = evidence; checkpoint();
        result.problems.push(...verifyEvidence(scenario, evidence));
        result.autonomous = !evidence.interventions.some((i) => i.kind !== 'setup');
        if (!result.problems.length) { result.phase = 'verified'; result.verifiedAtMs = Date.now(); }
        else result.phase = 'failed';
      } catch (error) { result.phase = 'failed'; result.problems.push(error instanceof Error ? error.message : String(error)); }
      checkpoint();
    }
  } catch (error) { report.blockers.push(error instanceof Error ? error.message : String(error)); }
  finally {
    if (session) {
      try { report.cleanup = await session.close(); }
      catch (error) { report.cleanup = { reconciled: false, steps: [{ step: 'session-close', ok: false, detail: error instanceof Error ? error.message : String(error) }] }; }
    }
    for (const result of report.results) if (result.phase === 'planned') { result.phase = 'deferred'; result.problems.push('session never exercised this scenario'); }
    report.blockers.push(...generalityProblems(report.results));
    if (!report.cleanup?.reconciled) report.blockers.push('world/player/process cleanup is not independently reconciled');
    if (report.results.length !== SCENARIOS.length) report.blockers.push('partial scenario selection cannot close V1 acceptance');
    // Human source review, source/build/launch matching, and both versions
    // remain coordinator gates even when every individual scenario verifies.
    report.acceptance = false;
    report.blockers.push('coordinator source/general-intent review and independent both-version acceptance remain required');
    checkpoint();
  }
}
