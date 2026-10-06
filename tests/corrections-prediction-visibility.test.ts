// Maintained regressions for the MB-SKL-009 authority boundary in OBSERVATION:
// a voxel the client model changed by local prediction (e.g. Mineflayer's
// finished dig set to air) is unknown/opaque in the authoritative world view
// (sessionWorld) until the server states it. Runs the REAL PerceptionService,
// ServerEvidence, registered resolvers and the connection's prediction tap over
// a Mineflayer-shaped bot using the installed 26.1.2 registry and shapes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, systemClock, type ObservationSnapshot, type TaskSpec } from '../src/contracts/index.ts';
import { taskHints } from '../src/execution/candidates.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence, tapClientPredictions } from '../src/game/server-evidence.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService, sessionWorld } from '../src/perception/perception.ts';
import { UNCONFIRMED_BLOCK } from '../src/perception/visibility.ts';
import type { SkillServices } from '../src/skills/definition.ts';
import { liveBlock } from '../src/skills/common.ts';
import { mineBlock } from '../src/skills/mining.ts';
import { placeBlock } from '../src/skills/placement.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2, vec3 } from './skill-fakes.ts';

const stateOf = (name: string) => REGISTRY_26_1_2.blocksByName[name]?.defaultState as number;

/** Wall at z=3 (x -5..5, y 0..3) hiding ore (0,0,5), a cow (0.5,0,6.5) and a dropped apple (0.5,0,4.5). */
function scene() {
  const client = fakeClient();
  const fake = fakeMineflayerBot(client, { loaded: 16 });
  fake.fill(-10, -1, -10, 10, -1, 10, 'grass_block');
  fake.fill(-5, 0, 3, 5, 3, 3, 'stone_bricks');
  fake.setBlock(0, 0, 5, 'diamond_ore');
  fake.addEntity({ id: 10, type: 'mob', name: 'cow', at: { x: 0.5, y: 0, z: 6.5 }, height: 1.4 });
  const drop = fake.addEntity({ id: 11, type: 'other', name: 'item', at: { x: 0.5, y: 0, z: 4.5 }, height: 0.25 });
  Object.assign(drop, { getDroppedItem: () => ({ name: 'apple', count: 1 }) });
  const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never);
  evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const perception = new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 16, travelRadius: 64 });
  const services: SkillServices = { perception, knowledge: new VersionKnowledge({ version: '26.1.2' }), ledger: new EvidenceLedger(systemClock), clock: systemClock, limits: { observationRadius: 16, travelRadius: 64, ownerLossMs: 1_000 } };
  /** Mineflayer-style local prediction: the client model changes, the server has said nothing. */
  const predictAir = (x: number, y: number, z: number) => {
    evidence.notePrediction(x, y, z);
    fake.setBlock(x, y, z, 'air');
  };
  const serverSays = (x: number, y: number, z: number, name: string) => {
    fake.setBlock(x, y, z, name); // Mineflayer applies the server statement to its world
    client.emit('block_change', { location: vec3(x, y, z), type: stateOf(name) });
  };
  const view = () => {
    const snap = perception.take(1) as ObservationSnapshot;
    return {
      snap,
      ore: snap.blocks.some((b) => b.key === 'minecraft:diamond_ore') || snap.blockSummary.some((b) => b.key === 'minecraft:diamond_ore'),
      cow: snap.entities.some((e) => e.key === 'minecraft:cow'),
      drop: snap.drops.some((d) => d.key === 'minecraft:apple'),
      oreNow: perception.blockVisibleNow(0, 0, 5),
      cowNow: perception.entityVisibleNow(10),
      dropNow: perception.entityVisibleNow(11),
    };
  };
  return { fake, client, evidence, session, perception, services, predictAir, serverSays, view };
}

const ALL_HIDDEN = { ore: false, cow: false, drop: false, oreNow: false, cowNow: false, dropNow: false };
const ALL_SHOWN = { ore: true, cow: true, drop: true, oreNow: true, cowNow: true, dropNow: true };
const flags = (v: ReturnType<ReturnType<typeof scene>['view']>) => ({ ore: v.ore, cow: v.cow, drop: v.drop, oreNow: v.oreNow, cowNow: v.cowNow, dropNow: v.dropNow });

