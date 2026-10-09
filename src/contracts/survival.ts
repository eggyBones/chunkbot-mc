// MB-FLOW-003 survival routines and death recovery contracts.
//
// Survival is a bounded, code-owned POLICY over fresh server-backed state. It
// never actuates, never calls a model and never owns a goal: it returns a
// bounded condition/decision to the single MB-FLOW-001 supervisor, which
// admits any work through the one GoalEngine admission path, the one catalog,
// the one task runtime, the one actuator lease and the one SpendLedger.
//
// Routine names below are SCHEDULING POLICIES (why support work is proposed),
// not a goal whitelist and not a task enum: the work itself is a generic
// planner goal or a generic TaskSpec over registered capabilities.
//
// Durable recovery state is scoped by the explicit operator world profile /
// revision / bot profile (the MB-MEM-001 MemoryScope). Death incidents
// themselves are MB-MEM-001 death facts; survival stores only its episode
// bookkeeping (attempt counters, accumulated budgets, hazards, blocker,
// interrupted directive) next to them. Nothing stored is executable: no
// handles, action ids, leases, epochs or old instructions are replayed.
//
// This file has no Minecraft library imports.
import { z } from 'zod';
import { BOUNDS, CapabilityIdSchema, DimensionSchema, RegistryKeySchema, Vec3Schema } from './common.ts';
import { MemoryFactIdSchema, MemoryScopeSchema, type MemoryScope } from './memory.ts';
import type { ObservationSnapshot } from './observation.ts';
import type { GameLifecycleEvent } from './ports.ts';
import type { RouteDestinationProvider } from './locator.ts';
import type { OutcomePredicate, PredicateEvaluation } from './predicate.ts';
import type { TaskMode, TaskSpec } from './task.ts';

/**
 * Durable store schema. v2 (MB-FLOW-003-C9/C10): a manifest item keeps its
 * ORIGINAL lost `count` immutable and records server-confirmed regains in a
 * separate `regained` counter (v1 decremented `count`, which reached 0 after a
 * whole-key pickup and made every later write fail schema validation);
 * episodes record incidental (not-attributed) inventory effects and attempts
 * whose effects became unknown. v1 files are read (checksum on the raw body)
 * and migrated by `migrateV1Body`: lost = v1 remaining + the episode's recorded
 * regains of that key, regained = those recorded regains, state derived;
 * nothing is invented. v3 (MB-FLOW-003-C12) adds display-only continuation
 * checkpoint records (v2 bodies read with none). A newer schema is read-only,
 * never overwritten.
 */
export const SURVIVAL_SCHEMA_VERSION = 3 as const;
export const SURVIVAL_READABLE_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3];
export const SURVIVAL_FILE_FORMAT = 'chunkbot-survival' as const;

const atMs = z.number().int().nonnegative();
const shortText = z.string().max(BOUNDS.shortText);
const itemCount = z.object({ key: RegistryKeySchema, count: z.number().int().positive() }).strict();

/** Hard bounds of durable/model-visible survival data (independent of config). */
export const SURVIVAL_BOUNDS = {
  /** Episodes kept per scope (open ones are never evicted). */
  episodes: 16,
  relatedIncidents: 8,
  attemptHistory: 4,
  /** Incidental (not recovery-attributed) inventory effects kept per episode. */
  incidental: 16,
  hazards: 8,
  regained: 32,
  manifestItems: BOUNDS.listMedium + 9,
  /** Serialized size of one planner-visible survival context (characters). */
  plannerContextChars: 2_000,
  /** Serialized size of the status projection (characters). */
  statusChars: 4_000,
  /** Absolute ceiling on recovery attempts per incident, whatever the config says. */
  maxAttemptsCeiling: 2,
} as const;

// ---------------------------------------------------------------- routines

/**
 * Scheduling policies. `death_recovery`: bounded return to an own death site.
 * `eat`: suitable owned safe food. `rest`: wait for verified natural
 * regeneration in place. `tool_upkeep`: equip suitable owned gear or replace a
 * nearly worn/unsuitable tool. `inventory_room`: deposit surplus into
 * designated, freshly inspected storage. `resupply`: restore a basic reserve
 * after it crossed its low threshold. `home_rest`: gated bed/spawn routine at
 * an approved Overworld home (R8; only after its mechanics gate).
 */
export const SURVIVAL_ROUTINES = ['death_recovery', 'eat', 'rest', 'tool_upkeep', 'inventory_room', 'resupply', 'home_rest'] as const;
export const SurvivalRoutineSchema = z.enum(SURVIVAL_ROUTINES);
export type SurvivalRoutine = z.infer<typeof SurvivalRoutineSchema>;

/**
 * Supervisor priority class of a survival decision. `safety`: immediate,
 * outranks owner intent (the owner's intent is RETAINED, never discarded).
 * `support`: precedes unrelated progression, follows active owner intent
 * unless that intent itself needs it (e.g. cannot continue without food).
 */
export const SURVIVAL_PRIORITIES = ['safety', 'support'] as const;
export type SurvivalPriority = (typeof SURVIVAL_PRIORITIES)[number];

/** C4: the only routines proposed while an interrupted owner directive awaits the owner. */
export const NECESSARY_ROUTINES = ['eat', 'rest', 'death_recovery'] as const satisfies readonly SurvivalRoutine[];

/** Routines whose code-built task may run under the narrow low-health allowance. */
export const LOW_HEALTH_ROUTINES = ['eat', 'rest'] as const satisfies readonly SurvivalRoutine[];

/** Gated later slices: never proposed by this release; shown honestly as pending. */
export const GATED_LATER_SLICES = ['lighting', 'replanting', 'emergency_escape', 'combat_defense'] as const;

// ---------------------------------------------------------------- config

