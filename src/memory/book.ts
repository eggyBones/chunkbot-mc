// In-memory fact book over one scope's store body: merge, supersede, forget,
// invalidate, projects, milestones, death incidents and retention bounds.
// Pure (no I/O); the service persists the resulting body atomically.
//
// Rules:
//   - Only code-grounded inputs become trusted facts (observation, verified
//     skill, owner statement). Unverified notes stay untrusted forever; nothing
//     upgrades a note into a trusted fact.
//   - Duplicates merge (same category/key/position or same owner label);
//     evidence is appended (bounded: first + most recent), never replaced.
//   - Contradictions are retained: a contradicted fact becomes `invalid` with
//     the contradicting evidence; a corrected owner designation `supersedes`
//     the old one; forgetting leaves a bounded tombstone.
//   - Retention never evicts the active home, active/interrupted projects or
//     unresolved death incidents.
import {
  MEMORY_BOUNDS,
  type DeathPayload,
  type MemoryCategory,
  type MemoryEvidence,
  type MemoryFact,
  type MemoryLocation,
  type MemoryScope,
  type MemorySource,
  type MemoryStoreBody,
  type ProjectPayload,
} from '../contracts/memory.ts';
import { labelKey } from './labels.ts';

export const SOURCE_RANK: Record<MemorySource, number> = { unverified_note: 0, observation: 1, verified_skill: 2, owner_statement: 3 };

export function isTrusted(fact: Pick<MemoryFact, 'source'>): boolean {
  return fact.source !== 'unverified_note';
}

/** Whether retention must keep this fact. */
export function isProtected(fact: MemoryFact): boolean {
  if (fact.status !== 'active') return false;
  if (fact.category === 'home') return true;
  if (fact.category === 'project') return fact.project?.state === 'active' || fact.project?.state === 'interrupted';
  if (fact.category === 'death') return fact.death?.recovery.status === 'unresolved' || fact.death?.recovery.status === 'partially_recovered';
  return false;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
export const roundAt = (at: { x: number; y: number; z: number }) => ({ x: r1(at.x), y: r1(at.y), z: r1(at.z) });
const sameBlock = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.y) === Math.floor(b.y) && Math.floor(a.z) === Math.floor(b.z);
const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, d: number) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= d;
/** 16-block cell used to aggregate resource sightings. */
const cell = (at: { x: number; y: number; z: number }) => `${Math.floor(at.x / 16)},${Math.floor(at.y / 16)},${Math.floor(at.z / 16)}`;

export interface WriteResult {
  fact: MemoryFact;
  /** `created`, `confirmed` (evidence added), `updated` (content changed), `unchanged`. */
  change: 'created' | 'confirmed' | 'updated' | 'unchanged';
  /** Facts superseded or invalidated by this write. */
  affected: MemoryFact[];
}

export class MemoryBook {
  private readonly data: MemoryStoreBody;
  /** Monotonic write counter for dirty tracking. */
  version = 0;

  constructor(scope: MemoryScope, nowMs: number, body?: MemoryStoreBody) {
    this.data = body ? structuredClone(body) : { scope, createdAtMs: nowMs, facts: [], nextFact: 1, evicted: 0 };
  }

  body(): MemoryStoreBody {
    return structuredClone(this.data);
  }

  get scope(): MemoryScope {
    return this.data.scope;
  }

  get endpoint(): MemoryStoreBody['endpoint'] {
    return this.data.endpoint;
  }

  bindEndpoint(endpoint: string, nowMs: number): void {
    this.data.endpoint = { endpoint: endpoint.slice(0, 300), boundAtMs: nowMs };
    this.version += 1;
  }

  get evicted(): number {
    return this.data.evicted;
  }

  facts(): readonly MemoryFact[] {
    return this.data.facts;
  }

  active(): MemoryFact[] {
    return this.data.facts.filter((f) => f.status === 'active');
  }

  get(id: string): MemoryFact | undefined {
    return this.data.facts.find((f) => f.id === id);
  }

  activeByLabel(label: string): MemoryFact[] {
    const key = labelKey(label);
    return this.active().filter((f) => f.labelKey === key);
  }

  private newId(): string {
    const n = this.data.nextFact;
    this.data.nextFact += 1;
    return `mf-${n.toString(36).padStart(4, '0')}`;
  }

