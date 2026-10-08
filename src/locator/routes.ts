// MB-LOC-001 declared, code-owned route legs.
//
// A goal may travel beyond its admission travel radius ONLY through a route
// authorization granted at admission from operator policy (never from the
// planner), and only one bounded LEG at a time:
//
//   admit      -> one authorization per NEW goal epoch (a repeated or older
//                 epoch is refused: no callback can regrant/reset a route);
//                 ceilings and the route deadline are fixed here
//   beginLeg   -> code (a route skill executing under the fenced lease) asks
//                 for a new local bound anchored at the bot's OWN current
//                 position; refused once any parent ceiling is reached
//   sample     -> cumulative own movement (path length) from the bot's own
//                 position samples, server corrections labelled (C1)
//   revoke     -> goal end, replacement, stop, lifecycle: never steers again
//
// Ceilings: legs, CUMULATIVE own movement since the first leg (out-and-back and
// detours consume it), a wall-clock deadline fixed at admission, and
// consecutive legs without NET progress (stall). None is reset by a new leg,
// window, replan, retry, epoch/connection/dimension callback or planner output.
// The admission anchor is copied and never moved; the goal's accepted outcome
// and counters are not touched here. Leg bounds come from the bot's own
// position and the operator leg radius; no destination defines a bound.
import type { EventEmitter } from 'node:events';
import type { Clock, Vec3 } from '../contracts/index.ts';
import {
  ROUTE_CARRY_VERSION,
  RoutePolicySchema,
  type RouteAdmission,
  type RouteCarry,
  type RouteContinuationRefusal,
  type RouteContinuationResult,
  type RouteAuthorization,
  type RouteBlocker,
  type RouteDestinationKind,
  type RouteDestinationProvider,
  type EffectiveTravel,
  type FrozenOwnIncident,
  type RouteAdmissionProof,
  type RouteDistanceAccount,
  type RouteLegBounds,
  type RouteOwnerCoordinate,
  type RoutePolicy,
  type RoutePort,
  type RouteProposalContext,
  type RouteStatus,
} from '../contracts/locator.ts';
import type { GameSession } from '../game/connection.ts';

export interface RouteControllerOptions {
  policy: RoutePolicy;
  clock: Clock;
  record?: (event: { type: string } & Record<string, unknown>) => void;
  /** Survival seam (own_death destinations); absent: own_death is never available. */
  ownDeath?: RouteDestinationProvider;
}

interface LegRecord {
  index: number;
  destination: RouteDestinationKind;
  anchor: Vec3;
  radius: number;
  startedAtMs: number;
  /** Steering bearing at leg start (owner) or the fixed destination (code-owned). */
  bearingRad: number | null;
  destinationAt: Vec3 | null;
  /** Latest NET horizontal displacement from the leg anchor (bot's own position). */
  displacement: number;
  /** NET progress toward the destination (projection on the bearing / distance reduction). */
  netProgress: number;
  outcome: string;
}

interface RouteRecord {
  auth: RouteAuthorization;
  state: RouteStatus['state'];
  legs: LegRecord[];
  stalledLegs: number;
  blocker: { reason: RouteBlocker; detail: string } | null;
  ownerCoordinates: RouteOwnerCoordinate[];
  distance: RouteDistanceAccount;
  lastSample: Vec3 | null;
  /** The WHOLE own-incident identity frozen at first use (C3); any later difference is refused. */
  boundOwnDeath: FrozenOwnIncident | null;
  /** C12: legs consumed by EARLIER epochs of the same lineage (new legs are numbered after them). */
  legOffset: number;
  /** C12: the last finished leg of an earlier epoch (status only). */
  carriedLastLeg: { index: number; outcome: string; netProgress: number; displacement: number } | null;
  /** C12: a continued lineage whose route had already begun counts own movement from admission. */
  countFromStart: boolean;
}

type LegSummary = { index: number; outcome: string; netProgress: number; displacement: number };

/** Canonical JSON (sorted keys) of plain data: the lineage fingerprint. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

export type BeginLegResult = { ok: true; leg: RouteLegBounds; status: RouteStatus } | { ok: false; blocker: RouteBlocker; detail: string; status: RouteStatus | null };

export interface RouteCtx {
  goalEpoch: number;
  connectionEpoch: number;
  dimension: string;
}

export interface BeginLegRequest extends RouteCtx {
  /** The bot's own current position. */
  at: Vec3;
  destination: RouteDestinationKind;
  /** Internal steering bearing (owner cue) at leg start. */
  bearingRad?: number;
  /** Code-owned fixed destination (verified owner-typed coordinates or own death). */
  destinationAt?: Vec3;
}

export type DestinationCheck =
  | { ok: true; kind: 'owner_destination'; at: Vec3; label: string }
  | { ok: true; kind: 'own_death'; at: Vec3; label: string; identity: FrozenOwnIncident }
  | { ok: false; blocker: RouteBlocker; detail: string };

const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const r1 = (n: number) => Math.round(n * 10) / 10;
const freezeVec = (v: Vec3): Vec3 => Object.freeze({ x: v.x, y: v.y, z: v.z });
const sameVec = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;
const sameIncident = (a: FrozenOwnIncident, b: FrozenOwnIncident) => a.destinationId === b.destinationId && a.dimension === b.dimension && sameVec(a.at, b.at) && a.recordedAtMs === b.recordedAtMs;

