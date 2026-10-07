// MB-FLOW-003-C7 (offline, inference-free): the leased 26.1.2 trial
// (batch002-survival-261-gates-01, G2) showed the session dimension is
// mineflayer's bare `overworld` while the server GlobalPos says
// `minecraft:overworld`; the policy then refused the recovery as
// `cross_dimension`. These tests reproduce that exact split: session,
// snapshot and lifecycle in the session form, packets in the wire form.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { sameDimension, sessionDimension } from '../src/survival/items.ts';
import { NETHER, OW, SESSION_OW, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, settle, slot, type Harness } from './survival-helpers.ts';

after(cleanupRoots);

const KIT = { 36: slot('iron_pickaxe', 1, [{ type: 'damage', data: 10 }]), 37: slot('bread', 4), 9: slot('cobblestone', 20) };

async function die(h: Harness, dimensionName: string): Promise<void> {
  h.packets.inventory(KIT);
  h.packets.health(20, 20);
  h.pos.at = { x: 29.6, y: 64, z: 10.2 };
  dieWithItems(h, KIT);
  h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
  respawnFresh(h, {}, { dimensionName, location: { x: 30, y: 64, z: 10 } });
  await settle(h);
}

describe('C7 dimension identity (session vs wire spelling)', () => {
  it('canonical helpers: the minecraft namespace is the only difference ignored', () => {
    assert.equal(sessionDimension('minecraft:overworld'), 'overworld');
    assert.equal(sessionDimension('overworld'), 'overworld');
    assert.equal(sessionDimension('mypack:minecraft:overworld'), 'mypack:minecraft:overworld');
    assert.ok(sameDimension('minecraft:overworld', 'overworld'));
    assert.ok(sameDimension('minecraft:the_nether', 'the_nether'));
    assert.ok(!sameDimension('minecraft:the_nether', 'overworld'));
    assert.ok(!sameDimension('mypack:overworld', 'overworld'), 'a datapack dimension is not the vanilla one');
    assert.ok(!sameDimension(undefined, 'overworld'));
    assert.ok(!sameDimension(undefined, undefined));
  });

  it('trial G2 reproduction: a namespaced GlobalPos in the session dimension proposes death_recovery, not resupply', async () => {
    const h = harness();
    assert.equal(h.pos.dimension, SESSION_OW);
    await die(h, OW);
    const inc = h.service.status(h.clock.now()).incidents[0];
    assert.equal(inc?.site.source, 'server_death_location');
    assert.equal(inc?.site.dimension, 'overworld', 'stored in the session spelling');
    const d = h.service.assess(assessInput(h));
    assert.equal(d.kind, 'propose', JSON.stringify(d));
    const p = (d as { proposal: SurvivalProposal }).proposal;
    assert.equal(p.routine, 'death_recovery');
    assert.ok(!h.service.status(h.clock.now()).blocked.some((b) => b.reason === 'cross_dimension'));
    // The client estimate is compared with the server site (was skipped when the spellings differed).
    const ep = (h.service as unknown as { book: { get(id: string): { site: { clientEstimateOffBy?: number } } | undefined } }).book.get(inc?.episodeId as string);
    assert.equal(typeof ep?.site.clientEstimateOffBy, 'number');
    h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: 'goal-dim7', goalEpoch: 5, connectionEpoch: 1, admittedAtMs: h.clock.now() });
    await settle(h);
    // The skills fence with String(bot.game.dimension) (session form); both spellings resolve the same target.
    for (const dimension of [SESSION_OW, OW]) {
      const t = h.service.recoveryTarget({ goalEpoch: 5, connectionEpoch: 1, dimension });
      assert.ok(!('error' in t), JSON.stringify(t));
      assert.equal(t.site.dimension, 'overworld');
    }
    assert.equal(h.service.current({ goalEpoch: 5, connectionEpoch: 1, dimension: SESSION_OW })?.dimension, 'overworld');
  });

  it('a genuinely different dimension stays blocked (cross_dimension), in either spelling', async () => {
    const h = harness();
    await die(h, NETHER);
    const d = h.service.assess(assessInput(h));
    assert.ok(d.kind !== 'propose' || d.proposal.routine !== 'death_recovery');
    assert.ok(h.service.status(h.clock.now()).blocked.some((b) => b.routine === 'death_recovery' && b.reason === 'cross_dimension'));
  });

  it('the login last-death GlobalPos is reported in the session spelling', () => {
    const h = harness();
    h.packets.client.emit('login', { entityId: 42, worldState: { name: OW, death: { dimensionName: OW, location: { x: 1, y: 2, z: 3 } } } });
    const tracker = (h.service as unknown as { tracker: { loginDeathLocation(): { dimension: string } | undefined } }).tracker;
    assert.equal(tracker.loginDeathLocation()?.dimension, 'overworld');
  });
});
