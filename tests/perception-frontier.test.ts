// MB-PLAN-003 maintained regression: a planner-selected frontier waypoint
// re-grounds into a fresh observation ONLY when the same safe, visible,
// in-bounds waypoint is produced again on the same connection/dimension and
// lifecycle generation; otherwise it is refused (stale) with no fallback to a
// different frontier. Exercised through the actual PerceptionService and
// TaskCandidateGenerator (explore_frontier / move_near parameter admission).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, type TaskSpec } from '../src/contracts/index.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { allSkills } from '../src/skills/index.ts';
import { evidenceFor, fakeClient, fakeMineflayerBot, vec3 } from './skill-fakes.ts';

function world(travelRadius = 128) {
  const client = fakeClient();
  const scene = fakeMineflayerBot(client, { dimension: 'overworld' });
  scene.fill(-30, -1, -30, 30, -1, 30, 'grass_block');
  const evidence = evidenceFor(client);
  const session = { bot: scene.bot, evidence, connectionEpoch: 1 } as unknown as GameSession & { connectionEpoch: number };
  const clock = { now: () => 1_000 };
  const ids = sequentialIds();
  const perception = new PerceptionService({ session: () => session, clock, ids, observationRadius: 16, travelRadius, rays: 800 });
  const services = { perception, knowledge: new VersionKnowledge({ version: '26.1.2' }), ledger: new EvidenceLedger(clock), clock, limits: { observationRadius: 16, travelRadius, ownerLossMs: 1_000 } };
  const candidates = new TaskCandidateGenerator({ registry: new SkillRegistry(allSkills()), services, session: () => session, ids });
  perception.admitTravelAnchor(1);
  return { scene, session, perception, candidates, evidence };
}

const exploreTask = (ref: { snapshotId: string; handle: string }): TaskSpec => ({
  objective: 'Explore toward the chosen waypoint.',
  decisionInstruction: 'Walk to the chosen frontier.',
  allowedCapabilities: ['explore_frontier'],
  targetSelectors: [],
  parameters: { frontier: ref },
  completion: { predicate: 'visited_location', target: { kind: 'observed', snapshotId: ref.snapshotId, handle: ref.handle }, within: 2 },
});

describe('MB-PLAN-003 frontier references', () => {
  it('the same visible safe waypoint re-grounds into the next snapshot; the generated candidate targets exactly it', () => {
    const w = world();
    try {
      const first = w.perception.take(1)!;
      const f = first.frontiers[0]!;
      assert.ok(f, 'a visible safe frontier exists');
      const next = w.perception.take(1)!;
      const same = next.frontiers.find((x) => x.at.x === f.at.x && x.at.y === f.at.y && x.at.z === f.at.z)!;
      assert.equal(w.perception.translateHandle(first.id, f.handle, next.id), same.handle);
      const set = w.candidates.generate(exploreTask({ snapshotId: first.id, handle: f.handle }), next);
      assert.equal(set.candidates.length, 1, JSON.stringify(set.unavailable));
      assert.deepEqual(set.candidates[0]!.parameters, { frontier: { snapshotId: next.id, handle: same.handle } }, 'exactly the same waypoint, never another frontier');
    } finally {
      w.evidence.detach();
    }
  });

  it('a move_near target parameter {kind:"handle"} naming a shown frontier re-grounds the same way', () => {
    const w = world();
    try {
      const first = w.perception.take(1)!;
      const f = first.frontiers[0]!;
      const next = w.perception.take(1)!;
      const same = next.frontiers.find((x) => x.at.x === f.at.x && x.at.y === f.at.y && x.at.z === f.at.z)!;
      const set = w.candidates.generate({ objective: 'o', decisionInstruction: 'd', allowedCapabilities: ['move_near'], targetSelectors: [], parameters: { target: { kind: 'handle', snapshotId: first.id, handle: f.handle } }, completion: { predicate: 'visited_location', target: { kind: 'observed', snapshotId: first.id, handle: f.handle }, within: 2 } }, next);
      assert.ok(set.candidates.length >= 1, JSON.stringify(set.unavailable));
      for (const c of set.candidates) assert.deepEqual((c.parameters as Record<string, unknown>)['target'], { kind: 'handle', snapshotId: next.id, handle: same.handle });
    } finally {
      w.evidence.detach();
    }
  });

  it('a waypoint that is no longer safe (now blocked) is refused as stale; no other frontier is substituted', () => {
    const w = world();
    try {
      const first = w.perception.take(1)!;
      const f = first.frontiers[0]!;
      // make the waypoint unsafe: fill its standing cell and the cell above
      w.scene.fill(Math.floor(f.at.x), Math.floor(f.at.y), Math.floor(f.at.z), Math.floor(f.at.x), Math.floor(f.at.y) + 1, Math.floor(f.at.z), 'stone');
      const next = w.perception.take(1)!;
      assert.ok(next.frontiers.length > 0, 'other frontiers still exist');
      assert.equal(next.frontiers.some((x) => x.at.x === f.at.x && x.at.y === f.at.y && x.at.z === f.at.z), false);
      assert.equal(w.perception.translateHandle(first.id, f.handle, next.id), undefined);
      const set = w.candidates.generate(exploreTask({ snapshotId: first.id, handle: f.handle }), next);
      assert.equal(set.candidates.length, 0, 'no fallback to an unrelated frontier');
      assert.ok(set.unavailable.some((u) => u.capability === 'explore_frontier'), JSON.stringify(set.unavailable));
    } finally {
      w.evidence.detach();
    }
  });

  it('a waypoint no longer produced after moving (e.g. outside the admitted travel bounds) is not re-grounded', () => {
    const w = world(14);
    try {
      const first = w.perception.take(1)!;
      const far = [...first.frontiers].sort((a, b) => b.distance - a.distance)[0]!;
      w.scene.bot.entity.position = vec3(-far.at.x, 0, -far.at.z); // opposite side; the admission anchor stays
      const next = w.perception.take(1)!;
      const reproduced = next.frontiers.some((x) => x.at.x === far.at.x && x.at.y === far.at.y && x.at.z === far.at.z);
      assert.equal(w.perception.translateHandle(first.id, far.handle, next.id) !== undefined, reproduced, 'translated iff the same waypoint is produced again');
      for (const f of next.frontiers) assert.ok(w.perception.withinTravel(f.at), 'every produced frontier is inside the admitted bounds');
    } finally {
      w.evidence.detach();
    }
  });

  it('lifecycle invalidation and a new connection void earlier frontier handles', () => {
    const w = world();
    try {
      const before = w.perception.take(1)!;
      const h = before.frontiers[0]!;
      w.perception.invalidate('lifecycle_death');
      w.perception.admitTravelAnchor(2);
      const after = w.perception.take(2)!;
      assert.ok(after.frontiers.some((x) => x.at.x === h.at.x && x.at.z === h.at.z), 'the same geometry still yields the waypoint');
      assert.equal(w.perception.translateHandle(before.id, h.handle, after.id), undefined, 'but the old handle is void after the lifecycle interruption');
      const again = w.perception.take(2)!;
      (w.session as { connectionEpoch: number }).connectionEpoch = 2;
      const other = w.perception.take(2)!;
      assert.equal(w.perception.translateHandle(again.id, again.frontiers[0]!.handle, other.id), undefined, 'another connection cannot re-ground it');
    } finally {
      w.evidence.detach();
    }
  });
});
