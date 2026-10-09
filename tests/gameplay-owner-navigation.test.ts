// P-L1/L6: actual shared proposal/catalog and manual navigation projection.
// No world, provider, durable store or gameplay harness execution.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SkillRuntime } from '../src/app/skill-runtime.ts';
import { parseConfig } from '../src/config/load.ts';
import { BOUNDS, sequentialIds, systemClock, type OutcomePredicate, type PlannerProposal, type TaskSpec } from '../src/contracts/index.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { checkProposal } from '../src/goals/proposal.ts';
import { enableOwnerSeeking } from '../src/goals/owner-navigation.ts';
import { navigationStatusLines } from '../src/autonomy/status-text.ts';
import { fakeClient, fakeMineflayerBot } from './skill-fakes.ts';
import type { GameSession } from '../src/game/connection.ts';

const config = parseConfig({ minecraft: { host: '127.0.0.1', port: 25566, version: '26.1.2' }, bot: { auth: 'offline', username: 'Chunkbot', trustedOfflineFixture: true }, owner: { name: 'FixtureOwner' } });
const near: OutcomePredicate = { predicate: 'near_target', target: { kind: 'owner' }, within: 3 };
const task = (): TaskSpec => ({ objective: 'Stay nearby.', decisionInstruction: 'Use current guidance.', allowedCapabilities: ['follow_entity', 'move_near'], targetSelectors: [], parameters: {}, completion: near });
function runtime(locator = true, session?: GameSession) {
  return new SkillRuntime({ config, features: { locator }, session: () => session, connectionEpoch: () => 1, goalEpoch: () => 1, diagnosticCurrent: () => false, admission: () => ({ serverOnlineMode: false }), store: new MemoryRunStore(), clock: systemClock, ids: sequentialIds() });
}

describe('shared owner-navigation seams', () => {
  it('actual proposal validation adds registered seeking for owner movement, without granting a route or changing the outcome/raw draft', () => {
    const r = runtime();
    const raw: PlannerProposal = { version: 1, disposition: 'plan', interpretation: 'Stay nearby.', outcome: { kind: 'persistent', maintain: near }, tasks: [task()], morePlanningNeeded: false };
    const checked = checkProposal(raw, r.registry, { planWindowSteps: 8, remainingTaskAllowance: 64 }, { registry: r.knowledge });
    assert.ok(checked.ok && checked.proposal.disposition === 'plan');
    assert.deepEqual(checked.proposal.tasks[0]!.allowedCapabilities, ['follow_entity', 'move_near', 'seek_owner']);
    assert.deepEqual(checked.proposal.outcome, raw.outcome);
    assert.deepEqual(raw.tasks[0]!.allowedCapabilities, ['follow_entity', 'move_near']);
    assert.equal(r.routes!.status(1), null, 'capability inclusion does not acquire or refill route authority');
  });

  it('handles owner selectors and nested positive predicates without instruction phrases; unrelated work and unregistered seeking remain unchanged', () => {
    const r = runtime();
    const a = task(); a.completion = { predicate: 'all', of: [near] };
    const b = task(); b.completion = { predicate: 'inventory_delta', selector: 'minecraft:oak_log', atLeast: 1, mayBeConsumedLater: false }; b.targetSelectors = [{ kind: 'owner' }];
    const unrelated = task(); unrelated.completion = { predicate: 'inventory_delta', selector: 'minecraft:oak_log', atLeast: 1, mayBeConsumedLater: false };
    assert.deepEqual(enableOwnerSeeking([a, b, unrelated], r.registry.catalog()), []);
    assert.ok(a.allowedCapabilities.includes('seek_owner') && b.allowedCapabilities.includes('seek_owner'));
    assert.ok(!unrelated.allowedCapabilities.includes('seek_owner'));
    const disabled = task(); enableOwnerSeeking([disabled], runtime(false).registry.catalog());
    assert.ok(!disabled.allowedCapabilities.includes('seek_owner'));
    const full = task(); full.allowedCapabilities = Array(BOUNDS.listSmall).fill('move_near');
    assert.match(enableOwnerSeeking([full], r.registry.catalog()).join(), /needs a slot/);
    assert.equal(full.allowedCapabilities.length, BOUNDS.listSmall, 'augmentation never exceeds the task contract');
  });

  it('shows current manual route/locator status without an autonomy supervisor or counter changes', () => {
    const client = fakeClient(); const fake = fakeMineflayerBot(client);
    const session = { bot: fake.bot, connectionEpoch: 1 } as unknown as GameSession;
    const r = runtime(true, session);
    r.onGoalAdmitted({ goalId: 'goal-0001', epoch: 1, admittedAtMs: Date.now(), deadlineAtMs: Date.now() + 60_000, source: { kind: 'owner' } });
    const view = r.routeView(1)!;
    const before = r.routes!.status(1);
    const lines = navigationStatusLines(view.status, { admission: view.admission, locator: r.locator!.ownerHint() });
    assert.ok(lines.some((l) => l.startsWith('route: ') && l.includes('admission anchor')));
    assert.ok(lines.some((l) => l.startsWith('locator: ') && l.includes('not actionable')));
    assert.equal(r.routes!.status(1)!.legsUsed, before!.legsUsed);
    assert.equal(r.routes!.status(1)!.distanceUsed, before!.distanceUsed);
  });
});
