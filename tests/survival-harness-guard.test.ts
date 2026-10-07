// MB-FLOW-003 gate harness safety: importing scripts/survival-live-check.ts runs
// nothing, and without a valid --fixture-lease it exits 2 before any password
// read, RCON command, join or output directory. Verified statically and by
// spawning it only with missing/invalid leases (never with a lease).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';

const SCRIPT = join(PROJECT_ROOT, 'scripts', 'survival-live-check.ts');
const source = readFileSync(SCRIPT, 'utf8');
const liveDir = join(PROJECT_ROOT, 'var', 'live-check');
const listLive = () => (existsSync(liveDir) ? readdirSync(liveDir).sort() : []);

describe('survival gate harness guard', () => {
  it('is import-safe and the lease check precedes every fixture path', () => {
    const guard = source.indexOf('if (isEntryPoint(import.meta.url, process.argv[1])) {');
    assert.ok(guard > 0);
    const code = source.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const calls = code.filter(({ l }) => /(^|[^\w.])main\(\)/.test(l) && !/function main\(/.test(l));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.i > source.slice(0, guard).split('\n').length - 1);
    const mainBody = source.slice(source.indexOf('async function main()'), guard);
    const leaseCheck = mainBody.indexOf("arg('--fixture-lease')");
    assert.ok(leaseCheck > 0);
    for (const later of ['mkdirSync(', 'run(outDir']) assert.ok(mainBody.indexOf(later) > leaseCheck, `${later} only after the lease check`);
    const topLevel = source.split('\n').filter((l) => /^(const|let|var|await|[a-zA-Z_$][\w$]*\()/.test(l));
    for (const l of topLevel) assert.ok(!/readRconPassword\(|rconCommand\(|mkdirSync\(|connect\(|new Gate\(/.test(l), `top-level side effect: ${l}`);
    // The password is read only inside the Gate constructor (created by run(), after the lease check).
    assert.ok(source.indexOf('this.password = readRconPassword()') > source.indexOf('class Gate'));
  });

  it('C6 footprint: every entity removal is scoped to the owned volume; no spawnpoint change; restoration gates the report', () => {
    const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const kills = [...code.matchAll(/kill @e\[([^\]]*)\]/g)].map((m) => m[1] as string);
    assert.ok(kills.length > 0);
    for (const k of kills) assert.match(k, /\$\{ITEM_AREA\}/, `unscoped entity removal: kill @e[${k}]`);
    assert.ok(!/spawnpoint /.test(code), 'no spawnpoint command');
    assert.ok(!/y=-64/.test(code) && !/dy=40/.test(code), 'no selector beyond the declared y range');
    assert.match(code, /const ITEM_AREA = `x=\$\{AREA\.x1\},y=\$\{SCENE_Y\.y1\}/);
    assert.match(code, /const FOREIGN_TAG = `cbsurv_/, 'unique per-run foreign tag');
    assert.ok(!/chunkbot_foreign/.test(code), 'no shared global foreign tag');
    assert.match(code, /id: 'RESTORE'/, 'restoration is a report result');
    assert.match(code, /restoreChecks\.every\(\(c\) => c\.ok\)/, 'any failed restoration fails the report');
    assert.match(code, /backup volume .* is not verified empty/, 'refuses to use a non-empty backup volume');
    assert.match(code, /addedForceload\.push/, 'only trial-added forceload chunks are tracked for removal');
  });

  for (const args of [[], ['--fixture-lease'], ['--fixture-lease', '../x;rm'], ['--with-settings'], ['--fixture', '26.2']]) {
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