const reserveSchema = z
  .object({
    /** Registry item key or tag (`#minecraft:...`), or the code-defined pseudo key `chunkbot:safe_food`. */
    key: z.string().regex(/^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(BOUNDS.shortText),
    low: z.number().int().min(0).max(256),
    high: z.number().int().min(1).max(256),
  })
  .strict()
  .refine((r) => r.high > r.low, 'reserve high must exceed low (hysteresis)');

/**
 * `survival` config block (proposed for ChunkbotConfig as
 * `survival: SurvivalConfigSchema.optional()`; the designated writer adds it).
 * Absent: survival policy disabled (manual goals unaffected). Every value is a
 * bounded coordinator default chosen from mechanics/fixture evidence; the
 * planner can never supply or change any of them.
 */
export const SurvivalConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    food: z
      .object({
        /** Eat when the server food level is at or below this (hysteresis low). */
        eatAtOrBelow: z.number().int().min(0).max(19).default(14),
        /** Stop proposing eating once food reaches this (hysteresis high). */
        eatUntil: z.number().int().min(1).max(20).default(18),
        /** Extra item keys never eaten automatically (in addition to the code risky/precious lists). */
        avoid: z.array(RegistryKeySchema).max(BOUNDS.listMedium).default([]),
      })
      .strict()
      .default({ eatAtOrBelow: 14, eatUntil: 18, avoid: [] }),
    health: z
      .object({
        /** Propose resting when health is at or below this and regeneration is possible. */
        restAtOrBelow: z.number().min(1).max(19).default(12),
        restUntil: z.number().min(2).max(20).default(18),
        /** A rest window with no server-confirmed health gain ends honestly (regeneration unavailable). */
        noRegenWindowMs: z.number().int().min(5_000).max(300_000).default(30_000),
        maxRestMs: z.number().int().min(10_000).max(600_000).default(120_000),
      })
      .strict()
      .default({ restAtOrBelow: 12, restUntil: 18, noRegenWindowMs: 30_000, maxRestMs: 120_000 }),
    lowHealthAllowance: z
      .object({
        /** Actions one allowance may execute (each through the fenced executor). */
        maxActions: z.number().int().min(1).max(8).default(4),
        ttlMs: z.number().int().min(5_000).max(300_000).default(90_000),
        /** Hostile/hazard keys within this distance (visible now) refuse the allowance. */
        threatRadius: z.number().min(1).max(32).default(8),
      })
      .strict()
      .default({ maxActions: 4, ttlMs: 90_000, threatRadius: 8 }),
    tools: z
      .object({
        /** A tool is nearly worn at or below this remaining fraction of max durability. */
        wornFraction: z.number().min(0).max(0.5).default(0.1),
        /** ... or at or below this many remaining uses, whichever is larger. */
        wornUses: z.number().int().min(0).max(256).default(8),
      })
      .strict()
      .default({ wornFraction: 0.1, wornUses: 8 }),
    inventory: z
      .object({
        /** Propose making room at or below this many free main-inventory slots. */
        minFreeSlots: z.number().int().min(0).max(35).default(2),
        /** Room to aim for (hysteresis high). */
        targetFreeSlots: z.number().int().min(1).max(36).default(6),
      })
      .strict()
      .default({ minFreeSlots: 2, targetFreeSlots: 6 }),
    resupply: z
      .object({
        reserves: z.array(reserveSchema).max(BOUNDS.listSmall).default([{ key: 'chunkbot:safe_food', low: 2, high: 6 }]),
        /** Minimum time between two resupply proposals for the same reserve. */
        cooldownMs: z.number().int().min(60_000).max(24 * 3_600_000).default(15 * 60_000),
      })
      .strict()
      .default({ reserves: [{ key: 'chunkbot:safe_food', low: 2, high: 6 }], cooldownMs: 15 * 60_000 }),
    recovery: z
      .object({
        /** Recovery attempts per incident (absolute ceiling 2). */
        maxAttempts: z.number().int().min(1).max(SURVIVAL_BOUNDS.maxAttemptsCeiling).default(2),
        /** Visible drops are recovery candidates only within this distance of the recorded site. */
        searchRadius: z.number().min(1).max(32).default(8),
        /** Accepted arrival distance at the death site. */
        arrivalWithin: z.number().min(1).max(16).default(4),
        /** A death within this distance of the site with the same cause is the SAME unresolved hazard. */
        sameHazardRadius: z.number().min(1).max(64).default(8),
        /** Accumulated ceilings for one recovery episode across every admission (<= goal limits). */
        episodePlannerTurns: z.number().int().min(1).max(40).default(12),
        episodeTasks: z.number().int().min(1).max(128).default(24),
        episodeReplans: z.number().int().min(0).max(16).default(4),
        episodeDeadlineMs: z.number().int().min(60_000).max(3 * 3_600_000).default(30 * 60_000),
      })
      .strict()
      .default({ maxAttempts: 2, searchRadius: 8, arrivalWithin: 4, sameHazardRadius: 8, episodePlannerTurns: 12, episodeTasks: 24, episodeReplans: 4, episodeDeadlineMs: 30 * 60_000 }),
    /** A blocked routine is not proposed again for this long unless its condition materially changes. */
    blockedCooldownMs: z.number().int().min(60_000).max(24 * 3_600_000).default(15 * 60_000),
    /** Automatic support admissions per rolling hour (all routines). */
    admissionsPerHour: z.number().int().min(1).max(60).default(12),
    /** Durable episode store directory under storage.dataDir. */
    dir: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).default('survival'),
  })
  .strict();
export type SurvivalConfig = z.output<typeof SurvivalConfigSchema>;
export type SurvivalConfigInput = z.input<typeof SurvivalConfigSchema>;

// ---------------------------------------------------------------- items and metadata

/**
 * Item metadata as far as the SERVER stated it in a slot packet. A stack's
 * components are sent as a patch against the item's defaults: an absent
 * `damage` patch on a known-damageable item means damage 0 only when the slot
 * packet itself was seen (`metadata: 'server_slot'`). `unknown` means no slot
 * packet with components was seen for this stack (e.g. client-model seed).
 */
export const ItemMetadataSchema = z
  .object({
    metadata: z.enum(['server_slot', 'unknown']),
    /** Max durability (registry default or `max_damage` patch); absent for non-damageable items. */
    maxDurability: z.number().int().positive().optional(),
    damage: z.number().int().nonnegative().optional(),
    enchanted: z.boolean().optional(),
    customName: z.boolean().optional(),
    /**
     * sha256 (16 hex) over the identity-relevant server component patch
     * (damage, max_damage, enchantments, stored_enchantments, custom_name,
     * trim, unbreakable). Present only for `server_slot` metadata. Two stacks
     * of one key with different digests are different items.
     */
    digest: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  })
  .strict();
export type ItemMetadata = z.infer<typeof ItemMetadataSchema>;

export const TrackedStackSchema = z
  .object({
    /** Player-inventory window-0 slot number (5..45). */
    slot: z.number().int().min(0).max(45),
    key: RegistryKeySchema,
    count: z.number().int().positive(),
    meta: ItemMetadataSchema,
  })
  .strict();
export type TrackedStack = z.infer<typeof TrackedStackSchema>;

/**
 * The bot's own inventory as stated by the server. `server_packets`: built
 * only from server window_items/set_slot packets since the connection's
 * initial full sync. `ready_seed`: seeded from the library model at ready
 * before any client click (server-fed, but labeled). `unavailable`.
 */
export const InventoryFactsSchema = z
  .object({
    source: z.enum(['server_packets', 'ready_seed', 'unavailable']),
    connectionEpoch: z.number().int().nonnegative(),
    /** Time of the last server inventory packet applied. */
    atMs: atMs,
    stacks: z.array(TrackedStackSchema).max(46),
    /** True once a full window-0 sync was received on this connection/life. */
    fullSync: z.boolean(),
    /** Selected hotbar slot (0..8) when the server stated it, else the client value. */
    heldHotbar: z.number().int().min(0).max(8).optional(),
  })
  .strict();
