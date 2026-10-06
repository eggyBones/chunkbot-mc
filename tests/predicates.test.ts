import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sequentialIds, systemClock, type OutcomePredicate } from '../src/contracts/index.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { ActuatorLeases } from '../src/execution/lease.ts';
import { PredicateEngine } from '../src/execution/predicates.ts';
import type { GameSession } from '../src/game/connection.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { createRequire } from 'node:module';
import { ackSequenced, evidenceFor, fakeClient } from './skill-fakes.ts';

const require = createRequire(import.meta.url);
const registry = require('prismarine-registry')('26.1.2');
const id = (name: string) => registry.itemsByName[name].id as number;

/** A session whose server answers inventory resyncs from `slots` (window-0 numbering). */
function world() {
  const slots = new Map<number, { name: string; count: number }>();
  const client = fakeClient((name, data) => {
    if (name === 'window_click' && data['stateId'] === -1) {
      setImmediate(() => {
        const items = Array.from({ length: 46 }, (_, i) => {
          const s = slots.get(i);
          return s ? { itemCount: s.count, itemId: id(s.name) } : { itemCount: 0 };
        });
        client.emit('window_items', { windowId: 0, stateId: 9, items });
      });
    }
    ackSequenced(client, name, data);
  });
  const evidence = evidenceFor(client);
  (evidence as unknown as { registry: unknown }).registry = registry;
  const bot = { _client: client, registry, currentWindow: null, quickBarSlot: 0, entities: {}, game: { dimension: 'overworld' }, entity: { position: { x: 0, y: 0, z: 0 } }, username: 'Chunkbot', players: {} };
  const session = { bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const ledger = new EvidenceLedger(systemClock);
  const services = {
    perception: new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 8, travelRadius: 32 }),
    knowledge: new VersionKnowledge({ version: '26.1.2' }),
    ledger,
    clock: systemClock,
    limits: { observationRadius: 8, travelRadius: 32, ownerLossMs: 1_000 },
  };
  const leases = new ActuatorLeases({ clock: systemClock, ownerCurrent: () => true, connectionEpoch: () => 1, clearShared: () => ({ steps: [], errors: [] }) });
  return { slots, ledger, leases, engine: new PredicateEngine({ services, session: () => session, leases }) };
}

const signal = () => new AbortController().signal;

describe('goal admission baseline (MB-V1-04)', () => {
  it('captures ALL item counts at admission; an outcome bound LATER measures acquisition from those original counts', async () => {
    const w = world();
    w.slots.set(36, { name: 'cobblestone', count: 3 });
    w.slots.set(37, { name: 'oak_log', count: 1 });
    const baseline = await w.engine.captureBaseline(signal());
    assert.deepEqual(baseline.counts, { 'minecraft:cobblestone': 3, 'minecraft:oak_log': 1 });
    // Before the planner even decides the selector, Chunkbot picks up two cobblestone ...
    w.slots.set(36, { name: 'cobblestone', count: 5 });
    const p: OutcomePredicate = { predicate: 'inventory_amount', selector: 'minecraft:cobblestone', atLeast: 2, mode: 'collect_additional' };
    const fromAdmission = await w.engine.bind(p, signal(), baseline);
    assert.deepEqual(fromAdmission.baselines, { 'inv:minecraft:cobblestone': 3 }, 'original admission count, not the count at binding');
    assert.equal(fromAdmission.boundAtMs, baseline.capturedAtMs);
    assert.equal((await w.engine.evaluate(fromAdmission, signal())).status, 'satisfied', '5 - 3 = 2 acquired since admission');
    const late = await w.engine.bind(p, signal());
    assert.equal((await w.engine.evaluate(late, signal())).status, 'unsatisfied', 'binding at the first plan would have lost the acquisition');
  });

  it('without a server-confirmed inventory the admission baseline is explicit about it (never a client-model fallback)', async () => {
    const w = world();
    const lease = w.leases.acquire({ kind: 'diagnostic', diagnosticId: 'x' });
    const baseline = await w.engine.captureBaseline(signal());
    assert.equal(baseline.counts, null);
    assert.match(baseline.detail, /no server-confirmed inventory at admission: an action holds the actuator/);
    void lease;
  });
});

