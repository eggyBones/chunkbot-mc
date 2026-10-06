import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { sequentialIds, systemClock, type ActionCandidate, type ExecutionOwner } from '../src/contracts/index.ts';
import { Actuator } from '../src/execution/actuator.ts';
import { SkillExecutorImpl } from '../src/execution/executor.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases, LeaseBusyError, LeaseRevokedError } from '../src/execution/lease.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import type { SkillDefinition, SkillServices } from '../src/skills/definition.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { tick } from './helpers.ts';
import { evidenceFor, fakeClient, type FakeClient } from './skill-fakes.ts';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('26.1.2');

function harness(goalEpoch = { value: 1 }) {
  const shared: string[] = [];
  const leases = new ActuatorLeases({
    clock: systemClock,
    ownerCurrent: (o: ExecutionOwner) => (o.kind === 'goal' ? o.goalEpoch === goalEpoch.value : true),
    connectionEpoch: () => 1,
    clearShared: (reason) => {
      shared.push(reason);
      return { steps: ['controls_cleared'], errors: [] };
    },
  });
  return { leases, shared, goalEpoch };
}

function fakeSession(client: FakeClient, overrides: Record<string, unknown> = {}): GameSession {
  const slots: unknown[] = new Array(46).fill(null);
  const inventory = { id: 0, type: 'minecraft:inventory', slots, selectedItem: null, inventoryStart: 9, inventoryEnd: 45, acceptClick: (c: { slot: number }) => [c.slot] };
  const setGoalCalls: unknown[] = [];
  const bot = {
    _client: client,
    registry,
    currentWindow: null,
    inventory,
    quickBarSlot: 0,
    game: { dimension: 'minecraft:overworld' },
    lastDigTime: null,
    entity: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } },
    lookAt: () => new Promise((r) => setTimeout(r, 40)),
    look: () => Promise.resolve(),
    dig: () => {
      client.write('block_dig', { status: 0 });
      return new Promise(() => undefined);
    },
    setQuickBarSlot: () => undefined,
    clearControlStates: () => undefined,
    pathfinder: { setGoal: (g: unknown) => setGoalCalls.push(g) },
    setGoalCalls,
    ...overrides,
  };
  return { bot: bot as unknown as GameSession['bot'], connectionEpoch: 1, evidence: evidenceFor(client) };
}

const goalOwner = (epoch: number): ExecutionOwner => ({ kind: 'goal', goalEpoch: epoch, goalId: 'goal-0001', taskId: 'task-0001' });

