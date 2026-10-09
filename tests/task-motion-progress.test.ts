// Internal receipt adverse controls complement the production gameplay test;
// arbitrary SkillOutcome evidence is deliberately not an input to this seam.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActionCandidate, AdmittedTask } from '../src/contracts/index.ts';
import type { OwnedMotionSample } from '../src/execution/executor.ts';
import { TaskMotionProgress } from '../src/tasks/motion-progress.ts';

function harness() {
  const observers = new Set<(s: OwnedMotionSample) => void>();
  let current = true, guidance: { authorityId: string; bearingRad: number } | undefined = { authorityId: 'route-original', bearingRad: 0 };
  const abort = new AbortController();
  const task: AdmittedTask = { goalId: 'goal-original', goalEpoch: 7, taskId: 'task-original', mode: 'maintain', spec: { objective: 'An open-ended task', decisionInstruction: 'Use an offered option', allowedCapabilities: ['seek_owner'], targetSelectors: [{ kind: 'owner' }], parameters: {}, completion: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } }, signal: abort.signal, isCurrent: () => current };
  const candidate = { id: 'act-current', capability: 'seek_owner', connectionEpoch: 3, goalEpoch: 7 } as ActionCandidate;
  const progress = new TaskMotionProgress({ executor: { observeMotion: (f) => { observers.add(f); return () => { observers.delete(f); }; } }, guidance: () => guidance });
  const receipts: Array<{ atMs: number; netProgress: number; provenance: 'client_only' }> = [];
  const sample = (x: number, atMs: number, changes: Partial<OwnedMotionSample> = {}) => {
    const s: OwnedMotionSample = { actionId: candidate.id, capability: candidate.capability, owner: { kind: 'goal', goalId: task.goalId, goalEpoch: task.goalEpoch, taskId: task.taskId }, leaseId: 1, connectionEpoch: 3, dimension: 'overworld', self: { x, y: 0, z: 0 }, atMs, correctionSeq: 0, commandsIssued: 1, ...changes };
    for (const f of observers) f(s);
  };
  return { task, candidate, progress, receipts, sample, watch: () => progress.watch(task, candidate, (r) => receipts.push(r)), stale: () => { current = false; }, abort, cue: (g: typeof guidance) => { guidance = g; }, listeners: () => observers.size };
}

describe('owned motion progress receipt fences and conservative accounting', () => {
  it('two actual sampled blocks create only a client receipt; elapsed/empty/sidestep motion does not', () => {
    const h = harness(), unwatch = h.watch();
    h.sample(0, 0); h.sample(0, 100); h.sample(0, 200, { self: { x: 0, y: 0, z: 5 } }); h.sample(0, 300);
    assert.equal(h.receipts.length, 0);
    h.sample(2, 400); assert.deepEqual(h.receipts, [{ atMs: 400, netProgress: 2, provenance: 'client_only' }]);
    unwatch(); assert.equal(h.listeners(), 0); h.sample(4, 500); assert.equal(h.receipts.length, 1);
  });
  it('retreat/retrace cannot refill progress across windows, cue loss or changed bearings', () => {
    const h = harness(); let unwatch = h.watch();
    h.sample(0, 0); h.sample(2, 100); h.sample(4, 200); assert.equal(h.receipts.length, 2);
    unwatch(); // unobserved retreat between actual owned windows
    unwatch = h.watch(); h.sample(0, 300); h.sample(2, 400); h.sample(4, 500);
    assert.equal(h.receipts.length, 2, 'retrace never new progress');
    h.sample(6, 600); assert.equal(h.receipts.length, 3);
    h.cue(undefined); h.sample(0, 700); h.cue({ authorityId: 'route-original', bearingRad: 0 }); h.sample(0, 800); h.sample(6, 900);
    assert.equal(h.receipts.length, 3, 'lost guidance cannot refill');
    h.cue({ authorityId: 'route-original', bearingRad: Math.PI }); h.sample(6, 1_000); h.sample(0, 1_100); h.sample(-2, 1_200);
    assert.equal(h.receipts.length, 3, 'changing cue cannot re-credit a spatial loop');
    unwatch();
  });
  it('large gaps and server position corrections cannot inflate client-only progress', () => {
    const h = harness(), unwatch = h.watch();
    h.sample(0, 0); h.sample(100, 100, { correctionSeq: 1 }); assert.equal(h.receipts.length, 0);
    h.sample(102, 200, { correctionSeq: 1 }); assert.equal(h.receipts.length, 1);
    assert.equal(h.receipts[0]!.netProgress, 2, 'correction displacement excluded');
    h.sample(200, 2_000, { correctionSeq: 1 }); assert.equal(h.receipts.length, 1);
    h.sample(202, 2_100, { correctionSeq: 1 }); assert.equal(h.receipts[1]!.netProgress, 4, 'gap displacement excluded');
    unwatch();
  });
  it('both fresh bearings must support progress and a replaced grant cannot reset the high-water mark', () => {
    const h = harness(), unwatch = h.watch();
    h.sample(0, 0); h.cue({ authorityId: 'route-original', bearingRad: Math.PI }); h.sample(4, 100);
    assert.equal(h.receipts.length, 0);
    h.cue({ authorityId: 'refilled-route', bearingRad: 0 }); h.sample(4, 200); h.sample(8, 300);
    assert.equal(h.receipts.length, 0); unwatch();
  });
  it('only current action, owner/task/epoch, connection and lease samples can advance the guard', () => {
    const cases: Partial<OwnedMotionSample>[] = [
      { actionId: 'act-other' }, { capability: 'mine_block' }, { connectionEpoch: 4 }, { leaseId: 2 },
      { owner: { kind: 'goal', goalId: 'goal-foreign', goalEpoch: 7, taskId: 'task-original' } },
      { owner: { kind: 'goal', goalId: 'goal-original', goalEpoch: 8, taskId: 'task-original' } },
      { owner: { kind: 'goal', goalId: 'goal-original', goalEpoch: 7, taskId: 'task-other' } },
      { owner: { kind: 'diagnostic', diagnosticId: 'diag-other' } },
      { owner: { kind: 'safety', grantId: 'safety-other', episodeId: 'episode-other', connectionEpoch: 3 } },
    ];
    for (const change of cases) {
      const h = harness(), unwatch = h.watch(); h.sample(0, 0); h.sample(4, 100, change);
      assert.equal(h.receipts.length, 0, JSON.stringify(change)); unwatch();
    }
    const h = harness(), unwatch = h.watch(); h.sample(0, 0); h.stale(); h.sample(4, 100); h.abort.abort(); h.sample(8, 200);
    assert.equal(h.receipts.length, 0); unwatch();
    const old = harness(); old.candidate.goalEpoch = 8;
    const unwatchOld = old.watch(); old.sample(0, 0); old.sample(4, 100);
    assert.equal(old.receipts.length, 0, 'a stale candidate cannot borrow current task ownership'); unwatchOld();
  });
});
