// Operator mechanic DIAGNOSTICS (terminal only, `/diag ...`). These run the SAME
// registered skill definitions, candidate resolvers, executor, actuator lease,
// perception, knowledge and predicate evaluator that goal execution uses, but
// every step is chosen explicitly by the operator. They are deterministic
// diagnostics: no model is called and no autonomous goal planning happens.
//
//   /diag catalog                         capability catalog (ids, families)
//   /diag observe                         filtered observation snapshot
//   /diag knowledge <KnowledgeQuery json> version knowledge answer
//   /diag candidates <TaskSpec json>      task-driven grounded candidates
//   /diag run <act-id>                    execute a candidate from the last set
//   /diag do <capability> <params json>   execute one grounded action directly
//   /diag inventory                       server-confirmed inventory
//   /diag bind <name> <predicate json>    bind predicate baselines now
//   /diag eval <name>                     evaluate a bound predicate
//   /diag anchor                          set the travel anchor here
// `stop` (terminal or owner chat) cancels a running diagnostic action.
import {
  KnowledgeQuerySchema,
  OutcomePredicateSchema,
  TaskSpecSchema,
  type ActionCandidate,
  type BoundPredicate,
  type CandidateSet,
  type Clock,
  type IdSource,
  type RunStore,
} from '../contracts/index.ts';
import type { SkillRuntime } from './skill-runtime.ts';

