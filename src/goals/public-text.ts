// MB-PLAN-006 hard boundary for owner-visible text (chat, terminal notices,
// status, dashboard). Planner prose (interpretation, cannot_execute blocker,
// planner-reported progress, task objectives) is NEVER relayed to the owner:
// these APPLICATION-OWNED renderings are built only from structured,
// code-validated data (the accepted outcome contract, capability ids, code
// reason codes, code counters). The question detector in declarative.ts is
// defense in depth on top of this boundary. Raw planner text stays internal
// (planner requests, the redacted run store and planner journal).
import type { GoalOutcomeContract, KnowledgeResult, TaskFeedback, TaskSpec } from '../contracts/index.ts';
import { describePredicate } from '../dashboard/outcome-text.ts';
import { ownerQuestionIn } from './declarative.ts';

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const CODE_ID = /^[a-z][a-z0-9_]{1,47}$/;

/** "Done when the bot …" / "Keeps going while the bot …" from the accepted contract only. */
export function publicOutcome(contract: GoalOutcomeContract): string {
  const body = describePredicate(contract.kind === 'finite' ? contract.outcome : contract.maintain);
  return clip(contract.kind === 'finite' ? `Done when the bot ${body}.` : `Keeps going while the bot ${body}, until told to stop or blocked.`, 400);
}

/** One task step for status/dashboard/terminal: its capabilities and code-checked completion, never its prose objective. */
export function publicTaskLabel(spec: Pick<TaskSpec, 'allowedCapabilities' | 'completion'>): string {
  return clip(`${spec.allowedCapabilities.slice(0, 6).join(', ')} until the bot ${describePredicate(spec.completion)}`, 200);
}

/** Code reason codes (snake_case) rendered as words; never model prose. */
const REASONS: Record<string, string> = {
  no_visible_target: 'no matching target is visible',
  named_target_not_visible: 'the chosen target is no longer visible',
  named_target_not_eligible: 'the chosen target cannot be used for this step',
  out_of_reach: 'the target is out of reach',
  no_safe_path: 'no safe walking path was found',
  outside_travel_bounds: 'the target is outside the travel limit',
  harvest_tool_missing: 'a required harvest tool is missing',
  missing_ingredients: 'ingredients are missing',
  workstation_required: 'a workstation is required',
  owner_not_visible: 'the owner is not visible',
  no_vacant_site: 'no vacant flat site is visible nearby',
  home_project_exists: 'a home project already exists',
  no_entity_in_reach: 'no matching creature is within reach',
  no_progress: 'no progress was made',
  per_target_retries_exhausted: 'retries on the target were used up',
  no_candidates: 'no grounded action was available',
};

function reasonText(code: string): string | undefined {
  if (!CODE_ID.test(code)) return undefined;
  return REASONS[code] ?? code.replace(/_/g, ' ');
}

/**
 * App-owned declarative blocker for a planner `cannot_execute`: the planner's
 * own wording is not relayed; only capability ids it named (code-shaped and
 * declarative) and the latest code-verified task reasons are shown.
 */
export function publicBlocker(input: { missingCapabilities: readonly string[]; feedback: readonly TaskFeedback[]; knowledge?: readonly KnowledgeResult[] }): string {
  const parts: string[] = ['the planner found no supported way to continue'];
  const ownerSafe = (c: string) => CODE_ID.test(c) && ownerQuestionIn(c.replace(/_/g, ' ')) === undefined;
  const caps = [...new Set(input.missingCapabilities.filter(ownerSafe))].slice(0, 4);
  if (caps.length > 0) parts.push(`missing capabilities: ${caps.join(', ')}`);
  // P-PLAN-R20: capability ids this goal queried that the CODE catalog answered
  // as not implemented (status "unknown"). A code fact, named even when the
  // planner described the gap only in prose (which stays internal).
  const checked = [...new Set((input.knowledge ?? []).filter((r) => r.query.kind === 'capability' && r.status === 'unknown').map((r) => (r.query as { id: string }).id).filter((id) => ownerSafe(id) && !caps.includes(id)))].slice(0, 4);
  if (checked.length > 0) parts.push(`not implemented (checked against the capability catalog): ${checked.join(', ')}`);
  const last = input.feedback.at(-1);
  if (last) {
    const why = reasonText(last.reason);
    const unavailable = [...new Set(last.unavailable.map((u) => reasonText(u.reason)).filter((x): x is string => Boolean(x)))].slice(0, 3);
    parts.push(`last step ${last.status}${why ? ` (${why})` : ''}${unavailable.length ? `; ${unavailable.join('; ')}` : ''}`);
  }
  return clip(parts.join('; '), 400);
}