/** Owner-typed coordinate match (block centring tolerated), same rule as goals/owner-coordinates.ts. */
export function matchesRouteOwnerCoordinate(at: Vec3, coords: readonly RouteOwnerCoordinate[]): boolean {
  return coords.some((c) => Math.abs(at.x - c.x) <= 0.5 + 1e-9 && Math.abs(at.y - c.y) <= 0.5 + 1e-9 && Math.abs(at.z - c.z) <= 0.5 + 1e-9);
}

/** A single sample jump larger than this is a teleport-scale change (still counted, flagged). */
const LARGE_SAMPLE = 16;

export class RouteController implements RoutePort {
  private readonly options: RouteControllerOptions;
  readonly policy: RoutePolicy;
  private current: RouteRecord | undefined;
  private counter = 0;
  /** Highest goal epoch ever admitted (monotonic; no re-admission of an epoch). */
  private lastAdmittedEpoch = -1;
  private detachMovement: (() => void) | undefined;
  /** C12 lineage bookkeeping: every route this controller granted, with its latest admissible export. */
  private readonly lineages = new Map<string, { goalId: string; latestExport: string | null; consumed: boolean }>();
  /** Logical goal ids that ever received a route grant: a plain admit of the same id never gets a fresh allowance. */
  private readonly goalsWithLineage = new Set<string>();

  constructor(options: RouteControllerOptions) {
    this.options = options;
    this.policy = RoutePolicySchema.parse(options.policy);
  }

  /** Admission: grants the NEW goal epoch its frozen authorization (or declines) and revokes any earlier route. */
  admit(a: RouteAdmission): RouteAuthorization | undefined {
    if (a.goalEpoch <= this.lastAdmittedEpoch) {
      this.options.record?.({ type: 'route_admission_refused', goalId: a.goalId, goalEpoch: a.goalEpoch, reason: 'epoch_already_admitted', lastAdmittedEpoch: this.lastAdmittedEpoch });
      return undefined;
    }
    this.lastAdmittedEpoch = a.goalEpoch;
    if (this.current && this.current.state !== 'revoked') this.revoke('replaced_by_admission');
    this.current = undefined;
    if (this.goalsWithLineage.has(a.goalId)) {
      // C12: the same logical goal continues ONLY through admitContinuation with its carried lineage.
      this.options.record?.({ type: 'route_admission_refused', goalId: a.goalId, goalEpoch: a.goalEpoch, reason: 'continuation_requires_carry' });
      return undefined;
    }
    const p = this.policy;
    if (!p.enabled || !(p.sources as readonly string[]).includes(a.source)) {
      this.options.record?.({ type: 'route_not_authorized', goalId: a.goalId, goalEpoch: a.goalEpoch, source: a.source, reason: p.enabled ? 'source_not_in_policy' : 'routes_disabled' });
      return undefined;
    }
    this.counter += 1;
    const ceilings = Object.freeze({
      legRadius: p.legRadius,
      maxLegs: p.maxLegs,
      maxTotalDistance: p.maxTotalDistance,
      routeDeadlineMs: Math.min(a.admittedAtMs + p.maxRouteMs, a.goalDeadlineMs),
      maxStalledLegs: p.maxStalledLegs,
      minLegProgress: p.minLegProgress,
    });
    const auth: RouteAuthorization = Object.freeze({
      routeId: `route-${this.counter}`,
      goalId: a.goalId,
      goalEpoch: a.goalEpoch,
      connectionEpoch: a.connectionEpoch,
      dimension: a.dimension,
      source: a.source,
      grantedBy: 'operator_policy' as const,
      grantedAtMs: a.admittedAtMs,
      destinations: Object.freeze([...p.destinations]),
      admissionAnchor: freezeVec(a.admissionAnchor),
      admissionRadius: a.admissionRadius,
      ceilings,
    });
    this.current = {
      auth,
      state: 'authorized',
      legs: [],
      stalledLegs: 0,
      blocker: null,
      ownerCoordinates: a.ownerCoordinates.slice(0, 8).map((c) => ({ x: c.x, y: c.y, z: c.z, source: c.source })),
      distance: { total: 0, clientPhysics: 0, serverCorrections: 0, correctionCount: 0 },
      lastSample: null,
      boundOwnDeath: null,
      legOffset: 0,
      carriedLastLeg: null,
      countFromStart: false,
    };
    this.lineages.set(auth.routeId, { goalId: a.goalId, latestExport: null, consumed: false });
    this.goalsWithLineage.add(a.goalId);
    this.options.record?.({ type: 'route_authorized', routeId: auth.routeId, goalId: a.goalId, goalEpoch: a.goalEpoch, source: a.source, destinations: [...auth.destinations], legRadius: ceilings.legRadius, maxLegs: ceilings.maxLegs, maxTotalDistance: ceilings.maxTotalDistance, routeBudgetMs: ceilings.routeDeadlineMs - a.admittedAtMs, ownerCoordinates: this.current.ownerCoordinates.length });
    return auth;
  }

