import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { SpendLedger, type SpendSnapshot } from '../src/decision/spend.ts';
import { CHECKPOINT_SEMANTICS, CheckpointAccounting, ManagedCheckpointStore, SemanticGoalSchema, portableOutcome, type CheckpointScope } from '../src/updates/checkpoints/index.ts';

const roots: string[] = [];
after(() => { for (const p of roots) rmSync(p, { recursive: true, force: true }); });
const scope: CheckpointScope = { worldProfile: 'independent-accounting', worldRevision: 1, botProfile: 'dummy', semantics: CHECKPOINT_SEMANTICS };
function options() {
  mkdirSync('var', { recursive: true }); const dir = mkdtempSync(resolve('var/checkpoint-spend-unit-')); roots.push(dir);
  return { dir, scope, sessionId: 'same-budget', now: () => 2_000 };
}
function fresh(capUsd = 1) {
  const o = options(); const store = new ManagedCheckpointStore(o); store.open();
  store.createSession({ authorization: 'explicit_operator_new_session', capUsd, onlineIntent: true, paused: false, allowances: [] });
  const ledger = new SpendLedger(capUsd);
  const accounting = new CheckpointAccounting(store, () => ledger);
  return { o, store, ledger, accounting };
}

test('real SpendLedger reservations reach disk before dispatch and valid reconciliation persists actual charges', () => {
  const { store, accounting } = fresh();
  assert.equal(accounting.capUsd, 1, 'the actual Jev readiness port reads this cap');
  const r = accounting.reserve(0.001344, 'do-not-store-label')!;
  assert.equal(store.snapshot()!.spend.outstandingUsd, r.amountUsd);
  accounting.beforeDispatch(r); accounting.reconcile(r, 0.0001);
  assert.equal(store.snapshot()!.spend.reconciledUsd, 0.0001);
  assert.equal(store.snapshot()!.spend.outstandingUsd, 0);
  assert.equal(accounting.remainingUsd(), 0.9999); store.close();
});

test('recovery turns all unknown in-flight charges into retained maximum and keeps the original cap', () => {
  const { o, store, accounting } = fresh(0.1);
  accounting.reserve(0.04, 'one'); accounting.reserve(0.04, 'two'); store.close();
  const r = new ManagedCheckpointStore(o); assert.equal(r.open().status, 'ready');
  const s = r.snapshot()!.spend;
  assert.equal(s.capUsd, 0.1); assert.equal(s.retainedUsd, 0.08); assert.equal(s.outstandingUsd, 0);
  assert.equal(s.attempts, 2); assert.equal(s.retained, 2);
  assert.ok(Math.abs(s.remainingUsd - 0.02) < 1e-12);
  // Until the integration-owned restore seam exists, a fresh ledger is REFUSED.
  assert.throws(() => new CheckpointAccounting(r, () => new SpendLedger(0.1)), /restored_accounting_mismatch/);
  r.close(); const again = new ManagedCheckpointStore(o); again.open(); assert.deepEqual(again.snapshot()!.spend, s); again.close();
});

test('exhaustion, explicit no-inference refunds, attempts and ambiguous failures retain their exact accounting', () => {
  const { o, store, accounting } = fresh(0.05);
  const rejected = accounting.reserve(0.02, 'rejected')!; accounting.release(rejected);
  const charge = accounting.reserve(0.03, 'ambiguous')!; accounting.retain(charge);
  const paid = accounting.reserve(0.02, 'valid')!; accounting.reconcile(paid, 0.02);
  assert.equal(accounting.reserve(0.001, 'exhausted'), undefined);
  const expected = accounting.snapshot(); assert.ok(Math.abs(expected.remainingUsd) < 1e-12); assert.equal(expected.released, 1); assert.equal(expected.refused, 1);
  store.close(); const after = new ManagedCheckpointStore(o); after.open(); assert.deepEqual(after.snapshot()!.spend, expected); after.close();
});

test('stale/forged/double settlements and logout do not free reservations or dispatch a request', () => {
  const { store, accounting } = fresh(); const r = accounting.reserve(0.02, 'real')!;
  assert.throws(() => accounting.release({ ...r, amountUsd: 0.01 }), /forged/);
  accounting.retain(r); assert.throws(() => accounting.release(r), /forged/);
  const next = accounting.reserve(0.02, 'next')!; store.control('logout');
  assert.throws(() => accounting.beforeDispatch(next), /replaced_or_revoked/);
  assert.throws(() => accounting.release(next), /replaced_or_revoked/);
  assert.equal(store.snapshot()!.spend.outstandingUsd, 0.02); store.close();
});

test('invalid provider-reported cost retains full maximum and permanently disables the provider', () => {
  const { o, store, accounting } = fresh(); const r = accounting.reserve(0.03, 'bad')!;
  assert.throws(() => accounting.reconcile(r, 0.5), /untrustworthy/);
  assert.equal(store.snapshot()!.spend.retainedUsd, 0.03);
  assert.equal(store.snapshot()!.providerDisabled.decision, 'untrustworthy_reported_cost');
  assert.throws(() => accounting.reserve(0.01, 'disabled'), /not_authorized/);
  store.close(); const after = new ManagedCheckpointStore(o); after.open(); assert.equal(after.snapshot()!.providerDisabled.decision, 'untrustworthy_reported_cost'); after.close();
});

