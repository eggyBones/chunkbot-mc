// Perception: builds bounded, filtered, model-visible observation snapshots from
// the live game session, and resolves code handles back to live targets for
// candidate generation and execution.
//
// Filtering happens HERE, before anything reaches a model: only blocks seen by
// line-of-sight rays within the observation radius, only entities/drops with a
// clear line of sight within the radius (no tab-list or global player
// positions), no hidden ores, seeds, or chunk dumps. Every handle carries its
// snapshot, connection epoch, dimension and observation time; handles from an
// older connection or dimension never resolve.
import blockLoader from 'prismarine-block';
import { Vec3 } from 'vec3';
import type { Clock, EffectiveTravel, IdSource, ObservationPort, ObservationSnapshot, Readiness, RouteAdmissionProof } from '../contracts/index.ts';
import type { GameSession } from '../game/connection.ts';
import { isOwnerPlayer, type OwnerPolicy } from '../game/identity.ts';
import { findFrontiers } from './frontiers.ts';
import { UNCONFIRMED_BLOCK, discoverVisible, isBlockVisible, isEntityVisible, sphereDirections, type BlockView, type RayHit, type Vec, type WorldView } from './visibility.ts';

type Bot = GameSession['bot'];
type Entity = Bot['entity'];

export type HandleTarget =
  | { kind: 'block'; x: number; y: number; z: number; name: string; stateId: number }
  | { kind: 'entity'; entityId: number; name: string; username?: string; isOwner: boolean }
  | { kind: 'drop'; entityId: number; item: string; count: number }
  | { kind: 'frontier'; at: Vec };

export interface HandleRecord {
  snapshotId: string;
  connectionEpoch: number;
  dimension: string;
  observedAtMs: number;
  target: HandleTarget;
}

interface SnapshotRecord {
  id: string;
  connectionEpoch: number;
  dimension: string;
  takenAtMs: number;
  eye: Vec;
  handles: Map<string, HandleRecord>;
  blockHandles: Map<string, string>;
  seen: Map<string, RayHit>;
  snapshot: ObservationSnapshot;
}

export interface PerceptionOptions {
  session: () => GameSession | undefined;
  clock: Clock;
  ids: IdSource;
  observationRadius: number;
  travelRadius: number;
  /** The admitted owner policy (shared with chat admission). */
  ownerPolicy?: OwnerPolicy;
  /** Connection facts for the policy; UUID mode requires verified online mode. */
  admission?: () => { serverOnlineMode: boolean };
  /** Shorthand when no policy is given: UUID mode if ownerUuid is set, else exact offline name. */
  ownerName?: string;
  ownerUuid?: string;
  /** Discovery ray count (angular sampling density). */
  rays?: number;
  /**
   * MB-LOC-001 route legs (canonical RoutePort.legBounds): an authorized local
   * leg bound for the SAME goal epoch, connection epoch and dimension as the
   * admitted anchor. The admission anchor itself is never moved.
   */
  /**
   * MB-LOC-001-C2/C3 canonical shared travel guard (RoutePort.effectiveTravel):
   * called on EVERY bounds poll with the goal's ORIGINAL admission proof; returns
   * the active leg only while the route is live and the proof matches exactly.
   */
  effectiveTravel?: (admission: RouteAdmissionProof) => EffectiveTravel;
}

const WORKSTATIONS = /^(crafting_table|furnace|blast_furnace|smoker|stonecutter|smithing_table|anvil|chipped_anvil|damaged_anvil|grindstone|loom|cartography_table|fletching_table|enchanting_table|brewing_stand|campfire|soul_campfire)$/;
const CONTAINERS = /^(chest|trapped_chest|barrel|hopper|dropper|dispenser|ender_chest|([a-z_]+_)?shulker_box)$/;
const AIR = /^(air|cave_air|void_air)$/;

export function blockLabel(name: string): string | undefined {
  if (WORKSTATIONS.test(name)) return 'workstation';
  if (CONTAINERS.test(name)) return 'container';
  return undefined;
}

const UNCONFIRMED_VIEW: BlockView = { name: UNCONFIRMED_BLOCK, stateId: -1, shapes: [[0, 0, 0, 1, 1, 1]] };