  noteOwnerCoordinates(goalEpoch: number, coordinates: readonly RouteOwnerCoordinate[]): void {
    const r = this.current;
    if (!r || r.state === 'revoked' || r.auth.goalEpoch !== goalEpoch) return;
    for (const c of coordinates) {
      if (r.ownerCoordinates.length >= 8) break;
      if (!matchesRouteOwnerCoordinate(c, r.ownerCoordinates)) r.ownerCoordinates.push({ x: c.x, y: c.y, z: c.z, source: c.source });
    }
  }

  /** The authorization of a goal epoch on its EXACT connection/dimension, if not revoked. */
  authorization(ctx: RouteCtx): RouteAuthorization | undefined {
    const r = this.current;
    if (!r || r.state === 'revoked') return undefined;
    const a = r.auth;
    if (a.goalEpoch !== ctx.goalEpoch || a.connectionEpoch !== ctx.connectionEpoch || a.dimension !== ctx.dimension) return undefined;
    return a;
  }

  /** Whether the route's leg authority is live: leg_active, before the fixed deadline, under the distance ceiling. */
  private legLive(r: RouteRecord): 'live' | 'route_not_active' | 'route_exhausted' | 'route_expired' {
    if (r.state !== 'leg_active' || r.legs.length === 0) return r.state === 'exhausted' || r.state === 'blocked' ? 'route_exhausted' : 'route_not_active';
    if (r.distance.total >= r.auth.ceilings.maxTotalDistance) return 'route_exhausted';
    if (this.options.clock.now() >= r.auth.ceilings.routeDeadlineMs) return 'route_expired';
    return 'live';
  }

  legBounds(ctx: RouteCtx): RouteLegBounds | undefined {
    const auth = this.authorization(ctx);
    const r = this.current;
    if (!auth || !r) return undefined;
    // MB-LOC-001-C2: exhausted/blocked/expired routes withdraw their expanded authority.
    if (this.legLive(r) !== 'live') return undefined;
    const leg = r.legs.at(-1);
    if (!leg) return undefined;
    return { routeId: auth.routeId, goalEpoch: auth.goalEpoch, connectionEpoch: auth.connectionEpoch, dimension: auth.dimension, legIndex: leg.index, anchor: { ...leg.anchor }, radius: leg.radius, admissionAnchor: { ...auth.admissionAnchor }, admissionRadius: auth.admissionRadius };
  }

  /**
   * Reference implementation of the consumer rule for the perception hook: the
   * leg applies only when it belongs to exactly this goal-owned admission
   * anchor (same epochs, dimension and admission anchor).
   */
  static applies(leg: RouteLegBounds | undefined, anchor: { goalEpoch: number | undefined; connectionEpoch: number; dimension: string; at: Vec3 } | undefined): leg is RouteLegBounds {
    if (!leg || !anchor || anchor.goalEpoch === undefined) return false;
    return leg.goalEpoch === anchor.goalEpoch && leg.connectionEpoch === anchor.connectionEpoch && leg.dimension === anchor.dimension && sameVec(leg.admissionAnchor, anchor.at);
  }

  /**
   * The canonical travel bound for every movement poll (shared travel guard,
   * all skills/navigation): the live leg only when it belongs to exactly this
   * goal-owned admission proof; otherwise the unchanged admission bound.
   */
  effectiveTravel(admission: RouteAdmissionProof): EffectiveTravel {
    const base = { anchor: { ...admission.anchor }, radius: admission.radius };
    const auth = this.authorization(admission);
    const r = this.current;
    if (!auth || !r) return { kind: 'admission', ...base, reason: 'no_route' };
    if (!sameVec(auth.admissionAnchor, admission.anchor) || auth.admissionRadius !== admission.radius) return { kind: 'admission', ...base, reason: 'proof_mismatch' };
    const live = this.legLive(r);
    if (live !== 'live') return { kind: 'admission', ...base, reason: live };
    const leg = r.legs.at(-1) as LegRecord;
    return { kind: 'route_leg', anchor: { ...leg.anchor }, radius: leg.radius, routeId: auth.routeId, legIndex: leg.index, admissionAnchor: { ...auth.admissionAnchor }, admissionRadius: auth.admissionRadius };
  }

  proposalContext(ctx: RouteCtx): RouteProposalContext {
    const auth = this.authorization(ctx);
    const r = this.current;
    if (!auth || !r) return { authorized: false, destinations: [], ownDeathAvailable: false, state: r && r.auth.goalEpoch === ctx.goalEpoch ? r.state : null };
    const ownDeathAvailable = auth.destinations.includes('own_death') && this.options.ownDeath?.current(ctx)?.provenance === 'own_incident';
    return { authorized: true, destinations: [...auth.destinations], ownDeathAvailable: Boolean(ownDeathAvailable), state: r.state };
  }

