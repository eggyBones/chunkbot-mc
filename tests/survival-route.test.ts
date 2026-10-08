// S-C12-R5: production tracker/service packets on an admitted recovery goal.
// These reproduce the active-support suppression; they do not reconstruct missing real-run packets.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { survivalScopeDirectory } from '../src/survival/store.ts';
import { after, it } from 'node:test';
import type { SurvivalProposal } from '../src/contracts/survival.ts';
import { survivalSkills } from '../src/skills/survival.ts';
import { assessInput, cleanupRoots, dieWithItems, harness, OW, respawnFresh, SESSION_OW, settle, slot, snapshot } from './survival-helpers.ts';
after(cleanupRoots);
const SITE = { x: 205.5, y: -60, z: 205.5 };
const fence = { goalId: 'goal-r500', goalEpoch: 3, connectionEpoch: 1 };
async function scene(farRoute?: () => string | undefined) {
  const h = harness({ ...(farRoute ? { farRoute } : {}) });
  h.pos.at = SITE;
  const kit = { 9: slot('oak_planks', 16), 36: slot('bread', 8), 37: slot('oak_log', 2) };
  h.packets.inventory(kit); h.packets.health(20);
  dieWithItems(h, kit, 'death.attack.genericKill');
  const id = h.service.deathContext().captureId!;
  h.service.linkIncident(id, 'mf-0001');
  respawnFresh(h, {}, { dimensionName: OW, location: { x: 205, y: -60, z: 205 } });
  h.pos.at = farRoute ? { x: 1, y: -60, z: -7 } : { x: 200.5, y: -60, z: 205.5 };
  await settle(h);
  const d = h.service.assess(assessInput(h));
  assert.equal(d.kind, 'propose', JSON.stringify(d));
  const p = (d as { proposal: SurvivalProposal }).proposal;
  h.service.onSupportAdmitted({ proposalId: p.proposalId, ...fence, admittedAtMs: h.clock.now() });
  await settle(h);
  return { h, id, p };
}
it('R5: route-passive planks16/logs2 update the durable manifest and incident; later scoped bread8 completes exactly once', async () => {
  const { h, id } = await scene(() => 'locator_route_legs');
  const admitted = h.service.status(h.clock.now()).incidents[0]!;
  for (const [entityId, stack] of [[25, slot('oak_planks', 16)], [26, slot('oak_log', 2)]] as const) {
    h.packets.spawnItem(entityId, stack, SITE); h.packets.collect(entityId, stack.itemCount); h.packets.destroy(entityId);
  }
  h.packets.inventory({ 9: slot('oak_planks', 16), 37: slot('oak_log', 2) });
  const partial = h.service.status(h.clock.now()).incidents[0]!;
  assert.equal(partial.status, 'partially_recovered');
  assert.deepEqual(h.service.incidentReturns(id)?.regained, { 'minecraft:oak_planks': 16, 'minecraft:oak_log': 2 });
  const target = h.service.recoveryTarget({ ...fence, dimension: SESSION_OW });
  assert.ok(!('error' in target));
  assert.deepEqual(target.sought, new Map([['minecraft:bread', 8]]));
  assert.deepEqual(partial.incidental, []);
  // The scoped executor defers only its frozen bread entity, preventing double credit.
  const plan = h.service.recoveryCollectPlan(fence);
  h.packets.spawnItem(27, slot('bread', 8), SITE); plan.reserve(27); h.packets.collect(27, 8); h.packets.destroy(27);
  assert.equal(h.service.incidentReturns(id)?.regained['minecraft:bread'], undefined);
  assert.equal(h.service.recordRegain(fence, 'minecraft:bread', 8, 'act-r500', h.service.collectedFacts(1, 27)?.meta), 8);
  plan.settled(27); plan.close();
  assert.equal(h.service.recordRegain(fence, 'minecraft:bread', 8, 'act-r501'), 0);
  assert.equal(h.service.status(h.clock.now()).incidents[0]?.status, 'recovered');
  assert.deepEqual(h.service.incidentReturns(id)?.regained, { 'minecraft:oak_planks': 16, 'minecraft:oak_log': 2, 'minecraft:bread': 8 });
  assert.deepEqual(h.service.status(h.clock.now()).incidents[0]?.budget, admitted.budget, 'packet returns do not refill or reset the admitted budget');
  assert.equal(h.events.filter((e) => e['type'] === 'survival_own_collect').length, 3);
  await settle(h); await h.service.close();
  const reload = harness({ root: h.root });
  const record = reload.service.status(reload.clock.now()).incidents[0]!;
  assert.equal(record.status, 'recovered');
  const dir = survivalScopeDirectory(h.root, { worldProfile: 'test-world', worldRevision: 1, botProfile: 'chunkbot' });
  const file = readdirSync(dir).filter((f) => /^survival-.*\.json$/.test(f)).sort().at(-1)!;
  const durable = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  assert.deepEqual(durable.body.episodes[0].manifest.missing.map((m: { key: string; count: number; regained: number }) => [m.key, m.count, m.regained]), [['minecraft:oak_planks', 16, 16], ['minecraft:bread', 8, 8], ['minecraft:oak_log', 2, 2]]);
  assert.deepEqual(durable.body.episodes[0].regained.map((r: { provenance: string }) => r.provenance), ['server_attributed_collect', 'server_attributed_collect', 'scoped_visible_drop']);
  assert.deepEqual(record.budget, admitted.budget);
  await reload.service.close();
});
it('R5: unknown, foreign64, partial collect of an oversized pile, wrong identity and known orb remain distinct during route recovery', async () => {
  for (const mode of ['unknown', 'foreign64', 'oversized_partial', 'wrong_identity', 'orb'] as const) {
    const { h, id } = await scene();
    if (mode === 'foreign64' || mode === 'oversized_partial') h.packets.spawnItem(68, slot('bread', 64), SITE);
    if (mode === 'wrong_identity') h.packets.spawnItem(68, slot('bread', 8, [{ type: 'custom_name', data: 'foreign' }]), SITE);
    if (mode === 'orb') h.packets.spawnOther(68, SITE);
    const count = mode === 'foreign64' ? 64 : mode === 'oversized_partial' ? 4 : 8;
    h.packets.collect(68, count); h.packets.destroy(68);
    assert.deepEqual(h.service.incidentReturns(id)?.regained, {}, mode);
    assert.equal(h.service.incidentReturns(id)?.attribution, ['unknown', 'foreign64', 'oversized_partial'].includes(mode) ? 'unknown' : 'server_attributed', mode);
    const effects = h.service.status(h.clock.now()).incidents[0]?.incidental ?? [];
    assert.equal(effects.length, mode === 'orb' ? 0 : 1, mode);
    if (mode !== 'orb') { assert.equal(effects[0]?.count, count); assert.equal(effects[0]?.key, mode === 'unknown' ? undefined : 'minecraft:bread'); }
    await h.service.close();
  }
});
it('R5: first announced outside the incident radius then moved into it is foreign; inventory gains alone cannot prove return', async () => {
  const { h, id } = await scene();
  h.packets.spawnItem(68, slot('oak_planks', 16), { x: 0, y: -60, z: 0 });
  h.packets.client.emit('sync_entity_position', { entityId: 68, ...SITE });
  h.packets.collect(68, 16); h.packets.destroy(68);
  h.packets.inventory({ 9: slot('oak_planks', 16) });
  assert.deepEqual(h.service.incidentReturns(id)?.regained, {});
  assert.equal(h.service.status(h.clock.now()).incidents[0]?.status, 'pending');
  assert.deepEqual(h.service.status(h.clock.now()).incidents[0]?.incidental?.map((e) => [e.key, e.count]), [['minecraft:oak_planks', 16]]);
  await h.service.close();
});
it('R5: far-route guidance requires the installed routing seam; local primitive remains bounded', async () => {
  const { h, p } = await scene(() => 'locator_route_legs');
  assert.equal(p.execution.kind, 'planner_goal');
  if (p.execution.kind === 'planner_goal') { assert.match(p.execution.instruction, /route_travel with destination own_death/); assert.ok(p.execution.context.suggestedCapabilities.includes('route_travel')); }
  const skill = survivalSkills(h.service).find((s) => s.descriptor.id === 'go_to_death_site')!;
  const resolved = skill.resolve({ snapshot: snapshot({ goalEpoch: 3, at: { x: 1, y: -60, z: -7 } }), services: { perception: { withinTravel: () => false } } } as never);
  assert.equal(resolved.drafts.length, 0);
  assert.equal(resolved.unavailable?.[0]?.reason, 'outside_travel_bounds');
  assert.match(resolved.unavailable?.[0]?.detail ?? '', /If separately registered and authorized/);
  assert.equal(JSON.stringify(skill.descriptor).includes('not integrated'), false);
  await h.service.close();
  const absent = harness(); absent.pos.at = SITE;
  absent.packets.inventory({ 36: slot('bread', 8) }); absent.packets.health(20); dieWithItems(absent, { 36: slot('bread', 8) });
  absent.service.linkIncident(absent.service.deathContext().captureId!, 'mf-0001');
  respawnFresh(absent, {}, { dimensionName: OW, location: { x: 205, y: -60, z: 205 } }); absent.pos.at = { x: 1, y: -60, z: -7 };
  await settle(absent); const d = absent.service.assess(assessInput(absent));
  assert.ok(d.kind !== 'propose' || d.proposal.routine !== 'death_recovery');
  assert.ok(absent.service.status(absent.clock.now()).blocked.some((b) => b.reason === 'outside_travel_bounds'));
  await absent.service.close();
});