/**
 * THE authoritative world view for perception and skills: server chunk/block
 * data as Mineflayer holds it, except that a voxel with a pending client-side
 * prediction (see ServerEvidence.notePrediction) is an opaque, unreported
 * UNCONFIRMED voxel until the server states it. Every ray, visible face,
 * entity/drop visibility, frontier and visible-target check uses this view.
 */
export function sessionWorld(session: Pick<GameSession, 'bot' | 'evidence'>): WorldView {
  const raw = rawBotWorld(session.bot);
  const ev = session.evidence as Partial<Pick<GameSession['evidence'], 'predictionPending'>> | undefined;
  const pending = typeof ev?.predictionPending === 'function' ? (x: number, y: number, z: number) => ev.predictionPending!(x, y, z) : undefined;
  if (!pending) return raw;
  return {
    blockAt(x, y, z) {
      const b = raw.blockAt(x, y, z);
      if (b && pending(x, y, z)) return UNCONFIRMED_VIEW;
      return b;
    },
  };
}

/** Raw view of Mineflayer's (mutable, possibly predicted) client model. Use sessionWorld instead. */
function rawBotWorld(bot: Bot): WorldView {
  const Block = blockLoader(bot.registry as never) as unknown as { fromStateId(id: number, biome: number): { name: string; shapes: number[][] } };
  const cache = new Map<number, BlockView>();
  const v = new Vec3(0, 0, 0);
  const world = bot.world as unknown as { getColumnAt(p: Vec3): unknown; getBlockStateId(p: Vec3): number };
  const minY = (bot.game as { minY?: number }).minY ?? -64;
  const height = (bot.game as { height?: number }).height ?? 384;
  return {
    blockAt(x, y, z) {
      if (y < minY || y >= minY + height) return { name: 'void_air', stateId: 0, shapes: [] };
      v.x = x;
      v.y = y;
      v.z = z;
      if (!world.getColumnAt(v)) return null;
      const id = world.getBlockStateId(v);
      let view = cache.get(id);
      if (!view) {
        const b = Block.fromStateId(id, 0);
        view = { name: b.name, stateId: id, shapes: b.shapes ?? [] };
        if (b.name === 'lava' || b.name === 'water') {
          const min = (bot.registry as unknown as { blocksByName: Record<string, { minStateId: number } | undefined> }).blocksByName[b.name]?.minStateId;
          if (min !== undefined) view.level = id - min;
        }
        cache.set(id, view);
      }
      return view;
    },
  };
}

