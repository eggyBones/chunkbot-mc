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
    assert.ok(/finally \{[\s\S]*restores\.reverse\(\)/.test(runBody), 'restorations run in finally');
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

  it('leaksCoordinate finds a hidden owner x/z (floor/round +/-1) and ignores other numbers', () => {
    const owner = { x: 2301.5, z: 2043.5 };
    assert.equal(harness.leaksCoordinate('{"self":{"x":2001.2,"z":2010}}', owner), undefined);
    assert.ok(harness.leaksCoordinate('{"target":{"x":2301,"z":7}}', owner));
    assert.ok(harness.leaksCoordinate('owner at 2302.0', owner));
    assert.ok(harness.leaksCoordinate('z=2044', owner));
    assert.equal(harness.leaksCoordinate('id 123012301 and 92301', owner), undefined, 'digits inside a longer number are not a coordinate');
    assert.equal(harness.leaksCoordinate('x 2301', { x: Number.NaN, z: 2043.5 }), undefined, 'a coordinate excluded by the caller is not checked');
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
