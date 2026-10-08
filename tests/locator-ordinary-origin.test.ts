import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { captureStationaryPosition, originalPositionTarget, parsePlayerPositionRead, POSITION_SETTLE, stationaryPositionProof, type PlayerPositionRead, type PositionScope, type PositionTarget } from '../scripts/lib/locator-ordinary-origin.ts';

const identity = { name: 'Chunkbot', uuid: '00000001-0000-0002-0000-000300000004' };
const scope: PositionScope = { runId: 'run-origin', connectionEpoch: 1 };
const target: PositionTarget = { at: { x: 264.5, y: -60, z: 195.5 }, dimension: 'minecraft:overworld' };
const data = (value: string) => `Chunkbot has the following entity data: ${value}`;
const pos = (y = -60, x = 264.5, z = 195.5) => data(`[${x}d, ${y}d, ${z}d]`);
function sample(fromMs = 1_000): PlayerPositionRead {
  return { scopeBefore: { ...scope }, scopeAfter: { ...scope }, fromMs, toMs: fromMs + 10,
    replies: { positionBefore: pos(), positionAfter: pos(), dimensionBefore: data('"minecraft:overworld"'), dimensionAfter: data('"minecraft:overworld"'), uuid: data('[I; 1, 2, 3, 4]'), onGround: data('1b') } };
}
const stable = () => [sample(1_000), sample(1_510), sample(2_020)];
function fakeIo(change: (read: PlayerPositionRead, index: number) => void = () => {}, readMs = 10) {
  let clock = 1_000, count = 0;
  const retained: PlayerPositionRead[] = [];
  return { retained, io: {
    now: () => clock,
    read: async () => { const read = sample(clock); read.toMs = clock + readMs; change(read, count++); clock += readMs; return read; },
    record: (read: PlayerPositionRead) => retained.push(structuredClone(read)),
    wait: async (ms: number) => { clock += ms; },
  } };
}

describe('ordinary locator stable origin server proof', () => {
  it('proves a grounded full point/dimension over a bounded interval and returns detached evidence', () => {
    const reads = stable(), proof = stationaryPositionProof(reads, identity, scope);
    assert.deepEqual(originalPositionTarget(proof), target);
    reads[0]!.replies.positionBefore = pos(-50);
    assert.deepEqual(originalPositionTarget(proof), target);
    assert.equal(proof.fromMs, 1_000);
    assert.equal(proof.toMs, 2_030);
  });
  for (const y of [-50.42467038393728, -48.22350670217752]) {
    it(`rejects the retained airborne origin ${y}, even with repeated identical server positions`, () => {
      const reads = stable();
      for (const r of reads) { r.replies.positionBefore = pos(y); r.replies.positionAfter = pos(y); r.replies.onGround = data('0b'); }
      assert.throws(() => stationaryPositionProof(reads, identity, scope), /airborne/);
    });
  }
  for (const [name, change] of [
    ['falls during a bracketed read', (r: PlayerPositionRead) => { r.replies.positionAfter = pos(-60.2); }],
    ['moves horizontally', (r: PlayerPositionRead) => { r.replies.positionBefore = pos(-60, 265); r.replies.positionAfter = pos(-60, 265); }],
    ['changes only z', (r: PlayerPositionRead) => { r.replies.positionBefore = pos(-60, 264.5, 196); r.replies.positionAfter = pos(-60, 264.5, 196); }],
    ['changes dimension within one read', (r: PlayerPositionRead) => { r.replies.dimensionAfter = data('"minecraft:the_nether"'); }],
    ['changes dimension between reads', (r: PlayerPositionRead) => { r.replies.dimensionBefore = r.replies.dimensionAfter = data('"minecraft:the_nether"'); }],
  ] as const) {
    it(`refuses a stationary baseline that ${name}`, () => {
      const reads = stable(); change(reads[1]!);
      assert.throws(() => stationaryPositionProof(reads, identity, scope), /airborne, moving or changed dimension/);
    });
  }
  for (const [name, change] of [
    ['wrong UUID', (r: PlayerPositionRead) => { r.replies.uuid = data('[I; 1, 2, 3, 5]'); }],
    ['foreign named entity', (r: PlayerPositionRead) => { r.replies.positionAfter = r.replies.positionAfter.replace('Chunkbot', 'FixtureGuest'); }],
    ['command absence', (r: PlayerPositionRead) => { r.replies.positionBefore = 'No entity was found'; }],
    ['missing dimension', (r: PlayerPositionRead) => { r.replies.dimensionAfter = 'Found no elements matching Dimension'; }],
    ['grounding label without named server reply', (r: PlayerPositionRead) => { r.replies.onGround = 'grounded: true'; }],
    ['unreadable grounding', (r: PlayerPositionRead) => { r.replies.onGround = data('true'); }],
    ['connection changed during reads', (r: PlayerPositionRead) => { r.scopeAfter.connectionEpoch++; }],
    ['different run', (r: PlayerPositionRead) => { r.scopeBefore.runId = 'run-other'; }],
    ['read over freshness bound', (r: PlayerPositionRead) => { r.toMs = r.fromMs + POSITION_SETTLE.maxReadMs + 1; }],
    ['backward read clock', (r: PlayerPositionRead) => { r.toMs = r.fromMs - 1; }],
    ['non-finite time', (r: PlayerPositionRead) => { r.toMs = NaN; }],
  ] as const) {
    it(`refuses ${name} without deriving a default origin`, () => { const r = sample(); change(r); assert.throws(() => parsePlayerPositionRead(r, identity, scope)); });
  }
  it('refuses too few reads, a short interval, gaps and overlapping chronology', () => {
    assert.throws(() => stationaryPositionProof(stable().slice(0, 1), identity, scope), /too few/);
    assert.throws(() => stationaryPositionProof([sample(1_000), sample(1_200), sample(1_400)], identity, scope), /too short/);
    assert.throws(() => stationaryPositionProof([sample(1_000), sample(2_011), sample(2_600)], identity, scope), /gap/);
    assert.throws(() => stationaryPositionProof([sample(1_000), sample(1_005), sample(2_600)], identity, scope), /unordered/);
  });
  it('revalidates the restoration exception against the retained raw proof', () => {
    for (const change of [
      (p: ReturnType<typeof stationaryPositionProof>) => { p.at.y = -50; },
      (p: ReturnType<typeof stationaryPositionProof>) => { p.at.x = NaN; },
      (p: ReturnType<typeof stationaryPositionProof>) => { p.dimension = 'minecraft:the_nether'; },
      (p: ReturnType<typeof stationaryPositionProof>) => { p.toMs++; },
      (p: ReturnType<typeof stationaryPositionProof>) => { p.reads[1]!.replies.onGround = data('0b'); },
    ]) { const p = stationaryPositionProof(stable(), identity, scope); change(p); assert.throws(() => originalPositionTarget(p)); }
  });
});