test('failed durable reservation cannot return a dispatch permit', () => {
  const o = options(); let shouldFail = false;
  const store = new ManagedCheckpointStore({ ...o, fault: (point) => { if (shouldFail && point === 'after_file_sync') throw new Error('disk injection'); } });
  store.open(); store.createSession({ authorization: 'explicit_operator_new_session', capUsd: 1, onlineIntent: true, paused: false, allowances: [] });
  const accounting = new CheckpointAccounting(store, () => new SpendLedger(1)); shouldFail = true;
  let dispatched = false;
  assert.throws(() => { const permit = accounting.reserve(0.1, 'request'); if (permit) dispatched = true; }, /disk injection/);
  assert.equal(dispatched, false); assert.equal(store.resumeView().kind, 'held'); store.close();
  const after = new ManagedCheckpointStore(o); assert.equal(after.open().status, 'held'); assert.equal(after.resumeView().kind, 'held'); after.close();
});

test('real owned child dies during provider I/O; recovery never silently starts a fresh spend cap', () => {
  const { o, store } = fresh(0.1); store.close();
  const entry = resolve('src/updates/checkpoints/index.ts'); const spend = resolve('src/decision/spend.ts');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ManagedCheckpointStore, CheckpointAccounting } from ${JSON.stringify(entry)};
    import { SpendLedger } from ${JSON.stringify(spend)};
    const s = new ManagedCheckpointStore({...${JSON.stringify(o)}, now:()=>2000}); if(s.open().status!=='ready') process.exit(74);
    const a = new CheckpointAccounting(s, ()=>new SpendLedger(0.1));
    const r = a.reserve(0.08,'dummy-provider'); a.beforeDispatch(r);
    // Fake provider in flight: no socket, secret or inference involved.
    process.exit(73);
  `], { env: { PATH: process.env['PATH'] }, timeout: 10_000, encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  const after = new ManagedCheckpointStore(o); assert.equal(after.open().status, 'ready');
  assert.equal(after.snapshot()!.spend.retainedUsd, 0.08); assert.equal(after.snapshot()!.spend.capUsd, 0.1);
  assert.equal(after.resumeView().kind, 'held');
  assert.throws(() => after.bindChild(), /explicit_start/); after.close();
  const onceMore = new ManagedCheckpointStore(o); onceMore.open();
  assert.equal(onceMore.resumeView().kind, 'held', 'unclean hold survives another graceful restart');
  assert.throws(() => onceMore.bindChild(), /explicit_start/);
  onceMore.control('start'); assert.equal(onceMore.resumeView().kind, 'idle');
  assert.equal(onceMore.snapshot()!.spend.retainedUsd, 0.08); onceMore.close();
});

test('ledger mutations outside the owned adapter and fabricated restore snapshots fail closed', () => {
  const { store, ledger, accounting } = fresh(); ledger.reserve(0.05, 'bypass');
  assert.throws(() => accounting.reserve(0.01, 'cannot-dispatch'), /outside_adapter/); store.close();
  const { store: other } = fresh();
  const forged = new SpendLedger(1);
  const initial = forged.snapshot();
  forged.snapshot = (): SpendSnapshot => ({ ...initial, remainingUsd: 2 });
  assert.throws(() => new CheckpointAccounting(other, () => forged)); other.close();
});

test('managed child replacement and rollback retain ambiguous charges without restarting the manager or budget', () => {
  const { store, accounting } = fresh(0.1);
  const pending = accounting.reserve(0.08, 'old-child')!;
  const checkpoint = store.prepareReplacement({ expectedGeneration: 0, cleanup: 'owned_child_settled' });
  assert.equal(checkpoint.spend.retainedUsd, 0.08); assert.equal(checkpoint.spend.outstandingUsd, 0);
  assert.equal(checkpoint.spend.capUsd, 0.1); assert.equal(checkpoint.spend.retained, 1);
  assert.throws(() => accounting.beforeDispatch(pending), /replaced_or_revoked/);
  assert.throws(() => accounting.release(pending), /replaced_or_revoked/);
  const rollback = store.prepareReplacement({ expectedGeneration: 0, cleanup: 'owned_child_settled' });
  assert.deepEqual(rollback.spend, checkpoint.spend);
  store.control('logout');
  assert.throws(() => store.prepareReplacement({ expectedGeneration: 0, cleanup: 'owned_child_settled' }), /generation_or_cleanup/);
  assert.equal(store.resumeView().kind, 'offline'); store.close();
});

test('new directive uses the same child ledger; prior-generation permits cannot dispatch or refund', () => {
  const { store, accounting } = fresh(0.1);
  const previous = accounting.reserve(0.03, 'previous-directive')!;
  store.control('directive');
  assert.throws(() => accounting.beforeDispatch(previous), /revoked_reservation/);
  assert.throws(() => accounting.release(previous), /revoked_reservation/);
  const current = accounting.reserve(0.03, 'current-directive')!;
  accounting.beforeDispatch(current); accounting.reconcile(current, 0.01);
  // A trustworthy late cost is accounting only, never a goal/action result.
  accounting.reconcile(previous, 0.02);
  assert.equal(store.snapshot()!.spend.reconciledUsd, 0.03);
  assert.equal(store.resumeView().kind, 'held', 'no semantic goal result was forged'); store.close();
});

test('a crash committing an invalid provider cost cannot lose the disabled flag while retaining its charge', () => {
  const { o, store } = fresh(0.1); store.close();
  const entry = resolve('src/updates/checkpoints/index.ts'); const spend = resolve('src/decision/spend.ts');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ManagedCheckpointStore, CheckpointAccounting } from ${JSON.stringify(entry)};
    import { SpendLedger } from ${JSON.stringify(spend)};
    let crash=false;
    const s = new ManagedCheckpointStore({...${JSON.stringify(o)}, now:()=>2000,
      fault:(point)=>{if(crash&&point==='after_directory_sync') process.exit(73)}});
    if(s.open().status!=='ready') process.exit(74);
    const a=new CheckpointAccounting(s,()=>new SpendLedger(0.1));
    const r=a.reserve(0.03,'dummy-invalid-provider'); crash=true; a.reconcile(r,0.5);
  `], { env: { PATH: process.env['PATH'] }, timeout: 10_000, encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  const after = new ManagedCheckpointStore(o); assert.equal(after.open().status, 'ready');
  assert.equal(after.snapshot()!.spend.retainedUsd, 0.03);
  assert.equal(after.snapshot()!.providerDisabled.decision, 'untrustworthy_reported_cost'); after.close();
});