  /**
   * Verifies a fixed destination's provenance for this route (resolver AND
   * executor): owner_destination must match coordinates the owner typed for THIS
   * goal; own_death must come from the installed provider (own incident), in
   * this dimension, and equal the destination first bound by this route.
   */
  verifyDestination(ctx: RouteCtx, kind: 'owner_destination', at: Vec3, dimension: string): DestinationCheck;
  verifyDestination(ctx: RouteCtx, kind: 'own_death'): DestinationCheck;
  verifyDestination(ctx: RouteCtx, kind: 'owner_destination' | 'own_death', at?: Vec3, dimension?: string): DestinationCheck {
    const auth = this.authorization(ctx);
    const r = this.current;
    if (!auth || !r) return { ok: false, blocker: 'not_authorized', detail: 'no route authorization for this goal on this connection and dimension' };
    if (!auth.destinations.includes(kind)) return { ok: false, blocker: 'destination_not_authorized', detail: `route policy does not authorize ${kind} destinations` };
    if (kind === 'owner_destination') {
      if (!at || dimension !== ctx.dimension) return { ok: false, blocker: 'dimension_mismatch', detail: 'the destination is not in the current dimension' };
      if (!matchesRouteOwnerCoordinate(at, r.ownerCoordinates)) return { ok: false, blocker: 'destination_unverified', detail: 'these coordinates were not typed by the owner for this goal' };
      return { ok: true, kind, at: { ...at }, label: `owner-supplied destination ${at.x},${at.y},${at.z}` };
    }
    const dest = this.options.ownDeath?.current(ctx);
    if (!dest || dest.provenance !== 'own_incident') return { ok: false, blocker: 'destination_unverified', detail: 'no recorded own death location from the installed provider' };
    if (dest.dimension !== ctx.dimension) return { ok: false, blocker: 'dimension_mismatch', detail: `the recorded own death location is in ${dest.dimension}` };
    const identity: FrozenOwnIncident = { destinationId: dest.destinationId, dimension: dest.dimension, at: { x: dest.at.x, y: dest.at.y, z: dest.at.z }, recordedAtMs: dest.recordedAtMs };
    if (r.boundOwnDeath !== null && !sameIncident(r.boundOwnDeath, identity)) return { ok: false, blocker: 'destination_changed', detail: 'the recorded own death location changed after this route began; a fresh owner decision is needed' };
    return { ok: true, kind, at: { ...identity.at }, label: dest.label.slice(0, 80), identity };
  }

  /**
   * Freezes the WHOLE own-incident identity at first use (C3). Later calls
   * succeed only for an identical identity (same id, dimension, position and
   * recorded time); the same id with a different position is refused.
   */
  bindOwnDeath(ctx: RouteCtx, identity: FrozenOwnIncident): boolean {
    const r = this.current;
    if (!r || !this.authorization(ctx)) return false;
    if (r.boundOwnDeath !== null) return sameIncident(r.boundOwnDeath, identity);
    r.boundOwnDeath = Object.freeze({ ...identity, at: Object.freeze({ ...identity.at }) });
    return true;
  }

  /** The frozen own-incident identity of the route (null before first use). */
  frozenOwnDeath(ctx: RouteCtx): FrozenOwnIncident | null {
    const r = this.current;
    return r && this.authorization(ctx) ? r.boundOwnDeath : null;
  }

  /**
   * One own-position sample (C1): adds the horizontal path length since the
   * previous sample, once the route's first leg has begun. Server position
   * corrections are counted and labelled. Exceeding the ceiling exhausts the
   * route (no new legs; route skills stop).
   */
  sample(ctx: RouteCtx, at: Vec3, source: 'client_physics' | 'server_correction' = 'client_physics'): number {
    const r = this.current;
    if (!r || !this.authorization(ctx) || (r.legs.length === 0 && !r.countFromStart)) return 0;
    let counted = 0;
    if (r.lastSample) {
      const d = horizontal(r.lastSample, at);
      counted = d;
      if (d > 0) {
        r.distance.total += d;
        if (source === 'server_correction') {
          r.distance.serverCorrections += d;
          r.distance.correctionCount += 1;
        } else r.distance.clientPhysics += d;
        if (d > LARGE_SAMPLE) this.options.record?.({ type: 'route_large_sample', routeId: r.auth.routeId, source, blocks: r1(d) });
      }
    }
    r.lastSample = { x: at.x, y: at.y, z: at.z };
    const leg = r.legs.at(-1);
    if (leg) {
      leg.displacement = horizontal(leg.anchor, at);
      leg.netProgress = this.progressOf(leg, at);
    }
    if (r.distance.total >= r.auth.ceilings.maxTotalDistance && (r.state === 'leg_active' || r.state === 'authorized')) {
      r.state = 'exhausted';
      r.blocker = { reason: 'distance_limit', detail: `${Math.round(r.distance.total)} of ${r.auth.ceilings.maxTotalDistance} route blocks of own movement are used` };
      this.options.record?.({ type: 'route_exhausted', routeId: r.auth.routeId, goalEpoch: r.auth.goalEpoch, blocker: 'distance_limit', distanceUsed: r1(r.distance.total) });
    }
    return counted;
  }