export type InventoryFacts = z.infer<typeof InventoryFactsSchema>;

/** Fresh server vitals (update_health). Saturation is server-stated; regeneration rules stay version mechanics. */
export const VitalsSchema = z
  .object({
    health: z.number().min(0).max(1_024),
    food: z.number().int().min(0).max(20),
    saturation: z.number().min(0).max(20),
    atMs: atMs,
    connectionEpoch: z.number().int().nonnegative(),
  })
  .strict();
export type Vitals = z.infer<typeof VitalsSchema>;

// ---------------------------------------------------------------- death incident evidence

/**
 * How the death site is known. `server_death_location`: the respawn
 * SpawnInfo's own last-death GlobalPos (block precision, dimension included).
 * `client_position_at_death_event`: client physics at the death packet (an
 * estimate). `last_observation`: the last filtered snapshot (aged).
 */
export const DEATH_SITE_SOURCES = ['server_death_location', 'client_position_at_death_event', 'last_observation', 'unknown'] as const;
export type DeathSiteSource = (typeof DEATH_SITE_SOURCES)[number];

export const DeathSiteSchema = z
  .object({
    source: z.enum(DEATH_SITE_SOURCES),
    dimension: DimensionSchema.optional(),
    at: Vec3Schema.optional(),
    observedAtMs: atMs.optional(),
    /** The client estimate, kept when a server location refined it (distance between them). */
    clientEstimateOffBy: z.number().nonnegative().optional(),
  })
  .strict();
export type DeathSite = z.infer<typeof DeathSiteSchema>;

/**
 * Cause as stated by the server death message (translation key only; player
 * names and free text are never stored). `unknown` when no own combat-kill
 * packet arrived or its message was empty (e.g. death messages disabled).
 */
export const DeathCauseSchema = z
  .object({
    kind: z.enum(['server_message', 'unknown']),
    /** e.g. `death.attack.lava`, `death.fell.accident.generic`, `death.attack.outOfWorld`. */
    translationKey: z.string().regex(/^[a-zA-Z0-9_.]{1,80}$/).optional(),
    /** Code classification of the key (hazard family), never model text. */
    hazard: z.enum(['lava', 'fire', 'fall', 'drowning', 'void', 'suffocation', 'starvation', 'explosion', 'mob', 'player', 'magic', 'freeze', 'command', 'other', 'unknown']),
  })
  .strict();
export type DeathCause = z.infer<typeof DeathCauseSchema>;

/**
 * The last-alive inventory frozen BEFORE the death-time inventory clearing
 * reaches the client. `frozen_at`: which signal froze it (own combat-kill
 * packet first; else the first zero-health update; else the death event).
 */
export const LastAliveSchema = z
  .object({
    source: z.enum(['server_packets', 'ready_seed', 'unavailable']),
    frozenAt: z.enum(['combat_kill_packet', 'zero_health_packet', 'death_event', 'none']),
    capturedAtMs: atMs.optional(),
    /** Age of the newest inventory packet applied at freezing time. */
    ageMsAtDeath: z.number().int().nonnegative().optional(),
    stacks: z.array(TrackedStackSchema).max(46),
    /** Inventory packets that arrived between the kill signal and the death event (the clearing). */
    clearingPacketsAfterFreeze: z.number().int().nonnegative(),
  })
  .strict();
export type LastAlive = z.infer<typeof LastAliveSchema>;

/** One captured own death (in-process record; durable copy is the memory death fact + episode). */
export interface CapturedDeath {
  captureId: string;
  connectionEpoch: number;
  occurredAtMs: number;
  site: DeathSite;
  cause: DeathCause;
  lastAlive: LastAlive;
  /** Memory death fact id once memory recorded it (undefined: memory disabled/not writable). */
  incidentFactId?: string;
}

// ---------------------------------------------------------------- recovery episode (durable)

/**
 * Distinct recovery outcomes. `pending`: not concluded. `no_loss`: the fresh
 * respawn inventory retained everything (no trip). `recovered`: every missing
 * item regained (server-confirmed pickups). `partially_recovered`.
 * `blocked`: a known prerequisite/route/hazard/budget/scope prevents it.
 * `known_destroyed`: reserved for ACTUAL server evidence that the items are
 * gone. This release has no such evidence source, so it never sets it; cause
 * mechanics (lava, void) only mark items `likely_destroyed` and the episode
 * `blocked` (C1: never upgraded without evidence).
 * `unknown`: bounded search ended without finding them; NOT proof of despawn.
 * `abandoned`: the owner redirected or dismissed it.
 */
export const RECOVERY_STATUSES = ['pending', 'no_loss', 'recovered', 'partially_recovered', 'blocked', 'known_destroyed', 'unknown', 'abandoned'] as const;
export const RecoveryStatusSchema = z.enum(RECOVERY_STATUSES);
export type RecoveryStatus = z.infer<typeof RecoveryStatusSchema>;

export const RECOVERY_PHASES = ['awaiting_respawn', 'assessing', 'ready', 'preparing', 'traveling', 'collecting', 'concluded'] as const;
export const RecoveryPhaseSchema = z.enum(RECOVERY_PHASES);
export type RecoveryPhase = z.infer<typeof RecoveryPhaseSchema>;

/**
 * Per-item loss state (C10: distinct, never merged into one "recovered" label).
 * `missing`: lost, nothing regained yet, still sought. `partially_regained`:
 * some regained by server-confirmed pickups, the rest still sought.
 * `regained`: every lost unit regained. `likely_destroyed`: cause mechanics
 * suggest destruction (unverified). `unknown`: the bounded search/episode ended
 * with the remainder unaccounted for — NOT proof of despawn or destruction.
 * Possessions kept through respawn never appear here (`LossManifest.retained`).
 */
export const MANIFEST_ITEM_STATES = ['missing', 'partially_regained', 'regained', 'likely_destroyed', 'unknown'] as const;

