// MB-MEM-001 persistent gameplay memory contracts.
//
// Memory is application-owned, durable, bounded and SCOPED: an explicit
// operator-named world profile AND world revision, a bot profile, and a
// dimension per fact. A server endpoint is connection metadata, never proof
// that it is the same world. Facts carry their source (direct observation,
// verified skill outcome, owner statement, unverified note), bounded supporting
// evidence that survives run-log pruning, timestamps, a fact revision and a
// status. Historical facts never become current state: remembered container
// contents are not present stock, a remembered home does not prove the house
// still exists, and old snapshot handles, action ids, leases or epochs are never
// stored or replayed. The planner sees a bounded, freshly referenced VIEW; it
// never reads the store, and its own assertions are never promoted to trusted
// facts.
//
// This file has no Minecraft library imports. It is consumed by src/memory/,
// the memory skills, and (through the designated writer) the shared request,
// selector, predicate, config and composition seams.
import { z } from 'zod';
import { BOUNDS, DimensionSchema, RegistryKeySchema, Vec3Schema, textSchema } from './common.ts';
import type { PredicateEvaluation } from './predicate.ts';

export const MEMORY_SCHEMA_VERSION = 1 as const;
export const MEMORY_FILE_FORMAT = 'chunkbot-memory' as const;

/** Bounds for durable storage and the model-visible view (independent of run-log retention). */
export const MEMORY_BOUNDS = {
  /** Facts kept per scope file (protected facts included). */
  maxFacts: 512,
  /** Serialized store body limit (bytes); a write that would exceed it prunes first. */
  maxStoreBytes: 1_000_000,
  /** Complete store revisions kept on disk (newest first) for crash recovery. */
  keepRevisions: 4,
  /** Supporting evidence entries per fact (first + most recent). */
  evidencePerFact: 4,
  checkpointsPerProject: 64,
  unknownEffectsPerProject: 16,
  activeProjects: 16,
  milestones: 16,
  deathIncidents: 16,
  /** Superseded/forgotten/invalid tombstones retained for audit. */
  tombstones: 64,
  /** Retrieval cap for one planner request (trusted + untrusted). */
  retrieveFacts: 20,
  /** Untrusted notes shown in one request (within retrieveFacts). */
  retrieveNotes: 4,
  /** Serialized size bound of one rendered memory view (characters). */
  viewMaxChars: 8_000,
  /** Executable memory references issued per request. */
  refsPerRequest: 24,
  /** Requests per goal whose references stay resolvable (like shown snapshots). */
  refRequestsPerGoal: 4,
} as const;

/** Operator-named profile id (world or bot). Never derived from a host name. */
export const ProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, 'must be a lowercase profile id (a-z, 0-9, _ and -)');
export type ProfileId = z.infer<typeof ProfileIdSchema>;

/**
 * Mandatory memory scope. A reset or replacement world under the same endpoint
 * needs a new worldProfile or a higher worldRevision; code never guesses world
 * identity from the host. Dimension is part of every located fact.
 */
export const MemoryScopeSchema = z
  .object({
    worldProfile: ProfileIdSchema,
    worldRevision: z.number().int().min(1).max(1_000_000),
    botProfile: ProfileIdSchema,
  })
  .strict();
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export function scopeKey(scope: MemoryScope): string {
  return `${scope.worldProfile}@r${scope.worldRevision}/${scope.botProfile}`;
}

/**
 * `memory` config block (proposed for ChunkbotConfig; designated writer adds it
 * as `memory: MemoryConfigSchema.optional()`). Absent or `enabled: false`:
 * memory is disabled, no memory capability is registered and no view is built.
 */
export const MemoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    worldProfile: ProfileIdSchema,
    worldRevision: z.number().int().min(1).max(1_000_000),
    botProfile: ProfileIdSchema,
    /** Directory under storage.dataDir (default `memory`, i.e. ignored var/memory). */
    dir: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).default('memory'),
    /**
     * The first connection binds the endpoint (host:port) to this profile
     * revision. A different endpoint later disables memory for that connection
     * (scope_conflict) unless the operator sets this once to rebind it.
     */
    rebindEndpoint: z.boolean().default(false),
    /** Age after which a fact is labeled stale in the view (it is never deleted for age alone). */
    staleAfterMs: z.number().int().positive().max(365 * 24 * 3_600_000).default(24 * 3_600_000),
  })
  .strict();
