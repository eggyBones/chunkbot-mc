// MB-LOC-002: the ordinary-pipeline locator harness is import-safe, refuses to
// touch a fixture without an explicit lease, stays inside its declared
// footprint (disjoint from every other harness scene), never writes blocks, and
// its scripted planner turns are valid application wire output. Its privacy
// helper detects hidden owner coordinates in model-visible text.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { PlannerProposalSchema } from '../src/contracts/planner.ts';
import { proposalFromWire } from '../src/planner/wire.ts';
import { setFaultTurns, writeFaultCodex } from '../scripts/lib/fault-codex.ts';

const liveDir = join(PROJECT_ROOT, 'var', 'live-check');
const listLive = () => (existsSync(liveDir) ? readdirSync(liveDir).sort() : []);
const before = listLive();
const harness = await import('../scripts/locator-ordinary-live-check.ts');
const gates = await import('../scripts/locator-live-check.ts');

const SCRIPT = join(PROJECT_ROOT, 'scripts', 'locator-ordinary-live-check.ts');
const source = readFileSync(SCRIPT, 'utf8');
const code = source
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

const overlaps = (a: { x1: number; x2: number; z1: number; z2: number }, b: { x1: number; x2: number; z1: number; z2: number }) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.z1 <= b.z2 && b.z1 <= a.z2;