  /**
   * Samples the bot's OWN RESOLVED position on every Mineflayer `move` of one
   * connection (C2). A server position packet is applied by the pinned
   * physics plugin (relative flags resolved per axis) which then emits `move`
   * and, synchronously after it, `forcedMove`; that last move's delta is
   * relabelled as a server correction. Raw journal coordinates are never used,
   * so zero-relative or mixed-axis corrections cannot create fictitious
   * distance, and nothing is counted twice (each sample extends one chain).
   */
  attachMovement(session: GameSession, goalEpoch: () => number): () => void {
    this.detachMovement?.();
    const bot = session.bot as unknown as EventEmitter & { entity: { position: Vec3 }; game: { dimension: unknown } };
    const ctx = (): RouteCtx => ({ goalEpoch: goalEpoch(), connectionEpoch: session.connectionEpoch, dimension: String(bot.game.dimension) });
    let lastMove: { delta: number; route: RouteRecord } | undefined;
    const onMove = () => {
      const p = bot.entity.position;
      const delta = this.sample(ctx(), { x: p.x, y: p.y, z: p.z }, 'client_physics');
      const r = this.current;
      lastMove = delta > 0 && r ? { delta, route: r } : undefined;
      // Only a forcedMove emitted synchronously after THIS move may relabel it.
      queueMicrotask(() => {
        lastMove = undefined;
      });
    };
    const onForcedMove = () => {
      const m = lastMove;
      lastMove = undefined;
      if (!m || m.route !== this.current) return;
      m.route.distance.clientPhysics = Math.max(0, m.route.distance.clientPhysics - m.delta);
      m.route.distance.serverCorrections += m.delta;
      m.route.distance.correctionCount += 1;
    };
    bot.on('move', onMove);
    bot.on('forcedMove', onForcedMove);
    const detach = () => {
      bot.off('move', onMove);
      bot.off('forcedMove', onForcedMove);
      if (this.detachMovement === detach) this.detachMovement = undefined;
    };
    this.detachMovement = detach;
    return detach;
  }

  /** Whether route movement may continue (not exhausted by distance or time). */
  budget(ctx: RouteCtx): { ok: true } | { ok: false; blocker: RouteBlocker; detail: string } {
    const r = this.current;
    if (!r || !this.authorization(ctx)) return { ok: true }; // inside the admission bound: no route budget applies
    if (r.state === 'exhausted' || r.state === 'blocked') return { ok: false, blocker: r.blocker?.reason ?? 'leg_limit', detail: r.blocker?.detail ?? 'route ended' };
    if (r.legs.length > 0 && this.options.clock.now() >= r.auth.ceilings.routeDeadlineMs) return { ok: false, blocker: 'time_limit', detail: 'the route time budget of this goal is spent' };
    return { ok: true };
  }

  private progressOf(leg: LegRecord, at: Vec3): number {
    if (leg.destinationAt) return horizontal(leg.anchor, leg.destinationAt) - horizontal(at, leg.destinationAt);
    if (leg.bearingRad !== null) return (at.x - leg.anchor.x) * Math.cos(leg.bearingRad) + (at.z - leg.anchor.z) * Math.sin(leg.bearingRad);
    return 0;
  }

  /** Whether a new leg could begin now (no side effects). */
  canBegin(ctx: RouteCtx, destination: RouteDestinationKind): { ok: true } | { ok: false; blocker: RouteBlocker; detail: string } {
    const auth = this.authorization(ctx);
    const r = this.current;
    if (!auth || !r) return { ok: false, blocker: 'not_authorized', detail: 'no route authorization for this goal on this connection and dimension' };
    if (!auth.destinations.includes(destination)) return { ok: false, blocker: 'destination_not_authorized', detail: `route policy does not authorize ${destination} destinations` };
    return this.ceilingCheck(r, this.options.clock.now(), r.stalledLegs);
  }

  private ceilingCheck(r: RouteRecord, now: number, stalled: number): { ok: true } | { ok: false; blocker: RouteBlocker; detail: string } {
    const c = r.auth.ceilings;
    if (r.state === 'blocked' || r.state === 'exhausted') return { ok: false, blocker: r.blocker?.reason ?? 'leg_limit', detail: r.blocker?.detail ?? 'route ended' };
    if (stalled >= c.maxStalledLegs) return { ok: false, blocker: 'stalled', detail: `${stalled} consecutive legs made less than ${c.minLegProgress} blocks of net progress toward the destination` };
    if (r.legOffset + r.legs.length >= c.maxLegs) return { ok: false, blocker: 'leg_limit', detail: `all ${c.maxLegs} route legs of this goal are used` };
    if (r.distance.total >= c.maxTotalDistance) return { ok: false, blocker: 'distance_limit', detail: `${Math.round(r.distance.total)} of ${c.maxTotalDistance} route blocks of own movement are used` };
    if (now >= c.routeDeadlineMs) return { ok: false, blocker: 'time_limit', detail: 'the route time budget of this goal is spent' };
    return { ok: true };
  }

