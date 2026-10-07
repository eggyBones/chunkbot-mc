// MB-FLOW-001 read-only dashboard projection: truthful automatic modes and a
// bounded, schema-valid autonomy section (no controls, no exact owner coordinates).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutonomySectionSchema, DirectiveSectionSchema } from '../src/contracts/dashboard.ts';
import type { AutonomyStatus } from '../src/contracts/autonomy.ts';
import { projectAutonomy, projectDirective } from '../src/dashboard/directive.ts';
import { autonomyHarness } from './autonomy-fakes.ts';
import { cobble, finitePlan, holdUntilRevoked, task } from './handoff-fakes.ts';
import { until } from './helpers.ts';

const status = (over: Partial<AutonomyStatus> = {}): AutonomyStatus => ({
  mode: 'progression',
  detail: 'automatic progression goal goal-0001 (attempt 1)',
  sinceMs: 1,
  enabled: true,
  scope: { worldProfile: 'w', worldRevision: 1, botProfile: 'b' },
  persistence: { state: 'ready', detail: 'loaded revision 3', revision: 3 },
  latch: { paused: false, durable: 'written' },
  active: { goalId: 'goal-0001', source: { kind: 'progression', sessionAttempt: 1 }, priority: 'progression' },
  ownerIntent: { goalId: 'goal-0000', instruction: 'collect 10 logs', state: 'interrupted', detail: 'death', requiresOwnerDecision: true },
  nextAssessmentAtMs: null,
  session: { progressionGoals: 1, supportGoals: 0, safetyRevocations: 0, plannerTurns: 3, completed: 0, consecutiveUnproductive: 0, limits: { maxProgressionGoals: 16, maxSupportGoals: 16, maxPlannerTurns: 200, maxConsecutiveUnproductive: 3, maxRepeatsPerFingerprint: 2 } },
  lastOutcome: null,
  blocker: null,
  home: null,
  support: null,
  route: { routeId: 'route-1', goalId: 'goal-0001', state: 'leg_active', destinations: ['owner'], legsUsed: 1, maxLegs: 12, distanceUsed: 40.24, distanceSources: { clientPhysics: 40, serverCorrections: 0.24, correctionCount: 1 }, maxTotalDistance: 1024, remainingMs: 1000, stalledLegs: 0, legRadius: 96, currentLeg: null, lastLeg: null, blocker: null },
  ...over,
});

describe('dashboard autonomy section', () => {
  it('is schema-valid, bounded, keeps the ORIGINAL admission anchor and only the coarse locator hint', () => {
    const p = projectAutonomy({
      status: status(),
      admission: { anchor: { x: 1.23, y: 64, z: -5.55 }, radius: 128 },
      locator: { target: 'owner', source: 'server_locator_waypoint', actionable: true, reason: 'tracking', direction: 'north_east', distanceBand: 'far', elevation: 'above', precision: 'block', ageMs: 1000, expiresInMs: 5000, connectionEpoch: 1, dimension: 'overworld', note: 'coarse' },
    });
    assert.equal(AutonomySectionSchema.safeParse(p).success, true);
    assert.deepEqual(p.route?.admissionAnchor, { x: 1.2, y: 64, z: -5.5 });
    assert.equal(p.ownerIntent?.requiresOwnerDecision, true);
    assert.equal(JSON.stringify(p.locator).includes('"x"'), false, 'no locator coordinates are projected');
  });

  it('automatic goals are labeled automatic (never an owner directive)', async () => {
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: finitePlan([task('collect cobblestone for tools', cobble(1))], cobble(1), false) }));
    h.tasks.behaviors.set('collect cobblestone for tools', holdUntilRevoked);
    await h.supervisor.assessNow();
    await until(() => h.tasks.runs.length === 1);
    const d = projectDirective(h.engine.status(), undefined, undefined, undefined, { status: h.supervisor.status() });
    assert.equal(d.mode, 'automatic_progression');
    assert.equal(DirectiveSectionSchema.safeParse(d).success, true);
    await h.engine.stop('owner_stop', 'chat');
  });
});
