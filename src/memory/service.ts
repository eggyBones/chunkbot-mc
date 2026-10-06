// MemoryService: the facade the application, goal engine, predicate engine
// and memory skills use. Composes the atomic file store, the fact book, the
// request-bound ref registry and the recorder rules.
//
// Startup: open() loads the configured scope (explicit world profile +
// revision + bot profile) and reports corruption/migration/recovery honestly.
// Connection: the first ready connection binds the endpoint; a different
// endpoint later puts memory in `scope_conflict` (no retrieval, no writes) —
// the operator must choose a new profile/revision or rebind explicitly.
// Lifecycle: death/respawn/dimension change/disconnect invalidate only
// transient refs; durable facts persist. A death is captured synchronously
// (cheap, no I/O) and persisted asynchronously, never delaying revocation.
// Memory never reconnects, unpauses, resumes goals or replays actions.
import { join } from 'node:path';
import type { Clock, EvidenceEvent, GameLifecycleEvent, ObservationSnapshot, SkillOutcome } from '../contracts/index.ts';
import {
  MEMORY_BOUNDS,
  MemoryFactSchema,
  scopeKey,
  type MemoryCategory,
  type MemoryConfig,
  type MemoryEvidence,
  type MemoryFact,
  type MemoryLocation,
  type MemoryPlannerPort,
  type MemoryPredicatePort,
  type MemoryRefResolver,
  type MemoryScope,
  type MemoryStateEvaluation,
  type MemoryStateBinding,
  type MemoryStatePredicate,
  type MemoryStatus,
  type MemoryStoreState,
  type MemoryRefFence,
  type MemoryRefId,
  type MemoryFactId,
  type MemoryView,
  type MemoryViewRequest,
  type ResolvedMemoryRef,
} from '../contracts/memory.ts';
import { MemoryBook, isTrusted, type WriteResult } from './book.ts';
import { labelKey, ownerGrounding } from './labels.ts';
import { MemoryRefRegistry } from './refs.ts';
import { buildView } from './retrieval.ts';
import { MemoryFileStore, scopeDirectory, type MemoryFileStoreOptions, type MemoryLoad } from './store.ts';
import type { DeathContext, MemoryWorld } from './world.ts';

const WORKSTATION = /^minecraft:(crafting_table|furnace|blast_furnace|smoker|stonecutter|smithing_table|anvil|chipped_anvil|damaged_anvil|grindstone|loom|cartography_table|fletching_table|enchanting_table|brewing_stand|campfire|soul_campfire)$/;
const CONTAINER = /^minecraft:(chest|trapped_chest|barrel|hopper|dropper|dispenser|ender_chest|([a-z_]+_)?shulker_box)$/;
/** Resource sightings worth remembering (coordinator assumption): ores, logs/stems, ancient debris. */
const RESOURCE = /^minecraft:([a-z_]+_ore|ancient_debris|[a-z_]+_log|[a-z_]+_stem)$/;
const HAZARD = /^minecraft:(lava)$/;

/** Only well-formed code identifiers are kept in durable evidence (a malformed one is dropped, never stored). */
function evidenceIds(ids: { capability?: string | undefined; actionId?: string | undefined; goalId?: string | undefined }): Pick<MemoryEvidence, 'capability' | 'actionId' | 'goalId'> {
  return {
    ...(ids.capability && /^[a-z][a-z0-9_]{1,63}$/.test(ids.capability) ? { capability: ids.capability } : {}),
    ...(ids.actionId && /^act-[a-z0-9]{4,32}$/.test(ids.actionId) ? { actionId: ids.actionId } : {}),
    ...(ids.goalId && /^goal-[a-z0-9]{4,32}$/.test(ids.goalId) ? { goalId: ids.goalId } : {}),
  };
}

const bare = (key: string) => key.replace(/^minecraft:/, '').replace(/_/g, ' ');
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const fmt = (at: { x: number; y: number; z: number }) => `${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)}`;

export interface MemoryServiceOptions {
  /** Undefined (or enabled:false): memory is disabled and advertises nothing. */
  config: MemoryConfig | undefined;
  /** Root directory for memory (normally <dataDir>/<config.dir>, i.e. var/memory). */
  rootDir: string;
  /** host:port of the configured server (connection metadata, never identity proof). */
  endpoint: string;
  clock: Clock;
  /** Run evidence (redacted by the run store). */
  record?: (event: EvidenceEvent) => void;
  /** Debounce for observation-driven persistence (default 10 s). Owner/skill/death writes persist immediately. */
  observationPersistMs?: number;
  /** Store test seams (fault injection, pid, migrations). */
  store?: Partial<Pick<MemoryFileStoreOptions, 'beforeRename' | 'pid' | 'isAlive' | 'migrations' | 'keepRevisions'>>;
}

interface GoalMemoryContext {
  goalId: string;
  epoch: number;
  instruction: string;
  answers: string[];
}

export type MemoryWriteOutcome =
  | { ok: true; fact: MemoryFact; change: WriteResult['change']; trusted: boolean; storeRevision: number; affected: string[]; detail: string; /** A requested trusted designation was stored only as an unverified note. */ downgraded?: boolean }
  | { ok: false; reason: string; detail: string };

