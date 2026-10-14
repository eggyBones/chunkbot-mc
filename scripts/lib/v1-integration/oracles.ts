import { createHash } from 'node:crypto';
import type { Evidence, Event, Result, Scenario, Vec } from './types.ts';

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
  require(choices.every((v) => e.events.some((r) => r.type === 'jev_request' && r.goalId === e.goalId && r.requestId === v.requestId && r.endpoint === 'openrouter')), 'real OpenRouter request evidence is absent (fault-provider output cannot prove acceptance)');
  require(!e.events.some((v) => /rerout|prohibited_event|model_mismatch/.test(String(v.kind))), 'provider isolation/route failure observed');
  require(!e.events.some((v) => v.truncated === true), 'truncated event evidence cannot verify acceptance');
  require(!e.journal.some((v) => v.truncated === true), 'truncated planner journal cannot verify acceptance');
  if (s.family === 'stop' || s.family === 'lifecycle') {
    const expectedReason = s.trigger === 'disconnect' ? 'kicked' : s.trigger === 'death' ? 'death' : 'shutdown';
    require(end && (s.family === 'stop' ? end.reason === 'owner_stop' : end.reason === expectedReason), 'expected ownership-revoking terminal is absent');
    require(goal.some((v) => v.type === 'goal_cleanup' && v.failed === 0), 'goal cleanup failed or is unproved');
    require(e.stop && e.stop.activeAtMs <= e.stop.sentAtMs, 'trigger did not prove an active provider/skill');
    if (e.stop) {
      const after = e.events.filter((v) => atMs(v) > e.stop!.sentAtMs);
      require(!after.some((v) => v.type === 'task_action' && v.goalId === e.goalId), 'late result was published after revocation');
      const cancelled = e.events.filter((v) => v.type === 'skill_outcome' && v.goalId === e.goalId && v.goalEpoch === e.epoch && v.status === 'cancelled' && v.actionId === e.stop!.actionId);
      if (['movement', 'mining', 'crafting', 'furnace'].includes(e.stop.family)) {
        require(typeof e.stop.actionId === 'string', 'cancelled skill action identity is absent');
        require(cancelled.length > 0, 'in-flight skill cancellation was not exercised');
        for (const v of cancelled) {
          const evidence = object(v.evidence), clear = object(evidence.cleanup), iface = object(evidence.interfaceAfterSettle);
          require(typeof clear.clearMs === 'number' && clear.clearMs <= 250 && Array.isArray(clear.errors) && clear.errors.length === 0 && clear.clearedShared === true, 'control-clear target/lease cleanup unproved');
          require(iface.currentWindow === null && iface.pendingRequests === 0, 'interface cleanup is unproved');
          require(evidence.commandsAfterRevoke === 0 && ['none', 'server_packet', 'server_sync'].includes(String(object(evidence.partialEffects).confirmed)), 'partial effects or post-revocation commands invalid');
        }
      }
      if (e.stop.family === 'planner') {
        require(typeof e.stop.requestId === 'string' && after.some((v) => v.type === 'planner_process_cleanup' && v.goalId === e.goalId && v.requestId === e.stop!.requestId && Array.isArray(v.remaining) && v.remaining.length === 0), 'owned planner process cleanup is unproved');
        require(after.some((v) => v.type === 'planner_turn_failed' && v.requestId === e.stop!.requestId && v.kind === 'aborted'), 'real in-flight planner transport abort is unproved');
      }
      if (e.stop.family === 'decision') {
        require(!after.some((v) => v.type === 'task_choice' && v.goalId === e.goalId), 'late decision published');
        require(typeof e.stop.requestId === 'string' && after.some((v) => v.type === 'jev_failure' && v.requestId === e.stop!.requestId && v.kind === 'aborted' && typeof object(v.spend).retainedUsd === 'number' && Number(object(v.spend).retainedUsd) > 0), 'in-flight Jev abort and ambiguous-charge retention are unproved');
      }
    }
    if (s.family === 'lifecycle') require(e.freshIdle && e.freshIdle.untilMs - e.freshIdle.sinceMs >= 3_000 && !e.freshIdle.events.some((v) => ['goal_admitted', 'planner_request', 'task_round', 'skill_started'].includes(v.type)), 'fresh reconnect/restart idle without replay is unproved');
  } else if (s.family === 'privacy') {
    // Bound this trial to the initial hidden scene: stop at the first actual
    // Jev request, BEFORE any skill. A later legitimate sighting is a different
    // observation boundary and cannot be judged against initial occlusion.
    require(end?.reason === 'owner_stop' && goal.some((v) => v.type === 'goal_cleanup' && v.failed === 0), 'bounded privacy probe did not revoke and clean up');
    require(!e.events.some((v) => v.type === 'skill_started'), 'privacy probe acted before the initial hidden-data boundary was captured');
    require(distance(e.position, { x: 205.5, y: -60, z: 205.5 }) <= 0.05, 'privacy probe left its independently staged opaque-wall position');
    require(e.captureComplete && e.captures.some((c) => c.provider === 'planner') && e.captures.some((c) => c.provider === 'jev'), 'complete actual planner/Jev payload capture is absent');
    require(e.hiddenFacts.length > 0, 'independent hidden server facts are absent');
    require(e.captures.every((c) => c.goalId === e.goalId && c.requestId && Number.isFinite(c.atMs)), 'payload capture binding is invalid');
    const requests = goal.filter((v) => ['planner_turn_started', 'jev_request'].includes(v.type));
    const key = (provider: string, id: unknown, attempt: unknown) => `${provider}:${String(id)}:${String(attempt ?? 0)}`;
    const keys = e.captures.map((c) => key(c.provider, c.requestId, c.attempt));
    require(new Set(keys).size === keys.length && requests.length === e.captures.length, 'payload capture coverage has missing/duplicate/extra requests');
    for (const c of e.captures) {
      const r = requests.find((v) => key(v.type === 'jev_request' ? 'jev' : 'planner', v.requestId, v.type === 'jev_request' ? v.attempt : undefined) === key(c.provider, c.requestId, c.attempt));
      const hash = createHash('sha256').update(c.body).digest('hex');
      require(r && (c.provider === 'planner' ? r.promptDigest === hash.slice(0, 12) : r.bodyDigest === hash) && Math.abs(atMs(r) - c.atMs) <= 1_000, 'capture is not bound to actual transmitted request bytes');
    }
    for (const hidden of e.hiddenFacts) require(!e.captures.some((c) => c.body.includes(hidden)), 'hidden server fact leaked into a model payload');
    require((e.hiddenLocations?.length ?? 0) > 0, 'independently staged hidden-location proof is absent');
    for (const p of e.hiddenLocations ?? []) require(!e.captures.some((c) => containsLocation(c.body, p)), 'hidden location leaked despite formatting differences');
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
    if (s.family === 'movement' || s.returnToOwner) require(distance(e.position, e.ownerPosition) <= 3, 'server owner proximity is unproved');
    if (s.family === 'equipment') require(e.equipped.head === 'minecraft:iron_helmet', 'server head equipment is unproved');
    if (s.family === 'replan') {
      require(e.interventions.some((v) => v.kind === 'fault'), 'target removal was not exercised');
      require(goal.some((v) => v.type === 'planner_request' && v.turnKind === 'replan'), 'outcome-preserving replan was not exercised');
    }
  }
  return problems;
}
function distance(a: Evidence['position'], b: Evidence['position']): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
export function containsLocation(body: string, p: Vec): boolean {
  const visit = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false;
    if (Array.isArray(v)) return (v.length === 3 && v[0] === p.x && v[1] === p.y && v[2] === p.z) || v.some(visit);
    const o = object(v); return (o.x === p.x && o.y === p.y && o.z === p.z) || Object.values(o).some(visit);
  };
  for (const input of [body, body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)]) {
    try { if (visit(JSON.parse(input) as unknown)) return true; } catch { /* prose prompt: scan coordinate text below */ }
  }
  const n = (v: number) => `${String(v).replace('.', '\\.')}\\b(?:\\.0+)?`;
  return new RegExp(`${n(p.x)}\\s*[, /]\\s*${n(p.y)}\\s*[, /]\\s*${n(p.z)}`).test(body);
}

