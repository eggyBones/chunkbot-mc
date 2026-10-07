// MB-FLOW-001 x MB-FLOW-003-C5: the owned admission barrier holds a newly
// admitted death-recovery goal until survival's recovery authority is durable
// (attempt saved + exact memory death fact durable). Held/failed saves start
// no model call and no action; stop aborts the wait at once; other goals are
// unaffected. Real GoalEngine + supervisor, fake ports, no inference.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlannerProposal, SurvivalProposal } from '../src/contracts/index.ts';
import { recoveryAdmissionBarrier } from '../src/autonomy/barrier.ts';
import { until } from './helpers.ts';
import { FakeSurvival, autonomyHarness } from './autonomy-fakes.ts';
import { cobble, finitePlan, runFor, sleep, task } from './handoff-fakes.ts';

class Authority {
  state: 'pending' | 'durable' | 'failed' = 'pending';
  calls = 0;
  recoveryTarget(): { episodeId: string } | { error: string; detail: string } {
    this.calls += 1;
    if (this.state === 'durable') return { episodeId: 'rep-0001' };
    return this.state === 'pending' ? { error: 'attempt_write_pending', detail: 'not saved yet' } : { error: 'attempt_write_failed', detail: 'disk full' };
  }
}

const recoveryProposal = (now: number): SurvivalProposal => ({
  proposalId: 'prop-rec',
  routine: 'death_recovery',
  priority: 'support',
  reason: 'recover belongings',
  signature: 's-rec',
  serves: 'progression',
  execution: { kind: 'planner_goal', instruction: 'Recover the belongings dropped at your death site.', context: { routine: 'death_recovery', facts: [], suggestedCapabilities: [], rules: [] } },
  ceilings: { plannerTurns: 4, tasks: 8, replans: 2, deadlineMs: 60_000 },
  expiresAtMs: now + 60_000,
});

const plan = finitePlan([task('collect cobblestone for tools', cobble(1))], cobble(1), false) as PlannerProposal;

function setup(waitMs = 1_000) {
  const authority = new Authority();
  const survival = new FakeSurvival();
  const barrier = recoveryAdmissionBarrier({ survival: authority, connection: () => ({ connectionEpoch: 1, dimension: 'overworld' }), waitMs, pollMs: 10 });
  const h = autonomyHarness(() => ({ kind: 'reply', proposal: plan }), { survival, barrier });
  survival.next = [{ kind: 'propose', proposal: recoveryProposal(h.clock.now()) }];
  return { h, authority };
}

describe('MB-FLOW-003-C5 owned admission barrier', () => {
  it('a held (pending) save starts no planner turn; once durable the recovery plans', async () => {
    const { h, authority } = setup();
    h.tasks.behaviors.set('collect cobblestone for tools', runFor(5, () => h.server.add('minecraft:cobblestone', 1)));
    void h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.source?.kind === 'support');
    await sleep(60);
    assert.equal(h.planner.count, 0, 'no model call while the recovery attempt is not durable');
    assert.ok(authority.calls > 1, 'the barrier rechecks (bounded poll, code only)');
    authority.state = 'durable';
    await until(() => h.planner.count === 1);
  });

  it('a failed save ends the goal before any model call or action', async () => {
    const { h, authority } = setup();
    authority.state = 'failed';
    void h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.terminal !== undefined);
    const g = h.engine.status().goal!;
    assert.equal(g.terminal?.reason, 'cannot_execute');
    assert.match(g.terminal!.detail, /attempt_write_failed/);
    assert.equal(h.planner.count, 0);
    assert.equal(h.tasks.runs.length, 0);
  });

  it('a save that stays pending past the bound ends honestly (no indefinite wait)', async () => {
    const { h } = setup(80);
    void h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.terminal !== undefined, 2_000);
    assert.match(h.engine.status().goal!.terminal!.detail, /attempt_write_pending/);
    assert.equal(h.planner.count, 0);
  });

  it('stop during the barrier wait cancels immediately; nothing starts afterwards', async () => {
    const { h, authority } = setup(5_000);
    void h.supervisor.assessNow();
    await until(() => h.engine.status().goal?.source?.kind === 'support');
    const t0 = Date.now();
    await h.engine.stop('owner_stop', 'chat');
    assert.ok(Date.now() - t0 < 500, 'stop does not wait for the durability barrier');
    assert.equal(h.engine.status().goal?.state, 'cancelled');
    authority.state = 'durable';
    await sleep(50);
    assert.equal(h.planner.count, 0);
  });

  it('other goals (progression) pass the barrier untouched', async () => {
    const authority = new Authority();
    const barrier = recoveryAdmissionBarrier({ survival: authority, connection: () => ({ connectionEpoch: 1, dimension: 'overworld' }) });
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: plan }), { barrier });
    h.tasks.behaviors.set('collect cobblestone for tools', runFor(5));
    await h.supervisor.assessNow();
    await until(() => h.planner.count === 1);
    assert.equal(authority.calls, 0);
  });
});
