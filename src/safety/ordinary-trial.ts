// Dedicated ordinary-pipeline acceptance oracles/proposal. Never gameplay
// policy, a planner fixture, or an authority supplier. All inputs are evidence.
import { SAFETY_RAISED_LAYOUT, SAFETY_TRIAL_BOX, trialEntitySelector, waterArenaPlan, mobArenaPlan, type TrialBox } from './trial-arena.ts';
import { parseEntityTest } from './trial-journal.ts';
import { serverWaterSupport, type TrialWaterSupport } from './trial-water.ts';

export type OrdinaryEvidence = Record<string, any>;
export interface TrialPosition { x: number; y: number; z: number }
export interface OrdinaryOptions { fixture: '26.1.2' | '26.2'; lease: string; raised: true }
export const ORDINARY_BACKUP: TrialBox = [240, 200, 190, 270, 213, 220];
export const ORDINARY_POINTS = {
  bot: { x: 259.5, y: -52, z: 205.5 },
  owner: { x: 264.5, y: -52, z: 205.5 },
  ownerWalk: { x: 263.5, y: -52, z: 213.5 },
  pool: { x: 255.5, y: -56, z: 205.5 },
  mob: { x: 255.5, y: -52, z: 205.5 },
  ownerMob: { x: 255.5, y: -52, z: 211.5 },
} as const satisfies Record<string, TrialPosition>;
export const ORDINARY_LOGS: TrialPosition[] = [244, 249].flatMap((x) => [-52, -51, -50].map((y) => ({ x, y, z: 212 })));
export const ORDINARY_CASES = [
  { id: 'SAFE', goal: 'Follow me and stay nearby.', proof: 'ordinary sustained follow continues; current cow/wolf/player remain unprovoked and unattacked' },
  { id: 'WAIT', goal: 'Follow me and stay nearby.', proof: 'water escape during an actual outstanding planner request; stop cancels motion; new manual goal grants only after old cleanup' },
  { id: 'WORK', goal: 'Gather six additional oak logs.', proof: 'partial server acquisition, water interruption of an actual task, original outcome/baseline/anchor retained, code-verified final six additional logs' },
  { id: 'AVOID', goal: 'Follow me and stay nearby.', proof: 'unarmed zombie and effect-free creeper avoidance during ordinary work; temporary owner cue withdrawal; replacement fences old action' },
  { id: 'DEFEND', goal: 'Follow me and stay nearby.', proof: 'current engaging isolated adult zombie and verified gear; bounded server hits/death; no player/passive/neutral attacks' },
] as const;

/** No filesystem/network/process work is needed to review this exact proposal. */
export function ordinaryProposal() {
  return {
    schema: 'chunkbot.safety-ordinary-proposal', version: 1,
    mode: 'real Codex subscription + real Jev; coordinator-injected key only',
    executor: 'actual dist/cli.js run --no-autonomy; no in-process SkillRuntime or safety stand-in',
    scene: [...SAFETY_TRIAL_BOX], backup: [...ORDINARY_BACKUP], cells: 13454,
    staging: { ...SAFETY_RAISED_LAYOUT, mutation: [...SAFETY_RAISED_LAYOUT.mutation] },
    fullBodySelector: trialEntitySelector(SAFETY_TRIAL_BOX),
    points: ORDINARY_POINTS, logs: ORDINARY_LOGS,
    water: waterArenaPlan(false, SAFETY_RAISED_LAYOUT), mobs: mobArenaPlan(SAFETY_RAISED_LAYOUT),
    cases: ORDINARY_CASES,
    settings: 'read original difficulty/rules/forceload; only Peaceful -> Easy if required, finally exact difficulty/rules/forceload equality; no time/rule/bed/respawn writes',
    cleanup: 'unique run-tagged summons and declared scene item/xp only; original clone comparison before clearing backup; actual CLI exit 0, owner disconnect, zero players',
    limits: 'unchanged application caps and one CLI/safety history across all cases; no production reset, synthetic readiness, model facts or packet injection',
    pending: 'ROOT geometry/source approval and named exclusive lease BEFORE execution; beyond-128 follow requires separate ROOT-authorized far-route geometry; these bounded cases alone cannot certify it',
  };
}

