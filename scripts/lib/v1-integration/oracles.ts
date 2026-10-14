import type { Evidence, Event, Result, Scenario } from './types.ts';

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const atMs = (e: Event): number => Date.parse(e.t ?? '');
const sameGoal = (e: Evidence) => e.events.filter((v) => v.goalId === e.goalId);
const terminal = (e: Evidence) => sameGoal(e).filter((v) => v.type === 'goal_terminal').at(-1);

export function verifyEvidence(s: Scenario, e: Evidence): string[] {
  const problems: string[] = [];
  const require = (condition: unknown, detail: string) => { if (!condition) problems.push(detail); };
  const goal = sameGoal(e), end = terminal(e);
  require(goal.some((v) => v.type === 'goal_admitted' && v.epoch === e.epoch && v.kind !== 'operator_task_diagnostic'), 'ordinary goal admission is absent');
  require(!goal.some((v) => v.type === 'clarification_requested' || v.state === 'awaiting_owner'), 'owner question/answer wait observed');
  require(!e.lines.some((v) => /^\[chunkbot\] /.test(v) && /Question q\d+|answer q\d+|reply: answer|\?/.test(v) && !/^\[chunkbot\] \[chat\]/.test(v)), 'owner-facing question observed');
  require(e.events.some((v) => v.type === 'planner_turn_started' && v.goalId === e.goalId && v.authMode === 'chatgpt' && v.selectedModel === 'gpt-6.1-sol' && v.effort === 'low' && typeof v.catalogVersion === 'string'), 'real subscription planner route/catalog evidence is absent');
  const choices = goal.filter((v) => v.type === 'task_choice');
  require(choices.every((v) => v.provider === 'TypeSafe' && /^typesafe\/jev-1\.13(?:-|$)/.test(String(v.model)) && typeof v.costUsd === 'number'), 'Jev route or cost evidence is invalid');
  require(!e.events.some((v) => /rerout|prohibited_event|model_mismatch/.test(String(v.kind))), 'provider isolation/route failure observed');
  require(!e.events.some((v) => v.truncated === true), 'truncated event evidence cannot verify acceptance');
  require(!e.journal.some((v) => v.truncated === true), 'truncated planner journal cannot verify acceptance');
  if (s.family === 'stop' || s.family === 'lifecycle') {
    require(end && (s.family === 'stop' ? end.reason === 'owner_stop' : ['disconnect', 'shutdown'].includes(String(end.reason))), 'expected ownership-revoking terminal is absent');
    require(goal.some((v) => v.type === 'goal_cleanup' && v.failed === 0), 'goal cleanup failed or is unproved');
    require(e.stop && e.stop.activeAtMs <= e.stop.sentAtMs, 'trigger did not prove an active provider/skill');
    if (e.stop) {
      const after = e.events.filter((v) => atMs(v) > e.stop!.sentAtMs);
      require(!after.some((v) => v.type === 'task_action' && v.goalId === e.goalId), 'late result was published after revocation');
      const cancelled = e.events.filter((v) => v.type === 'skill_outcome' && v.goalId === e.goalId && v.goalEpoch === e.epoch && v.status === 'cancelled');
      if (['movement', 'mining', 'crafting', 'furnace'].includes(e.stop.family)) {
        require(cancelled.length > 0, 'in-flight skill cancellation was not exercised');
        for (const v of cancelled) {
          const evidence = object(v.evidence), clear = object(evidence.cleanup), iface = object(evidence.interfaceAfterSettle);
          require(typeof clear.clearMs === 'number' && clear.clearMs <= 250 && Array.isArray(clear.errors) && clear.errors.length === 0 && clear.clearedShared === true, 'control-clear target/lease cleanup unproved');
          require(iface.currentWindow === null && iface.pendingRequests === 0, 'interface cleanup is unproved');
          require(evidence.commandsAfterRevoke === 0 && ['none', 'server_packet', 'server_sync'].includes(String(object(evidence.partialEffects).confirmed)), 'partial effects or post-revocation commands invalid');
        }
      }
      if (e.stop.family === 'planner') require(e.events.some((v) => v.type === 'planner_process_cleanup' && v.goalId === e.goalId && Array.isArray(v.remaining) && v.remaining.length === 0), 'owned planner process cleanup is unproved');
      if (e.stop.family === 'decision') require(!after.some((v) => v.type === 'task_choice' && v.goalId === e.goalId), 'late decision published');
    }
    if (s.family === 'lifecycle') require(e.freshIdle && e.freshIdle.untilMs - e.freshIdle.sinceMs >= 3_000 && !e.freshIdle.events.some((v) => ['goal_admitted', 'planner_request', 'task_round', 'skill_started'].includes(v.type)), 'fresh reconnect/restart idle without replay is unproved');
  } else if (s.family === 'privacy') {
    require(e.captureComplete && e.captures.some((c) => c.provider === 'planner') && e.captures.some((c) => c.provider === 'jev'), 'complete actual planner/Jev payload capture is absent');
    require(e.hiddenFacts.length > 0, 'independent hidden server facts are absent');
    require(e.captures.every((c) => c.goalId === e.goalId && c.requestId && Number.isFinite(c.atMs)), 'payload capture binding is invalid');
    for (const hidden of e.hiddenFacts) require(!e.captures.some((c) => c.body.includes(hidden)), 'hidden server fact leaked into a model payload');
  } else if (s.persistent) {
    require(!end, 'persistent goal terminated');
    require(goal.some((v) => v.type === 'goal_outcome_bound' && v.kind === 'persistent'), 'persistent outcome was not bound');
    require(distance(e.position, e.ownerPosition) <= 3, 'server owner proximity is unproved');
    require(choices.length > 0, 'real Jev choice is absent');
  } else {
    require(end?.state === 'completed' && end.reason === 'outcome_verified', 'code-verified goal completion is absent');
    require(goal.some((v) => v.type === 'goal_outcome_evaluated' && v.status === 'satisfied'), 'final goal predicate evidence is absent');
    require(goal.filter((v) => v.type === 'goal_outcome_bound').length === 1 && goal.some((v) => v.type === 'goal_outcome_bound' && v.fromAdmission === true), 'immutable admission-bound outcome is unproved');
    require(choices.length > 0, 'real Jev choice is absent');
    for (const [key, count] of Object.entries(s.outputs)) {
      const needed = s.family === 'resource' && s.instruction.includes('additional') || s.family === 'replan' ? count + (e.baseline[key] ?? 0) : count;
      require((e.inventory[key] ?? 0) >= needed, `server inventory does not prove ${needed} ${key}`);
    }
    if (s.id === 'V1-STONE') require((e.inventory['minecraft:stone'] ?? 0) >= 4, 'cobblestone is not stone');
    if (s.family === 'movement') require(distance(e.position, e.ownerPosition) <= 3, 'server owner proximity is unproved');
    if (s.family === 'equipment') require(e.equipped.head === 'minecraft:iron_helmet', 'server head equipment is unproved');
    if (s.family === 'replan') {
      require(e.interventions.some((v) => v.kind === 'fault'), 'target removal was not exercised');
      require(goal.some((v) => v.type === 'planner_request' && v.turnKind === 'replan'), 'outcome-preserving replan was not exercised');
    }
  }
  return problems;
}
function distance(a: Evidence['position'], b: Evidence['position']): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

