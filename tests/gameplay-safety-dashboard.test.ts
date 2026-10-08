// Actual facade -> publisher -> schema -> viewer, without a world or providers.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DashboardStatusSchema, type DashboardStatus } from '../src/contracts/dashboard.ts';
import type { SafetyStatus } from '../src/contracts/safety.ts';
import type { SafetyService } from '../src/safety/service.ts';
import { DashboardStatusPublisher } from '../src/dashboard/publisher.ts';
import { createDashboardRuntime, type DashboardRuntimeDeps } from '../src/dashboard/runtime.ts';
import { remoteMetadata } from '../src/dashboard/remote.ts';
import { buildViewModel, StatusFollower } from '../src/dashboard/viewmodel.ts';
import { FakeConnection } from './dashboard-fakes.ts';
import { safetyStatusLine } from '../src/app/status.ts';

type Assignable<T, U extends T> = U;
export type RealSafetyGetterFits = Assignable<NonNullable<DashboardRuntimeDeps['safety']>, () => ReturnType<SafetyService['status']>>;

function sample(): SafetyStatus {
  return { enabled: true, state: 'responding', authority: { basis: 'owner_goal', detail: 'Manual goal protected while automatic work is paused.' }, connectionEpoch: 1,
    vitals: null, fluid: null, threats: [],
    episode: { episodeId: 'se-test1234', response: 'escape_water', hazards: ['submerged'], sinceS: 1, actions: 1, maxActions: 3, displacement: 2, suspended: { goalId: 'goal-test1234' } },
    lastEpisode: null, blocker: null,
    counters: { episodes: 1, resolved: 0, improved: 0, unresolved: 0, blocked: 0, revoked: 0, preemptions: 1, retreats: 0, defenses: 0, attacksSent: 0, hitsConfirmed: 0, defeatsConfirmed: 0 }, limits: [] };
}
function view(status: DashboardStatus, now = status.publisher.publishedAtMs) {
  const follower = new StatusFollower();
  follower.accept({ kind: 'ok', status: DashboardStatusSchema.parse(status) });
  return buildViewModel({ follower, now, pidAlive: () => true, history: undefined, remote: remoteMetadata({}), timeZone: 'UTC' });
}
function snapshot(safety?: () => SafetyStatus | undefined) {
  const clock = { t: 100_000 };
  const game = new FakeConnection(clock); game.join(); game.ready();
  const pub = new DashboardStatusPublisher({ statusPath: '/unused', runId: 'run-safety1234', pid: 1234, now: () => clock.t, game, profile: { version: '26.2', supportLevel: 'local-compat' }, ...(safety ? { safety } : {}) });
  return pub.snapshot();
}

describe('shared immediate-safety dashboard composition', () => {
  it('facade publishes a bounded whitelist without memory/autonomy or changing authority/counters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'safety-dashboard-'));
    const clock = { t: 100_000 };
    const game = new FakeConnection(clock); game.join(); game.ready();
    const status = sample();
    status.authority.detail += ` ${'x'.repeat(1_000)} OPENROUTER_API_KEY=sk-secretkey123456789`;
    const before = structuredClone(status);
    let reads = 0;
    const runtime = createDashboardRuntime({ dataDir: dir, runId: 'run-safety1234', now: () => clock.t, game,
      profile: { version: '26.2', supportLevel: 'local-compat' }, safety: () => { reads++; return status; } });
    try {
      runtime.start();
      const s = DashboardStatusSchema.parse(JSON.parse(readFileSync(runtime.paths.status, 'utf8')));
      const projected = s.directive.safety!;
      assert.equal(reads, 1, 'one status read per snapshot; no action/tick/resync');
      assert.equal(s.integrations.memory, false); assert.equal(s.integrations.autonomy, false); assert.equal(s.integrations.safety, true);
      assert.equal(projected.authority, 'owner_goal'); assert.equal(projected.suspendedGoalId, 'goal-test1234'); assert.equal(projected.response, 'escape_water');
      assert.equal(projected.reason, 'submerged');
      assert.equal(projected.source, 'app_state'); assert.equal(projected.connectionEpoch, 1);
      assert.ok(projected.detail.length <= 600);
      assert.ok(!JSON.stringify(projected).includes('sk-secretkey123456789'));
      assert.ok(!('threats' in projected) && !('vitals' in projected) && !('fluid' in projected));
      assert.deepEqual(status, before);
      assert.match(view(s).directive.safety!.title, /Leaving unsafe water/);
      assert.equal(view(s).directive.safety!.historical, false);
      runtime.stop('shutdown');
      const stopped = DashboardStatusSchema.parse(JSON.parse(readFileSync(runtime.paths.status, 'utf8')));
      assert.equal(view(stopped).directive.safety!.historical, true);
      assert.match(view(stopped).directive.safety!.note, /Historical; not live/);
    } finally { runtime.stop('test end'); rmSync(dir, { recursive: true, force: true }); }
  });

  it('blocked and revoked control cannot display an old active response; missing status never reports clear', () => {
    const s = sample();
    s.state = 'blocked'; s.blocker = { reason: 'repeated_hazard', detail: 'Finite episode allowance exhausted.', hazards: ['submerged'], retryInS: 10 };
    const blocked = view(snapshot(() => s)).directive.safety!;
    assert.match(blocked.title, /Safety response blocked/); assert.match(blocked.detail, /repeated hazard/); assert.equal(blocked.tone, 'warn');
    assert.match(safetyStatusLine(s), /safety: blocked; blocked repeated_hazard/);
    s.state = 'no_authority'; s.episode = null; s.blocker = null; s.authority = { basis: 'none', detail: 'Explicit stop revoked motion.' };
    const revoked = view(snapshot(() => s)).directive.safety!;
    assert.match(revoked.title, /no control authority/); assert.ok(!revoked.title.includes('Leaving'));
    assert.match(safetyStatusLine(s), /safety: no_authority; authority none; connection 1/);
    assert.ok(!safetyStatusLine(s).includes('clear'));
    const unavailable = snapshot(() => { throw new Error('status unavailable'); });
    assert.equal(unavailable.directive.safety, undefined);
    assert.match(view(unavailable).directive.safety!.title, /unavailable/);
    assert.equal(view(unavailable).directive.safety!.historical, true);
  });

  it('old files remain valid; wrong epoch, stale/future sample or stopped publisher is historical', () => {
    const old = snapshot(); delete old.integrations.safety;
    assert.ok(DashboardStatusSchema.safeParse(old).success); assert.equal(view(old).directive.safety, null);
    const current = snapshot(() => sample());
    for (const changed of [{ ...current.directive.safety!, connectionEpoch: 0 }, { ...current.directive.safety!, observedAtMs: 95_000 }, { ...current.directive.safety!, observedAtMs: 100_001 }]) {
      const v = view({ ...current, directive: { ...current.directive, safety: changed } }).directive.safety!;
      assert.equal(v.historical, true); assert.match(v.title, /^Last known/);
    }
    assert.equal(view(current, 110_000).directive.safety!.historical, true);
    const extra = { ...current, directive: { ...current.directive, safety: { ...current.directive.safety!, coordinates: { x: 1, z: 1 } } } };
    assert.equal(DashboardStatusSchema.safeParse(extra).success, false);
  });
});
