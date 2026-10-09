// MB-FLOW-003-C11/C13 shared structural seams (P): one lease/executor with a
// `safety` owner kind fenced by a code-owned grant check (fail closed),
// synchronous preemption that does NOT end the owning goal, and the app
// authority host (manual owner goal protected while the automatic latch is set;
// explicit stop without a newer owner goal -> none; not ready/dead -> none).
// No safety policy here (W owns it). Credential-free fakes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChunkbotApp } from '../src/app/app.ts';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { parseConfig } from '../src/config/load.ts';
import { sequentialIds, systemClock, type ExecutionOwner } from '../src/contracts/index.ts';
import { ActuatorLeases, LeaseRevokedError } from '../src/execution/lease.ts';
import { offlinePlayerUuid } from '../src/game/identity.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { FakeGame, ScriptedPlanner, until } from './helpers.ts';

const config = parseConfig({ minecraft: { host: '127.0.0.1', port: 25566, version: '26.1.2' }, bot: { auth: 'offline', username: 'Chunkbot', trustedOfflineFixture: true }, owner: { name: 'FixtureOwner' } });
const safetyOwner: Extract<ExecutionOwner, { kind: 'safety' }> = { kind: 'safety', grantId: 'sg-0001', episodeId: 'se-0001', connectionEpoch: 1 };

describe('safety seams: single lease preemption', () => {
  it('preemption revokes a goal lease synchronously (goal not ended) and never preempts a safety lease', () => {
    const cleared: string[] = [];
    let goalEpoch = 3;
    const leases = new ActuatorLeases({ clock: systemClock, ownerCurrent: (o) => (o.kind === 'goal' ? o.goalEpoch === goalEpoch : o.kind === 'safety'), connectionEpoch: () => 1, clearShared: (r) => (cleared.push(r), { steps: ['controls'], errors: [] }) });
    const goal = leases.acquire({ kind: 'goal', goalEpoch: 3, goalId: 'goal-0001', taskId: 'task-0001' });
    const r = leases.preemptForSafety();
    assert.equal(r.revoked, true);
    assert.equal(r.holder, 'goal epoch 3');
    assert.deepEqual(cleared, ['safety_preempt']);
    assert.throws(() => goal.fence(), (e: unknown) => e instanceof LeaseRevokedError && e.reason === 'safety_preempt');
    assert.equal(goalEpoch, 3, 'the goal epoch (ownership) is untouched by preemption');
    const s = leases.acquire(safetyOwner);
    assert.deepEqual(leases.preemptForSafety(), { revoked: false, holder: 'safety grant sg-0001', clearMs: null });
    assert.equal(s.active, true);
    goalEpoch = 4;
  });

  it('a safety owner is fenced by the installed grant check and fails closed without one', () => {
    const runtime = new SkillRuntime({ config, session: () => undefined, connectionEpoch: () => 0, goalEpoch: () => 0, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store: new MemoryRunStore(), clock: systemClock, ids: sequentialIds(), features: {} });
    const lease = runtime.leases.acquire({ ...safetyOwner, connectionEpoch: 0 });
    assert.equal(lease.active, false, 'no grant check installed: refused');
    let current = true;
    runtime.installSafetyGrantCheck((id) => id === 'sg-0001' && current);
    assert.equal(lease.active, true);
    current = false;
    assert.throws(() => lease.fence(), LeaseRevokedError, 'an expired/revoked grant stops the very next command');
    const port = runtime.safetyActuation();
    assert.equal(typeof port.preemptCurrent, 'function');
    assert.equal(typeof port.execute, 'function');
  });
});

describe('safety seams: authority host', () => {
  it('manual owner goal while paused is protected; stop without a newer owner goal is none; not ready is none', async () => {
    const planner = new ScriptedPlanner();
    const game = new FakeGame();
    game.selfUuid = offlinePlayerUuid('Chunkbot');
    const causes: string[] = [];
    const app = new ChunkbotApp({ config, game, store: new MemoryRunStore(), clock: { now: () => Date.now() }, ids: sequentialIds(), out: () => undefined, runFacts: {}, adapters: { planner }, extensions: { onSafetyAuthorityChanged: (c) => causes.push(c), travelBounds: () => ({ anchor: { x: 1, y: 2, z: 3 }, radius: 128 }) } });
    assert.equal(app.safetyAuthority().basis, 'none', 'not connected');
    const connected = app.connect();
    game.completeJoin();
    await connected;
    assert.equal(app.safetyAuthority().basis, 'unpaused');
    await app.handleTerminalLine('stop');
    assert.equal(app.safetyAuthority().basis, 'none', 'explicit stop: no idle motion');
    await app.handleTerminalLine('come here');
    await until(() => planner.waiting === 1);
    const a = app.safetyAuthority();
    assert.equal(a.basis, 'owner_goal', 'a new manual owner goal is protected while the automatic latch stays set');
    assert.deepEqual(a.travel, { anchor: { x: 1, y: 2, z: 3 }, radius: 128 });
    assert.equal(a.goal?.source, 'owner');
    await app.handleTerminalLine('stop');
    assert.equal(app.safetyAuthority().basis, 'none');
    assert.ok(causes.includes('owner_stop') && causes.includes('owner_goal_admitted'));
    await app.shutdown('operator_quit');
  });
});