export class MemoryService implements MemoryPlannerPort, MemoryRefResolver, MemoryPredicatePort {
  readonly enabled: boolean;
  readonly scope: MemoryScope | undefined;
  private readonly options: MemoryServiceOptions;
  private store: MemoryFileStore | undefined;
  private book: MemoryBook | undefined;
  private load: MemoryLoad | undefined;
  private world: MemoryWorld | undefined;
  readonly refs = new MemoryRefRegistry();
  private readonly goals = new Map<string, GoalMemoryContext>();
  private conflict: string | undefined;
  private rebound = false;
  private persistedVersion = -1;
  /** Fact id -> fact revision included in the last durable store revision. */
  private durable = new Map<string, number>();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persisting: Promise<number | undefined> | undefined;
  private lastIngested: string | undefined;
  private lastWriteError: string | undefined;
  private closed = false;
  private checkedEpoch: number | undefined;
  /** Monotonic memory write sequence (owner/skill writes); predicate baselines compare against it. */
  private writeSeq = 0;
  private readonly factWriteSeq = new Map<string, number>();
  /** Label keys of ACTIVE facts in the last complete durable revision (loaded or written). */
  private durableActiveLabels = new Set<string>();

  constructor(options: MemoryServiceOptions) {
    this.options = options;
    const cfg = options.config;
    this.enabled = Boolean(cfg && cfg.enabled);
    this.scope = cfg && cfg.enabled ? { worldProfile: cfg.worldProfile, worldRevision: cfg.worldRevision, botProfile: cfg.botProfile } : undefined;
  }

  // ------------------------------------------------------------ startup / status

  /** Loads the scope's newest complete revision (synchronous). Safe to call once. */
  open(): MemoryStatus {
    if (!this.enabled || !this.scope || this.store) return this.status();
    const now = this.options.clock.now();
    this.store = new MemoryFileStore({ dir: scopeDirectory(this.options.rootDir, this.scope), scope: this.scope, clock: this.options.clock, ...(this.options.store ?? {}) });
    try {
      this.load = this.store.open();
    } catch (error) {
      this.load = { body: undefined, state: 'read_only', detail: `memory store could not be opened: ${error instanceof Error ? error.message : String(error)}`, revision: 0, corruptRevisions: [], discardedPartialWrites: 0, writable: false };
    }
    if (this.load.body || this.load.state === 'empty') this.book = new MemoryBook(this.scope, now, this.load.body);
    if (this.book && this.load.body) {
      this.persistedVersion = this.book.version;
      for (const f of this.book.facts()) this.durable.set(f.id, f.revision);
      this.durableActiveLabels = new Set(this.book.facts().filter((f) => f.status === 'active').map((f) => f.labelKey));
    }
    this.options.record?.({ type: 'memory_opened', scope: scopeKey(this.scope), state: this.load.state, detail: this.load.detail, revision: this.load.revision, corruptRevisions: this.load.corruptRevisions, facts: this.book?.facts().length ?? 0 });
    return this.status();
  }

  attachWorld(world: MemoryWorld): void {
    this.world = world;
  }

  private get state(): MemoryStoreState {
    if (!this.enabled) return 'disabled';
    if (this.conflict) return 'scope_conflict';
    if (!this.load) return 'empty';
    if ((this.load.state === 'ready' || this.load.state === 'empty') && !this.store?.canWrite) return 'read_only';
    return this.load.state;
  }

  /** Retrieval allowed (a loaded book and no scope conflict). */
  private get readable(): boolean {
    return this.enabled && Boolean(this.book) && !this.conflict;
  }

  /** Writes allowed (readable, writable store, not closed). */
  private get writable(): boolean {
    return this.readable && Boolean(this.store?.canWrite) && !this.closed;
  }

  status(): MemoryStatus {
    const facts = this.book?.facts() ?? [];
    const active = facts.filter((f) => f.status === 'active');
    const detail = !this.enabled
      ? 'memory disabled: no world profile is configured (set memory.worldProfile, worldRevision and botProfile)'
      : this.conflict
        ? this.conflict
        : `${this.load?.detail ?? 'not opened'}${this.rebound ? '; endpoint rebound by operator config' : ''}`;
    return {
      state: this.state,
      detail,
      ...(this.scope ? { scope: this.scope } : {}),
      revision: this.store?.revision ?? 0,
      facts: { total: facts.length, active: active.length, trusted: active.filter(isTrusted).length, untrusted: active.filter((f) => !isTrusted(f)).length },
      writable: this.writable,
      corruptRevisions: this.load?.corruptRevisions ?? [],
      ...(this.load?.recoveredFromRevision !== undefined ? { recoveredFromRevision: this.load.recoveredFromRevision } : {}),
      ...(this.load?.migratedFromSchema !== undefined ? { migratedFromSchema: this.load.migratedFromSchema } : {}),
      discardedPartialWrites: this.load?.discardedPartialWrites ?? 0,
      pendingWrites: this.store?.pending ?? 0,
      ...(this.store?.lastWriteAtMs !== undefined ? { lastWriteAtMs: this.store.lastWriteAtMs } : {}),
      ...(this.lastWriteError ? { lastError: this.lastWriteError } : {}),
      ...(this.book?.endpoint ? { endpoint: this.book.endpoint.endpoint } : {}),
    };
  }

  /** Operator status lines (no inference, no world data). */
  statusLines(): string[] {
    const s = this.status();
    if (s.state === 'disabled') return [`memory: disabled (${s.detail})`];
    const scope = s.scope ? scopeKey(s.scope) : '?';
    const lines = [`memory: ${s.state} ${scope} rev ${s.revision}; ${s.facts.active} active facts (${s.facts.trusted} trusted, ${s.facts.untrusted} untrusted notes); ${s.writable ? 'writable' : 'NOT writable'}${s.pendingWrites ? `; ${s.pendingWrites} write(s) pending` : ''}`];
    if (s.state !== 'ready' && s.state !== 'empty') lines.push(`memory detail: ${clip(s.detail, 240)}`);
    if (s.lastError) lines.push(`memory last write error: ${clip(s.lastError, 200)}`);
    return lines;
  }

