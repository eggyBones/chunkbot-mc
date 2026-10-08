// MB-LOC-001 locator-assisted following and declared bounded route legs.
//
// Two code-owned concepts, both plain data (no Minecraft library imports):
//
// 1. LocatorHint — a COARSE, owner-only cue derived from the server's
//    `tracked_waypoint` (locator bar) packets: compass sector, distance band and
//    relative elevation where the received variant justifies it, with source,
//    receive time, freshness, connection epoch and dimension. Exact waypoint
//    coordinates are used only transiently inside src/locator/ to derive the
//    cue; they never appear in this contract, observations, planner/Jev
//    context, memory, status/dashboard or logs. A hint is NOT owner
//    visibility, an interaction target, or proof of arrival. Identity is bound
//    only by the configured verified owner UUID (or, in the trusted offline
//    fixture, the exact name's derived offline UUID AND that exact listed
//    name); never by icon colour, order, name similarity or nearest player.
//    String-identified waypoints and unknown UUIDs grant no identity.
//
// 2. RouteAuthorization — a typed, code-owned leg budget granted at goal
//    ADMISSION from operator policy (never by the planner). Each leg is a
//    finite local travel bound anchored at the bot's own position when the leg
//    begins, inside which the ordinary conservative skills operate on fresh
//    local geometry. Parent ceilings (legs, total leg distance, elapsed time,
//    stalled legs) are fixed at admission and cannot be reset by a new leg,
//    window, replan or planner output. The admission anchor and the goal's
//    accepted outcome/counters are unchanged by legs.
import { z } from 'zod';
import { BOUNDS, DimensionSchema, Vec3Schema, textSchema, type Vec3 } from './common.ts';
import { EpochSchema, GoalIdSchema } from './ids.ts';

// ---------------------------------------------------------------- locator hints

/** Eight compass sectors (+x east, +z south); the same vocabulary as observation frontiers. */
export const COMPASS_SECTORS = ['east', 'south_east', 'south', 'south_west', 'west', 'north_west', 'north', 'north_east'] as const;
export const CompassSectorSchema = z.enum(COMPASS_SECTORS);
export type CompassSector = z.infer<typeof CompassSectorSchema>;

/** Waypoint payload variants of the 26.x `tracked_waypoint` codec. */
export const WAYPOINT_VARIANTS = ['empty', 'vec3i', 'chunk', 'azimuth'] as const;
export const WaypointVariantSchema = z.enum(WAYPOINT_VARIANTS);
export type WaypointVariant = z.infer<typeof WaypointVariantSchema>;

/**
 * Horizontal distance band (blocks). `vec3i` justifies any band; `chunk` only
 * bands whose edges are not within the chunk-centre uncertainty; `azimuth`
 * and `empty` carry no distance (`unknown`).
 */
export const LOCATOR_DISTANCE_BANDS = ['close', 'near', 'far', 'very_far', 'unknown'] as const;
export const LocatorDistanceBandSchema = z.enum(LOCATOR_DISTANCE_BANDS);
export type LocatorDistanceBand = z.infer<typeof LocatorDistanceBandSchema>;
/** Upper edges of close/near/far (blocks, horizontal); beyond the last is very_far. */
export const LOCATOR_BAND_EDGES = { close: 32, near: 128, far: 512 } as const;

/** Relative height: only a block-precision (vec3i) statement justifies above/below/level. */
export const LOCATOR_ELEVATIONS = ['above', 'below', 'level', 'unknown'] as const;
export const LocatorElevationSchema = z.enum(LOCATOR_ELEVATIONS);
export type LocatorElevation = z.infer<typeof LocatorElevationSchema>;
/** |dy| at or below this is `level` (blocks). */
export const LOCATOR_LEVEL_TOLERANCE = 3;

/** Precision of the server statement the cue came from (never the statement itself). */
export const LOCATOR_PRECISIONS = ['block', 'chunk', 'direction_only', 'none'] as const;
export type LocatorPrecision = (typeof LOCATOR_PRECISIONS)[number];

