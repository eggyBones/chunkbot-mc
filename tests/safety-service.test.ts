// MB-FLOW-003-C11/C13 (offline): SafetyService authority, grants, preemption,
// episodes, hold/waitClear, stop/lifecycle revocation, stale grants, repeated
// hazards and readiness downgrade. Fake reader/actuation/timers; no world,
// no model, no Minecraft.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ActionCandidate, SkillOutcome } from '../src/contracts/index.ts';
import { sequentialIds } from '../src/contracts/ids.ts';
import type { SafetyAuthority, SafetyConfigInput, SafetyEntityFact, SafetyExecutionOwner, SafetySelfFacts } from '../src/contracts/safety.ts';
import { SafetyService, type SafetyTimers } from '../src/safety/service.ts';
import { pool, inTag, mob, self, unarmed } from './safety-helpers.ts';
import { flatWorld } from './skill-fakes.ts';

const submerged = (): Partial<SafetySelfFacts> => ({ fluid: { feetIn: 'water', eyeIn: 'water', support: 'solid', depth: 3, wadeable: false, headroom: 'open', surfaceDy: 1, onGround: false, source: 'local_estimate' }, position: { x: 0.5, y: 0, z: 0.5 } });

function manualTimers(): SafetyTimers & { fire(): void } {
  const after = new Set<{ fn: () => void }>();
  return {
    every: () => 'interval',
    after: (_ms, fn) => {
      const h = { fn };
      after.add(h);
      return h;
    },
    clear: (h) => void after.delete(h as { fn: () => void }),
    fire: () => {
      for (const h of [...after]) {
        after.delete(h);
        h.fn();
      }
    },
  };
}

interface Pending {
  candidate: ActionCandidate;
  signal: AbortSignal;
  owner: SafetyExecutionOwner;
  resolve(o: Partial<SkillOutcome>): void;
}

function harness(opts: { config?: SafetyConfigInput; basis?: SafetyAuthority['basis'] } = {}) {
  let now = 1_000;
  const state = {
    self: self() as SafetySelfFacts,
    entities: [] as SafetyEntityFact[],
    world: flatWorld(30) as ReturnType<typeof flatWorld> | ReturnType<typeof pool>,
    authority: {
      basis: opts.basis ?? 'owner_goal',
      detail: 'test',
      connection: { ready: true, connectionEpoch: 1, dimension: 'overworld' },
      alive: true,
      goal: { goalId: 'goal-0001', goalEpoch: 3, source: 'owner' },
      travel: null,
    } as SafetyAuthority,
  };
  const events: Array<Record<string, unknown>> = [];
  const preempts: string[] = [];
  const pending: Pending[] = [];
  const timers = manualTimers();
  const service = new SafetyService({
    ...(opts.config ? { config: opts.config } : {}),
    authority: () => state.authority,
    actuation: {
      preemptCurrent: (reason) => {
        preempts.push(reason);
        return { revoked: true, holder: 'goal', clearMs: 0 };
      },
      execute: (candidate, signal, owner) =>
        new Promise<SkillOutcome>((resolve) => {
          const p: Pending = {
            candidate,
            signal,
            owner,
            resolve: (o) => resolve({ actionId: candidate.id, owner: 'goal', connectionEpoch: 1, goalEpoch: 3, status: 'succeeded', elapsedMs: 1, effect: 'ok', confirmation: 'client_only', evidence: {}, ...o } as SkillOutcome),
          };
          signal.addEventListener('abort', () => p.resolve({ status: 'cancelled', reason: 'owner_stop' }), { once: true });
          pending.push(p);
        }),
    },
    reader: {
      self: () => state.self,
      entities: () => state.entities,
      world: () => state.world,
      visible: () => () => true,
      position: () => state.self.position,
      reset: () => undefined,
    },
    inTag,
    registry: () => undefined,
    category: () => 'Hostile mobs',
    now: () => now,
    ids: sequentialIds(),
    record: (e) => void events.push(e),
    timers,
  });
  const flush = () => new Promise((r) => setImmediate(r));
  return { service, state, events, preempts, pending, timers, flush, advance: (ms: number) => (now += ms), now: () => now };
}

