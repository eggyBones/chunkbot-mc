// Projects the goal engine's code-owned status into the dashboard's directive
// and readiness sections. Text is bounded and passed through the evidence
// redactor; nothing here calls an adapter beyond the engine's status read.
import { isActiveGoalState, type Readiness } from '../contracts/index.ts';
import { DASHBOARD_BOUNDS, type DashboardGoal, type DashboardMemorySummary, type DashboardPause, type DashboardPendingDirective, type DashboardStatus } from '../contracts/dashboard.ts';
import type { EngineStatus } from '../goals/goal-engine.ts';
import { redactString } from '../telemetry/redact.ts';

export const clipText = (s: string, max: number = DASHBOARD_BOUNDS.text): string => {
  const r = redactString(s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' '), max);
  return r.length > max ? `${r.slice(0, max - 1)}…` : r;
};
const clipShort = (s: string) => clipText(s, DASHBOARD_BOUNDS.shortText);

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

export function projectDirective(status: EngineStatus | undefined, pending: DashboardPendingDirective | undefined, survival: SurvivalSummary | undefined, pause?: DashboardPause): DirectiveSection {
  const goal = status ? projectGoal(status) : undefined;
  const active = goal !== undefined && isActiveGoalState(goal.phase);
  const mode: DirectiveSection['mode'] = !active ? 'idle' : goal.kind === 'operator_task_diagnostic' ? 'operator_diagnostic' : 'owner_directive';
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