  // ------------------------------------------------------------ connection / lifecycle

  /** Re-checks the endpoint binding once per connection epoch (also when no ready hook was wired). */
  private ensureScope(): void {
    const conn = this.world?.connection();
    if (conn && conn.connectionEpoch !== this.checkedEpoch) this.onConnectionReady();
  }

  /** First ready connection binds the endpoint; a different endpoint is a scope conflict. */
  onConnectionReady(): void {
    if (!this.enabled || !this.book) return;
    const epoch = this.world?.connection()?.connectionEpoch;
    if (epoch !== undefined) this.checkedEpoch = epoch;
    const endpoint = this.options.endpoint;
    const bound = this.book.endpoint;
    const now = this.options.clock.now();
    if (!bound) {
      if (this.store?.canWrite) {
        this.book.bindEndpoint(endpoint, now);
        void this.persist('endpoint_bound');
      }
      this.conflict = undefined;
      return;
    }
    if (bound.endpoint === endpoint) {
      this.conflict = undefined;
      return;
    }
    if (this.options.config?.rebindEndpoint && this.store?.canWrite) {
      this.book.bindEndpoint(endpoint, now);
      this.rebound = true;
      this.conflict = undefined;
      this.options.record?.({ type: 'memory_endpoint_rebound', from: bound.endpoint, to: endpoint });
      void this.persist('endpoint_rebound');
      return;
    }
    this.conflict = `scope conflict: world profile ${scopeKey(this.book.scope)} is bound to endpoint ${bound.endpoint}, but this connection is ${endpoint}. A different server or a reset world needs a new memory.worldProfile or worldRevision; set memory.rebindEndpoint only if this is the same world moved. Memory is not used for this connection.`;
    this.refs.invalidateAll();
    this.options.record?.({ type: 'memory_scope_conflict', bound: bound.endpoint, endpoint });
  }

  /**
   * Lifecycle hook. Call synchronously BEFORE the skill layer invalidates the
   * ledger/perception (so a death can still read the last-alive evidence),
   * and after the goal engine's synchronous revocation prefix.
   */
  onLifecycle(event: GameLifecycleEvent): void {
    if (event.type === 'ready') {
      this.onConnectionReady();
      return;
    }
    if (event.type === 'death' && this.world) this.captureDeath(this.world.deathContext());
    if (event.type === 'death' || event.type === 'respawn' || event.type === 'dimension_change' || event.type === 'ended') {
      const n = this.refs.invalidateAll();
      if (n > 0) this.options.record?.({ type: 'memory_refs_invalidated', reason: event.type, refs: n });
    }
    if (event.type === 'ended') void this.flush();
  }

  /** Records an own death incident (sync, no I/O); persistence is queued. */
  captureDeath(ctx: DeathContext): MemoryFact | undefined {
    this.ensureScope();
    if (!this.writable || !this.book) {
      this.options.record?.({ type: 'memory_death_not_recorded', reason: this.state });
      return undefined;
    }
    const now = this.options.clock.now();
    const items = ctx.inventory.items.filter((i) => i.count > 0).slice(0, 41);
    const fact = this.book.addDeath({
      ...(ctx.dimension && ctx.position ? { location: { dimension: ctx.dimension, at: ctx.position } } : {}),
      death: {
        occurredAtMs: now,
        accuracy: ctx.accuracy,
        ...(ctx.positionAgeMs !== undefined ? { positionAgeMs: Math.round(ctx.positionAgeMs) } : {}),
        cause: { kind: 'unknown', detail: 'no death cause is parsed yet (MB-FLOW-003 seam)' },
        lastAliveInventory: {
          source: ctx.inventory.source,
          ...(ctx.inventory.capturedAtMs !== undefined ? { capturedAtMs: ctx.inventory.capturedAtMs, ageMsAtDeath: Math.max(0, now - ctx.inventory.capturedAtMs) } : {}),
          items,
        },
      },
      evidence: { kind: 'lifecycle', atMs: now, detail: `own death (${ctx.accuracy}${ctx.position ? ` at ${fmt(ctx.position)} in ${ctx.dimension}` : ', location unknown'}); inventory ${ctx.inventory.source}` },
      nowMs: now,
    });
    this.options.record?.({ type: 'memory_death_recorded', factId: fact.id, relatedTo: fact.death?.relatedTo ?? null, accuracy: ctx.accuracy, inventorySource: ctx.inventory.source });
    void this.persist('death');
    return fact;
  }

  /** MB-FLOW-003 seam: verified regained items update an incident's recovery record. */
  async updateDeathRecovery(factId: string, update: { regained?: Array<{ key: string; count: number }>; status?: 'abandoned'; detail?: string }, evidence: { detail: string; actionId?: string; capability?: string }): Promise<MemoryWriteOutcome> {
    if (!this.writable || !this.book) return { ok: false, reason: 'memory_not_writable', detail: this.status().detail };
    const now = this.options.clock.now();
    const fact = this.book.updateDeathRecovery(factId, update, { kind: 'skill_outcome', atMs: now, detail: clip(evidence.detail, 200), ...evidenceIds({ actionId: evidence.actionId, capability: evidence.capability }) }, now);
    if (!fact) return { ok: false, reason: 'unknown_death_incident', detail: `${factId} is not a death incident in this scope` };
    return this.persistOutcome(fact, 'updated', [], 'death recovery updated');
  }

  // ------------------------------------------------------------ goals / planner seam

