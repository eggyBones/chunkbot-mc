// Task-driven grounded candidate generation. For a generic TaskSpec (no task
// type), each ALLOWED capability's registered resolver proposes grounded
// options from the current filtered snapshot. Code assigns candidate IDs and
// epochs; the decision model may only pick an ID. When nothing is actionable,
// each capability reports a structured reason (missing ingredient/tool/table/
// fuel, no visible target, out of reach, no frontier, ...) for the planner.
import {
  CandidateSetSchema,
  type ActionCandidate,
  type CandidateGenerator,
  type CandidateSet,
  type CandidateUnavailable,
  type IdSource,
  type ObservationSnapshot,
  type OutcomePredicate,
  type TaskSpec,
} from '../contracts/index.ts';
import type { GameSession } from '../game/connection.ts';
import { admittedParameters } from '../skills/common.ts';
import type { SkillServices, TaskHints } from '../skills/definition.ts';
import { boundJson } from './executor.ts';
import type { SkillRegistry } from './registry.ts';

/** Collects predicate-derived hints (selectors, outputs) without interpreting any goal category. */
function walkPredicate(p: OutcomePredicate, hints: TaskHints): void {
  switch (p.predicate) {
    case 'all':
    case 'any':
      for (const c of p.of) walkPredicate(c, hints);
      return;
    case 'not':
      return; // negated outcomes are not acquisition hints
    case 'inventory_amount':
    case 'inventory_delta':
      hints.keys.push(p.selector);
      hints.outputs.push(p.predicate === 'inventory_amount' && p.mode === 'possess' ? { key: p.selector, count: p.atLeast, possess: true } : { key: p.selector, count: p.atLeast });
      return;
    case 'crafting_result':
    case 'smelting_result':
      hints.keys.push(p.output);
      hints.outputs.push({ key: p.output, count: p.atLeast });
      return;
    case 'equipped':
      hints.keys.push(p.selector);
      return;
    case 'container_state':
      hints.keys.push(p.selector);
      addSelector(p.target, hints);
      return;
    case 'block_state':
      hints.keys.push(p.expect);
      addSelector(p.target, hints);
      return;
    case 'near_target':
    case 'visited_location':
    case 'entity_outcome':
      addSelector(p.target, hints);
      return;
  }
}

function addSelector(s: TaskSpec['targetSelectors'][number], hints: TaskHints): void {
  switch (s.kind) {
    case 'registry':
      hints.keys.push(s.key);
      return;
    case 'observed':
      hints.handles.push({ snapshotId: s.snapshotId, handle: s.handle });
      return;
    case 'owner':
      hints.wantsOwner = true;
      return;
    case 'remembered_anchor':
      hints.anchors.push(s.anchorId);
      return;
    case 'owner_destination':
      hints.destinations.push({ dimension: s.dimension, at: s.at });
      return;
    case 'prior_result':
      hints.priorResults.push(s.actionId);
      return;
  }
}

export function taskHints(task: TaskSpec): TaskHints {
  const hints: TaskHints = { keys: [], handles: [], wantsOwner: false, anchors: [], destinations: [], priorResults: [], outputs: [], parameters: task.parameters ?? {} };
  for (const s of task.targetSelectors ?? []) addSelector(s, hints);
  walkPredicate(task.completion, hints);
  hints.keys = [...new Set(hints.keys)];
  return hints;
}

function isHandleRef(v: unknown): v is { snapshotId: string; handle: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return Object.keys(o).length === 2 && typeof o['snapshotId'] === 'string' && typeof o['handle'] === 'string';
}

function isKindHandleRef(v: unknown): v is { kind: 'handle'; snapshotId: string; handle: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return Object.keys(o).length === 3 && o['kind'] === 'handle' && typeof o['snapshotId'] === 'string' && typeof o['handle'] === 'string';
}

