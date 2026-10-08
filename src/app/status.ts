// Status rendering. Status never performs inference or game actions.
import type { ConnectionState, GoalRecord, ReadyInfo } from '../contracts/index.ts';
import type { EngineStatus } from '../goals/goal-engine.ts';
import { DASHBOARD_BOUNDS, type DashboardMemorySummary, type DashboardPause, type DashboardPendingDirective } from '../contracts/dashboard.ts';
import type { MemoryFact, MemoryScope } from '../contracts/memory.ts';

export interface StatusInput {
  connection: ConnectionState;
  ready: ReadyInfo | undefined;
  live: { dimension?: string; position?: { x: number; y: number; z: number }; health?: number };
  engine: EngineStatus;
  decision?: { ready: boolean; detail: string };
}

function goalLine(goal: GoalRecord | undefined): string {
  if (!goal) return 'goal: idle (no goal yet)';
  const instruction = goal.instruction.length > 80 ? `${goal.instruction.slice(0, 79)}…` : goal.instruction;
  let line = `goal: ${goal.id}${goal.kind === 'operator_task_diagnostic' ? ' [operator task diagnostic]' : ''} ${goal.state} "${instruction}"`;
  if (goal.terminal) line += ` — ${goal.terminal.reason}: ${goal.terminal.detail}`;
  if (goal.interpretation) line += ` — interpreted: ${goal.interpretation.length > 160 ? `${goal.interpretation.slice(0, 159)}…` : goal.interpretation}`;
  if (goal.counters) {
    const c = goal.counters;
    line += ` — planner turns ${c.plannerTurns} (knowledge ${c.knowledgeRounds}, repairs ${c.repairs}, retries ${c.retries}${c.questionRefusals ? `, question refusals ${c.questionRefusals}` : ''}, replans ${c.replans}${c.preparationTurns ? `, preparation ${c.preparationTurns}` : ''}${c.lookaheads ? `, lookahead ${c.lookaheads}` : ''}), windows ${c.windows}, tasks ${c.tasksAdmitted}`;
  }
  return line;
}

export function renderStatusLines(input: StatusInput): string[] {
  const lines: string[] = [];
  let conn = `connection: ${input.connection}`;
  if (input.connection === 'ready' && input.ready) {
    const pos = input.live.position ?? input.ready.position;
    conn += ` version=${input.ready.serverVersion} protocol=${input.ready.protocolVersion} dimension=${input.live.dimension ?? input.ready.dimension}`;
    conn += ` position=${pos.x},${pos.y},${pos.z}`;
    if (input.live.health !== undefined) conn += ` health=${input.live.health}`;
  }
  lines.push(conn);
  lines.push(goalLine(input.engine.goal));
  const r = input.engine.readiness;
  const readiness = (label: string, v: { ready: boolean; detail: string }) => `${label}=${v.ready ? 'ready' : 'not-ready'}`;
  lines.push(
    `adapters: ${readiness('planner', r.planner)} ${readiness('knowledge', r.knowledge)} ${readiness('perception', r.observation)} ${readiness('skills', r.executor)} capabilities=${r.capabilityCount} (catalog ${r.catalogVersion})`,
  );
  lines.push(`planner: ${r.planner.ready ? 'ready' : 'not-ready'} — ${r.planner.detail}`);
  lines.push(`decision: ${input.decision ? `${input.decision.ready ? 'ready' : 'not-ready'} — ${input.decision.detail}` : 'not installed'}; tasks: ${r.tasks.ready ? 'ready' : 'not-ready'}`);
  if (input.engine.task) lines.push(`task: ${input.engine.task.taskId} (${input.engine.task.mode}) "${input.engine.task.objective}"`);
  const e = input.engine;
  if (e.pending) {
    const p = e.pending;
    const instr = p.instruction.length > 80 ? `${p.instruction.slice(0, 79)}…` : p.instruction;
    let line = `pending instruction: ${p.intentId} ${p.state} "${instr}" (planner turns ${p.plannerTurns}; not admitted${p.activeGoalId ? `; ${p.activeGoalId} keeps control until handoff` : ''})`;
    lines.push(line);
  }
  // MB-FLOW-003-C12 held owner jobs (app-owned, declarative; never a question).
  for (const cp of e.checkpoints ?? []) {
    const last = cp.interruptions.at(-1)?.reason.replace(/_/g, ' ') ?? 'an interruption';
    const what = cp.state === 'held' ? `held after ${last}; continues when it is safe (continuation ${cp.continuations.used + 1} of at most ${cp.continuations.max}); stop cancels it` : cp.state === 'continuing' ? `continuing after ${last} (continuation ${cp.continuations.used}/${cp.continuations.max})` : cp.state === 'blocked' ? `held after ${last}, not continued: ${cp.stateReason.replace(/[_:]/g, ' ')}; a new instruction replaces it` : cp.state.replace(/_/g, ' ');
    lines.push(`owner job ${cp.goalId}: ${what} — ${cp.publicOutcome.slice(0, 160)}`);
  }
  if (e.parked) lines.push('handoff: the current goal finished its admitted step and starts no new work until the pending instruction is ready');
  const h = e.handoff;
  if (h && (h.preparations > 0 || h.lookaheadTurns > 0)) {
    lines.push(`handoff totals: preparations ${h.preparations} (handed off ${h.handedOff}, discarded ${h.discarded}; discarded planner turns ${h.discardedTurns}/${h.discardedTurnAllowance}, transferred ${h.transferredTurns}), lookahead turns ${h.lookaheadTurns} (used ${h.lookaheadsUsed}, discarded ${h.lookaheadsDiscarded})`);
  }
  const gap = e.windowGaps?.at(-1);
  if (gap) lines.push(`last window gap: ${gap.gapMs} ms after window ${gap.afterWindow} of ${gap.goalId} (${gap.source}${gap.revalidationMs !== undefined ? `, revalidation ${gap.revalidationMs} ms` : ''})`);
  if (e.latch?.paused) lines.push(`Automatic work paused (stop${e.latch.source ? ` from ${e.latch.source}` : ''}); automatic follow-on work stays off until \`resume\`${e.goal && !e.goal.terminal ? '; the current goal is owner-commanded and runs normally' : ''}`);
  if (input.engine.lastTask) {
    const t = input.engine.lastTask;
    lines.push(`last task: ${t.taskId} ${t.status} (${t.reason}) decisions=${t.decisions} actions=${t.actions} localContinuations=${t.localContinuations} — ${t.detail}`);
  }
  if (!r.planner.ready) lines.push('note: the gameplay planner is not ready; admitted goals cannot be planned or executed (operator /task diagnostics use the controller directly)');
  return lines;
}