  /** Begins the next leg at the bot's own position (code-owned; counted; never refunded). */
  beginLeg(req: BeginLegRequest): BeginLegResult {
    const ctx: RouteCtx = { goalEpoch: req.goalEpoch, connectionEpoch: req.connectionEpoch, dimension: req.dimension };
    const auth = this.authorization(ctx);
    const r = this.current;
    if (!auth || !r) {
      const mismatch = this.current && this.current.state !== 'revoked' && this.current.auth.goalEpoch === req.goalEpoch && this.current.auth.dimension !== req.dimension;
      return { ok: false, blocker: mismatch ? 'dimension_mismatch' : 'not_authorized', detail: mismatch ? 'the route was authorized in another dimension' : 'no route authorization for this goal on this connection and dimension', status: null };
    }
    if (!auth.destinations.includes(req.destination)) return { ok: false, blocker: 'destination_not_authorized', detail: `route policy does not authorize ${req.destination} destinations`, status: this.status(req.goalEpoch) };
    const now = this.options.clock.now();
    this.sample(ctx, req.at);
    // Close the active leg from the bot's own position; the stall run uses NET progress.
    const prev = r.legs.at(-1);
    let stalled = r.stalledLegs;
    if (prev) {
      prev.displacement = horizontal(prev.anchor, req.at);
      prev.netProgress = this.progressOf(prev, req.at);
      prev.outcome = prev.netProgress >= auth.ceilings.minLegProgress ? 'progressed' : 'stalled';
      stalled = prev.outcome === 'stalled' ? stalled + 1 : 0;
      r.stalledLegs = stalled;
    }
    const check = this.ceilingCheck(r, now, stalled);
    if (!check.ok) {
      if (r.state !== 'exhausted' && r.state !== 'blocked') {
        r.state = check.blocker === 'stalled' ? 'blocked' : 'exhausted';
        r.blocker = { reason: check.blocker, detail: check.detail };
      }
      this.options.record?.({ type: 'route_leg_refused', routeId: auth.routeId, goalEpoch: auth.goalEpoch, blocker: check.blocker, legsUsed: r.legOffset + r.legs.length, distanceUsed: r1(r.distance.total) });
      return { ok: false, blocker: check.blocker, detail: check.detail, status: this.status(req.goalEpoch) };
    }
    const leg: LegRecord = {
      index: r.legOffset + r.legs.length + 1, // C12: monotonic across continuation epochs
      destination: req.destination,
      anchor: { x: req.at.x, y: req.at.y, z: req.at.z },
      radius: auth.ceilings.legRadius,
      startedAtMs: now,
      bearingRad: req.bearingRad ?? null,
      destinationAt: req.destinationAt ? { ...req.destinationAt } : null,
      displacement: 0,
      netProgress: 0,
      outcome: 'active',
    };
    r.legs.push(leg);
    r.state = 'leg_active';
    r.lastSample ??= { x: req.at.x, y: req.at.y, z: req.at.z };
    this.options.record?.({ type: 'route_leg_started', routeId: auth.routeId, goalEpoch: auth.goalEpoch, leg: leg.index, maxLegs: auth.ceilings.maxLegs, radius: leg.radius, destination: req.destination, distanceUsed: r1(r.distance.total) });
    return { ok: true, leg: this.legBounds(ctx) as RouteLegBounds, status: this.status(req.goalEpoch) as RouteStatus };
  }

  status(goalEpoch?: number): RouteStatus | null {
    const r = this.current;
    if (!r || (goalEpoch !== undefined && r.auth.goalEpoch !== goalEpoch)) return null;
    const a = r.auth;
    const leg = r.legs.at(-1);
    const prev = r.legs.length > 1 ? r.legs.at(-2) : undefined;
    const last: LegSummary | null = prev ? { index: prev.index, outcome: prev.outcome, netProgress: prev.netProgress, displacement: prev.displacement } : r.carriedLastLeg;
    return {
      routeId: a.routeId,
      goalId: a.goalId,
      state: r.state,
      destinations: [...a.destinations],
      legsUsed: r.legOffset + r.legs.length,
      maxLegs: a.ceilings.maxLegs,
      distanceUsed: r1(r.distance.total),
      distanceSources: { clientPhysics: r1(r.distance.clientPhysics), serverCorrections: r1(r.distance.serverCorrections), correctionCount: r.distance.correctionCount },
      maxTotalDistance: a.ceilings.maxTotalDistance,
      remainingMs: Math.max(0, Math.round(a.ceilings.routeDeadlineMs - this.options.clock.now())),
      stalledLegs: r.stalledLegs,
      legRadius: a.ceilings.legRadius,
      currentLeg: leg && r.state !== 'revoked' ? { index: leg.index, destination: leg.destination, anchor: { x: r1(leg.anchor.x), y: r1(leg.anchor.y), z: r1(leg.anchor.z) }, radius: leg.radius } : null,
      lastLeg: last ? { index: last.index, outcome: last.outcome, netProgress: r1(last.netProgress), displacement: r1(last.displacement) } : null,
      blocker: r.blocker,
      ...(a.continuation ? { continuation: { count: a.continuation.count, originalGoalEpoch: a.continuation.originalGoalEpoch } } : {}),
    };
  }

  // ------------------------------------------------------------ C12 continuation lineage