  private addEvidence(fact: MemoryFact, ev: MemoryEvidence): void {
    const list = fact.evidence;
    if (list.length >= MEMORY_BOUNDS.evidencePerFact) list.splice(1, 1); // keep the first (origin) and the most recent
    list.push(ev);
    fact.evidenceCount += 1;
  }

  private touch(fact: MemoryFact, nowMs: number): void {
    fact.revision += 1;
    this.version += 1;
    void nowMs;
  }

  private create(input: {
    category: MemoryCategory;
    label: string;
    source: MemorySource;
    evidence: MemoryEvidence;
    nowMs: number;
    key?: string;
    location?: MemoryLocation;
    note?: string;
    seenCount?: number;
    container?: MemoryFact['container'];
    project?: ProjectPayload;
    milestone?: MemoryFact['milestone'];
    death?: DeathPayload;
    goalId?: string;
    supersedes?: string;
  }): MemoryFact {
    const fact: MemoryFact = {
      id: this.newId(),
      category: input.category,
      label: input.label.trim().slice(0, 80) || input.category,
      labelKey: labelKey(input.label),
      ...(input.key ? { key: input.key } : {}),
      ...(input.location ? { location: { dimension: input.location.dimension, at: roundAt(input.location.at) } } : {}),
      source: input.source,
      evidence: [input.evidence],
      evidenceCount: 1,
      firstRecordedMs: input.nowMs,
      lastConfirmedMs: input.nowMs,
      revision: 1,
      status: 'active',
      ...(input.note ? { note: input.note.slice(0, 200) } : {}),
      ...(input.seenCount ? { seenCount: input.seenCount } : {}),
      ...(input.container ? { container: input.container } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.milestone ? { milestone: input.milestone } : {}),
      ...(input.death ? { death: input.death } : {}),
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    this.data.facts.push(fact);
    this.version += 1;
    return fact;
  }

  private setStatus(fact: MemoryFact, status: MemoryFact['status'], detail: string, nowMs: number, ev?: MemoryEvidence): void {
    fact.status = status;
    fact.statusDetail = detail.slice(0, 200);
    fact.statusAtMs = nowMs;
    if (ev) this.addEvidence(fact, ev);
    this.touch(fact, nowMs);
  }

  /**
   * A located fact derived by code from perception (`observation`) or a
   * server-confirmed skill outcome (`verified_skill`). Workstations and
   * containers merge by exact block; resources aggregate per 16-block cell.
   * A different block kind at a remembered workstation/container position
   * invalidates the old fact (the world changed) and records the new one.
   */
  recordWorldFact(input: {
    category: 'workstation' | 'container' | 'resource' | 'hazard' | 'location';
    source: 'observation' | 'verified_skill';
    key: string;
    label: string;
    location: MemoryLocation;
    evidence: MemoryEvidence;
    nowMs: number;
    seenCount?: number;
    container?: MemoryFact['container'];
  }): WriteResult {
    const affected: MemoryFact[] = [];
    const sameDim = (f: MemoryFact) => f.location?.dimension === input.location.dimension;
    let existing: MemoryFact | undefined;
    if (input.category === 'resource') {
      const c = cell(input.location.at);
      existing = this.active().find((f) => f.category === 'resource' && f.key === input.key && sameDim(f) && f.location && cell(f.location.at) === c);
    } else {
      for (const f of this.active()) {
        if (!sameDim(f) || !f.location || (f.category !== 'workstation' && f.category !== 'container') || !sameBlock(f.location.at, input.location.at)) continue;
        if (f.key === input.key && f.category === input.category) existing = f;
        else if (f.source !== 'owner_statement') {
          this.setStatus(f, 'invalid', `${input.key} is at this position now (was ${f.key ?? f.category})`, input.nowMs, input.evidence);
          affected.push(f);
        }
      }
    }
    if (!existing) {
      const fact = this.create({ ...input, ...(input.seenCount ? { seenCount: input.seenCount } : {}) });
      return { fact, change: 'created', affected };
    }
    // Throttle repeated identical observations: refresh the confirmation time, add evidence at most once a minute.
    const lastEv = existing.evidence.at(-1);
    const repeat = lastEv && lastEv.kind === input.evidence.kind && input.evidence.kind === 'observation' && input.nowMs - lastEv.atMs < 60_000;
    existing.lastConfirmedMs = Math.max(existing.lastConfirmedMs, input.nowMs);
    let change: WriteResult['change'] = 'confirmed';
    if (!repeat) this.addEvidence(existing, input.evidence);
    if (SOURCE_RANK[input.source] > SOURCE_RANK[existing.source]) {
      existing.source = input.source;
      change = 'updated';
    }
    if (input.seenCount && input.seenCount !== existing.seenCount) existing.seenCount = input.seenCount;
    if (input.container) {
      existing.container = input.container;
      change = 'updated';
    }
    if (repeat && change === 'confirmed') {
      // Freshness only; no revision bump for a sub-minute repeat.
      this.version += 1;
      return { fact: existing, change: 'unchanged', affected };
    }
    this.touch(existing, input.nowMs);
    return { fact: existing, change, affected };
  }

  /** Direct observation that a remembered workstation/container/resource is no longer there. */
  contradict(fact: MemoryFact, detail: string, evidence: MemoryEvidence, nowMs: number): void {
    if (fact.status !== 'active') return;
    this.setStatus(fact, 'invalid', detail, nowMs, evidence);
  }

  /**
   * Owner designation ("remember this as home"). The label is owner-grounded
   * and the location code-grounded (caller validated both). A home is unique
   * per scope; the same label at a different place supersedes the old fact
   * (owner correction); the same place re-confirms it.
   */
  designate(input: { category: MemoryCategory; label: string; location: MemoryLocation; evidence: MemoryEvidence; nowMs: number; key?: string; note?: string; goalId?: string }): WriteResult {
    const key = labelKey(input.label);
    const affected: MemoryFact[] = [];
    const conflicts = this.active().filter((f) => f.source !== 'unverified_note' && (f.labelKey === key || (input.category === 'home' && f.category === 'home')) && f.category !== 'death' && f.category !== 'project' && f.category !== 'milestone');
    const same = conflicts.find((f) => f.location && f.location.dimension === input.location.dimension && near(f.location.at, input.location.at, 1.5) && f.category === input.category && f.labelKey === key);
    if (same) {
      same.lastConfirmedMs = input.nowMs;
      this.addEvidence(same, input.evidence);
      const upgraded = same.source !== 'owner_statement';
      same.source = 'owner_statement';
      if (input.note) same.note = input.note.slice(0, 200);
      this.touch(same, input.nowMs);
      return { fact: same, change: upgraded ? 'updated' : 'confirmed', affected };
    }
    const fact = this.create({ ...input, source: 'owner_statement', ...(conflicts[0] ? { supersedes: conflicts[0].id } : {}) });
    for (const old of conflicts) {
      old.supersededBy = fact.id;
      this.setStatus(old, 'superseded', `replaced by owner designation ${fact.id} (${fact.label})`, input.nowMs, input.evidence);
      affected.push(old);
    }
    return { fact, change: 'created', affected };
  }

  /** Unverified note (planner suggestion or ungrounded designation). Never trusted. */
  note(input: { label: string; text: string; evidence: MemoryEvidence; nowMs: number; goalId?: string; category?: MemoryCategory }): WriteResult {
    const key = labelKey(input.label);
    const existing = this.active().find((f) => f.source === 'unverified_note' && f.labelKey === key);
    if (existing) {
      existing.note = input.text.slice(0, 200);
      existing.lastConfirmedMs = input.nowMs;
      this.addEvidence(existing, input.evidence);
      this.touch(existing, input.nowMs);
      return { fact: existing, change: 'updated', affected: [] };
    }
    const fact = this.create({ category: input.category ?? 'note', label: input.label, source: 'unverified_note', evidence: input.evidence, nowMs: input.nowMs, note: input.text, ...(input.goalId ? { goalId: input.goalId } : {}) });
    return { fact, change: 'created', affected: [] };
  }

  /** Owner forgetting: tombstone (bounded), never a hard delete of other scopes/caches. */
  forget(fact: MemoryFact, evidence: MemoryEvidence, nowMs: number): void {
    this.setStatus(fact, 'forgotten', `forgotten by the owner`, nowMs, evidence);
  }

  // ------------------------------------------------------------ projects

  projectForGoal(goalId: string): MemoryFact | undefined {
    return this.data.facts.find((f) => f.category === 'project' && f.goalId === goalId && f.status === 'active');
  }

  /** Adds a server-confirmed block change to the goal's construction project (creating it). */
  addCheckpoint(input: { goalId: string; label: string; dimension: string; checkpoint: ProjectPayload['checkpoints'][number]; evidence: MemoryEvidence; nowMs: number }): MemoryFact {
    let fact = this.projectForGoal(input.goalId);
    if (!fact) {
      fact = this.create({
        category: 'project',
        label: input.label,
        source: 'verified_skill',
        evidence: input.evidence,
        nowMs: input.nowMs,
        location: { dimension: input.dimension, at: input.checkpoint.at },
        goalId: input.goalId,
        project: { state: 'active', checkpoints: [], checkpointsOmitted: 0, unknownEffects: [], updatedAtMs: input.nowMs },
      });
    } else this.addEvidence(fact, input.evidence);
    const p = fact.project as ProjectPayload;
    const dup = p.checkpoints.findIndex((c) => sameBlock(c.at, input.checkpoint.at));
    if (dup >= 0) p.checkpoints.splice(dup, 1); // latest confirmed state of that block wins
    p.checkpoints.push({ ...input.checkpoint, at: roundAt(input.checkpoint.at) });
    if (p.checkpoints.length > MEMORY_BOUNDS.checkpointsPerProject) {
      p.checkpoints.splice(0, p.checkpoints.length - MEMORY_BOUNDS.checkpointsPerProject);
      p.checkpointsOmitted += 1;
    }
    p.updatedAtMs = input.nowMs;
    fact.lastConfirmedMs = input.nowMs;
    this.touch(fact, input.nowMs);
    return fact;
  }

  addUnknownEffect(goalId: string, effect: ProjectPayload['unknownEffects'][number], nowMs: number): MemoryFact | undefined {
    const fact = this.projectForGoal(goalId);
    if (!fact?.project) return undefined;
    fact.project.unknownEffects.push(effect);
    if (fact.project.unknownEffects.length > MEMORY_BOUNDS.unknownEffectsPerProject) fact.project.unknownEffects.splice(0, fact.project.unknownEffects.length - MEMORY_BOUNDS.unknownEffectsPerProject);
    fact.project.updatedAtMs = nowMs;
    this.touch(fact, nowMs);
    return fact;
  }

  setProjectState(goalId: string, state: ProjectPayload['state'], evidence: MemoryEvidence, nowMs: number): MemoryFact | undefined {
    const fact = this.projectForGoal(goalId);
    if (!fact?.project || fact.project.state === state) return fact;
    fact.project.state = state;
    fact.project.updatedAtMs = nowMs;
    this.addEvidence(fact, evidence);
    this.touch(fact, nowMs);
    return fact;
  }

  addMilestone(input: { label: string; summary: string; evidence: MemoryEvidence; nowMs: number; goalId?: string; location?: MemoryLocation }): MemoryFact {
    return this.create({
      category: 'milestone',
      label: input.label,
      source: 'verified_skill',
      evidence: input.evidence,
      nowMs: input.nowMs,
      milestone: { outcome: 'verified', summary: input.summary.slice(0, 1_000), completedAtMs: input.nowMs },
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.location ? { location: input.location } : {}),
    });
  }

