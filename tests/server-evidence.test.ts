import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCommandBody, parseTerminalLine } from '../src/commands/parse.ts';
import { evidenceFor, fakeClient } from './skill-fakes.ts';

describe('server evidence journal', () => {
  it('records only server packets and decodes multi-block changes', () => {
    const client = fakeClient();
    const ev = evidenceFor(client);
    // section (1,-4,2), local x=3 z=5 y=7, state 42: (state << 12) | (x << 8 | z << 4 | y)
    const record = (42n << 12n) | BigInt((3 << 8) | (5 << 4) | 7);
    client.emit('multi_block_change', { chunkCoordinates: { x: 1, y: -4, z: 2 }, records: [record] });
    const [change] = ev.since(0, 'block_change');
    assert.deepEqual({ x: change?.x, y: change?.y, z: change?.z, stateId: change?.stateId }, { x: 19, y: -57, z: 37, stateId: 42 });
    client.emit('window_items', { windowId: 0, stateId: 17, items: [{ itemCount: 0 }, { itemCount: 3, itemId: 1 }] });
    assert.equal(ev.stateId, 17);
    assert.deepEqual(ev.latest('window_items')?.slots, [{ key: 'minecraft:oak_log', count: 3, slot: 1 }]);
  });

  it('tracks item stacks only for item entities and metadata flags only for watched entities', () => {
    const client = fakeClient();
    const ev = evidenceFor(client);
    client.emit('spawn_entity', { entityId: 5, type: 71, x: 0, y: 0, z: 0 });
    client.emit('entity_metadata', { entityId: 5, metadata: [{ key: 8, type: 'item_stack', value: { itemCount: 2, itemId: 2 } }] });
    client.emit('entity_metadata', { entityId: 9, metadata: [{ key: 17, type: 'byte', value: 16 }] });
    assert.deepEqual(ev.latest('item_stack')?.stack, { key: 'minecraft:cobblestone', count: 2 });
    assert.equal(ev.since(0, 'entity_flags').length, 0);
    ev.watch(9);
    client.emit('entity_metadata', { entityId: 9, metadata: [{ key: 17, type: 'byte', value: 16 }] });
    assert.equal(ev.since(0, 'entity_flags').length, 1);
  });

  it('waits for a matching later entry, and resolves undefined on abort or timeout', async () => {
    const client = fakeClient();
    const ev = evidenceFor(client);
    const after = ev.seq;
    const waiting = ev.waitFor('collect', (e) => e.collectedEntityId === 5, { afterSeq: after, timeoutMs: 1_000 });
    client.emit('collect', { collectedEntityId: 4, collectorEntityId: 1, pickupItemCount: 1 });
    client.emit('collect', { collectedEntityId: 5, collectorEntityId: 1, pickupItemCount: 2 });
    assert.equal((await waiting)?.count, 2);
    const abort = new AbortController();
    const cancelled = ev.waitFor('collect', () => true, { afterSeq: ev.seq, timeoutMs: 1_000, signal: abort.signal });
    abort.abort();
    assert.equal(await cancelled, undefined);
    assert.equal(await ev.waitFor('collect', () => true, { afterSeq: ev.seq, timeoutMs: 20 }), undefined);
  });
});

describe('operator diagnostics are terminal-only commands', () => {
  it('parses /diag on the terminal; the same text in chat is an ordinary instruction', () => {
    assert.deepEqual(parseTerminalLine('/diag do mine_block {"target":{"snapshotId":"snap-1","handle":"blk-2"}}', '!chunkbot'), {
      kind: 'diagnostic',
      args: 'do mine_block {"target":{"snapshotId":"snap-1","handle":"blk-2"}}',
    });
    assert.equal(parseCommandBody('/diag observe').kind, 'goal');
  });
});