export const ManifestItemSchema = z
  .object({
    key: RegistryKeySchema,
    /** ORIGINAL lost count (last-alive minus fresh respawn sync). Immutable after assessment except related-death additions. */
    count: z.number().int().positive(),
    /** Server-confirmed regained units of this incident (never above `count`). */
    regained: z.number().int().nonnegative().default(0),
    /** Tools/armor/enchanted/named items or configured valuables. */
    valuable: z.boolean(),
    metadata: z.enum(['server_slot', 'unknown']),
    state: z.enum(MANIFEST_ITEM_STATES),
    /**
     * Valuable items only (C3): the server identity digest of each still-missing
     * stack, one entry per stack. A valuable drop counts only when its server
     * digest equals one of these; absent (metadata unknown) -> identity unproven,
     * never collected or counted as this item.
     */
    identities: z.array(z.object({ digest: z.string().regex(/^[0-9a-f]{16}$/), count: z.number().int().positive() }).strict()).max(8).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    // State/count consistency (C9 coordinator review): the label must agree with the counters.
    const bad = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
    if (m.regained > m.count) return bad('regained exceeds the lost count', 'regained');
    switch (m.state) {
      case 'missing':
        if (m.regained !== 0) bad('a missing item cannot have regained units (use partially_regained)', 'state');
        break;
      case 'partially_regained':
        if (m.regained === 0 || m.regained >= m.count) bad('partially_regained needs 0 < regained < lost count', 'state');
        break;
      case 'regained':
        if (m.regained !== m.count) bad('regained needs every lost unit regained (a partial regain is not complete)', 'state');
        break;
      default:
        // likely_destroyed / unknown: some remainder is unaccounted for.
        if (m.regained >= m.count) bad(`${m.state} needs a remainder (a fully regained item is regained)`, 'state');
    }
  });
export type ManifestItem = z.infer<typeof ManifestItemSchema>;

/** Units of a manifest item still unaccounted for (lost minus server-confirmed regains). */
export function manifestRemaining(m: Pick<ManifestItem, 'count' | 'regained'>): number {
  return Math.max(0, m.count - (m.regained ?? 0));
}

/** A manifest item is still SOUGHT by recovery (never `likely_destroyed`/`unknown`/`regained`). */
export function manifestSought(m: Pick<ManifestItem, 'count' | 'regained' | 'state'>): boolean {
  return (m.state === 'missing' || m.state === 'partially_regained') && manifestRemaining(m) > 0;
}

/**
 * C10: an inventory effect that is NOT attributed to this incident's recovery
 * (reported truthfully, never counted as regained or retained).
 * `after_respawn_sync`: gained after the fresh respawn window sync and before
 * any recovery action (e.g. passive pickup at the respawn point).
 * `unplanned_collect`: a server collect packet (collector = bot) of an item
 * entity outside the frozen recovery plan, during recovery travel or pickup.
 * `key` is absent when the server never stated that entity's stack.
 */
export const IncidentalEffectSchema = z
  .object({
    source: z.enum(['after_respawn_sync', 'unplanned_collect']),
    key: RegistryKeySchema.optional(),
    count: z.number().int().positive(),
    atMs,
    /** Recovery goal during which it happened (absent before any attempt). */
    goalId: z.string().regex(/^goal-[a-z0-9]{4,32}$/).optional(),
    detail: shortText,
  })
  .strict();
export type IncidentalEffect = z.infer<typeof IncidentalEffectSchema>;

/** Identity check of one drop against the manifest (C3). */
export type DropIdentity = 'not_required' | 'match' | 'mismatch' | 'unproven';

/** Server-stated facts of one dropped item entity (from its own metadata packet; never a display label). */
export interface DropStackFacts {
  entityId: number;
  /** Tracker-local server spawn incarnation; a reused entity id never reuses a frozen pickup claim. */
  incarnation: number;
  key: string;
  count: number;
  meta: ItemMetadata;
  atMs: number;
}

export const LossManifestSchema = z
  .object({
    assessedAtMs: atMs,
    /** Fresh post-respawn inventory used for the comparison. */
    freshInventorySource: z.enum(['server_packets', 'unavailable']),
    lastAliveSource: z.enum(['server_packets', 'ready_seed', 'unavailable']),
    missing: z.array(ManifestItemSchema).max(SURVIVAL_BOUNDS.manifestItems),
    retained: z.array(itemCount).max(SURVIVAL_BOUNDS.manifestItems),
    /** True when the pre-death record was missing/partial: the manifest is explicitly partial. */
    partial: z.boolean(),
    detail: shortText,
  })
  .strict();
export type LossManifest = z.infer<typeof LossManifestSchema>;

/**
 * Bounded code summary of what an attempt carried and how it travelled, used
 * to decide whether another attempt is MATERIALLY improved.
 */
export const PreparationSignatureSchema = z
  .object({
    armorPoints: z.number().int().min(0).max(40),
    foodItems: z.number().int().min(0).max(4_096),
    health: z.number().min(0).max(1_024),
    /** Fire-resistance relevant gear or effect evidence (unknown counts as false). */
    fireProtection: z.boolean(),
    startAt: Vec3Schema.optional(),
    startDimension: DimensionSchema.optional(),
    /** Route policy identity (e.g. `local`, or a locator route-leg policy id). */
    routePolicy: z.string().regex(/^[a-z0-9_.:-]{1,48}$/),
  })
  .strict();
export type PreparationSignature = z.infer<typeof PreparationSignatureSchema>;

export const RecoveryAttemptSchema = z
  .object({
    attempt: z.number().int().min(1).max(SURVIVAL_BOUNDS.maxAttemptsCeiling),
    goalId: z.string().regex(/^goal-[a-z0-9]{4,32}$/).optional(),
    startedAtMs: atMs,
    endedAtMs: atMs.optional(),
    /** Terminal reason code of the support goal, or `death` / `restart_interrupted`. */
    outcome: z.string().regex(/^[a-z_]{1,48}$/).optional(),
    preparation: PreparationSignatureSchema,
    regained: z.number().int().nonnegative().default(0),
    /** The bot reached the site and the bounded visible search ended (nothing scoped remained visible). */
    searchedSite: z.boolean().default(false),
    /**
     * C9: this attempt may have changed the inventory after the last durable
     * revision (the process ended while it ran, so its last pickups may never
     * have been saved). Such effects are UNKNOWN, never assumed regained or
     * missing; status says so.
     */
    effectsUnknown: z.boolean().default(false),
  })
  .strict();
export type RecoveryAttempt = z.infer<typeof RecoveryAttemptSchema>;

export const HazardRecordSchema = z
  .object({
    hazard: DeathCauseSchema.shape.hazard,
    translationKey: z.string().regex(/^[a-zA-Z0-9_.]{1,80}$/).optional(),
    dimension: DimensionSchema.optional(),
    at: Vec3Schema.optional(),
    atMs,
    /** Incident fact of the death that revealed it (historical label). */
    incidentFactId: MemoryFactIdSchema.optional(),
  })
  .strict();
export type HazardRecord = z.infer<typeof HazardRecordSchema>;

/** Accumulated work of one episode across every admission (death/restart/subgoal never resets it). */
export const EpisodeBudgetSchema = z
  .object({
    plannerTurns: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
    replans: z.number().int().nonnegative(),
    admissions: z.number().int().nonnegative(),
    /** Elapsed active recovery time (sum of admitted goal durations). */
    activeMs: z.number().int().nonnegative(),
  })
  .strict();
