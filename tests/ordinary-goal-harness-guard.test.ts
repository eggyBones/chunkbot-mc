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
import { LAYOUT, currentMeleeDamage, fixtureEntityTest, onWaterBank, ordinaryDryBankSupport, questionLines, verifyOrdinaryContinuation } from '../scripts/ordinary-goal-live-check.ts';
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
    assert.ok(source.indexOf('if (!io) this.password = readRconPassword()') > source.indexOf('class Harness'));
    assert.ok(!/process\.kill\(|pkill|killall/.test(source), 'never signals anything but its own child');
    assert.ok(!/[`'"](gamerule\s+\w+\s+(?:true|false|\d+)|difficulty\s+(?:peaceful|easy|normal|hard)|time\s+(?:set|add)|weather\s+\w+|spawnpoint|setworldspawn)\b/.test(source), 'no settings or respawn changes; read-only preconditions are allowed');
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
    const points = [LAYOUT.chickenNear, LAYOUT.o2.near, LAYOUT.o2.far, LAYOUT.o2.cow, LAYOUT.houseOwner, LAYOUT.ownerDefault, ...LAYOUT.birchLogs, ...LAYOUT.oakTrees.flatMap((t) => [...t.logs]), ...LAYOUT.gather.trunks, { x: LAYOUT.gather.stone.x1, z: LAYOUT.gather.stone.z1 }, { x: LAYOUT.gather.stone.x2, z: LAYOUT.gather.stone.z2 }, LAYOUT.water.bot, LAYOUT.water.owner, LAYOUT.water.submerged, { x: LAYOUT.water.platform.x1, z: LAYOUT.water.platform.z1 }, { x: LAYOUT.water.platform.x2, z: LAYOUT.water.platform.z2 }];
    for (const p of points) assert.ok(inside(p), JSON.stringify(p));
    for (const p of [...LAYOUT.birchLogs]) assert.ok(p.y >= -60 && p.y <= -50);
    assert.ok(LAYOUT.birchLogs[0].y > -60, 'happy-path target remains floating');
    assert.ok(Math.abs(LAYOUT.birchLeaves.y + 0.5 - (-60 + 1.62)) < 4.5, 'lower canopy admits an eye-reach approach');
    assert.ok(Math.abs(LAYOUT.birchLeaves.y + 1.5 - (-60 + 1.62)) > 4.5, 'O3u canopy remains unreachable without climbing');
  });

  it('question detection on CLI output', () => {
    assert.deepEqual(questionLines(['[chunkbot] Question q1: Which tree? (reply: answer q1 <reply>)', '[chunkbot] Goal goal-1 accepted: "kill that chicken". Planning…', '[status] goal: x?']).length, 1);
    assert.equal(questionLines(['[chunkbot] Reply not applied: no question is pending']).length, 0);
  });

  it('entity disappearance requires a readable negative server reply', () => {
    assert.equal(fixtureEntityTest('Test passed. Count: 1'), true);
    assert.equal(fixtureEntityTest('Test passed, count: 2'), true);
    assert.equal(fixtureEntityTest('Test failed'), false);
    for (const reply of ['', 'No entity was found', 'Unknown command', 'Test passed. Count: 0']) assert.equal(fixtureEntityTest(reply), null);
  });

  it('water completion rejects a surface bob and requires a settled supported bank', () => {
    assert.equal(onWaterBank({ x: 207.5, y: -56, z: 206.5 }), false);
    assert.equal(onWaterBank({ x: 207.5, y: -55, z: 206.5 }), false);
    assert.equal(onWaterBank({ x: 211.5, y: -56, z: 206.5 }), true);
    assert.equal(onWaterBank({ x: 225.5, y: -56, z: 206.5 }), false);
    assert.equal(onWaterBank({ x: 211.5, y: -55, z: 206.5 }), false);
    assert.match(source, /episode released before reaching a dry bank/);
    assert.match(source, /server confirms dry stable support/);
    assert.match(source, /stays settled after controls release/);
    assert.match(source, /replacement episode cannot rescue premature release/);
  });

  it('defense staging binds fresh server damage to the actual victim and attacker before admission', () => {
    const hit = { entityId: 4, sourceCauseId: 9, atMs: 100 };
    assert.equal(currentMeleeDamage(hit, 4, 8, 101), true);
    assert.equal(currentMeleeDamage(hit, 5, 8, 101), false);
    assert.equal(currentMeleeDamage(hit, 4, 9, 101), false);
    assert.equal(currentMeleeDamage({ ...hit, sourceCauseId: 0 }, 4, 8, 101), false);
    assert.equal(currentMeleeDamage(hit, 4, 8, 99), false);
    assert.equal(currentMeleeDamage(hit, 4, 8, 6101), false);
    const staging = source.indexOf('await h.stageMeleeEngagement(tag, summon, ev)');
    assert.ok(staging > 0 && staging < source.indexOf("goal = await h.goal('follow me')", staging));
    assert.match(source, /id: 'O8A', armed: true, engaging: false/);
    assert.match(source, /NoAI:1b/);
    assert.ok(!source.slice(source.indexOf('async stageMeleeEngagement'), source.indexOf('async interruptByDeath')).includes('h.goal('));
  });

  it('water release requires actual ground, dry body/eyes and recovered air, followed by three seconds of support', () => {
    const bank = { x: 211.5, y: -56, z: 206.5 };
    const facts = { onGround: true, floor: 'solid', feet: 'air', eye: 'air' } as const;
    assert.equal(ordinaryDryBankSupport(bank, facts, 300), true);
    assert.equal(ordinaryDryBankSupport({ x: 207.5, y: -56, z: 206.5 }, facts, 300), false, 'pool surface bob is never shore');
    assert.equal(ordinaryDryBankSupport(bank, { ...facts, onGround: false }, 300), false, 'height alone is insufficient');
    assert.equal(ordinaryDryBankSupport(bank, { ...facts, floor: 'water' }, 300), false, 'deep water below is insufficient');
    assert.equal(ordinaryDryBankSupport(bank, { ...facts, feet: 'water' }, 300), false, 'this fixture requires dry shore, not a wading claim');
    assert.equal(ordinaryDryBankSupport(bank, { ...facts, eye: 'water' }, 300), false);
    for (const air of [null, 299, -1]) assert.equal(ordinaryDryBankSupport(bank, facts, air), false);
    assert.match(source, /this\.now\(\) - started >= 3_000 && samples\.length >= 4/);
    assert.match(source, /nbt=\{OnGround:1b\}/);
    assert.match(source, /await h\.waterExitSettled\(ev\)/);
  });

  it('P-SAFETY-R16 corrections stay scoped: strict O7W/O7F settle, fresh O7F staging, strict mob staging, unchanged O8N equality', () => {
    const body = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
    const o7w = body("scenarioRun('O7W'", "for (const mode of [");
    assert.match(o7w, /await h\.waterExitSettled\(ev\);/, 'O7W remains the strictly stationary no-memory/no-autonomy control');
    const o7f = body("scenarioRun('O7F'", "scenarioRun('O8C'");
    assert.match(o7f, /const end = await waterFinished\(episode, ev\);/, 'O7F (cue withdrawn) stays strictly settled');
    assert.ok(o7f.indexOf('freshFarCue(') > 0 && o7f.indexOf('freshFarCue(') < o7f.indexOf("h.goal('follow me')"), 'fresh far cue staging precedes admission');
    assert.ok(o7f.indexOf('const teleportStartedAtMs = Date.now();') < o7f.indexOf('await h.triggerTeleport(OWNER, LAYOUT.safety.farOwner'));
    assert.ok(!/waitForTruth\('fresh actionable far owner cue'/.test(o7f), 'the stale-accepting cue predicate is gone');
    for (const id of ['O7P', 'O7R']) assert.match(body(`scenarioRun('${id}'`, 'h.noQuestions('), /waterFinished\(episode, ev, \{ goalId: goal\.goalId, excludedLeaseIds: /);
    const o8c = body("scenarioRun('O8C'", "scenarioRun('O8N'");
    assert.match(o8c, /const staged = await h\.mobIdentity\('og_o8c', 'minecraft:creeper'\);/, 'creeper staging identity stays strict');
    const o8n = body("scenarioRun('O8N'", "scenarioRun('RC1'");
    assert.ok(o8n.indexOf('await h.fullStableHealth([BOT, OWNER], ev);') < o8n.indexOf('summon ${kind}'), 'natural health readiness precedes the actors');
    assert.match(o8n, /const cow = await h\.mobIdentity\('og_o8n_cow', 'minecraft:cow'\), wolf = await h\.mobIdentity\('og_o8n_wolf', 'minecraft:wolf'\);/, 'neutral staging identity stays strict');
    assert.match(o8n, /check\(health\.bot === 20 && health\.owner === 20, 'staging_unready: full stable control-player health required before the no-damage window'\);/);
    assert.ok(!/(instant_health|regeneration|saturation)[^\n]*\$\{OWNER\}|\$\{OWNER\}[^\n]*(instant_health|regeneration|saturation)/.test(source), 'the owner is never healed or fed');
    const reset = body('  async resetScene(): Promise<void> {', '  blockResetCommands(): string[] {');
    assert.ok(reset.indexOf('effect give ${OWNER} slow_falling 5 0 true') < reset.indexOf('this.blockResetCommands()'), 'owner protection precedes every fill');
  });

  it('ordinary recovery oracle permits separate support and rejects authority refills or task replay', () => {
    const semantic = { outcomeCanonical: 'original', admissionBaseline: { counts: { 'minecraft:oak_log': 8 } }, caps: { plannerTurnsPerGoal: 20 }, deadlineAtMs: 99 };
    const events = [
      { type: 'goal_admitted', goalId: 'goal-a', epoch: 1 },
      { type: 'goal_travel_anchor', goalId: 'goal-a', epoch: 1, admitted: true, anchor: { x: 205, y: -60, z: 205 }, radius: 128 },
      { type: 'task_admitted', goalId: 'goal-a', epoch: 1, taskId: 'task-old' },
      { type: 'continuation_checkpoint', goalId: 'goal-a', state: 'held', counters: { plannerTurns: 2 }, ...semantic },
      { type: 'goal_admitted', goalId: 'goal-recovery', epoch: 3, source: { kind: 'support' } },
      { type: 'goal_admitted', goalId: 'goal-a', epoch: 5, continuation: { number: 1, counters: { plannerTurns: 2 } } },
      { type: 'goal_travel_anchor', goalId: 'goal-a', epoch: 5, admitted: true, anchor: { x: 205, y: -60, z: 205 }, radius: 128 },
      { type: 'goal_continuation_bound', goalId: 'goal-a', epoch: 5, carriedTasks: 0, carriedHandles: 0, ...semantic },
      { type: 'task_admitted', goalId: 'goal-a', epoch: 5, taskId: 'task-fresh' },
    ];
    assert.equal(verifyOrdinaryContinuation(events, 'goal-a').admission.epoch, 5);
    assert.throws(() => verifyOrdinaryContinuation(events.map((e) => e.type === 'goal_continuation_bound' ? { ...e, deadlineAtMs: 199 } : e), 'goal-a'));
    assert.throws(() => verifyOrdinaryContinuation(events.map((e) => e.type === 'task_admitted' && e.epoch === 5 ? { ...e, taskId: 'task-old' } : e), 'goal-a'));
    assert.throws(() => verifyOrdinaryContinuation(events.map((e) => e.continuation ? { ...e, continuation: { number: 1, counters: { plannerTurns: 0 } } } : e), 'goal-a'));
    assert.throws(() => verifyOrdinaryContinuation(events.map((e) => e.type === 'goal_travel_anchor' && e.epoch === 5 ? { ...e, radius: 512 } : e), 'goal-a'));
  });
});
