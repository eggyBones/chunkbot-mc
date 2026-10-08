// Projects the goal engine's code-owned status into the dashboard's directive
// and readiness sections. Text is bounded and passed through the evidence
// redactor; nothing here calls an adapter beyond the engine's status read.
import { isActiveGoalState, type Readiness } from '../contracts/index.ts';
import { DASHBOARD_BOUNDS, type DashboardAutonomy, type DashboardGoal, type DashboardMemorySummary, type DashboardPause, type DashboardPendingDirective, type DashboardSafety, type DashboardStatus } from '../contracts/dashboard.ts';
import type { SafetyStatus } from '../contracts/safety.ts';
import type { AutonomyStatus } from '../contracts/autonomy.ts';
import type { LocatorHint } from '../contracts/locator.ts';
import type { EngineStatus } from '../goals/goal-engine.ts';
import { redactString } from '../telemetry/redact.ts';

export const clipText = (s: string, max: number = DASHBOARD_BOUNDS.text): string => {
  const r = redactString(s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' '), max);
  return r.length > max ? `${r.slice(0, max - 1)}…` : r;
};
const clipShort = (s: string) => clipText(s, DASHBOARD_BOUNDS.shortText);

/** Read-only whitelist. Excludes raw vitals, threat identities, locations and history. */
export function projectSafety(s: SafetyStatus, now: number): DashboardSafety {
  return {
    source: 'app_state', observedAtMs: now, connectionEpoch: s.connectionEpoch,
    enabled: s.enabled, state: s.state, authority: s.authority.basis,
    response: s.state === 'responding' ? s.episode?.response ?? null : null,
    reason: s.blocker ? clipShort(s.blocker.reason) : s.episode ? clipShort(s.episode.hazards.join(', ')) : null,
    detail: clipText(s.blocker?.detail ?? s.authority.detail),
    episodeId: s.episode ? clipShort(s.episode.episodeId) : null,
    suspendedGoalId: s.episode?.suspended ? clipShort(s.episode.suspended.goalId) : null,
    counters: { episodes: s.counters.episodes, preemptions: s.counters.preemptions, retreats: s.counters.retreats, defenses: s.counters.defenses, attacksSent: s.counters.attacksSent, hitsConfirmed: s.counters.hitsConfirmed, defeatsConfirmed: s.counters.defeatsConfirmed },
  };
}

export type DirectiveSection = DashboardStatus['directive'];
export type ReadinessSection = DashboardStatus['readiness'];
export type SurvivalSummary = NonNullable<DirectiveSection['survival']>;

export function projectGoal(status: EngineStatus): DashboardGoal | undefined {
  const g = status.goal;
  if (!g) return undefined;
  const c = g.counters;
  return {
    id: clipShort(g.id),
    kind: g.kind ?? 'owner_goal',
    epoch: g.epoch,
    instruction: clipText(g.instruction),
    phase: g.state,
    ...(g.interpretation ? { interpretation: clipText(g.interpretation) } : {}),
    ...(g.outcome ? { outcome: clipText(g.outcome) } : {}),
    ...(g.progress ? { progress: clipText(g.progress) } : {}),
    admittedAtMs: g.admittedAtMs,
    updatedAtMs: g.updatedAtMs,
    ...(g.terminal ? { terminal: { reason: clipShort(g.terminal.reason), detail: clipText(g.terminal.detail), atMs: g.terminal.atMs } } : {}),
    ...(g.pendingClarification ? { clarification: { ref: clipShort(g.pendingClarification.ref), question: clipText(g.pendingClarification.question) } } : {}),
    ...(c ? { counters: { plannerTurns: c.plannerTurns, repairs: c.repairs, retries: c.retries, replans: c.replans, windows: c.windows, tasksAdmitted: c.tasksAdmitted } } : {}),
  };
}

