// Shared memory seams for batch002 (progression is the shared writer):
// - exact capture recording: memory records the survival capture it is given
//   (cause included) and returns the fact for the captureId -> factId link;
// - MB-FLOW-003-C5: typed fact durability (a synchronous return is not durable
//   authority; a failed write is reported failed, never durable);
// - retained possessions are not regained evidence;
// - a code-verified shelter never overrides an owner-designated home.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { cleanupRoots, harness, OVERWORLD } from './memory-helpers.ts';

after(() => cleanupRoots());

const deathCtx = { captureId: 'cap-1', dimension: OVERWORLD, position: { x: 10, y: 64, z: 10 }, accuracy: 'client_position_at_death_event' as const, inventory: { source: 'server_sync' as const, capturedAtMs: 1, items: [{ key: 'minecraft:iron_pickaxe', count: 1 }, { key: 'minecraft:bread', count: 3 }] }, cause: { kind: 'observed' as const, detail: 'server death message death.attack.lava' } };

describe('memory death capture and durability seams', () => {
  it('records EXACTLY the given capture (no re-read) and reports durability pending -> durable', async () => {
    const h = harness();
    const { captureId: _c, ...ctx } = deathCtx;
    void _c;
    const fact = h.memory.onLifecycle({ type: 'death', connectionEpoch: 1 }, ctx);
    assert.ok(fact, 'the capture is recorded synchronously');
    assert.equal(fact!.death?.cause.kind, 'observed');
    assert.deepEqual(fact!.death?.lastAliveInventory.items.map((i) => i.key), ['minecraft:iron_pickaxe', 'minecraft:bread']);
    assert.notEqual(h.memory.factDurability(fact!.id), 'durable', 'a synchronous return is not durable authority');
    assert.equal(await h.memory.whenFactDurable(fact!.id, 2_000), 'durable');
    assert.equal(h.memory.factDurability(fact!.id), 'durable');
  });

  it('a failed durable write is reported failed (never durable)', async () => {
    const h = harness({ service: { store: { pid: 123_456, isAlive: () => false, beforeRename: () => { throw new Error('disk full'); } } } });
    const { captureId: _c, ...ctx } = deathCtx;
    void _c;
    const fact = h.memory.onLifecycle({ type: 'death', connectionEpoch: 1 }, ctx)!;
    const r = await h.memory.whenFactDurable(fact.id, 2_000);
    assert.equal(r, 'failed');
    assert.equal(h.memory.factDurability(fact.id), 'failed');
    assert.equal(h.memory.factDurability('mf-nope'), 'unknown');
  });

  it('retained possessions reduce what is missing but are not regained evidence (no_loss)', async () => {
    const h = harness();
    const { captureId: _c, ...ctx } = deathCtx;
    void _c;
    const fact = h.memory.onLifecycle({ type: 'death', connectionEpoch: 1 }, ctx)!;
    const out = await h.memory.updateDeathRecovery(fact.id, { retained: [{ key: 'minecraft:iron_pickaxe', count: 1 }, { key: 'minecraft:bread', count: 3 }] }, { detail: 'respawn inventory retained everything' });
    assert.equal(out.ok, true);
    const d = h.memory.facts().find((f) => f.id === fact.id)!.death!;
    assert.equal(d.recovery.status, 'no_loss');
    assert.equal(d.recovery.regained.length, 0);
    assert.equal(d.recovery.missing.length, 0);
  });

  it('a verified shelter is a trusted home only without an owner-designated home; otherwise a separate location', async () => {
    const h = harness();
    const r1 = await h.memory.recordVerifiedHome({ location: { dimension: OVERWORLD, at: { x: 1, y: 64, z: 1 } }, detail: 'all cells verified' });
    assert.equal(r1.ok, true);
    if (r1.ok) {
      assert.equal(r1.fact.category, 'home');
      assert.equal(r1.fact.source, 'verified_skill');
    }
    h.memory.beginGoal({ goalId: 'goal-own1', epoch: 2, instruction: 'remember this as my base home' });
    const d = await h.memory.designate({ goalId: 'goal-own1', category: 'home', label: 'home', location: { dimension: OVERWORLD, at: { x: 50, y: 64, z: 50 } }, basis: 'owner position' });
    assert.equal(d.ok, true);
    const r2 = await h.memory.recordVerifiedHome({ location: { dimension: OVERWORLD, at: { x: 2, y: 64, z: 2 } }, detail: 'all cells verified' });
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.fact.category, 'location', 'never overrides the owner-designated home');
      assert.equal(r2.fact.label, 'chunkbot shelter');
    }
  });
});