  /**
   * The lineage of the CURRENT route of `goalEpoch`, captured BEFORE revocation.
   * Changes no route state; it only records this export as the route's latest
   * admissible lineage (an older export can never be admitted afterwards). An
   * active leg is finalized conservatively as `interrupted_*` from its last own
   * sample: it stays counted and is never executable again.
   */
  exportCarry(goalEpoch: number): RouteCarry | undefined {
    const r = this.current;
    if (!r || r.state === 'revoked' || r.auth.goalEpoch !== goalEpoch) return undefined;
    const a = r.auth;
    let stalled = r.stalledLegs;
    let lastLeg: LegSummary | null = r.carriedLastLeg;
    for (const [i, leg] of r.legs.entries()) {
      const active = i === r.legs.length - 1 && r.state === 'leg_active';
      const outcome = active ? (leg.netProgress >= a.ceilings.minLegProgress ? 'interrupted_progressed' : 'interrupted_stalled') : leg.outcome;
      if (active) stalled = outcome === 'interrupted_stalled' ? stalled + 1 : 0;
      lastLeg = { index: leg.index, outcome, netProgress: r1(leg.netProgress), displacement: r1(leg.displacement) };
    }
    const carry: RouteCarry = deepFreeze({
      version: ROUTE_CARRY_VERSION,
      routeId: a.routeId,
      goalId: a.goalId,
      originalGoalEpoch: a.continuation?.originalGoalEpoch ?? a.goalEpoch,
      fromGoalEpoch: a.goalEpoch,
      connectionEpoch: a.connectionEpoch,
      dimension: a.dimension,
      source: a.source,
      grantedAtMs: a.grantedAtMs,
      exportedAtMs: this.options.clock.now(),
      destinations: [...a.destinations],
      admissionAnchor: { ...a.admissionAnchor },
      admissionRadius: a.admissionRadius,
      ceilings: { ...a.ceilings },
      legsUsed: r.legOffset + r.legs.length,
      lastLeg,
      stalledLegs: stalled,
      distance: { ...r.distance },
      state: r.state === 'exhausted' || r.state === 'blocked' ? r.state : 'authorized',
      blocker: r.blocker ? { ...r.blocker } : null,
      ownerCoordinates: r.ownerCoordinates.map((c) => ({ ...c })),
      boundOwnDeath: r.boundOwnDeath ? { ...r.boundOwnDeath, at: { ...r.boundOwnDeath.at } } : null,
      continuations: a.continuation?.count ?? 0,
    });
    const lineage = this.lineages.get(a.routeId);
    if (lineage) {
      lineage.latestExport = canonical(carry);
      lineage.consumed = false;
    }
    this.options.record?.({ type: 'route_carry_exported', routeId: a.routeId, goalId: a.goalId, goalEpoch, legsUsed: carry.legsUsed, distanceUsed: r1(carry.distance.total), state: carry.state });
    return carry;
  }

  revokeWithCarry(reason: string, goalEpoch: number): RouteCarry | undefined {
    const carry = this.exportCarry(goalEpoch);
    this.revoke(reason, goalEpoch);
    return carry;
  }

