// Test doubles for MB-FLOW-002 handoff/lookahead tests (never wired into the CLI).
// The planner is delayed and tracks how many turns are in flight; tasks hold or
// complete on timers and can change the fake server inventory; the world fake
// produces snapshots with per-snapshot handles and a controllable re-grounding.
import type {
  AdmittedTask,
  BoundPredicate,
  InventoryBaseline,
  ObservationPort,
  ObservationSnapshot,
  OutcomePredicate,
  PlannerPort,
  PlannerProposal,
  PlannerRequest,
  PredicateEvaluation,
  PredicateEvaluator,
  Readiness,
  TaskExecutionPort,
  TaskResult,
  TaskSpec,
} from '../src/contracts/index.ts';
import { PlannerError } from '../src/planner/errors.ts';
import type { PlannerFailureKind } from '../src/contracts/index.ts';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type PlannerScript =
  | { kind: 'reply'; proposal: unknown; delayMs?: number }
  | { kind: 'fail'; failure: PlannerFailureKind; detail?: string; delayMs?: number }
  /** Never answers; rejects `aborted` after `cleanupMs` once aborted (process cleanup). */
  | { kind: 'hang'; cleanupMs?: number }
  /** Ignores the abort and resolves late (a stale reply from a killed process). */
  | { kind: 'late'; proposal: unknown; delayMs: number };

/** Planner that answers from a per-request script and records concurrency. */
export class DelayedPlanner implements PlannerPort {
  readonly requests: PlannerRequest[] = [];
  readonly signals: AbortSignal[] = [];
  readonly events: Array<{ t: number; what: string; instruction: string; kind: string }> = [];
  inFlight = 0;
  maxInFlight = 0;
  private readonly script: (request: PlannerRequest, index: number) => PlannerScript;
  constructor(script: (request: PlannerRequest, index: number) => PlannerScript) {
    this.script = script;
  }
  readiness(): Readiness {
    return { ready: true, detail: 'delayed fake planner' };
  }
  get count(): number {
    return this.requests.length;
  }
  propose(request: PlannerRequest, signal: AbortSignal): Promise<PlannerProposal> {
    const index = this.requests.length;
    this.requests.push(request);
    this.signals.push(signal);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const kind = `${request.subject.kind}:${request.turnKind ?? 'initial'}`;
    this.events.push({ t: Date.now(), what: 'start', instruction: request.instruction, kind });
    const step = this.script(request, index);
    const done = <T>(p: Promise<T>) =>
      p.finally(() => {
        this.inFlight -= 1;
        this.events.push({ t: Date.now(), what: 'settled', instruction: request.instruction, kind });
      });
    return done(
      new Promise<PlannerProposal>((resolve, reject) => {
        const abortAfter = (ms: number) => signal.addEventListener('abort', () => setTimeout(() => reject(new PlannerError('aborted', 'killed')), ms), { once: true });
        switch (step.kind) {
          case 'reply': {
            const t = setTimeout(() => resolve(step.proposal as PlannerProposal), step.delayMs ?? 0);
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              setTimeout(() => reject(new PlannerError('aborted', 'killed')), 5);
            }, { once: true });
            return;
          }
          case 'fail': {
            const t = setTimeout(() => reject(new PlannerError(step.failure, step.detail ?? `${step.failure} (fake)`, step.failure === 'invalid_output' ? [step.detail ?? 'malformed fake output'] : undefined)), step.delayMs ?? 0);
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new PlannerError('aborted', 'killed'));
            }, { once: true });
            return;
          }
          case 'hang':
            abortAfter(step.cleanupMs ?? 5);
            return;
          case 'late':
            setTimeout(() => resolve(step.proposal as PlannerProposal), step.delayMs);
            return;
        }
      }),
    );
  }
}

export class FakeWorld implements ObservationPort {
  readonly taken: Array<{ id: string; goalEpoch: number }> = [];
  /** Whether a block seen earlier is still produced as the SAME target in a later snapshot. */
  persist = true;
  dimension = 'overworld';
  private n = 0;
  readiness(): Readiness {
    return { ready: true, detail: 'fake world' };
  }
  async snapshot(goalEpoch: number): Promise<ObservationSnapshot> {
    this.n += 1;
    const id = `snap-${String(this.n).padStart(4, '0')}`;
    this.taken.push({ id, goalEpoch });
    return {
      id,
      connectionEpoch: 1,
      goalEpoch,
      takenAtMs: Date.now(),
      dimension: this.dimension,
      self: { at: { x: 0, y: 64, z: 0 }, health: 20, food: 20 },
      inventory: [],
      inventorySource: 'client_model',
      equipment: {},
      owner: { visible: true, at: { x: 2, y: 64, z: 2 }, distance: 2.8 },
      entities: [],
      blocks: [{ handle: `blk-${this.n}`, key: 'minecraft:oak_log', at: { x: 3, y: 64, z: 3 }, distance: 4.2 }],
      drops: [],
      remembered: [],
      blockSummary: [],
      frontiers: [],
    };
  }
  translateHandle(fromSnapshotId: string, handle: string, toSnapshotId: string): string | undefined {
    if (!this.persist) return undefined;
    if (!/^blk-\d+$/.test(handle)) return undefined;
    return `blk-${Number(toSnapshotId.slice(5))}`;
  }
}