  /** Goal admission: keeps the owner's words for grounding designations (call with the instruction). */
  beginGoal(goal: { goalId: string; epoch: number; instruction: string }): void {
    this.goals.set(goal.goalId, { goalId: goal.goalId, epoch: goal.epoch, instruction: goal.instruction.slice(0, 2_000), answers: [] });
    while (this.goals.size > 8) this.goals.delete(this.goals.keys().next().value as string);
  }

  /**
   * One bounded view per planner request. A goal subject gets fresh
   * executable refs; a preparation subject gets the same bounded facts with
   * NON-executable prepared refs and records nothing (a preparation owns no
   * goal, lease or baseline; memory never invents an admitted goal for it).
   */
  view(request: MemoryViewRequest): MemoryView {
    this.ensureScope();
    const subject = request.subject;
    if (subject.kind === 'goal') {
      const known = this.goals.get(subject.goalId);
      if (!known || known.epoch !== subject.goalEpoch) this.beginGoal({ goalId: subject.goalId, epoch: subject.goalEpoch, instruction: request.instruction });
      const g = this.goals.get(subject.goalId) as GoalMemoryContext;
      g.answers = [...(request.answers ?? [])].slice(-8).map((a) => a.slice(0, 1_000));
      if (this.readable && request.observation) this.ingestObservation();
    }
    const nowMs = this.options.clock.now();
    const view = buildView(request, {
      state: this.state,
      detail: this.status().detail,
      usable: this.readable,
      ...(this.scope ? { scope: this.scope } : {}),
      facts: this.book?.facts() ?? [],
      nowMs,
      staleAfterMs: this.options.config?.staleAfterMs ?? 24 * 3_600_000,
      refs: this.refs,
    });
    this.options.record?.({
      type: 'memory_view',
      subject: subject.kind,
      subjectId: subject.kind === 'goal' ? subject.goalId : subject.intentId,
      requestId: request.requestId,
      state: view.status.state,
      facts: view.facts.length,
      notes: view.notes.length,
      refs: view.facts.filter((f) => f.ref).length,
      preparedRefs: view.facts.filter((f) => f.prepRef).length,
      omitted: view.omitted.count,
    });
    return view;
  }

  /** Executable refs currently shown to an admitted goal epoch (proposal reference validation). */
  shownRefs(goal: { goalId: string; goalEpoch: number }): Set<string> {
    return this.refs.shownFor(goal);
  }

  /** Prepared refs shown to a preparation generation (draft reference validation). */
  shownPreparedRefs(prep: { intentId: string; generation: number }): Set<string> {
    return this.refs.shownPrepared(prep);
  }

  /** After the REAL admission: prepared ref -> fresh executable ref of the SAME active fact, or a closed failure. */
  regroundPrepared(
    prepRefId: string,
    admission: { intentId: string; generation: number; goalId: string; goalEpoch: number; requestId: string; connectionEpoch: number; dimension: string },
  ): { refId: MemoryRefId; factId: MemoryFactId } | { error: string; detail: string } {
    this.ensureScope();
    if (!this.readable || !this.book) return { error: 'memory_unavailable', detail: `memory is not usable: ${this.status().detail}` };
    const book = this.book;
    const r = this.refs.reground(prepRefId, admission, (id) => book.get(id));
    this.options.record?.({ type: 'memory_ref_regrounded', prepRefId, goalId: admission.goalId, ok: !('error' in r), ...('error' in r ? { error: r.error } : { refId: r.refId, factId: r.factId }) });
    return r;
  }

  releaseGoal(goalId: string): void {
    this.refs.releaseGoal(goalId);
  }

  releasePreparation(intentId: string): void {
    this.refs.releasePreparation(intentId);
  }

  /**
   * Goal terminal hook. A code-verified outcome becomes a bounded milestone and
   * completes the goal's project; any other end marks its project interrupted
   * (confirmed checkpoints stay; nothing is replayed). Releases the goal's refs.
   */
  onGoalTerminal(end: { goalId: string; reason: string; detail: string; interpretation?: string; kind?: string }): void {
    this.refs.releaseGoal(end.goalId);
    const g = this.goals.get(end.goalId);
    this.goals.delete(end.goalId);
    if (!this.writable || !this.book) return;
    const now = this.options.clock.now();
    const ev: MemoryEvidence = { kind: 'goal_outcome', atMs: now, ...evidenceIds({ goalId: end.goalId }), detail: clip(`${end.reason}: ${end.detail}`, 200) };
    if (end.reason === 'outcome_verified' && end.kind !== 'operator_task_diagnostic') {
      const label = clip(g?.instruction ?? end.interpretation ?? 'verified goal', 80);
      this.book.addMilestone({ label, summary: clip(`${end.interpretation ? `${end.interpretation} — ` : ''}${end.detail}`, 1_000), evidence: { ...ev, ...(g ? { ownerText: clip(g.instruction, 200) } : {}) }, nowMs: now, goalId: end.goalId });
      this.book.setProjectState(end.goalId, 'completed', ev, now);
    } else {
      this.book.setProjectState(end.goalId, 'interrupted', ev, now);
    }
    void this.persist('goal_terminal');
  }

  // ------------------------------------------------------------ evidence recording