describe('MB-SKL-009 unconfirmed client predictions never reveal hidden world data', () => {
  it('a predicted hole hides ore, entity and drop in snapshots and live visibility; a server-confirmed hole reveals them', () => {
    const s = scene();
    assert.deepEqual(flags(s.view()), ALL_HIDDEN, 'scene precondition: genuinely occluded');
    s.predictAir(0, 0, 3);
    s.predictAir(0, 1, 3);
    const predicted = s.view();
    assert.deepEqual(flags(predicted), ALL_HIDDEN, 'the client-only hole reveals nothing');
    assert.ok(!predicted.snap.blocks.some((b) => b.key === `minecraft:${UNCONFIRMED_BLOCK}`) && !predicted.snap.blockSummary.some((b) => b.key.includes(UNCONFIRMED_BLOCK)), 'the unconfirmed voxel itself is not reported');
    assert.ok(predicted.snap.frontiers.every((f) => !(Math.abs(f.at.x) <= 4 && f.at.z > 3)), 'no frontier through the unconfirmed hole (only around the wall ends)');
    assert.equal(sessionWorld(s.session).blockAt(0, 0, 3)?.name, UNCONFIRMED_BLOCK);
    s.serverSays(0, 0, 3, 'air');
    s.serverSays(0, 1, 3, 'air');
    assert.equal(s.evidence.predictionPending(0, 0, 3), false);
    assert.deepEqual(flags(s.view()), ALL_SHOWN, 'the server-confirmed hole legitimately reveals all three');
  });

  it('a server rejection restores the opaque wall', () => {
    const s = scene();
    s.predictAir(0, 0, 3);
    s.predictAir(0, 1, 3);
    s.serverSays(0, 0, 3, 'stone_bricks'); // the server kept the block (e.g. dig rejected)
    s.serverSays(0, 1, 3, 'stone_bricks');
    assert.equal(s.evidence.predictionPending(0, 0, 3), false);
    assert.equal(sessionWorld(s.session).blockAt(0, 0, 3)?.name, 'stone_bricks');
    assert.deepEqual(flags(s.view()), ALL_HIDDEN);
  });

  it('ordinary see-through positives and already-known history survive an unrelated pending prediction', () => {
    const s = scene();
    s.fake.setBlock(3, 1, 3, 'glass');
    s.fake.setBlock(3, 1, 5, 'emerald_block');
    // History: the ore seen from behind the wall stays a valid (timestamped) observation.
    s.fake.bot.entity.position = vec3(0.5, 0, 8.5);
    const behind = s.perception.take(1) as ObservationSnapshot;
    const oreHandle = behind.blocks.find((b) => b.key === 'minecraft:diamond_ore')?.handle;
    assert.ok(oreHandle, 'ore seen from behind the wall');
    s.fake.bot.entity.position = vec3(3.5, 0, 0.5); // in line with the glass window
    s.predictAir(-3, 0, 3); // an unrelated predicted voxel elsewhere in the wall
    const now = s.perception.take(1) as ObservationSnapshot;
    assert.ok(now.blocks.some((b) => b.key === 'minecraft:emerald_block'), 'block behind glass still visible');
    assert.ok(!now.blocks.some((b) => b.key === 'minecraft:diamond_ore'), 'the ore is not visible from here');
    const rec = s.perception.resolve(behind.id, oreHandle);
    assert.ok(!('error' in rec), 'the earlier observation remains resolvable history');
  });

  it('skill resolvers cannot target through or into an unconfirmed voxel', () => {
    const s = scene();
    s.fake.give(36, 'iron_pickaxe', 1);
    s.fake.give(37, 'cobblestone', 4);
    s.fake.bot.entity.position = vec3(0.5, 0, 1.5);
    s.predictAir(0, 0, 3);
    s.predictAir(0, 1, 3);
    s.predictAir(1, 0, 2); // client predicts air at a placement destination in front of the wall
    const snap = s.perception.take(1) as ObservationSnapshot;
    const t = (over: Partial<TaskSpec>): TaskSpec => ({ objective: 'o', decisionInstruction: 'd', allowedCapabilities: [], targetSelectors: [], parameters: {}, completion: { predicate: 'inventory_amount', selector: 'minecraft:diamond', atLeast: 1, mode: 'possess' }, ...over });
    const mineTask = t({ allowedCapabilities: ['mine_block'] });
    const mined = mineBlock.resolve({ task: mineTask, hints: taskHints(mineTask), snapshot: snap, session: s.session, services: s.services });
    assert.equal(mined.drafts.length, 0, 'no mining candidate for ore behind an unconfirmed hole');
    const placeTask = t({ allowedCapabilities: ['place_block'], parameters: { item: 'minecraft:cobblestone' }, completion: { predicate: 'block_state', target: { kind: 'registry', key: 'minecraft:cobblestone' }, expect: 'minecraft:cobblestone' } });
    const placed = placeBlock.resolve({ task: placeTask, hints: taskHints(placeTask), snapshot: snap, session: s.session, services: s.services });
    assert.ok(placed.drafts.length > 0, 'other free faces remain (positive)');
    assert.equal(placed.drafts.some((d) => /-> 1,0,2\)/.test(d.description)), false, 'never into the unconfirmed voxel');
    assert.equal(placed.drafts.some((d) => /at 0,[01],3 /.test(d.description)), false, 'never against the unconfirmed voxel');
    // Executing against a handle whose voxel now has a pending prediction is refused (no "now air" claim).
    const wall = snap.blocks.find((b) => b.key === 'minecraft:stone_bricks' && !(b.at.x === 0 && b.at.z === 3 && b.at.y <= 1));
    assert.ok(wall, 'a visible wall block');
    assert.ok(!('error' in liveBlock(s.services, s.session, snap.id, wall.handle)), 'positive: valid before any prediction');
    s.predictAir(wall.at.x, wall.at.y, wall.at.z);
    const live = liveBlock(s.services, s.session, snap.id, wall.handle);
    assert.ok('error' in live && live.error === 'target_unconfirmed', JSON.stringify(live));
    // Positive control: once the server confirms the hole, the same resolver offers the ore.
    s.serverSays(0, 0, 3, 'air');
    s.serverSays(0, 1, 3, 'air');
    const after = s.perception.take(1) as ObservationSnapshot;
    const minedAfter = mineBlock.resolve({ task: mineTask, hints: taskHints(mineTask), snapshot: after, session: s.session, services: s.services });
    assert.ok(minedAfter.drafts.some((d) => /diamond_ore/.test(d.description)), `ore offered after confirmation: ${JSON.stringify(minedAfter.unavailable)}`);
  });

  it("the connection's prediction tap marks exactly Mineflayer's local world updates", () => {
    const s = scene();
    const applied: Array<{ x: number; stateId: number }> = [];
    const bot = s.fake.bot as unknown as { _updateBlockState?: (p: { x: number; y: number; z: number }, id: number) => void };
    bot._updateBlockState = (p, id) => {
      applied.push({ x: p.x, stateId: id });
      s.fake.setBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), id === 0 ? 'air' : 'stone_bricks');
    };
    tapClientPredictions(s.fake.bot, () => s.evidence);
    tapClientPredictions(s.fake.bot, () => s.evidence); // idempotent
    bot._updateBlockState?.({ x: 0.3, y: 0, z: 3.7 }, 0); // what digging.js does when a dig finishes locally
    assert.equal(applied.length, 1, 'the original update still runs exactly once');
    assert.equal(s.evidence.predictionPending(0, 0, 3), true);
    assert.equal(sessionWorld(s.session).blockAt(0, 0, 3)?.name, UNCONFIRMED_BLOCK);
    s.serverSays(0, 0, 3, 'air');
    assert.equal(s.evidence.predictionPending(0, 0, 3), false, 'the server statement resolves it');
    assert.equal(sessionWorld(s.session).blockAt(0, 0, 3)?.name, 'air');
  });
});
