// Strict schema validation followed by reference/capability/semantic checks.
// A schema guarantees an interpretable form; it does not prove understanding.
//
// Before any action, every planner proposal (from the real Codex planner or a
// fixture) must pass:
//   1. forbidden content: no executable code, code-bearing text, or fields that
//      would change limits, providers, models, permissions or configuration;
//   2. the shared PlannerProposal schema (bounds, kinds, window size);
//   3. capability references: only IDs of the single implemented catalog;
//   4. parameter references: only parameters a chosen capability declares, with
//      values of the declared type/range/enum (code still re-validates them);
//   5. registry/recipe references: items, blocks and tags of the exact
//      version; crafted/smelted outputs that a recipe of that family produces;
//   6. world references: observed handles only from snapshots shown to the
//      planner for THIS goal, remembered anchors that were shown, prior results
//      the evidence ledger verified for this goal, and owner destinations whose
//      coordinates the owner actually typed (an echoed label is not evidence);
//   7. outcome semantics: a persistent outcome needs a task that maintains it.
// The accepted outcome's immutability across revisions is enforced by the
// goal engine against the first admitted plan.
import {
  PlannerProposalSchema,
  isPredicateWithinDepth,
  type CapabilityCatalog,
  type CapabilityRegistry,
  type OutcomePredicate,
  type OwnerCoordinate,
  type ParameterSpec,
  type PlannerProposal,
  type RegistryFacts,
  type TargetSelector,
  type TaskSpec,
} from '../contracts/index.ts';
import { scanForbidden } from './forbidden.ts';
import { matchesOwnerCoordinate } from './owner-coordinates.ts';

export type ProposalCheck =
  | { ok: true; proposal: PlannerProposal }
  | { ok: false; kind: 'forbidden' | 'schema' | 'semantic' | 'reference'; problems: string[] }
  | { ok: false; kind: 'unknown_capabilities'; problems: string[]; capabilities: string[] };

export interface ShownSnapshot {
  handles: ReadonlySet<string>;
  dimension: string;
}

export interface ProposalLimits {
  planWindowSteps: number;
  /** Remaining admitted-task allowance for this goal. */
  remainingTaskAllowance: number;
}

/** Evidence the planner was actually given for this goal (reference validation). */
export interface ProposalContext {
  /** Version registry facts; without them registry/recipe references cannot be verified and are rejected. */
  registry?: RegistryFacts;
  /** Snapshots shown to the planner for this goal, by id. */
  shown?: ReadonlyMap<string, ShownSnapshot>;
  /** Remembered anchor ids shown to the planner for this goal. */
  anchors?: ReadonlySet<string>;
  /** Current dimension (from the latest shown observation). */
  dimension?: string;
  ownerCoordinates?: readonly OwnerCoordinate[];
  /** Action ids of verified prior results of this goal. */
  priorResults?: ReadonlySet<string>;
  /**
   * MB-MEM-001: memory refs shown to THIS subject. `executable` (mref-) for an
   * admitted goal; `prepared` (mprep-) for a preparation draft (re-grounded at
   * admission). Absent: memory is not installed (memory selectors/predicates rejected).
   */
  memory?: { refs: ReadonlySet<string>; kind: 'executable' | 'prepared' };
}

const MAX_PROBLEMS = 12;

function catalogParams(catalog: CapabilityCatalog, ids: readonly string[]): Map<string, Array<{ capability: string; spec: ParameterSpec }>> {
  const out = new Map<string, Array<{ capability: string; spec: ParameterSpec }>>();
  for (const id of ids) {
    const c = catalog.capabilities.find((x) => x.id === id);
    for (const spec of c?.parameters ?? []) out.set(spec.name, [...(out.get(spec.name) ?? []), { capability: id, spec }]);
  }
  return out;
}

class Checker {
  readonly problems: string[] = [];
  private readonly ctx: ProposalContext;
  constructor(ctx: ProposalContext) {
    this.ctx = ctx;
  }
  add(problem: string): void {
    if (this.problems.length < MAX_PROBLEMS) this.problems.push(problem);
  }