/** Why a hint is not actionable (or `tracking` when it is). */
export const LOCATOR_HINT_REASONS = [
  'tracking', // a current server statement for the verified owner
  'never_received', // no owner waypoint on this connection/dimension yet
  'untracked', // the server withdrew the owner's waypoint (hidden: crouching, invisibility, head item, range, logout, ...)
  'expired', // the last statement is older than the freshness bound
  'no_position', // the server tracks the owner with an `empty` payload
  'direction_undetermined', // the statement does not determine a horizontal direction from here (e.g. owner's chunk is this chunk, or directly above/below)
  'dimension_changed', // a dimension change/respawn voided earlier statements
  'disconnected', // no ready connection (statements never carry across connections)
  'owner_identity_unverified', // the owner policy cannot verify identity on this connection (e.g. UUID mode on an offline-mode server)
  'unsupported_codec', // the installed protocol does not have the verified tracked_waypoint definition
  'disabled', // locator perception is disabled by configuration
] as const;
export const LocatorHintReasonSchema = z.enum(LOCATOR_HINT_REASONS);
export type LocatorHintReason = z.infer<typeof LocatorHintReasonSchema>;

/**
 * The ONLY model-visible locator data. Coarse, owner-only, freshness-labelled.
 * `actionable` is true only for a current statement with a direction on the
 * current connection and dimension.
 */
export const LocatorHintSchema = z
  .object({
    target: z.literal('owner'),
    source: z.literal('server_locator_waypoint'),
    actionable: z.boolean(),
    reason: LocatorHintReasonSchema,
    direction: CompassSectorSchema.nullable(),
    distanceBand: LocatorDistanceBandSchema,
    elevation: LocatorElevationSchema,
    precision: z.enum(LOCATOR_PRECISIONS),
    /** Age of the last owner statement at view time (null: none received). */
    ageMs: z.number().int().nonnegative().nullable(),
    /** Remaining freshness (null: not actionable). */
    expiresInMs: z.number().int().nonnegative().nullable(),
    connectionEpoch: EpochSchema,
    dimension: DimensionSchema.nullable(),
    note: textSchema(BOUNDS.shortText),
  })
  .strict();
export type LocatorHint = z.infer<typeof LocatorHintSchema>;

/** Bounded counters for status/evidence (counts only; never positions or other players' identities). */
export interface LocatorCounters {
  packets: number;
  track: number;
  update: number;
  untrack: number;
  /** Statements attributed to the verified owner. */
  ownerStatements: number;
  /** Waypoints currently tracked that are NOT the verified owner (count only). */
  otherTracked: number;
  /** String-identified waypoints received (never granted identity). */
  stringIds: number;
  /** Packets refused as malformed/unknown variant. */
  rejected: number;
  byVariant: Record<WaypointVariant, number>;
}

export const LOCATOR_SUPPORT = ['available', 'unsupported_codec', 'disabled', 'not_connected'] as const;
export type LocatorSupport = (typeof LOCATOR_SUPPORT)[number];

export interface LocatorStatus {
  support: LocatorSupport;
  /** The protocol version whose codec was verified (e.g. 26.2), when available. */
  codecVersion: string | null;
  connectionEpoch: number;
  owner: LocatorHint;
  counters: LocatorCounters;
}

// ---------------------------------------------------------------- configuration

/**
 * Operator route policy (proposed ChunkbotConfig `locator.routes`, added by the
 * designated writer). The planner never supplies or changes these values.
 */
export const RoutePolicySchema = z
  .object({
    /** Off: no route authorization is ever granted; travel stays inside the admission radius. */
    enabled: z.boolean().default(true),
    /** Local bound of one leg (blocks, horizontal) around the bot's position when the leg begins. */
    legRadius: z.number().int().min(16).max(256).default(96),
    /** Legs per goal, including legs that made no progress. */
    maxLegs: z.number().int().min(1).max(64).default(12),
    /**
     * MB-LOC-001-C1: CUMULATIVE own movement per goal once its first leg begins
     * (horizontal path length sampled from the bot's own position; server
     * position corrections are counted and labelled). Out-and-back trips and
     * detours consume it. Net/projected progress is separate (stall detection).
     */
    maxTotalDistance: z.number().int().min(64).max(8_192).default(1_024),
    /**
     * Wall-clock route budget measured from goal ADMISSION (fixed when the
     * authorization is granted; a leg never restarts it). The effective
     * deadline is min(admission + maxRouteMs, goal deadline).
     */
    maxRouteMs: z.number().int().min(10_000).max(3_600_000).default(15 * 60_000),
    /** Consecutive legs whose NET progress toward the destination is below minLegProgress before the route is blocked. */
    maxStalledLegs: z.number().int().min(1).max(8).default(3),
    minLegProgress: z.number().int().min(1).max(64).default(8),
    /** Destination kinds a goal may route toward. */
    destinations: z.array(z.enum(['owner', 'owner_destination', 'own_death'])).min(1).max(3).default(['owner', 'owner_destination']),
    /** Goal sources that receive an authorization at admission. */
    sources: z.array(z.enum(['owner', 'progression', 'support'])).min(1).max(3).default(['owner']),
  })
  .strict();
