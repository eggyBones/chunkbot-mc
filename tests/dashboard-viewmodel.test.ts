// MB-UI-001 viewer derivation: offline/stale/crash/stopped/disconnected states,
// out-of-order and old-run snapshots, epoch-tagged historical world readings,
// unknown values that never display as zero, and tiny-cost formatting.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashboardStatus } from '../src/contracts/dashboard.ts';
import { DashboardStatusPublisher } from '../src/dashboard/publisher.ts';
import { remoteMetadata } from '../src/dashboard/remote.ts';
import { StatusFollower, breakdown, buildViewModel, formatUsd, pips, type ViewModel } from '../src/dashboard/viewmodel.ts';
import { FakeConnection, stack, window0 } from './dashboard-fakes.ts';

function scenario(runId = 'run-view0001') {
  const clock = { t: 5_000_000 };
  const game = new FakeConnection(clock);
  const pub = new DashboardStatusPublisher({ statusPath: '/dev/null/never', runId, pid: 4242, now: () => clock.t, game, profile: { version: '26.2', supportLevel: 'local-compat' } });
  pub.start(); // lifecycle subscription (the write to an impossible path fails quietly)
  return { clock, game, pub };
}

function vm(f: StatusFollower, now: number, alive = true): ViewModel {
  return buildViewModel({ follower: f, now, pidAlive: () => alive, history: undefined, remote: remoteMetadata({}), timeZone: 'UTC' });
}

const ok = (status: DashboardStatus) => ({ kind: 'ok' as const, status });
let seq = 0;
const next = (s: DashboardStatus): DashboardStatus => ({ ...s, publisher: { ...s.publisher, seq: ++seq } });

describe('dashboard viewer liveness', () => {
  it('no file yet: "No Chunkbot session yet", no invented values', () => {
    const f = new StatusFollower();
    f.accept({ kind: 'missing' });
    const v = vm(f, 1);
    assert.equal(v.banner.state, 'no_session');
    assert.equal(v.banner.title, 'No Chunkbot session yet');
    assert.equal(v.world.health.text, 'unknown');
    assert.equal(v.world.xp.level, '?');
    assert.equal(v.world.inventory.known, false);
  });

  it('live only with a fresh heartbeat, a ready connection and current-epoch readings', () => {
    const { clock, game, pub } = scenario();
    game.join();
    game.ready();
    game.health(20, 20);
    game.bot.entity.attributes = { 'minecraft:max_health': { value: 20, modifiers: [] } };
    game.xp(3, 0.5, 30);
    game.windowItems(0, window0({ 36: stack(6, 1) }));
    const f = new StatusFollower();
    f.accept(ok(next(pub.snapshot())));
    let v = vm(f, clock.t + 100);
    assert.equal(v.banner.state, 'live');
    assert.equal(v.world.historical, false);
    assert.equal(v.world.health.text, '20 / 20');
    assert.equal(v.world.health.pips?.length, 10);
    assert.equal(v.world.inventory.hotbar[0]?.name, 'Stone Pickaxe');
    // missed heartbeat while the process exists -> stale; process gone -> crashed
    v = vm(f, clock.t + 10_000, true);
    assert.equal(v.banner.state, 'stale');
    assert.equal(v.world.historical, true);
    v = vm(f, clock.t + 10_000, false);
    assert.equal(v.banner.state, 'crashed');
    assert.equal(v.world.historical, true);
  });

  it('graceful stop and disconnect are distinct, and both mark world readings historical', () => {
    const { clock, game, pub } = scenario();
    game.join();
    game.ready();
    game.health(9, 20);
    const f = new StatusFollower();
    f.accept(ok(next(pub.snapshot())));
    game.end('kicked');
    f.accept(ok(next(pub.snapshot())));
    let v = vm(f, clock.t);
    assert.equal(v.banner.state, 'disconnected');
    assert.match(v.banner.title, /kicked/);
    assert.equal(v.world.historical, true);
    assert.match(v.world.health.text, /^9/);
    pub.stop('operator_quit');
    const stopped = pub.snapshot();
    f.accept(ok(next(stopped)));
    v = vm(f, clock.t + 60_000, false);
    assert.equal(v.banner.state, 'stopped', 'a clean stop is not reported as a crash');
    assert.equal(v.world.historical, true);
  });

  it('ignores out-of-order snapshots and older runs; a newer run replaces the state', () => {
    const a = scenario('run-aaaa0001');
    a.game.join();
    a.game.ready();
    a.game.health(5, 5);
    const f = new StatusFollower();
    const s1 = next(a.pub.snapshot());
    a.game.health(15, 15);
    const s2 = next(a.pub.snapshot());
    f.accept(ok(s2));
    f.accept(ok(s1)); // late, lower seq
    assert.equal(f.ignored, 1);
    assert.match(vm(f, a.clock.t).world.health.text, /^15/);
    const b = scenario('run-bbbb0002');
    b.clock.t = a.clock.t + 1_000;
    const older = { ...next(b.pub.snapshot()), publisher: { ...b.pub.snapshot().publisher, startedAtMs: 1, seq: 999 } };
    f.accept(ok(older));
    assert.equal(f.ignored, 2, 'a snapshot from a run that started earlier is not newer');
    const newer = next(b.pub.snapshot());
    f.accept(ok(newer));
    const v = vm(f, b.clock.t);
    assert.equal(v.banner.state, 'disconnected');
    assert.equal(v.world.historical, true, 'previous run readings are only historical');
    assert.match(v.world.note, /previous run/);
  });

  it('a new connection epoch never presents the old epoch as live', () => {
    const { clock, game, pub } = scenario();
    game.join();
    game.ready();
    game.health(11, 20);
    game.windowItems(0, window0({ 9: stack(1, 8) }));
    const f = new StatusFollower();
    f.accept(ok(next(pub.snapshot())));
    game.end();
    pub.snapshot();
    game.join();
    game.ready(); // epoch 2, nothing received yet
    f.accept(ok(next(pub.snapshot())));
    const v = vm(f, clock.t);
    assert.equal(v.banner.state, 'live', 'the app and connection are live');
    assert.equal(v.world.historical, true, 'but the readings are from epoch 1');
    assert.match(v.world.note, /connection 1/);
  });

  it('malformed status keeps the last valid update and says so', () => {
    const { clock, game, pub } = scenario();
    game.join();
    game.ready();
    const f = new StatusFollower();
    f.accept(ok(next(pub.snapshot())));
    f.accept({ kind: 'error', detail: 'status file is not valid JSON (partial or foreign write)' });
    const v = vm(f, clock.t);
    assert.equal(v.banner.state, 'error');
    assert.match(v.banner.detail, /last valid update/);
    const empty = new StatusFollower();
    empty.accept({ kind: 'error', detail: 'too big' });
    assert.equal(vm(empty, 1).banner.state, 'error');
  });
});

