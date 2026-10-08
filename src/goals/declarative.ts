// MB-PLAN-006 no-follow-up-question policy (application-owned; a model cannot
// toggle it). Chunkbot never asks the owner a follow-up question, requests a
// confirmation or waits for an answer. Planner text that reaches the owner
// (interpretation, cannot_execute blocker/progress, task objectives) must be
// DECLARATIVE: an assumption stated, an action taken, or a concrete blocker.
//
// This module is the single code-owned detector used by the wire conversion and
// proposal validation. A proposal that asks the owner something is refused
// before any notice, state change or action and gets a bounded, COUNTED repair
// turn (existing allowances); exhaustion is a declarative blocker whose text is
// app-owned (the raw question is never relayed). Removing a question mark is
// not enforcement: owner-directed requests are detected by phrasing as well.
//
// Internal knowledge queries (needs_information) are not owner questions and
// stay allowed.

/** Problem prefix that marks a refusal under this policy (counted as `questionRefusals`). */
export const OWNER_QUESTION_PROBLEM = 'owner_question_refused';

/** The repair guidance the planner receives with a refusal (data, not owner text). */
export const NO_QUESTION_GUIDANCE =
  'Chunkbot never asks the owner follow-up questions or for confirmation. Choose the most reasonable grounded interpretation (fresh visible targets, the closest reachable match, a modest task-appropriate quantity, the visible owner for "here"), state the assumption declaratively and plan it; use needs_information for game knowledge; or answer cannot_execute with ONE declarative blocker (no question, no request for a reply).';

/** Short form carried in a repair turn's rejection (bounded problem text); the full rule is in the planner instructions. */
const SHORT_GUIDANCE = 'never ask the owner: plan the most reasonable grounded default (closest visible match, modest quantity, visible owner for "here"), query knowledge, or state ONE declarative blocker';

const PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\?/, why: 'contains a question mark' },
  { re: /\b(can|could|would|will|do|did|should|shall)\s+you\b/i, why: 'addresses a question to the owner' },
  { re: /\bwould\s+you\s+(like|prefer|rather)\b/i, why: "asks for the owner's preference" },
  { re: /\b(shall|should|may|can)\s+i\b/i, why: 'asks the owner for permission' },
  { re: /\b(let\s+me\s+know|tell\s+me\s+(which|what|where|whether|how|if))\b/i, why: 'requests information from the owner' },
  { re: /\bplease\s+(confirm|clarify|specify|choose|pick|select|tell|let|reply|respond|answer|provide|say|decide|indicate|share|send|type|point)\b/i, why: 'requests a reply from the owner' },
  { re: /\b(confirm|clarify|specify|choose|pick|decide|indicate)\s+(which|what|whether|where|how\s+many|if)\b/i, why: 'requests an owner decision' },
  { re: /\b(reply|respond)\s+(with|to|by)\b/i, why: 'requests a reply' },
  { re: /\banswer\s+q[0-9]/i, why: 'refers to a correlated question' },
  { re: /\b(wait(ing)?|await(ing)?)\s+(for\s+)?(your|the\s+owner'?s?|an?\s+owner)\s+(answer|reply|confirmation|decision|input|choice|response|instructions?)\b/i, why: 'waits for the owner' },
  { re: /\b(need|needs|needed|require|requires|required)\s+(your|the\s+owner'?s?|an?\s+owner)\s+(answer|reply|confirmation|decision|input|choice|response|clarification|preference)\b/i, why: 'requires an owner decision' },
  { re: /\b(will|to|must|should|need\s+to|going\s+to|first)\s+ask\s+(you|the\s+owner)\b/i, why: 'proposes asking the owner' },
  { re: /\bif\s+you\s+(want|prefer|meant|mean|would|wish|like|need)\b/i, why: 'solicits an owner refinement' },
  { re: /\b(which|what)\s+(one|tree|chicken|target|item|block|material|kind|type|site|place|location)\s+(do|did|should|would)\s+you\b/i, why: 'asks which target' },
];

/** Quoted owner words are data (e.g. an interpretation quoting the instruction), not Chunkbot asking. */
function withoutQuotes(text: string): string {
  return text.replace(/"[^"]{0,240}"|“[^”]{0,240}”/g, '""');
}

/** Why `text` asks the owner something (first matching rule), or undefined when declarative. */
export function ownerQuestionIn(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const t = withoutQuotes(text);
  for (const p of PATTERNS) if (p.re.test(t)) return p.why;
  return undefined;
}

/** Owner-facing text fields of a raw (wire or contract) proposal; screened before acceptance. */
export function ownerFacingFields(raw: unknown): Array<{ where: string; text: string }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const o = raw as Record<string, unknown>;
  const out: Array<{ where: string; text: string }> = [];
  const add = (where: string, v: unknown) => {
    if (typeof v === 'string' && v.length > 0) out.push({ where, text: v });
  };
  add('interpretation', o['interpretation']);
  add('missing', o['missing']);
  add('verifiedProgress', o['verifiedProgress']);
  add('question', o['question']);
  if (Array.isArray(o['tasks'])) {
    o['tasks'].slice(0, 16).forEach((t, i) => {
      if (t && typeof t === 'object') add(`tasks[${i}].objective`, (t as Record<string, unknown>)['objective']);
    });
  }
  return out;
}

/**
 * Policy problems for a raw proposal: the retired clarification disposition, a
 * `question` field, or owner-facing text that asks the owner something. Each
 * problem starts with OWNER_QUESTION_PROBLEM. Empty: declarative.
 */
export function ownerQuestionProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const o = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (o['disposition'] === 'needs_clarification') problems.push(`${OWNER_QUESTION_PROBLEM}: disposition needs_clarification does not exist; ${SHORT_GUIDANCE}`);
  else if (typeof o['question'] === 'string' && o['question'].trim().length > 0) problems.push(`${OWNER_QUESTION_PROBLEM}: a proposal cannot carry an owner question; ${SHORT_GUIDANCE}`);
  for (const f of ownerFacingFields(raw)) {
    if (f.where === 'question') continue;
    const why = ownerQuestionIn(f.text);
    if (why && problems.length < 6) problems.push(`${OWNER_QUESTION_PROBLEM}: ${f.where} ${why}; write it as a declarative assumption, action or blocker`);
  }
  return problems;
}

export function isOwnerQuestionProblem(problems: readonly string[]): boolean {
  return problems.some((p) => p.startsWith(OWNER_QUESTION_PROBLEM));
}

/** App-owned declarative blocker when bounded repairs could not remove an owner question (no raw planner text). */
export function questionBlockerText(repairs: number): string {
  return `the planner kept asking for an owner decision instead of acting (after ${repairs} repair turn${repairs === 1 ? '' : 's'}); Chunkbot does not ask follow-up questions, so nothing was asked and no action was taken. A new instruction can state the target or detail`;
}
