// Request-bound executable memory references (`mref-N`).
//
// A ref is issued for ONE planner request of ONE goal, on ONE connection, in
// ONE dimension, for one trusted located fact. It is never persisted. It stops
// resolving when the goal ends, when the goal has issued more than
// `refRequestsPerGoal` newer requests, on any lifecycle interruption (death,
// respawn, dimension change, disconnect), or when the fact is no longer active.
// A resolved ref is remembered (historical) evidence: it can justify bounded
// travel or name where to look, but never proves presence, contents or success.
import { MEMORY_BOUNDS, type MemoryFact, type MemoryRefId, type ResolvedMemoryRef } from '../contracts/memory.ts';

interface RefEntry {
  refId: MemoryRefId;
  goalId: string;
  goalEpoch: number;
  requestId: string;
  connectionEpoch: number;
  dimension: string;
  factId: string;
  /** Location this ref points at (the fact location or one project checkpoint). */
  at: { x: number; y: number; z: number };
  label: string;
}

export class MemoryRefRegistry {
  private counter = 0;
  private readonly refs = new Map<string, RefEntry>();
  private readonly requests = new Map<string, string[]>();
  /** Lifecycle generation: bumped by every invalidation. */
  generation = 0;

  issue(ctx: { goalId: string; goalEpoch: number; requestId: string; connectionEpoch: number; dimension: string }, fact: MemoryFact, at: { x: number; y: number; z: number }, label?: string): MemoryRefId {
    const list = this.requests.get(ctx.goalId) ?? [];
    if (!list.includes(ctx.requestId)) {
      list.push(ctx.requestId);
      while (list.length > MEMORY_BOUNDS.refRequestsPerGoal) {
        const old = list.shift() as string;
        for (const [id, e] of this.refs) if (e.goalId === ctx.goalId && e.requestId === old) this.refs.delete(id);
      }
      this.requests.set(ctx.goalId, list);
    }
    this.counter = (this.counter % 999_999) + 1;
    const refId = `mref-${this.counter}` as MemoryRefId;
    this.refs.set(refId, { refId, ...ctx, factId: fact.id, at: { ...at }, label: label ?? fact.label });
    return refId;
  }

  /** Refs currently resolvable for a goal (proposal reference validation). */
  shownFor(goalId: string): Set<string> {
    return new Set([...this.refs.values()].filter((e) => e.goalId === goalId).map((e) => e.refId));
  }

  resolve(refId: string, current: { connectionEpoch: number; dimension: string }, fact: (id: string) => MemoryFact | undefined): ResolvedMemoryRef | { error: string; detail: string } {
    const e = this.refs.get(refId);
    if (!e) return { error: 'unknown_memory_ref', detail: `${refId} was not issued for a current goal request (invented, expired or invalidated by a lifecycle event)` };
    if (e.connectionEpoch !== current.connectionEpoch) return { error: 'stale_connection', detail: `${refId} belongs to an earlier connection` };
    if (e.dimension !== current.dimension) return { error: 'dimension_mismatch', detail: `${refId} is in ${e.dimension}, not ${current.dimension}` };
    const f = fact(e.factId);
    if (!f || f.status !== 'active') return { error: 'memory_fact_inactive', detail: `the remembered fact behind ${refId} is ${f ? f.status : 'gone'}${f?.statusDetail ? ` (${f.statusDetail})` : ''}` };
    if (!f.location || f.location.dimension !== e.dimension) return { error: 'memory_fact_moved', detail: `the remembered fact behind ${refId} no longer has this location` };
    return {
      refId: e.refId,
      factId: f.id,
      category: f.category,
      label: e.label,
      ...(f.key ? { key: f.key } : {}),
      dimension: e.dimension,
      at: { ...e.at },
      source: f.source,
      lastConfirmedMs: f.lastConfirmedMs,
    };
  }

  releaseGoal(goalId: string): void {
    for (const [id, e] of this.refs) if (e.goalId === goalId) this.refs.delete(id);
    this.requests.delete(goalId);
  }

  /** Lifecycle interruption: every transient ref is void (durable facts are untouched). */
  invalidateAll(): number {
    const n = this.refs.size;
    this.refs.clear();
    this.requests.clear();
    this.generation += 1;
    return n;
  }

  get size(): number {
    return this.refs.size;
  }
}
