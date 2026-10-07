// MB-LOC-001 waypoint codec gate and strict decoder.
//
// The locator reads the server's `tracked_waypoint` (locator bar) packets as
// decoded by the PINNED minecraft-protocol/minecraft-data stack. Before any
// statement is used, the installed protocol definition for the configured
// version must be byte-for-byte (canonical JSON) the verified 26.x definition:
//
//   operation: varint mapper {0 track, 1 untrack, 2 update}
//   waypoint:  hasUUID bool -> uuid UUID | id string
//              icon { style string, color option<{red,green,blue u8}> }
//              type varint mapper {0 empty, 1 vec3i, 2 chunk, 3 azimuth}
//              data switch(type) { vec3i {x,y,z varint}, chunk {chunkX,chunkZ varint}, azimuth f32 }
//
// The pinned mapper passes UNKNOWN operation/type ids through as raw numbers,
// so the decoder rejects anything that is not a known string value. The icon
// (style/colour) is never used for identity and is not retained.
//
// Decoded statements contain exact server data. They stay inside src/locator/
// and are converted to a coarse cue (see geometry.ts); nothing here is
// model-visible, logged or persisted.
import minecraftData from 'minecraft-data';
import type { WaypointVariant } from '../contracts/locator.ts';

/** The verified `packet_tracked_waypoint` definition (installed 26.1 and 26.2 data are identical). */
export const VERIFIED_TRACKED_WAYPOINT: unknown = [
  'container',
  [
    { name: 'operation', type: ['mapper', { type: 'varint', mappings: { '0': 'track', '1': 'untrack', '2': 'update' } }] },
    {
      name: 'waypoint',
      type: [
        'container',
        [
          { name: 'hasUUID', type: 'bool' },
          {
            anon: true,
            type: ['switch', { compareTo: 'hasUUID', fields: { true: ['container', [{ name: 'uuid', type: 'UUID' }]], false: ['container', [{ name: 'id', type: 'string' }]] } }],
          },
          {
            name: 'icon',
            type: [
              'container',
              [
                { name: 'style', type: 'string' },
                { name: 'color', type: ['option', ['container', [{ name: 'red', type: 'u8' }, { name: 'green', type: 'u8' }, { name: 'blue', type: 'u8' }]]] },
              ],
            ],
          },
          { name: 'type', type: ['mapper', { type: 'varint', mappings: { '0': 'empty', '1': 'vec3i', '2': 'chunk', '3': 'azimuth' } }] },
          {
            name: 'data',
            type: ['switch', { compareTo: 'type', fields: { vec3i: 'vec3i', chunk: ['container', [{ name: 'chunkX', type: 'varint' }, { name: 'chunkZ', type: 'varint' }]], azimuth: 'f32' } }],
          },
        ],
      ],
    },
  ],
];

export const VERIFIED_VEC3I: unknown = ['container', [{ name: 'x', type: 'varint' }, { name: 'y', type: 'varint' }, { name: 'z', type: 'varint' }]];

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export interface CodecVerification {
  ok: boolean;
  version: string;
  /** Clientbound packet id in the installed mapping (e.g. 0x8a), when present. */
  packetId: string | null;
  detail: string;
}

type ProtocolDoc = { play?: { toClient?: { types?: Record<string, unknown> } }; types?: Record<string, unknown> };

/** Verifies a protocol document (exposed for tests with synthetic definitions). */
export function verifyWaypointProtocol(version: string, protocol: ProtocolDoc | undefined): CodecVerification {
  const types = protocol?.play?.toClient?.types;
  if (!types) return { ok: false, version, packetId: null, detail: `no play/toClient protocol for ${version}` };
  const def = types['packet_tracked_waypoint'];
  if (def === undefined) return { ok: false, version, packetId: null, detail: `${version} has no tracked_waypoint packet` };
  let packetId: string | null = null;
  try {
    const packet = types['packet'] as unknown as [string, Array<{ type: [string, { mappings?: Record<string, string> }] }>];
    const mappings = packet[1][0]?.type[1]?.mappings ?? {};
    packetId = Object.entries(mappings).find(([, name]) => name === 'tracked_waypoint')?.[0] ?? null;
  } catch {
    packetId = null;
  }
  if (!packetId) return { ok: false, version, packetId: null, detail: `${version} does not map a clientbound tracked_waypoint packet id` };
  if (canonical(def) !== canonical(VERIFIED_TRACKED_WAYPOINT)) {
    return { ok: false, version, packetId, detail: `${version} tracked_waypoint definition differs from the verified 26.x definition; locator statements are not decoded` };
  }
  const vec3i = types['vec3i'] ?? protocol?.types?.['vec3i'];
  if (canonical(vec3i) !== canonical(VERIFIED_VEC3I)) {
    return { ok: false, version, packetId, detail: `${version} vec3i type differs from the verified definition` };
  }
  return { ok: true, version, packetId, detail: `${version} tracked_waypoint (${packetId}) matches the verified definition` };
}