describe('actuator lease ownership', () => {
  it('invalidates first, closes owned interfaces, then clears shared controls', () => {
    const { leases, shared } = harness();
    const order: string[] = [];
    const lease = leases.acquire(goalOwner(1));
    lease.onRevoke('close_window', () => {
      order.push(`cleanup active=${lease.active}`);
    });
    const report = leases.revoke(lease, 'owner_stop');
    assert.deepEqual(order, ['cleanup active=false'], 'ownership was invalid before cleanup ran');
    assert.deepEqual(shared, ['owner_stop']);
    assert.equal(report?.clearedShared, true);
    assert.throws(() => lease.fence(), LeaseRevokedError);
    assert.equal(leases.revoke(lease, 'again'), undefined, 'idempotent');
  });

  it('an old lease never clears the replacement lease', async () => {
    const { leases, shared } = harness();
    const client = fakeClient();
    const session = fakeSession(client);
    const oldLease = leases.acquire({ kind: 'diagnostic', diagnosticId: 'diag-1' });
    const oldAct = new Actuator(session, oldLease, systemClock);
    leases.revoke(oldLease, 'replaced');
    const newLease = leases.acquire({ kind: 'diagnostic', diagnosticId: 'diag-2' });
    const newAct = new Actuator(session, newLease, systemClock);
    newAct.setPathGoal({ goal: 'new' });
    const goalsBefore = (session.bot as unknown as { setGoalCalls: unknown[] }).setGoalCalls.length;
    // A late continuation of the old action tries to clean up shared movement.
    oldAct.clearPathGoal();
    assert.equal((session.bot as unknown as { setGoalCalls: unknown[] }).setGoalCalls.length, goalsBefore, 'old cleanup did not touch the new path goal');
    assert.equal(leases.revoke(oldLease, 'late'), undefined);
    assert.deepEqual(shared, ['replaced'], 'shared controls cleared only once, for the old lease while it was current');
    assert.equal(newLease.active, true);
    await tick();
  });

  it('a goal epoch change revokes authority before any abort is delivered', () => {
    const { leases, goalEpoch } = harness({ value: 1 });
    const lease = leases.acquire(goalOwner(1));
    assert.equal(lease.active, true);
    goalEpoch.value = 2; // GoalEngine increments the epoch synchronously on stop/replacement
    assert.equal(lease.active, false);
    assert.throws(() => lease.fence(), /owner_revoked/);
  });

  it('one lease at a time; a stale holder is revoked on the next acquire', () => {
    const { leases, goalEpoch } = harness({ value: 1 });
    const a = leases.acquire(goalOwner(1));
    assert.throws(() => leases.acquire({ kind: 'diagnostic', diagnosticId: 'diag-1' }), LeaseBusyError);
    goalEpoch.value = 2;
    const b = leases.acquire(goalOwner(2));
    assert.equal(a.revocation, 'stale_owner');
    assert.equal(leases.current, b);
  });
});

describe('fenced delayed subcommands', () => {
  it('negative control: an awaited macro still writes after its outer promise is abandoned', async () => {
    const client = fakeClient();
    const bot = { lookAt: () => new Promise((r) => setTimeout(r, 30)) };
    const macro = async () => {
      await bot.lookAt();
      client.write('block_dig', { status: 0 }); // like bot.dig after its internal lookAt
    };
    const abort = new AbortController();
    const outer = Promise.race([macro(), new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('cancelled'))))]);
    abort.abort();
    await assert.rejects(outer);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(client.written.length, 1, 'the late write happened anyway');
  });

  it('a revoke during a fenced look prevents the dig start', async () => {
    const { leases } = harness();
    const client = fakeClient();
    const session = fakeSession(client);
    const lease = leases.acquire({ kind: 'diagnostic', diagnosticId: 'diag-1' });
    const act = new Actuator(session, lease, systemClock);
    const seq = (async () => {
      await act.lookAt({ x: 1, y: 1, z: 1 });
      await act.startDig({} as never);
    })();
    await tick(5);
    leases.revoke(lease, 'owner_stop');
    await assert.rejects(seq, LeaseRevokedError);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(client.written.filter((w) => w.name === 'block_dig').length, 0);
  });

  it('click sequences stop at the next fence: no window click after revocation', async () => {
    const { leases } = harness();
    const client = fakeClient();
    const session = fakeSession(client);
    const lease = leases.acquire({ kind: 'diagnostic', diagnosticId: 'diag-1' });
    const act = new Actuator(session, lease, systemClock);
    const seq = (async () => {
      for (const slot of [36, 1, 2, 3, 36]) await act.click(slot, 0, 0, 0);
    })();
    await tick(10); // first click written; now inside the per-tick pacing wait
    const revokedAt = Date.now();
    leases.revoke(lease, 'owner_stop');
    await assert.rejects(seq, LeaseRevokedError);
    await new Promise((r) => setTimeout(r, 150));
    const clicks = client.written.filter((w) => w.name === 'window_click');
    assert.equal(clicks.length, 1);
    assert.ok(clicks.every((c) => c.atMs <= revokedAt));
  });

  it('a window that opens after revocation is closed even when a newer lease exists, and never adopted by it', async () => {
    for (const newer of [false, true]) {
      const { leases } = harness();
      const client = fakeClient();
      const window = { id: 7 };
      const session = fakeSession(client, { currentWindow: null, closeWindow: (w: { id: number }) => client.write('close_window', { windowId: w.id }) });
      const lease = leases.acquire({ kind: 'diagnostic', diagnosticId: 'diag-1' });
      const act = new Actuator(session, lease, systemClock);
      const opening = act.openBlockWindow({ x: 0, y: 0, z: 0 }, 'up', 2_000).catch((e: unknown) => e);
      await tick(60); // look done, use packet sent, waiting for open_window
      leases.revoke(lease, 'owner_stop');
      const fresh = newer ? leases.acquire({ kind: 'diagnostic', diagnosticId: 'diag-2' }) : undefined;
      const freshAct = fresh ? new Actuator(session, fresh, systemClock) : undefined;
      (session.bot as unknown as { currentWindow: unknown }).currentWindow = window;
      client.emit('open_window', { windowId: 7, inventoryType: 2 });
      await tick(20);
      assert.ok((await opening) instanceof LeaseRevokedError);
      const closes = client.written.filter((w) => w.name === 'close_window' && w.data['windowId'] === 7).length;
      assert.equal(closes, 1, 'the late reply belongs to the revoked request and is closed');
      if (freshAct) assert.equal(freshAct.ownsWindow(7), false, 'the newer lease does not adopt the old reply');
    }
  });
});