  // ------------------------------------------------------------ deaths

  unresolvedDeaths(): MemoryFact[] {
    return this.active().filter((f) => f.category === 'death' && (f.death?.recovery.status === 'unresolved' || f.death?.recovery.status === 'partially_recovered'));
  }

  /**
   * New own death incident. If an unresolved incident exists, the new one is
   * `relatedTo` the ORIGINAL (oldest unresolved) and never overwrites it.
   */
  addDeath(input: { location?: MemoryLocation; death: Omit<DeathPayload, 'relatedTo' | 'recovery'>; evidence: MemoryEvidence; nowMs: number }): MemoryFact {
    const original = this.unresolvedDeaths().sort((a, b) => a.firstRecordedMs - b.firstRecordedMs)[0];
    const relatedTo = original ? (original.death?.relatedTo ?? original.id) : undefined;
    const missing = input.death.lastAliveInventory.items.map((i) => ({ key: i.key, count: i.count }));
    return this.create({
      category: 'death',
      label: relatedTo ? 'related death' : 'death',
      source: 'observation',
      evidence: input.evidence,
      nowMs: input.nowMs,
      ...(input.location ? { location: input.location } : {}),
      death: {
        ...input.death,
        ...(relatedTo ? { relatedTo } : {}),
        recovery: { status: 'unresolved', regained: [], missing, updatedAtMs: input.nowMs },
      },
    });
  }