function material(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(material);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(object(v)).filter(([k]) => !['snapshotId', 'handle', 'anchorId', 'actionId', 'at', 'x', 'y', 'z'].includes(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, material(value)]));
  return v;
}
export function planSignature(e: Evidence): string {
  const tasks = e.journal.filter((v) => v.type === 'goal_proposal_accepted' && v.goalId === e.goalId).flatMap((v) => {
    const p = object(v.proposal);
    return Array.isArray(p.tasks) ? p.tasks.map((t: unknown) => { const task = object(t); return { capabilities: task.allowedCapabilities, parameters: task.parameters, selectors: task.targetSelectors, completion: task.completion }; }) : [];
  });
  return tasks.length ? JSON.stringify(material(tasks)) : '';
}
export function generalityProblems(results: readonly Result[]): string[] {
  const trials = ['V1-RESOURCE-EMPTY', 'V1-RESOURCE-TOOL', 'V1-RESOURCE-STOCK'].map((id) => results.find((r) => r.id === id));
  if (trials.some((r) => r?.phase !== 'verified' || !r.autonomous || !r.evidence)) return ['three autonomous prerequisite-changing resource trials are not verified'];
  const signatures = trials.map((r) => planSignature(r!.evidence!));
  const problems = signatures.some((s) => !s) || new Set(signatures).size < 2 ? ['materially different prerequisite plans are unproved'] : [];
  const tool = trials[1]!.evidence!;
  const empty = trials[0]!.evidence!;
  if (!empty.events.some((v) => v.type === 'task_action' && v.capability === 'craft_item' && /pickaxe/.test(JSON.stringify(v.evidence)))) problems.push('empty-inventory trial did not prove planner-chosen tool prerequisites');
  if (tool.events.some((v) => v.type === 'task_action' && v.goalId === tool.goalId && v.capability === 'craft_item' && /pickaxe|stick|planks/.test(JSON.stringify(v.evidence)))) problems.push('suitable-tool trial repeats unnecessary tool prerequisites');
  if (!results.some((r) => r.id === 'V1-COMPOSITION' && r.phase === 'verified' && r.autonomous)) problems.push('acceptance-selected untemplated composition is unproved');
  return problems;
}
