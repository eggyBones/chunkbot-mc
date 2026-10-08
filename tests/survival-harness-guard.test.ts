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
import { PHYSIOLOGY_ENCLOSURE, assertPhysiologyLife, physiologyEnclosureEmpty, physiologyEnclosurePlan, deltaMismatches, parseClockReply, parseClockSetReply, parseDifficultyReply, parseRuleReply, parseTimelineReply } from '../scripts/survival-live-check.ts';

const SCRIPT = join(PROJECT_ROOT, 'scripts', 'survival-live-check.ts');
const source = readFileSync(SCRIPT, 'utf8');
const liveDir = join(PROJECT_ROOT, 'var', 'live-check');
const listLive = () => (existsSync(liveDir) ? readdirSync(liveDir).sort() : []);

describe('survival gate harness guard', () => {
  it('R4: G3 enclosure is sealed, transparent and lighted entirely inside the unchanged restored scene', () => {
    const p = physiologyEnclosurePlan();
    const blocks = new Map<string, string>();
    // Apply the emitted standard fill commands to an independent voxel model, checking EVERY boundary voxel.
    for (const command of p.writes) {
      const m = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (glass|sea_lantern)( hollow)?$/.exec(command);
      assert.ok(m, `only bounded block fills: ${command}`);
      const [x1, y1, z1, x2, y2, z2] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
      assert.ok(x1 >= 196 && x2 <= 224 && z1 >= 190 && z2 <= 224 && y1 >= -61 && y2 <= -50);
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) {
        const shell = x === x1 || x === x2 || y === y1 || y === y2 || z === z1 || z === z2;
        blocks.set(`${x},${y},${z}`, m[8] && !shell ? 'air' : m[7]!);
      }
    }
    const b = PHYSIOLOGY_ENCLOSURE;
    for (let x = b.x1; x <= b.x2; x++) for (let y = b.y1; y <= b.y2; y++) for (let z = b.z1; z <= b.z2; z++) {
      const key = `${x},${y},${z}`;
      if (y === b.y1) assert.equal(blocks.get(key), 'sea_lantern', `lighted floor at ${key}`);
      else if (x === b.x1 || x === b.x2 || z === b.z1 || z === b.z2 || y === b.y2) assert.equal(blocks.get(key), 'glass', `sealed transparent boundary at ${key}`);
      else assert.equal(blocks.get(key), 'air', `interior at ${key}`);
    }
    assert.equal(blocks.get('205,-60,205'), 'air');
    assert.equal(blocks.get('205,-59,205'), 'air', 'bot has standing clearance');
    // Exterior positions stay outside the EXISTING 8-block visible-threat guard at START (not relaxed).
    assert.ok(Math.min(205.5 - b.x1, b.x2 + 1 - 205.5, 205.5 - b.z1, b.z2 + 1 - 205.5, b.y2 + 1 + 60) > 8);
    assert.match(source, /await g\.enclosePhysiology\(ev\)/);
    assert.match(source, /scene restored from backup/, 'same existing clone restoration remains mandatory');
  });

  it('R4: existing enclosure occupants and uncertain replies never pass preflight', () => {
    assert.equal(physiologyEnclosureEmpty('Test failed'), true);
    assert.equal(physiologyEnclosureEmpty('Test failed. Count: 0'), true);
    for (const reply of ['Test passed', 'Test passed. Count: 10', 'Test passed. Count: 20', 'Unknown command at position 0', '', 'No entity found']) assert.equal(physiologyEnclosureEmpty(reply), false, reply);
  });

  it('R4: G3 death/automatic respawn is a staging interruption with its actual cause, never a food timeout or pass', () => {
    assert.doesNotThrow(() => assertPhysiologyLife('dcap-1-2', { captureId: 'dcap-1-2', life: 'alive', health: 7 }));
    for (const life of ['dead', 'respawned_awaiting_sync', 'alive']) {
      assert.throws(() => assertPhysiologyLife('dcap-1-2', { captureId: 'dcap-1-3', life, health: life === 'alive' ? 20 : 0, cause: 'death.attack.mob' }), /physiology_staging_interrupted:.*death\.attack\.mob/);
    }
    assert.throws(() => assertPhysiologyLife(undefined, { life: 'alive' }), /physiology_staging_interrupted/);
    assert.match(source, /40_000, sameLife/, 'food staging checks life every poll');
  });
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

  it('leased default: NO bed interaction, NO respawn-point mutation, NO clock write; G4/G4n always SKIPPED with the R8 reason', () => {
    const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // Official 26.1.2/26.2 command reports DO contain `spawnpoint`; bed use changes the respawn point without it.
    for (const banned of [/spawnpoint/, /setworldspawn/, /_bed\b/, /'interact_block'/, /setblock /, /time set /, /time of /, /time add /, /sleeping_pos/]) assert.ok(!banned.test(code), `forbidden in the leased default: ${banned}`);
    assert.match(code, /for \(const \[id, title\] of \[\['G4', 'R8 day bed observation'\], \['G4n', 'R8 night bed observation'\]\] as const\) g\.skip\(id, title, BED_SKIP_REASON\);/, 'G4/G4n are reported SKIPPED in every run');
    assert.match(code, /const BED_SKIP_REASON = 'not run under this lease: bed interaction changes the fixture bot\\'s respawn point/, 'the concrete unassigned R8/respawn-restoration reason');
    // Settings restoration covers exactly what --with-settings writes.
    const writes = [...code.matchAll(/g\.rcon\(`(difficulty|gamerule) ([^`]*)`\)/g)].map((m) => `${m[1]} ${m[2]}`);
    for (const w of writes) assert.ok(/^difficulty (easy|\$\{difficulty\})$|^gamerule \$\{RULE_(KEEP|REGEN)\}( (true|false|\$\{(keep|regen)\}))?$/.test(w), `unexpected settings command ${w}`);
    for (const what of ["what: 'difficulty'", 'what: RULE_KEEP', 'what: RULE_REGEN']) assert.ok(code.includes(what), `restoration entry ${what}`);
  });

  it('G3 (trial 8e87ec3 finding T1): decisions record server vitals + cutoffs; staged preconditions are asserted; one computed damage, no rescue damage', () => {
    const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const label of ['(a) ordinary hunger decision', '(b1) health-support decision', '(b2) low-health decision']) assert.ok(code.includes(`g.decisionLine('${label}', d)`), `decision evidence for ${label}`);
    assert.match(code, /server health=\$\{v\?\.health \?\? 'unknown'\} food=\$\{v\?\.food \?\? 'unknown'\}/, 'decision lines carry server health and food');
    assert.match(code, /cutoffs lowHealth=\$\{this\.lowHealth\} restAtOrBelow=/, 'decision lines carry every cutoff');
    assert.match(code, /staged precondition holds at the decision \(server health \$\{v1\?\.health\} <= \$\{cfg\.health\.restAtOrBelow\}/, 'b1 precondition is checked, not assumed');
    assert.match(code, /staged precondition holds at the decision \(server health \$\{v2\?\.health\} <= lowHealth \$\{g\.lowHealth\}/, 'b2 precondition is checked, not assumed');
    const g3 = code.slice(code.indexOf("await g.gate('G3'"), code.indexOf("await g.gate('G3'") + 9_000);
    assert.equal([...g3.matchAll(/damage \$\{BOT\}/g)].length, 3, 'exactly three damage commands in G3: b1 staging, b2 single computed damage, regen-off trial');
    assert.match(g3, /damage \$\{BOT\} \$\{Math\.round\(\(hBefore - 7\) \* 100\) \/ 100\} minecraft:generic/, 'b2 uses ONE computed damage to health 7');
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