export function eyeOf(bot: Bot): Vec {
  const p = bot.entity.position;
  return { x: p.x, y: p.y + ((bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62), z: p.z };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const vec = (p: { x: number; y: number; z: number }) => ({ x: round1(p.x), y: round1(p.y), z: round1(p.z) });

/** Bound on retired handle identities kept for re-grounding (MB-PLAN-006 N-G1). */
const RETIRED_HANDLES = 4_096;

/** Block interaction reach (survival `block_interaction_range` default 4.5). */
export const BLOCK_REACH = 4.5;
/** Entity interaction reach (survival `entity_interaction_range` default 3.0). */
export const ENTITY_REACH = 3;

export class PerceptionService implements ObservationPort {
  private readonly options: PerceptionOptions;
  private readonly snapshots: SnapshotRecord[] = [];
  /**
   * MB-PLAN-006 N-G1: TARGET IDENTITY (entity id, block position, frontier
   * waypoint) of handles whose snapshot was evicted from the bounded snapshot
   * window. Used ONLY to re-ground a named target to the SAME target produced
   * again in a newer snapshot (translateHandle) and for code predicate
   * identity; an expired handle is never executable (resolve still refuses it).
   * Same connection/dimension only; cleared by every lifecycle invalidation.
   */
  private readonly retired = new Map<string, HandleRecord>();
  private readonly anchors: Array<{ anchorId: string; label: string; dimension: string; at: Vec; observedAtMs: number; source: 'observed' | 'owner_supplied' | 'skill_result'; connectionEpoch: number }> = [];
  private readonly visited: Array<{ dimension: string; at: Vec; atMs: number; connectionEpoch: number }> = [];
  /**
   * Travel anchor. `goalEpoch` is set only by goal ADMISSION (admitTravelAnchor):
   * a goal's actions use that anchor for the goal's whole lifetime (tasks,
   * windows, first action); only a new admission replaces it. Untagged anchors
   * belong to operator diagnostics.
   */
  private travelAnchor: { dimension: string; at: Vec; connectionEpoch: number; goalEpoch?: number; admittedAtMs?: number } | undefined;
  private readonly directions: Vec[];
  private anchorCounter = 0;
  private handleCounter = 0;

  constructor(options: PerceptionOptions) {
    this.options = options;
    this.directions = sphereDirections(options.rays ?? 2400);
  }

  readiness(): Readiness {
    const ready = this.options.session() !== undefined;
    return {
      ready: true,
      detail: `line-of-sight perception installed (radius ${this.options.observationRadius}, ${this.directions.length} rays)${ready ? '' : '; waiting for a ready connection'}`,
    };
  }

  get radius(): number {
    return this.options.observationRadius;
  }

  /**
   * Lifecycle interruption (death, dimension change, disconnect): every handle,
   * snapshot and remembered anchor taken before it is void, even on the same
   * connection and dimension (the player entity was replaced). Visited points
   * remain as bounded historical evidence for admission-bound predicates.
   */
  invalidate(reason: string): void {
    this.snapshots.splice(0);
    this.retired.clear();
    this.anchors.splice(0);
    this.travelAnchor = undefined;
    this.invalidations.push({ atMs: this.options.clock.now(), reason });
    if (this.invalidations.length > 16) this.invalidations.shift();
  }

  readonly invalidations: Array<{ atMs: number; reason: string }> = [];

  /** Operator/diagnostic travel anchor (untagged). Defaults to the current position. */
  setTravelAnchor(at: Vec | undefined): void {
    const s = this.options.session();
    if (!s) return;
    const p = at ?? s.bot.entity.position;
    this.travelAnchor = { dimension: String(s.bot.game.dimension), at: { x: p.x, y: p.y, z: p.z }, connectionEpoch: s.connectionEpoch };
  }

  /**
   * Goal admission: captures the travel anchor owned by `goalEpoch` at the
   * admission position (current position unless given), BEFORE planning. It is
   * not moved by later observations or actions; a replacement admission (new
   * epoch) installs its own. Returns false when there is no connection.
   */
  admitTravelAnchor(goalEpoch: number, at?: Vec): boolean {
    const s = this.options.session();
    if (!s) {
      this.travelAnchor = undefined;
      return false;
    }
    const p = at ?? s.bot.entity.position;
    this.travelAnchor = { dimension: String(s.bot.game.dimension), at: { x: p.x, y: p.y, z: p.z }, connectionEpoch: s.connectionEpoch, goalEpoch, admittedAtMs: this.options.clock.now() };
    return true;
  }

  /** The goal epoch that owns the current travel anchor (undefined: diagnostic or none). */
  travelAnchorGoalEpoch(): number | undefined {
    const s = this.options.session();
    const a = this.travelAnchor;
    if (!s || !a || a.connectionEpoch !== s.connectionEpoch || a.dimension !== String(s.bot.game.dimension)) return undefined;
    return a.goalEpoch;
  }

  /** The anchor bound (goal-owned admission anchor, or the diagnostic default) — never a route leg. */
  private anchorBounds(): { anchor: Vec; radius: number } | undefined {
    const s = this.options.session();
    if (!s) return undefined;
    if (!this.travelAnchor || this.travelAnchor.connectionEpoch !== s.connectionEpoch || this.travelAnchor.dimension !== String(s.bot.game.dimension)) {
      // Diagnostic default only: a goal-owned anchor is never re-created here
      // (goal actions require their admitted anchor and are refused otherwise).
      this.setTravelAnchor(undefined);
    }
    return this.travelAnchor ? { anchor: { ...this.travelAnchor.at }, radius: this.options.travelRadius } : undefined;
  }

  /**
   * The immutable ORIGINAL ADMISSION proof of the goal that owns the anchor
   * (MB-LOC-001 RouteAdmissionProof). Never a route leg; undefined for a
   * diagnostic (untagged) anchor or without a connection.
   */
  admissionBounds(): RouteAdmissionProof | undefined {
    const s = this.options.session();
    const bounds = this.anchorBounds();
    const a = this.travelAnchor;
    if (!s || !bounds || !a || a.goalEpoch === undefined) return undefined;
    return { goalEpoch: a.goalEpoch, connectionEpoch: s.connectionEpoch, dimension: String(s.bot.game.dimension), anchor: { ...bounds.anchor }, radius: bounds.radius };
  }

  /** The canonical effective bound for this poll (route leg only on full proof while live), else undefined. */
  private activeLeg(): { anchor: Vec; radius: number } | undefined {
    const proof = this.admissionBounds();
    const effective = this.options.effectiveTravel;
    if (!proof || !effective) return undefined;
    const e = effective(proof);
    if (e.kind !== 'route_leg') return undefined;
    // Defense in depth: the leg must belong to THIS admission exactly.
    if (e.admissionAnchor.x !== proof.anchor.x || e.admissionAnchor.y !== proof.anchor.y || e.admissionAnchor.z !== proof.anchor.z || e.admissionRadius !== proof.radius) return undefined;
    return { anchor: { ...e.anchor }, radius: e.radius };
  }

  /**
   * Effective local travel bound for skills on THIS poll: the live route leg of
   * the admitted goal (exact proof), else the anchor bound. A leg never moves
   * the admission anchor (see admissionBounds).
   */
  travelBounds(): { anchor: Vec; radius: number } | undefined {
    const anchor = this.anchorBounds();
    if (!anchor) return undefined;
    return this.activeLeg() ?? anchor;
  }

  /** Inside the admission bound OR the live route leg of the same admission (re-evaluated every call). */
  withinTravel(at: Vec): boolean {
    const anchor = this.anchorBounds();
    if (!anchor) return false;
    if (Math.hypot(at.x - anchor.anchor.x, at.z - anchor.anchor.z) <= anchor.radius) return true;
    const leg = this.activeLeg();
    return leg ? Math.hypot(at.x - leg.anchor.x, at.z - leg.anchor.z) <= leg.radius : false;
  }

  private policy(): OwnerPolicy | undefined {
    if (this.options.ownerPolicy) return this.options.ownerPolicy;
    if (this.options.ownerUuid) return { mode: 'uuid', ownerUuid: this.options.ownerUuid, requireSignedChat: false };
    if (this.options.ownerName) return { mode: 'offline_name', ownerName: this.options.ownerName };
    return undefined;
  }

  /** Same rule as chat admission (see isOwnerPlayer); never a case-insensitive or name-only match. */
  isOwnerEntity(bot: Bot, entity: Entity): boolean {
    if ((entity as { type?: string }).type !== 'player') return false;
    const username = (entity as { username?: string }).username;
    if (!username || username === bot.username) return false;
    const policy = this.policy();
    if (!policy) return false;
    const uuid = (entity as { uuid?: string }).uuid ?? bot.players?.[username]?.uuid;
    const ctx = this.options.admission?.() ?? { serverOnlineMode: false };
    return isOwnerPlayer(policy, { username, ...(uuid ? { uuid } : {}) }, ctx);
  }

  /** Records the current position as visited (bounded, 4-block grid). */
  recordVisited(): void {
    const s = this.options.session();
    if (!s) return;
    const p = s.bot.entity.position;
    const dimension = String(s.bot.game.dimension);
    const last = this.visited.at(-1);
    if (last && last.dimension === dimension && last.connectionEpoch === s.connectionEpoch && Math.hypot(last.at.x - p.x, last.at.y - p.y, last.at.z - p.z) < 4) return;
    this.visited.push({ dimension, at: vec(p), atMs: this.options.clock.now(), connectionEpoch: s.connectionEpoch });
    if (this.visited.length > 128) this.visited.splice(0, this.visited.length - 128);
  }

  visitedLocations(): ReadonlyArray<{ dimension: string; at: Vec; atMs: number }> {
    const s = this.options.session();
    return this.visited.filter((v) => !s || v.connectionEpoch === s.connectionEpoch);
  }

  /** Adds a remembered anchor (historical evidence, never current visibility). */
  remember(label: string, at: Vec, source: 'observed' | 'owner_supplied' | 'skill_result'): string | undefined {
    const s = this.options.session();
    if (!s) return undefined;
    const dimension = String(s.bot.game.dimension);
    const existing = this.anchors.find((a) => a.label === label && a.dimension === dimension && Math.hypot(a.at.x - at.x, a.at.y - at.y, a.at.z - at.z) < 1);
    if (existing) {
      existing.observedAtMs = this.options.clock.now();
      existing.at = vec(at);
      return existing.anchorId;
    }
    this.anchorCounter += 1;
    const anchorId = `anchor-${this.anchorCounter}`;
    this.anchors.push({ anchorId, label: label.slice(0, 200), dimension, at: vec(at), observedAtMs: this.options.clock.now(), source, connectionEpoch: s.connectionEpoch });
    if (this.anchors.length > 32) this.anchors.splice(0, this.anchors.length - 32);
    return anchorId;
  }

  anchor(anchorId: string): { label: string; dimension: string; at: Vec; observedAtMs: number; source: string } | undefined {
    const s = this.options.session();
    return this.anchors.find((a) => a.anchorId === anchorId && (!s || a.connectionEpoch === s.connectionEpoch));
  }

  private record(id: string): SnapshotRecord | undefined {
    return this.snapshots.find((s) => s.id === id);
  }

  /** The latest snapshot of the current connection, if any. */
  latest(): ObservationSnapshot | undefined {
    const s = this.options.session();
    const last = this.snapshots.at(-1);
    return last && s && last.connectionEpoch === s.connectionEpoch ? last.snapshot : undefined;
  }

  /**
   * Resolves a snapshot handle to its target, only if it belongs to the current
   * connection epoch and dimension. Callers must still revalidate the live target.
   */
  resolve(snapshotId: string, handle: string): HandleRecord | { error: string } {
    const s = this.options.session();
    if (!s) return { error: 'not_connected' };
    const rec = this.record(snapshotId);
    if (!rec) return { error: 'snapshot_expired' };
    if (rec.connectionEpoch !== s.connectionEpoch) return { error: 'stale_connection' };
    if (rec.dimension !== String(s.bot.game.dimension)) return { error: 'dimension_changed' };
    const h = rec.handles.get(handle);
    if (!h) return { error: 'unknown_handle' };
    return h;
  }

  /**
   * Target identity of a handle: from its live snapshot, or (after the snapshot
   * was evicted) from the bounded retired-identity record. Current connection
   * and dimension only. Never executable by itself: callers re-ground it in a
   * fresh snapshot or evaluate code predicates from it.
   */
  identity(snapshotId: string, handle: string): HandleRecord | { error: string } {
    const live = this.resolve(snapshotId, handle);
    if (!('error' in live) || live.error !== 'snapshot_expired') return live;
    const s = this.options.session();
    const r = this.retired.get(handle);
    if (!s || !r || r.snapshotId !== snapshotId) return live;
    if (r.connectionEpoch !== s.connectionEpoch) return { error: 'stale_connection' };
    if (r.dimension !== String(s.bot.game.dimension)) return { error: 'dimension_changed' };
    return r;
  }

  /**
   * Re-grounds a handle from an earlier snapshot in another snapshot of the same
   * connection and dimension: same block position still seen, the same
   * entity/drop id still listed, or the same frontier waypoint still produced
   * (visible, safe, inside travel bounds). Undefined when the target is no
   * longer available; there is never a fallback to a different target.
   */
  translateHandle(fromSnapshotId: string, handle: string, toSnapshotId: string): string | undefined {
    if (fromSnapshotId === toSnapshotId) return handle;
    const from = this.identity(fromSnapshotId, handle);
    const to = this.record(toSnapshotId);
    if ('error' in from || !to || to.connectionEpoch !== from.connectionEpoch || to.dimension !== from.dimension) return undefined;
    const t = from.target;
    if (t.kind === 'block') return this.blockHandle(toSnapshotId, t.x, t.y, t.z);
    if (t.kind === 'entity' || t.kind === 'drop') {
      for (const [h, rec] of to.handles) if ((rec.target.kind === 'entity' || rec.target.kind === 'drop') && rec.target.entityId === t.entityId) return h;
    }
    if (t.kind === 'frontier') {
      // MB-PLAN-003: the SAME waypoint only (exact coordinates), and only if the
      // target snapshot's own frontier search produced it again — i.e. it is
      // still visible, safe and inside the travel bounds now. Never the nearest
      // or any other frontier.
      for (const [h, rec] of to.handles) {
        if (rec.target.kind === 'frontier' && rec.target.at.x === t.at.x && rec.target.at.y === t.at.y && rec.target.at.z === t.at.z) return h;
      }
    }
    return undefined;
  }

  /** Visible voxels of a snapshot (internal; never sent to models as a dump). */
  seenBlocks(snapshotId: string): ReadonlyMap<string, RayHit> | undefined {
    return this.record(snapshotId)?.seen;
  }

  /** Mints (or reuses) a handle for a voxel seen in the snapshot. */
  blockHandle(snapshotId: string, x: number, y: number, z: number): string | undefined {
    const rec = this.record(snapshotId);
    if (!rec) return undefined;
    const k = `${x},${y},${z}`;
    const existing = rec.blockHandles.get(k);
    if (existing) return existing;
    const hit = rec.seen.get(k);
    if (!hit) return undefined;
    const handle = this.nextHandle('blk');
    rec.handles.set(handle, {
      snapshotId,
      connectionEpoch: rec.connectionEpoch,
      dimension: rec.dimension,
      observedAtMs: rec.takenAtMs,
      target: { kind: 'block', x, y, z, name: hit.block.name, stateId: hit.block.stateId },
    });
    rec.blockHandles.set(k, handle);
    return handle;
  }

  private nextHandle(prefix: string): string {
    this.handleCounter = (this.handleCounter % 999_999) + 1;
    return `${prefix}-${this.handleCounter}`;
  }

  /** Live world view for skills (collision geometry for navigation/visibility checks). */
  world(): WorldView | undefined {
    const s = this.options.session();
    return s ? sessionWorld(s) : undefined;
  }

  async snapshot(goalEpoch: number): Promise<ObservationSnapshot | null> {
    return this.take(goalEpoch);
  }

  take(goalEpoch: number): ObservationSnapshot | null {
    const s = this.options.session();
    if (!s) return null;
    const bot = s.bot;
    const now = this.options.clock.now();
    const world = sessionWorld(s);
    const eye = eyeOf(bot);
    const self = bot.entity.position;
    const dimension = String(bot.game.dimension);
    const radius = this.options.observationRadius;
    const id = this.options.ids.next('snap');
    const rec: SnapshotRecord = {
      id,
      connectionEpoch: s.connectionEpoch,
      dimension,
      takenAtMs: now,
      eye,
      handles: new Map(),
      blockHandles: new Map(),
      seen: new Map(),
      snapshot: undefined as unknown as ObservationSnapshot,
    };
    this.recordVisited();

    // Blocks: line-of-sight discovery only.
    const seen = discoverVisible(world, eye, radius, this.directions);
    // Unconfirmed (predicted) voxels occlude but are never reported or targetable.
    for (const [k, hit] of seen) if (!AIR.test(hit.block.name) && hit.block.name !== UNCONFIRMED_BLOCK) rec.seen.set(k, hit);
    const byKey = new Map<string, Array<{ hit: RayHit; d: number }>>();
    for (const hit of rec.seen.values()) {
      const d = Math.hypot(hit.x + 0.5 - eye.x, hit.y + 0.5 - eye.y, hit.z + 0.5 - eye.z);
      const list = byKey.get(hit.block.name) ?? [];
      list.push({ hit, d });
      byKey.set(hit.block.name, list);
    }
    const summary = [...byKey.entries()].map(([name, list]) => ({ name, list: list.sort((a, b) => a.d - b.d) }));
    // Display order: rarer block types first (terrain naturally sorts last), then distance.
    summary.sort((a, b) => a.list.length - b.list.length || (a.list[0]?.d ?? 0) - (b.list[0]?.d ?? 0));
    const blocks: ObservationSnapshot['blocks'] = [];
    let truncated = false;
    for (const { name, list } of summary) {
      const perKey = blockLabel(name) ? 8 : 4;
      for (const { hit, d } of list.slice(0, perKey)) {
        if (blocks.length >= 128) {
          truncated = true;
          break;
        }
        const handle = this.nextHandle('blk');
        rec.handles.set(handle, {
          snapshotId: id,
          connectionEpoch: s.connectionEpoch,
          dimension,
          observedAtMs: now,
          target: { kind: 'block', x: hit.x, y: hit.y, z: hit.z, name, stateId: hit.block.stateId },
        });
        rec.blockHandles.set(`${hit.x},${hit.y},${hit.z}`, handle);
        const label = blockLabel(name);
        blocks.push({
          handle,
          key: `minecraft:${name}`,
          at: { x: hit.x, y: hit.y, z: hit.z },
          distance: round1(d),
          inReach: d <= BLOCK_REACH,
          ...(label ? { label } : {}),
        });
        if (label) this.remember(`${name} seen`, { x: hit.x, y: hit.y, z: hit.z }, 'observed');
      }
      if (list.length > perKey) truncated = true;
    }
    const blockSummary = summary
      .slice()
      .sort((a, b) => b.list.length - a.list.length)
      .slice(0, 32)
      .map(({ name, list }) => ({ key: `minecraft:${name}`, count: list.length, nearest: round1(list[0]?.d ?? 0) }));

    // Entities and drops: radius + line of sight; never global player positions.
    // MB-PLAN-006 N-G1: every visible candidate is collected and ordered by
    // distance (ties: registry key, then position) BEFORE the bounded cap, so a
    // nearby target can never be crowded out by farther entities that happened
    // to come first in the client's entity table. Handles follow that order.
    const visibleEntities: Array<{ entity: Entity; d: number; name: string }> = [];
    const visibleDrops: Array<{ entity: Entity; d: number; item: { name: string; count: number } }> = [];
    for (const entity of Object.values(bot.entities)) {
      if (!entity || entity === bot.entity || !entity.position) continue;
      const d = entity.position.distanceTo(self);
      if (d > radius) continue;
      const height = (entity as { height?: number }).height ?? 1;
      if (!isEntityVisible(world, eye, entity.position, height)) continue;
      const name = entity.name ?? 'unknown';
      if (name === 'item') {
        const item = (entity as { getDroppedItem?: () => { name: string; count: number } | null }).getDroppedItem?.();
        if (item) visibleDrops.push({ entity, d, item });
        continue;
      }
      visibleEntities.push({ entity, d, name });
    }
    const order = (a: { d: number; entity: Entity }, b: { d: number; entity: Entity }, ka: string, kb: string) =>
      a.d - b.d || (ka < kb ? -1 : ka > kb ? 1 : 0) || a.entity.position.x - b.entity.position.x || a.entity.position.z - b.entity.position.z || a.entity.position.y - b.entity.position.y || a.entity.id - b.entity.id;
    visibleEntities.sort((a, b) => order(a, b, a.name, b.name));
    visibleDrops.sort((a, b) => order(a, b, a.item.name, b.item.name));
    const entities: ObservationSnapshot['entities'] = [];
    const drops: ObservationSnapshot['drops'] = [];
    let owner: ObservationSnapshot['owner'] = { visible: false };
    for (const { entity, d, item } of visibleDrops) {
      if (drops.length >= 32) {
        truncated = true;
        break;
      }
      const handle = this.nextHandle('drp');
      rec.handles.set(handle, { snapshotId: id, connectionEpoch: s.connectionEpoch, dimension, observedAtMs: now, target: { kind: 'drop', entityId: entity.id, item: `minecraft:${item.name}`, count: item.count } });
      drops.push({ handle, key: `minecraft:${item.name}`, at: vec(entity.position), distance: round1(d), label: `x${item.count}` });
    }
    for (const { entity, d, name } of visibleEntities) {
      const isOwner = this.isOwnerEntity(bot, entity);
      // The owner is always reported when visible, even beyond the entity cap.
      if (entities.length >= 32 && !isOwner) {
        truncated = true;
        continue;
      }
      const username = (entity as { username?: string }).username;
      const handle = this.nextHandle('ent');
      rec.handles.set(handle, {
        snapshotId: id,
        connectionEpoch: s.connectionEpoch,
        dimension,
        observedAtMs: now,
        target: { kind: 'entity', entityId: entity.id, name, isOwner, ...(username ? { username } : {}) },
      });
      const label = isOwner ? 'owner' : (entity as { type?: string }).type === 'player' ? 'player' : undefined;
      if (entities.length < 32) entities.push({ handle, key: `minecraft:${name}`, at: vec(entity.position), distance: round1(d), inReach: d <= ENTITY_REACH, ...(label ? { label } : {}) });
      else entities[31] = { handle, key: `minecraft:${name}`, at: vec(entity.position), distance: round1(d), inReach: d <= ENTITY_REACH, ...(label ? { label } : {}) };
      if (isOwner) {
        owner = { visible: true, at: vec(entity.position), distance: round1(d) };
        this.remember('owner last seen', entity.position, 'observed');
      }
    }

    // Frontiers from safe local geometry inside travel bounds.
    const bounds = this.travelBounds();
    const visitedHere = this.visitedLocations().filter((v) => v.dimension === dimension).map((v) => v.at);
    const { frontiers: cells } = bounds
      ? findFrontiers(world, self, {
          radius: Math.min(radius, 24),
          travelAnchor: bounds.anchor,
          travelRadius: bounds.radius,
          floorSeen: (x, y, z) => rec.seen.has(`${x},${y},${z}`),
          visited: visitedHere,
        })
      : { frontiers: [] };
    const frontiers = cells.map((c) => {
      const handle = this.nextHandle('frt');
      rec.handles.set(handle, { snapshotId: id, connectionEpoch: s.connectionEpoch, dimension, observedAtMs: now, target: { kind: 'frontier', at: c.at } });
      return { handle, at: vec(c.at), distance: round1(c.distance), direction: c.direction, visited: c.visited };
    });

    // Inventory: client model (may include optimistic local updates; skills confirm with the server).
    const counts = new Map<string, number>();
    for (const item of bot.inventory.items()) counts.set(`minecraft:${item.name}`, (counts.get(`minecraft:${item.name}`) ?? 0) + item.count);
    const slotKey = (slot: number) => {
      const it = bot.inventory.slots[slot];
      return it ? `minecraft:${it.name}` : null;
    };
    const held = bot.heldItem;
    const snapshot: ObservationSnapshot = {
      id,
      connectionEpoch: s.connectionEpoch,
      goalEpoch,
      takenAtMs: now,
      dimension,
      self: { at: vec(self), health: bot.health ?? 0, food: bot.food ?? 0 },
      inventory: [...counts.entries()].slice(0, 41).map(([key, count]) => ({ key, count })),
      inventorySource: 'client_model',
      equipment: {
        hand: held ? `minecraft:${held.name}` : null,
        off_hand: slotKey(45),
        head: slotKey(5),
        torso: slotKey(6),
        legs: slotKey(7),
        feet: slotKey(8),
      },
      owner,
      entities,
      blocks,
      drops,
      remembered: this.anchors
        .filter((a) => a.connectionEpoch === s.connectionEpoch)
        .slice(-32)
        .map(({ anchorId, label, dimension: dim, at, observedAtMs, source }) => ({ anchorId, label, dimension: dim, at, observedAtMs, source })),
      blockSummary,
      frontiers,
      perception: {
        radius,
        policy: `line of sight from eye, ${this.directions.length} rays, see-through glass/panes/bars, entities/drops by LOS within radius`,
        truncated,
        ...(bounds ? { travel: { anchor: vec(bounds.anchor), radius: bounds.radius, distanceFromAnchor: round1(Math.hypot(self.x - bounds.anchor.x, self.z - bounds.anchor.z)) } } : {}),
      },
    };
    rec.snapshot = snapshot;
    this.snapshots.push(rec);
    if (this.snapshots.length > 8) {
      for (const old of this.snapshots.splice(0, this.snapshots.length - 8)) {
        // Keep only the identity of handles the snapshot actually listed (bounded).
        for (const [h, r] of old.handles) this.retired.set(h, r);
      }
      while (this.retired.size > RETIRED_HANDLES) this.retired.delete(this.retired.keys().next().value as string);
    }
    return snapshot;
  }

  /** Precise current visibility of a block for revalidation before acting. */
  blockVisibleNow(x: number, y: number, z: number): boolean {
    const s = this.options.session();
    if (!s) return false;
    return isBlockVisible(sessionWorld(s), eyeOf(s.bot), x, y, z);
  }

  entityVisibleNow(entityId: number): boolean {
    const s = this.options.session();
    if (!s) return false;
    const e = s.bot.entities[entityId];
    if (!e?.position) return false;
    if (e.position.distanceTo(s.bot.entity.position) > this.options.observationRadius) return false;
    return isEntityVisible(sessionWorld(s), eyeOf(s.bot), e.position, (e as { height?: number }).height ?? 1);
  }
}