  /** Item key or item tag (inventory/equipment/container selectors, outputs). */
  itemOrTag(key: string, where: string): void {
    const r = this.ctx.registry;
    if (!r) return this.add(`${where}: ${key} cannot be verified (no version registry installed)`);
    if (key.startsWith('#') ? !r.isTag(key) : !r.isItem(key)) this.add(`${where}: ${key} is not an item${key.startsWith('#') ? ' tag' : ''} in the ${r.version} registry`);
  }

  block(key: string, where: string): void {
    const r = this.ctx.registry;
    if (!r) return this.add(`${where}: ${key} cannot be verified (no version registry installed)`);
    if (!r.isBlock(key)) this.add(`${where}: ${key} is not a block in the ${r.version} registry`);
  }

  anyKey(key: string, where: string): void {
    const r = this.ctx.registry;
    if (!r) return this.add(`${where}: ${key} cannot be verified (no version registry installed)`);
    if (key.startsWith('#') ? !r.isTag(key) : !(r.isItem(key) || r.isBlock(key))) this.add(`${where}: ${key} is not an item, block or item tag in the ${r.version} registry`);
  }

  handle(snapshotId: string, handle: string, where: string): void {
    const shown = this.ctx.shown?.get(snapshotId);
    if (!shown) return this.add(`${where}: snapshot ${snapshotId} was not shown to the planner for this goal (invented or expired reference)`);
    if (!shown.handles.has(handle)) this.add(`${where}: handle ${handle} is not in snapshot ${snapshotId} (invented reference)`);
  }

  anchor(anchorId: string, where: string): void {
    if (!this.ctx.anchors?.has(anchorId)) this.add(`${where}: remembered anchor ${anchorId} was not shown to the planner (invented reference)`);
  }

  destination(dimension: string, at: { x: number; y: number; z: number }, where: string): void {
    if (this.ctx.dimension && dimension !== this.ctx.dimension) this.add(`${where}: destination dimension ${dimension} is not the current dimension ${this.ctx.dimension}`);
    if (!matchesOwnerCoordinate(at, this.ctx.ownerCoordinates ?? [])) {
      this.add(`${where}: coordinates ${at.x} ${at.y} ${at.z} were not supplied by the owner (owner-typed coordinates: ${(this.ctx.ownerCoordinates ?? []).map((c) => `${c.x} ${c.y} ${c.z}`).join('; ') || 'none'}); invented coordinates are not destinations`);
    }
  }

  prior(actionId: string, where: string): void {
    if (!this.ctx.priorResults?.has(actionId)) this.add(`${where}: ${actionId} is not a verified prior result of this goal (invented reference)`);
  }

  selector(s: TargetSelector, where: string): void {
    switch (s.kind) {
      case 'registry':
        return this.anyKey(s.key, where);
      case 'observed':
        return this.handle(s.snapshotId, s.handle, where);
      case 'remembered_anchor':
        return this.anchor(s.anchorId, where);
      case 'owner_destination':
        return this.destination(s.dimension, s.at, where);
      case 'owner':
        return;
      case 'prior_result':
        return this.prior(s.actionId, where);
      case 'memory_ref':
        return this.memoryRef(s.refId, where);
    }
  }

  memoryRef(refId: string, where: string): void {
    const m = this.ctx.memory;
    if (!m) return this.add(`${where}: memory is not installed in this run; memory_ref targets are unavailable`);
    const prepared = refId.startsWith('mprep-');
    if (m.kind === 'executable' && prepared) return this.add(`${where}: ${refId} is a preparation reference; use the mref- refs shown in this request`);
    if (m.kind === 'prepared' && !prepared) return this.add(`${where}: ${refId} is not a reference shown while preparing (use the mprep- refs shown in this request)`);
    if (!m.refs.has(refId)) this.add(`${where}: memory ref ${refId} was not shown to the planner for this ${m.kind === 'executable' ? 'goal' : 'preparation'} (invented or expired reference)`);
  }

