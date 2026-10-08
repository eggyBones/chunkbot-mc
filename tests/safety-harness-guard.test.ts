// MB-FLOW-003-C11/C13 harness safety: importing scripts/safety-live-check.ts
// runs nothing, and without a valid --fixture-lease it exits 2 before any
// password read, RCON command, join or output directory. Verified statically
// and by spawning it only with missing/invalid leases (never with a lease).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { SafetyTrialJournal, cleanupOnce, parseEntityTest, parseForceload, sameChunks } from '../src/safety/trial-journal.ts';
import { trialRcon } from '../src/safety/trial-rcon.ts';
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
    assert.ok(mainBody.indexOf('mkdirSync(') > leaseCheck);
    assert.ok(mainBody.search(/\brun\s*\(/) > leaseCheck, 'trial call only after lease refusal');
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
    assert.match(code, /this\.interventions\.push\(\{ atMs: Date\.now\(\), gate: phase, command \}\)/);
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

  it('importing the actual script creates no output and performs no trial', () => {
    const before = listLive();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(SCRIPT)})`], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.deepEqual(listLive(), before);
  });

  it('durable original settings, command intent and exact additions survive interruption before the reply', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chunkbot-safety-journal-'));
    try {
      const path = join(dir, 'restoration.json');
      const j = new SafetyTrialJournal(path);
      assert.throws(() => j.before('difficulty easy', 'setup'), /before original/);
      const original = { difficulty: 'peaceful', forceload: [{ cx: 15, cz: 12 }], forceloadReply: 'There is a force loaded chunk in dimension minecraft:overworld at: [15, 12]' };
      j.capture(original);
      original.difficulty = 'hard'; // caller mutation cannot alter the saved original
      const additions = [{ cx: 16, cz: 12 }];
      j.remember({ addedForceload: additions, backupTaken: true });
      const index = j.before('forceload add 256 192', 'setup');
      const interrupted = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(interrupted.original.difficulty, 'peaceful');
      assert.deepEqual(interrupted.original.forceload, [{ cx: 15, cz: 12 }]);
      assert.deepEqual(interrupted.state.addedForceload, additions, 'planned addition exists before any response');
      assert.equal(interrupted.commands[index].reply, undefined, 'ambiguous write retains its exact intent');
      j.after(index, 'added');
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).commands[index].reply, 'added');
      assert.throws(() => j.capture(original), /immutable/);
      assert.equal(sameChunks(interrupted.original.forceload, [{ cx: 15, cz: 12 }, ...additions]), false, 'final superset is not exact restoration');
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('forceload parsing refuses unreadable, truncated or duplicate provenance', () => {
    assert.deepEqual(parseForceload('No force loaded chunks were found in dimension minecraft:overworld'), []);
    assert.deepEqual(parseForceload('There is a force loaded chunk in dimension minecraft:overworld at: [15, 12]'), [{ cx: 15, cz: 12 }]);
    assert.deepEqual(parseForceload('There are 2 force loaded chunks in dimension minecraft:overworld at: [16, 12], [15, -1]'), [{ cx: 15, cz: -1 }, { cx: 16, cz: 12 }]);
    for (const reply of ['', 'error', 'There are 2 force loaded chunks at: [15, 12]', 'There are 2 force loaded chunks at: [15, 12], [15, 12]']) assert.equal(parseForceload(reply), undefined, reply);
  });

  it('unknown command errors never mean that an entity was defeated or removed', () => {
    assert.equal(parseEntityTest('Test passed, count: 1'), true);
    assert.equal(parseEntityTest('Test failed'), false);
    for (const reply of ['Command failed', 'No entity was found', '', '0', 'RCON error']) assert.equal(parseEntityTest(reply), undefined, reply);
  });

  it('signal and finally callers share the same cleanup settlement exactly once', async () => {
    let calls = 0;
    let finish!: () => void;
    const cleanup = cleanupOnce(async () => { calls += 1; await new Promise<void>((r) => { finish = r; }); });
    const fromSignal = cleanup();
    const fromFinally = cleanup();
    assert.equal(fromFinally, fromSignal);
    await Promise.resolve();
    assert.equal(calls, 1);
    finish();
    await fromSignal;
    await cleanup();
    assert.equal(calls, 1, 'later teardown is idempotent');
  });

  it('RCON deadline includes a silent connected peer and destroys its socket (dummy endpoint only)', async () => {
    const peers = new Set<Socket>();
    const server = createServer((socket) => { peers.add(socket); socket.on('data', () => undefined); socket.on('close', () => peers.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const at = Date.now();
      await assert.rejects(trialRcon('127.0.0.1', address.port, 'dummy-not-a-secret', 'difficulty', 100), /absolute deadline/);
      assert.ok(Date.now() - at < 1_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.equal(peers.size, 0, 'timeout closes the transport; no abandoned I/O');
      await assert.rejects(trialRcon('example.com', address.port, 'dummy', 'difficulty'), /loopback/);
    } finally { for (const peer of peers) peer.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it('RCON sends the command only after authenticated response and accepts fragmented replies (dummy endpoint)', async () => {
    const types: number[] = [];
    const peers = new Set<Socket>();
    const response = (id: number, type: number, body: string) => {
      const p = Buffer.alloc(Buffer.byteLength(body) + 14);
      p.writeInt32LE(p.length - 4, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); p.write(body, 12); return p;
    };
    const server = createServer((socket) => {
      peers.add(socket); socket.on('close', () => peers.delete(socket));
      let buffer = Buffer.alloc(0);
      socket.on('data', (bytes) => {
        buffer = Buffer.concat([buffer, bytes]);
        while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
          const size = buffer.readInt32LE(0); const type = buffer.readInt32LE(8); types.push(type);
          buffer = buffer.subarray(size + 4);
          const reply = type === 3 ? response(1, 2, '') : response(2, 0, 'The difficulty is Peaceful');
          socket.write(reply.subarray(0, 7)); setTimeout(() => socket.write(reply.subarray(7)), 10);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address === 'object');
      assert.equal(await trialRcon('127.0.0.1', address.port, 'dummy', 'difficulty'), 'The difficulty is Peaceful');
      assert.deepEqual(types, [3, 2], 'auth then command, exactly once each');
    } finally { for (const peer of peers) peer.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
