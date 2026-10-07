// MB-LOC-001 owner locator: server `tracked_waypoint` statements -> one coarse,
// owner-only, freshness-labelled hint per connection.
//
// Authority and scope rules:
//   - Identity: ONLY the configured owner. UUID mode needs the configured UUID
//     AND a verified online-mode connection; the trusted offline fixture needs
//     the exact owner name's derived offline UUID AND that exact name listed for
//     that UUID by the server's player list. String-identified waypoints and
//     every other UUID grant no identity; they are counted, never stored with a
//     position. Icon style/colour and packet order are never used.
//   - Connection: statements belong to the connection epoch whose client
//     delivered them. A late packet from an older client is ignored; a new
//     connection starts empty (a fresh broadcast is required after restart).
//   - Dimension/lifecycle: a login/respawn packet (dimension change or death
//     respawn) and death/respawn/dimension-change/ended lifecycle events void
//     earlier statements.
//   - Freshness: a tracked statement is current until the server withdraws it
//     (untrack) or it is older than `hintMaxAgeMs`; an expired, withdrawn,
//     empty or undetermined statement exposes NO direction.
//   - Privacy: exact statement data stays in this object; hints, status and
//     telemetry carry only the coarse cue, counts and ages.
import type { EventEmitter } from 'node:events';
import type { Clock, GameLifecycleEvent } from '../contracts/index.ts';
import type { CompassSector, LocatorConfig, LocatorCounters, LocatorDistanceBand, LocatorElevation, LocatorHint, LocatorHintReason, LocatorPort, LocatorPrecision, LocatorStatus, WaypointVariant } from '../contracts/locator.ts';
import { normalizeUuid } from '../config/schema.ts';
import type { GameSession } from '../game/connection.ts';
import { offlinePlayerUuid, type OwnerPolicy } from '../game/identity.ts';
import { decodeTrackedWaypoint, verifyWaypointCodec, type CodecVerification, type WaypointPayload } from './codec.ts';
import { cueFrom } from './geometry.ts';

export interface LocatorServiceOptions {
  config: LocatorConfig;
  /** Exact configured Minecraft version (codec gate). */
  version: string;
  ownerPolicy: OwnerPolicy;
  /** Connection identity facts (UUID mode requires verified online mode). */
  admission: () => { serverOnlineMode: boolean };
  session: () => GameSession | undefined;
  clock: Clock;
  /** Bounded telemetry (state transitions and counts only; never positions). */
  record?: (event: { type: string } & Record<string, unknown>) => void;
  /** Test seam: a precomputed codec verification. */
  codec?: CodecVerification;
}

/** Internal steering data for route code (never model-visible, never logged). */
export interface LocatorSteering {
  bearingRad: number;
  direction: CompassSector;
  distanceBand: LocatorDistanceBand;
  elevation: LocatorElevation;
  precision: LocatorPrecision;
  approxDistance: number | null;
  ageMs: number;
  /** Increments with every owner statement (change detection). */
  statementSeq: number;
  connectionEpoch: number;
}

interface OwnerStatement {
  tracked: boolean;
  payload: WaypointPayload;
  receivedAtMs: number;
  generation: number;
  seq: number;
}

interface Attached {
  epoch: number;
  client: EventEmitter;
  generation: number;
  detach: () => void;
  late: boolean;
}

const MAX_OTHERS = 256;

function emptyCounters(): LocatorCounters {
  return { packets: 0, track: 0, update: 0, untrack: 0, ownerStatements: 0, otherTracked: 0, stringIds: 0, rejected: 0, byVariant: { empty: 0, vec3i: 0, chunk: 0, azimuth: 0 } };
}

export class LocatorService implements LocatorPort {
  private readonly options: LocatorServiceOptions;
  readonly codec: CodecVerification;
  /** The only UUID whose statements are retained (then verified at use). */
  private readonly ownerCandidate: string | undefined;
  private attached: Attached | undefined;
  private owner: OwnerStatement | undefined;
  private voided: LocatorHintReason | undefined;
  private readonly others = new Set<string>();
  private counters: LocatorCounters = emptyCounters();
  private seq = 0;
  private lastStateKey = '';

  constructor(options: LocatorServiceOptions) {
    this.options = options;
    this.codec = options.codec ?? verifyWaypointCodec(options.version);
    const p = options.ownerPolicy;
    this.ownerCandidate = p.mode === 'uuid' ? (p.ownerUuid ? normalizeUuid(p.ownerUuid) : undefined) : p.ownerName ? offlinePlayerUuid(p.ownerName) : undefined;
  }

  get enabled(): boolean {
    return this.options.config.enabled && this.codec.ok;
  }