/** Verifies the INSTALLED minecraft-data protocol for an exact version. */
export function verifyWaypointCodec(version: string): CodecVerification {
  let protocol: ProtocolDoc | undefined;
  try {
    protocol = (minecraftData(version) as unknown as { protocol?: ProtocolDoc } | undefined)?.protocol;
  } catch {
    protocol = undefined;
  }
  return verifyWaypointProtocol(version, protocol);
}

// ---------------------------------------------------------------- decoding

export type WaypointOperation = 'track' | 'untrack' | 'update';

export type WaypointIdentity = { kind: 'uuid'; uuid: string } | { kind: 'string'; id: string };

export type WaypointPayload =
  | { variant: 'empty' }
  | { variant: 'vec3i'; x: number; y: number; z: number }
  | { variant: 'chunk'; chunkX: number; chunkZ: number }
  | { variant: 'azimuth'; azimuth: number };

export interface DecodedWaypoint {
  operation: WaypointOperation;
  identity: WaypointIdentity;
  payload: WaypointPayload;
}

export const DECODE_REJECTIONS = ['not_an_object', 'unknown_operation', 'malformed_identity', 'unknown_variant', 'malformed_payload'] as const;
export type DecodeRejection = (typeof DECODE_REJECTIONS)[number];

export type DecodeResult = { ok: true; waypoint: DecodedWaypoint } | { ok: false; reason: DecodeRejection };

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const OPERATIONS: readonly string[] = ['track', 'untrack', 'update'];
const VARIANTS: readonly string[] = ['empty', 'vec3i', 'chunk', 'azimuth'];
/** World border is +/-30,000,000; build height is far inside +/-4096. */
const MAX_XZ = 30_000_016;
const MAX_CHUNK = Math.ceil(MAX_XZ / 16);

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown, bound: number): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= bound;

export function normalizeWaypointUuid(value: string): string {
  const hex = value.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Strictly decodes one packet object emitted by the pinned deserializer.
 * Unknown operation/variant ids (raw numbers from the mapper), malformed
 * identities and out-of-range payloads are rejected; nothing is guessed.
 */
export function decodeTrackedWaypoint(raw: unknown): DecodeResult {
  if (!isObject(raw) || !isObject(raw['waypoint'])) return { ok: false, reason: 'not_an_object' };
  const operation = raw['operation'];
  if (typeof operation !== 'string' || !OPERATIONS.includes(operation)) return { ok: false, reason: 'unknown_operation' };
  const w = raw['waypoint'];
  let identity: WaypointIdentity;
  if (w['hasUUID'] === true) {
    const uuid = w['uuid'];
    if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return { ok: false, reason: 'malformed_identity' };
    identity = { kind: 'uuid', uuid: normalizeWaypointUuid(uuid) };
  } else if (w['hasUUID'] === false) {
    const id = w['id'];
    if (typeof id !== 'string' || id.length > 32_767) return { ok: false, reason: 'malformed_identity' };
    identity = { kind: 'string', id };
  } else return { ok: false, reason: 'malformed_identity' };
  const variant = w['type'];
  if (typeof variant !== 'string' || !VARIANTS.includes(variant)) return { ok: false, reason: 'unknown_variant' };
  const data = w['data'];
  let payload: WaypointPayload;
  switch (variant as WaypointVariant) {
    case 'empty':
      payload = { variant: 'empty' };
      break;
    case 'vec3i':
      if (!isObject(data) || !isInt(data['x'], MAX_XZ) || !isInt(data['y'], 4_096) || !isInt(data['z'], MAX_XZ)) return { ok: false, reason: 'malformed_payload' };
      payload = { variant: 'vec3i', x: data['x'], y: data['y'], z: data['z'] };
      break;
    case 'chunk':
      if (!isObject(data) || !isInt(data['chunkX'], MAX_CHUNK) || !isInt(data['chunkZ'], MAX_CHUNK)) return { ok: false, reason: 'malformed_payload' };
      payload = { variant: 'chunk', chunkX: data['chunkX'], chunkZ: data['chunkZ'] };
      break;
    case 'azimuth':
      if (typeof data !== 'number' || !Number.isFinite(data) || Math.abs(data) > 64) return { ok: false, reason: 'malformed_payload' };
      payload = { variant: 'azimuth', azimuth: data };
      break;
  }
  return { ok: true, waypoint: { operation: operation as WaypointOperation, identity, payload } };
}