/** Server-confirmed inventory fake: captured only at admission; acquisition measured from that baseline. */
export class FakeServer implements PredicateEvaluator {
  readonly inventory = new Map<string, number>();
  readonly baselines: Array<{ t: number; counts: Record<string, number> }> = [];
  readonly boundWith: Array<InventoryBaseline | undefined> = [];
  /** Every predicate actually bound (goal outcomes), as bound. */
  readonly boundPredicates: OutcomePredicate[] = [];
  readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  add(key: string, n: number): void {
    this.inventory.set(key, (this.inventory.get(key) ?? 0) + n);
  }
  async captureBaseline(): Promise<InventoryBaseline> {
    const counts = Object.fromEntries(this.inventory);
    this.baselines.push({ t: Date.now(), counts });
    this.log.push(`baseline:${JSON.stringify(counts)}`);
    return { capturedAtMs: Date.now(), counts, detail: 'fake server inventory at admission' };
  }
  async bind(predicate: OutcomePredicate, _signal: AbortSignal, baseline?: InventoryBaseline): Promise<BoundPredicate> {
    this.boundWith.push(baseline);
    this.boundPredicates.push(structuredClone(predicate));
    const baselines: Record<string, number> = {};
    if (predicate.predicate === 'inventory_amount') baselines[`inv:${predicate.selector}`] = baseline?.counts?.[predicate.selector] ?? this.inventory.get(predicate.selector) ?? 0;
    return { predicate, boundAtMs: baseline?.capturedAtMs ?? Date.now(), baselines };
  }
  async evaluate(bound: BoundPredicate): Promise<PredicateEvaluation> {
    const p = bound.predicate;
    if (p.predicate === 'inventory_amount') {
      const now = this.inventory.get(p.selector) ?? 0;
      const base = bound.baselines[`inv:${p.selector}`] ?? 0;
      const acquired = p.mode === 'collect_additional' ? now - base : now;
      const ok = acquired >= p.atLeast;
      return { status: ok ? 'satisfied' : 'unsatisfied', predicate: p.predicate, detail: `${acquired}/${p.atLeast}`, evidence: { acquired } };
    }
    return { status: 'unknown', predicate: p.predicate, detail: 'not modeled', evidence: {} };
  }
}

export type TaskBehavior = (t: AdmittedTask) => Promise<Partial<TaskResult> | void>;

/** Task runtime fake: behavior by objective; records starts/ends and whether a task ran after losing ownership. */
export class FakeTaskRuntime implements TaskExecutionPort {
  readonly runs: Array<{ task: AdmittedTask; startedAt: number; endedAt?: number; currentAtStart: boolean }> = [];
  readonly log: string[];
  behaviors = new Map<string, TaskBehavior>();
  constructor(log: string[]) {
    this.log = log;
  }
  readiness(): Readiness {
    return { ready: true, detail: 'fake task runtime' };
  }
  async run(t: AdmittedTask): Promise<TaskResult> {
    const rec: { task: AdmittedTask; startedAt: number; endedAt?: number; currentAtStart: boolean } = { task: t, startedAt: Date.now(), currentAtStart: t.isCurrent() };
    this.runs.push(rec);
    this.log.push(`task-start:${t.spec.objective}`);
    const behavior = this.behaviors.get(t.spec.objective) ?? (async () => undefined);
    const o = (await behavior(t)) ?? {};
    rec.endedAt = Date.now();
    this.log.push(`task-end:${t.spec.objective}`);
    const status = o.status ?? (t.signal.aborted ? 'cancelled' : 'completed');
    const reason = o.reason ?? (status === 'completed' ? 'completion_verified' : 'ownership_revoked');
    return { taskId: t.taskId, status, reason, detail: o.detail ?? 'fake', rounds: 1, decisions: 1, actions: 1, localContinuations: 0, feedback: { taskId: t.taskId, objective: t.spec.objective, status, reason, detail: o.detail ?? 'fake', unavailable: [], recentOutcomes: [], exhaustedTargets: [], completion: null } };
  }
}

/** Waits for `ms` or until the task is revoked. */
export function runFor(ms: number, effect?: () => void): TaskBehavior {
  return async (t) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      t.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    if (!t.signal.aborted) effect?.();
  };
}

/** Holds (e.g. a sustained follow) until revoked. */
export const holdUntilRevoked: TaskBehavior = (t) => new Promise((resolve) => t.signal.addEventListener('abort', () => resolve(undefined), { once: true }));

export const task = (objective: string, completion: OutcomePredicate, extra: Partial<TaskSpec> = {}): TaskSpec => ({
  objective,
  decisionInstruction: 'do it',
  allowedCapabilities: ['mine_block'],
  targetSelectors: [],
  parameters: {},
  completion,
  ...extra,
});

export const NEAR: OutcomePredicate = { predicate: 'near_target', target: { kind: 'owner' }, within: 3 };
export const cobble = (atLeast: number): OutcomePredicate => ({ predicate: 'inventory_amount', selector: 'minecraft:cobblestone', atLeast, mode: 'collect_additional' });

export function finitePlan(tasks: TaskSpec[], outcome: OutcomePredicate, more = true, interpretation = 'collect cobblestone'): PlannerProposal {
  return { version: 1, disposition: 'plan', interpretation, outcome: { kind: 'finite', outcome }, tasks, morePlanningNeeded: more } as PlannerProposal;
}

export function followPlan(): PlannerProposal {
  return {
    version: 1,
    disposition: 'plan',
    interpretation: 'stay near the owner',
    outcome: { kind: 'persistent', maintain: NEAR },
    tasks: [task('stay near the owner', NEAR, { allowedCapabilities: ['follow_entity'], targetSelectors: [{ kind: 'owner' }] })],
    morePlanningNeeded: false,
  } as PlannerProposal;
}
