// Test doubles for MB-FLOW-001 supervisor tests (never wired into the CLI):
// a REAL GoalEngine with fake planner/tasks/server/world ports, a real
// AutonomyControl on a temp directory, manual timers and a manual clock.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LowHealthAllowanceGrant, ObservationSnapshot, OwnerGoalEnd, PlannerRequest, SupportAdmission, SupportTerminal, SurvivalAssessmentInput, SurvivalDecision, SurvivalPolicyPort, SurvivalStatus } from '../src/contracts/index.ts';
import { AutonomyConfigSchema, type AutonomyConfig, type AutonomyConfigInput } from '../src/contracts/autonomy.ts';
import { AutonomyControl } from '../src/autonomy/control.ts';
import { AutonomySupervisor, type ProviderState, type TimerApi } from '../src/autonomy/supervisor.ts';
import { StaticCapabilityRegistry } from '../src/goals/not-ready.ts';
import type { GoalEngineLimits } from '../src/goals/goal-engine.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { makeEngine } from './helpers.ts';
import { DelayedPlanner, FakeServer, FakeTaskRuntime, FakeWorld, type PlannerScript } from './handoff-fakes.ts';

export const OWNER = { surface: 'chat', principal: 'owner' } as const;
export const FACTS = new VersionKnowledge({ version: '26.1.2' });
const cap = (id: string) => ({ id, family: 'test', purpose: `${id} test capability`, parameters: [], preconditions: [], effects: [], supportedPredicates: [], timeoutMs: 1_000, cancellation: 'stops', limitations: ['test'] });
export const CAPS = new StaticCapabilityRegistry({ catalogVersion: 'test-autonomy', capabilities: [cap('mine_block'), cap('move_near'), cap('follow_entity'), cap('use_held_item'), cap('pickup_item'), cap('craft_item'), cap('place_block')] });
const READY_EXECUTOR = { readiness: () => ({ ready: true, detail: 'fake executor' }), execute: async () => { throw new Error('not used'); } };
export const LIMITS: GoalEngineLimits = { maxInstructionChars: 500, plannerTurnsPerGoal: 20, plannerTimeoutMs: 10_000, planWindowSteps: 8, totalTaskCeiling: 64, goalDeadlineMs: 60_000, cleanupTimeoutMs: 500, replans: 8 };

/** Manual timers driven by the test (no wall-clock waiting for cooldowns). */
export class ManualTimers implements TimerApi {
  private seq = 0;
  readonly pending = new Map<number, { at: number; ms: number; fn: () => void }>();
  readonly history: number[] = [];
  private readonly clock: ManualClock;
  constructor(clock: ManualClock) {
    this.clock = clock;
  }
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { at: this.clock.t + ms, ms, fn });
    this.history.push(ms);
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Delays of timers currently pending (ascending). */
  delays(): number[] {
    return [...this.pending.values()].map((t) => t.ms).sort((a, b) => a - b);
  }
  /** Advances the clock to the earliest timer and runs it (returns false when none). */
  fireNext(): boolean {
    const next = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return false;
    this.pending.delete(next[0]);
    this.clock.t = Math.max(this.clock.t, next[1].at);
    next[1].fn();
    return true;
  }
}

export class ManualClock {
  t = 1_000_000;
  now(): number {
    return this.t;
  }
}

/** Scripted canonical survival policy (MB-FLOW-003 port) for supervisor tests. */
export class FakeSurvival implements SurvivalPolicyPort {
  enabled = true;
  decision: SurvivalDecision = { kind: 'none', reason: 'healthy' };
  /** Decision returned once (then falls back to `decision`). */
  next: SurvivalDecision[] = [];
  grant: Omit<LowHealthAllowanceGrant, 'goalId' | 'goalEpoch' | 'connectionEpoch' | 'grantedAtMs'> | undefined;
  readonly assessed: SurvivalAssessmentInput[] = [];
  readonly admitted: SupportAdmission[] = [];
  readonly grants: LowHealthAllowanceGrant[] = [];
  readonly terminals: SupportTerminal[] = [];
  readonly ownerEnds: OwnerGoalEnd[] = [];
  readonly ownerInstructions: number[] = [];
  assess(input: SurvivalAssessmentInput): SurvivalDecision {
    this.assessed.push(input);
    return this.next.shift() ?? this.decision;
  }
  onSupportAdmitted(admission: SupportAdmission): LowHealthAllowanceGrant | undefined {
    this.admitted.push(admission);
    if (!this.grant) return undefined;
    const g: LowHealthAllowanceGrant = { ...this.grant, goalId: admission.goalId, goalEpoch: admission.goalEpoch, connectionEpoch: admission.connectionEpoch, grantedAtMs: admission.admittedAtMs };
    this.grants.push(g);
    return g;
  }
  onSupportTerminal(end: SupportTerminal): void {
    this.terminals.push(end);
  }
  onOwnerGoalEnd(end: OwnerGoalEnd): void {
    this.ownerEnds.push(end);
  }
  onOwnerInstruction(atMs: number): void {
    this.ownerInstructions.push(atMs);
    this.durableInterrupted = [];
  }
  abandonRecovery(): void {}
  /** Durable interrupted owner directives (as survival would reload them after a restart). */
  durableInterrupted: Array<{ goalId: string; instruction: string; reason: string; interruptedAtMs: number; durable: boolean }> = [];
  interruptedOwnerIntent() {
    return this.durableInterrupted;
  }
  readonly dismissed: string[] = [];
  dismissInterrupted(goalId: string): boolean {
    this.dismissed.push(goalId);
    return true;
  }
  status(): SurvivalStatus {
    return { enabled: true, store: { state: 'ready', detail: 'fake' }, incidents: [], interrupted: [], blocked: [], cooldowns: [], admissionsLastHour: this.admitted.length, gated: [] };
  }
}