export type EpisodeBudget = z.infer<typeof EpisodeBudgetSchema>;

export const BlockerSchema = z
  .object({
    reason: z.string().regex(/^[a-z_]{1,48}$/),
    detail: shortText,
    atMs,
    /** Condition signature that must change before the routine is reconsidered. */
    signature: z.string().max(200),
  })
  .strict();
export type Blocker = z.infer<typeof BlockerSchema>;

export const EpisodeIdSchema = z.string().regex(/^rep-[a-z0-9]{4,24}$/);
export type EpisodeId = z.infer<typeof EpisodeIdSchema>;

// ---------------------------------------------------------------- interrupted owner directive

/**
 * An owner directive that ended because of a lifecycle/safety interruption
 * (C1 first-release decision). It stays VISIBLE and requires an owner
 * decision: it is never replayed, never resubmitted with a new baseline and
 * never silently dropped. Actual continuation would need the preserved
 * original outcome, baseline, counters, deadline and fenced references, which
 * this release does not provide; an outcome's shape alone (e.g. inventory
 * only) is NOT evidence of compatibility. A bare `resume` only clears the stop
 * latch and does not dismiss it; a new explicit owner instruction supersedes
 * it. Support/recovery may address the interruption meanwhile; unrelated
 * progression waits.
 */
export const InterruptedDirectiveSchema = z
  .object({
    goalId: z.string().regex(/^goal-[a-z0-9]{4,32}$/),
    /** Owner's words (bounded). Display only; never resubmitted automatically. */
    instruction: z.string().max(BOUNDS.text),
    interpretation: z.string().max(BOUNDS.text).optional(),
    /** Bounded rendering of the accepted immutable outcome contract. */
    outcome: z.string().max(BOUNDS.text).optional(),
    outcomeKind: z.enum(['finite', 'persistent', 'none']),
    /** Original admission baseline (server-confirmed counts or null when unknown). */
    baseline: z.object({ capturedAtMs: atMs, counts: z.record(RegistryKeySchema, z.number().int().nonnegative()).nullable() }).strict().optional(),
    /** Confirmed effects reported before the interruption (bounded summaries). */
    confirmedProgress: z.string().max(BOUNDS.text),
    interruptedAtMs: atMs,
    reason: z.string().regex(/^[a-z_]{1,48}$/),
    /** First release: always `requires_owner_decision` (no automatic continuation exists). */
    continuation: z.literal('requires_owner_decision'),
    continuationDetail: shortText,
    /** `awaiting_owner` until a new explicit owner instruction supersedes it (or the owner dismisses it explicitly). */
    state: z.enum(['awaiting_owner', 'superseded_by_owner', 'dismissed_by_owner']),
    stateAtMs: atMs,
  })
  .strict();
export type InterruptedDirective = z.infer<typeof InterruptedDirectiveSchema>;

export const RecoveryEpisodeSchema = z
  .object({
    episodeId: EpisodeIdSchema,
    /** Memory death fact of this incident (absent when memory could not record it: episode stays blocked). */
    incidentFactId: MemoryFactIdSchema.optional(),
    /** The ORIGINAL incident whose valuables are being recovered (a recovery death never replaces it). */
    originalIncidentFactId: MemoryFactIdSchema.optional(),
    relatedIncidentFactIds: z.array(MemoryFactIdSchema).max(SURVIVAL_BOUNDS.relatedIncidents),
    openedAtMs: atMs,
    updatedAtMs: atMs,
    occurredAtMs: atMs,
    phase: RecoveryPhaseSchema,
    status: RecoveryStatusSchema,
    site: DeathSiteSchema,
    cause: DeathCauseSchema,
    lastAlive: LastAliveSchema,
    manifest: LossManifestSchema.optional(),
    regained: z.array(z.object({ key: RegistryKeySchema, count: z.number().int().positive(), atMs, provenance: z.enum(['scoped_visible_drop', 'server_attributed_collect']) }).strict()).max(SURVIVAL_BOUNDS.regained),
    /** C10: inventory effects NOT attributed to recovery (bounded, newest kept). */
    incidental: z.array(IncidentalEffectSchema).max(SURVIVAL_BOUNDS.incidental).default([]),
    attempts: z.array(RecoveryAttemptSchema).max(SURVIVAL_BOUNDS.attemptHistory),
    maxAttempts: z.number().int().min(1).max(SURVIVAL_BOUNDS.maxAttemptsCeiling),
    budget: EpisodeBudgetSchema,
    hazards: z.array(HazardRecordSchema).max(SURVIVAL_BOUNDS.hazards),
    blocker: BlockerSchema.optional(),
    /** The owner directive this death interrupted (if any). */
    interrupted: InterruptedDirectiveSchema.optional(),
    detail: shortText.default(''),
  })
  .strict();
export type RecoveryEpisode = z.infer<typeof RecoveryEpisodeSchema>;

/**
 * MB-FLOW-003-C12: DISPLAY-ONLY projection of a held continuation checkpoint
 * (src/contracts/continuation.ts). Deliberately not the executable checkpoint:
 * no outcome contract, lineage, route carry, epochs or handles are stored, so a
 * restart can only show it (`restart_held`), never continue it.
 */
export const CHECKPOINT_RECORD_STATES = ['capturing', 'held', 'continuing', 'completed', 'superseded_by_owner', 'stopped_by_owner', 'blocked', 'restart_held'] as const;
export const CheckpointRecordSchema = z
  .object({
    goalId: z.string().regex(/^goal-[a-z0-9]{4,32}$/),
    sessionId: z.string().min(1).max(64),
    instruction: z.string().max(BOUNDS.text),
    publicOutcome: z.string().max(BOUNDS.text),
    state: z.enum(CHECKPOINT_RECORD_STATES),
    stateReason: shortText,
    stateAtMs: atMs,
    deadlineAtMs: atMs,
    continuations: z.object({ used: z.number().int().nonnegative(), max: z.number().int().nonnegative() }).strict(),
    interruptions: z.array(z.object({ reason: z.string().regex(/^[a-z_]{1,48}$/), atMs }).strict()).max(8),
    counters: z.object({ plannerTurns: z.number().int().nonnegative(), tasksAdmitted: z.number().int().nonnegative(), replans: z.number().int().nonnegative() }).strict(),
    savedAtMs: atMs,
  })
  .strict();
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;

export const SurvivalStoreBodySchema = z
  .object({
    scope: MemoryScopeSchema,
    createdAtMs: atMs,
    episodes: z.array(RecoveryEpisodeSchema).max(SURVIVAL_BOUNDS.episodes),
    /** Interrupted owner directives not tied to a death (e.g. low-health safety stop). */
    interrupted: z.array(InterruptedDirectiveSchema).max(4),
    nextEpisode: z.number().int().positive(),
    evicted: z.number().int().nonnegative(),
    /** C12 display-only checkpoint projections (newest kept). */
    checkpoints: z.array(CheckpointRecordSchema).max(4).default([]),
  })
  .strict();