describe('MB-LOC-002 ordinary harness guard', () => {
  it('importing creates no output and starts nothing; main() only behind the entry-point guard; lease check before run()', () => {
    assert.deepEqual(listLive(), before);
    const guard = source.indexOf('if (isEntryPoint(import.meta.url, process.argv[1])) {');
    assert.ok(guard > 0);
    const lines = source.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const calls = lines.filter(({ l }) => /(^|[^\w.])main\(/.test(l) && !/function main\(/.test(l));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.i > source.slice(0, guard).split('\n').length - 1);
    const mainBody = source.slice(source.indexOf('async function main('), guard);
    assert.ok(mainBody.indexOf("argOf(argv, '--fixture-lease')") > 0 && mainBody.indexOf('run(argv, lease)') > mainBody.indexOf("argOf(argv, '--fixture-lease')"));
    const topLevel = source.split('\n').filter((l) => /^(const|let|var|await|[a-zA-Z_$][\w$]*\()/.test(l));
    for (const l of topLevel) assert.ok(!/readFileSync\(|rconCommand\(|mkdirSync\(|createBot\(|createServer\(|spawn|import\(/.test(l), `top-level side effect: ${l}`);
    const runBody = source.slice(source.indexOf('async function run('), source.indexOf('async function main('));
    assert.ok(runBody.indexOf("await import('../src/app/fixture-layout.ts')") < runBody.indexOf('readFileSync(fx.properties'));
    assert.ok(/finally \{[\s\S]*zero final players/.test(runBody), 'restorations and zero-player verification run in finally');
    assert.ok(runBody.indexOf('base.bot.trustedOfflineFixture === true') < runBody.indexOf('readFileSync(fx.properties'), 'exact loopback/offline profile checked before credential reads');
  });

  for (const args of [[], ['--fixture', '26.2'], ['--fixture-lease'], ['--fixture-lease', '../x;rm'], ['--only', 'O1']]) {
    it(`refuses without a valid lease: ${JSON.stringify(args)}`, () => {
      const prior = listLive();
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /refusing to run: pass --fixture-lease/);
      assert.equal(r.stdout, '');
      assert.deepEqual(listLive(), prior, 'no output directory created');
    });
  }
  it('rejects an unsupported fixture profile before password/output/join even with a syntactically valid lease', () => {
    const prior = listLive();
    const r = spawnSync(process.execPath, [SCRIPT, '--fixture-lease', 'guard-profile-only', '--fixture', '26.3'], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /unknown fixture profile/);
    assert.equal(r.stdout, '');
    assert.deepEqual(listLive(), prior);
  });
});

describe('MB-LOC-002 ordinary harness footprint', () => {
  const F = harness.ORDINARY_FOOTPRINT;
  it('every teleport destination is inside the declared footprint and the bot envelope', () => {
    for (const [k, v] of Object.entries(harness.ORD_TELEPORTS)) {
      assert.ok(gates.insideBox(F.overworldTeleports, v), k);
      assert.ok(gates.insideBox(F.botEnvelope, v), k);
    }
    assert.ok(gates.insideBox(F.netherTeleports, harness.NETHER_ROOF));
  });

  it('the footprint is disjoint from the skills scene and the reviewed locator gate footprint', () => {
    const skillsScene = { x1: 196, x2: 224, z1: 190, z2: 224 };
    assert.ok(!overlaps(F.botEnvelope, skillsScene));
    for (const box of Object.values(gates.LOCATOR_FOOTPRINT)) assert.ok(!overlaps(F.botEnvelope, box) || box === gates.LOCATOR_FOOTPRINT.netherTeleports);
  });

  it('far scenarios are beyond the 128-block admission radius and the 32-block sight; teleports only via checked helpers; no block writes', () => {
    for (const k of ['ownerFarEast', 'ownerFarWest', 'ownerFarSouthWest', 'ownerFarNorth'] as const) {
      const v = harness.ORD_TELEPORTS[k]!;
      assert.ok(Math.hypot(v.x - harness.ORD_BASE.x, v.z - harness.ORD_BASE.z) > 160, k);
    }
    const rawTp = code.split('\n').filter((l) => /run tp |`tp /.test(l));
    assert.equal(rawTp.length, 4, rawTp.join('\n')); // nether + named destination + owner step + final restore of the recorded start
    assert.ok(!/\b(fill|setblock|clone|gamerule|attribute|difficulty|summon|kill)\b/.test(code.replace(/killed|kill\(|SIGKILL/g, '')), 'no world/settings writes');
  });
});

describe('MB-LOC-002 ordinary harness scripted planner turns and privacy helper', () => {
  it('the scripted follow / come-here / blocked turns are valid planner wire output for the application', () => {
    for (const p of [harness.followMe(), harness.comeHere(), harness.blockedTurn('fixture')]) {
      const proposal = proposalFromWire(p);
      assert.ok(PlannerProposalSchema.safeParse(proposal).success, JSON.stringify(proposal).slice(0, 200));
    }
    const follow = proposalFromWire(harness.followMe());
    assert.equal(follow.disposition, 'plan');
    if (follow.disposition === 'plan') {
      assert.deepEqual(follow.tasks[0]!.allowedCapabilities, ['follow_entity', 'move_near', 'seek_owner']);
      assert.equal(follow.outcome.kind, 'persistent');
    }
  });

  it('wires complete action intervals and strict parsed privacy provenance into the actual ordinary scenarios', () => {
    assert.match(code, /reacquisitionProof\(events\(\), observations,/);
    assert.match(code, /turnsAfter === turnsBefore/);
    assert.match(code, /verifiedHistory\(observations, ownerIdentity\)/);
    assert.match(code, /privacyOracle\(input,/);
    assert.match(code, /parsePlannerInput\(text\)/);
    assert.ok(!/leaksCoordinate|Number\.NaN|const probe =|const near =/.test(code), 'no blanket coordinate/axis exemption');
    assert.match(code, /appendFileSync\(join\(outDir, 'jev-requests.jsonl'\)/);
    assert.match(code, /cli\.send\('\/diag observe'\)/);
    assert.ok(!/cli\.send\('\/diag (?:run|do)/.test(code), 'observations do not control gameplay');
  });
  it('brackets the real read-only diagnostic with retained server point/UUID/dimension reads and response time', () => {
    const capture = code.slice(code.indexOf('const observe = async'), code.indexOf('const sampleUntil = async'));
    assert.ok(capture.indexOf('const before = await ownerServerRead()') < capture.indexOf("cli.send('/diag observe')"));
    assert.ok(capture.indexOf('const after = await ownerServerRead()') > capture.indexOf('const line = await lineSince('));
    assert.match(capture, /receivedAtMs: line\.atMs/);
    assert.match(capture, /connectionEpochBefore: readyBefore/);
    assert.match(capture, /connectionEpochAfter: readyAfter/);
    assert.match(capture, /appendFileSync\(join\(outDir, 'observations.jsonl'\)/);
    assert.match(code, /parseOwnerServerRead\(OWNER, \{ position, uuid, dimension \}/);
    assert.match(code, /uuid: offlinePlayerUuid\(OWNER\)/);
    assert.match(code, /retainedLH9Failure:/);
  });
  it('preserves first-option Jev, the finite completion bound, and genuine reconnect plus ready no-op control', () => {
    assert.match(code, /const pick = keys\[0\]/);
    assert.match(code, /within: 3/);
    assert.match(code, /replacement finite goal did not become terminal within the unchanged 240s bound/);
    assert.match(code, /already ready/);
    assert.match(code, /rcon\(`kick \$\{BOT\} locator-ordinary-owned-disconnect`\)/);
    assert.match(code, /reconnectProblems\(events\(\),/);
    assert.match(code, /noCue\.directive\.autonomy\.locator\.actionable === false/);
    assert.match(code, /assert\(freshCue,/);
  });
  it('requires actual snapshot time/scope, retains independent server reads and scans all visible-request fields', () => {
    assert.match(code, /visibleOwnerConsistency\(obs, observations,/);
    assert.match(code, /takenAtMs: binding\?\.snapshotTakenAtMs/);
    assert.match(code, /visibilityCapture\?\.reads/);
    assert.match(code, /retainedLH11Failure:/);
    const visible = code.slice(code.indexOf('if (obs.owner?.visible === true)'), code.indexOf('for (const hit of result.findings)'));
    assert.ok(!/\breturn\s*;/.test(visible), 'a visible flag cannot exempt the rest of a model request');
    assert.match(visible, /owner: sample\.owner \?\? owner/, 'hidden current coordinates still use request-time server owner, never the earlier visible point');
    assert.match(code, /appendFileSync\(join\(outDir, 'visibility-reads.jsonl'\)/);
    assert.ok(code.indexOf('await visibilityCapture?.stop()') < code.indexOf("scenario = 'restore'"));
    const capture = code.slice(code.indexOf('visibilityCapture = startVisibilityCapture'), code.indexOf("await check('O0'"));
    assert.ok(!/\/diag|\.send\(|\.chat\(|\.write\(/.test(capture), 'truth capture creates no snapshot/model/actuator action');
  });
  it('records online cleanup before logout and asserts truthful CLI exits without a forced kill', () => {
    assert.ok(!/\.kill\(|SIGKILL/.test(code));
    assert.match(code, /shutdownProblems\(exited,/);
    assert.match(code, /assert\(problems\.length === 0,/);
    const quit = code.indexOf('await quitPlayer(o())');
    assert.ok(code.lastIndexOf('await cleanupPlayer(OWNER, o())', quit) >= 0);
    assert.match(code, /online Inventory\/head not verified empty/);
    assert.match(code, /server sneak state not verified clear/);
    assert.match(code, /all actuator leases revoked/);
    assert.match(code, /zero players not verified/);
    assert.match(code, /forcedKill: false/);
    assert.ok(!code.includes('cliExitSaved: true'));
  });
  it('captures grounded stationary server origin before staging and retains exact restoration proof even on failure', () => {
    const origin = code.indexOf("botStart = await captureBotPosition('pre-staging origin')");
    assert.ok(origin > code.indexOf("await startCli('run-locator-ordinary', normalConfig)"));
    assert.ok(origin < code.indexOf('owner = await fixturePlayer(OWNER)'));
    const capture = code.slice(code.indexOf('const captureBotPosition = async'), code.indexOf('const startCli = async'));
    assert.match(capture, /await readField\('OnGround'\)/);
    assert.match(capture, /await readField\('UUID'\)/);
    assert.match(capture, /Math\.min\(deadlineMs, fromMs \+ POSITION_SETTLE\.maxReadMs\)/);
    assert.match(capture, /scopeBefore, scopeAfter: positionScope\(\)/);
    assert.match(capture, /appendFileSync\(join\(outDir, 'position-reads.jsonl'\)/);
    assert.match(capture, /evidence\.error =/);
    assert.ok(!/serverPos\(|cli\.send\(|run tp|rcon\([^`]/.test(capture), 'origin capture has only independent server reads');
    assert.ok(!/Dimension.*\?\? 'minecraft:overworld'/.test(code), 'no guessed original dimension');
    assert.match(code, /const target = originalPositionTarget\(botStart\)/);
    assert.match(code, /const restored = await captureBotPosition\('original restoration', target\)/);
    assert.match(code, /botOrigin: botStart \?\? null/);
    assert.match(code, /retainedLH10Failures:/);
    assert.match(code, /'origin must precede any gameplay work'/);
    assert.match(code, /'gameplay work started during origin capture'/);
  });
});

describe('MB-LOC-002 ordinary harness prompt capture (offline: stub real CLI, shared fault fixture, temp dir)', () => {
  it('exec prompts are saved verbatim and the scripted proposal is replayed; gate commands pass through', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locator-ordinary-capture-'));
    try {
      const stub = join(dir, 'stub-codex.cjs');
      writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write('stub ' + process.argv.slice(2).join(' ') + '\\n');\n`);
      chmodSync(stub, 0o755);
      const prompts = join(dir, 'prompts');
      mkdirSync(prompts);
      const fault = writeFaultCodex(dir, stub);
      setFaultTurns(dir, stub, [{ kind: 'proposal', proposal: harness.followMe() }], 'chatgpt');
      const wrapper = harness.writePromptCapture(dir, fault, prompts);
      const gate = spawnSync(wrapper, ['--version'], { encoding: 'utf8' });
      assert.equal(gate.status, 0, gate.stderr);
      assert.match(gate.stdout, /^stub --version/);
      const prompt = '{"goal":{"origin":"owner"},"observation":{"self":{"x":1,"z":2}}}\nplease plan';
      const ex = spawnSync(wrapper, ['exec', '--json', '-'], { input: prompt, encoding: 'utf8' });
      assert.equal(ex.status, 0, ex.stderr);
      const saved = readdirSync(prompts);
      assert.equal(saved.length, 1);
      assert.match(saved[0]!, /^0000-\d+\.txt$/);
      assert.equal(readFileSync(join(prompts, saved[0]!), 'utf8'), prompt);
      const lines = ex.stdout.trim().split('\n').map((l) => JSON.parse(l) as { type: string; item?: { text?: string } });
      const message = lines.find((l) => l.type === 'item.completed')?.item?.text ?? '';
      assert.deepEqual(JSON.parse(message), harness.followMe());
      assert.ok(lines.some((l) => l.type === 'turn.completed'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