export interface AutonomyHarnessOptions {
  dir?: string;
  scope?: boolean;
  enabled?: boolean;
  config?: AutonomyConfigInput;
  survival?: FakeSurvival;
  providers?: () => ProviderState;
  fingerprint?: () => string;
  limits?: Partial<GoalEngineLimits>;
  observe?: () => Promise<ObservationSnapshot | null>;
  lookahead?: boolean;
  /** Engine admission barrier (MB-FLOW-003-C5). */
  barrier?: import('../src/goals/goal-engine.ts').GoalEngineDeps['admissionBarrier'];
}

export function autonomyHarness(script: (request: PlannerRequest, index: number) => PlannerScript, opts: AutonomyHarnessOptions = {}) {
  const log: string[] = [];
  const planner = new DelayedPlanner(script);
  const server = new FakeServer(log);
  const tasks = new FakeTaskRuntime(log);
  const world = new FakeWorld();
  const clock = new ManualClock();
  const timers = new ManualTimers(clock);
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'chunkbot-autonomy-'));
  const config: AutonomyConfig = AutonomyConfigSchema.parse({ startDelayMs: 5_000, afterCompletionMs: 3_000, afterBlockedMs: 60_000, maxBackoffMs: 900_000, ...opts.config });
  const control = new AutonomyControl({ scope: opts.scope === false ? undefined : { worldProfile: 'test-world', worldRevision: 1, botProfile: 'test-bot' }, rootDir: dir, endpoint: '127.0.0.1:25566', rebindEndpoint: false, clock });
  const notices: string[] = [];
  let ready = true;
  let connectionEpoch = 1;
  let fingerprint = 'state-0';
  // eslint-disable-next-line prefer-const
  let supervisor: AutonomySupervisor;
  const h = makeEngine(
    {
      planner,
      outcomes: server,
      tasks,
      observation: world,
      capabilities: CAPS,
      executor: READY_EXECUTOR,
      registry: FACTS,
      limits: { ...LIMITS, ...opts.limits },
      flow: { handoff: 'smooth', lookahead: opts.lookahead ?? false },
      connectionEpoch: () => connectionEpoch,
      isGameReady: () => ready,
      onLatchChanged: (latch, cause) => supervisor.onLatchChanged(latch, cause),
      onGoalAdmitted: (a) => supervisor.onGoalAdmitted(a),
      onGoalTerminal: (e) => supervisor.onGoalTerminal(e),
      onPreparationDiscarded: (p) => supervisor.onPreparationDiscarded(p),
      ...(opts.barrier ? { admissionBarrier: opts.barrier } : {}),
    },
    log,
  );
  supervisor = new AutonomySupervisor({
    engine: h.engine,
    control,
    config,
    enabled: { enabled: opts.enabled ?? true, reason: opts.enabled === false ? 'disabled by test' : 'enabled' },
    clock,
    timers,
    record: (e) => h.store.record(e),
    notify: (text) => notices.push(text),
    connection: () => (ready ? { ready: true, connectionEpoch, dimension: world.dimension } : null),
    observe: opts.observe ?? (async () => ({ ...await world.snapshot(0), connectionEpoch, takenAtMs: clock.now() })),
    providers: opts.providers ?? (() => ({ ready: true, detail: 'fake providers ready' })),
    stateFingerprint: opts.fingerprint ?? (() => fingerprint),
    goalLimits: { plannerTurns: 20, tasks: 64, replans: 8, deadlineMs: 60_000 },
    ...(opts.survival ? { survival: opts.survival } : {}),
    survivalGuardMs: 5_000,
  });
  supervisor.start();
  return {
    ...h,
    planner,
    server,
    tasks,
    world,
    clock,
    timers,
    dir,
    control,
    config,
    supervisor,
    notices,
    log,
    setReady(r: boolean) {
      ready = r;
      h.setReady(r);
    },
    setFingerprint(f: string) {
      fingerprint = f;
    },
    setConnectionEpoch(epoch: number) {
      connectionEpoch = epoch;
    },
    automaticRequests: () => planner.requests.filter((r) => r.autonomy !== undefined),
  };
}