export type MemoryConfig = z.output<typeof MemoryConfigSchema>;
export type MemoryConfigInput = z.input<typeof MemoryConfigSchema>;

// ---------------------------------------------------------------- facts

/**
 * Where a fact came from. `observation`: bounded line-of-sight perception.
 * `verified_skill`: a skill outcome confirmed by server evidence (or a
 * code-verified goal outcome). `owner_statement`: the owner designated it (the
 * label is quoted from the owner's own words; the location is code-grounded).
 * `unverified_note`: a planner suggestion or anything code could not ground;
 * never trusted, never an executable target.
 */
export const MEMORY_SOURCES = ['observation', 'verified_skill', 'owner_statement', 'unverified_note'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const MEMORY_CATEGORIES = ['home', 'location', 'resource', 'workstation', 'container', 'hazard', 'project', 'milestone', 'note', 'death'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** Categories an owner can designate through the remember capability. */
export const OWNER_DESIGNATION_CATEGORIES = ['home', 'location', 'resource', 'workstation', 'container', 'hazard'] as const satisfies readonly MemoryCategory[];

/**
 * `active`: current best knowledge (still historical; freshness is labeled).
 * `invalid`: contradicted by later direct evidence (kept for audit).
 * `superseded`: replaced by a newer fact (`supersededBy`).
 * `forgotten`: removed by the owner (tombstone; never retrieved).
 */
export const MEMORY_FACT_STATUSES = ['active', 'invalid', 'superseded', 'forgotten'] as const;
export type MemoryFactStatus = (typeof MEMORY_FACT_STATUSES)[number];

export const MemoryFactIdSchema = z.string().regex(/^mf-[a-z0-9]{4,24}$/);
export type MemoryFactId = z.infer<typeof MemoryFactIdSchema>;

/** Request-bound executable memory reference (`mref-12`). Never stored. */
export const MemoryRefIdSchema = z.string().regex(/^mref-[0-9]{1,6}$/);
export type MemoryRefId = z.infer<typeof MemoryRefIdSchema>;

const shortText = (max: number) => z.string().max(max);
const atMs = z.number().int().nonnegative();
const itemCounts = z.record(RegistryKeySchema, z.number().int().nonnegative()).refine((r) => Object.keys(r).length <= 64, 'at most 64 item kinds');

export const MemoryLocationSchema = z.object({ dimension: DimensionSchema, at: Vec3Schema }).strict();
export type MemoryLocation = z.infer<typeof MemoryLocationSchema>;

/**
 * Durable supporting evidence summary (bounded, redacted). It stays historical
 * proof of WHY a fact was recorded after the run journal is pruned; it is never
 * proof of current state.
 */
export const MemoryEvidenceSchema = z
  .object({
    kind: z.enum(['observation', 'skill_outcome', 'owner_instruction', 'planner_note', 'goal_outcome', 'lifecycle', 'operator']),
    atMs,
    detail: shortText(BOUNDS.shortText),
    /** Code facts as they were when recorded (identifiers here are historical labels, never executable). */
    capability: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
    actionId: z.string().regex(/^act-[a-z0-9]{4,32}$/).optional(),
    goalId: z.string().regex(/^goal-[a-z0-9]{4,32}$/).optional(),
    confirmation: z.enum(['server_packet', 'server_sync', 'client_only', 'local_memory', 'none']).optional(),
    /** Bounded excerpt of the owner's own words supporting an owner statement. */
    ownerText: shortText(BOUNDS.shortText).optional(),
  })
  .strict();
export type MemoryEvidence = z.infer<typeof MemoryEvidenceSchema>;

/** Historical container contents (never a claim of current stock). */
export const ContainerPayloadSchema = z
  .object({
    block: RegistryKeySchema,
    contents: itemCounts,
    observedAtMs: atMs,
    via: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  })
  .strict();

/** A server-confirmed block change belonging to a construction project. */
export const ProjectCheckpointSchema = z
  .object({
    at: Vec3Schema,
    from: RegistryKeySchema.or(z.literal('unknown')),
    to: RegistryKeySchema,
    confirmedAtMs: atMs,
    capability: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  })
  .strict();

/** Commands sent after the last server confirmation of an interrupted action: effects UNKNOWN. */
export const ProjectUnknownEffectSchema = z
  .object({
    atMs,
    capability: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    commandsAfterLastConfirmation: z.number().int().nonnegative(),
    detail: shortText(BOUNDS.shortText),
  })
  .strict();

export const ProjectPayloadSchema = z
  .object({
    /** `active`: being built; `interrupted`: stopped/failed with confirmed partial state; `completed`: outcome verified by code. */
    state: z.enum(['active', 'interrupted', 'completed', 'abandoned']),
    checkpoints: z.array(ProjectCheckpointSchema).max(MEMORY_BOUNDS.checkpointsPerProject),
    /** Checkpoints dropped by the bound (count only). */
    checkpointsOmitted: z.number().int().nonnegative().default(0),
    unknownEffects: z.array(ProjectUnknownEffectSchema).max(MEMORY_BOUNDS.unknownEffectsPerProject),
    updatedAtMs: atMs,
  })
  .strict();
export type ProjectPayload = z.infer<typeof ProjectPayloadSchema>;

export const MilestonePayloadSchema = z
  .object({
    outcome: z.enum(['verified']),
    summary: shortText(BOUNDS.text),
    completedAtMs: atMs,
  })
  .strict();

const InventoryRecordSchema = z
  .object({
    /** `server_sync`: last server-confirmed inventory; `client_model`: optimistic client view; `unavailable`. */
    source: z.enum(['server_sync', 'client_model', 'unavailable']),
    capturedAtMs: atMs.optional(),
    /** How old the inventory evidence was when the death happened. */
    ageMsAtDeath: z.number().int().nonnegative().optional(),
    items: z.array(z.object({ key: RegistryKeySchema, count: z.number().int().positive() }).strict()).max(BOUNDS.listMedium + 9),
  })
  .strict();

/**
 * Own death incident (MB-FLOW-003 seam). Captured without delaying ownership
 * revocation, persisted asynchronously. A later death never overwrites an
 * unresolved original: it is a new incident `relatedTo` the original. Recovery
 * status may survive restart but authorizes nothing (no reconnect, unpause or
 * replay); it is updated only from verified evidence.
 */
export const DeathPayloadSchema = z
  .object({
    occurredAtMs: atMs,
    /** How the location was obtained and how exact it is. */
    accuracy: z.enum(['client_position_at_death_event', 'last_observation', 'unknown']),
    positionAgeMs: z.number().int().nonnegative().optional(),
    cause: z.object({ kind: z.enum(['unknown', 'observed']), detail: shortText(BOUNDS.shortText).optional() }).strict(),
    lastAliveInventory: InventoryRecordSchema,
    /** The original unresolved incident this death is related to (e.g. died while recovering). */
    relatedTo: MemoryFactIdSchema.optional(),
    recovery: z
      .object({
        status: z.enum(['unresolved', 'partially_recovered', 'recovered', 'abandoned']),
        regained: z.array(z.object({ key: RegistryKeySchema, count: z.number().int().positive(), atMs }).strict()).max(BOUNDS.listMedium),
        /** Items believed still missing (from the last-alive record minus verified regains). */
        missing: z.array(z.object({ key: RegistryKeySchema, count: z.number().int().positive() }).strict()).max(BOUNDS.listMedium + 9),
        updatedAtMs: atMs,
        detail: shortText(BOUNDS.shortText).optional(),
      })
      .strict(),
  })
  .strict();
export type DeathPayload = z.infer<typeof DeathPayloadSchema>;

export const MemoryFactSchema = z
  .object({
    id: MemoryFactIdSchema,
    category: z.enum(MEMORY_CATEGORIES),
    /** Display label (bounded). */
    label: textSchema(80),
    /** Normalized label for matching (lowercase words). */
    labelKey: z.string().max(80),
    /** Registry key the fact is about (block/item), when any. */
    key: RegistryKeySchema.optional(),
    location: MemoryLocationSchema.optional(),
    source: z.enum(MEMORY_SOURCES),
    evidence: z.array(MemoryEvidenceSchema).min(1).max(MEMORY_BOUNDS.evidencePerFact),
    /** Number of supporting evidence events (including ones dropped by the bound). */
    evidenceCount: z.number().int().positive(),
    firstRecordedMs: atMs,
    /** Last time evidence CONFIRMED this fact (observation, skill, owner restatement). */
    lastConfirmedMs: atMs,
    /** Fact revision: incremented on every change. */
    revision: z.number().int().positive(),
    status: z.enum(MEMORY_FACT_STATUSES),
    statusDetail: shortText(BOUNDS.shortText).optional(),
    statusAtMs: atMs.optional(),
    supersedes: MemoryFactIdSchema.optional(),
    supersededBy: MemoryFactIdSchema.optional(),
    /** Short free text (notes, owner remark); data, never instructions. */
    note: shortText(BOUNDS.shortText).optional(),
    /** Observation aggregate (e.g. visible resource blocks in this cell when last seen). */
    seenCount: z.number().int().positive().optional(),
    container: ContainerPayloadSchema.optional(),
    project: ProjectPayloadSchema.optional(),
    milestone: MilestonePayloadSchema.optional(),
    death: DeathPayloadSchema.optional(),
    /** The goal that created/owns a project (historical label only). */
    goalId: z.string().regex(/^goal-[a-z0-9]{4,32}$/).optional(),
  })
  .strict();
export type MemoryFact = z.infer<typeof MemoryFactSchema>;

/** Endpoint bound to the profile revision (connection metadata, not identity proof). */
export const EndpointBindingSchema = z.object({ endpoint: z.string().max(300), boundAtMs: atMs }).strict();

export const MemoryStoreBodySchema = z
  .object({
    scope: MemoryScopeSchema,
    createdAtMs: atMs,
    endpoint: EndpointBindingSchema.optional(),
    facts: z.array(MemoryFactSchema).max(MEMORY_BOUNDS.maxFacts),
    /** Monotonic counter for fact ids. */
    nextFact: z.number().int().positive(),
    /** Facts evicted by the bound so far (count only). */
    evicted: z.number().int().nonnegative(),
  })
  .strict();
export type MemoryStoreBody = z.infer<typeof MemoryStoreBodySchema>;

/** One complete on-disk store revision. `checksum` is sha256 over the canonical body JSON. */
export const MemoryStoreFileSchema = z
  .object({
    format: z.literal(MEMORY_FILE_FORMAT),
    schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
    revision: z.number().int().positive(),
    writtenAtMs: atMs,
    checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    body: MemoryStoreBodySchema,
  })
  .strict();
export type MemoryStoreFile = z.infer<typeof MemoryStoreFileSchema>;

// ---------------------------------------------------------------- status

/**
 * Store state. `ready`: newest revision loaded. `empty`: no revision exists
 * (fresh assessment). `recovered`: the newest revision(s) were unreadable and
 * an older complete revision was loaded. `migrated`: an older schema was
 * upgraded in memory (originals kept). `read_only`: readable but writes are
 * refused (newer schema, another writer, or every revision corrupt with data
 * present). `scope_conflict`: the connection's endpoint differs from the bound
 * one. `disabled`: no profile configured.
 */
export const MEMORY_STORE_STATES = ['disabled', 'empty', 'ready', 'recovered', 'migrated', 'read_only', 'scope_conflict'] as const;
export type MemoryStoreState = (typeof MEMORY_STORE_STATES)[number];

export interface MemoryStatus {
  state: MemoryStoreState;
  detail: string;
  scope?: MemoryScope;
  /** Loaded/written store revision (0 when none). */
  revision: number;
  facts: { total: number; active: number; trusted: number; untrusted: number };
  writable: boolean;
  corruptRevisions: number[];
  recoveredFromRevision?: number;
  migratedFromSchema?: number;
  discardedPartialWrites: number;
  pendingWrites: number;
  lastWriteAtMs?: number;
  lastError?: string;
  endpoint?: string;
}

// ---------------------------------------------------------------- planner view

export type MemoryTrust = 'trusted' | 'untrusted';

/** One retrieved fact as the planner sees it (bounded, fresh refs only). */
export interface MemoryViewFact {
  /** Executable reference for THIS request (only for trusted, located facts in the current dimension). */
  ref?: MemoryRefId;
  /** Durable fact id: usable only to name a fact for forgetting/correction, never as a target. */
  id: MemoryFactId;
  category: MemoryCategory;
  label: string;
  key?: string;
  location?: { dimension: string; at: { x: number; y: number; z: number }; distance?: number; currentDimension: boolean };
  source: MemorySource;
  trust: MemoryTrust;
  /** Freshness: age of the last confirming evidence; `stale` beyond the configured age. */
  freshness: { lastConfirmedAgeS: number; stale: boolean; recordedAgeS: number };
  /** Short evidence summary (historical). */
  evidence: string;
  note?: string;
  /** Historical container contents (NOT present stock; inspect before relying on them). */
  container?: { contents: Record<string, number>; observedAgeS: number; historical: true };
  project?: { state: ProjectPayload['state']; confirmedChanges: number; recent: Array<{ ref?: MemoryRefId; at: { x: number; y: number; z: number }; to: string }>; unknownEffects: number };
  death?: { ageS: number; accuracy: DeathPayload['accuracy']; recovery: DeathPayload['recovery']['status']; missing: Array<{ key: string; count: number }>; inventorySource: string; inventoryAgeAtDeathS?: number; relatedTo?: MemoryFactId };
  milestone?: { summary: string };
}

export interface MemoryView {
  status: { state: MemoryStoreState; detail: string };
  scope?: { worldProfile: string; worldRevision: number; botProfile: string; dimension?: string };
  /** Trusted facts (observation, verified skill, owner statement), most relevant first. */
  facts: MemoryViewFact[];
  /** Untrusted notes, shown separately (never executable). */
  notes: MemoryViewFact[];
  /** How many matching facts were not shown and why. */
  omitted: { count: number; reason: string };
  /** Rules restated as data so the bounded view is self-describing. */
  rules: string[];
}

// ---------------------------------------------------------------- shared-seam schemas (for the designated writer)

/**
 * Proposed TargetSelector variant: a request-bound memory reference. Resolves
 * only for the goal/connection/dimension it was issued in and only while the
 * fact is active; it is remembered (historical) evidence, never current
 * visibility, presence, ownership or contents.
 */
export const MemoryRefSelectorSchema = z.object({ kind: z.literal('memory_ref'), refId: MemoryRefIdSchema }).strict();
export type MemoryRefSelector = z.infer<typeof MemoryRefSelectorSchema>;

/**
 * Proposed atomic predicate: a durable memory write confirmed LOCALLY by the
 * memory store (not a world effect, not server evidence).
 * `recorded`: a TRUSTED fact with this label was durably written/confirmed since binding.
 * `noted`: an UNVERIFIED note with this label was durably written since binding.
 * `forgotten`: no active fact with this label remains in the current scope.
 */
export const MemoryStatePredicateSchema = z
  .object({
    predicate: z.literal('memory_state'),
    label: textSchema(80),
    expect: z.enum(['recorded', 'noted', 'forgotten']),
  })
  .strict();
export type MemoryStatePredicate = z.infer<typeof MemoryStatePredicateSchema>;

/** A resolved memory reference (plain data). */
export interface ResolvedMemoryRef {
  refId: MemoryRefId;
  factId: MemoryFactId;
  category: MemoryCategory;
  label: string;
  key?: string;
  dimension: string;
  at: { x: number; y: number; z: number };
  source: MemorySource;
  lastConfirmedMs: number;
}

// ---------------------------------------------------------------- ports (installed by the designated writer)

/** Goal-engine seam: one bounded view with fresh refs per planner request. */
export interface MemoryPlannerPort {
  view(request: {
    goalId: string;
    goalEpoch: number;
    requestId: string;
    instruction: string;
    /** Owner answers to clarification questions (owner words). */
    answers?: readonly string[];
    observation: { dimension: string; self: { at: { x: number; y: number; z: number } }; connectionEpoch: number } | null;
  }): MemoryView;
  /** Goal ended (any terminal state): its refs become unresolvable. Confirmed memory persists. */
  releaseGoal(goalId: string): void;
}

/** Selector/predicate seam: resolve a request-bound ref against the CURRENT connection and dimension. */
export interface MemoryRefResolver {
  resolveRef(refId: string, current: { connectionEpoch: number; dimension: string }): ResolvedMemoryRef | { error: string; detail: string };
}

/** Code evaluation of `memory_state` (same shape as PredicateEvaluation; the kind is added by the writer). */
export type MemoryStateEvaluation = Omit<PredicateEvaluation, 'predicate' | 'children'> & { predicate: 'memory_state' };

/** Predicate-engine seam for `memory_state`. */
export interface MemoryPredicatePort {
  evaluateMemoryState(predicate: MemoryStatePredicate, boundAtMs: number): MemoryStateEvaluation;
}