export type RoutePolicy = z.infer<typeof RoutePolicySchema>;

export const LocatorConfigSchema = z
  .object({
    /** Locator perception (waypoint packets -> coarse owner hint). */
    enabled: z.boolean().default(true),
    /**
     * A tracked owner statement older than this is `expired` (not actionable).
     * MB-LOC-002 D1 (coordinator-authorized): the DEFAULT is the bounded maximum,
     * 600 s, because the official server sends no new statement while a
     * block/chunk-precision owner stands still, even as the bot moves. Untrack,
     * logout (identity no longer listed), dimension change, respawn and
     * connection end still withdraw the cue IMMEDIATELY, at any age. An explicitly
     * configured value is binding (never extended); the reported age and
     * remaining freshness stay honest.
     */
    hintMaxAgeMs: z.number().int().min(1_000).max(600_000).default(600_000),
    routes: RoutePolicySchema.default(RoutePolicySchema.parse({})),
  })
  .strict();
export type LocatorConfig = z.infer<typeof LocatorConfigSchema>;
export const DEFAULT_LOCATOR_CONFIG: LocatorConfig = LocatorConfigSchema.parse({});

// ---------------------------------------------------------------- routes

export const RouteIdSchema = z.string().regex(/^route-[a-z0-9]{1,32}$/);
export type RouteId = z.infer<typeof RouteIdSchema>;

export const ROUTE_DESTINATION_KINDS = ['owner', 'owner_destination', 'own_death'] as const;
export type RouteDestinationKind = (typeof ROUTE_DESTINATION_KINDS)[number];

/** Who the admitted goal belongs to (typed code-owned context; not a goal/task enum). */
export const ROUTE_GOAL_SOURCES = ['owner', 'progression', 'support', 'diagnostic'] as const;
export type RouteGoalSource = (typeof ROUTE_GOAL_SOURCES)[number];

export interface RouteCeilings {
  legRadius: number;
  maxLegs: number;
  /** Cumulative own movement (path length) budget once the first leg begins. */
  maxTotalDistance: number;
  /** Absolute wall-clock end fixed at admission: min(admittedAt + maxRouteMs, goal deadline). */
  routeDeadlineMs: number;
  maxStalledLegs: number;
  minLegProgress: number;
}

/** Owner-typed coordinates recorded for the goal (code-parsed from the owner's own words; provenance for owner_destination). */
export interface RouteOwnerCoordinate {
  x: number;
  y: number;
  z: number;
  source: 'instruction' | 'answer';
}

/** Immutable once granted (Object.freeze); only the route controller holds mutable usage. */
export interface RouteAuthorization {
  routeId: RouteId;
  goalId: string;
  goalEpoch: number;
  connectionEpoch: number;
  dimension: string;
  source: RouteGoalSource;
  grantedBy: 'operator_policy';
  grantedAtMs: number;
  destinations: readonly RouteDestinationKind[];
  /** Copy of the goal's admission anchor; never moved by a leg. */
  admissionAnchor: Vec3;
  admissionRadius: number;
  ceilings: Readonly<RouteCeilings>;
  /**
   * MB-FLOW-003-C12 lineage: present only on a CONTINUATION grant (same routeId
   * and logical goal id, fresh goal epoch). Never a fresh allowance.
   */
  continuation?: Readonly<{ originalGoalEpoch: number; fromGoalEpoch: number; count: number }>;
}

/**
 * Input of the synchronous admission hook (called right after the travel-anchor
 * capture, before planning). One admission per goal epoch: a repeated or older
 * epoch is refused, so no callback can regrant or reset a route.
 */
export interface RouteAdmission {
  goalId: string;
  goalEpoch: number;
  admittedAtMs: number;
  source: RouteGoalSource;
  /** Absolute goal deadline (ms since epoch). */
  goalDeadlineMs: number;
  connectionEpoch: number;
  dimension: string;
  admissionAnchor: Vec3;
  admissionRadius: number;
  /** Coordinates the owner typed in the admitted instruction (GoalEngine ownerCoordinates). */
  ownerCoordinates: readonly RouteOwnerCoordinate[];
}