describe('authority (coordinator review 1)', () => {
  it('a manual owner goal authorizes protection while the automatic latch is paused', async () => {
    const h = harness({ basis: 'owner_goal' });
    h.state.self = self(submerged());
    h.service.tick();
    assert.equal(h.pending.length, 1, 'escape dispatched');
    assert.deepEqual(h.preempts, ['safety_preempt'], 'current lease preempted synchronously');
    const p = h.pending[0]!;
    assert.equal(p.owner.kind, 'safety');
    assert.equal(p.candidate.capability, 'escape_water');
    assert.equal(h.service.grantCurrent(p.owner.grantId), true);
    assert.equal(h.service.hold()?.reason, 'episode');
    assert.equal(Object.keys(p.candidate.parameters).includes('grantId'), false, 'no grant in parameters');
  });

  it('explicit stop without an owner goal: no safety motion at all, even when submerged', () => {
    const h = harness({ basis: 'none' });
    h.state.self = self(submerged());
    h.service.tick();
    assert.equal(h.pending.length, 0);
    assert.equal(h.preempts.length, 0);
    assert.equal(h.service.status(h.now()).state, 'no_authority');
  });

  it('idle coverage only while unpaused and coverIdle; owner goals always covered', () => {
    const off = harness({ basis: 'unpaused', config: { coverIdle: false } });
    off.state.self = self(submerged());
    off.service.tick();
    assert.equal(off.pending.length, 0);
    const on = harness({ basis: 'unpaused' });
    on.state.self = self(submerged());
    on.service.tick();
    assert.equal(on.pending.length, 1);
  });

  it('dead / not ready: nothing', () => {
    const h = harness();
    h.state.self = self(submerged());
    h.state.authority = { ...h.state.authority, alive: false };
    h.service.tick();
    assert.equal(h.pending.length, 0);
  });
});

