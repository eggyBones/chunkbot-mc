// MB-FLOW-003-C11 (offline, module level): the REAL escape skill and service
// episode through the real Lease/ActuatorLeases/Actuator over a
// Mineflayer-shaped bot, with the INSTALLED prismarine-physics stepping the
// body from the controls the skill actually set. Client-physics evidence only;
// server acceptance stays fixture evidence.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ActionCandidate } from '../src/contracts/index.ts';
import type { SafetyExecutionOwner } from '../src/contracts/safety.ts';
import { fluidState } from '../src/safety/geometry.ts';
import { Actuator } from '../src/execution/actuator.ts';
import { clock } from './safety-session.ts';
import { ownerAuthority, runtime, scene, stopPhysics, until } from './safety-session.ts';

after(stopPhysics);

describe('safety skills over the installed physics (client-physics evidence)', () => {
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
    assert.equal(ep.outcome, 'resolved');
    assert.ok(ep.displacement <= 24);
    assert.equal(sc.controls['jump'], false, 'controls released after the episode');
    assert.equal(rt.leases.current, undefined, 'lease released');
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
    assert.equal(fluidState(rt.service.world()!, sc.bot.entity.position).feetIn, 'none');
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
