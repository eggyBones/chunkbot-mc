// W-H4: attribution discrimination through the real packet tracker/reader and
// both exact installed registries. No world, network, controls or inference.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { SessionSafetyReader, registryFactsOf } from '../src/safety/adapter.ts';
import { SafetyTracker } from '../src/safety/tracker.ts';
import { planSafety } from '../src/safety/policy.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2 } from './skill-fakes.ts';
import { policyCtx, self } from './safety-helpers.ts';

const md = createRequire(import.meta.url)('minecraft-data') as (v: string) => typeof REGISTRY_26_1_2;
function rig(version: string) {
  const client = fakeClient();
  const fake = fakeMineflayerBot(client);
  const registry = md(version);
  Object.assign(fake.bot, { registry, version });
  fake.addEntity({ id: 70, type: 'animal', name: 'wolf', at: { x: 2.5, y: 0, z: 0.5 }, height: 0.85 });
  const evidence = new ServerEvidence(client, registry); evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  let now = 1000;
  const tracker = new SafetyTracker();
  const facts = registryFactsOf(registry);
  tracker.attach(client, { connectionEpoch: 1, registry: () => facts, now: () => now });
  client.emit('login', { entityId: 1 });
  const reader = new SessionSafetyReader({ session: () => session, perception: { isOwnerEntity: () => false }, tracker, now: () => now });
  const read = () => reader.entities({ scanRadius: 16, approachWindowMs: 1500, provokedWindowMs: 6000 });
  return { client, fake, tracker, read, facts, advance: (n: number) => { now += n; }, plan: () => planSafety(self({ observedAtMs: now }), read(), policyCtx({ nowMs: now })) };
}

for (const version of ['26.1.2', '26.2']) describe(`W-H4 current neutral attribution (${version})`, () => {
  it('wrong victim and damage from another zombie/projectile never provoke this nearby wolf', () => {
    const r = rig(version);
    r.client.emit('damage_event', { entityId: 70, sourceTypeId: 3, sourceCauseId: 51, sourceDirectId: 51 });
    assert.equal(r.tracker.damage.length, 0, 'damage TO the wolf is not damage TO the bot');
    r.client.emit('damage_event', { entityId: 1, sourceTypeId: 3, sourceCauseId: 51, sourceDirectId: 101 });
    assert.equal(r.tracker.damage[0]?.causeEntityId, 50);
    assert.equal(r.tracker.damage[0]?.directEntityId, 100);
    assert.equal(r.read().find((e) => e.entityId === 70)?.damagedSelfAtMs, null);
    assert.equal(r.plan().kind, 'none');
  });

  it('current self-addressed cause/direct evidence makes the exact wolf an avoidance-only threat; unknown source does not', () => {
    const r = rig(version);
    r.client.emit('damage_event', { entityId: 1, sourceTypeId: 3, sourceCauseId: 0, sourceDirectId: 0 });
    assert.equal(r.read()[0]?.damagedSelfAtMs, null);
    assert.equal(r.plan().kind, 'none');
    r.client.emit('damage_event', { entityId: 1, sourceTypeId: 3, sourceCauseId: 71, sourceDirectId: 71 });
    assert.equal(r.read()[0]?.damagedSelfAtMs, 1000, 'IDs are wire value minus one');
    const p = r.plan();
    assert.equal(p.kind, 'respond');
    if (p.kind === 'respond') {
      assert.equal(p.response, 'retreat');
      assert.equal(p.hazards[0]?.kind, 'provoked_threat');
      assert.ok(p.defense?.refusals.includes('neutral_or_unknown_threat'));
    }
    r.tracker.resetLife();
    r.client.emit('damage_event', { entityId: 1, sourceTypeId: 3, sourceCauseId: 0, sourceDirectId: 71 });
    assert.equal(r.read()[0]?.damagedSelfAtMs, 1000, 'direct entity is independently server-attributed');
  });

  it('stale/lifecycle damage expires, while current aggressive metadata remains avoidance-only', () => {
    const r = rig(version);
    r.client.emit('damage_event', { entityId: 1, sourceTypeId: 3, sourceCauseId: 71, sourceDirectId: 71 });
    r.advance(6001);
    assert.equal(r.read()[0]?.damagedSelfAtMs, null);
    assert.equal(r.plan().kind, 'none');
    r.client.emit('damage_event', { entityId: 1, sourceTypeId: 3, sourceCauseId: 71, sourceDirectId: 71 });
    r.client.emit('respawn', {});
    assert.equal(r.read()[0]?.damagedSelfAtMs, null);
    const wolf = r.fake.bot['entities'] as Record<number, { metadata?: Record<number, unknown> }>;
    wolf[70]!.metadata = { [r.facts.metadataIndex('wolf', 'mob_flags')!]: 4 };
    const p = r.plan();
    assert.equal(p.kind, 'respond');
    if (p.kind === 'respond') assert.equal(p.response, 'retreat');
  });

  it('a damaged source behind opaque terrain is still excluded from current visible input', () => {
    const r = rig(version);
    r.client.emit('damage_event', { entityId: 1, sourceTypeId: 3, sourceCauseId: 71, sourceDirectId: 71 });
    for (let z = -1; z <= 2; z += 1) for (let y = 0; y <= 3; y += 1) r.fake.setBlock(1, y, z, 'stone');
    assert.equal(r.read().length, 0);
    assert.equal(r.plan().kind, 'none', 'no hidden target inference from retained source ID');
    assert.equal(r.client.written.length, 0, 'tracker/reader never send controls/attacks');
  });
});