describe('ordinary locator read-only settling and honest original restoration', () => {
  it('retains the initial falling reads and captures the later actual stable ground, never the transient join position', async () => {
    const { io, retained } = fakeIo((r, i) => {
      if (i < 3) { r.replies.positionBefore = pos(-48 - i); r.replies.positionAfter = pos(-48.2 - i); r.replies.onGround = data('0b'); }
    });
    const proof = await captureStationaryPosition(io, identity, scope);
    assert.equal(retained.length, 8);
    assert.equal(proof.reads.length, 5);
    assert.equal(retained[0]!.replies.positionBefore, pos(-48));
    assert.deepEqual(originalPositionTarget(proof), target);
  });
  it('resets a settling interval when position drifts, instead of pooling separated snapshots', async () => {
    const { io, retained } = fakeIo((r, i) => { if (i < 4) r.replies.positionBefore = r.replies.positionAfter = pos(-60, 264.5 + i); });
    const proof = await captureStationaryPosition(io, identity, scope);
    assert.equal(retained.length, 9);
    assert.equal(proof.reads.length, 5);
    assert.deepEqual(proof.at, target.at);
  });
  it('times out an indefinitely airborne origin and retains every actual read', async () => {
    const { io, retained } = fakeIo((r) => { r.replies.onGround = data('0b'); });
    await assert.rejects(captureStationaryPosition(io, identity, scope), /did not settle within 10000ms/);
    assert.equal(io.now(), 11_000);
    assert.ok(retained.length > 3);
    assert.ok(retained.every((r) => r.replies.onGround === data('0b')));
  });
  it('refuses successful teleport text as restoration evidence and retains malformed readbacks', async () => {
    const { io, retained } = fakeIo((r) => { r.replies.positionAfter = 'Teleported Chunkbot to 264.500000, -60.000000, 195.500000'; });
    await assert.rejects(captureStationaryPosition(io, identity, scope, target), /unverified server read/);
    assert.equal(retained.length, 1);
  });
  for (const [name, change] of [
    ['grounded elsewhere after falling', (r: PlayerPositionRead) => { r.replies.positionBefore = r.replies.positionAfter = pos(-61.6); }],
    ['same x/z but incorrect height within old 1.5 tolerance', (r: PlayerPositionRead) => { r.replies.positionBefore = r.replies.positionAfter = pos(-60.1); }],
    ['wrong dimension at exact coordinates', (r: PlayerPositionRead) => { r.replies.dimensionBefore = r.replies.dimensionAfter = data('"minecraft:the_nether"'); }],
    ['airborne at exact target', (r: PlayerPositionRead) => { r.replies.onGround = data('0b'); }],
  ] as const) {
    it(`keeps restoration failed when ${name}`, async () => {
      const { io, retained } = fakeIo(change);
      await assert.rejects(captureStationaryPosition(io, identity, scope, target), /did not settle/);
      assert.ok(retained.length > 3);
      assert.throws(() => stationaryPositionProof(retained.slice(-5), identity, scope, target));
    });
  }
  it('requires a fresh settled target on the later CLI connection while retaining the original run proof', async () => {
    const origin = stationaryPositionProof(stable(), identity, scope), current = { runId: 'run-exhaust', connectionEpoch: 3 };
    const { io } = fakeIo((r, i) => { r.scopeBefore = { ...current }; r.scopeAfter = { ...current }; if (i === 0) r.replies.onGround = data('0b'); });
    const proof = await captureStationaryPosition(io, identity, current, originalPositionTarget(origin));
    assert.deepEqual(proof.at, origin.at);
    assert.deepEqual(proof.scope, current);
    assert.deepEqual(origin.scope, scope);
  });
  it('fails closed on future samples, backward chronology and a read that overruns the capture deadline', async () => {
    for (const change of [(r: PlayerPositionRead) => { r.fromMs--; }, (r: PlayerPositionRead) => { r.toMs++; }]) {
      const { io, retained } = fakeIo(change);
      await assert.rejects(captureStationaryPosition(io, identity, scope), /chronology/);
      assert.equal(retained.length, 1);
    }
    const { io } = fakeIo((r) => { r.replies.onGround = data('0b'); }, POSITION_SETTLE.maxReadMs);
    await assert.rejects(captureStationaryPosition(io, identity, scope), /deadline/);
  });
  it('refuses an invalid restoration target before reading', async () => {
    const { io, retained } = fakeIo();
    await assert.rejects(captureStationaryPosition(io, identity, scope, { at: { ...target.at, y: NaN }, dimension: target.dimension }), /invalid original/);
    assert.equal(retained.length, 0);
  });
});