describe('interfaces opened as a side effect', () => {
  it('a window opened by our own use packet is adopted and closed when the lease ends', async () => {
    const { leases } = harness();
    const client = fakeClient();
    const session = fakeSession(client, { closeWindow: (w: { id: number }) => client.write('close_window', { windowId: w.id }) });
    const lease = leases.acquire({ kind: 'diagnostic', diagnosticId: 'diag-1' });
    const act = new Actuator(session, lease, systemClock);
    await act.useOnBlock({ x: 0, y: 0, z: 0 }, 'up');
    client.emit('open_window', { windowId: 3, inventoryType: 12 }); // e.g. a crafting table opened instead of placing
    (session.bot as unknown as { currentWindow: unknown }).currentWindow = { id: 3 };
    assert.equal(act.ownsWindow(3), true);
    leases.revoke(lease, 'completed');
    assert.equal(client.written.filter((w) => w.name === 'close_window' && w.data['windowId'] === 3).length, 1);
  });
});

describe('skill executor revalidation and cancellation', () => {
  const clicks: SkillDefinition<{ serverStated?: boolean | undefined }> = {
    descriptor: {
      id: 'test_clicks',
      family: 'test',
      purpose: 'test skill',
      parameters: [],
      preconditions: [],
      effects: [],
      supportedPredicates: [],
      timeoutMs: 10_000,
      cancellation: 'fenced',
      limitations: [],
    },
    params: z.object({ serverStated: z.boolean().optional() }).strict(),
    resolve: () => ({ drafts: [] }),
    async execute(ctx) {
      for (let i = 0; i < 20; i += 1) {
        await ctx.act.click(36, 0, 0, 0);
        ctx.progress({ clicks: i + 1 }); // client-model progress (local provenance)
        if (i === 0 && ctx.candidate.parameters['serverStated'] === true) ctx.progress({ serverEffect: 1 }, 'server_packet');
      }
      return { status: 'succeeded', effect: 'done', confirmation: 'none' };
    },
  };

  function executor(goalEpoch = { value: 1 }) {
    const { leases } = harness(goalEpoch);
    const client = fakeClient();
    const session = fakeSession(client);
    const services = {
      perception: new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 8, travelRadius: 32 }),
      knowledge: new VersionKnowledge({ version: '26.1.2' }),
      ledger: new EvidenceLedger(systemClock),
      clock: systemClock,
      limits: { observationRadius: 8, travelRadius: 32, ownerLossMs: 1_000 },
    } satisfies SkillServices;
    const exec = new SkillExecutorImpl({ registry: new SkillRegistry([clicks]), leases, session: () => session, services, goalEpoch: () => goalEpoch.value, store: new MemoryRunStore(), settleMs: 10 });
    services.perception.admitTravelAnchor(goalEpoch.value); // goal admission (SkillRuntime.onGoalAdmitted)
    return { exec, leases, client };
  }

  const candidate = (goalEpoch: number, parameters: Record<string, boolean> = {}): ActionCandidate => ({
    id: 'act-0001',
    capability: 'test_clicks',
    parameters,
    snapshotId: 'snap-0001',
    connectionEpoch: 1,
    goalEpoch,
    description: 'test',
    criteria: [],
    preconditions: [],
    timeoutMs: 10_000,
  });

  it('abort revokes the lease, stops further commands, reports partial progress and releases control', async () => {
    const { exec, leases, client } = executor();
    const abort = new AbortController();
    const done = exec.execute(candidate(1), abort.signal, goalOwner(1));
    await new Promise((r) => setTimeout(r, 140));
    abort.abort();
    const outcome = await done;
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.evidence['commandsAfterRevoke'], 0);
    const local = outcome.evidence['localProgress'] as Record<string, unknown>;
    const progressed = Number(local['clicks']);
    assert.ok(progressed >= 1 && progressed < 20, `partial progress ${progressed}`);
    assert.equal(outcome.confirmation, 'none', 'client-model progress never makes a cancelled result server-confirmed');
    assert.equal(outcome.evidence['clicks'], undefined, 'local progress is labeled, not reported as a confirmed effect');
    const partial = outcome.evidence['partialEffects'] as Record<string, unknown>;
    assert.equal(partial['confirmed'], 'none');
    assert.equal(partial['additional'], 'unknown', 'clicks were written with no server confirmation: their effects are unknown');
    assert.ok(Number(partial['commandsAfterLastConfirmation']) >= 1);
    assert.ok((outcome.evidence['cleanup'] as { clearMs: number }).clearMs <= 5);
    assert.equal(leases.current, undefined, 'control released');
    const before = client.written.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(client.written.length, before, 'no late clicks');
  });

  it('a cancelled action is server-confirmed only by server-stated partial effects', async () => {
    const { exec } = executor();
    const abort = new AbortController();
    const done = exec.execute(candidate(1, { serverStated: true }), abort.signal, goalOwner(1));
    await new Promise((r) => setTimeout(r, 140));
    abort.abort();
    const outcome = await done;
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.confirmation, 'server_packet');
    assert.equal(outcome.evidence['serverEffect'], 1);
    const partial = outcome.evidence['partialEffects'] as Record<string, unknown>;
    assert.equal(partial['confirmed'], 'server_packet', 'the confirmed prior effect is reported as confirmed');
    assert.equal(partial['additional'], 'unknown', 'later clicks after that confirmation are reported as unknown, not confirmed');
    assert.match(outcome.effect, /UNKNOWN effects/);
  });

  it('stale candidates never acquire control', async () => {
    const epoch = { value: 2 };
    const { exec, leases, client } = executor(epoch);
    const outcome = await exec.execute(candidate(1), new AbortController().signal, goalOwner(1));
    assert.equal(outcome.status, 'precondition_failed');
    assert.equal(outcome.reason, 'stale_goal_epoch');
    assert.equal(leases.current, undefined);
    assert.equal(client.written.length, 0);
  });

  it('a second owner is refused while the lease is held', async () => {
    const { exec } = executor();
    const first = exec.execute(candidate(1), new AbortController().signal, { kind: 'diagnostic', diagnosticId: 'diag-1' });
    await tick(5);
    const second = await exec.execute(candidate(1), new AbortController().signal, { kind: 'diagnostic', diagnosticId: 'diag-2' });
    assert.equal(second.status, 'precondition_failed');
    assert.equal(second.reason, 'actuator_busy');
    await first;
  });
});