test('goal decision attempt and charge commit together, so a provider-I/O crash refills neither allowance', () => {
  const { o, store } = fresh();
  const generation = store.control('directive');
  store.captureGoal({ expectedGeneration: generation, goal: SemanticGoalSchema.parse({
    goalId: 'same-goal', instruction: 'stay near the owner', origin: { surface: 'chat', principal: 'owner' },
    admittedAtMs: 1_000, deadlineAtMs: 10_000,
    ...portableOutcome({ kind: 'persistent', maintain: { predicate: 'near_target', target: { kind: 'owner' }, within: 3 } }, true),
    admissionBaseline: { capturedAtMs: 1_001, counts: {}, detail: 'server confirmed at original admission' }, anchor: null,
    counters: { plannerTurns: 1, knowledgeRounds: 0, repairs: 0, retries: 0, questionRefusals: 0, replans: 0, windows: 1, tasksAdmitted: 1, preparationTurns: 0, lookaheads: 0 },
    caps: { plannerTurns: 12, tasks: 32, replans: 8 }, admittedTasks: 1, counts: [], verifiedEffects: [], continuations: { used: 0, max: 2 },
    allowances: [{ key: 'decision_attempts', limit: 2, used: 1, deadlineAtMs: 10_000, disabled: null }], route: null,
  }) });
  const current = new CheckpointAccounting(store, () => new SpendLedger(1));
  assert.throws(() => current.reserve(0.03, 'unbound'), /goal_decision_context_required/);
  assert.throws(() => current.reserve(0.03, 'wrong-owner', { goalId: 'another-goal', expectedGeneration: generation }), /decision_owner/);
  assert.equal(store.snapshot()!.spend.attempts, 0); store.close();
  const entry = resolve('src/updates/checkpoints/index.ts'); const spend = resolve('src/decision/spend.ts');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { ManagedCheckpointStore, CheckpointAccounting } from ${JSON.stringify(entry)};
    import { SpendLedger } from ${JSON.stringify(spend)};
    const s=new ManagedCheckpointStore({...${JSON.stringify(o)}, now:()=>2000}); if(s.open().status!=='ready') process.exit(74);
    const a=new CheckpointAccounting(s,()=>new SpendLedger(1));
    const r=a.reserve(0.03,'dummy-goal-provider',{goalId:'same-goal',expectedGeneration:${generation}});
    a.beforeDispatch(r); process.exit(73);
  `], { env: { PATH: process.env['PATH'] }, timeout: 10_000, encoding: 'utf8' });
  assert.equal(child.status, 73, child.stderr);
  const after = new ManagedCheckpointStore(o); assert.equal(after.open().status, 'ready');
  assert.equal(after.snapshot()!.spend.retainedUsd, 0.03);
  assert.equal(after.snapshot()!.goal!.allowances[0]!.used, 2);
  assert.equal(after.snapshot()!.goal!.allowances[0]!.limit, 2);
  assert.throws(() => after.checkDecisionOwner({ goalId: 'same-goal', expectedGeneration: generation }), /allowance_not_available/); after.close();
});