export const ROUTE_STATES = ['authorized', 'leg_active', 'exhausted', 'blocked', 'revoked'] as const;
export type RouteState = (typeof ROUTE_STATES)[number];

export const ROUTE_BLOCKERS = [
  'leg_limit',
  'distance_limit',
  'time_limit',
  'stalled', // maxStalledLegs consecutive legs without net progress toward the destination
  'no_actionable_hint', // owner not visible and no current locator statement
  'destination_not_authorized',
  'destination_unverified', // owner_destination not typed by the owner for this goal / own_death not from the provider
  'destination_changed', // the code-owned destination changed after the route bound it
  'dimension_mismatch',
  'not_authorized', // no route authorization for this goal epoch/connection
] as const;
export type RouteBlocker = (typeof ROUTE_BLOCKERS)[number];

/**
 * Effective local travel bound of the active leg, with its full route context.
 * Consumers (perception travel guard) must apply it ONLY when goalEpoch,
 * connectionEpoch, dimension AND admissionAnchor exactly match their own
 * goal-owned admission anchor; on any mismatch the admission bound applies.
 */
export interface RouteLegBounds {
  routeId: RouteId;
  goalEpoch: number;
  connectionEpoch: number;
  dimension: string;
  legIndex: number;
  /** The bot's own position when the leg began (not a hidden coordinate). */
  anchor: Vec3;
  radius: number;
  /** The unchanged admission anchor/radius of the same authorization. */
  admissionAnchor: Vec3;
  admissionRadius: number;
}

/**
 * Goal-owned ADMISSION proof (MB-LOC-001-C2/C3): the original admission bound of
 * a goal epoch, from a dedicated accessor that never returns a route leg
 * (proposed PerceptionService.admissionBounds()). Route legs apply only when
 * the authorization's admission anchor/radius equal this proof exactly.
 */
export interface RouteAdmissionProof {
  goalEpoch: number;
  connectionEpoch: number;
  dimension: string;
  anchor: Vec3;
  radius: number;
}

/**
 * The canonical travel bound for ALL movement of a goal (shared travel guard,
 * every skill/navigation poll): the active leg only while the route is
 * `leg_active`, before its fixed deadline, under its cumulative distance
 * ceiling and with an exactly matching admission proof; otherwise the
 * unchanged admission bound. Never a stale expanded leg.
 */
export type EffectiveTravel =
  | { kind: 'admission'; anchor: Vec3; radius: number; reason: 'no_route' | 'route_not_active' | 'route_exhausted' | 'route_expired' | 'proof_mismatch' }
  | { kind: 'route_leg'; anchor: Vec3; radius: number; routeId: RouteId; legIndex: number; admissionAnchor: Vec3; admissionRadius: number };

/** Frozen own-incident destination identity (C3): bound at first use; any later difference stops the route. */
export interface FrozenOwnIncident {
  destinationId: string;
  dimension: string;
  at: Vec3;
  recordedAtMs: number;
}

/** Own-movement accounting source (C1): client physics samples vs server position corrections. */
export interface RouteDistanceAccount {
  /** Total counted path length (blocks, horizontal). */
  total: number;
  clientPhysics: number;
  serverCorrections: number;
  correctionCount: number;
}

/** Model/status-visible route progress (no destination coordinates, no hidden positions). */
export const RouteStatusSchema = z
  .object({
    routeId: RouteIdSchema,
    goalId: GoalIdSchema,
    state: z.enum(ROUTE_STATES),
    destinations: z.array(z.enum(ROUTE_DESTINATION_KINDS)).max(3),
    legsUsed: z.number().int().nonnegative(),
    maxLegs: z.number().int().positive(),
    /** Cumulative own movement since the first leg (C1). */
    distanceUsed: z.number().nonnegative(),
    distanceSources: z.object({ clientPhysics: z.number().nonnegative(), serverCorrections: z.number().nonnegative(), correctionCount: z.number().int().nonnegative() }).strict(),
    maxTotalDistance: z.number().positive(),
    remainingMs: z.number().int().nonnegative(),
    stalledLegs: z.number().int().nonnegative(),
    legRadius: z.number().positive(),
    currentLeg: z
      .object({ index: z.number().int().positive(), destination: z.enum(ROUTE_DESTINATION_KINDS), anchor: Vec3Schema, radius: z.number().positive() })
      .strict()
      .nullable(),
    lastLeg: z
      .object({ index: z.number().int().positive(), outcome: z.string().max(64), netProgress: z.number(), displacement: z.number().nonnegative() })
      .strict()
      .nullable(),
    blocker: z.object({ reason: z.enum(ROUTE_BLOCKERS), detail: textSchema(BOUNDS.shortText) }).strict().nullable(),
    /** C12 lineage: continuations admitted for this route (absent/null on an original grant). */
    continuation: z.object({ count: z.number().int().positive(), originalGoalEpoch: EpochSchema }).strict().nullable().optional(),
  })
  .strict();
