// W-H6: actual synchronous reader ordering and strict harness mechanics.
// No fixture/credential/network/provider/controls; both installed registries.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { SessionSafetyReader, registryFactsOf } from '../src/safety/adapter.ts';
import { SafetyTracker } from '../src/safety/tracker.ts';
import { planSafety } from '../src/safety/policy.ts';
import { guardMutationVolume, mobStageRefusals, type MobTrialGate, type TrialSummon } from '../src/safety/trial-arena.ts';
import { readMobStage, trialSummonEffects, verifyEffectFreeCreeper } from '../src/safety/trial-mobs.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2 } from './skill-fakes.ts';
import { mob, policyCtx, self } from './safety-helpers.ts';

const md = createRequire(import.meta.url)('minecraft-data') as (v: string) => typeof REGISTRY_26_1_2;
const target: TrialSummon = { tag: 'cbsafe_test_zombie', uuid: 'current-zombie', entityId: 50, key: 'minecraft:zombie', visible: true };

function rig(version: string, gate: MobTrialGate, readCostMs: number) {
  const client = fakeClient(); const fake = fakeMineflayerBot(client);
  const registry = md(version); const facts = registryFactsOf(registry);
  Object.assign(fake.bot, { registry, version, quickBarSlot: 0 });
  Object.assign(fake.bot.entity, { onGround: true });
  fake.fill(-15, -1, -15, 15, -1, 15, 'stone');
  const z = fake.addEntity({ id: 50, uuid: target.uuid, type: 'hostile', name: 'zombie', at: { x: 3, y: 0, z: 0.5 }, height: 1.95 });
  (z as unknown as { metadata: Record<number, unknown> }).metadata = { [facts.metadataIndex('zombie', 'mob_flags')!]: 4, [facts.metadataIndex('zombie', 'baby')!]: false };
  const evidence = new ServerEvidence(client, registry); evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  let now = 1000;
  const tracker = new SafetyTracker(); tracker.attach(client, { connectionEpoch: 1, registry: () => facts, now: () => now });
  client.emit('login', { entityId: 1 });
  const items = new Array(46).fill(null);
  if (gate !== 'M1') for (const [slot, key] of [[36, 'iron_sword'], [5, 'iron_helmet'], [6, 'iron_chestplate']] as const) items[slot] = { itemCount: 1, itemId: registry.itemsByName[key]!.id, components: [] };
  client.emit('window_items', { windowId: 0, stateId: 1, items });
  client.emit('update_health', { health: 20, food: 20, foodSaturation: 5 });
  // Each REAL reader's clock sample starts a synchronous bounded read whose
  // cost advances our controlled clock; entities is causally later than self.
  const reader = new SessionSafetyReader({ session: () => session, perception: { isOwnerEntity: () => false }, tracker, now: () => { const at = now; now += readCostMs; return at; } });
  const order: string[] = [];
  const reads = {
    now: () => { order.push('clock'); return now; },
    self: () => { order.push('self'); return reader.self(); },
    visible: () => { order.push('entities'); return reader.entities({ scanRadius: 16, approachWindowMs: 1500, provokedWindowMs: 6000 }); },
    summons: () => { order.push('identity/LOS'); return [{ ...target }]; },
    plan: (s: ReturnType<SessionSafetyReader['self']> & {}, visible: ReturnType<SessionSafetyReader['entities']>) => { order.push('policy'); return planSafety(s, visible, policyCtx({ nowMs: now })); },
  };
  return { client, reads, order };
}

for (const version of ['26.1.2', '26.2']) describe(`W-H6 causal read-end clock (${version})`, () => {
  it('real reader reproduces +6/+4/+4ms false futures; read-end fixes only those three stage failures', () => {
    for (const [gate, delta] of [['M1', 6], ['M2', 4], ['M2b', 4]] as const) {
      const r = rig(version, gate, delta); const snap = readMobStage(gate, r.reads);
      assert.equal(snap.visible.length, 1);
      assert.equal(snap.visible[0]!.observedAtMs - snap.readStartedAtMs, delta);
      assert.deepEqual(mobStageRefusals(gate, snap.summons, snap.visible, snap.plan, snap.readStartedAtMs), ['stale_visible_evidence'], 'old harness rejects causally later current observations');
      assert.deepEqual(snap.refusals, []);
      assert.equal(snap.plan.kind === 'respond' ? snap.plan.response : snap.plan.kind, gate === 'M1' ? 'retreat' : 'defend');
      assert.deepEqual(r.order, ['clock', 'self', 'entities', 'identity/LOS', 'policy', 'clock']);
      assert.equal(r.client.written.length, 0);
    }
  });

  it('genuine future +1, age501 and unknown time refuse; age500 and current facts still pass', () => {
    const r = rig(version, 'M2', 4); const snap = readMobStage('M2', r.reads);
    for (const age of [0, 500]) assert.deepEqual(mobStageRefusals('M2', snap.summons, snap.visible.map((e) => ({ ...e, observedAtMs: snap.atMs - age })), snap.plan, snap.atMs), []);
    for (const time of [snap.atMs - 501, snap.atMs + 1, NaN, Infinity]) assert.ok(mobStageRefusals('M2', snap.summons, snap.visible.map((e) => ({ ...e, observedAtMs: time })), snap.plan, snap.atMs).includes('stale_visible_evidence'));
    assert.ok(mobStageRefusals('M2', snap.summons, snap.visible, snap.plan, NaN).includes('stale_visible_evidence'));
    const future = rig(version, 'M2', 4);
    const read = future.reads.visible;
    future.reads.visible = () => read().map((e) => ({ ...e, observedAtMs: e.observedAtMs + 5 }));
    assert.ok(readMobStage('M2', future.reads).refusals.includes('stale_visible_evidence'), 'helper never takes max(observation time) to manufacture a later evaluation');
  });
});