describe('code-owned predicate evaluation', () => {
  it('binds acquisition baselines at admission from a server-confirmed inventory', async () => {
    const w = world();
    w.slots.set(36, { name: 'stick', count: 2 });
    const p: OutcomePredicate = { predicate: 'inventory_delta', selector: 'minecraft:stick', atLeast: 4, mayBeConsumedLater: true };
    const bound = await w.engine.bind(p, signal());
    assert.deepEqual(bound.baselines, { 'inv:minecraft:stick': 2 });
    assert.equal((await w.engine.evaluate(bound, signal())).status, 'unsatisfied');
    w.slots.set(36, { name: 'stick', count: 6 });
    assert.equal((await w.engine.evaluate(bound, signal())).status, 'satisfied');
  });

  it('an ingredient milestone stays met after verified consumption; final quantities must still hold', async () => {
    const w = world();
    w.slots.set(36, { name: 'stick', count: 2 });
    const milestone = await w.engine.bind({ predicate: 'inventory_delta', selector: 'minecraft:stick', atLeast: 4, mayBeConsumedLater: true }, signal());
    const strict = await w.engine.bind({ predicate: 'inventory_amount', selector: 'minecraft:stick', atLeast: 4, mode: 'collect_additional' }, signal());
    w.slots.set(36, { name: 'stick', count: 6 });
    assert.equal((await w.engine.evaluate(milestone, signal())).status, 'satisfied');
    // Crafting later consumes 3 sticks (recorded by the craft skill from a server resync diff).
    w.ledger.add({ kind: 'consumed', item: 'minecraft:stick', count: 3, atMs: Date.now(), via: 'craft_item' });
    w.slots.set(36, { name: 'stick', count: 3 });
    const m = await w.engine.evaluate(milestone, signal());
    assert.equal(m.status, 'satisfied');
    assert.equal(m.evidence['latched'], true);
    assert.equal((await w.engine.evaluate(strict, signal())).status, 'unsatisfied', 'collect_additional is a current requirement');
  });

  it('possession supports tags; crafting results come only from skill-confirmed ledger entries', async () => {
    const w = world();
    w.slots.set(9, { name: 'oak_log', count: 2 });
    w.slots.set(10, { name: 'birch_log', count: 1 });
    w.slots.set(11, { name: 'oak_planks', count: 4 });
    const logs = await w.engine.bind({ predicate: 'inventory_amount', selector: '#minecraft:logs', atLeast: 3, mode: 'possess' }, signal());
    assert.equal((await w.engine.evaluate(logs, signal())).status, 'satisfied');
    const crafted = await w.engine.bind({ predicate: 'crafting_result', output: 'minecraft:oak_planks', atLeast: 4 }, signal());
    assert.equal((await w.engine.evaluate(crafted, signal())).status, 'unsatisfied', 'holding planks is not proof of crafting them');
    w.ledger.add({ kind: 'crafted', output: 'minecraft:oak_planks', count: 4, consumed: { 'minecraft:oak_log': 1 }, atMs: Date.now() });
    assert.equal((await w.engine.evaluate(crafted, signal())).status, 'satisfied');
  });

  it('missing evidence is unknown, and unknown never satisfies a combination', async () => {
    const w = world();
    // While an action holds the lease, evaluation does not resync and there is no confirmed inventory yet.
    w.leases.acquire({ kind: 'diagnostic', diagnosticId: 'diag-1' });
    const inv = await w.engine.bind({ predicate: 'inventory_amount', selector: 'minecraft:stick', atLeast: 1, mode: 'possess' }, signal());
    assert.equal((await w.engine.evaluate(inv, signal())).status, 'unknown');
    const container = await w.engine.bind(
      { predicate: 'container_state', target: { kind: 'owner_destination', dimension: 'overworld', at: { x: 3, y: 0, z: 3 }, ownerText: 'the chest at 3 0 3' }, selector: 'minecraft:stone', atLeast: 1 },
      signal(),
    );
    const c = await w.engine.evaluate(container, signal());
    assert.equal(c.status, 'unknown');
    assert.match(c.detail, /not been observed/);
    const all = await w.engine.bind({ predicate: 'all', of: [{ predicate: 'crafting_result', output: 'minecraft:stick', atLeast: 1 }, container.predicate] }, signal());
    assert.equal((await w.engine.evaluate(all, signal())).status, 'unsatisfied');
    const any = await w.engine.bind({ predicate: 'any', of: [container.predicate] }, signal());
    assert.equal((await w.engine.evaluate(any, signal())).status, 'unknown');
    const not = await w.engine.bind({ predicate: 'not', of: container.predicate }, signal());
    assert.equal((await w.engine.evaluate(not, signal())).status, 'unknown');
  });
});