export type SurvivalStoreBody = z.infer<typeof SurvivalStoreBodySchema>;

export const SurvivalStoreFileSchema = z
  .object({
    format: z.literal(SURVIVAL_FILE_FORMAT),
    /** v1 is read and migrated (see SURVIVAL_SCHEMA_VERSION); every new write is v2. */
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(SURVIVAL_SCHEMA_VERSION)]),
    revision: z.number().int().positive(),
    writtenAtMs: atMs,
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    body: SurvivalStoreBodySchema,
  })
  .strict();
export type SurvivalStoreFile = z.infer<typeof SurvivalStoreFileSchema>;

/** `ready`/`empty`: writable. `read_only`: newer schema/corrupt/locked. `unscoped`: no operator scope configured. */
export const SURVIVAL_STORE_STATES = ['unscoped', 'empty', 'ready', 'recovered', 'read_only', 'disabled'] as const;
export type SurvivalStoreState = (typeof SURVIVAL_STORE_STATES)[number];

// ---------------------------------------------------------------- policy input / decision (supervisor port)

/** What currently owns control, as the supervisor knows it (plain data). */
export interface ActiveWorkFacts {
  kind: 'none' | 'owner_goal' | 'support' | 'progression' | 'diagnostic';
  goalId?: string;
  goalEpoch?: number;
  /** Survival routine of an admitted support goal. */
  routine?: SurvivalRoutine;
  /** Capabilities of the task currently running (to judge whether it is unsafe now). */
  runningCapabilities?: readonly string[];
}

/** Fresh state for one policy evaluation. Never a raw world object. */
export interface SurvivalAssessmentInput {
  nowMs: number;
  connection: { ready: boolean; connectionEpoch: number; dimension: string } | null;
  /** Fresh filtered snapshot of this connection (or null). */
  snapshot: ObservationSnapshot | null;
  /** Owner pause latch (stop until explicit resume): no automatic proposal while false. */
  autonomyAllowed: boolean;
  active: ActiveWorkFacts;
  /**
   * MB-FLOW-003-C4 canonical semantics. LIVE owner intake only: a new owner
   * instruction being prepared/handed off, or an owner question awaiting the
   * owner's answer. Survival yields to it (only `revoke_unsafe` still applies).
   * An already interrupted, retained directive is NOT intake; pass it as
   * `ownerIntentInterrupted` instead.
   */
  ownerIntakePending: boolean;
  /**
   * A retained interrupted owner directive awaits the owner's decision (its
   * accepted outcome/baseline stay held; nothing is replayed). Survival then
   * proposes only NECESSARY support (eat, rest, death recovery) serving
   * `owner_intent`; other upkeep and all unrelated progression wait. Survival
   * also ORs in its own DURABLE record (`interruptedOwnerIntent()`), so a
   * process restart cannot drop it. Bare `resume` never clears it.
   */
  ownerIntentInterrupted: boolean;
  /** Remaining goal-level limits the supervisor would grant a support goal (ceilings never exceed these). */
  goalLimits: { plannerTurns: number; tasks: number; replans: number; deadlineMs: number };
}

/** Code-owned planner context for a support goal (bounded, plain data, no hidden geometry). */
export interface SurvivalPlannerContext {
  routine: SurvivalRoutine;
  /** Code-written facts, e.g. missing items, site distance band, attempt n of m. */
  facts: string[];
  /** Capabilities this routine expects to need (advisory; the catalog is unchanged). */
  suggestedCapabilities: string[];
  /** Hard rules restated as data (no sweeping, no valuables dumping, no exact despawn promise...). */
  rules: string[];
}

/** How the supervisor should run the support work through the single admission path. */
export type SurvivalExecution =
  /** A natural-language goal for the gameplay planner (prerequisites chosen by the planner). */
  | { kind: 'planner_goal'; instruction: string; context: SurvivalPlannerContext }
  /**
   * A small preapproved code-built task (eat/rest): same task runtime, Jev
   * choice, executor and lease; no planner turn. `completion` is the proposed
   * `survival_state` predicate; the writer composes `{ ...spec, completion }`
   * once that predicate is in the shared union.
   */
  | { kind: 'code_task'; spec: Omit<TaskSpec, 'completion'>; completion: SurvivalStatePredicate | OutcomePredicate; mode: TaskMode; objective: string };

export interface SurvivalProposal {
  proposalId: string;
  routine: SurvivalRoutine;
  priority: SurvivalPriority;
  reason: string;
  /** Condition signature: an unchanged signature after a block/cooldown is never re-proposed. */
  signature: string;
  execution: SurvivalExecution;
  episodeId?: EpisodeId;
  /** What the routine serves (canonical autonomy GoalSource `support.serves`). */
  serves: 'owner_intent' | 'progression' | 'none';
  /** Ceilings for THIS admission (<= remaining episode budget and <= goal limits). */
  ceilings: { plannerTurns: number; tasks: number; replans: number; deadlineMs: number };
  /** Narrow low-health allowance the supervisor must attach to the admitted code task (eat/rest only). */
  lowHealthAllowance?: LowHealthAllowanceRequest;
  /** The supervisor discards a proposal it did not admit by this time (fresh assessment instead). */
  expiresAtMs: number;
}

export type SurvivalDecision =
  /** Nothing to do now (healthy, cooled down, or paused). */
  | { kind: 'none'; reason: string }
  /** Immediate safety: the running work is unsafe now; revoke it (owner intent retained), then reassess. */
  | { kind: 'revoke_unsafe'; reason: string; detail: string; retainOwnerIntent: boolean }
  /** Propose bounded support work through the single admission path. */
  | { kind: 'propose'; proposal: SurvivalProposal }
  /** Honest wait: a routine is needed but blocked (no inference, no polling until the signature changes). */
  | { kind: 'blocked'; routine: SurvivalRoutine; reason: string; detail: string; signature: string; retryAfterMs?: number };

// ---------------------------------------------------------------- low-health allowance (task runtime seam)

/** What a proposal asks the supervisor to attach to its admitted code task. */
export interface LowHealthAllowanceRequest {
  routine: (typeof LOW_HEALTH_ROUTINES)[number];
  capabilities: readonly string[];
  /** Food keys the allowance may consume (eat only). */
  items: readonly string[];
  maxActions: number;
  ttlMs: number;
}

/**
 * A granted allowance (issued once by survival at support admission). Bound
 * to ONE goal id/epoch, connection epoch and dimension, the admitted support
 * task (bound at its first check; any other task id is refused), and the
 * exact capabilities/items of the proposal. Fixed expiry and a fixed maximum
 * of consumed actions: there is no renewal; a second grant for the same goal
 * epoch is refused, so counts and expiry can never be reset or extended.
 */