  /** Verified regained items reduce `missing`; status follows. Only verified evidence may call this. */
  updateDeathRecovery(id: string, update: { regained?: Array<{ key: string; count: number }>; status?: 'abandoned'; detail?: string }, evidence: MemoryEvidence, nowMs: number): MemoryFact | undefined {
    const fact = this.get(id);
    const d = fact?.death;
    if (!fact || !d) return undefined;
    for (const g of update.regained ?? []) {
      if (g.count <= 0) continue;
      d.recovery.regained.push({ key: g.key, count: g.count, atMs: nowMs });
      const m = d.recovery.missing.find((x) => x.key === g.key);
      if (m) m.count = Math.max(0, m.count - g.count);
    }
    d.recovery.missing = d.recovery.missing.filter((m) => m.count > 0);
    if (d.recovery.regained.length > 32) d.recovery.regained.splice(0, d.recovery.regained.length - 32);
    d.recovery.status = update.status ?? (d.recovery.missing.length === 0 ? 'recovered' : d.recovery.regained.length > 0 ? 'partially_recovered' : 'unresolved');
    d.recovery.updatedAtMs = nowMs;
    if (update.detail) d.recovery.detail = update.detail.slice(0, 200);
    this.addEvidence(fact, evidence);
    this.touch(fact, nowMs);
    return fact;
  }

