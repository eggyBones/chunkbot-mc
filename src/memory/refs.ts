// Code-owned ledger of issued memory references.
//
// EXECUTABLE refs (`mref-`) are issued only to an ADMITTED goal subject for one
// planner request, on one connection, in one dimension, for one trusted located
// fact at one exact location. Resolution requires the mandatory fence (owning
// goal epoch [+ goal id], current connection and dimension) and an active fact
// whose location still matches; anything else fails closed. Ids are
// `<per-run nonce><monotonic counter>` in base36: never reused in a run (no
// wrap-around), and a different run's ids never collide.
//
// PREPARED refs (`mprep-`) are shown to a non-admitted preparation subject.
// They never resolve for execution; after the real admission they can only be
// re-grounded to a fresh executable ref of the SAME still-active fact.
//
// Lifecycle interruptions (death, respawn, dimension change, disconnect) void
// every transient ref; goal end and preparation discard void theirs; a goal
// keeps refs of at most `refRequestsPerGoal` recent requests.
import { randomBytes } from 'node:crypto';
import { MEMORY_BOUNDS, type MemoryFact, type MemoryFactId, type MemoryRefFence, type MemoryRefId, type PreparedMemoryRefId, type ResolvedMemoryRef } from '../contracts/memory.ts';

interface Located {
  factId: string;
  /** Fact identity at issuance (revision, category, key). */
  factRevision: number;
  category: string;
  key: string | undefined;
  connectionEpoch: number;
  dimension: string;
  at: { x: number; y: number; z: number };
  label: string;
  requestId: string;
}

interface GoalRef extends Located {
  refId: MemoryRefId;
  goalId: string;
  goalEpoch: number;
}

interface PrepRef extends Located {
  refId: PreparedMemoryRefId;
  intentId: string;
  generation: number;
}

const MAX_COUNTER = 36 ** 8 - 1;
const identity = (f: MemoryFact) => ({ factId: f.id, factRevision: f.revision, category: f.category, key: f.key });
const sameAt = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => a.x === b.x && a.y === b.y && a.z === b.z;
const r1 = (n: number) => Math.round(n * 10) / 10;

export class MemoryRefRegistry {
  private readonly nonce: string;
  private counter = 0;
  private readonly goalRefs = new Map<string, GoalRef>();
  private readonly prepRefs = new Map<string, PrepRef>();
  private readonly goalRequests = new Map<string, string[]>();
  /** Lifecycle generation: bumped by every invalidation. */
  generation = 0;

  constructor(nonce?: string) {
    this.nonce = (nonce ?? randomBytes(4).readUInt32BE(0).toString(36)).replace(/[^a-z0-9]/g, '').padStart(4, '0').slice(0, 6);
  }

  private nextId(): string {
    if (this.counter >= MAX_COUNTER) throw new Error('memory reference id space exhausted for this run');
    this.counter += 1;
    return `${this.nonce}${this.counter.toString(36).padStart(4, '0')}`;
  }

  /** Executable ref for an ADMITTED goal request. */
  issue(ctx: { goalId: string; goalEpoch: number; requestId: string; connectionEpoch: number; dimension: string }, fact: MemoryFact, at: { x: number; y: number; z: number }, label?: string): MemoryRefId {
    const key = `${ctx.goalId}#${ctx.goalEpoch}`;
    const list = this.goalRequests.get(key) ?? [];
    if (!list.includes(ctx.requestId)) {
      list.push(ctx.requestId);
      while (list.length > MEMORY_BOUNDS.refRequestsPerGoal) {
        const old = list.shift() as string;
        for (const [id, e] of this.goalRefs) if (e.goalId === ctx.goalId && e.goalEpoch === ctx.goalEpoch && e.requestId === old) this.goalRefs.delete(id);
      }
      this.goalRequests.set(key, list);
    }
    const refId = `mref-${this.nextId()}` as MemoryRefId;
    this.goalRefs.set(refId, { refId, goalId: ctx.goalId, goalEpoch: ctx.goalEpoch, requestId: ctx.requestId, connectionEpoch: ctx.connectionEpoch, dimension: ctx.dimension, ...identity(fact), at: { ...at }, label: label ?? fact.label });
    return refId;
  }

  /** Non-executable ref for a preparation request. */
  issuePrepared(ctx: { intentId: string; generation: number; requestId: string; connectionEpoch: number; dimension: string }, fact: MemoryFact, at: { x: number; y: number; z: number }, label?: string): PreparedMemoryRefId {
    // Older generations of the same intent are superseded.
    for (const [id, e] of this.prepRefs) if (e.intentId === ctx.intentId && e.generation !== ctx.generation) this.prepRefs.delete(id);
    const refId = `mprep-${this.nextId()}` as PreparedMemoryRefId;
    this.prepRefs.set(refId, { refId, intentId: ctx.intentId, generation: ctx.generation, requestId: ctx.requestId, connectionEpoch: ctx.connectionEpoch, dimension: ctx.dimension, ...identity(fact), at: { ...at }, label: label ?? fact.label });
    return refId;
  }

  shownFor(goal: { goalId: string; goalEpoch: number }): Set<string> {
    return new Set([...this.goalRefs.values()].filter((e) => e.goalId === goal.goalId && e.goalEpoch === goal.goalEpoch).map((e) => e.refId));
  }

  shownPrepared(prep: { intentId: string; generation: number }): Set<string> {
    return new Set([...this.prepRefs.values()].filter((e) => e.intentId === prep.intentId && e.generation === prep.generation).map((e) => e.refId));
  }