/** Order-independent JSON for parameter comparison. */
function canonical(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export interface CandidateDeps {
  registry: SkillRegistry;
  services: SkillServices;
  session: () => GameSession | undefined;
  ids: IdSource;
  maxPerCapability?: number;
  maxTotal?: number;
}

export class TaskCandidateGenerator implements CandidateGenerator {
  private readonly deps: CandidateDeps;

  constructor(deps: CandidateDeps) {
    this.deps = deps;
  }

  generate(task: TaskSpec, snapshot: ObservationSnapshot): CandidateSet {
    const session = this.deps.session();
    const hints = taskHints(task);
    const candidates: ActionCandidate[] = [];
    const unavailable: CandidateUnavailable[] = [];
    // Named targets (observed selectors AND handle references inside task
    // parameters) are re-grounded in THIS snapshot. A named target that is no
    // longer visible stays named with a non-current snapshot id, so resolvers
    // admit nothing for it and never fall back to unrelated targets.
    const stale: string[] = [];
    const ground = (h: { snapshotId: string; handle: string }) => {
      const translated = this.deps.services.perception.translateHandle(h.snapshotId, h.handle, snapshot.id);
      if (!translated) {
        stale.push(`${h.handle} from ${h.snapshotId}`);
        return { snapshotId: `stale:${h.snapshotId}`, handle: h.handle };
      }
      return { snapshotId: snapshot.id, handle: translated };
    };
    hints.handles = hints.handles.map(ground);
    const parameters: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(hints.parameters)) {
      if (isHandleRef(value)) {
        const grounded = ground(value);
        parameters[key] = grounded;
        hints.handles.push(grounded);
      } else if (isKindHandleRef(value)) {
        // movement targets {kind:"handle",snapshotId,handle} follow the same authority rule
        const grounded = ground({ snapshotId: value.snapshotId, handle: value.handle });
        parameters[key] = { kind: 'handle', ...grounded };
        hints.handles.push(grounded);
      } else parameters[key] = value;
    }
    hints.parameters = parameters as TaskHints['parameters'];
    const staleDetail = stale.length ? `${stale.slice(0, 3).join(', ')} not visible in ${snapshot.id}` : '';
    let truncated = false;
    const perCap = this.deps.maxPerCapability ?? 6;
    const maxTotal = this.deps.maxTotal ?? 32;
    for (const capability of task.allowedCapabilities) {
      const def = this.deps.registry.get(capability);
      if (!def) {
        unavailable.push({ capability, reason: 'capability_not_implemented', detail: `${capability} is not a registered capability`, evidence: {} });
        continue;
      }
      if (!session || session.connectionEpoch !== snapshot.connectionEpoch) {
        unavailable.push({ capability, reason: 'stale_snapshot', detail: 'snapshot belongs to a different or ended connection', evidence: {} });
        continue;
      }
      // Task parameters this capability's schema declares are binding.
      const admitted = admittedParameters({ hints }, def.params);
      if (admitted.invalid.length > 0) {
        unavailable.push({ capability, reason: 'invalid_task_parameter', detail: `task parameter(s) ${admitted.invalid.join(', ')} do not satisfy the ${capability} schema`, evidence: {} });
        continue;
      }
      let result;
      try {
        result = def.resolve({ task, hints, snapshot, session, services: this.deps.services });
      } catch (error) {
        unavailable.push({ capability, reason: 'resolver_error', detail: (error instanceof Error ? error.message : String(error)).slice(0, 200), evidence: {} });
        continue;
      }
      let conflicts = 0;
      const drafts = result.drafts.filter((d) => {
        const parsed = def.params.safeParse(d.parameters);
        if (!parsed.success) return false;
        const data = parsed.data as Record<string, unknown>;
        for (const [key, value] of Object.entries(admitted.values)) {
          if (canonical(data[key]) !== canonical(value)) {
            conflicts += 1;
            return false;
          }
        }
        return true;
      });
      if (conflicts > 0 && drafts.length === 0) {
        unavailable.push({ capability, reason: 'parameter_conflict', detail: `${conflicts} option(s) contradicted the task parameters ${Object.keys(admitted.values).join(', ')}`, evidence: {} });
      }
      if (drafts.length > perCap) truncated = true;
      for (const d of drafts.slice(0, perCap)) {
        if (candidates.length >= maxTotal) {
          truncated = true;
          break;
        }
        candidates.push({
          id: this.deps.ids.next('act') as ActionCandidate['id'],
          capability,
          parameters: d.parameters,
          snapshotId: snapshot.id,
          connectionEpoch: snapshot.connectionEpoch,
          goalEpoch: snapshot.goalEpoch,
          description: d.description.slice(0, 200),
          criteria: (d.criteria ?? []).slice(0, 8).map((c) => c.slice(0, 200)),
          preconditions: (d.preconditions ?? def.descriptor.preconditions).slice(0, 8).map((c) => c.slice(0, 200)),
          timeoutMs: Math.min(d.timeoutMs ?? def.descriptor.timeoutMs, 600_000),
        });
      }
      for (const u of result.unavailable ?? []) {
        if (unavailable.length >= 32) break;
        const detail = u.reason === 'named_target_not_visible' && staleDetail ? staleDetail : u.detail;
        unavailable.push({ capability, reason: u.reason, detail: detail.slice(0, 200), evidence: boundJson(u.evidence ?? {}) as Record<string, never> });
      }
      if (drafts.length === 0 && !(result.unavailable?.length) && conflicts === 0) {
        unavailable.push({ capability, reason: 'no_grounded_option', detail: `${capability} has no grounded option for this task and observation`, evidence: {} });
      }
    }
    return CandidateSetSchema.parse({
      snapshotId: snapshot.id,
      connectionEpoch: snapshot.connectionEpoch,
      goalEpoch: snapshot.goalEpoch,
      generatedAtMs: this.deps.services.clock.now(),
      candidates,
      unavailable: unavailable.slice(0, 32),
      truncated,
    });
  }
}