export interface LowHealthAllowanceGrant {
  readonly allowanceId: string;
  readonly goalId: string;
  readonly goalEpoch: number;
  readonly connectionEpoch: number;
  readonly dimension: string;
  /** Support task bound at the first check (null until then). */
  taskId: string | null;
  readonly routine: (typeof LOW_HEALTH_ROUTINES)[number];
  readonly capabilities: readonly string[];
  readonly items: readonly string[];
  readonly maxActions: number;
  actionsUsed: number;
  readonly grantedAtMs: number;
  readonly expiresAtMs: number;
  revoked?: string;
}

export type LowHealthCheck =
  | { allowed: true; allowanceId: string; capabilities: readonly string[]; items: readonly string[]; detail: string; /** Actions left AFTER this result (reserve: after counting this one). */ remainingActions?: number }
  | { allowed: false; reason: string; detail: string };

/** The task identity every allowance call carries (the runtime's admitted task). */
export interface AllowanceTaskRef {
  goalId: string;
  goalEpoch: number;
  taskId: string;
  connectionEpoch: number;
  allowedCapabilities: readonly string[];
}

/**
 * TaskRuntime seam (C1-approved shape). At the low-health guard the runtime
 * calls `check`; only an allowed result lets the round continue, and then ONLY
 * with candidates whose capability is in `capabilities` and whose item
 * parameter (if any) is in `items`. After the Jev choice and its fresh
 * revalidation, and BEFORE execution, the runtime calls `recheck` with the
 * chosen candidate and the fresh snapshot (ownership, connection/dimension,
 * expiry, remaining actions, health/food, visible threat, item still owned);
 * a refusal executes nothing. `reserve` must precede EVERY dispatch (Jev and
 * sustained local continuation) and counts before execution. The executor's lease/epoch fencing still
 * applies. Without the port, or on refusal, the guard blocks `low_health` as
 * today. There is no generic restore/escape exception and no global disable.
 */
export interface LowHealthAllowancePort {
  check(task: AllowanceTaskRef, snapshot: ObservationSnapshot): LowHealthCheck;
  /** Pure post-choice recheck (no accounting). */
  recheck(allowanceId: string, task: AllowanceTaskRef, candidate: { id?: string; capability: string; parameters: Readonly<Record<string, unknown>> }, snapshot: ObservationSnapshot): LowHealthCheck;
  /**
   * Conservative accounting (C2): call immediately BEFORE EVERY dispatch under
   * the allowance — a Jev-chosen action AND every sustained local
   * continuation. It rechecks and, only when allowed, counts the action
   * before it runs, so an abort, exception or missing outcome still consumed
   * it. The last allowed action leaves zero; further windows are refused.
   */
  reserve(allowanceId: string, task: AllowanceTaskRef, candidate: { id: string; capability: string; parameters: Readonly<Record<string, unknown>> }, snapshot: ObservationSnapshot): LowHealthCheck;
  /** Outcome note after a dispatch. A reserved action is never counted twice; an unreserved one is counted conservatively. Never extends anything. */
  consumed(allowanceId: string, outcome: { actionId: string; capability: string; status: string }): void;
}

// ---------------------------------------------------------------- survival predicate (predicate seam)

/**
 * Proposed atomic predicate: a survival condition evaluated by CODE from fresh
 * server evidence and the durable episode, fenced to the owning support goal.
 *
 * `death_recovery`:
 *   - `recovered`: satisfied ONLY when nothing is still sought: every missing
 *     item was regained through server-confirmed pickups, or the respawn
 *     inventory retained everything (`no_loss`).
 *   - `concluded`: satisfied when the bounded episode ENDED in any way
 *     (recovered, partially recovered after the bounded visible search,
 *     unknown, blocked). Its evidence carries `recoveryStatus`; a concluded
 *     label alone never implies that all loot was recovered.
 * `eat`/`rest`/`tool_upkeep`/`inventory_room`/`resupply` use `satisfied`:
 * fresh server food/health/inventory reached the routine's high threshold.
 * Any other routine/expect pairing evaluates `unknown`.
 */
export const SurvivalStatePredicateSchema = z
  .object({
    predicate: z.literal('survival_state'),
    routine: SurvivalRoutineSchema,
    expect: z.enum(['recovered', 'concluded', 'satisfied']),
  })
  .strict();
export type SurvivalStatePredicate = z.infer<typeof SurvivalStatePredicateSchema>;

export type SurvivalStateEvaluation = Omit<PredicateEvaluation, 'predicate' | 'children'> & { predicate: 'survival_state' };

export interface SurvivalPredicatePort {
  evaluateSurvivalState(predicate: SurvivalStatePredicate, owner: { goalId: string; goalEpoch: number } | undefined): SurvivalStateEvaluation;
}

// ---------------------------------------------------------------- lifecycle / packet hooks (C1-approved order)

