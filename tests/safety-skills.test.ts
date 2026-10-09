// MB-FLOW-003-C11 (offline, module level): the REAL escape skill and service
// episode through the real Lease/ActuatorLeases/Actuator over a
// Mineflayer-shaped bot, with the INSTALLED prismarine-physics stepping the
// body from the controls the skill actually set. Client-physics evidence only;
// server acceptance stays fixture evidence.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ActionCandidate } from '../src/contracts/index.ts';
import type { SafetyExecutionOwner } from '../src/contracts/safety.ts';
import { fluidState, hasSafeFluidSupport } from '../src/safety/geometry.ts';
import { Actuator } from '../src/execution/actuator.ts';
import { clock } from './safety-session.ts';
import { ownerAuthority, runtime, scene, stopPhysics, until } from './safety-session.ts';

after(stopPhysics);

describe('safety skills over the installed physics (client-physics evidence)', () => {
  for (const y of [3.73802231455, 3.8394]) {
    it(`W-C11-R7: starting at the observed near-surface height ${y}, escapes to settled shore without episode churn`, async () => {
      const sc = scene();
      sc.bot.entity.position.y = y;
      sc.bot.entity.position.x = 0.8762083584;
      sc.bot.entity['onGround'] = false;
      let auth = ownerAuthority();
      const rt = runtime(sc.session, () => auth);
      const before = rt.reader.self()!.fluid;
      assert.equal(before.feetIn, 'none');
      assert.equal(before.eyeIn, 'none');
      assert.equal(before.columnFluid, 'water');
      rt.service.start();
      rt.service.tick();
      assert.ok(await until(() => sc.controls['forward'] === true, 1_000), 'steers toward shore instead of claiming the bob safe');
      assert.equal(rt.service.counters.resolved, 0);
      assert.ok(await until(() => rt.service.episodes().length > 0 && rt.service.hold() === null, 15_000));
      const ep = rt.service.episodes().at(-1)!;
      assert.equal(ep.outcome, 'resolved', ep.detail);
      assert.equal(ep.actions, 1, 'same dispatch covers surfacing, exit and release settlement');
      assert.ok(ep.displacement > 2.5 && ep.displacement <= 24, 'actual horizontal shore travel within the original bound');
      assert.ok(hasSafeFluidSupport(rt.reader.self()!.fluid));
      assert.equal(sc.controls['jump'] || sc.controls['forward'], false);
      for (let n = 0; n < 6; n += 1) {
        await new Promise((r) => setTimeout(r, 250));
        assert.ok(hasSafeFluidSupport(rt.reader.self()!.fluid), 'does not re-sink after controls release');
        assert.equal(rt.service.counters.episodes, 1, 'monitor never starts another water episode');
        assert.equal(rt.leases.current, undefined);
      }
      auth = { ...auth, basis: 'none' };
      await rt.service.close();
    });
  }

  it('stop during a near-surface escape clears every control and never holds the bob up', async () => {
    const sc = scene();
    sc.bot.entity.position.y = 3.73802231455;
    sc.bot.entity['onGround'] = false;
    let auth = ownerAuthority();
    const rt = runtime(sc.session, () => auth);
    rt.service.start();
    rt.service.tick();
    assert.ok(await until(() => sc.controls['jump'] === true, 1_000));
    const grant = (rt.leases.current!.owner as unknown as SafetyExecutionOwner).grantId;
    auth = { ...auth, basis: 'none', goal: null };
    rt.service.onAuthorityChanged('owner_stop');
    assert.equal(sc.controls['jump'] || sc.controls['forward'], false);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(sc.controls['jump'] || sc.controls['forward'], false);
    assert.equal(rt.service.grantCurrent(grant), false);
    assert.equal(rt.leases.current, undefined);
    assert.equal(rt.service.counters.resolved, 0);
    await rt.service.close();
  });

  it('stop during the released-control settlement revokes the old grant before success', async () => {
    const sc = scene();
    sc.bot.entity.position.y = 3.73802231455;
    sc.bot.entity['onGround'] = false;
    let auth = ownerAuthority();
    const rt = runtime(sc.session, () => auth);
    rt.service.tick();
    assert.ok(await until(() => hasSafeFluidSupport(rt.reader.self()!.fluid) && sc.controls['jump'] === false && rt.service.hold()?.reason === 'episode', 15_000));
    const grant = (rt.leases.current!.owner as unknown as SafetyExecutionOwner).grantId;
    auth = { ...auth, basis: 'none', goal: null };
    rt.service.onAuthorityChanged('owner_stop');
    assert.equal(rt.service.grantCurrent(grant), false);
    assert.equal(sc.controls['jump'] || sc.controls['forward'], false);
    assert.ok(await until(() => rt.leases.current === undefined && rt.service.episodes().length > 0, 1_000));
    assert.equal(rt.service.episodes().at(-1)?.outcome, 'revoked');
    assert.equal(rt.service.counters.resolved, 0);
    await rt.service.close();
  });

  it('ordinary goal bounds still refuse a shore outside the admitted radius', async () => {
    const sc = scene();
    sc.bot.entity.position.y = 3.73802231455;
    sc.bot.entity['onGround'] = false;
    const rt = runtime(sc.session, ownerAuthority, { tickMs: 200 }, { travel: { anchor: { x: 0.5, y: 0, z: 0.5 }, radius: 1 } });
    const cand: ActionCandidate = { id: 'act-8002', capability: 'escape_water', parameters: { maxMs: 5_000 }, snapshotId: 'snap-8002', connectionEpoch: 1, goalEpoch: 2, description: 'bounded', criteria: [], preconditions: [], timeoutMs: 6_000 };
    const r = await rt.execute(cand, new AbortController().signal, { kind: 'goal', goalEpoch: 2, goalId: 'goal-0001', taskId: 'task-8002' });
    assert.notEqual(r.status, 'succeeded');
    assert.equal(r.reason, 'no_reachable_exit');
    assert.equal(sc.controls['jump'] || sc.controls['forward'], false);
    assert.equal(rt.service.counters.episodes, 0, 'ordinary work never manufactures a grant');
    await rt.service.close();
  });

  it('dry ground and genuine shallow grounded wading settle with controls released', async () => {
    for (const shallow of [false, true]) {
      const sc = scene({ pool: shallow });
      if (shallow) sc.fake.fill(-3, 1, -3, 3, 3, 3, 'air');
      const rt = runtime(sc.session, ownerAuthority);
      const cand: ActionCandidate = { id: 'act-8001', capability: 'escape_water', parameters: { maxMs: 5_000 }, snapshotId: 'snap-8001', connectionEpoch: 1, goalEpoch: 2, description: 'settle', criteria: [], preconditions: [], timeoutMs: 6_000 };
      const r = await rt.execute(cand, new AbortController().signal, { kind: 'goal', goalEpoch: 2, goalId: 'goal-0001', taskId: 'task-8001' });
      assert.equal(r.status, 'succeeded', r.effect);
      assert.ok(hasSafeFluidSupport(rt.reader.self()!.fluid));
      assert.equal(rt.reader.self()!.fluid.columnFluid, shallow ? 'water' : 'none');
      assert.equal(sc.controls['jump'] || sc.controls['forward'], false);
      await rt.service.close();
    }
  });
  it('the safety service surfaces and exits a 4-deep pool through one fenced lease, preempting the goal lease', async () => {
    const sc = scene();
    let auth = ownerAuthority();
    const rt = runtime(sc.session, () => auth);
    // A goal currently owns the single lease (e.g. a follow window that just ended in water).
    const goalLease = rt.leases.acquire({ kind: 'goal', goalEpoch: 2, goalId: 'goal-0001', taskId: 'task-0001' });
    rt.service.tick();
    assert.equal(goalLease.revocation, 'safety_preempt', 'goal lease preempted synchronously');
    assert.equal(rt.service.hold()?.reason, 'episode');
    const done = await until(() => rt.service.hold() === null, 25_000);
    assert.ok(done, 'episode ended');
    const ep = rt.service.episodes().at(-1)!;
    const p = sc.bot.entity.position;
    const f = fluidState(rt.service.world()!, { x: p.x, y: p.y, z: p.z });
    assert.equal(f.feetIn, 'none', `on dry ground (pos ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}; ${ep.outcome}/${ep.reason}: ${ep.detail})`);
    assert.ok(hasSafeFluidSupport({ ...f, onGround: Boolean(sc.bot.entity['onGround']) }), 'actual grounded shore, not an above-surface bob');
    assert.equal(ep.outcome, 'resolved');
    assert.ok(ep.displacement <= 24);
    assert.equal(sc.controls['jump'], false, 'controls released after the episode');
    assert.equal(rt.leases.current, undefined, 'lease released');
    auth = { ...auth, basis: 'none' };
    await rt.service.close();
  });

  it('W-R10 (R16 O7P/O7R boundary): after release, a resumed ordinary lease moves freely on dry support; re-entering deep water is preempted by a NEW finite grant for the same goal', async () => {
    const sc = scene();
    let auth = ownerAuthority();
    const rt = runtime(sc.session, () => auth);
    rt.service.start();
    // First, the ordinary follow lease that water preempts (as in O7R).
    const original = rt.leases.acquire({ kind: 'goal', goalEpoch: 2, goalId: 'goal-0001', taskId: 'task-0001' });
    rt.service.tick();
    assert.equal(original.revocation, 'safety_preempt');
    assert.ok(await until(() => rt.service.episodes().length === 1 && rt.service.hold() === null, 25_000), 'first episode released');
    const first = rt.service.episodes()[0]!;
    assert.equal(first.outcome, 'resolved', first.detail);
    assert.ok(hasSafeFluidSupport(rt.reader.self()!.fluid), 'released on stable solid support');
    // The resumed ordinary task gets a FRESH lease and moves AWAY from the pool on dry ground
    // (R16: lease goal:N acquired ~0.4 s after release, owner >3 blocks away).
    const resumed = rt.leases.acquire({ kind: 'goal', goalEpoch: 2, goalId: 'goal-0001', taskId: 'task-0001' });
    const act = new Actuator(sc.session, resumed, clock);
    const p0 = { ...sc.bot.entity.position };
    const away = { x: p0.x + (p0.x - 0.5), z: p0.z + (p0.z - 0.5) };
    await act.look(Math.atan2(-(away.x - p0.x), -(away.z - p0.z)), 0);
    act.setControl('forward', true);
    await new Promise((r) => setTimeout(r, 900));
    const p1 = sc.bot.entity.position;
    assert.ok(Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.8, 'ordinary movement after release is not suppressed (the stationary oracle is not a safety property)');
    assert.equal(resumed.revocation, undefined, 'no preemption while the body stays on dry support');
    assert.equal(rt.service.counters.episodes, 1, 'no new episode on dry ground');
    assert.equal(rt.service.hold(), null, 'dispatch is not held');
    assert.ok(hasSafeFluidSupport(rt.reader.self()!.fluid), 'still dry, grounded');
    // If resumed motion nevertheless re-enters the pool, survival keeps priority:
    // the resumed lease is preempted and a NEW finite grant protects the same goal.
    const q = sc.bot.entity.position;
    await act.look(Math.atan2(-(0.5 - q.x), -(0.5 - q.z)), 0);
    assert.ok(await until(() => resumed.revocation !== undefined, 15_000), 'walking back into deep water is caught');
    assert.equal(resumed.revocation, 'safety_preempt');
    assert.ok(await until(() => rt.service.episodes().length === 2 && rt.service.hold() === null, 25_000), 'second episode released');
    const second = rt.service.episodes()[1]!;
    assert.notEqual(second.grantId, first.grantId, 'fresh finite grant, not a revived one');
    assert.equal(second.outcome, 'resolved', second.detail);
    assert.equal(rt.service.counters.episodes, 2, 'cumulative episode history retained');
    assert.ok(hasSafeFluidSupport(rt.reader.self()!.fluid));
    auth = { ...auth, basis: 'none' };
    await rt.service.close();
  });

  it('explicit stop mid-escape clears controls immediately and the body is left to physics (no hidden buoyancy loop)', async () => {
    const sc = scene();
    let auth = ownerAuthority();
    const rt = runtime(sc.session, () => auth);
    rt.service.tick();
    assert.ok(await until(() => sc.controls['jump'] === true, 2_000), 'escape holds jump');
    auth = { ...auth, basis: 'none', goal: null, detail: 'explicit stop' };
    rt.service.onAuthorityChanged('owner_stop');
    assert.equal(sc.controls['jump'], false, 'cleared synchronously');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sc.controls['jump'], false, 'nothing re-pressed jump');
    assert.equal(rt.leases.current, undefined);
    rt.service.tick();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rt.leases.current, undefined, 'no new safety lease without authority');
    await rt.service.close();
  });

  it('stop then a NEW manual goal escapes again after old cleanup, with distinct authority and no revived controls', async () => {
    const sc = scene();
    let auth = ownerAuthority();
    const rt = runtime(sc.session, () => auth);
    rt.service.tick();
    assert.ok(await until(() => sc.controls['jump'] === true, 2_000));
    const oldLease = rt.leases.current!;
    const oldGrant = (oldLease.owner as unknown as SafetyExecutionOwner).grantId;
    auth = { ...auth, basis: 'none', goal: null, detail: 'automatic pause latched after stop' };
    rt.service.onAuthorityChanged('owner_stop');
    assert.equal(sc.controls['jump'], false);
    assert.equal(rt.service.grantCurrent(oldGrant), false);
    auth = { ...auth, basis: 'owner_goal', goal: { goalId: 'goal-0002', goalEpoch: 3, source: 'owner' }, detail: 'NEW manual goal, automatic pause remains latched' };
    rt.service.onAuthorityChanged('owner_goal_admitted');
    assert.ok(await until(() => rt.leases.current !== undefined && rt.leases.current !== oldLease, 2_000), 'fresh grant only after prior execute/cleanup settles');
    const newLease = rt.leases.current!;
    assert.notEqual((newLease.owner as unknown as SafetyExecutionOwner).grantId, oldGrant);
    assert.equal(rt.leases.revoke(oldLease, 'late_cleanup'), undefined, 'old cleanup cannot clear the new holder');
    assert.equal(rt.leases.current, newLease);
    assert.ok(await until(() => rt.service.episodes().length >= 2 && rt.service.hold() === null, 25_000));
    const ep = rt.service.episodes().at(-1)!;
    assert.equal(ep.outcome, 'resolved', ep.detail);
    assert.ok(hasSafeFluidSupport(rt.reader.self()!.fluid), 'NEW grant exits to stable solid support');
    assert.equal(rt.service.counters.episodes, 2, 'prior episode history retained');
    assert.equal(rt.service.grantCurrent(oldGrant), false);
    await rt.service.close();
  });

  it('under a solid ceiling with no open column: refuses (no blind jump) and reports a blocker', async () => {
    const sc = scene({ ceiling: true });
    const rt = runtime(sc.session, ownerAuthority);
    rt.service.tick();
    const s = rt.service.status(Date.now());
    assert.equal(s.state, 'blocked');
    assert.equal(s.blocker?.reason, 'no_reachable_surface');
    assert.equal(rt.leases.current, undefined);
    assert.equal(sc.controls['jump'], false);
    await rt.service.close();
  });

  it('no supported escape while ORDINARY motion runs: the goal lease is revoked, its controls cleared, no safety action is invented', async () => {
    const sc = scene({ ceiling: true });
    const rt = runtime(sc.session, ownerAuthority);
    // An ordinary goal action is actively moving (e.g. a follow window swimming under a ledge).
    const goalLease = rt.leases.acquire({ kind: 'goal', goalEpoch: 2, goalId: 'goal-0001', taskId: 'task-0003' });
    const act = new Actuator(sc.session, goalLease, clock);
    act.setControl('forward', true);
    act.setControl('jump', true);
    assert.equal(sc.controls['forward'], true);
    rt.service.tick();
    assert.equal(goalLease.revocation, 'safety_preempt', 'old action cancelled synchronously');
    assert.throws(() => act.setControl('forward', true), /revoked/, 'the old action cannot issue another command');
    assert.equal(sc.controls['forward'], false);
    assert.equal(sc.controls['jump'], false);
    assert.equal(rt.leases.current, undefined, 'no safety lease: nothing supported to do');
    assert.equal(rt.service.hold()?.reason, 'blocked', 'dispatch is held with a declarative blocker');
    await new Promise((r) => setTimeout(r, 400));
    rt.service.tick();
    assert.equal(rt.leases.current, undefined, 'no rogue action on later ticks');
    assert.equal(sc.controls['forward'] || sc.controls['jump'], false);
    await rt.service.close();
  });

  it('a planner/goal dispatch cannot borrow safety authority: a stale or foreign grant refuses before any command', async () => {
    const sc = scene();
    const rt = runtime(sc.session, ownerAuthority);
    const cand: ActionCandidate = { id: 'act-9001', capability: 'escape_water', parameters: { maxMs: 5_000 }, snapshotId: 'snap-9001', connectionEpoch: 1, goalEpoch: 2, description: 'x', criteria: [], preconditions: [], timeoutMs: 6_000 };
    const forged: SafetyExecutionOwner = { kind: 'safety', grantId: 'sg-forged1', episodeId: 'se-forged1', connectionEpoch: 1 };
    // The lease fence itself refuses the forged owner (ownerCurrent -> grantCurrent false).
    const r = await rt.execute(cand, new AbortController().signal, forged);
    assert.equal(r.status === 'precondition_failed' || r.status === 'cancelled', true);
    assert.equal(r.commands, 0, 'no command issued');
    assert.equal(sc.controls['jump'], false);
    await rt.service.close();
  });

  it('goal-owned use keeps the goal bounds (no displacement exception) and still escapes', async () => {
    const sc = scene();
    const rt = runtime(sc.session, ownerAuthority);
    const cand: ActionCandidate = { id: 'act-9002', capability: 'escape_water', parameters: { maxMs: 20_000 }, snapshotId: 'snap-9002', connectionEpoch: 1, goalEpoch: 2, description: 'x', criteria: [], preconditions: [], timeoutMs: 21_000 };
    const r = await rt.execute(cand, new AbortController().signal, { kind: 'goal', goalEpoch: 2, goalId: 'goal-0001', taskId: 'task-0002' });
    assert.equal(r.status, 'succeeded', r.effect);
    await rt.service.close();
  });
});
