// MB-FLOW-001 live harness safety: importing scripts/autonomy-live-check.ts runs
// nothing, and without a valid --fixture-lease it exits 2 before any password
// read, RCON command, join, config write or output directory. Verified
// statically and by spawning it only with missing/invalid leases (never with a lease).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { parseForceloadQuery } from '../scripts/autonomy-live-check.ts';

const SCRIPT = join(PROJECT_ROOT, 'scripts', 'autonomy-live-check.ts');
const source = readFileSync(SCRIPT, 'utf8');
const liveDir = join(PROJECT_ROOT, 'var', 'live-check');
const listLive = () => (existsSync(liveDir) ? readdirSync(liveDir).sort() : []);

describe('autonomy live harness guard', () => {
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
    for (const l of topLevel) assert.ok(!/readRconPassword\(|rconCommand\(|mkdirSync\(|writeFileSync\(|createBot\(|new Harness\(|new CliProcess\(|startJev\(/.test(l), `top-level side effect: ${l}`);
    // The password is read only inside the Harness constructor (created by run(), after the lease check).
    assert.ok(source.indexOf('this.password = readRconPassword()') > source.indexOf('class Harness'));
    // It drives the CLI WITH autonomy (never --no-autonomy) and never signals anything but its own child.
    assert.ok(!/'--no-autonomy'/.test(source));
    assert.ok(!/process\.kill\(|pkill|killall/.test(source));
  });

  it('P-C8: records forceload before any change, removes only its additions, awaits its own child after SIGKILL, and fails on unreconciled cleanup', () => {
    const run = source.slice(source.indexOf('async function run('));
    assert.ok(run.indexOf('await h.recordForceload()') > 0 && run.indexOf('await h.recordForceload()') < run.indexOf("h.scenarioRun('U0'"), 'forceload recorded before the first scenario');
    assert.ok(source.includes("check(this.forceloadBefore, 'the forceloaded set must be recorded before the first forceload change')"));
    assert.ok(/const added = AREA_CHUNKS\.filter\(\(c\) => !before\.has\(c\)\)/.test(source), 'only newly added area chunks are removed');
    assert.ok(/killed = p\.child\.kill\('SIGKILL'\);\s*exited = await Promise\.race\(\[p\.exited/.test(source), 'child exit awaited after SIGKILL');
    assert.ok(source.includes('pass: scenariosPass && cleanupFailures.length === 0'), 'cleanup gates pass and exit');
    assert.ok(!/catch \{\s*\/\/ best effort/.test(source), 'no silent best-effort cleanup');
    assert.ok(source.includes("const ITEM_AREA = `x=${AREA.x1},y=-64,z=${AREA.z1},dx=${AREA.x2 - AREA.x1},dy=40,dz=${AREA.z2 - AREA.z1}`"), 'entity box is the documented y -64..-24 box');
    for (const kill of source.match(/kill @e\[[^\]]*\]/g) ?? []) assert.ok(kill.includes('${ITEM_AREA}'), `kill stays inside the reviewed entity box: ${kill}`);
  });

  it('parses forceload query replies; unrecognized replies fail closed', () => {
    assert.deepEqual([...parseForceloadQuery('No force loaded chunks were found in minecraft:overworld')!], []);
    assert.deepEqual([...parseForceloadQuery('A force loaded chunk was found in minecraft:overworld at: [12, 11]')!], ['12,11']);
    assert.deepEqual([...parseForceloadQuery('2 force loaded chunks were found in minecraft:overworld at: [12, 11], [-3, 14]')!].sort(), ['-3,14', '12,11']);
    assert.equal(parseForceloadQuery('Unknown or incomplete command'), null);
    assert.equal(parseForceloadQuery(''), null);
  });

  for (const args of [[], ['--fixture-lease'], ['--fixture-lease', '../x;rm'], ['--fixture', '26.2']]) {
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