it('R5: stopping a frozen plan with a collect awaiting settlement makes lineage unknown; a closed plan cannot suppress later packets', async () => {
  const { h, id } = await scene();
  const scope = h.service.recoveryCollectPlan(fence);
  h.packets.spawnItem(25, slot('oak_planks', 16), SITE); scope.reserve(25); h.packets.collect(25, 16); h.packets.destroy(25);
  scope.close();
  assert.equal(h.service.incidentReturns(id)?.attribution, 'unknown');
  assert.deepEqual(h.service.incidentReturns(id)?.regained, {});
  scope.reserve(26); // closed scopes cannot reclaim an entity
  h.packets.spawnItem(26, slot('oak_log', 2), SITE); h.packets.collect(26, 2); h.packets.destroy(26);
  assert.deepEqual(h.service.incidentReturns(id)?.regained, { 'minecraft:oak_log': 2 });
  await h.service.close();
});
it('R5: passive receipt reconciliation fences old actions and never merges two same-id/count packets', async () => {
  const { h } = await scene();
  h.packets.spawnItem(68, slot('dirt', 8), SITE); h.packets.collect(68, 8); h.packets.destroy(68);
  const cursor = h.service.collectCursor();
  assert.equal(h.service.takePassiveCollect(cursor, 1, 68, 8), undefined);
  h.packets.spawnItem(68, slot('dirt', 8), SITE); h.packets.collect(68, 8); h.packets.destroy(68);
  assert.equal(h.service.takePassiveCollect(cursor, 1, 68, 8)?.incidentalRecorded, true);
  assert.equal(h.service.takePassiveCollect(cursor, 1, 68, 8), undefined);
  assert.deepEqual(h.service.status(h.clock.now()).incidents[0]?.incidental?.map((e) => [e.key, e.count]), [['minecraft:dirt', 8], ['minecraft:dirt', 8]]);
  await h.service.close();
});
