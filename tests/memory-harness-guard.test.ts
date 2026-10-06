// MB-BATCH001-I1 regression: the memory live harness is import-safe and
// refuses to touch a fixture without an explicit lease. Verified WITHOUT
// importing the harness (static source checks) and by spawning it only with
// missing/invalid leases, which must exit before any password read, RCON,
// join or output setup.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';

const SCRIPT = join(PROJECT_ROOT, 'scripts', 'memory-live-check.ts');
const source = readFileSync(SCRIPT, 'utf8');
const liveDir = join(PROJECT_ROOT, 'var', 'live-check');
const listLive = () => (existsSync(liveDir) ? readdirSync(liveDir).sort() : []);

describe('memory live harness guard (MB-BATCH001-I1)', () => {
  it('is import-safe: main() runs only behind the entry-point guard, and the lease check precedes every fixture path', () => {
    const guard = source.indexOf('if (isEntryPoint(import.meta.url, process.argv[1])) {');
    assert.ok(guard > 0, 'entry-point guard present');
    // Code (not comments) invoking main(): exactly one call, inside the guard.
    const code = source.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const calls = code.filter(({ l }) => /(^|[^\w.])main\(\)/.test(l) && !/function main\(/.test(l));
    const guardLine = source.slice(0, guard).split('\n').length - 1;
    assert.equal(calls.length, 1, calls.map((c) => c.l).join(' | '));
    assert.ok(calls[0]!.i > guardLine, 'main() is only invoked inside the entry-point guard');
    const mainBody = source.slice(source.indexOf('async function main()'), guard);
    const leaseCheck = mainBody.indexOf("arg('--fixture-lease')");
    assert.ok(leaseCheck > 0);
    for (const later of ['orchestrate()', 'seed(', 'recall(', "arg('--out')"]) assert.ok(mainBody.indexOf(later) > leaseCheck, `${later} only after the lease check`);
    // No top-level password read, RCON, connection or output setup.
    const topLevel = source.split('\n').filter((l) => /^(const|let|var|await|[a-zA-Z_$][\w$]*\()/.test(l));
    for (const l of topLevel) assert.ok(!/rconPassword\(|rconCommand\(|mkdirSync\(|connect\(|spawn\(/.test(l), `top-level side effect: ${l}`);
  });

  for (const args of [[], ['--phase', 'seed', '--out', 'OUT'], ['--fixture-lease'], ['--fixture-lease', '--phase', 'seed', '--out', 'OUT'], ['--fixture-lease', '../x;rm'], ['--fixture', '26.2']]) {
    it(`refuses without a valid lease: ${JSON.stringify(args)}`, () => {
      const out = mkdtempSync(join(tmpdir(), 'chunkbot-mem-guard-'));
      try {
        const before = listLive();
        const r = spawnSync(process.execPath, [SCRIPT, ...args.map((a) => (a === 'OUT' ? out : a))], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30_000 });
        assert.equal(r.status, 2, r.stderr);
        assert.match(r.stderr, /refusing to run: pass --fixture-lease/);
        assert.equal(r.stdout, '');
        assert.deepEqual(readdirSync(out), [], 'no phase output written');
        assert.deepEqual(listLive(), before, 'no live-check output directory created');
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    });
  }
});
