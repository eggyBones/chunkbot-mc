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
import { clockRestoreTarget, deltaMismatches, parseClockReply, parseClockSetReply, parseDifficultyReply, parseRuleReply, parseTimelineReply } from '../scripts/survival-live-check.ts';

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

  it('C6 follow-up assertions are present (not logged only)', () => {
    assert.match(source, /check\('error' in before && before\.error === 'attempt_write_pending'/, 'G2 asserts NOT authorized before the save');
    assert.match(source, /equals RCON LastDeathLocation/, 'G1 compares the captured GlobalPos with RCON LastDeathLocation');
    assert.match(source, /wrong-identity foreign sword is still on the ground/, 'G2 proves the wrong-identity sword was not collected');
    // C10: absolute counts were contaminated by respawn-point pickups; the oracle is the delta since a pre-recovery baseline.
    assert.match(source, /g\.baseline = await g\.inventoryCounts\(\)/, 'G2 records the RCON baseline before admission');
    assert.match(source, /deltaMismatches\(base, counts, acc\.regained, acc\.duringAttempt\)/, 'every server change must be regained or reported incidental');
    assert.match(source, /full recovery requires the server to gain exactly the lost kit since the pre-recovery baseline/, 'G2b requires the full kit as a delta');
    assert.match(source, /pre-recovery inventory equals the reported after-respawn-sync incidental effects/, 'respawn-point pickups must be reported, never retained/regained');
    assert.match(source, /recovered\.status === 'satisfied' && inc\?\.status === 'recovered'/, 'G2b requires recovered status');
    assert.match(source, /onDisk\.revision >= current\.revision/, 'stand-in durability compares exact fact revisions');
    assert.match(source, /factDurability\?: \(id: string\) => unknown/, 'prefers the integrated canonical durability string');
  });

  it('C8: settings use the 26.1.2/26.2 command names (official reports), record query replies, compare dimensions canonically', () => {
    const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.match(code, /const RULE_KEEP = 'keep_inventory';/);
    assert.match(code, /const RULE_REGEN = 'natural_health_regeneration';/);
    assert.match(code, /const TIME_QUERY = 'time query time';/);
    for (const legacy of [/gamerule keepInventory/, /gamerule naturalRegeneration/, /time query daytime/]) assert.ok(!legacy.test(code), `legacy command in use: ${legacy}`);
    for (const cmd of [...code.matchAll(/gamerule \$\{(\w+)\}/g)].map((m) => m[1])) assert.ok(cmd === 'RULE_KEEP' || cmd === 'RULE_REGEN', `unexpected gamerule ${cmd}`);
    assert.ok(!/TIME_REPLY|The time is \(\\d\+\)\/;/.test(code), 'the legacy-only TIME_REPLY parser is gone');
    assert.match(code, /parseClockReply\(await g\.rcon\(TIME_QUERY\)\)/, 'clock reads are recorded rcon calls parsed with the official forms');
    assert.match(code, /time of \$\{clockId\} set \$\{clockTarget\}/, 'the clock is restored through the absolute per-clock setter');
    assert.match(code, /% DAY_TICKS/, 'day/night checks use the time of day, not the absolute clock');
    assert.match(code, /check\(difficulty && keep && regen && clock0 && clock1 && clockId/, 'every original is read before any setting write');
    assert.match(code, /sameDimension\(dim, d\.site\.dimension\)/, 'G1 compares RCON and capture dimensions canonically (C7)');
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

  it('C8: the official 26.1.2/26.2 reply forms parse (trial 2 reply verbatim), others are refused', () => {
    assert.deepEqual(parseClockReply('Clock minecraft:overworld is at 3466899 tick(s)'), { clock: 'minecraft:overworld', ticks: 3466899 });
    assert.deepEqual(parseClockReply('The time is 6000'), { ticks: 6000 });
    assert.equal(parseClockReply('Unknown or incomplete command, see below for error'), undefined);
    assert.equal(parseClockReply('Clock minecraft:overworld is at many tick(s)'), undefined);
    assert.equal(parseTimelineReply('Timeline minecraft:day is at 4899 tick(s)', 'minecraft:day'), 4899);
    assert.equal(parseTimelineReply('Timeline minecraft:moon is at 4899 tick(s)', 'minecraft:day'), undefined, 'only the named timeline');
    assert.deepEqual(parseClockSetReply('Set minecraft:overworld to 3467999 tick(s)'), { clock: 'minecraft:overworld', ticks: 3467999 });
    assert.deepEqual(parseClockSetReply('Set the time to 1000'), { ticks: 1000 });
    assert.equal(parseClockSetReply('Set minecraft:overworld to time marker minecraft:day'), undefined, 'a marker set is not an absolute restoration');
    assert.equal(parseRuleReply('Gamerule keep_inventory is currently set to: false', 'keep_inventory'), 'false');
    assert.equal(parseRuleReply('Gamerule natural_health_regeneration is currently set to: true', 'keep_inventory'), undefined, 'the reply must name the queried rule');
    assert.equal(parseDifficultyReply('The difficulty is Peaceful'), 'peaceful');
  });

  it('C8: clock restoration advances the original by the MEASURED rate (no rewind, no skip); a paused clock is restored exactly', () => {
    const original = { ticks: 3466899, atMs: 1_000_000, ticksPerMs: 0.02 };
    assert.equal(clockRestoreTarget(original, 1_000_000 + 45_000), 3466899 + 900);
    assert.equal(clockRestoreTarget({ ...original, ticksPerMs: 0 }, 1_000_000 + 45_000), 3466899);
    assert.equal(clockRestoreTarget(original, 999_000), 3466899, 'never earlier than the original');
  });

  it('C10: the delta oracle reproduces the batch002-2472442 report as a mismatch and accepts truthful accounting', () => {
    // Trial 2: RCON bread 5 / cobblestone 84 at the end; survival counted cobblestone 20 and reported nothing else.
    const legacyBaseline = { bread: 0, cobblestone: 0, iron_pickaxe: 0, diamond_sword: 0, dirt: 0 };
    const end = { bread: 5, cobblestone: 84, iron_pickaxe: 0, diamond_sword: 0, dirt: 0 };
    assert.deepEqual(deltaMismatches(legacyBaseline, end, { cobblestone: 20 }, {}), ['bread: server delta 5 != regained 0 + incidental 0', 'cobblestone: server delta 84 != regained 20 + incidental 0']);
    // Corrected: the respawn-point pickups are in the pre-recovery baseline; the recovery delta is exactly what was counted.
    assert.deepEqual(deltaMismatches({ ...legacyBaseline, bread: 5, cobblestone: 64 }, end, { cobblestone: 20 }, {}), []);
    // An unplanned collect during the attempt must be reported as incidental to balance.
    assert.deepEqual(deltaMismatches({ dirt: 0 }, { dirt: 3 }, {}, { dirt: 3 }), []);
  });
});