  /** Ingests the latest filtered observation (once per snapshot): sightings and direct contradictions. */
  ingestObservation(snapshot?: ObservationSnapshot): void {
    this.ensureScope();
    if (!this.writable || !this.book || !this.world) return;
    const snap = snapshot ?? this.world.latestSnapshot();
    const conn = this.world.connection();
    if (!snap || !conn || snap.id === this.lastIngested || snap.connectionEpoch !== conn.connectionEpoch || snap.dimension !== conn.dimension) return;
    this.lastIngested = snap.id;
    const now = this.options.clock.now();
    const before = this.book.version;
    const confirmed = new Set<string>();
    const cells = new Map<string, { key: string; at: { x: number; y: number; z: number }; count: number; distance: number; category: 'resource' | 'hazard' }>();
    for (const b of snap.blocks) {
      const location = { dimension: snap.dimension, at: b.at };
      const evidence: MemoryEvidence = { kind: 'observation', atMs: now, detail: `seen ${bare(b.key)} at ${fmt(b.at)} (line of sight, ${b.distance} blocks)` };
      if (WORKSTATION.test(b.key) || CONTAINER.test(b.key)) {
        const r = this.book.recordWorldFact({ category: WORKSTATION.test(b.key) ? 'workstation' : 'container', source: 'observation', key: b.key, label: bare(b.key), location, evidence, nowMs: now });
        confirmed.add(r.fact.id);
      } else if (RESOURCE.test(b.key) || HAZARD.test(b.key)) {
        const k = `${b.key}|${Math.floor(b.at.x / 16)},${Math.floor(b.at.y / 16)},${Math.floor(b.at.z / 16)}`;
        const c = cells.get(k);
        if (!c) cells.set(k, { key: b.key, at: b.at, count: 1, distance: b.distance, category: HAZARD.test(b.key) ? 'hazard' : 'resource' });
        else {
          c.count += 1;
          if (b.distance < c.distance) Object.assign(c, { at: b.at, distance: b.distance });
        }
      }
    }
    for (const c of cells.values()) {
      const r = this.book.recordWorldFact({ category: c.category === 'hazard' ? 'hazard' : 'resource', source: 'observation', key: c.key, label: bare(c.key), location: { dimension: snap.dimension, at: c.at }, seenCount: c.count, evidence: { kind: 'observation', atMs: now, detail: `seen ${c.count} ${bare(c.key)} near ${fmt(c.at)} (line of sight)` }, nowMs: now });
      confirmed.add(r.fact.id);
    }
    // Direct contradictions: a remembered block-backed fact whose voxel is observable NOW and holds something else.
    const radius = this.world.observationRadius();
    const self = snap.self.at;
    for (const f of this.book.active()) {
      if (confirmed.has(f.id) || !f.key || !f.location || f.location.dimension !== snap.dimension) continue;
      if (f.category !== 'workstation' && f.category !== 'container' && f.category !== 'resource') continue;
      const at = f.location.at;
      if (Math.hypot(at.x - self.x, at.y - self.y, at.z - self.z) > radius + 1) continue;
      const seen = this.world.observeVoxel(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z));
      if (seen === undefined || seen === f.key) continue;
      this.book.contradict(f, `observed ${bare(seen)} at ${fmt(at)} instead of ${bare(f.key)}`, { kind: 'observation', atMs: now, detail: `direct observation: ${bare(seen)} at ${fmt(at)} (was ${bare(f.key)})` }, now);
      this.options.record?.({ type: 'memory_fact_contradicted', factId: f.id, category: f.category, was: f.key, now: seen });
    }
    if (this.book.version !== before) this.persistSoon();
  }

  /**
   * Records server-confirmed effects of one executed action (call for every
   * SkillOutcome). Only ledger entries the skill confirmed with server data
   * are used; client-only effects (e.g. arrival) record nothing durable.
   */
  recordOutcome(outcome: SkillOutcome): void {
    this.ensureScope();
    if (!this.writable || !this.book || !this.world) return;
    this.ingestObservation();
    const conn = this.world.connection();
    if (!conn || outcome.connectionEpoch !== conn.connectionEpoch) return;
    const now = this.options.clock.now();
    const capability = outcome.capability ?? 'unknown';
    const ev = this.world.actionEvidence(outcome.actionId);
    const before = this.book.version;
    const base: Omit<MemoryEvidence, 'detail'> = { kind: 'skill_outcome', atMs: now, ...evidenceIds({ capability, actionId: outcome.actionId, goalId: outcome.goalId }) };
    const goal = outcome.goalId ? this.goals.get(outcome.goalId) : undefined;
    for (const c of ev.blockChanges) {
      const at = { x: c.x, y: c.y, z: c.z };
      const removedResource = RESOURCE.test(c.from) && !RESOURCE.test(c.to);
      if (removedResource) {
        this.book.recordWorldFact({ category: 'resource', source: 'verified_skill', key: c.from, label: bare(c.from), location: { dimension: conn.dimension, at }, evidence: { ...base, confirmation: 'server_packet', detail: `${capability} broke ${bare(c.from)} at ${fmt(at)} (server block update)` }, nowMs: now });
      }
      if (capability === 'place_block' && outcome.owner === 'goal' && outcome.goalId) {
        this.book.addCheckpoint({
          goalId: outcome.goalId,
          label: clip(goal ? `build: ${goal.instruction}` : `construction for ${outcome.goalId}`, 80),
          dimension: conn.dimension,
          checkpoint: { at, from: /^#?[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(c.from) ? c.from : 'unknown', to: c.to, confirmedAtMs: c.atMs, capability },
          evidence: { ...base, confirmation: 'server_packet', detail: `placed ${bare(c.to)} at ${fmt(at)} (server block update)`, ...(goal ? { ownerText: clip(goal.instruction, 200) } : {}) },
          nowMs: now,
        });
      }
      if (WORKSTATION.test(c.to) || CONTAINER.test(c.to)) {
        this.book.recordWorldFact({ category: WORKSTATION.test(c.to) ? 'workstation' : 'container', source: 'verified_skill', key: c.to, label: bare(c.to), location: { dimension: conn.dimension, at }, evidence: { ...base, confirmation: 'server_packet', detail: `${capability} produced ${bare(c.to)} at ${fmt(at)} (server block update)` }, nowMs: now });
      }
    }
    for (const c of ev.containers) {
      if (c.dimension !== conn.dimension) continue;
      const at = { x: c.x, y: c.y, z: c.z };
      const key = this.world.observeVoxel(c.x, c.y, c.z) ?? this.book.active().find((f) => f.location && Math.floor(f.location.at.x) === c.x && Math.floor(f.location.at.y) === c.y && Math.floor(f.location.at.z) === c.z && f.key)?.key ?? 'minecraft:chest';
      const contents: Record<string, number> = {};
      for (const [k, n] of Object.entries(c.contents)) if (n > 0 && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(k)) contents[k] = n;
      const category = WORKSTATION.test(key) ? 'workstation' : 'container';
      this.book.recordWorldFact({
        category,
        source: 'verified_skill',
        key,
        label: bare(key),
        location: { dimension: conn.dimension, at },
        container: { block: key, contents, observedAtMs: c.atMs, via: (c.via ?? capability).replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'skill' },
        evidence: { ...base, confirmation: 'server_sync', detail: `${c.via ?? capability} read ${Object.keys(contents).length} item kind(s) in ${bare(key)} at ${fmt(at)} (server window sync; historical)` },
        nowMs: now,
      });
    }
    // Interrupted placement: commands after the last server confirmation have UNKNOWN effects.
    const partial = (outcome.evidence as Record<string, unknown>)['partialEffects'] as { additional?: string; commandsAfterLastConfirmation?: number } | undefined;
    if (outcome.status === 'cancelled' && outcome.goalId && partial?.additional === 'unknown') {
      this.book.addUnknownEffect(outcome.goalId, { atMs: now, capability, commandsAfterLastConfirmation: Math.max(0, Math.round(partial.commandsAfterLastConfirmation ?? 0)), detail: clip(`cancelled ${capability}: ${outcome.effect}`, 200) }, now);
    }
    if (this.book.version !== before) void this.persist('skill_outcome');
  }

  // ------------------------------------------------------------ skill operations

  /** Owner texts for a goal (instruction + clarification answers), or undefined. */
  ownerTexts(goalId: string | undefined): string[] | undefined {
    if (!goalId) return undefined;
    const g = this.goals.get(goalId);
    return g ? [g.instruction, ...g.answers] : undefined;
  }

  /**
   * Owner designation of a code-grounded location. Trusted (owner_statement)
   * only when every content word of the label is in the owner's own words;
   * otherwise stored as an UNVERIFIED note (never a target).
   */
  async designate(input: { goalId?: string; category: MemoryCategory; label: string; location: MemoryLocation; basis: string; key?: string; note?: string; actionId?: string }): Promise<MemoryWriteOutcome> {
    this.ensureScope();
    if (!this.writable || !this.book) return { ok: false, reason: 'memory_not_writable', detail: `memory cannot be written: ${this.status().detail}` };
    const texts = this.ownerTexts(input.goalId);
    if (!texts) return { ok: false, reason: 'owner_text_unavailable', detail: 'the owner instruction of this goal is not known to memory; nothing was written' };
    const now = this.options.clock.now();
    const ids = evidenceIds({ goalId: input.goalId, actionId: input.actionId });
    const grounding = ownerGrounding(input.label, texts);
    const before = this.captureFacts();
    if (!grounding) {
      const r = this.book.note({ label: input.label, text: clip(`unverified ${input.category} "${input.label}" at ${fmt(input.location.at)} in ${input.location.dimension} (${input.basis}); the owner's words do not contain this label${input.note ? `; ${input.note}` : ''}`, 200), evidence: { kind: 'planner_note', atMs: now, detail: clip(`planner-proposed ${input.category} label not found in owner text; ${input.basis}`, 200), ...ids }, nowMs: now, ...(input.goalId ? { goalId: input.goalId } : {}) });
      const out = await this.persistOutcome(r.fact, r.change, [], `stored as an UNVERIFIED note: the owner's words do not contain "${clip(input.label, 40)}"`, before);
      return out.ok ? { ...out, downgraded: true } : out;
    }
    const r = this.book.designate({
      category: input.category,
      label: input.label,
      location: input.location,
      ...(input.key ? { key: input.key } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      evidence: { kind: 'owner_instruction', atMs: now, detail: clip(`owner designated "${input.label}" (${input.category}); location: ${input.basis}`, 200), ownerText: grounding.excerpt, confirmation: 'local_memory', ...ids },
      nowMs: now,
    });
    return this.persistOutcome(r.fact, r.change, r.affected.map((f) => f.id), r.affected.length ? `supersedes ${r.affected.map((f) => f.id).join(', ')}` : r.change === 'created' ? 'new owner designation' : 'confirmed existing designation', before);
  }

  /** Planner/decision note: always UNVERIFIED (never trusted, never a target). */
  async note(input: { goalId?: string; label: string; text: string; actionId?: string }): Promise<MemoryWriteOutcome> {
    this.ensureScope();
    if (!this.writable || !this.book) return { ok: false, reason: 'memory_not_writable', detail: `memory cannot be written: ${this.status().detail}` };
    const now = this.options.clock.now();
    const before = this.captureFacts();
    const r = this.book.note({ label: input.label, text: input.text, evidence: { kind: 'planner_note', atMs: now, detail: clip(`unverified note: ${input.text}`, 200), ...evidenceIds({ goalId: input.goalId, actionId: input.actionId }) }, nowMs: now, ...(input.goalId ? { goalId: input.goalId } : {}) });
    return this.persistOutcome(r.fact, r.change, [], 'unverified note', before);
  }

  /**
   * Owner forgetting by fact id and/or label. Refused unless the forgotten
   * fact's label is in the owner's own words (forgetting is destructive).
   */
  async forget(input: { goalId?: string; factId?: string; label?: string; actionId?: string }): Promise<MemoryWriteOutcome & { forgotten?: string[] }> {
    this.ensureScope();
    if (!this.writable || !this.book) return { ok: false, reason: 'memory_not_writable', detail: `memory cannot be written: ${this.status().detail}` };
    const texts = this.ownerTexts(input.goalId);
    if (!texts) return { ok: false, reason: 'owner_text_unavailable', detail: 'the owner instruction of this goal is not known to memory; nothing was forgotten' };
    const targets = input.factId ? [this.book.get(input.factId)].filter((f): f is MemoryFact => Boolean(f && f.status === 'active')) : input.label ? this.book.activeByLabel(input.label) : [];
    if (input.factId && input.label) for (const f of [...targets]) if (f.labelKey !== labelKey(input.label)) targets.splice(targets.indexOf(f), 1);
    if (targets.length === 0) return { ok: false, reason: 'unknown_memory', detail: `no active remembered fact ${input.factId ?? ''}${input.label ? ` labeled "${clip(input.label, 40)}"` : ''} in this world profile` };
    const grounded = targets.filter((f) => ownerGrounding(f.label, texts));
    if (grounded.length === 0) return { ok: false, reason: 'not_owner_grounded', detail: `the owner's words do not name "${clip(targets[0]?.label ?? '', 40)}"; ask the owner which memory to forget` };
    const now = this.options.clock.now();
    const before = this.captureFacts();
    for (const f of grounded) this.book.forget(f, { kind: 'owner_instruction', atMs: now, detail: 'owner asked to forget this', ownerText: clip(texts[0] ?? '', 200), confirmation: 'local_memory', ...evidenceIds({ goalId: input.goalId, actionId: input.actionId }) }, now);
    const out = await this.persistOutcome(grounded[0] as MemoryFact, 'updated', grounded.map((f) => f.id), `forgot ${grounded.map((f) => `${f.id} (${f.label})`).join(', ')}`, before);
    return { ...out, forgotten: grounded.map((f) => f.id) };
  }

  /** Copies of the current facts (rollback point for one owner/skill write). */
  private captureFacts(): Map<string, MemoryFact> {
    return new Map((this.book?.facts() ?? []).map((f) => [f.id, structuredClone(f)]));
  }

  /**
   * Persists one owner/skill write. On a failed durable write the operation is
   * ROLLED BACK in memory (its facts restored, created facts dropped, write
   * sequence restored), so neither memory nor any predicate claims an effect
   * that the last complete revision does not contain.
   */
  private async persistOutcome(fact: MemoryFact, change: WriteResult['change'], affected: string[], detail: string, before?: Map<string, MemoryFact>): Promise<MemoryWriteOutcome> {
    const touched = [fact.id, ...affected];
    const priorSeq = new Map(touched.map((id) => [id, this.factWriteSeq.get(id)]));
    this.writeSeq += 1;
    for (const id of touched) this.factWriteSeq.set(id, this.writeSeq);
    const revision = await this.persist('skill');
    if (revision === undefined) {
      if (before && this.book) {
        this.book.restoreFacts(touched.map((id) => before.get(id)).filter((f): f is MemoryFact => Boolean(f)), touched.filter((id) => !before.has(id)));
        for (const [id, seq] of priorSeq) {
          if (seq === undefined) this.factWriteSeq.delete(id);
          else this.factWriteSeq.set(id, seq);
        }
        this.options.record?.({ type: 'memory_write_rolled_back', facts: touched });
      }
      return { ok: false, reason: 'memory_write_failed', detail: `the durable write failed (${this.lastWriteError ?? 'unknown error'}); the change was rolled back and the previous complete revision is intact` };
    }
    return { ok: true, fact: structuredClone(fact), change, trusted: isTrusted(fact), storeRevision: revision, affected, detail };
  }

  // ------------------------------------------------------------ refs / predicates

  /** Resolves an executable ref under the mandatory ownership fence (goal epoch [+ id], connection, dimension). */
  resolveRef(refId: string, fence: MemoryRefFence): ResolvedMemoryRef | { error: string; detail: string } {
    this.ensureScope();
    if (!this.readable || !this.book) return { error: 'memory_unavailable', detail: `memory is not usable: ${this.status().detail}` };
    const book = this.book;
    return this.refs.resolve(refId, fence, (id) => book.get(id));
  }

  /** Current write sequence (capture when a memory_state predicate is bound). */
  memoryBaseline(): number {
    return this.writeSeq;
  }

  /**
   * `recorded`/`noted`: a matching fact was written by an owner/skill memory
   * write AFTER the captured write-sequence baseline and is durable.
   * `forgotten`: no active fact with the label (already absent counts).
   * Disabled, conflicted, read-only or unreadable memory is always `unknown`.
   */
  evaluateMemoryState(p: MemoryStatePredicate, binding: MemoryStateBinding): MemoryStateEvaluation {
    const out = (status: MemoryStateEvaluation['status'], detail: string, evidence: MemoryStateEvaluation['evidence'] = {}): MemoryStateEvaluation => ({ status, predicate: 'memory_state', detail, evidence: { confirmation: 'local_memory_store', baseline: binding.memoryBaseline, ...evidence } });
    const state = this.state;
    if (!this.readable || !this.book || !(state === 'ready' || state === 'empty' || state === 'recovered' || state === 'migrated')) return out('unknown', `memory is not usable (${state}): ${this.status().detail}`);
    const matches = this.book.activeByLabel(p.label);
    if (p.expect === 'forgotten') {
      // Absence counts only when it is DURABLE: the last complete revision must not contain the label either.
      if (matches.length > 0) return out('unsatisfied', `${matches.length} active memory fact(s) labeled "${clip(p.label, 40)}" remain`, { facts: matches.map((f) => f.id).join(',') });
      if (this.durableActiveLabels.has(labelKey(p.label))) {
        return out('unknown', `forgetting "${clip(p.label, 40)}" is not durable yet: the last complete revision ${this.store?.revision ?? 0} still contains it (write pending or failed)`, { pendingWrites: this.store?.pending ?? 0, storeRevision: this.store?.revision ?? 0 });
      }
      return out('satisfied', `no active memory labeled "${clip(p.label, 40)}" in this world profile, in memory and in the last complete revision ${this.store?.revision ?? 0}`, { storeRevision: this.store?.revision ?? 0 });
    }
    const wantTrusted = p.expect === 'recorded';
    const after = (f: MemoryFact) => (this.factWriteSeq.get(f.id) ?? 0) > binding.memoryBaseline;
    const written = matches.filter((f) => isTrusted(f) === wantTrusted && after(f));
    if (written.length === 0) {
      const other = matches.filter((f) => isTrusted(f) !== wantTrusted && after(f));
      return out('unsatisfied', other.length ? `only ${wantTrusted ? 'an UNVERIFIED note' : 'a trusted fact'} labeled "${clip(p.label, 40)}" was written since binding` : `no ${wantTrusted ? 'trusted fact' : 'note'} labeled "${clip(p.label, 40)}" was written since binding (older memory does not count)`);
    }
    const durable = written.filter((f) => (this.durable.get(f.id) ?? 0) >= f.revision);
    if (durable.length === 0) return out('unknown', `memory write for "${clip(p.label, 40)}" is not durable yet (write pending or failed)`, { pendingWrites: this.store?.pending ?? 0 });
    const f = durable[0] as MemoryFact;
    return out('satisfied', `${wantTrusted ? 'trusted' : 'unverified'} memory "${clip(f.label, 40)}" (${f.id}, ${f.source}) durably written at store revision ${this.store?.revision ?? 0} (local memory confirmation, not a world effect)`, { factId: f.id, source: f.source, factRevision: f.revision, writeSeq: this.factWriteSeq.get(f.id) ?? 0, storeRevision: this.store?.revision ?? 0 });
  }

  // ------------------------------------------------------------ persistence

  private persistSoon(): void {
    if (this.persistTimer || this.closed) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist('observation');
    }, this.options.observationPersistMs ?? 10_000);
    this.persistTimer.unref?.();
  }

  /** Persists the current book if it changed (coalesced). Resolves with the durable store revision, or undefined on failure. */
  persist(reason: string): Promise<number | undefined> {
    if (!this.store || !this.book || !this.store.canWrite) return Promise.resolve(undefined);
    const run = async (): Promise<number | undefined> => {
      const book = this.book as MemoryBook;
      const store = this.store as MemoryFileStore;
      if (book.version === this.persistedVersion) return store.revision;
      book.enforceBounds();
      // A fact that fails the durable schema is quarantined (dropped with evidence), never allowed to block every later write.
      for (const f of book.facts()) {
        const check = MemoryFactSchema.safeParse(f);
        if (!check.success) {
          book.remove(f.id);
          this.options.record?.({ type: 'memory_fact_rejected', factId: f.id, category: f.category, issue: clip(check.error.issues[0]?.message ?? 'invalid', 200) });
        }
      }
      let body = book.body();
      while (JSON.stringify(body).length > MEMORY_BOUNDS.maxStoreBytes * 0.95) {
        const victim = book.evictionCandidate();
        if (!victim) break;
        book.remove(victim.id);
        body = book.body();
      }
      const version = book.version;
      try {
        const revision = await store.write(body);
        this.persistedVersion = version;
        this.durable = new Map(body.facts.map((f) => [f.id, f.revision]));
        this.durableActiveLabels = new Set(body.facts.filter((f) => f.status === 'active').map((f) => f.labelKey));
        this.lastWriteError = undefined;
        this.options.record?.({ type: 'memory_written', reason, revision, facts: body.facts.length });
        return revision;
      } catch (error) {
        this.lastWriteError = error instanceof Error ? error.message : String(error);
        this.options.record?.({ type: 'memory_write_failed', reason, error: clip(this.lastWriteError, 300) });
        return undefined;
      }
    };
    const chained = (this.persisting ?? Promise.resolve(undefined)).then(run, run);
    this.persisting = chained;
    return chained;
  }

  /** Persists pending changes now and waits for every queued write. */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persist('flush');
    await this.store?.flush();
  }

  /** Shutdown: flush, then release the writer lock. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    await this.store?.close();
  }

  /** Read-only snapshot of facts (operator inspection/tests). */
  facts(): readonly MemoryFact[] {
    return this.book ? structuredClone(this.book.facts()) : [];
  }
}

/** Root memory directory for a data dir and config (`<dataDir>/<dir>`). */
export function memoryRoot(dataDir: string, config: MemoryConfig | undefined): string {
  return join(dataDir, config?.dir ?? 'memory');
}
