// MB-LOC-001: the locator gate harness is import-safe and refuses to touch a
// fixture without an explicit lease. Verified by static source checks and by
// spawning it only with missing/invalid leases (exit 2 before any password
// read, RCON command, join or output-directory setup).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';

const SCRIPT = join(PROJECT_ROOT, 'scripts', 'locator-live-check.ts');
const source = readFileSync(SCRIPT, 'utf8');
const liveDir = join(PROJECT_ROOT, 'var', 'live-check');
const listLive = () => (existsSync(liveDir) ? readdirSync(liveDir).sort() : []);

describe('MB-LOC-001 locator harness guard', () => {
  it('is import-safe: main() runs only behind the entry-point guard; the lease check precedes run(); no top-level side effects', () => {
    const guard = source.indexOf('if (isEntryPoint(import.meta.url, process.argv[1])) {');
    assert.ok(guard > 0, 'entry-point guard present');
    const code = source.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const calls = code.filter(({ l }) => /(^|[^\w.])main\(/.test(l) && !/function main\(/.test(l));
    const guardLine = source.slice(0, guard).split('\n').length - 1;
    assert.equal(calls.length, 1, calls.map((c) => c.l).join(' | '));
    assert.ok(calls[0]!.i > guardLine, 'main() is only invoked inside the entry-point guard');
    const mainBody = source.slice(source.indexOf('async function main('), guard);
    const leaseCheck = mainBody.indexOf("argOf(argv, '--fixture-lease')");
    assert.ok(leaseCheck > 0 && mainBody.indexOf('run(argv, lease)') > leaseCheck, 'run() only after the lease check');
    // Password reads, RCON, joins, output dirs and heavy imports live inside run(), never at top level.
    const topLevel = source.split('\n').filter((l) => /^(const|let|var|await|[a-zA-Z_$][\w$]*\()/.test(l));
    for (const l of topLevel) assert.ok(!/readFileSync\(|rconCommand\(|mkdirSync\(|connect\(|createBot\(|import\(/.test(l), `top-level side effect: ${l}`);
    const runBody = source.slice(source.indexOf('async function run('), source.indexOf('async function main('));
    assert.ok(runBody.indexOf("await import('../src/app/fixture-layout.ts')") < runBody.indexOf('readFileSync(fx.properties'), 'imports before any read');
    assert.ok(/--approve-rules/.test(runBody) && /requires --approve-rules/.test(runBody), 'rule/attribute changes need their own approval id');
    assert.ok(/requires --approve-scene/.test(runBody), 'scene fills need their own approval id');
    assert.ok(/finally \{[\s\S]*restores\.reverse\(\)/.test(runBody), 'restorations run in finally');
  });

  for (const args of [[], ['--fixture', '26.2'], ['--fixture-lease'], ['--fixture-lease', '--fixture', '26.2'], ['--fixture-lease', '../x;rm'], ['--gates', 'g1,g2', '--approve-rules', 'x1']]) {
    it(`refuses without a valid lease: ${JSON.stringify(args)}`, () => {
      const before = listLive();
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /refusing to run: pass --fixture-lease/);
      assert.equal(r.stdout, '');
      assert.deepEqual(listLive(), before, 'no live-check output directory created');
    });
  }
});