  // ------------------------------------------------------------ retention

  /** Applies category caps and the global bound. Returns the number of facts removed. */
  enforceBounds(maxFacts: number = MEMORY_BOUNDS.maxFacts): number {
    const before = this.data.facts.length;
    const drop = (ids: Set<string>) => {
      if (ids.size === 0) return;
      this.data.facts = this.data.facts.filter((f) => !ids.has(f.id));
    };
    const oldest = (list: MemoryFact[], keep: number) => new Set(list.sort((a, b) => (b.statusAtMs ?? b.lastConfirmedMs) - (a.statusAtMs ?? a.lastConfirmedMs)).slice(keep).map((f) => f.id));
    drop(oldest(this.data.facts.filter((f) => f.status !== 'active'), MEMORY_BOUNDS.tombstones));
    drop(oldest(this.data.facts.filter((f) => f.category === 'milestone'), MEMORY_BOUNDS.milestones));
    drop(oldest(this.data.facts.filter((f) => f.category === 'death' && !isProtected(f)), Math.max(0, MEMORY_BOUNDS.deathIncidents - this.unresolvedDeaths().length)));
    drop(oldest(this.data.facts.filter((f) => f.category === 'project' && !isProtected(f)), MEMORY_BOUNDS.activeProjects));
    // Interrupted/active projects beyond their cap: the oldest are abandoned (kept as unprotected history).
    const live = this.data.facts.filter((f) => f.category === 'project' && isProtected(f)).sort((a, b) => b.lastConfirmedMs - a.lastConfirmedMs);
    for (const f of live.slice(MEMORY_BOUNDS.activeProjects)) if (f.project) f.project.state = 'abandoned';
    while (this.data.facts.length > maxFacts) {
      const victim = this.evictionCandidate();
      if (!victim) break;
      drop(new Set([victim.id]));
    }
    const removed = before - this.data.facts.length;
    if (removed > 0) {
      this.data.evicted += removed;
      this.version += 1;
    }
    return removed;
  }

  /** Lowest-value unprotected fact: tombstones, notes, observations, verified, owner statements; oldest first. */
  evictionCandidate(): MemoryFact | undefined {
    const tier = (f: MemoryFact) => (f.status !== 'active' ? 0 : f.source === 'unverified_note' ? 1 : f.source === 'observation' ? 2 : f.source === 'verified_skill' ? 3 : 4);
    return this.data.facts
      .filter((f) => !isProtected(f))
      .sort((a, b) => tier(a) - tier(b) || a.lastConfirmedMs - b.lastConfirmedMs)[0];
  }

  /** Removes one fact by id (byte-bound pruning). */
  remove(id: string): void {
    const n = this.data.facts.length;
    this.data.facts = this.data.facts.filter((f) => f.id !== id);
    if (this.data.facts.length !== n) {
      this.data.evicted += 1;
      this.version += 1;
    }
  }
}