  private checkFact(e: Located, refId: string, fact: (id: string) => MemoryFact | undefined): MemoryFact | { error: string; detail: string } {
    const f = fact(e.factId);
    if (!f || f.status !== 'active') return { error: 'memory_fact_inactive', detail: `the remembered fact behind ${refId} is ${f ? f.status : 'gone'}${f?.statusDetail ? ` (${f.statusDetail})` : ''}` };
    if (f.category !== e.category || f.key !== e.key) return { error: 'memory_fact_changed', detail: `the remembered fact behind ${refId} is no longer the same kind of thing` };
    if (!f.location || f.location.dimension !== e.dimension) return { error: 'memory_fact_moved', detail: `the remembered fact behind ${refId} no longer has this location` };
    // Project checkpoint refs point inside the project; plain facts must still be at the issued location.
    if (f.category !== 'project' && !sameAt({ x: r1(f.location.at.x), y: r1(f.location.at.y), z: r1(f.location.at.z) }, { x: r1(e.at.x), y: r1(e.at.y), z: r1(e.at.z) })) {
      return { error: 'memory_fact_moved', detail: `the remembered fact behind ${refId} was updated to another location` };
    }
    if (f.category === 'project' && !f.project?.checkpoints.some((c) => sameAt(c.at, e.at)) && !sameAt(f.location.at, e.at)) {
      return { error: 'memory_fact_moved', detail: `the project checkpoint behind ${refId} is no longer recorded` };
    }
    return f;
  }

  resolve(refId: string, fence: MemoryRefFence, fact: (id: string) => MemoryFact | undefined): ResolvedMemoryRef | { error: string; detail: string } {
    if (refId.startsWith('mprep-')) return { error: 'prepared_ref_not_admitted', detail: `${refId} was shown to a preparation; it must be re-grounded after admission before any use` };
    const e = this.goalRefs.get(refId);
    if (!e) return { error: 'unknown_memory_ref', detail: `${refId} was not issued for a current goal request (invented, expired, released or invalidated by a lifecycle event)` };
    if (e.goalEpoch !== fence.goalEpoch || (fence.goalId !== null && e.goalId !== fence.goalId)) return { error: 'memory_ref_not_owned', detail: `${refId} belongs to another goal (epoch ${e.goalEpoch}), not goal epoch ${fence.goalEpoch}` };
    if (e.connectionEpoch !== fence.connectionEpoch) return { error: 'stale_connection', detail: `${refId} belongs to an earlier connection` };
    if (e.dimension !== fence.dimension) return { error: 'dimension_mismatch', detail: `${refId} is in ${e.dimension}, not ${fence.dimension}` };
    const f = this.checkFact(e, refId, fact);
    if ('error' in f) return f;
    return {
      refId: e.refId,
      issuedTo: { goalId: e.goalId, goalEpoch: e.goalEpoch, requestId: e.requestId },
      factId: f.id as MemoryFactId,
      factRevision: { issued: e.factRevision, current: f.revision },
      category: f.category,
      label: e.label,
      ...(f.key && f.category !== 'project' ? { key: f.key } : {}),
      dimension: e.dimension,
      at: { ...e.at },
      source: f.source,
      lastConfirmedMs: f.lastConfirmedMs,
    };
  }

  /** Prepared ref -> fresh executable ref of the SAME fact after admission (fails closed). */
  reground(
    prepRefId: string,
    admission: { intentId: string; generation: number; goalId: string; goalEpoch: number; requestId: string; connectionEpoch: number; dimension: string },
    fact: (id: string) => MemoryFact | undefined,
  ): { refId: MemoryRefId; factId: MemoryFactId } | { error: string; detail: string } {
    const e = this.prepRefs.get(prepRefId);
    if (!e) return { error: 'unknown_prepared_ref', detail: `${prepRefId} was not shown to a current preparation (invented, superseded or invalidated)` };
    if (e.intentId !== admission.intentId || e.generation !== admission.generation) return { error: 'prepared_ref_other_preparation', detail: `${prepRefId} belongs to another preparation generation` };
    if (e.connectionEpoch !== admission.connectionEpoch) return { error: 'stale_connection', detail: `${prepRefId} was prepared on an earlier connection` };
    if (e.dimension !== admission.dimension) return { error: 'dimension_mismatch', detail: `${prepRefId} was prepared in ${e.dimension}, not ${admission.dimension}` };
    const f = this.checkFact(e, prepRefId, fact);
    if ('error' in f) return f;
    const refId = this.issue({ goalId: admission.goalId, goalEpoch: admission.goalEpoch, requestId: admission.requestId, connectionEpoch: admission.connectionEpoch, dimension: admission.dimension }, f, e.at, e.label);
    return { refId, factId: f.id as MemoryFactId };
  }

  /** Withdraws refs that were issued but not shown (bound guard). */
  revoke(refIds: readonly string[]): void {
    for (const id of refIds) {
      this.goalRefs.delete(id);
      this.prepRefs.delete(id);
    }
  }

  releaseGoal(goalId: string): void {
    for (const [id, e] of this.goalRefs) if (e.goalId === goalId) this.goalRefs.delete(id);
    for (const key of [...this.goalRequests.keys()]) if (key.startsWith(`${goalId}#`)) this.goalRequests.delete(key);
  }

  releasePreparation(intentId: string): void {
    for (const [id, e] of this.prepRefs) if (e.intentId === intentId) this.prepRefs.delete(id);
  }

  /** Lifecycle interruption: every transient ref is void (durable facts are untouched). */
  invalidateAll(): number {
    const n = this.goalRefs.size + this.prepRefs.size;
    this.goalRefs.clear();
    this.prepRefs.clear();
    this.goalRequests.clear();
    this.generation += 1;
    return n;
  }

  get size(): number {
    return this.goalRefs.size + this.prepRefs.size;
  }
}