  /**
   * Installs the packet listener for ONE connection epoch. Must be called when
   * the client is created (before login), so the join-time track statements
   * are seen. Replaces any earlier attachment; returns its detach function.
   */
  attach(client: EventEmitter, connectionEpoch: number, late = false): () => void {
    this.detachCurrent('replaced');
    this.reset();
    const onWaypoint = (data: unknown) => this.onPacket(connectionEpoch, data);
    const onGeneration = () => this.onGeneration(connectionEpoch);
    client.on('tracked_waypoint', onWaypoint);
    client.on('login', onGeneration);
    client.on('respawn', onGeneration);
    const detach = () => {
      client.off('tracked_waypoint', onWaypoint);
      client.off('login', onGeneration);
      client.off('respawn', onGeneration);
    };
    this.attached = { epoch: connectionEpoch, client, generation: 0, detach, late };
    this.options.record?.({ type: 'locator_attached', connectionEpoch, codec: this.codec.ok ? this.codec.version : 'unsupported', enabled: this.options.config.enabled, late });
    return () => {
      if (this.attached?.epoch === connectionEpoch && this.attached.client === client) this.detachCurrent('detached');
      else detach();
    };
  }

  /**
   * Fallback when the connection layer does not provide a creation hook: attach
   * to the current session's client on first use. Join-time statements sent
   * before this point are missed (reported as `late` in status).
   */
  private ensureAttached(): void {
    const s = this.options.session();
    if (!s || this.attached?.epoch === s.connectionEpoch) return;
    const client = (s.bot as unknown as { _client?: EventEmitter })._client;
    if (client && typeof client.on === 'function') this.attach(client, s.connectionEpoch, true);
  }

  private detachCurrent(reason: string): void {
    if (!this.attached) return;
    this.attached.detach();
    this.options.record?.({ type: 'locator_detached', connectionEpoch: this.attached.epoch, reason });
    this.attached = undefined;
  }

  private reset(): void {
    this.owner = undefined;
    this.voided = undefined;
    this.others.clear();
    this.counters = emptyCounters();
  }

  /** Lifecycle: death/respawn/dimension change void statements; ended detaches. */
  onLifecycle(event: GameLifecycleEvent): void {
    if (event.type === 'death' || event.type === 'respawn' || event.type === 'dimension_change') {
      if (this.attached?.epoch === event.connectionEpoch) this.void('dimension_changed', `lifecycle_${event.type}`);
    } else if (event.type === 'ended') {
      if (this.attached?.epoch === event.connectionEpoch) {
        this.detachCurrent('connection_ended');
        this.reset();
      }
    } else if (event.type === 'joining') {
      // A new connection attempt: nothing from an earlier connection may steer it.
      if (this.attached && this.attached.epoch !== event.connectionEpoch) {
        this.detachCurrent('new_connection');
        this.reset();
      }
    }
  }

  private void(reason: LocatorHintReason, cause: string): void {
    const had = this.owner !== undefined;
    this.owner = undefined;
    this.others.clear();
    this.counters.otherTracked = 0;
    if (had || this.voided) this.voided = reason;
    this.transition(cause);
  }

  private onGeneration(epoch: number): void {
    if (!this.attached || this.attached.epoch !== epoch) return;
    this.attached.generation += 1;
    if (this.attached.generation > 1 || this.owner) this.void('dimension_changed', 'login_or_respawn_packet');
  }

  private onPacket(epoch: number, data: unknown): void {
    const a = this.attached;
    if (!a || a.epoch !== epoch) return; // a late packet from an older client never steers
    this.counters.packets += 1;
    const decoded = decodeTrackedWaypoint(data);
    if (!decoded.ok) {
      this.counters.rejected += 1;
      if (this.counters.rejected <= 8) this.options.record?.({ type: 'locator_rejected', connectionEpoch: epoch, reason: decoded.reason });
      return;
    }
    const w = decoded.waypoint;
    this.counters[w.operation] += 1;
    this.counters.byVariant[w.payload.variant] += 1;
    const isOwner = w.identity.kind === 'uuid' && this.ownerCandidate !== undefined && w.identity.uuid === this.ownerCandidate;
    if (!isOwner) {
      const key = w.identity.kind === 'uuid' ? `u:${w.identity.uuid}` : `s:${w.identity.id.slice(0, 64)}`;
      if (w.identity.kind === 'string') this.counters.stringIds += 1;
      if (w.operation === 'untrack') this.others.delete(key);
      else if (this.others.size < MAX_OTHERS) this.others.add(key);
      this.counters.otherTracked = this.others.size;
      return;
    }
    this.counters.ownerStatements += 1;
    this.seq += 1;
    const now = this.options.clock.now();
    if (w.operation === 'untrack') {
      this.owner = { tracked: false, payload: { variant: 'empty' }, receivedAtMs: now, generation: a.generation, seq: this.seq };
    } else {
      // `update` without an earlier `track` is still a current server statement for this UUID.
      this.owner = { tracked: true, payload: w.payload, receivedAtMs: now, generation: a.generation, seq: this.seq };
    }
    this.voided = undefined;
    this.transition(`owner_${w.operation}`);
  }

  private identityVerified(s: GameSession): boolean {
    const p = this.options.ownerPolicy;
    if (!this.ownerCandidate) return false;
    if (p.mode === 'uuid') return this.options.admission().serverOnlineMode;
    const players = (s.bot as unknown as { players?: Record<string, { uuid?: string; username?: string } | undefined> }).players ?? {};
    const listed = players[p.ownerName];
    return Boolean(listed?.uuid && normalizeUuid(listed.uuid) === this.ownerCandidate);
  }

