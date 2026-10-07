// MB-LOC-001 L1: the EXACT pinned codec (minecraft-protocol 1.68.0 + the
// installed minecraft-data 26.1 / vendored 26.2 protocol) serializes and
// deserializes every tracked_waypoint operation, identity kind and payload
// variant; the strict decoder accepts exactly those and rejects unknown ids
// the pinned mapper passes through as raw numbers.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { VERIFIED_TRACKED_WAYPOINT, decodeTrackedWaypoint, verifyWaypointCodec, verifyWaypointProtocol } from '../src/locator/codec.ts';

const require = createRequire(import.meta.url);
const mc = require('minecraft-protocol') as {
  createSerializer(o: { state: string; isServer: boolean; version: string }): { createPacketBuffer(p: { name: string; params: unknown }): Buffer };
  createDeserializer(o: { state: string; isServer: boolean; version: string }): { parsePacketBuffer(b: Buffer): { data: { name: string; params: unknown } } };
};

const OWNER = '6f1c9e2a-5b3d-4e7f-8a9b-0c1d2e3f4a5b';
const VERSIONS = ['26.1.2', '26.2'] as const;

function roundTrip(version: string, params: unknown): unknown {
  const ser = mc.createSerializer({ state: 'play', isServer: true, version });
  const des = mc.createDeserializer({ state: 'play', isServer: false, version });
  const out = des.parsePacketBuffer(ser.createPacketBuffer({ name: 'tracked_waypoint', params }));
  assert.equal(out.data.name, 'tracked_waypoint');
  return out.data.params;
}

const icon = { style: 'minecraft:default', color: { red: 255, green: 0, blue: 0 } };

describe('MB-LOC-001 codec gate (installed protocol definitions)', () => {
  for (const version of VERSIONS) {
    it(`${version}: the installed tracked_waypoint definition is the verified one (clientbound 0x8a)`, () => {
      const v = verifyWaypointCodec(version);
      assert.equal(v.ok, true, v.detail);
      assert.equal(v.packetId, '0x8a');
    });
  }
  it('a changed definition, a missing packet or an unknown version is refused (fail closed)', () => {
    const altered = JSON.parse(JSON.stringify(VERIFIED_TRACKED_WAYPOINT)) as unknown[];
    (altered[1] as Array<Record<string, unknown>>)[0]!['name'] = 'op';
    const types = { packet_tracked_waypoint: altered, vec3i: ['container', [{ name: 'x', type: 'varint' }, { name: 'y', type: 'varint' }, { name: 'z', type: 'varint' }]], packet: ['container', [{ type: ['mapper', { mappings: { '0x8a': 'tracked_waypoint' } }] }]] };
    assert.equal(verifyWaypointProtocol('x', { play: { toClient: { types } } }).ok, false);
    assert.equal(verifyWaypointProtocol('x', { play: { toClient: { types: { packet: types.packet } } } }).ok, false);
    assert.equal(verifyWaypointProtocol('x', undefined).ok, false);
    assert.equal(verifyWaypointCodec('1.21.1').ok, false, '1.21.1 has no tracked_waypoint packet');
  });
});

