// P-TASK-R17: a task must not declare a terminal "nothing actionable" blocker on
// a completion evaluation that is OLDER than the observation that found nothing
// actionable. Actual composition: real PerceptionService, ServerEvidence,
// PredicateEngine (correlated resync + barrier ack), registered resolvers
// (mine_block/move_near/pickup_item), candidate generator, executor and
// TaskRuntime over a Mineflayer-shaped bot using the installed 26.1.2 registry.
//
// Installed vanilla ordering reproduced by the fake server (one tick): the
// resync `window_items` and the barrier ack are sent while the server handles
// this connection's packets; the item pickup happens later in the SAME tick's
// entity phase, so `collect`, `entity_destroy` and `set_slot` arrive AFTER the
// ack. That is exactly the actual 261 J2 round 6 (task-9117a8e2bdee): the
// evaluation counted 2/3 logs, the next snapshot no longer had the drop, the
// task ended blocked/no_candidates 60 ms after its own mining action, and the
// server then held 3 logs (J4 consumed 3 oak_log, server-confirmed).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, systemClock, type AdmittedTask, type DecisionPort } from '../src/contracts/index.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
import { clearSharedControls, SkillExecutorImpl } from '../src/execution/executor.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { PredicateEngine } from '../src/execution/predicates.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { allSkills } from '../src/skills/index.ts';
import { TaskRuntime } from '../src/tasks/task-runtime.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2 } from './skill-fakes.ts';

const LOG = REGISTRY_26_1_2.itemsByName['oak_log']!.id;
const DROP = 4081;

/**
 * `counts[i]` is the server's log count answered to the i-th correlated
 * resync; `pickupAfter` is the resync after which the server-side pickup
 * (collect/destroy/set_slot) follows in the same tick. `blockedRechecks`
 * makes later resyncs unanswered (state unknown).
 */
function scene(opts: { counts: number[]; pickupAfter?: number; noDrop?: boolean; unanswered?: number[]; revokeOnResync?: number; mode?: 'complete' | 'maintain' }) {
  let resyncs = 0;
  let logs = 0;
  let current = true;
  const writes: string[] = [];
  const client = fakeClient((name, data) => {
    writes.push(name);
    if (name === 'window_click' && data['stateId'] === -1) {
      resyncs += 1;
      logs = opts.counts[Math.min(resyncs - 1, opts.counts.length - 1)]!;
      if (resyncs === opts.revokeOnResync) current = false;
      return;
    }
    if (name === 'block_dig' && typeof data['sequence'] === 'number') {
      const n = resyncs, sequenceId = data['sequence'];
      setImmediate(() => {
        // Network phase: full inventory state for the resync, then the barrier ack.
        if (!opts.unanswered?.includes(n)) {
          const items = Array.from({ length: 46 }, (_, i) => (i === 36 && logs > 0 ? { itemCount: logs, itemId: LOG } : { itemCount: 0 }));
          client.emit('window_items', { windowId: 0, stateId: 10 + n, items });
        }
        client.emit('acknowledge_player_digging', { sequenceId });
        // Entity phase of the same tick: the bot touches the drop (pickup delay expired).
        if (n === opts.pickupAfter) {
          client.emit('collect', { collectedEntityId: DROP, collectorEntityId: 1, pickupItemCount: 1 });
          delete (fake.bot.entities as Record<number, unknown>)[DROP];
          client.emit('entity_destroy', { entityIds: [DROP] });
          logs += 1;
          client.emit('set_slot', { windowId: 0, stateId: 50 + n, slot: 36, item: { itemCount: logs, itemId: LOG } });
        }
      });
    }
  });
  // Actual J2 geometry translated by (-208, +60, -202): all three logs already
  // broken; bot feet at 208.5,-60,203.5; the last drop inside the broken cell.
  const fake = fakeMineflayerBot(client, { loaded: 48, at: { x: 0.5, y: 0, z: 1.5 } });
  fake.fill(-20, -1, -20, 20, -1, 20, 'grass_block');
  if (!opts.noDrop) {
    const drop = fake.addEntity({ id: DROP, type: 'other', name: 'item', at: { x: 0.5, y: 0.25, z: 0.5 }, height: 0.25 });
    Object.assign(drop, { getDroppedItem: () => ({ name: 'oak_log', count: 1 }) });
  }
  Object.assign(fake.bot, { pathfinder: { setGoal: () => undefined, setMovements: () => undefined, isMoving: () => false }, clearControlStates: () => undefined, stopDigging: () => undefined });
  const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never);
  evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const ids = sequentialIds();
  const store = new MemoryRunStore();
  const perception = new PerceptionService({ session: () => session, clock: systemClock, ids, observationRadius: 32, travelRadius: 128 });
  assert.equal(perception.admitTravelAnchor(3), true);
  const registry = new SkillRegistry(allSkills());
  const services = { perception, knowledge: new VersionKnowledge({ version: '26.1.2', catalog: () => registry.catalog() }), ledger: new EvidenceLedger(systemClock, () => 1), clock: systemClock, limits: { travelRadius: 128, observationRadius: 32, ownerLossMs: 1_000 } };
  const abort = new AbortController();
  const task: AdmittedTask = {
    goalId: 'goal-b01423cfe011', goalEpoch: 3, taskId: 'task-9117a8e2bdee', mode: opts.mode ?? 'complete', signal: abort.signal, isCurrent: () => current && !abort.signal.aborted,
    spec: {
      objective: 'Collect three oak logs from the visible tree.',
      decisionInstruction: 'Mine visible logs, moving closer first when they are out of reach, and pick up dropped logs.',
      allowedCapabilities: ['mine_block', 'move_near', 'pickup_item'],
      targetSelectors: [{ kind: 'registry', key: '#minecraft:logs' }],
      completion: { predicate: 'inventory_delta', selector: '#minecraft:logs', atLeast: 3, mayBeConsumedLater: true },
    } as AdmittedTask['spec'],
  };
  const leases = new ActuatorLeases({ clock: systemClock, ownerCurrent: () => task.isCurrent(), connectionEpoch: () => 1, clearShared: () => clearSharedControls(fake.bot as never) });
  const executor = new SkillExecutorImpl({ registry, leases, session: () => session, services, goalEpoch: () => 3, store, settleMs: 0 });
  const candidates = new TaskCandidateGenerator({ registry, services, session: () => session, ids });
  const predicates = new PredicateEngine({ services, session: () => session, leases });
  let decisions = 0;
  const decision: DecisionPort = { readiness: () => ({ ready: true, detail: 'scripted' }), choose: async () => { decisions += 1; throw new Error('no Jev call is expected in this control'); } };
  const kinds: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const runtime = new TaskRuntime({
    perception, candidates, executor, predicates, decision,
    sustained: (id) => registry.get(id)?.sustained, catalogVersion: () => registry.catalog().catalogVersion, mechanicsVersion: '26.1.2', connectionEpoch: () => 1,
    model: 'typesafe/jev-1.13', store, clock: systemClock, ids,
    limits: { maxOptions: 8, noProgressMs: 120_000, perTargetRetries: 2, lowHealth: 6 },
    emit: (kind, data) => kinds.push({ kind, data }),
  });
  return { runtime, task, kinds, writes, resyncs: () => resyncs, decisions: () => decisions, revoke: () => { current = false; }, abort, store };
}