export interface DiagnosticDeps {
  runtime: () => SkillRuntime;
  out: (line: string) => void;
  store: RunStore;
  clock: Clock;
  ids: IdSource;
  /** Current goal epoch (diagnostic candidates carry it; ownership is diagnostic). */
  goalEpoch: () => number;
  /** True while a goal owns control: diagnostics then refuse to act. */
  goalActive: () => boolean;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class DiagnosticConsole {
  private readonly deps: DiagnosticDeps;
  private lastSet: CandidateSet | undefined;
  private running: { id: string; abort: AbortController; capability: string; startedAtMs: number } | undefined;
  private current: string | undefined;
  private counter = 0;
  private readonly bound = new Map<string, BoundPredicate>();

  constructor(deps: DiagnosticDeps) {
    this.deps = deps;
  }

  /** Lease ownership check for diagnostic owners. */
  isCurrent(id: string): boolean {
    return this.current === id;
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  private json(kind: string, data: unknown): void {
    this.deps.out(`[diag-json] ${JSON.stringify({ kind, ...((data as object) ?? {}) })}`);
  }

  /**
   * Cancels a running diagnostic action: ownership is invalidated FIRST (the
   * diagnostic id stops being current), then the abort revokes the lease,
   * which clears controls synchronously. Returns the measured clear time.
   */
  cancel(reason: string): boolean {
    const running = this.running;
    if (!running) return false;
    const accepted = this.deps.clock.now();
    this.current = undefined; // invalidate first
    running.abort.abort(new Error(reason));
    const report = this.deps.runtime().leases.lastClear;
    const clearMs = this.deps.clock.now() - accepted;
    this.deps.out(`[diag] stop accepted for ${running.capability} (${running.id}): controls cleared in ${clearMs}ms${report ? ` [${report.steps.join(', ')}]` : ''}`);
    this.json('stop', { diagnosticId: running.id, capability: running.capability, reason, clearMs, steps: report?.steps ?? [], errors: report?.errors ?? [], clearedShared: report?.clearedShared ?? false });
    this.deps.store.record({ type: 'diagnostic_stop', diagnosticId: running.id, reason, clearMs, steps: report?.steps ?? [] });
    return true;
  }

  async handle(args: string): Promise<void> {
    const rt = this.deps.runtime();
    const [sub = '', ...restParts] = args.trim().split(/\s+/);
    const rest = args.trim().slice(sub.length).trim();
    this.deps.store.record({ type: 'diagnostic_command', sub });
    switch (sub) {
      case 'catalog': {
        const catalog = rt.registry.catalog();
        this.deps.out(`[diag] catalog ${catalog.catalogVersion}: ${catalog.capabilities.length} capabilities (diagnostic listing; generated from registered skill definitions)`);
        for (const c of catalog.capabilities) this.deps.out(`[diag]   ${c.id} (${c.family}): ${c.purpose}`);
        this.json('catalog', { catalogVersion: catalog.catalogVersion, ids: catalog.capabilities.map((c) => c.id) });
        return;
      }
      case 'observe': {
        const snap = rt.perception.take(this.deps.goalEpoch());
        if (!snap) return this.deps.out('[diag] no ready connection');
        this.deps.out(`[diag] snapshot ${snap.id}: ${snap.blocks.length} block handles (${snap.blockSummary.length} types), ${snap.entities.length} entities, ${snap.drops.length} drops, ${snap.frontiers.length} frontiers, owner ${snap.owner.visible ? 'visible' : 'not visible'}`);
        this.json('observe', { snapshot: snap });
        return;
      }
      case 'knowledge': {
        const q = KnowledgeQuerySchema.safeParse(parseJson(rest));
        if (!q.success) return this.deps.out(`[diag] invalid knowledge query: ${q.error.issues[0]?.message ?? 'parse error'}`);
        const [r] = await rt.knowledge.answer([q.data], new AbortController().signal);
        this.json('knowledge', { result: r });
        return;
      }
      case 'candidates': {
        const task = TaskSpecSchema.safeParse(parseJson(rest));
        if (!task.success) return this.deps.out(`[diag] invalid TaskSpec: ${task.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        const snap = rt.perception.take(this.deps.goalEpoch());
        if (!snap) return this.deps.out('[diag] no ready connection');
        this.lastSet = rt.candidates.generate(task.data, snap);
        this.deps.out(`[diag] ${this.lastSet.candidates.length} candidates, ${this.lastSet.unavailable.length} unavailable reasons (snapshot ${snap.id})`);
        for (const c of this.lastSet.candidates) this.deps.out(`[diag]   ${c.id} ${c.capability}: ${c.description}`);
        for (const u of this.lastSet.unavailable) this.deps.out(`[diag]   unavailable ${u.capability}: ${u.reason} - ${u.detail}`);
        this.json('candidates', { set: this.lastSet });
        return;
      }
      case 'run': {
        const id = restParts[0];
        const candidate = this.lastSet?.candidates.find((c) => c.id === id);
        if (!candidate) return this.deps.out(`[diag] no candidate ${id ?? ''} in the last candidate set`);
        await this.execute(candidate);
        return;
      }
      case 'do': {
        const capability = restParts[0] ?? '';
        const params = parseJson(rest.slice(capability.length).trim() || '{}');
        if (!rt.registry.has(capability)) return this.deps.out(`[diag] unknown capability ${capability}`);
        if (!params || typeof params !== 'object') return this.deps.out('[diag] parameters must be a JSON object');
        const snap = rt.perception.latest() ?? rt.perception.take(this.deps.goalEpoch());
        if (!snap) return this.deps.out('[diag] no ready connection');
        const def = rt.registry.get(capability);
        const candidate: ActionCandidate = {
          id: this.deps.ids.next('act') as ActionCandidate['id'],
          capability,
          parameters: params as ActionCandidate['parameters'],
          snapshotId: snap.id,
          connectionEpoch: snap.connectionEpoch,
          goalEpoch: this.deps.goalEpoch(),
          description: `diagnostic ${capability}`,
          criteria: [],
          preconditions: [],
          timeoutMs: def?.descriptor.timeoutMs ?? 60_000,
        };
        await this.execute(candidate);
        return;
      }
      case 'inventory': {
        const inv = await rt.predicates.inventory(new AbortController().signal);
        if (!inv) return this.deps.out('[diag] no server-confirmed inventory');
        this.json('inventory', { source: inv.source, atMs: inv.atMs, counts: Object.fromEntries(inv.counts), slots: Object.fromEntries([...inv.slots].map(([k, v]) => [String(k), v])) });
        return;
      }
      case 'bind': {
        const name = restParts[0] ?? '';
        const p = OutcomePredicateSchema.safeParse(parseJson(rest.slice(name.length).trim()));
        if (!name || !p.success) return this.deps.out('[diag] usage: /diag bind <name> <predicate json>');
        const bound = await rt.predicates.bind(p.data, new AbortController().signal);
        this.bound.set(name, bound);
        this.json('bind', { name, baselines: bound.baselines, boundAtMs: bound.boundAtMs });
        return;
      }
      case 'eval': {
        const name = restParts[0] ?? '';
        const bound = this.bound.get(name);
        if (!bound) return this.deps.out(`[diag] no bound predicate ${name}`);
        const r = await rt.predicates.evaluate(bound, new AbortController().signal);
        this.deps.out(`[diag] predicate ${name}: ${r.status} - ${r.detail}`);
        this.json('eval', { name, evaluation: r });
        return;
      }
      case 'anchor': {
        const owner = rt.perception.travelAnchorGoalEpoch();
        if (owner !== undefined && owner === this.deps.goalEpoch()) {
          this.deps.out(`[diag] anchor unchanged: it belongs to the current goal (epoch ${owner}), set at its admission`);
          this.json('anchor', { travel: rt.perception.travelBounds() ?? null, goalEpoch: owner, changed: false });
          return;
        }
        rt.perception.setTravelAnchor(undefined);
        this.json('anchor', { travel: rt.perception.travelBounds() ?? null });
        return;
      }
      default:
        this.deps.out('[diag] usage: /diag catalog|observe|knowledge <json>|candidates <task json>|run <act-id>|do <capability> <json>|inventory|bind <name> <json>|eval <name>|anchor');
    }
  }

  private async execute(candidate: ActionCandidate): Promise<void> {
    if (this.running) return this.deps.out(`[diag] busy: ${this.running.capability} is running; use stop first`);
    if (this.deps.goalActive()) return this.deps.out('[diag] refused: a goal owns control');
    this.counter += 1;
    const id = `diag-${this.counter}`;
    const abort = new AbortController();
    this.current = id;
    this.running = { id, abort, capability: candidate.capability, startedAtMs: this.deps.clock.now() };
    this.deps.out(`[diag] running ${candidate.capability} as ${id} (operator diagnostic; not goal planning)`);
    try {
      const outcome = await this.deps.runtime().executor.execute(candidate, abort.signal, { kind: 'diagnostic', diagnosticId: id });
      this.deps.out(`[diag] ${candidate.capability} ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}: ${outcome.effect}`);
      this.json('outcome', { diagnosticId: id, outcome });
    } finally {
      if (this.running?.id === id) this.running = undefined;
      if (this.current === id) this.current = undefined;
    }
  }
}