export type RouteStatus = z.infer<typeof RouteStatusSchema>;

// ---------------------------------------------------------------- continuation lineage (MB-FLOW-003-C12)

export const ROUTE_LINEAGE_VERSION = 1 as const;

/**
 * The route allowance lineage of ONE logical goal, exported by the route
 * controller BEFORE the interrupted goal epoch's route is revoked, and admitted
 * once into the continuation epoch of the SAME logical goal id. Plain data: no
 * handles, actions, tasks, leases or executable leg.
 *
 * Relation to the approved shared declaration (P `4409ba1`,
 * src/contracts/continuation.ts `RouteCarry`, "structural; L may refine field
 * names in locator.ts"): RouteLineage is a strict SUPERSET of that shape (every
 * approved field with a compatible type, plus the identity/provenance fields the
 * lineage rules need). It is named differently so the two `export *` lines of
 * contracts/index.ts never collide; the intended integration is
 * `export type RouteCarry = RouteLineage` in continuation.ts (P), so the
 * checkpoint stores exactly what exportCarry returns and admitContinuation takes.
 *
 * Invariants enforced by RouteController.admitContinuation:
 *   - same routeId and logical goalId; a FRESH goal epoch (> every admitted epoch);
 *   - exact original admission anchor/radius, connection epoch and dimension;
 *   - ORIGINAL frozen ceilings, including the ABSOLUTE route deadline;
 *   - every consumed leg, the cumulative distance with its sources (client
 *     physics, server corrections and their count), stalled-leg history and any
 *     blocker carried; new legs are numbered after `legsUsed`;
 *   - an active leg at export is finalized as interrupted (counted, never
 *     executable again);
 *   - exhausted, blocked or expired lineages get NO authority again;
 *   - only the LATEST export of a route is admissible, and only once.
 */
export interface RouteLineage {
  version: typeof ROUTE_LINEAGE_VERSION;
  routeId: RouteId;
  /** The logical goal id shared by every epoch of this owner job. */
  goalId: string;
  /** Goal epoch of the ORIGINAL grant. */
  originalGoalEpoch: number;
  /** Goal epoch whose route was exported (the interrupted epoch). */
  fromGoalEpoch: number;
  connectionEpoch: number;
  dimension: string;
  source: RouteGoalSource;
  /** Original grant time (never refreshed). */
  grantedAtMs: number;
  exportedAtMs: number;
  destinations: readonly RouteDestinationKind[];
  admissionAnchor: Vec3;
  admissionRadius: number;
  /** ORIGINAL frozen ceilings; `routeDeadlineMs` is absolute. */
  ceilings: Readonly<RouteCeilings>;
  /** Legs consumed by every epoch so far (an interrupted active leg included). */
  legsUsed: number;
  /** The index the next leg will get (always legsUsed + 1; numbering is monotonic across epochs). */
  nextLegIndex: number;
  lastLeg: { index: number; outcome: string; netProgress: number; displacement: number } | null;
  stalledLegs: number;
  /** Cumulative own movement with its sources; never reduced. */
  distance: RouteDistanceAccount;
  /** `authorized` (resumable) or a terminal state that stays terminal. */
  state: 'authorized' | 'exhausted' | 'blocked';
  blocker: { reason: RouteBlocker; detail: string } | null;
  /** Owner-typed coordinates recorded for this goal (owner_destination provenance). */
  ownerCoordinates: readonly RouteOwnerCoordinate[];
  /** The frozen own-incident identity, if bound (C3); a continuation never rebinds another. */
  boundOwnDeath: FrozenOwnIncident | null;
  /** Continuations already admitted in this lineage (the next one is count + 1). */
  continuations: number;
}

export const ROUTE_CONTINUATION_REFUSALS = [
  'unknown_or_stale_carry', // not this controller's latest export of that route, already admitted, or malformed
  'goal_mismatch', // a different logical goal id
  'stale_epoch', // not a fresh goal epoch
  'connection_mismatch',
  'dimension_mismatch',
  'anchor_mismatch', // not the exact original admission anchor/radius
  'source_mismatch',
] as const;
export type RouteContinuationRefusal = (typeof ROUTE_CONTINUATION_REFUSALS)[number];