  predicate(p: OutcomePredicate, where: string): void {
    switch (p.predicate) {
      case 'all':
      case 'any':
        p.of.forEach((c, i) => this.predicate(c, `${where}.of[${i}]`));
        return;
      case 'not':
        this.predicate(p.of, `${where}.of`);
        return;
      case 'inventory_amount':
      case 'inventory_delta':
        return this.itemOrTag(p.selector, `${where}.selector`);
      case 'equipped':
        return this.itemOrTag(p.selector, `${where}.selector`);
      case 'near_target':
      case 'visited_location':
        return this.selector(p.target, `${where}.target`);
      case 'block_state':
        this.selector(p.target, `${where}.target`);
        return this.block(p.expect, `${where}.expect`);
      case 'container_state':
        this.selector(p.target, `${where}.target`);
        return this.itemOrTag(p.selector, `${where}.selector`);
      case 'crafting_result': {
        this.itemOrTag(p.output, `${where}.output`);
        const r = this.ctx.registry;
        if (r && r.isItem(p.output) && !r.craftable(p.output)) this.add(`${where}.output: no crafting recipe produces ${p.output} in ${r.version} (query knowledge for how it is obtained)`);
        return;
      }
      case 'smelting_result': {
        this.itemOrTag(p.output, `${where}.output`);
        const r = this.ctx.registry;
        if (r && r.isItem(p.output) && !r.cookingOutput(p.output)) this.add(`${where}.output: no furnace-type recipe produces ${p.output} in ${r.version}`);
        return;
      }
      case 'entity_outcome':
        if (p.target.kind !== 'observed' && p.target.kind !== 'owner') this.add(`${where}.target: entity outcomes are evaluated only for an observed entity handle or the owner`);
        else if (p.target.kind === 'owner' && p.outcome === 'observed_defeated') this.add(`${where}: owner defeat is not an evaluated outcome`);
        return this.selector(p.target, `${where}.target`);
      case 'memory_state':
        if (!this.ctx.memory) this.add(`${where}: memory is not installed in this run; memory_state cannot be evaluated`);
        return;
    }
  }

  /** One task parameter against the specs of the allowed capabilities that declare it. */
  parameter(name: string, value: unknown, declared: Array<{ capability: string; spec: ParameterSpec }> | undefined, where: string): void {
    if (!declared || declared.length === 0) {
      this.add(`${where}: no allowed capability declares parameter "${name}" (plans cannot add limits, providers, models or other settings)`);
      return;
    }
    const failures: string[] = [];
    for (const { capability, spec } of declared) {
      const before = this.problems.length;
      const issue = this.valueIssue(spec, value, `${where}`);
      if (!issue && this.problems.length === before) return; // accepted by one declaring capability
      const added = this.problems.splice(before);
      failures.push(`${capability}: ${issue ?? added.join('; ')}`);
    }
    this.add(`${where}: value does not satisfy the declared parameter (${failures.slice(0, 2).join('; ')})`);
  }

  private valueIssue(spec: ParameterSpec, v: unknown, where: string): string | undefined {
    const range = (n: number) => (spec.minimum !== undefined && n < spec.minimum) || (spec.maximum !== undefined && n > spec.maximum) ? `outside ${spec.minimum ?? '-∞'}..${spec.maximum ?? '∞'}` : undefined;
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string' || v.length === 0 || v.length > 200) return 'expected a short string';
        if (spec.enum && !spec.enum.includes(v)) return `expected one of ${spec.enum.join(', ')}`;
        return undefined;
      case 'integer':
        return typeof v === 'number' && Number.isInteger(v) ? range(v) : 'expected an integer';
      case 'number':
        return typeof v === 'number' && Number.isFinite(v) ? range(v) : 'expected a number';
      case 'boolean':
        return typeof v === 'boolean' ? undefined : 'expected a boolean';
      case 'registry_key':
        if (typeof v !== 'string') return 'expected a registry key';
        this.anyKey(v, where);
        return undefined;
      case 'handle': {
        if (!isHandleRef(v)) return 'expected {snapshotId, handle}';
        this.handle(v.snapshotId, v.handle, where);
        return undefined;
      }
      case 'target_selector': {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return 'expected a target object';
        const o = v as Record<string, unknown>;
        switch (o['kind']) {
          case 'owner':
            return Object.keys(o).length === 1 ? undefined : 'owner target takes no other fields';
          case 'handle':
            if (typeof o['snapshotId'] !== 'string' || typeof o['handle'] !== 'string') return 'handle target needs snapshotId and handle';
            this.handle(o['snapshotId'], o['handle'], where);
            return undefined;
          case 'anchor':
            if (typeof o['anchorId'] !== 'string') return 'anchor target needs anchorId';
            this.anchor(o['anchorId'], where);
            return undefined;
          case 'destination': {
            const [x, y, z] = [o['x'], o['y'], o['z']];
            if (typeof o['dimension'] !== 'string' || typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return 'destination target needs dimension, x, y, z';
            this.destination(o['dimension'], { x, y, z }, where);
            return undefined;
          }
          default:
            return 'unknown target kind';
        }
      }
    }
  }
}

