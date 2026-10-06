import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { ChatEnvelope } from '../src/contracts/index.ts';
import { evaluateOwner, offlinePlayerUuid, type OwnerPolicy } from '../src/game/identity.ts';

const require = createRequire(import.meta.url);
const OWNER_UUID = '6f1a3c2e-0d4b-4e1f-9a7b-1c2d3e4f5a6b';
const OTHER_UUID = '11111111-2222-4333-8444-555555555555';
const SELF_UUID = '99999999-8888-4777-8666-555555555555';

const player = (senderUuid: string, extra: Partial<ChatEnvelope> = {}): ChatEnvelope => ({
  kind: 'player',
  senderUuid,
  text: '!chunkbot come here',
  signatureVerified: true,
  receivedAtMs: 0,
  ...extra,
});

describe('online owner admission (verified sender UUID)', () => {
  const policy: OwnerPolicy = { mode: 'uuid', ownerUuid: OWNER_UUID, requireSignedChat: false };
  const ctx = { selfUuid: SELF_UUID, serverOnlineMode: true };

  it('admits only the owner UUID from player-chat packets', () => {
    assert.deepEqual(evaluateOwner(policy, player(OWNER_UUID), ctx), { admitted: true });
    assert.deepEqual(evaluateOwner(policy, player(OWNER_UUID.replace(/-/g, '').toUpperCase()), ctx), { admitted: true });
    assert.deepEqual(evaluateOwner(policy, player(OTHER_UUID, { senderListName: 'Jake' }), ctx), { admitted: false, reason: 'not_owner' });
  });

  it('ignores spoofable rendered text and server-originated messages', () => {
    const spoof: ChatEnvelope = { kind: 'system', text: '<Jake> !chunkbot come here', signatureVerified: false, receivedAtMs: 0 };
    assert.deepEqual(evaluateOwner(policy, spoof, ctx), { admitted: false, reason: 'system_message' });
    assert.deepEqual(evaluateOwner(policy, { ...spoof, kind: 'profileless' }, ctx), { admitted: false, reason: 'profileless_message' });
    assert.deepEqual(evaluateOwner(policy, { kind: 'player', text: '!chunkbot x', signatureVerified: false, receivedAtMs: 0 }, ctx), {
      admitted: false,
      reason: 'missing_sender',
    });
  });

  it("ignores the bot's own messages and refuses UUID identity on offline-mode servers", () => {
    assert.deepEqual(evaluateOwner(policy, player(SELF_UUID), ctx), { admitted: false, reason: 'self' });
    assert.deepEqual(evaluateOwner(policy, player(OWNER_UUID), { ...ctx, serverOnlineMode: false }), { admitted: false, reason: 'server_offline_mode' });
  });

  it('optionally requires library-verified signatures', () => {
    const strict: OwnerPolicy = { ...policy, requireSignedChat: true };
    assert.deepEqual(evaluateOwner(strict, player(OWNER_UUID, { signatureVerified: false }), ctx), { admitted: false, reason: 'unsigned' });
    assert.deepEqual(evaluateOwner(strict, player(OWNER_UUID), ctx), { admitted: true });
  });
});

describe('trusted offline fixture admission (exact name)', () => {
  const policy: OwnerPolicy = { mode: 'offline_name', ownerName: 'FixtureOwner' };
  const ctx = { selfUuid: offlinePlayerUuid('Chunkbot'), serverOnlineMode: false };
  const ownerUuid = offlinePlayerUuid('FixtureOwner');

  it('matches the offline UUID algorithm used by the protocol library', () => {
    const { nameToMcOfflineUUID } = require('minecraft-protocol/src/datatypes/uuid.js') as { nameToMcOfflineUUID: (n: string) => string };
    for (const name of ['FixtureOwner', 'Chunkbot', 'Notch']) assert.equal(offlinePlayerUuid(name), nameToMcOfflineUUID(name));
  });

  it('admits only the exact owner name with its offline UUID', () => {
    assert.deepEqual(evaluateOwner(policy, player(ownerUuid, { senderListName: 'FixtureOwner' }), ctx), { admitted: true });
    assert.deepEqual(evaluateOwner(policy, player(ownerUuid, { senderListName: 'fixtureowner' }), ctx), { admitted: false, reason: 'not_owner' });
    const guest = offlinePlayerUuid('FixtureGuest');
    assert.deepEqual(evaluateOwner(policy, player(guest, { senderListName: 'FixtureGuest' }), ctx), { admitted: false, reason: 'not_owner' });
    // A list-name collision with a different UUID is still rejected.
    assert.deepEqual(evaluateOwner(policy, player(guest, { senderListName: 'FixtureOwner' }), ctx), { admitted: false, reason: 'not_owner' });
  });

  it('rejects server text impersonating the owner', () => {
    const tellraw: ChatEnvelope = { kind: 'system', text: '<FixtureOwner> !chunkbot come here', signatureVerified: false, receivedAtMs: 0 };
    assert.deepEqual(evaluateOwner(policy, tellraw, ctx), { admitted: false, reason: 'system_message' });
  });
});