export type RouteContinuationResult =
  /** Resumable lineage: a continuation authorization with the original ceilings and consumed history. */
  | { ok: true; authorization: RouteAuthorization; status: RouteStatus }
  /** Terminal lineage (exhausted/blocked/expired): recorded for truthful status, NO travel authority. */
  | { ok: false; kind: 'terminal'; blocker: RouteBlocker; detail: string; status: RouteStatus }
  /** Refused: nothing installed for this epoch; the admission bound alone applies. */
  | { ok: false; kind: 'refused'; reason: RouteContinuationRefusal; detail: string; status: null };

/**
 * Planner/proposal-check view of the goal's route context (proposed
 * PlannerRequest.route / ProposalContext.route). No coordinates: owner
 * destinations are validated against ownerCoordinates already shown.
 */
export interface RouteProposalContext {
  authorized: boolean;
  destinations: readonly RouteDestinationKind[];
  /** A code-owned own-death destination exists in the current dimension and the policy allows it. */
  ownDeathAvailable: boolean;
  state: RouteState | null;
}

// ---------------------------------------------------------------- ports

/** Coarse owner locator (src/locator/). Plain data only. */
export interface LocatorPort {
  /** The coarse owner hint for the CURRENT connection/dimension (never exact coordinates). */
  ownerHint(): LocatorHint;
  status(): LocatorStatus;
}

/**
 * Code-owned route legs (src/locator/routes.ts). The planner has no access to
 * this port; proposals cannot grant, extend or reset authorizations.
 */
export interface RoutePort {
  /** Synchronous admission hook: grants (or declines) a route authorization for a NEW goal epoch from operator policy. */
  admit(admission: RouteAdmission): RouteAuthorization | undefined;
  /** Owner coordinates from a correlated clarification answer (same goal epoch only). */
  noteOwnerCoordinates(goalEpoch: number, coordinates: readonly RouteOwnerCoordinate[]): void;
  /** Active (leg_active, unexpired, under the distance ceiling) leg bounds with full route context on an EXACT match, else undefined. */
  legBounds(ctx: { goalEpoch: number; connectionEpoch: number; dimension: string }): RouteLegBounds | undefined;
  /** The canonical travel bound for every movement poll (see EffectiveTravel). */
  effectiveTravel(admission: RouteAdmissionProof): EffectiveTravel;
  /** Proposal-validation/planner view (no coordinates). */
  proposalContext(ctx: { goalEpoch: number; connectionEpoch: number; dimension: string }): RouteProposalContext;
  /** Route progress for a goal epoch (status/observation); null when none. */
  status(goalEpoch?: number): RouteStatus | null;
  /** Goal end / replacement / lifecycle: the route can never steer again (never regranted). */
  revoke(reason: string, goalEpoch?: number): void;
  /**
   * C12: the lineage of the CURRENT (not yet revoked) route of a goal epoch, an
   * active leg finalized as interrupted. Pure: changes nothing. Undefined after
   * revocation, for another epoch, or without a route.
   */
  exportCarry(goalEpoch: number): RouteLineage | undefined;
  /** C12: exportCarry then revoke, atomically (the ordering the continuation contract requires). */
  revokeWithCarry(reason: string, goalEpoch: number): RouteLineage | undefined;
  /**
   * C12: the continuation admission of the SAME logical goal at a fresh epoch
   * (instead of `admit`). Synchronous, once per export.
   */
  admitContinuation(carry: RouteLineage, admission: RouteAdmission): RouteContinuationResult;
}

/**
 * Seam for a CODE-OWNED historical destination (e.g. the survival module's own
 * last death position, recorded from the bot's own server-confirmed state).
 * Not a planner coordinate, not another player's position. The route module
 * only routes toward it when the goal's authorization lists `own_death`, and
 * freezes the WHOLE identity (id, dimension, position, recorded time) at first
 * use; any later difference or absence stops the route (C3).
 */
export interface RouteDestinationProvider {
  readonly kind: 'own_death';
  current(ctx: { connectionEpoch: number; dimension: string; goalEpoch: number }): { destinationId: string; dimension: string; at: Vec3; recordedAtMs: number; label: string; provenance: 'own_incident' } | undefined;
}