function isHandleRef(v: unknown): v is { snapshotId: string; handle: string } {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 2 && typeof (v as Record<string, unknown>)['snapshotId'] === 'string' && typeof (v as Record<string, unknown>)['handle'] === 'string';
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function checkProposal(raw: unknown, registry: CapabilityRegistry, limits: ProposalLimits, ctx: ProposalContext = {}): ProposalCheck {
  const forbidden = scanForbidden(raw);
  if (forbidden.length > 0) return { ok: false, kind: 'forbidden', problems: forbidden };
  const parsed = PlannerProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      kind: 'schema',
      problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`),
    };
  }
  const proposal = parsed.data;
  if (proposal.disposition !== 'plan') return { ok: true, proposal };

  const problems: string[] = [];
  if (proposal.tasks.length > limits.planWindowSteps) {
    problems.push(`plan window has ${proposal.tasks.length} steps; limit is ${limits.planWindowSteps}`);
  }
  if (proposal.tasks.length > limits.remainingTaskAllowance) {
    problems.push(`plan exceeds the remaining task allowance (${limits.remainingTaskAllowance})`);
  }
  const outcomeRoot = proposal.outcome.kind === 'finite' ? proposal.outcome.outcome : proposal.outcome.maintain;
  const predicates = [outcomeRoot, ...proposal.tasks.map((t) => t.completion)];
  for (const p of predicates) {
    if (!isPredicateWithinDepth(p)) problems.push('predicate nesting exceeds the supported depth');
  }
  if (problems.length > 0) return { ok: false, kind: 'semantic', problems };

  const unknown = [...new Set(proposal.tasks.flatMap((t) => t.allowedCapabilities).filter((id) => !registry.has(id)))];
  if (unknown.length > 0) {
    return {
      ok: false,
      kind: 'unknown_capabilities',
      capabilities: unknown,
      problems: [`plan references capabilities that are not implemented: ${unknown.join(', ')}`],
    };
  }

  // References: registry/recipes, shown handles/anchors, verified prior results, owner-typed coordinates.
  const c = new Checker(ctx);
  c.predicate(outcomeRoot, 'outcome');
  const catalog = registry.catalog();
  proposal.tasks.forEach((t: TaskSpec, i) => {
    const where = `tasks[${i}]`;
    t.targetSelectors.forEach((s, j) => c.selector(s, `${where}.targetSelectors[${j}]`));
    c.predicate(t.completion, `${where}.completion`);
    const declared = catalogParams(catalog, t.allowedCapabilities);
    for (const [name, value] of Object.entries(t.parameters)) c.parameter(name, value, declared.get(name), `${where}.parameters.${name}`);
  });
  if (c.problems.length > 0) return { ok: false, kind: 'reference', problems: c.problems };

  // Outcome semantics: a persistent outcome is kept by a maintain-mode task (same predicate).
  if (proposal.outcome.kind === 'persistent' && !proposal.morePlanningNeeded) {
    const key = canonical(proposal.outcome.maintain);
    if (!proposal.tasks.some((t) => canonical(t.completion) === key)) {
      return { ok: false, kind: 'semantic', problems: ['a persistent outcome needs a task whose completion is exactly the maintained predicate (that task keeps the condition until stopped); otherwise set morePlanningNeeded'] };
    }
  }
  return { ok: true, proposal };
}

export { canonical as canonicalProposalJson };