  /**
   * Continuation admission of the SAME logical goal at a FRESH epoch. Validates
   * the lineage (latest unconsumed export of a route this controller granted),
   * the goal id, epoch freshness, connection, dimension, exact anchor and source;
   * then installs the original ceilings and consumed history. Exhausted, blocked
   * or expired lineages are recorded for truthful status with NO authority.
   */
  admitContinuation(carry: RouteCarry, a: RouteAdmission): RouteContinuationResult {
    if (a.goalEpoch <= this.lastAdmittedEpoch || a.goalEpoch <= carry.fromGoalEpoch) return this.refuseContinuation(carry, a, 'stale_epoch', `goal epoch ${a.goalEpoch} is not fresh`, false);
    const lineage = this.lineages.get(carry.routeId);
    let fingerprint = '';
    try {
      fingerprint = canonical(carry);
    } catch {
      fingerprint = '';
    }
    if (carry.version !== ROUTE_CARRY_VERSION || !lineage || lineage.consumed || lineage.latestExport === null || lineage.latestExport !== fingerprint || lineage.goalId !== carry.goalId) {
      return this.refuseContinuation(carry, a, 'unknown_or_stale_carry', 'not the latest unadmitted route lineage exported by this controller', true);
    }
    if (a.goalId !== carry.goalId) return this.refuseContinuation(carry, a, 'goal_mismatch', 'a continuation keeps the logical goal id of its lineage', true);
    if (a.connectionEpoch !== carry.connectionEpoch) return this.refuseContinuation(carry, a, 'connection_mismatch', 'route lineages never cross connections', true);
    if (a.dimension !== carry.dimension) return this.refuseContinuation(carry, a, 'dimension_mismatch', `the route lineage belongs to ${carry.dimension}`, true);
    if (!sameVec(a.admissionAnchor, carry.admissionAnchor) || a.admissionRadius !== carry.admissionRadius) return this.refuseContinuation(carry, a, 'anchor_mismatch', 'a continuation installs exactly the original admission anchor and radius', true);
    if (a.source !== carry.source) return this.refuseContinuation(carry, a, 'source_mismatch', 'the goal source of a lineage never changes', true);
    // Accepted: this epoch is admitted once; any other route is replaced; the export is consumed.
    this.lastAdmittedEpoch = a.goalEpoch;
    if (this.current && this.current.state !== 'revoked') this.revoke('replaced_by_admission');
    lineage.consumed = true;
    const now = this.options.clock.now();
    const c = carry.ceilings;
    let terminal: { state: 'exhausted' | 'blocked'; reason: RouteBlocker; detail: string } | null = null;
    if (carry.state !== 'authorized') terminal = { state: carry.state, reason: carry.blocker?.reason ?? 'leg_limit', detail: carry.blocker?.detail ?? 'the route had already ended' };
    else if (now >= c.routeDeadlineMs) terminal = { state: 'exhausted', reason: 'time_limit', detail: 'the original route time budget of this goal is spent' };
    else if (carry.distance.total >= c.maxTotalDistance) terminal = { state: 'exhausted', reason: 'distance_limit', detail: `${Math.round(carry.distance.total)} of ${c.maxTotalDistance} route blocks of own movement are used` };
    else if (carry.legsUsed >= c.maxLegs) terminal = { state: 'exhausted', reason: 'leg_limit', detail: `all ${c.maxLegs} route legs of this goal are used` };
    else if (carry.stalledLegs >= c.maxStalledLegs) terminal = { state: 'blocked', reason: 'stalled', detail: `${carry.stalledLegs} consecutive legs made less than ${c.minLegProgress} blocks of net progress toward the destination` };
    const auth: RouteAuthorization = deepFreeze({
      routeId: carry.routeId,
      goalId: carry.goalId,
      goalEpoch: a.goalEpoch,
      connectionEpoch: carry.connectionEpoch,
      dimension: carry.dimension,
      source: carry.source,
      grantedBy: 'operator_policy' as const,
      grantedAtMs: carry.grantedAtMs,
      destinations: [...carry.destinations],
      admissionAnchor: { ...carry.admissionAnchor },
      admissionRadius: carry.admissionRadius,
      ceilings: { ...c },
      continuation: { originalGoalEpoch: carry.originalGoalEpoch, fromGoalEpoch: carry.fromGoalEpoch, count: carry.continuations + 1 },
    });
    this.current = {
      auth,
      state: terminal ? terminal.state : 'authorized',
      legs: [],
      stalledLegs: carry.stalledLegs,
      blocker: terminal ? { reason: terminal.reason, detail: terminal.detail } : null,
      ownerCoordinates: carry.ownerCoordinates.slice(0, 8).map((o) => ({ x: o.x, y: o.y, z: o.z, source: o.source })),
      distance: { total: carry.distance.total, clientPhysics: carry.distance.clientPhysics, serverCorrections: carry.distance.serverCorrections, correctionCount: carry.distance.correctionCount },
      lastSample: null, // the respawn/teleport displacement is not own movement; the chain restarts here
      boundOwnDeath: carry.boundOwnDeath ? Object.freeze({ ...carry.boundOwnDeath, at: Object.freeze({ ...carry.boundOwnDeath.at }) }) : null,
      legOffset: carry.legsUsed,
      carriedLastLeg: carry.lastLeg ? { ...carry.lastLeg } : null,
      countFromStart: carry.legsUsed > 0,
    };
    this.goalsWithLineage.add(carry.goalId);
    const status = this.status(a.goalEpoch) as RouteStatus;
    this.options.record?.({ type: terminal ? 'route_continuation_terminal' : 'route_continued', routeId: carry.routeId, goalId: carry.goalId, goalEpoch: a.goalEpoch, fromGoalEpoch: carry.fromGoalEpoch, continuation: carry.continuations + 1, legsUsed: carry.legsUsed, distanceUsed: r1(carry.distance.total), ...(terminal ? { blocker: terminal.reason } : {}) });
    if (terminal) return { ok: false, kind: 'terminal', blocker: terminal.reason, detail: terminal.detail, status };
    return { ok: true, authorization: auth, status };
  }

  /** Refusal: nothing is installed. A FRESH epoch is still consumed (fail closed: it can never get a fresh grant later). */
  private refuseContinuation(carry: RouteCarry, a: RouteAdmission, reason: RouteContinuationRefusal, detail: string, freshEpoch: boolean): RouteContinuationResult {
    if (freshEpoch && a.goalEpoch > this.lastAdmittedEpoch) {
      this.lastAdmittedEpoch = a.goalEpoch;
      if (this.current && this.current.state !== 'revoked') this.revoke('replaced_by_admission');
      this.current = undefined;
    }
    this.options.record?.({ type: 'route_continuation_refused', routeId: String(carry?.routeId ?? ''), goalId: a.goalId, goalEpoch: a.goalEpoch, reason });
    return { ok: false, kind: 'refused', reason, detail, status: null };
  }

  revoke(reason: string, goalEpoch?: number): void {
    const r = this.current;
    if (!r || r.state === 'revoked') return;
    if (goalEpoch !== undefined && r.auth.goalEpoch !== goalEpoch) return;
    r.state = 'revoked';
    this.options.record?.({ type: 'route_revoked', routeId: r.auth.routeId, goalEpoch: r.auth.goalEpoch, reason: reason.slice(0, 64), legsUsed: r.legs.length, distanceUsed: r1(r.distance.total) });
  }
}