export function planSignature(e: Evidence): string {
  const tasks = e.journal.filter((v) => v.type === 'goal_proposal_accepted' && v.goalId === e.goalId).flatMap((v) => {
    const p = object(v.proposal);
    return Array.isArray(p.tasks) ? p.tasks.map((t: unknown) => { const task = object(t); return { capabilities: task.allowedCapabilities, parameters: task.parameters, selectors: task.targetSelectors, completion: task.completion }; }) : [];
  });
  return tasks.length ? JSON.stringify(tasks) : '';
}
export function generalityProblems(results: readonly Result[]): string[] {
  const trials = ['V1-RESOURCE-EMPTY', 'V1-RESOURCE-TOOL', 'V1-RESOURCE-STOCK'].map((id) => results.find((r) => r.id === id));
  if (trials.some((r) => r?.phase !== 'verified' || !r.autonomous || !r.evidence)) return ['three autonomous prerequisite-changing resource trials are not verified'];
  const signatures = trials.map((r) => planSignature(r!.evidence!));
  const problems = signatures.some((s) => !s) || new Set(signatures).size < 2 ? ['materially different prerequisite plans are unproved'] : [];
  const tool = trials[1]!.evidence!;
  if (tool.events.some((v) => v.type === 'task_action' && v.goalId === tool.goalId && v.capability === 'craft_item' && /pickaxe|stick|planks/.test(JSON.stringify(v.evidence)))) problems.push('suitable-tool trial repeats unnecessary tool prerequisites');
  if (!results.some((r) => r.id === 'V1-COMPOSITION' && r.phase === 'verified' && r.autonomous)) problems.push('acceptance-selected untemplated composition is unproved');
  return problems;
}