describe('episodes', () => {
  it('re-plans from fresh facts; resolved releases the hold and waitClear', async () => {
    const h = harness();
    h.state.self = self(submerged());
    h.service.tick();
    const wait = h.service.waitClear(new AbortController().signal);
    h.state.self = self(); // surfaced and dry
    h.pending[0]!.resolve({ status: 'succeeded' });
    const c = await wait;
    assert.equal(c.status, 'clear');
    assert.equal(h.service.hold(), null);
    const ended = h.events.find((e) => e['type'] === 'safety_episode_ended');
    assert.equal(ended?.['outcome'], 'resolved');
    assert.equal(h.service.counters.preemptions, 1);
  });

  it('stop during an in-flight step revokes the grant, aborts the step and never dispatches again', async () => {
    const h = harness();
    h.state.self = self(submerged());
    h.service.tick();
    const p = h.pending[0]!;
    h.state.authority = { ...h.state.authority, basis: 'none', goal: null };
    h.service.onAuthorityChanged('owner_stop');
    assert.equal(p.signal.aborted, true, 'abort is synchronous');
    assert.equal(h.service.grantCurrent(p.owner.grantId), false);
    await h.flush();
    await h.flush();
    assert.equal(h.pending.length, 1, 'no further step');
    assert.equal(h.events.find((e) => e['type'] === 'safety_episode_ended')?.['outcome'], 'revoked');
    h.service.tick();
    assert.equal(h.pending.length, 1, 'no hidden idle movement after stop');
  });

  it('death/disconnect revoke; join/respawn holds ordinary work until a fresh assessment', async () => {
    const h = harness();
    h.state.self = self(submerged());
    h.service.tick();
    const p = h.pending[0]!;
    h.service.onLifecycle({ type: 'death', connectionEpoch: 1 });
    assert.equal(p.signal.aborted, true);
    await h.flush();
    await h.flush();
    h.service.onLifecycle({ type: 'respawn', connectionEpoch: 1, dimension: 'overworld' });
    assert.equal(h.service.hold()?.reason, 'initial_assessment');
    h.state.self = self();
    h.service.tick();
    assert.equal(h.service.hold(), null, 'fresh assessment releases the hold');
  });

  it('an old grant id can never act after its episode ended or for another episode', async () => {
    const h = harness();
    h.state.self = self(submerged());
    h.service.tick();
    const old = h.pending[0]!.owner.grantId;
    h.state.self = self();
    h.pending[0]!.resolve({});
    await h.flush();
    await h.flush();
    assert.equal(h.service.grantCurrent(old), false);
    assert.equal(h.service.grant(old), undefined);
    h.state.self = self(submerged());
    h.service.tick();
    const fresh = h.pending[1]!.owner.grantId;
    assert.notEqual(fresh, old);
    assert.equal(h.service.grantCurrent(old), false);
    assert.equal(h.service.grantCurrent(fresh), true);
  });

  it('grant expiry and the action ceiling bound an episode', async () => {
    const h = harness({ config: { episodes: { maxActions: 2 } } });
    h.state.self = self(submerged());
    h.service.tick();
    h.pending[0]!.resolve({ status: 'partial', reason: 'timeout' });
    await h.flush();
    await h.flush();
    assert.equal(h.pending.length, 2, 'second step after fresh re-plan');
    h.pending[1]!.resolve({ status: 'partial' });
    await h.flush();
    await h.flush();
    assert.equal(h.pending.length, 2, 'no third step');
    const ended = h.events.find((e) => e['type'] === 'safety_episode_ended');
    assert.equal(ended?.['actions'], 2);
    assert.equal(ended?.['reason'], 'action_limit');
    const expiring = harness();
    expiring.state.self = self(submerged());
    expiring.service.tick();
    const g = expiring.pending[0]!.owner.grantId;
    expiring.advance(26_000);
    assert.equal(expiring.service.grantCurrent(g), false, 'expired grant fences');
  });

  it('repeated unresolved hazards block with a declarative blocker (no retry loop); clearing releases it', async () => {
    const h = harness({ config: { episodes: { maxActions: 1, maxFailedPerWindow: 2 } } });
    h.state.world = pool(4);
    h.state.self = self(submerged());
    for (let i = 0; i < 2; i += 1) {
      h.service.tick();
      h.pending.at(-1)!.resolve({ status: 'failed', reason: 'stuck' });
      await h.flush();
      await h.flush();
      h.advance(31_000); // past the per-signature cooldown
    }
    const before = h.pending.length;
    h.service.tick();
    assert.equal(h.pending.length, before, 'blocked: no new dispatch');
    assert.equal(h.service.hold()?.reason, 'blocked');
    const c = await h.service.waitClear(new AbortController().signal);
    assert.equal(c.status, 'blocked');
    h.state.self = self();
    h.service.tick();
    assert.equal(h.service.hold(), null, 'hazard gone: blocker cleared');
  });

  it('defense downgrades to retreat when readiness changes mid-episode', async () => {
    const h = harness();
    const z = mob('zombie', 2.5, { aggressive: true });
    h.state.entities = [z];
    h.service.tick();
    assert.equal(h.pending[0]!.candidate.capability, 'defend_against_threat');
    assert.equal(h.service.grant(h.pending[0]!.owner.grantId)?.target?.entityId, z.entityId, 'code-bound target');
    h.state.self = self({ equipment: unarmed() });
    h.pending[0]!.resolve({ status: 'partial', reason: 'readiness_changed' });
    await h.flush();
    await h.flush();
    assert.equal(h.pending[1]!.candidate.capability, 'retreat_from_threat');
    assert.equal(h.service.grant(h.pending[1]!.owner.grantId)?.target, null);
  });

  it('a defense action ending at its local loss threshold cannot refill that baseline in the same grant', async () => {
    const h = harness();
    h.state.entities = [mob('zombie', 2.5, { aggressive: true })];
    h.service.tick();
    const old = h.pending[0]!.owner.grantId;
    h.state.self = self({ health: 14 }); // admission minimum still met; local loss from 20 triggered disengage
    h.pending[0]!.resolve({ status: 'partial', reason: 'readiness_changed' });
    await h.flush();
    assert.equal(h.pending[1]?.candidate.capability, 'retreat_from_threat');
    assert.equal(h.pending[1]?.owner.grantId, old, 'same finite grant, no budget refill');
  });

  it('stop then immediate new manual admission waits for old cleanup and creates a distinct grant', async () => {
    const h = harness();
    h.state.self = self(submerged());
    h.service.tick();
    const old = h.pending[0]!.owner.grantId;
    h.state.authority = { ...h.state.authority, basis: 'none', goal: null };
    h.service.onAuthorityChanged('owner_stop');
    h.state.authority = { ...h.state.authority, basis: 'owner_goal', goal: { goalId: 'goal-0002', goalEpoch: 4, source: 'owner' } };
    h.service.onAuthorityChanged('owner_goal_admitted');
    assert.equal(h.pending.length, 1, 'new authority cannot dispatch before the old promise settles');
    await h.flush();
    assert.equal(h.pending.length, 2, 'fresh assessment runs immediately after cleanup');
    const fresh = h.pending[1]!.owner.grantId;
    assert.notEqual(fresh, old);
    assert.equal(h.service.grantCurrent(old), false);
    assert.equal(h.service.grantCurrent(fresh), true);
    assert.equal(h.service.grant(fresh)?.suspended?.goalEpoch, 4);
    assert.equal(h.service.counters.episodes, 2, 'history/counters are retained');
    await h.service.close();
  });

  it('waitClear honours the caller abort signal', async () => {
    const h = harness();
    h.state.self = self(submerged());
    h.service.tick();
    const ac = new AbortController();
    const w = h.service.waitClear(ac.signal);
    ac.abort();
    assert.equal((await w).status, 'aborted');
  });

  it('an active hazard with no supported response still preempts ordinary motion and holds dispatch (no rogue action)', () => {
    const h = harness();
    const w = flatWorld(30);
    for (let x = -20; x <= 20; x += 1) for (let z = -20; z <= 20; z += 1) if (Math.abs(x) > 2 || Math.abs(z) > 2) w.fill(x, 0, z, x, 2, z, 'stone');
    h.state.world = w;
    h.state.self = self({ equipment: unarmed() });
    h.state.entities = [mob('zombie', 2, { aggressive: true })];
    h.service.tick();
    assert.deepEqual(h.preempts, ['safety_preempt'], 'the old (ordinary) lease is revoked synchronously');
    assert.equal(h.pending.length, 0, 'no safety action is invented');
    const hold = h.service.hold();
    assert.equal(hold?.reason, 'blocked');
    assert.match(hold?.detail ?? '', /no_retreat_leg/);
    h.service.tick();
    assert.equal(h.pending.length, 0, 'still no rogue action on the next tick');
    h.state.entities = [];
    h.service.tick();
    assert.equal(h.service.hold(), null, 'hazard gone: dispatch released');
  });

  it('the grant is fenced while controls run: displacement and expiry revoke the in-flight step', async () => {
    const h = harness();
    h.state.self = self(submerged());
    h.service.tick();
    const p = h.pending[0]!;
    h.state.self = self({ ...submerged(), position: { x: 40, y: 0, z: 0.5 } });
    assert.equal(h.service.grantCurrent(p.owner.grantId), false, 'displacement fails the lease fence');
    h.service.tick(); // watchdog
    assert.equal(p.signal.aborted, true);
    await h.flush();
    await h.flush();
    assert.equal(h.events.find((e) => e['type'] === 'safety_episode_ended')?.['reason'], 'displacement_limit');

    const x = harness();
    x.state.self = self(submerged());
    x.service.tick();
    const q = x.pending[0]!;
    x.advance(30_000);
    x.timers.fire(); // the expiry timer, not the next fence
    assert.equal(q.signal.aborted, true, 'expiry aborts the running step');
  });

  it('the cumulative attack budget is per episode, reserved before each attack', () => {
    const h = harness();
    h.state.entities = [mob('zombie', 2.5, { aggressive: true })];
    h.service.tick();
    const g = h.pending[0]!.owner.grantId;
    const max = h.service.grant(g)!.maxAttacks;
    for (let i = 0; i < max; i += 1) assert.equal(h.service.reserveAttack(g), true);
    assert.equal(h.service.reserveAttack(g), false, 'no attack beyond the episode budget');
    assert.equal(h.service.reserveAttack('sg-forged1'), false, 'a foreign grant reserves nothing');
  });

  it('route exhausted / outside the original anchor: mob escape uses the prospective grant bound, not the goal radius', async () => {
    // The bot ended a counted route leg 400 blocks from its 128-radius admission anchor; the leg is withdrawn.
    const outside = { anchor: { x: 400, y: 0, z: 400 }, radius: 128 };
    const h = harness();
    h.state.authority = { ...h.state.authority, travel: outside };
    h.state.self = self({ equipment: unarmed() });
    h.state.entities = [mob('zombie', 5, { approaching: true })];
    h.service.tick();
    assert.equal(h.pending.length, 1, 'a finite safety grant is issued (no blocker from the goal radius)');
    assert.equal(h.pending[0]!.candidate.capability, 'retreat_from_threat');
    const g = h.service.grant(h.pending[0]!.owner.grantId)!;
    assert.deepEqual(g.origin, h.state.self.position, 'grant origin is the bot position (no re-anchor of the goal)');
    assert.equal(h.state.authority.travel, outside, 'the goal/route bound is untouched');

    // Readiness/escape-space uses the same bound: an engaging zombie with gear is defended there too.
    const d = harness();
    d.state.authority = { ...d.state.authority, travel: outside };
    d.state.entities = [mob('zombie', 2.5, { aggressive: true })];
    d.service.tick();
    assert.equal(d.pending[0]?.candidate.capability, 'defend_against_threat', 'escape space found inside the safety displacement');

    // Unpaused basis (no owner goal) also escapes; explicit stop does nothing.
    const u = harness({ basis: 'unpaused' });
    u.state.authority = { ...u.state.authority, travel: outside, goal: null };
    u.state.self = self({ equipment: unarmed() });
    u.state.entities = [mob('zombie', 5, { approaching: true })];
    u.service.tick();
    assert.equal(u.pending.length, 1);
    const n = harness({ basis: 'none' });
    n.state.authority = { ...n.state.authority, travel: outside, goal: null };
    n.state.self = self({ equipment: unarmed() });
    n.state.entities = [mob('zombie', 5, { approaching: true })];
    n.service.tick();
    assert.equal(n.pending.length, 0, 'explicit stop: no safety motion');
    assert.equal(n.preempts.length, 0);
  });

  it('owner replacement while an episode runs: the application-owned grant continues, the new goal waits, stop still revokes', async () => {
    const h = harness();
    h.state.self = self(submerged());
    h.service.tick();
    const p = h.pending[0]!;
    // A new manual owner goal replaces the old one mid-episode (new goal id/epoch; basis stays owner_goal).
    h.state.authority = { ...h.state.authority, goal: { goalId: 'goal-0002', goalEpoch: 4, source: 'owner' } };
    h.service.onAuthorityChanged('owner_goal_admitted');
    assert.equal(h.service.grantCurrent(p.owner.grantId), true, 'grant is application-owned, fenced by basis/connection/dimension');
    assert.equal(p.signal.aborted, false);
    assert.equal(h.service.hold()?.reason, 'episode', 'the new goal must wait locally for the episode');
    assert.equal(h.service.grant(p.owner.grantId)?.suspended?.goalId, 'goal-0001', 'suspended identity is informational only');
    h.state.authority = { ...h.state.authority, basis: 'none', goal: null };
    h.service.onAuthorityChanged('owner_stop');
    assert.equal(p.signal.aborted, true, 'explicit stop always revokes');
    assert.equal(h.service.grantCurrent(p.owner.grantId), false);
  });

  it('status is bounded, labeled and never includes players/owner as threats', () => {
    const h = harness();
    h.state.entities = [mob('zombie', 9), { ...mob('player', 2), disposition: 'player' }];
    h.service.tick();
    const s = h.service.status(h.now());
    assert.equal(s.authority.basis, 'owner_goal');
    assert.equal(s.threats.length, 1);
    assert.equal(s.fluid?.source, 'local_estimate');
    assert.ok(JSON.stringify(s).length < 4_000);
  });
});
