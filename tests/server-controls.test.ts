import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BridgeBindingSchema, BridgeSampleSchema, type BridgeBinding } from '../src/server-controls/types.ts';
import { decodeStorageReply, installationCommand, macroCommand, uuidWords, wordsUuid } from '../src/server-controls/protocol.ts';

const binding: BridgeBinding = { protocol: 1, installation: 'a'.repeat(32), world: 'fixture', bot: 'chunkbot', ownerUuid: '8123456789abcdef01234567ffffffff', botUuid: '0'.repeat(32), version: '26.2', authority: 'trusted-offline-fixture' };
describe('vanilla bridge typed boundary', () => {
  it('round-trips signed Minecraft UUID words without a name or coordinates', () => {
    const words = uuidWords(binding.ownerUuid);
    assert.equal(words[0], -2128394905);
    assert.equal(words[3], -1);
    assert.equal(wordsUuid(words), binding.ownerUuid);
    assert.doesNotMatch(installationCommand(binding), /name=|Pos|position|tp /);
  });
  it('rejects unsupported releases, unknown binding fields and macro injection', () => {
    assert.throws(() => BridgeBindingSchema.parse({ ...binding, version: '26.2.1' }));
    assert.throws(() => BridgeBindingSchema.parse({ ...binding, command: 'stop' }));
    assert.throws(() => macroCommand('open', { session: 'x\nstop' }));
    assert.throws(() => installationCommand({ ...binding, world: 'x" run stop' }));
    assert.throws(() => BridgeBindingSchema.parse({ ...binding, botUuid: binding.ownerUuid }));
  });
  it('accepts only the fixed storage envelope and bounded, unambiguous SNBT', () => {
    const decoded = decodeStorageReply('chunkbot_control:bridge has the following contents: {protocol: 1, owner: [I;-2128394905, -1985229329, 19088743, -1], version: "26_2", ownerPresent: 1b}');
    assert.equal((decoded as { version: string }).version, '26.2');
    assert.throws(() => decodeStorageReply('spoofed has the following contents: {}'));
    assert.throws(() => decodeStorageReply('chunkbot_control:bridge has the following contents: {protocol: 1, protocol: 1}'));
    assert.throws(() => decodeStorageReply('chunkbot_control:bridge has the following contents: {} trailing'));
    assert.throws(() => decodeStorageReply('chunkbot_control:bridge has the following contents: {owner: [I;1,2,3]}'));
    assert.equal(BridgeSampleSchema.safeParse(decoded).success, false, 'partial storage is not a request');
  });
});