export function parseOrdinaryOptions(argv: readonly string[]): OrdinaryOptions | { describe: true } {
  if (argv.length === 1 && argv[0] === '--describe') return { describe: true };
  const allowed = new Set(['--fixture-lease', '--fixture', '--raised-stage']);
  const seen = new Set<string>();
  let lease: string | undefined;
  let fixture: OrdinaryOptions['fixture'] = '26.1.2';
  let raised = false;
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (!allowed.has(key) || seen.has(key)) throw new Error(`unsupported/duplicate argument ${key}`);
    seen.add(key);
    if (key === '--raised-stage') { raised = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing ${key} value`);
    if (key === '--fixture-lease') lease = value;
    else {
      if (value !== '26.1.2' && value !== '26.2') throw new Error('only exact 26.1.2 / 26.2 fixtures are supported');
      fixture = value;
    }
  }
  if (!lease || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(lease)) throw new Error('a NEW coordinator-granted --fixture-lease is required');
  if (!raised) throw new Error('explicit --raised-stage is required for the proposed geometry');
  return { fixture, lease, raised: true };
}

/** FULL original scene, including colliding bodies at every +1 end extent.
 * Players are exempt only by the unique run tag, assigned by the harness to
 * its two proven current fixture clients after an initially empty server.
 * Natural item/xp is not exempt from this initial preflight. */
export async function guardOrdinaryScene(read: (command: string) => Promise<string>, tag: string, initial: boolean): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(tag)) throw new Error('invalid run tag');
  const area = trialEntitySelector(SAFETY_TRIAL_BOX);
  const filters = initial ? '' : ',type=!item,type=!experience_orb';
  const reply = await read(`execute if entity @e[tag=!${tag}${filters},${area}]`);
  if (parseEntityTest(reply) !== false) throw new Error('full original scene contains an unowned/unknown body; refusing mutation');
}

export function trialPointInside(p: TrialPosition): boolean {
  return [p.x, p.y, p.z].every(Number.isFinite) && p.x >= 240.3 && p.x <= 270.7 && p.y >= -61 && p.y + 1.8 <= -47 && p.z >= 190.3 && p.z <= 220.7;
}
export function strictPosition(reply: string): TrialPosition | undefined {
  const m = /^[^\n]+ has the following entity data: \[(-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)d,\s*(-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)d,\s*(-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)d\]$/.exec(reply.trim());
  if (!m) return undefined;
  const p = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  return [p.x, p.y, p.z].every(Number.isFinite) ? p : undefined;
}
export function horizontal(a: TrialPosition, b: TrialPosition): number { return Math.hypot(a.x - b.x, a.z - b.z); }

export interface WaterSample {
  atMs: number; position: TrialPosition; air: number; health: number;
  support: TrialWaterSupport; episodeCount: number; responding: boolean;
}
/** Same strict mechanics support proof, sampled AFTER the actual safety
 * action ended; follow may resume safely, but cannot resubmerge/churn. */
export function settledWaterProblems(samples: readonly WaterSample[]): string[] {
  const first = samples[0], last = samples.at(-1);
  if (!first || !last || samples.length < 4 || last.atMs - first.atMs < 3000) return ['insufficient_settlement'];
  const why: string[] = [];
  if (samples.some((s, i) => !Number.isFinite(s.atMs) || (i > 0 && s.atMs <= samples[i - 1]!.atMs) || (i > 0 && s.atMs - samples[i - 1]!.atMs > 1000))) why.push('settlement_gaps_or_clock');
  if (samples.some((s) => !trialPointInside(s.position) || serverWaterSupport(s.support) === undefined || s.air !== 300 || !Number.isFinite(s.health) || s.health <= 0)) why.push('unsafe_or_unknown_server_support');
  if (samples.some((s) => s.responding || s.episodeCount !== first.episodeCount)) why.push('episode_churn');
  if (samples.some((s) => s.health < first.health)) why.push('health_loss_after_escape');
  return why;
}

/** A request is really outstanding at the response, never merely present
 * somewhere earlier in the run. No provider timeout is credited as a reply. */
export function duringPlannerWait(events: readonly OrdinaryEvidence[], planner: readonly OrdinaryEvidence[], goalId: string, start: OrdinaryEvidence): boolean {
  const at = Date.parse(String(start.t));
  return events.some((e) => e.type === 'planner_request' && e.goalId === goalId && Date.parse(String(e.t)) <= at &&
    !planner.some((p) => p.requestId === e.requestId && ['planner_response', 'planner_error', 'goal_proposal_accepted', 'goal_proposal_rejected'].includes(p.type) && Date.parse(String(p.t)) <= at));
}

/** Each safety grant belongs to the SAME original job; a new admission,
 * baseline/outcome binding or anchor reset cannot masquerade as continuation. */
export function preservationProblems(events: readonly OrdinaryEvidence[], planner: readonly OrdinaryEvidence[], goalId: string, episodes: readonly OrdinaryEvidence[]): string[] {
  const why: string[] = [];
  const admission = events.filter((e) => e.type === 'goal_admitted' && e.goalId === goalId);
  if (admission.length !== 1) why.push('admission_reset_or_missing');
  for (const type of ['goal_admission_baseline', 'goal_outcome_bound', 'goal_travel_anchor']) if (events.filter((e) => e.type === type && e.goalId === goalId).length !== 1) why.push(`${type}_reset_or_missing`);
  const interpretations = planner.filter((e) => e.type === 'goal_interpretation' && e.goalId === goalId);
  if (interpretations.length !== 1 || !interpretations[0]?.outcome) why.push('outcome_reset_or_missing');
  if (episodes.some((e) => e.suspended?.goalId !== goalId || e.suspended?.goalEpoch !== admission[0]?.epoch || e.basis !== 'owner_goal')) why.push('wrong_suspended_ownership');
  const counters: Record<string, number> = {};
  for (const e of events.filter((x) => x.goalId === goalId && x.counters)) for (const [k, v] of Object.entries(e.counters)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < (counters[k] ?? 0)) why.push(`counter_refill_${k}`);
    else counters[k] = v;
  }
  if (events.some((e) => e.type === 'goal_terminal' && e.goalId === goalId && e.state === 'completed' && e.reason !== 'outcome_verified')) why.push('unverified_completion');
  return [...new Set(why)];
}

export function noQuestionProblems(events: readonly OrdinaryEvidence[], lines: readonly string[]): string[] {
  const why: string[] = [];
  if (events.some((e) => e.state === 'awaiting_owner' || e.type === 'goal_question' || e.type === 'clarification_requested')) why.push('owner_question_event');
  if (lines.some((l) => /Question q\d+|answer q\d+|reply: answer/i.test(l))) why.push('owner_question_output');
  return why;
}

/** Server defeat is independently required; leaving view/unknown is no kill. */
export function defenseProblems(start: OrdinaryEvidence, ended: OrdinaryEvidence, outcomes: readonly OrdinaryEvidence[], serverPresent: boolean | undefined): string[] {
  const why: string[] = [];
  if (start.response !== 'defend' || !start.defense?.target) why.push('no_supported_defense');
  if (ended.episodeId !== start.episodeId || ended.outcome !== 'resolved') why.push('wrong_or_unresolved_episode');
  const evs = outcomes.filter((o) => o.owner === 'safety' && o.evidence?.defeatedByServerStatus === true && o.evidence?.hitsConfirmed > 0);
  if (!evs.length) why.push('no_server_hits_and_death_status');
  if (serverPresent !== false) why.push('server_absence_unverified');
  return why;
}