describe('dashboard viewer formatting', () => {
  it('formats tiny charges with real precision', () => {
    assert.equal(formatUsd(0), '$0.00');
    assert.equal(formatUsd(17_640), '$0.00001764');
    assert.equal(formatUsd(1_344_000), '$0.001344');
    assert.equal(formatUsd(42), '$0.000000042');
    assert.equal(formatUsd(1e9), '$1.00');
    assert.equal(formatUsd(998_655_999), '$0.9987');
  });

  it('hearts follow the actual maximum; unknown max shows no hearts', () => {
    assert.deepEqual(pips(7, 10), ['full', 'full', 'full', 'half', 'empty']);
    assert.equal(pips(40, 40).length, 20);
    const { clock, game, pub } = scenario();
    game.join();
    game.ready();
    game.health(14, 20);
    const f = new StatusFollower();
    f.accept(ok(next(pub.snapshot())));
    const v = vm(f, clock.t);
    assert.equal(v.world.health.text, '14 (max unknown)');
    assert.equal(v.world.health.pips, null);
  });

  it('unknown usage stays unknown text, never $0.00', () => {
    const { clock, game, pub } = scenario();
    game.join();
    const f = new StatusFollower();
    f.accept(ok(next(pub.snapshot())));
    const v = vm(f, clock.t);
    assert.match(v.usage.jev[0]!.value, /^unknown/);
    assert.match(v.usage.planner[0]!.value, /^unknown/);
    assert.equal(v.usage.jevSplit.length, 0);
    assert.match(v.remote.codex.status, /Remaining Codex allowance unavailable/);
    assert.match(v.remote.wallet, /unavailable/);
  });

  it('pause latch, clarification and position read as distinct, honest statements', () => {
    const clock = { t: 9_000_000 };
    const game = new FakeConnection(clock);
    const pub = new DashboardStatusPublisher({
      statusPath: '/dev/null/never',
      runId: 'run-pause001',
      pid: 1,
      now: () => clock.t,
      game,
      profile: { version: '26.1.2', supportLevel: 'upstream-tested' },
      pause: () => ({ paused: true, reason: 'stopped by owner', sinceMs: clock.t - 1000, manualGoalsAllowed: true }),
      engine: () => ({ goal: { id: 'goal-q001', epoch: 1, instruction: 'fetch wood', origin: { surface: 'chat', principal: 'owner' }, state: 'awaiting_owner', admittedAtMs: 1, updatedAtMs: 1, plannerTurns: 1, progress: '', pendingClarification: { ref: 'q2', question: 'Oak or birch?' } }, readiness: { planner: { ready: true, detail: '' }, knowledge: { ready: true, detail: '' }, observation: { ready: true, detail: '' }, executor: { ready: true, detail: '' }, capabilityCount: 1, catalogVersion: 'x', tasks: { ready: true, detail: '' } } }) as never,
    });
    pub.start();
    game.join();
    game.ready();
    game.bot.entity.position = { x: 1, y: 2, z: 3 };
    const f = new StatusFollower();
    f.accept(ok(next(pub.snapshot())));
    const v = vm(f, clock.t);
    assert.match(v.directive.pause!.text, /^Automatic work paused; a manual goal can still execute/);
    assert.equal(v.directive.clarification, null, 'MB-PLAN-006: a legacy question is never shown or answered');
    assert.equal(v.directive.phase, 'Held (no reply is used)');
    const pos = v.identity.find((r) => r.label === 'Position')!;
    assert.equal(pos.value, '1 2 3 (client)');
    assert.match(pos.title!, /none on this connection/);
    pub.stop('t');
  });

  it('a build without a pause latch says so instead of implying "not paused"', () => {
    const { clock, game, pub } = scenario();
    game.join();
    const f = new StatusFollower();
    f.accept(ok(next(pub.snapshot())));
    assert.match(vm(f, clock.t).directive.pause!.text, /not reported/);
  });

  it('partial planner breakdowns are shown as partial or unknown, never 0', () => {
    assert.equal(breakdown(0, 0, 3), 'unknown (not reported)');
    assert.equal(breakdown(800, 1, 2), '≥ 800 (reported for 1 of 2 turns)');
    assert.equal(breakdown(800, 2, 2), '800');
    assert.equal(breakdown(0, 0, 0), 'n/a');
  });
});
