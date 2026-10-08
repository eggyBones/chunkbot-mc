// MB-LOC-001: the locator gate harness is import-safe and refuses to touch a
// fixture without an explicit lease. Verified by static source checks and by
// spawning it only with missing/invalid leases (exit 2 before any password
// read, RCON command, join or output-directory setup).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
// Import safety is itself under test: importing the harness runs nothing (no output dir is created).
const before = existsSync(join(PROJECT_ROOT, 'var', 'live-check')) ? readdirSync(join(PROJECT_ROOT, 'var', 'live-check')).sort() : [];
const harness = await import('../scripts/locator-live-check.ts');

const SCRIPT = join(PROJECT_ROOT, 'scripts', 'locator-live-check.ts');
const source = readFileSync(SCRIPT, 'utf8');
const liveDir = join(PROJECT_ROOT, 'var', 'live-check');
const listLive = () => (existsSync(liveDir) ? readdirSync(liveDir).sort() : []);

describe('MB-LOC-001 locator harness guard', () => {
  it('is import-safe: main() runs only behind the entry-point guard; the lease check precedes run(); no top-level side effects', () => {
    const guard = source.indexOf('if (isEntryPoint(import.meta.url, process.argv[1])) {');
    assert.ok(guard > 0, 'entry-point guard present');
    const code = source.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const calls = code.filter(({ l }) => /(^|[^\w.])main\(/.test(l) && !/function main\(/.test(l));
    const guardLine = source.slice(0, guard).split('\n').length - 1;
    assert.equal(calls.length, 1, calls.map((c) => c.l).join(' | '));
    assert.ok(calls[0]!.i > guardLine, 'main() is only invoked inside the entry-point guard');
    const mainBody = source.slice(source.indexOf('async function main('), guard);
    const leaseCheck = mainBody.indexOf("argOf(argv, '--fixture-lease')");
    assert.ok(leaseCheck > 0 && mainBody.indexOf('run(argv, lease)') > leaseCheck, 'run() only after the lease check');
    // Password reads, RCON, joins, output dirs and heavy imports live inside run(), never at top level.
    const topLevel = source.split('\n').filter((l) => /^(const|let|var|await|[a-zA-Z_$][\w$]*\()/.test(l));
    for (const l of topLevel) assert.ok(!/readFileSync\(|rconCommand\(|mkdirSync\(|connect\(|createBot\(|import\(/.test(l), `top-level side effect: ${l}`);
    const runBody = source.slice(source.indexOf('async function run('), source.indexOf('async function main('));
    assert.ok(runBody.indexOf("await import('../src/app/fixture-layout.ts')") < runBody.indexOf('readFileSync(fx.properties'), 'imports before any read');
    assert.ok(/--approve-rules/.test(runBody) && /requires --approve-rules/.test(runBody), 'rule/attribute changes need their own approval id');
    assert.ok(/requires --approve-scene/.test(runBody), 'scene fills need their own approval id');
    assert.ok(/finally \{[\s\S]*restores\.reverse\(\)/.test(runBody), 'restorations run in finally');
  });

  it('importing the harness module creates no output and starts nothing', () => {
    assert.deepEqual(listLive(), before);
  });

  for (const args of [[], ['--fixture', '26.2'], ['--fixture-lease'], ['--fixture-lease', '--fixture', '26.2'], ['--fixture-lease', '../x;rm'], ['--gates', 'g1,g2', '--approve-rules', 'x1']]) {
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

describe('MB-LOC-001-C4 declared footprint, flat baseline and restoration', () => {
  const F = harness.LOCATOR_FOOTPRINT;
  it('EVERY teleport destination is inside the declared footprint (west 400, south 200, north-east, elevated, nether roof)', () => {
    for (const [name, at] of Object.entries(harness.TELEPORTS)) assert.ok(harness.insideBox(F.overworldTeleports, at), `${name} ${JSON.stringify(at)}`);
    const t = harness.TELEPORTS;
    assert.equal(t['ownerWest400']!.x, 600.5);
    assert.equal(t['ownerSouth200']!.z, 1200.5);
    assert.equal(t['ownerNorthEast60']!.z, 958.5);
    assert.equal(t['ownerAbove']!.y, -46);
    assert.ok(harness.insideBox(F.netherTeleports, harness.NETHER_ROOF));
    assert.equal(harness.NETHER_ROOF.y, 128, 'on top of the nether bedrock roof, never inside unknown rock');
    for (const k of ['base', 'ownerG3'] as const) assert.ok(harness.insideBox(F.g3BotEnvelope, t[k]!), `${k} inside the G3 envelope`);
  });

  it('the harness teleports ONLY through the checked helper, with declared keys', () => {
    const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.equal((code.match(/run tp \$\{/g) ?? []).length, 2, 'exactly the two helper teleports (overworld, nether roof)');
    assert.ok(!/rcon\(`tp /.test(code), 'no raw tp');
    const keys = [...code.matchAll(/(?:ownerAt\(|tp\([^,]+,)\s*'([A-Za-z0-9]+)'/g)].map((m) => m[1]!);
    assert.ok(keys.length >= 15);
    for (const k of keys) assert.ok(k === 'netherRoof' || k in harness.TELEPORTS || k in harness.F1_TELEPORTS, `undeclared teleport key ${k}`);
    const ownerOffsets = [...code.matchAll(/'(owner[A-Za-z0-9]+)'/g)].map((m) => m[1]!);
    for (const k of ownerOffsets) assert.ok(k in harness.TELEPORTS, `undeclared ${k}`);
  });

  it('the flat baseline is the dedicated fixture default (scripts/fixture.ts flat, no generator settings) and restoration rewrites EVERY scene layer once', () => {
    const fixtureSrc = readFileSync(join(PROJECT_ROOT, 'scripts', 'fixture.ts'), 'utf8');
    assert.match(fixtureSrc, /'level-type=minecraft\\\\:flat'/);
    assert.ok(!/generator-settings/.test(fixtureSrc), 'default flat layers (no custom generator settings)');
    assert.deepEqual(harness.FLAT_BASELINE.map((l: { y: number; block: string }) => `${l.y}:${l.block}`), ['-64:bedrock', '-63:dirt', '-62:dirt', '-61:grass_block']);
    const sc = F.scene;
    const covered = new Map<number, string>();
    for (const cmd of harness.baselineRestoreCommands(sc)) {
      const m = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) ([a-z_]+)$/.exec(cmd);
      assert.ok(m, cmd);
      const [x1, y1, z1, x2, y2, z2] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
      assert.deepEqual([x1, z1, x2, z2], [sc.x1, sc.z1, sc.x2, sc.z2]);
      assert.ok((x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1) <= 32_768, 'within the fill volume limit');
      for (let y = y1; y <= y2; y += 1) {
        assert.ok(!covered.has(y), `layer ${y} written twice`);
        covered.set(y, m[7]!);
      }
    }
    for (let y = sc.y1; y <= sc.y2; y += 1) assert.ok(covered.has(y), `layer ${y} restored (bedrock/dirt/grass/air)`);
    assert.equal(covered.get(-64), 'bedrock');
    assert.equal(covered.get(-63), 'dirt');
    assert.equal(covered.get(-61), 'grass_block');
    assert.equal(covered.get(-60), 'air');
  });

  it('the scene and its read-only reference region are disjoint, equally sized and comparable in one execute-if-blocks', () => {
    const a = F.scene;
    const b = F.sceneReference;
    assert.ok(a.x2 < b.x1, 'disjoint');
    assert.deepEqual([a.x2 - a.x1, a.y1, a.y2, a.z1, a.z2], [b.x2 - b.x1, b.y1, b.y2, b.z1, b.z2]);
    assert.ok((a.x2 - a.x1 + 1) * (a.y2 - a.y1 + 1) * (a.z2 - a.z1 + 1) <= 32_768);
    const runBody = source.slice(source.indexOf('async function run('), source.indexOf('async function main('));
    assert.ok(/G5-baseline/.test(runBody) && runBody.indexOf('G5-baseline') < runBody.indexOf("scenario('G5-lava'"), 'baseline proven before any scene write');
    assert.ok(/restoreFailures\.length === 0/.test(runBody), 'a failed restoration fails the whole report');
    assert.ok(/throw new Error\(`scene restoration not verified/.test(runBody), 'restoration is re-verified, not assumed');
  });
});

describe('MB-LOC-002 G6 F1 direction-matrix footprint', () => {
  const F = harness.LOCATOR_FOOTPRINT;
  it('every G6 destination is in its own negative-coordinate box, disjoint from the other harness boxes; the bot envelope holds the base', () => {
    for (const [name, at] of Object.entries(harness.F1_TELEPORTS)) {
      assert.ok(harness.insideBox(F.f1Teleports, at), `${name} ${JSON.stringify(at)}`);
      assert.ok(at.x < 0 && at.z < 0, `${name} uses negative coordinates`);
    }
    assert.ok(harness.insideBox(F.g6BotEnvelope, harness.F1_BASE));
    const ov = (a: { x1: number; x2: number; z1: number; z2: number }, b: { x1: number; x2: number; z1: number; z2: number }) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.z1 <= b.z2 && b.z1 <= a.z2;
    for (const k of ['overworldTeleports', 'g3BotEnvelope', 'scene', 'sceneReference', 'netherTeleports'] as const) assert.ok(!ov(F.f1Teleports, F[k]), k);
  });

  it('eight directions plus wraparound at each variant distance; the true sectors of the destinations are all eight', () => {
    const sectors = new Set<string>();
    for (const b of harness.F1_BEARINGS) {
      for (const v of ['vec3i', 'chunk', 'azimuth'] as const) {
        const at = harness.F1_TELEPORTS[harness.f1Key(v, b)]!;
        const d = Math.hypot(at.x - harness.F1_BASE.x, at.z - harness.F1_BASE.z);
        assert.ok(Math.abs(d - harness.F1_DISTANCES[v]) < 1.5, `${v} ${b}: ${d}`);
        const a = (Math.atan2(at.z - harness.F1_BASE.z, at.x - harness.F1_BASE.x) * 180) / Math.PI;
        assert.ok(Math.abs(((a - b + 540) % 360) - 180) < 2, `${v} ${b}: bearing ${a.toFixed(1)}`);
        sectors.add(['east', 'south_east', 'south', 'south_west', 'west', 'north_west', 'north', 'north_east'][((Math.round(a / 45) % 8) + 8) % 8]!);
      }
    }
    assert.equal(sectors.size, 8);
    assert.ok(harness.F1_DISTANCES.azimuth > 332 && harness.F1_DISTANCES.vec3i < 6 * 16, 'distances select azimuth / block precision at view distance 6');
  });
});

describe('MB-LOC-001-C5 negative-scene geometry', () => {
  it('the bot starts west of every obstacle, the owner on intact ground, the drop is a platform inside the scene (bedrock never removed)', () => {
    const F = harness.LOCATOR_FOOTPRINT;
    const t = harness.TELEPORTS;
    const obstaclesFrom = F.scene.x1 + 3;
    assert.ok(Math.floor(t['sceneBot']!.x) < obstaclesFrom, 'bot west of the lava/wall bands');
    assert.ok(Math.floor(t['sceneOwner']!.x) > F.scene.x1 + 12, 'owner east of the widest band');
    const pf = harness.SCENE_PLATFORM;
    assert.ok(harness.insideBox(F.scene, { x: pf.x1, y: pf.y1, z: pf.z1 }) && harness.insideBox(F.scene, { x: pf.x2, y: pf.y2, z: pf.z2 }));
    assert.ok(pf.y1 > -61, 'the platform is built on top of the ground; no layer below it is removed');
    const p = t['scenePlatform']!;
    assert.ok(Math.floor(p.x) >= pf.x1 && Math.floor(p.x) <= pf.x2 && p.y === pf.y2 + 1, 'bot stands on the platform top');
    assert.ok(pf.y2 + 1 - (-60) > 3, 'the drop is deeper than 3 blocks');
    const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    assert.ok(!/-64 \$\{sc\.z1\}[^`]*air/.test(code) && !/fill \$\{sc\.x1 \+ 3\} -64/.test(code), 'no scene setup removes the bedrock layer');
    assert.ok(/no obstacle contact, damage or death/.test(code), 'contact/damage/death are monitored for every scene');
  });
});