/** EventEmitter-like raw protocol packet source (the bot's protocol client). */
export interface SurvivalPacketSource {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

/** MB-MEM-001 DeathContext shape for the SAME frozen capture, plus its capture id. */
export interface SurvivalDeathContext {
  captureId?: string;
  dimension?: string;
  position?: { x: number; y: number; z: number };
  accuracy: 'client_position_at_death_event' | 'last_observation' | 'unknown';
  positionAgeMs?: number;
  inventory: { source: 'server_sync' | 'client_model' | 'unavailable'; capturedAtMs?: number; items: Array<{ key: string; count: number }> };
  cause?: { kind: 'observed'; detail: string };
}

/**
 * Lifecycle seam. Order (C1-approved): (1) synchronous GoalEngine ownership
 * revocation; (2) `onLifecycle(death)` consumes the packet-frozen last-alive
 * evidence (no I/O); (3) memory records the SAME capture via
 * `deathContext()` and the writer reports the fact with `linkIncident`;
 * (4) lifecycle ledger invalidation / resource teardown. Disk writes are
 * queued after capture and never awaited on this path.
 */
export interface SurvivalLifecyclePort {
  /** Synchronous `onBotCreated` hook: attach the packet tracker before login. */
  attachConnection(source: SurvivalPacketSource, ctx: { connectionEpoch: number; selfPosition: () => { dimension: string; at: { x: number; y: number; z: number } } | undefined; containerLayout?: () => { id: number; inventoryStart: number } | undefined }): void;
  onLifecycle(event: GameLifecycleEvent): void;
  deathContext(): SurvivalDeathContext;
  linkIncident(captureId: string, memoryFactId: string): void;
  /** Persists pending survival state (shutdown, after owned gameplay cleanup). */
  close(): Promise<void>;
}

/**
 * The CANONICAL locator `RouteDestinationProvider` (b323883): the CURRENT
 * incident's own proven historical site with `provenance: 'own_incident'`,
 * returned only for the bound recovery goal epoch on the same connection and
 * dimension, only with an exact capture -> memory fact -> episode link, and
 * only while the incident identity frozen at admission (episode, fact,
 * dimension, coordinates, source) is unchanged; the destinationId encodes that
 * whole identity so a changed coordinate can never reuse it. Far recovery stays
 * blocked until the corrected route port is integrated; the travel bound is
 * never relaxed and a stale target is never replayed.
 */
export type OwnDeathDestinationProvider = RouteDestinationProvider;

// ---------------------------------------------------------------- supervisor hooks

/** Support goal admission/terminal facts the supervisor reports back (plain data). */
export interface SupportAdmission {
  proposalId: string;
  goalId: string;
  goalEpoch: number;
  connectionEpoch: number;
  admittedAtMs: number;
}

export interface SupportTerminal {
  proposalId: string;
  goalId: string;
  goalEpoch: number;
  state: string;
  reason: string;
  detail: string;
  /** GoalRecord.counters at terminal (never reset). */
  counters: { plannerTurns: number; tasksAdmitted: number; replans: number };
  endedAtMs: number;
}

/** An owner goal that ended (any reason): survival records it if it was interrupted by death/safety. */
export interface OwnerGoalEnd {
  goalId: string;
  instruction: string;
  interpretation?: string;
  outcome?: { kind: 'finite' | 'persistent'; rendered: string; atomic: readonly string[] };
  baseline?: { capturedAtMs: number; counts: Record<string, number> | null };
  progress: string;
  state: string;
  reason: string;
  endedAtMs: number;
}

/**
 * The bounded policy/recovery/status port the progression supervisor
 * consumes. Every method is synchronous, local and inference-free.
 */
export interface SurvivalPolicyPort {
  readonly enabled: boolean;
  /** Fresh-state evaluation (call on lifecycle/inventory/vitals change and on a coarse guard timer; never per tick). */
  assess(input: SurvivalAssessmentInput): SurvivalDecision;
  /** The supervisor admitted a proposal through GoalEngine (binds episode/allowance to the epoch). */
  onSupportAdmitted(admission: SupportAdmission): LowHealthAllowanceGrant | undefined;
  /** A support goal ended; budgets accumulate, attempts/cooldowns update. Stale proposal ids are ignored. */
  onSupportTerminal(end: SupportTerminal): void;
  /** Any owner goal end (interruption bookkeeping; never resubmits). */
  onOwnerGoalEnd(end: OwnerGoalEnd): void;
  /** A NEW explicit owner instruction was admitted: interrupted directives become superseded_by_owner; recovery yields. (Bare `resume` is NOT this.) */
  onOwnerInstruction(atMs: number): void;
  /** Owner explicitly dismissed an interrupted directive. */
  dismissInterrupted(goalId: string, atMs: number): boolean;
  /**
   * C4: the durable interrupted owner directives still awaiting the owner
   * (survived restart when scoped). The supervisor must keep unrelated
   * progression blocked while any is listed; only a new explicit owner
   * instruction (`onOwnerInstruction`) or an explicit dismissal clears them.
   */
  interruptedOwnerIntent(): ReadonlyArray<{ goalId: string; instruction: string; reason: string; interruptedAtMs: number; durable: boolean }>;
  /** Owner dismissed/redirected recovery explicitly (episode abandoned). */
  abandonRecovery(detail: string, atMs: number): void;
  status(nowMs: number): SurvivalStatus;
}

// ---------------------------------------------------------------- status projection (terminal / dashboard)

export interface SurvivalIncidentStatus {
  episodeId: string;
  incidentFactId?: string;
  originalIncidentFactId?: string;
  ageS: number;
  site: { source: DeathSiteSource; dimension?: string; at?: { x: number; y: number; z: number }; distance?: number };
  cause: { hazard: DeathCause['hazard']; translationKey?: string };
  phase: RecoveryPhase;
  status: RecoveryStatus;
  /** `count`: units still unaccounted for (lost minus server-confirmed regains); `lost`/`regained` per item (C9/C10). */
  missing: Array<{ key: string; count: number; state: ManifestItem['state']; lost?: number; regained?: number }>;
  regained: Array<{ key: string; count: number }>;
  /** Kept through respawn (never regained/recovered evidence). */
  retained?: Array<{ key: string; count: number }>;
  /** C10: inventory effects NOT attributed to this incident's recovery. */
  incidental?: Array<{ source: IncidentalEffect['source']; key?: string; count: number }>;
  /** C9: an attempt's effects after its last durable revision are unknown (process ended mid-attempt). */
  effectsUnknown?: boolean;
  manifestPartial: boolean;
  attempts: { used: number; max: number };
  budget: EpisodeBudget & { ceilings: { plannerTurns: number; tasks: number; replans: number; deadlineMs: number } };
  blocker?: { reason: string; detail: string };
  relatedDeaths: number;
}

export interface SurvivalStatus {
  enabled: boolean;
  store: { state: SurvivalStoreState; detail: string; scope?: MemoryScope };
  /** Active support routine (admitted), if any. */
  activeRoutine?: { routine: SurvivalRoutine; goalId: string; since: number };
  lastDecision?: { kind: SurvivalDecision['kind']; routine?: SurvivalRoutine; reason: string; atMs: number };
  vitals?: { health: number; food: number; saturation: number; ageS: number };
  incidents: SurvivalIncidentStatus[];
  interrupted: Array<{ goalId: string; instruction: string; reason: string; continuation: InterruptedDirective['continuation']; state: InterruptedDirective['state']; ageS: number }>;
  /** C12 display-only checkpoint records (other application sessions show as `restart_held`). */
  checkpoints?: Array<{ goalId: string; instruction: string; state: CheckpointRecord['state']; stateReason: string; continuations: { used: number; max: number }; ageS: number }>;
  blocked: Array<{ routine: SurvivalRoutine; reason: string; detail: string; retryInS?: number }>;
  cooldowns: Array<{ routine: SurvivalRoutine; key?: string; remainingS: number }>;
  admissionsLastHour: number;
  /** Slices intentionally not implemented in this release (honest labels). */
  gated: Array<{ slice: string; status: 'later_gated_slice' | 'mechanics_gate_pending'; detail: string }>;
}

/** Capability ids registered by src/skills/survival.ts (single source for wiring/allowances). */
export const SURVIVAL_CAPABILITIES = {
  eatSafeFood: 'eat_safe_food',
  restInPlace: 'rest_in_place',
  goToDeathSite: 'go_to_death_site',
  recoverLostItems: 'recover_lost_items',
  equipSuitableTool: 'equip_suitable_tool',
} as const satisfies Record<string, string>;

export const SurvivalCapabilityIdSchema = CapabilityIdSchema;