describe('MB-LOC-001 L1 decoding through the exact pinned serializer/deserializer', () => {
  for (const version of VERSIONS) {
    it(`${version}: track/update/untrack with every payload variant and identity kind`, () => {
      const cases: Array<[unknown, ReturnType<typeof decodeTrackedWaypoint>]> = [
        [{ operation: 'track', waypoint: { hasUUID: true, uuid: OWNER, icon, type: 'vec3i', data: { x: -120, y: 71, z: 3_000 } } }, { ok: true, waypoint: { operation: 'track', identity: { kind: 'uuid', uuid: OWNER }, payload: { variant: 'vec3i', x: -120, y: 71, z: 3_000 } } }],
        [{ operation: 'update', waypoint: { hasUUID: true, uuid: OWNER, icon: { style: 'minecraft:default' }, type: 'chunk', data: { chunkX: -8, chunkZ: 187 } } }, { ok: true, waypoint: { operation: 'update', identity: { kind: 'uuid', uuid: OWNER }, payload: { variant: 'chunk', chunkX: -8, chunkZ: 187 } } }],
        [{ operation: 'update', waypoint: { hasUUID: true, uuid: OWNER, icon, type: 'azimuth', data: -1.5 } }, { ok: true, waypoint: { operation: 'update', identity: { kind: 'uuid', uuid: OWNER }, payload: { variant: 'azimuth', azimuth: -1.5 } } }],
        [{ operation: 'track', waypoint: { hasUUID: true, uuid: OWNER, icon, type: 'empty' } }, { ok: true, waypoint: { operation: 'track', identity: { kind: 'uuid', uuid: OWNER }, payload: { variant: 'empty' } } }],
        [{ operation: 'untrack', waypoint: { hasUUID: true, uuid: OWNER, icon, type: 'empty' } }, { ok: true, waypoint: { operation: 'untrack', identity: { kind: 'uuid', uuid: OWNER }, payload: { variant: 'empty' } } }],
        [{ operation: 'track', waypoint: { hasUUID: false, id: 'Owner', icon, type: 'vec3i', data: { x: 1, y: 2, z: 3 } } }, { ok: true, waypoint: { operation: 'track', identity: { kind: 'string', id: 'Owner' }, payload: { variant: 'vec3i', x: 1, y: 2, z: 3 } } }],
      ];
      for (const [params, expected] of cases) {
        const decoded = decodeTrackedWaypoint(roundTrip(version, params));
        if (decoded.ok && expected.ok && decoded.waypoint.payload.variant === 'azimuth' && expected.waypoint.payload.variant === 'azimuth') {
          // f32 on the wire
          assert.ok(Math.abs(decoded.waypoint.payload.azimuth - expected.waypoint.payload.azimuth) < 1e-6);
          continue;
        }
        assert.deepEqual(decoded, expected);
      }
    });

    it(`${version}: unknown operation / variant ids from the pinned mapper are rejected, not guessed`, () => {
      const ser = mc.createSerializer({ state: 'play', isServer: true, version });
      const des = mc.createDeserializer({ state: 'play', isServer: false, version });
      const good = ser.createPacketBuffer({ name: 'tracked_waypoint', params: { operation: 'untrack', waypoint: { hasUUID: true, uuid: OWNER, icon: { style: 's' }, type: 'empty' } } });
      const badVariant = Buffer.from(good);
      badVariant[badVariant.length - 1] = 7;
      const v = des.parsePacketBuffer(badVariant).data.params as { waypoint: { type: unknown } };
      assert.equal(v.waypoint.type, 7, 'the pinned mapper passes the raw number through');
      assert.deepEqual(decodeTrackedWaypoint(v), { ok: false, reason: 'unknown_variant' });
      const badOp = Buffer.from(good);
      badOp[2] = 9; // [packet id varint 0x8a 0x01][operation]
      const o = des.parsePacketBuffer(badOp).data.params as { operation: unknown };
      assert.equal(o.operation, 9);
      assert.deepEqual(decodeTrackedWaypoint(o), { ok: false, reason: 'unknown_operation' });
    });
  }

  it('malformed identities and payloads are rejected', () => {
    const w = (over: Record<string, unknown>) => ({ operation: 'track', waypoint: { hasUUID: true, uuid: OWNER, icon, type: 'vec3i', data: { x: 1, y: 2, z: 3 }, ...over } });
    assert.deepEqual(decodeTrackedWaypoint(null), { ok: false, reason: 'not_an_object' });
    assert.deepEqual(decodeTrackedWaypoint(w({ uuid: 'not-a-uuid' })), { ok: false, reason: 'malformed_identity' });
    assert.deepEqual(decodeTrackedWaypoint(w({ hasUUID: 'yes' })), { ok: false, reason: 'malformed_identity' });
    assert.deepEqual(decodeTrackedWaypoint(w({ data: { x: 1.5, y: 2, z: 3 } })), { ok: false, reason: 'malformed_payload' });
    assert.deepEqual(decodeTrackedWaypoint(w({ data: { x: 40_000_000, y: 2, z: 3 } })), { ok: false, reason: 'malformed_payload' });
    assert.deepEqual(decodeTrackedWaypoint(w({ type: 'chunk', data: { chunkX: 1 } })), { ok: false, reason: 'malformed_payload' });
    assert.deepEqual(decodeTrackedWaypoint(w({ type: 'azimuth', data: Number.NaN })), { ok: false, reason: 'malformed_payload' });
  });
});