  /** The coarse owner hint for the current connection and dimension. */
  ownerHint(): LocatorHint {
    return this.compute().hint;
  }

  /** Internal steering for route code: present only when the hint is actionable. */
  steering(): LocatorSteering | undefined {
    return this.compute().steering;
  }

  private compute(): { hint: LocatorHint; steering?: LocatorSteering } {
    const s = this.options.session();
    if (s && this.options.config.enabled && this.codec.ok) this.ensureAttached();
    const now = this.options.clock.now();
    const base: LocatorHint = {
      target: 'owner',
      source: 'server_locator_waypoint',
      actionable: false,
      reason: 'never_received',
      direction: null,
      distanceBand: 'unknown',
      elevation: 'unknown',
      precision: 'none',
      ageMs: null,
      expiresInMs: null,
      connectionEpoch: s?.connectionEpoch ?? this.attached?.epoch ?? 0,
      dimension: s ? String(s.bot.game.dimension) : null,
      note: 'no owner locator statement on this connection',
    };
    const not = (reason: LocatorHintReason, note: string, extra: Partial<LocatorHint> = {}) => ({ hint: { ...base, reason, note, ...extra } });
    if (!this.options.config.enabled) return not('disabled', 'locator perception is disabled by configuration');
    if (!this.codec.ok) return not('unsupported_codec', `locator unsupported: ${this.codec.detail}`.slice(0, 200));
    if (!s || !this.attached || this.attached.epoch !== s.connectionEpoch) return not('disconnected', 'no ready connection; locator statements never carry across connections');
    if (!this.identityVerified(s)) return not('owner_identity_unverified', 'owner identity cannot be verified on this connection; waypoints grant no identity');
    const o = this.owner;
    if (!o) return not(this.voided ?? 'never_received', this.voided ? 'earlier owner statements were voided by a respawn/dimension change; waiting for a fresh broadcast' : 'the server has not broadcast the owner on the locator bar on this connection');
    const ageMs = Math.max(0, Math.round(now - o.receivedAtMs));
    if (o.generation !== this.attached.generation) return not('dimension_changed', 'owner statement belongs to an earlier dimension/respawn', { ageMs });
    if (!o.tracked) return not('untracked', 'the server withdrew the owner from the locator bar (hidden, out of range, disabled or left)', { ageMs });
    if (o.payload.variant === 'empty') return not('no_position', 'the server tracks the owner without a position', { ageMs });
    const maxAge = this.options.config.hintMaxAgeMs;
    if (ageMs > maxAge) return not('expired', `the last owner statement is ${Math.round(ageMs / 1000)}s old (limit ${Math.round(maxAge / 1000)}s)`, { ageMs });
    const self = s.bot.entity.position;
    const cue = cueFrom(o.payload, self);
    const precision: LocatorPrecision = o.payload.variant === 'vec3i' ? 'block' : o.payload.variant === 'chunk' ? 'chunk' : 'direction_only';
    if (!cue || cue.bearingRad === null || cue.direction === null) {
      return not('direction_undetermined', 'the owner statement does not determine a horizontal direction from here', { ageMs, precision, ...(cue ? { elevation: cue.elevation, distanceBand: cue.distanceBand } : {}) });
    }
    const hint: LocatorHint = {
      ...base,
      actionable: true,
      reason: 'tracking',
      direction: cue.direction,
      distanceBand: cue.distanceBand,
      elevation: cue.elevation,
      precision: cue.precision,
      ageMs,
      expiresInMs: Math.max(0, maxAge - ageMs),
      note: `owner locator cue ${cue.direction}, distance ${cue.distanceBand}, height ${cue.elevation} (${cue.precision} precision); a direction cue, not visibility or arrival`,
    };
    return {
      hint,
      steering: { bearingRad: cue.bearingRad, direction: cue.direction, distanceBand: cue.distanceBand, elevation: cue.elevation, precision: cue.precision, approxDistance: cue.approxDistance, ageMs, statementSeq: o.seq, connectionEpoch: s.connectionEpoch },
    };
  }

  status(): LocatorStatus {
    const s = this.options.session();
    const support = !this.options.config.enabled ? 'disabled' : !this.codec.ok ? 'unsupported_codec' : !s ? 'not_connected' : 'available';
    return { support, codecVersion: this.codec.ok ? this.codec.version : null, connectionEpoch: s?.connectionEpoch ?? this.attached?.epoch ?? 0, owner: this.ownerHint(), counters: { ...this.counters, byVariant: { ...this.counters.byVariant } } };
  }

  /** Whether the current attachment started late (join-time statements may be missing). */
  get attachedLate(): boolean {
    return this.attached?.late ?? false;
  }

  private transition(cause: string): void {
    const o = this.owner;
    const key = o ? `${o.tracked ? 'tracked' : 'untracked'}:${o.payload.variant}` : `none:${this.voided ?? 'never_received'}`;
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.options.record?.({ type: 'locator_owner_state', connectionEpoch: this.attached?.epoch ?? null, state: key, cause, ownerStatements: this.counters.ownerStatements });
  }
}

export type { WaypointVariant };