/** Input of the read-only autonomy projection (supervisor status + route admission anchor + coarse locator hint). */
export interface AutonomyView {
  status: AutonomyStatus;
  admission?: { anchor: { x: number; y: number; z: number }; radius: number } | null;
  locator?: LocatorHint | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Bounded, redacted projection of the supervisor status (no controls, no inference). */
export function projectAutonomy(v: AutonomyView): DashboardAutonomy {
  const s = v.status;
  const src = s.active?.source;
  return {
    mode: clipShort(s.mode),
    detail: clipText(s.detail),
    scope: s.scope ? clipShort(`${s.scope.worldProfile}@r${s.scope.worldRevision}/${s.scope.botProfile}`) : null,
    persistence: { state: clipShort(s.persistence.state), detail: clipText(s.persistence.detail) },
    latch: { paused: s.latch.paused, durable: clipShort(s.latch.durable), ...(s.latch.source ? { source: clipShort(s.latch.source) } : {}), ...(s.latch.sinceMs !== undefined ? { sinceMs: s.latch.sinceMs } : {}) },
    active: s.active ? { goalId: clipShort(s.active.goalId), source: clipShort(src?.kind ?? 'owner'), ...(src?.kind === 'support' ? { routine: clipShort(src.routine) } : {}), priority: clipShort(s.active.priority) } : null,
    ownerIntent: s.ownerIntent ? { state: clipShort(s.ownerIntent.state), instruction: clipText(s.ownerIntent.instruction), detail: clipText(s.ownerIntent.detail), requiresOwnerDecision: s.ownerIntent.requiresOwnerDecision } : null,
    session: { progressionGoals: s.session.progressionGoals, maxProgressionGoals: s.session.limits.maxProgressionGoals, supportGoals: s.session.supportGoals, maxSupportGoals: s.session.limits.maxSupportGoals, plannerTurns: s.session.plannerTurns, maxPlannerTurns: s.session.limits.maxPlannerTurns, completed: s.session.completed, consecutiveUnproductive: s.session.consecutiveUnproductive },
    nextAssessmentAtMs: s.nextAssessmentAtMs,
    blocker: s.blocker ? { code: clipShort(s.blocker.code), detail: clipText(s.blocker.detail) } : null,
    home: s.home
      ? { state: clipShort(s.home.state), detail: clipText(s.home.detail), ownConfirmed: s.home.progress.ownConfirmed, cells: s.home.progress.cells, verified: s.home.verified ? clipShort(`${s.home.verified.status} ${s.home.verified.satisfied}/${s.home.verified.total}`) : null, dimension: clipShort(s.home.dimension), at: { x: s.home.origin.x, y: s.home.origin.y, z: s.home.origin.z } }
      : null,
    route: s.route
      ? { state: clipShort(s.route.state), legsUsed: s.route.legsUsed, maxLegs: s.route.maxLegs, distanceUsed: r1(s.route.distanceUsed), maxTotalDistance: s.route.maxTotalDistance, remainingMs: s.route.remainingMs, blocker: s.route.blocker ? clipShort(`${s.route.blocker.reason}: ${s.route.blocker.detail}`) : null, admissionAnchor: v.admission ? { x: r1(v.admission.anchor.x), y: r1(v.admission.anchor.y), z: r1(v.admission.anchor.z) } : null }
      : null,
    locator: v.locator ? { actionable: v.locator.actionable, reason: clipShort(v.locator.reason), direction: v.locator.direction, distanceBand: v.locator.distanceBand, elevation: v.locator.elevation, ageMs: v.locator.ageMs } : null,
  };
}

export function projectDirective(status: EngineStatus | undefined, pending: DashboardPendingDirective | undefined, survival: SurvivalSummary | undefined, pause?: DashboardPause, autonomy?: AutonomyView): DirectiveSection {
  const goal = status ? projectGoal(status) : undefined;
  const active = goal !== undefined && isActiveGoalState(goal.phase);
  const source = status?.goal?.source?.kind;
  const mode: DirectiveSection['mode'] = !active ? 'idle' : goal.kind === 'operator_task_diagnostic' ? 'operator_diagnostic' : source === 'progression' ? 'automatic_progression' : source === 'support' ? 'automatic_support' : 'owner_directive';
  const t = status?.task;
  const l = status?.lastTask;
  return {
    mode,
    ...(pause ? { pause: { paused: pause.paused, reason: clipText(pause.reason), sinceMs: pause.sinceMs, manualGoalsAllowed: pause.manualGoalsAllowed } } : {}),
    ...(goal ? { goal } : {}),
    task: {
      ...(t ? { current: { taskId: clipShort(t.taskId), objective: clipText(t.objective), mode: clipShort(t.mode), startedAtMs: t.startedAtMs } } : {}),
      ...(l ? { last: { taskId: clipShort(l.taskId), status: clipShort(l.status), reason: clipShort(l.reason), detail: clipText(l.detail), decisions: l.decisions, actions: l.actions } } : {}),
    },
    ...(pending
      ? { pending: { instruction: clipText(pending.instruction), state: pending.state, sinceMs: pending.sinceMs, ...(pending.detail ? { detail: clipText(pending.detail) } : {}) } }
      : {}),
    ...(survival
      ? {
          survival: {
            routine: clipShort(survival.routine),
            reason: clipText(survival.reason),
            ...(survival.phase ? { phase: clipShort(survival.phase) } : {}),
            ...(survival.attempt !== undefined ? { attempt: survival.attempt } : {}),
            sinceMs: survival.sinceMs,
          },
        }
      : {}),
    ...(autonomy ? { autonomy: projectAutonomy(autonomy) } : {}),
  };
}

const item = (r: Readiness | undefined, missing: string) => (r ? { ready: r.ready, detail: clipText(r.detail) } : { ready: false, detail: missing });

export function projectReadiness(status: EngineStatus | undefined, decision: Readiness | undefined): ReadinessSection {
  const r = status?.readiness;
  const none = 'application status not available';
  return {
    planner: item(r?.planner, none),
    decision: item(decision, 'decision adapter not installed'),
    perception: item(r?.observation, none),
    skills: item(r?.executor, none),
    tasks: item(r?.tasks, none),
    knowledge: item(r?.knowledge, none),
    capabilityCount: r?.capabilityCount ?? 0,
  };
}

const finitePos = (p: { x: number; y: number; z: number }) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 });

/** Bounds and redacts a memory summary from the memory feature (labels may be owner-provided text). */
export function projectMemory(m: DashboardMemorySummary): DashboardMemorySummary {
  return {
    items: m.items.slice(0, DASHBOARD_BOUNDS.memoryItems).map((i) => ({
      label: clipShort(i.label),
      kind: clipShort(i.kind),
      ...(i.dimension ? { dimension: clipShort(i.dimension) } : {}),
      source: clipShort(i.source),
      observedAtMs: i.observedAtMs,
      ...(i.at ? { at: finitePos(i.at) } : {}),
    })),
    totalItems: m.totalItems,
    worldProfile: m.worldProfile ? { id: clipShort(m.worldProfile.id), revision: typeof m.worldProfile.revision === 'number' ? m.worldProfile.revision : clipShort(m.worldProfile.revision) } : null,
    home: m.home ? { label: clipShort(m.home.label), dimension: clipShort(m.home.dimension), at: finitePos(m.home.at), source: clipShort(m.home.source), observedAtMs: m.home.observedAtMs, stale: m.home.stale } : null,
  };
}
