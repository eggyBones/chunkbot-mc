// MB-PLAN-006 ordinary-goal harness safety: importing it runs nothing, and
// without a valid --fixture-lease it exits 2 before any password read, RCON
// command, join, config write or output directory. Verified statically and by
// spawning it only with missing/invalid leases (never with a lease).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { LAYOUT, questionLines } from '../scripts/ordinary-goal-live-check.ts';
import { SCENE } from '../scripts/lib/scene.ts';

const SCRIPT = join(PROJECT_ROOT, 'scripts', 'ordinary-goal-live-check.ts');
const source = readFileSync(SCRIPT, 'utf8');
const liveDir = join(PROJECT_ROOT, 'var', 'live-check');
const listLive = () => (existsSync(liveDir) ? readdirSync(liveDir).filter((d) => d.endsWith('-ordinary-goals')).sort() : []);

describe('ordinary-goal live harness guard', () => {
  it('is import-safe and the lease check precedes every fixture path', () => {
    const guard = source.indexOf('if (isEntryPoint(import.meta.url, process.argv[1])) {');
    assert.ok(guard > 0);
    const mainBody = source.slice(source.indexOf('async function main()'), guard);
    const leaseCheck = mainBody.indexOf("arg('--fixture-lease')");
    assert.ok(leaseCheck > 0);
    for (const later of ['mkdirSync(', 'run(outDir']) assert.ok(mainBody.indexOf(later) > leaseCheck, `${later} only after the lease check`);
    const topLevel = source.split('\n').filter((l) => /^(const|let|var|await|[a-zA-Z_$][\w$]*\()/.test(l));
    for (const l of topLevel) assert.ok(!/readRconPassword\(|rconCommand\(|mkdirSync\(|writeFileSync\(|createBot\(|new Harness\(|new CliProcess\(/.test(l), `top-level side effect: ${l}`);
    assert.ok(source.indexOf('this.password = readRconPassword()') > source.indexOf('class Harness'));
    assert.ok(!/process\.kill\(|pkill|killall/.test(source), 'never signals anything but its own child');
    assert.ok(!/[`'"](gamerule|difficulty|time set|weather)\b/.test(source), 'no settings changes');
  });

  it('refuses to run without a valid lease (exit 2, no report directory)', () => {
    const before = listLive();
    for (const args of [[], ['--fixture-lease'], ['--fixture-lease', '../evil'], ['--fixture-lease', '']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 2, `args ${JSON.stringify(args)}: ${r.stderr}`);
      assert.match(r.stderr, /refusing to run: pass --fixture-lease/);
    }
    assert.deepEqual(listLive(), before);
  });

  it('declared geometry stays inside the reset footprint', () => {
    const inside = (p: { x: number; z: number }) => p.x >= SCENE.area.x1 && p.x <= SCENE.area.x2 && p.z >= SCENE.area.z1 && p.z <= SCENE.area.z2;
    const points = [LAYOUT.chickenNear, LAYOUT.o2.near, LAYOUT.o2.far, LAYOUT.o2.cow, LAYOUT.houseOwner, LAYOUT.ownerDefault, ...LAYOUT.birchLogs, ...LAYOUT.oakTrees.flatMap((t) => [...t.logs])];
    for (const p of points) assert.ok(inside(p), JSON.stringify(p));
    for (const p of [...LAYOUT.birchLogs]) assert.ok(p.y >= -60 && p.y <= -50);
  });

  it('question detection on CLI output', () => {
    assert.deepEqual(questionLines(['[chunkbot] Question q1: Which tree? (reply: answer q1 <reply>)', '[chunkbot] Goal goal-1 accepted: "kill that chicken". Planning…', '[status] goal: x?']).length, 1);
    assert.equal(questionLines(['[chunkbot] Reply not applied: no question is pending']).length, 0);
  });
});