describe('W-H6 setup and lost-creeper controls', () => {
  it('missing self/current identity aborts staging without evaluating/admitting work', () => {
    const r = rig('26.2', 'M1', 4);
    assert.throws(() => readMobStage('M1', { ...r.reads, self: () => undefined }), /fresh self facts unavailable/);
    assert.throws(() => readMobStage('M1', { ...r.reads, summons: () => { throw new Error('current tagged identity lost'); } }), /current tagged identity lost/);
    assert.equal(r.order.filter((s) => s === 'policy').length, 0);
    assert.equal(r.client.written.length, 0);
  });

  it('only a uniquely tagged zombie receives fire resistance; creeper and neutral controls receive no effect command', () => {
    assert.deepEqual(trialSummonEffects('zombie', 'cbsafe_test_zombie'), ['effect give @e[tag=cbsafe_test_zombie,x=240,y=-61,z=190,dx=30,dy=13,dz=30] minecraft:fire_resistance infinite 0 true']);
    for (const kind of ['creeper', 'cow', 'wolf', 'unknown']) assert.deepEqual(trialSummonEffects(kind, `cbsafe_test_${kind}`), []);
    assert.throws(() => trialSummonEffects('zombie', 'foreign],limit=1'), /invalid summon tag/);
  });

  it('actual tagged effects check proves absence, retains present/unknown evidence and notices changes after awaits', async () => {
    let hasEffects = false; const seen: string[] = []; const replies: string[] = [];
    const read = async (c: string) => {
      assert.equal(c, 'execute if data entity @e[tag=cbsafe_test_creeper,limit=1,x=240,y=-61,z=190,dx=30,dy=13,dz=30] active_effects[0]'); seen.push(c);
      return hasEffects ? 'Test passed. Count: 1' : 'Test failed';
    };
    const record = (_c: string, reply: string) => { replies.push(reply); };
    await verifyEffectFreeCreeper(read, 'cbsafe_test_creeper', record);
    await Promise.resolve(); hasEffects = true;
    await assert.rejects(verifyEffectFreeCreeper(read, 'cbsafe_test_creeper', record), /effects present or unknown/);
    assert.equal(seen.length, 2); assert.deepEqual(replies, ['Test failed', 'Test passed. Count: 1']);
    for (const unknown of ['No entity was found', 'Command failed', '', 'Test failedTest failed']) await assert.rejects(verifyEffectFreeCreeper(async () => unknown, 'cbsafe_test_creeper', record), /unknown/);
    assert.equal(replies.at(-1), 'Test failedTest failed');
  });

  it('known current effect-free creeper retreats; absent proof and the retained lost-target/cloud scene still refuse', async () => {
    const creep: TrialSummon = { ...target, entityId: 3835, key: 'minecraft:creeper', effectFree: true };
    const fact = mob('creeper', 5, { entityId: 3835 }); const plan = planSafety(self(), [fact], policyCtx());
    assert.deepEqual(mobStageRefusals('M3', [creep], [fact], plan, 1000), []);
    const { effectFree: _unused, ...unknown } = creep;
    for (const s of [unknown, { ...creep, effectFree: false }]) assert.ok(mobStageRefusals('M3', [s], [fact], plan, 1000).includes('server_creeper_effects_unverified'));
    const cloud = mob('area_effect_cloud', 2.97, { entityId: 3844, disposition: 'unknown' });
    const why = mobStageRefusals('M3', [{ ...creep, visible: false }], [cloud], planSafety(self(), [cloud], policyCtx()), 1000);
    for (const refusal of ['summon_identity_or_visibility', 'unexpected_visible_entity', 'target_not_currently_visible', 'policy_prerequisite_retreat']) assert.ok(why.includes(refusal));
    const commands: string[] = [];
    await assert.rejects(guardMutationVolume(async (c) => { commands.push(c); return 'Test passed. Count: 1'; }, 'cbsafe_test', 'Chunkbot', () => {}), /foreign arena occupants present/);
    assert.equal(commands.length, 1); assert.ok(commands.every((c) => c.startsWith('execute if entity @e[tag=!cbsafe_test,type=!player,type=!item,type=!experience_orb,')), 'no cloud type/UUID exemption and no kill/relocation command');
  });
});