describe('P-TASK-R17 terminal blocker freshness (actual composition)', () => {
  it('own drop collected in the same server tick after the resync: re-verified completion, never a stale no_candidates blocker', async () => {
    // Resync 1 = task baseline (0); resync 2 = round evaluation (2/3), pickup follows in the same tick.
    const s = scene({ counts: [0, 2, 3], pickupAfter: 2 });
    const result = await s.runtime.run(s.task);
    assert.equal(result.status, 'completed', `${result.status}/${result.reason}: ${result.detail}`);
    assert.equal(result.reason, 'completion_verified');
    assert.match(result.detail, /acquired 3\/3/);
    assert.equal(s.decisions(), 0, 'no inference, no action, no retry');
    assert.equal(result.actions, 0);
    assert.equal(s.resyncs(), 3, 'exactly one additional correlated server read');
    const recheck = s.kinds.find((k) => k.kind === 'task_completion' && k.data['recheck'] === 'before_terminal');
    assert.ok(recheck && recheck.data['status'] === 'satisfied');
  });

  it('genuinely absent drop and an unchanged count: the same honest blocker after exactly one fresh read (no hidden lookup, no wait loop)', async () => {
    const s = scene({ counts: [0, 2, 2], noDrop: true });
    const result = await s.runtime.run(s.task);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'no_candidates');
    assert.match(result.detail, /mine_block: no_visible_target; move_near: no_grounded_destination; pickup_item: no_visible_drop/);
    assert.equal(s.resyncs(), 3, 'one fresh read, never a loop');
    assert.equal(s.decisions(), 0);
    assert.equal(result.rounds, 1, 'the check is not a new round');
    assert.equal(result.feedback.completion?.detail, 'acquired 2/3 #minecraft:logs since admission');
    const recheck = s.kinds.find((k) => k.kind === 'task_completion' && k.data['recheck'] === 'before_terminal');
    assert.equal(recheck?.data['status'], 'unsatisfied');
  });

  it('an unanswered fresh read (state unknown) never completes and keeps the honest blocker', async () => {
    const s = scene({ counts: [0, 2, 3], pickupAfter: 2, unanswered: [3] });
    const result = await s.runtime.run(s.task);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'no_candidates');
    assert.equal(result.feedback.completion?.status, 'unknown');
    assert.equal(s.decisions(), 0);
  });

  it('ownership revoked during the fresh read: no completion or blocker is claimed by a revoked task', async () => {
    const s = scene({ counts: [0, 2, 3], pickupAfter: 2, revokeOnResync: 3 });
    const result = await s.runtime.run(s.task);
    assert.equal(result.status, 'cancelled', `${result.status}/${result.reason}`);
    assert.ok(!s.kinds.some((k) => k.kind === 'task_terminal' && ['completed', 'blocked'].includes(String(k.data['status']))));
  });

  it('maintain mode: a fresh satisfied read returns to the ordinary hold instead of a blocker', async () => {
    const s = scene({ counts: [0, 2, 3], pickupAfter: 2, mode: 'maintain' });
    const run = s.runtime.run(s.task);
    const deadline = Date.now() + 3_000;
    while (!s.kinds.some((k) => k.kind === 'task_holding') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    s.abort.abort();
    const result = await run;
    assert.ok(s.kinds.some((k) => k.kind === 'task_holding'), 'held the satisfied maintained condition');
    assert.notEqual(result.reason, 'no_candidates');
  });
});