/** One compact line for in-game replies. */
export function renderStatusChat(input: StatusInput): string {
  const goal = input.engine.goal;
  const goalPart = goal
    ? `${goal.state}${goal.terminal ? ` (${goal.terminal.reason})` : ''}`
    : 'idle';
  const planner = input.engine.readiness.planner.ready ? 'planner ready' : 'planner not ready';
  const p = input.engine.pending;
  const pendingPart = p ? `, new instruction ${p.state}` : '';
  const paused = input.engine.latch?.paused ? ', automatic work paused' : '';
  return `Status: ${input.connection}, goal ${goalPart}${pendingPart}${paused}, ${planner}, ${input.engine.readiness.capabilityCount} capabilities`;
}

/**
 * Dashboard seam (MB-UI-001 <- MB-FLOW-002): the pending (not admitted)
 * instruction, if any. "Pending" never means started; the active goal stays
 * visible separately in the directive section.
 */
export function pendingDirectiveFrom(engine: EngineStatus | undefined): DashboardPendingDirective | undefined {
  const p = engine?.pending;
  if (!p) return undefined;
  const state = p.state === 'handing_off' ? 'ready_to_switch' : p.state;
  // MB-PLAN-006: there are no owner questions; legacy question fields are never rendered.
  const detail = p.state === 'handing_off'
      ? 'plan ready; switching after the current work is released'
      : `${p.plannerTurns} planner turn(s) so far; ${p.activeGoalId ? `${p.activeGoalId} keeps control until handoff` : 'nothing else is running'}`;
  return { instruction: p.instruction.slice(0, 1_000), state, sinceMs: p.receivedAtMs, detail: detail.slice(0, 1_000) };
}

/**
 * Dashboard seam (MB-UI-001 <- MB-MEM-001): the configured memory scope, the
 * designated home and the most recently confirmed active facts. Everything is
 * REMEMBERED (historical) evidence, never a claim about the current world.
 */
export function memorySummaryFrom(facts: readonly MemoryFact[], scope: MemoryScope | undefined, nowMs: number, staleAfterMs: number): DashboardMemorySummary {
  const active = facts.filter((f) => f.status === 'active').sort((a, b) => b.lastConfirmedMs - a.lastConfirmedMs);
  const home = active.find((f) => f.category === 'home' && f.location);
  return {
    totalItems: active.length,
    items: active.slice(0, DASHBOARD_BOUNDS.memoryItems).map((f) => ({
      label: f.label.slice(0, 200),
      kind: f.category,
      ...(f.location ? { dimension: f.location.dimension, at: { ...f.location.at } } : {}),
      source: f.source,
      observedAtMs: f.lastConfirmedMs,
    })),
    worldProfile: scope ? { id: scope.worldProfile, revision: scope.worldRevision } : null,
    home: home?.location
      ? { label: home.label.slice(0, 200), dimension: home.location.dimension, at: { ...home.location.at }, source: home.source, observedAtMs: home.lastConfirmedMs, stale: nowMs - home.lastConfirmedMs > staleAfterMs }
      : null,
  };
}

/**
 * Dashboard seam (MB-UI-001 <- MB-FLOW-002): the stop latch pauses AUTOMATIC
 * work only; explicit owner goals are always allowed (an executing owner goal
 * is never "paused"). Reading it authorizes nothing.
 */
export function pauseFrom(engine: EngineStatus | undefined): DashboardPause | undefined {
  const latch = engine?.latch;
  if (!latch) return undefined;
  return latch.paused
    ? { paused: true, reason: `Automatic work paused (stop${latch.source ? ` from ${latch.source}` : ''}); resume to allow automatic follow-on work`, sinceMs: latch.sinceMs ?? null, manualGoalsAllowed: true }
    : { paused: false, reason: 'automatic work allowed', sinceMs: null, manualGoalsAllowed: true };
}
