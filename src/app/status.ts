// Status rendering. Status never performs inference or game actions.
import type { ConnectionState, GoalRecord, ReadyInfo } from '../contracts/index.ts';
import type { EngineStatus } from '../goals/goal-engine.ts';

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
  if (goal.pendingClarification) line += ` — waiting for answer ${goal.pendingClarification.ref}: ${goal.pendingClarification.question}`;
  if (goal.interpretation) line += ` — interpreted: ${goal.interpretation.length > 160 ? `${goal.interpretation.slice(0, 159)}…` : goal.interpretation}`;
  if (goal.counters) {
    const c = goal.counters;
    line += ` — planner turns ${c.plannerTurns} (knowledge ${c.knowledgeRounds}, repairs ${c.repairs}, retries ${c.retries}, clarifications ${c.clarifications}, replans ${c.replans}), windows ${c.windows}, tasks ${c.tasksAdmitted}`;
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
    ? `${goal.state}${goal.terminal ? ` (${goal.terminal.reason})` : ''}${goal.pendingClarification ? ` awaiting ${goal.pendingClarification.ref}` : ''}`
    : 'idle';
  const planner = input.engine.readiness.planner.ready ? 'planner ready' : 'planner not ready';
  return `Status: ${input.connection}, goal ${goalPart}, ${planner}, ${input.engine.readiness.capabilityCount} capabilities`;
}
