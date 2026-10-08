// MB-FLOW-003-C11/C13 harness safety: importing scripts/safety-live-check.ts
// runs nothing, and without a valid --fixture-lease it exits 2 before any
// password read, RCON command, join or output directory. Verified statically
// and by spawning it only with missing/invalid leases (never with a lease).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';

const SCRIPT = join(PROJECT_ROOT, 'scripts', 'safety-live-check.ts');
const source = readFileSync(SCRIPT, 'utf8');
const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const liveDir = join(PROJECT_ROOT, 'var', 'live-check');
const listLive = () => (existsSync(liveDir) ? readdirSync(liveDir).sort() : []);

describe('safety gate harness guard', () => {
  it('is import-safe and the lease check precedes every fixture path', () => {
    const guard = source.indexOf('if (isEntryPoint(import.meta.url, process.argv[1])) {');
    assert.ok(guard > 0);
    const mainBody = source.slice(source.indexOf('async function main()'), guard);
    const leaseCheck = mainBody.indexOf("arg('--fixture-lease')");
    assert.ok(leaseCheck > 0);
    for (const later of ['mkdirSync(', 'run()']) assert.ok(mainBody.indexOf(later) > leaseCheck, `${later} only after the lease check`);
    const topLevel = source.split('\n').filter((l) => /^(const|let|var|await|[a-zA-Z_$][\w$]*\()/.test(l));
    for (const l of topLevel) assert.ok(!/readRconPassword\(|rconCommand\(|mkdirSync\(|connect\(|new Gate\(/.test(l), `top-level side effect: ${l}`);
    assert.ok(source.indexOf('this.password = readRconPassword()') > source.indexOf('class Gate'), 'password read only inside the Gate (created by run())');
  });

  it('footprint: every entity removal/effect is scoped to the owned volume and the per-run tag; restoration gates the report', () => {
    const selectors = [...code.matchAll(/@e\[([^\]]*)\]/g)].map((m) => m[1] as string);
    assert.ok(selectors.length > 0);
    for (const s of selectors) assert.match(s, /\$\{ENTITY_AREA\}/, `unscoped entity selector: @e[${s}]`);
    for (const s of [...code.matchAll(/kill @e\[([^\]]*)\]/g)].map((m) => m[1] as string)) assert.match(s, /tag=\$\{(MOB_TAG|tag|c)\}|type=(item|experience_orb)/, `kill must name the run tag or drops: ${s}`);
    assert.match(code, /const MOB_TAG = `cbsafe_/, 'unique per-run tag');
    assert.ok(!/gamerule /.test(code), 'no gamerule changes');
    assert.ok(!/time set /.test(code), 'no time changes');
    assert.ok(!/spawnpoint /.test(code), 'no spawnpoint change');
    assert.match(code, /if \(difficulty\.original === 'peaceful'\)/, 'difficulty is changed only from peaceful');
    assert.match(code, /id: 'RESTORE'/, 'restoration is a report result');
    assert.match(code, /restoreChecks\.every\(\(c\) => c\.ok\)/, 'any failed restoration fails the report');
    assert.match(code, /backup volume .* is not verified empty/, 'refuses to use a non-empty backup volume');
    assert.match(code, /addedForceload\.push/, 'only trial-added forceload chunks are tracked for removal');
    // Every fill/clone stays inside the declared scene/backup boxes.
    for (const m of code.matchAll(/`fill ([^`]*)`/g)) assert.match(m[1] as string, /^\$\{(AREA|POOL|BACKUP_BOX)|^\$\{BACKUP_BOX\}/, `fill outside the declared boxes: ${m[1]}`);
  });

  it('interventions are recorded per gate and labeled as never earning pass credit; difficulty is always verified', () => {
    assert.match(code, /this\.interventions\.push\(\{ atMs: Date\.now\(\), gate: this\.phase, command \}\)/);
    assert.match(code, /credit: 'module mechanics only; operator interventions/);
    assert.match(code, /standIn: 'safety owners run through a labeled pre-integration stand-in executor/);
    assert.match(code, /difficulty \$\{difficulty\.changed \? 'restored to' : 'unchanged at'\}/);
  });

  it('executor selection is never silent: real shared executor whenever the owner variant exists; stand-in labeled otherwise', () => {
    assert.match(code, /this\.executor === 'real' \? this\.goalExecutor\.execute/);
    assert.match(code, /readonly executor: 'real' \| 'stand_in' = realSafetyExecutorAvailable\(\) \? 'real' : 'stand_in'/);
    assert.match(code, /executor: g\.executor,/);
    const mainBody = source.slice(source.indexOf('async function main()'));
    assert.ok(mainBody.indexOf("'--require-real-executor'") < mainBody.indexOf('mkdirSync('), 'the real-executor requirement refuses before any output/fixture access');
  });

  it('W3 and M2b label their interventions; M2/M2b stage an already-engaging threat; unreadable evidence fails', () => {
    const w3 = code.slice(code.indexOf("g.gate('W3',"), code.indexOf("g.gate('M1',"));
    assert.match(w3, /INTERVENTION \(no credit\): water breathing/);
    assert.match(w3, /INTERVENTION \(no credit\): teleport rescue/);
    const m2 = code.slice(code.indexOf("g.gate('M2',"), code.indexOf("g.gate('M3',"));
    assert.equal((m2.match(/ev\.push\(await g\.engaged\(\)\)/g) ?? []).length, 2, 'M2 and M2b both stage engagement before admission');
    assert.match(m2, /INTERVENTION \(no credit\): operator \/damage/);
    assert.ok(!/!z1 \|\|/.test(code), 'missing server position is never a pass');
  });

  it('W1 forbids an RCON rescue: no teleport between admission and the W1 verdict', () => {
    const w1 = code.slice(code.indexOf("g.gate('W1',"), code.indexOf("g.gate('W1s',"));
    const admit = w1.indexOf('g.admit(');
    assert.ok(admit > 0);
    assert.ok(!/g\.tp\(|tp \$\{BOT\}/.test(w1.slice(admit)), 'no tp after admission in W1');
  });

  it('refuses without a lease or with an invalid one (exit 2, no output directory)', () => {
    const before = listLive();
    for (const args of [[], ['--fixture-lease'], ['--fixture-lease', '../evil'], ['--fixture-lease', 'x']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 2, `args ${JSON.stringify(args)}: ${r.stderr}`);
      assert.match(r.stderr, /refusing to run/);
    }
    assert.deepEqual(listLive(), before, 'no output directory created');
  });
});
