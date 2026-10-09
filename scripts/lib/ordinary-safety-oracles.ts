// Read-only oracles for the existing ordinary CLI harness. These never grant
// gameplay authority and treat missing/unknown staging evidence as failure.
import { SAFETY_CAPABILITIES } from '../../src/contracts/safety.ts';
type Row = Record<string, any>;
export type Point = { x: number; y: number; z: number };
const need = (v: unknown, why: string): void => { if (!v) throw new Error(why); };
const canonicalJson = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonicalJson).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Row)[k])}`).join(',')}}`;
export const timeOf = (e: Row): number => Date.parse(String(e.t));
export const distance = (a: Point, b: Point): number => Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z);

export function pendingRealTurn(events: Row[], journal: Row[], goalId: string): Row | undefined {
  return events.findLast((e) => e.type === 'planner_turn_started' && e.goalId === goalId &&
    e.subject === goalId && e.selectedModel === 'gpt-6.1-sol' &&
    events.some((s) => s.requestId === e.requestId && s.goalId === goalId && s.type === 'planner_stream_started') &&
    !events.some((s) => s.requestId === e.requestId && ['planner_response_started', 'planner_stream_completed', 'planner_turn_completed', 'planner_turn_failed', 'planner_output_rejected'].includes(s.type)) &&
    !journal.some((s) => s.requestId === e.requestId && s.type === 'planner_proposal_raw'));
}

export function verifyPlannerWaterRace(events: Row[], journal: Row[], goalId: string, requestId: string, episode: Row, triggerAtMs: number): void {
  const start = events.find((e) => e.type === 'planner_turn_started' && e.requestId === requestId && e.goalId === goalId);
  const completed = events.find((e) => e.type === 'planner_turn_completed' && e.requestId === requestId && e.goalId === goalId);
  const stream = events.find((e) => e.type === 'planner_stream_started' && e.requestId === requestId && e.goalId === goalId);
  const response = events.find((e) => e.type === 'planner_response_started' && e.requestId === requestId && e.goalId === goalId);
  const streamEnd = events.find((e) => e.type === 'planner_stream_completed' && e.requestId === requestId && e.goalId === goalId);
  const raw = journal.find((e) => e.type === 'planner_proposal_raw' && e.requestId === requestId && e.goalId === goalId);
  need(start?.subject === goalId && start.selectedModel === 'gpt-6.1-sol', 'staging_unready: an actual owned subscription turn must have started');
  need(stream && response && streamEnd && completed && raw && !events.some((e) => e.requestId === requestId && e.type === 'planner_turn_failed'), 'actual correlated planner stream/response/completion required; no provider pass from cancellation');
  need(episode.suspended?.goalId === goalId && episode.response === 'escape_water', 'water intervention belongs to this owner goal');
  need(timeOf(start!) <= timeOf(stream!) && timeOf(stream!) <= triggerAtMs && triggerAtMs <= timeOf(episode) && timeOf(episode) < timeOf(response!) && timeOf(response!) <= timeOf(streamEnd!) && timeOf(streamEnd!) <= timeOf(completed!) && timeOf(completed!) <= timeOf(raw!), 'staging_unready: water intervention must precede the FIRST actual response stream item, real stream completion AND raw journal response');
}

export function verifySafetyOwnership(events: Row[], journal: Row[], goalId: string, before: Row, after: Row): void {
  const admitted = events.filter((e) => e.type === 'goal_admitted' && e.goalId === goalId);
  need(admitted.length === 1 && !admitted[0]!.continuation, 'safety cannot readmit the owner goal');
  const epoch = admitted[0]!.epoch;
  for (const phase of [before, after]) {
    const goal = phase.directive?.goal;
    need(goal?.id === goalId && goal.epoch === epoch && !goal.terminal, 'same live goal and epoch required through safety');
    need(phase.directive.pause?.paused === true && phase.directive.pause.manualGoalsAllowed === true, 'manual safety/work remains available with automatic pause retained');
  }
  need(!events.some((e) => e.type === 'goal_terminal' && e.goalId === goalId), 'safety cannot complete or end the job');
  for (const type of ['goal_travel_anchor', 'goal_admission_baseline', 'goal_outcome_bound']) need(events.filter((e) => e.type === type && e.goalId === goalId).length === 1, `single original ${type} required`);
  const plans = journal.filter((e) => e.type === 'goal_proposal_accepted' && e.goalId === goalId && e.proposal?.disposition === 'plan');
  need(plans.length > 0 && plans[0]!.proposal.outcome, 'code-accepted original outcome required');
  need(plans.every((e) => canonicalJson(e.proposal.outcome) === canonicalJson(plans[0]!.proposal.outcome)), 'accepted owner outcome remains exactly immutable');
  const counters: Row[] = events.filter((e) => e.goalId === goalId && e.counters).map((e) => e.counters);
  counters.push(after.directive.goal.counters);
  const last: Row = before.directive.goal.counters;
  need(last && counters.at(-1), 'current original cumulative counters must be published');
  // Historical events preceding the before sample are checked separately;
  // do not mistake their smaller counters for a later refill.
  for (const sequence of [events.filter((e) => e.goalId === goalId && e.counters).map((e) => e.counters), [last, counters.at(-1)!]]) {
    for (let i=1; i<sequence.length; i++) for (const key of Object.keys(sequence[i-1]!)) {
      if (sequence[i]![key] !== undefined) need(Number(sequence[i]![key]) >= Number(sequence[i-1]![key]), `cumulative ${key} cannot reset`);
    }
  }
  need(before.directive.goal.admittedAtMs === after.directive.goal.admittedAtMs && before.directive.goal.outcome === after.directive.goal.outcome, 'original admission time and displayed outcome unchanged');
  const anchor = events.find((e) => e.type === 'goal_travel_anchor' && e.goalId === goalId)!;
  need(anchor.admitted === true && anchor.epoch === epoch && anchor.radius === 128, 'original admitted default-radius anchor required');
  for (const phase of [before, after]) {
    const at = phase.directive.autonomy?.route?.admissionAnchor;
    if (at) need(canonicalJson(at) === canonicalJson(anchor.anchor), 'current route cannot reanchor the owner job');
  }
  const b = before.usage?.jev?.value, a = after.usage?.jev?.value;
  need(b && a && a.capNanoUsd === b.capNanoUsd && a.confirmedNanoUsd >= b.confirmedNanoUsd && a.retainedNanoUsd >= b.retainedNanoUsd, 'per-run spend authority cannot refill');
}

export function verifyFiniteEpisode(start: Row, end: Row): void {
  need(start.episodeId === end.episodeId && start.grantId === end.grantId, 'same finite grant must settle');
  need(Number.isFinite(start.expiresInMs) && start.expiresInMs > 0 && start.expiresInMs <= 60_000, 'finite episode deadline required');
  need(Number.isFinite(end.elapsedMs) && end.elapsedMs >= 0 && end.elapsedMs <= start.expiresInMs, 'episode never extends its deadline');
  need(Number.isFinite(end.actions) && end.actions <= start.maxActions && Number.isFinite(end.displacement) && end.displacement <= start.maxDisplacement, 'episode action/displacement allowance cannot expand');
}

export function verifyNoAttacks(events: Row[], sinceMs: number): void {
  const recent = events.filter((e) => timeOf(e) >= sinceMs);
  need(!recent.some((e) => e.type === 'skill_started' && ['attack_entity', SAFETY_CAPABILITIES.defendAgainstThreat].includes(e.capability)), 'no offensive skill dispatch');
  need(!recent.some((e) => e.type === 'safety_episode_started' && e.response === 'defend'), 'no defensive intervention for this control');
  need(!recent.some((e) => ['task_action', 'skill_outcome'].includes(e.type) && (e.evidence?.attacksSent > 0 || e.capability === 'attack_entity')), 'no attack effects');
}

export function verifyPreemption(events: Row[], episode: Row, action: Row, epoch: number): void {
  need(action.owner === 'goal' && episode.preempted?.revoked === true && episode.preempted.holder === `goal epoch ${epoch}`, 'an active goal lease must actually be revoked');
  const revoked = events.find((e) => e.type === 'lease_revoked' && e.leaseId === action.leaseId && e.reason === 'safety_preempt');
  need(revoked?.clearedShared === true && revoked.clearMs <= 250 && timeOf(revoked) <= timeOf(episode), 'original active lease cleared before safety dispatch');
  let current: number | undefined;
  for (const e of events) {
    if (e.type === 'lease_acquired') {
      need(current === undefined, 'single actuator cannot acquire overlapping leases');
      current = e.leaseId;
    } else if (e.type === 'lease_revoked' && e.clearedShared && e.leaseId === current) current = undefined;
  }
}

/** Exact own player standing point; every server reply must positively prove it. */
export function ownerStandingCommands(p: Point, name: string): { support: string; feet: string; head: string; occupants: string } {
  need(name === 'FixtureOwner' && p.x === 350.5 && p.y === -60 && p.z === 198.5, 'only the declared owned player at the approved additional point');
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
  return {
    support: `execute if loaded ${x} ${y-1} ${z} if block ${x} ${y-1} ${z} minecraft:grass_block`,
    feet: `execute if loaded ${x} ${y} ${z} if block ${x} ${y} ${z} minecraft:air`,
    head: `execute if loaded ${x} ${y+1} ${z} if block ${x} ${y+1} ${z} minecraft:air`,
    occupants: `execute if entity @e[x=${x},y=${y},z=${z},dx=0,dy=1,dz=0]`,
  };
}

export function verifyHiddenOwner(snapshot: Row, far: Point): void {
  need(snapshot.owner?.visible === false && snapshot.owner.at === undefined && snapshot.owner.distance === undefined, 'hidden current owner coordinates/distance must be absent');
  verifyNoFarPoint(snapshot, far);
}

/**
 * O7F staging (P-SAFETY-R16): the far cue and hidden-owner observation must be
 * FRESH relative to the owned teleport. Requires an actual locator owner
 * statement change at/after `sinceMs`, a dashboard published after it with an
 * actionable east cue, and an observation taken after it. A stale pre-teleport
 * view (owner still visible at its old, non-far position) is "not yet"; the far
 * point anywhere in ANY observation is an immediate privacy failure.
 */
export function freshFarCue(events: readonly Row[], dashboard: Row, snapshot: Row | undefined, sinceMs: number, far: Point): 'ready' | 'waiting' {
  if (snapshot) verifyNoFarPoint(snapshot, far);
  const change = events.find((e) => e.type === 'locator_owner_state' && timeOf(e) >= sinceMs && /^tracked:/.test(String(e.state)));
  if (!change) return 'waiting';
  const l = dashboard.directive?.autonomy?.locator;
  if (!(dashboard.publisher?.publishedAtMs >= timeOf(change)) || l?.actionable !== true || !String(l.direction ?? '').includes('east')) return 'waiting';
  if (!snapshot || !(snapshot.takenAtMs >= timeOf(change)) || snapshot.owner?.visible !== false) return 'waiting';
  verifyHiddenOwner(snapshot, far);
  return 'ready';
}

export function verifySharedSafetyHistory(samples: Row[], cases: string[]): void {
  const rows = samples.filter((e) => cases.includes(e.scenario) && e.dashboard).map((e) => e.dashboard);
  need(rows.length > 0 && cases.every((id) => samples.some((e) => e.scenario === id && e.dashboard)), 'actual dashboard history for each executed safety case required');
  const first = rows[0]!;
  for (let i=0; i<rows.length; i++) {
    const r = rows[i]!, previous = rows[Math.max(0, i-1)]!;
    need(r.publisher.runId === first.publisher.runId && r.publisher.pid === first.publisher.pid && r.connection.epoch === first.connection.epoch && r.publisher.seq >= previous.publisher.seq, 'one actual CLI/service/connection history; no reset to erase an episode');
    need(r.directive.safety && previous.directive.safety, 'actual safety counters required throughout');
    for (const [key, value] of Object.entries(previous.directive.safety.counters)) need(Number(r.directive.safety.counters[key]) >= Number(value), `same-service safety ${key} never resets`);
    const a = r.usage?.jev?.value, b = previous.usage?.jev?.value;
    need(a && b && a.capNanoUsd === b.capNanoUsd && a.confirmedNanoUsd >= b.confirmedNanoUsd && a.retainedNanoUsd >= b.retainedNanoUsd, 'single per-run spend authority retained across safety cases');
  }
}

// ---------------------------------------------------------------- R16 corrections (P-SAFETY-R16)

/**
 * Current server-held melee gear from the INSTALLED 26.1.x/26.2 player NBT
 * (verified in both server jars and the R16 replies): `Inventory` holds only
 * main/hotbar slots; worn armour/off hand live in the `equipment` compound
 * (EquipmentSlot names head/chest/legs/feet/offhand); the held item is the
 * Inventory entry at `SelectedItemSlot`. Any unreadable or ambiguous reply is
 * null (never readiness). A pre-1.21.5 `Slot: 103b` armour entry is NOT worn gear.
 */
export function serverHeldGear(inventory: string, equipment: string, selected: string): { mainHand: string | null; head: string | null; chest: string | null; selectedSlot: number } | null {
  const inv = /has the following entity data: (\[.*\])$/.exec(inventory.trim())?.[1];
  const eq = /has the following entity data: (\{.*\})$/.exec(equipment.trim())?.[1];
  const sel = /has the following entity data: (\d+)$/.exec(selected.trim())?.[1];
  if (inv === undefined || eq === undefined || sel === undefined) return null;
  const selectedSlot = Number(sel);
  if (!Number.isInteger(selectedSlot) || selectedSlot < 0 || selectedSlot > 8) return null;
  let mainHand: string | null = null;
  for (const entry of inv.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) ?? []) {
    const slot = /(?:^\{|, )Slot: (-?\d+)b(?:,|\})/.exec(entry)?.[1];
    const id = /(?:^\{|, )id: "([^"]+)"/.exec(entry)?.[1];
    if (slot === undefined || !id) return null;
    if (Number(slot) === selectedSlot) { if (mainHand !== null) return null; mainHand = id; }
  }
  const worn = (slot: string): string | null | undefined => {
    const all = [...eq.matchAll(new RegExp(`(?:^\\{|, )${slot}: \\{([^{}]*)\\}`, 'g'))];
    if (all.length > 1) return undefined;
    if (all.length === 0) return null;
    return /(?:^|, )id: "([^"]+)"/.exec(all[0]![1]!)?.[1] ?? undefined;
  };
  const head = worn('head'), chest = worn('chest');
  if (head === undefined || chest === undefined) return null;
  return { mainHand, head, chest, selectedSlot };
}

/** One post-release server sample (RCON position read bracket). */
export interface SettleSample { startedAtMs: number; atMs: number; p: Point }

/** Vanilla sprint-jump peaks near 7.1 blocks/s; anything faster is not ordinary grounded walking. */
export const ORDINARY_GROUND_SPEED_BPS = 7.2;
export const SETTLED_STEP = 0.8;

/**
 * Post-release motion attribution (P-SAFETY-R16, O7P/O7R). After a water grant
 * releases the actuator, an ordinary owner job may legitimately resume through
 * a FRESH goal lease. Motion between two server samples is accepted only while
 * such an action of the SAME goal and epoch was actually active: a goal-owned
 * movement capability dispatched through the ordinary task pipeline
 * (task_choice/local continuation), started at or after the episode ended, on a
 * lease acquired for `goal:<epoch>` that is neither a safety lease nor the
 * preempted lease, and no faster than ordinary grounded movement. Every other
 * step must stay below the original settled threshold (physics drift).
 * Dry support / air for EVERY sample is checked separately and stays binding.
 */
export function postReleaseMotion(samples: readonly SettleSample[], events: readonly Row[], ctx: { goalId: string; goalEpoch: number; episodeEnd: Row; excludedLeaseIds: readonly number[]; capabilities: readonly string[] }): Array<{ fromMs: number; toMs: number; displacement: number; actionId: string | null }> {
  need(samples.length >= 2, 'post-release motion needs server samples');
  const releasedAt = timeOf(ctx.episodeEnd);
  need(ctx.episodeEnd.type === 'safety_episode_ended' && Number.isFinite(releasedAt), 'actual episode release required');
  const safetyLeases = new Set(events.filter((e) => e.type === 'lease_acquired' && String(e.owner).startsWith('safety:')).map((e) => e.leaseId));
  const owned = events.filter((e) => e.type === 'skill_started' && e.owner === 'goal' && ctx.capabilities.includes(e.capability) && timeOf(e) >= releasedAt && !safetyLeases.has(e.leaseId) && !ctx.excludedLeaseIds.includes(e.leaseId) &&
    events.some((l) => l.type === 'lease_acquired' && l.leaseId === e.leaseId && l.owner === `goal:${ctx.goalEpoch}` && timeOf(l) >= releasedAt && timeOf(l) <= timeOf(e)) &&
    events.some((c) => ['task_choice', 'task_local_continuation'].includes(c.type) && c.goalId === ctx.goalId && c.goalEpoch === ctx.goalEpoch && (c.candidateId ?? c.actionId) === e.actionId))
    .map((e) => {
      const end = events.find((o) => o.type === 'skill_outcome' && o.actionId === e.actionId);
      return { actionId: String(e.actionId), from: timeOf(e), to: end ? timeOf(end) : Number.POSITIVE_INFINITY };
    });
  const out: Array<{ fromMs: number; toMs: number; displacement: number; actionId: string | null }> = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!, b = samples[i]!;
    const d = Math.hypot(b.p.x - a.p.x, b.p.z - a.p.z);
    if (d < SETTLED_STEP) { out.push({ fromMs: a.startedAtMs, toMs: b.atMs, displacement: d, actionId: null }); continue; }
    const by = owned.find((o) => o.from <= b.atMs && o.to >= a.startedAtMs);
    need(by, `dry supported position stays settled after controls release (step ${d.toFixed(2)} with no current goal-owned movement action of the same goal/epoch)`);
    need(d <= ORDINARY_GROUND_SPEED_BPS * Math.max(0, b.atMs - a.startedAtMs) / 1000 + 0.25, `post-release step ${d.toFixed(2)} exceeds ordinary grounded movement`);
    out.push({ fromMs: a.startedAtMs, toMs: b.atMs, displacement: d, actionId: by!.actionId });
  }
  return out;
}

/** Inside the harness entity/scene footprint (x 196..224, z 190..224 inclusive block columns). */
export function insideSceneColumns(p: Point): boolean {
  return p.x >= 196 && p.x < 225 && p.z >= 190 && p.z < 225;
}

/**
 * Post-response visibility (P-SAFETY-R16, O8C/O8N verification only). Staging
 * keeps the strict "no unexpected visible nonplayer" readiness guard. After an
 * executed response, an unexpected visible nonplayer is tolerated ONLY as a
 * recorded foreign occupant that is outside the declared scene columns and was
 * never a hazard or target of any safety episode since admission; anything
 * inside the scene, involved in a response, or unpositioned fails.
 */
export function foreignVisibleAfterResponse(unexpected: readonly Row[], events: readonly Row[], ctx: { sinceMs: number; allowedHazards: readonly string[]; allowedTargetIds: readonly number[] }): Row[] {
  const episodes = events.filter((e) => ['safety_episode_started', 'safety_episode_ended'].includes(e.type) && timeOf(e) >= ctx.sinceMs);
  for (const e of episodes) {
    for (const h of [...(e.hazards ?? []), ...(e.hazardsBefore ?? []), ...(e.hazardsAfter ?? [])]) need(ctx.allowedHazards.includes(h), `unexpected safety hazard ${String(h)} during the control`);
    const target = e.defense?.target?.entityId;
    if (target !== undefined && target !== null) need(ctx.allowedTargetIds.includes(target), 'a safety response targeted an unrecorded entity');
  }
  for (const u of unexpected) {
    need(u.at && Number.isFinite(u.at.x) && Number.isFinite(u.at.z), 'unexpected visible nonplayer without a position');
    need(!insideSceneColumns(u.at), `unexpected visible nonplayer ${String(u.key)} inside the declared scene`);
  }
  return unexpected.map((u) => ({ key: u.key, at: u.at, distance: u.distance ?? null }));
}

/** The hidden far point never appears in an observation, including rounded/nested coordinates. */
export function verifyNoFarPoint(snapshot: Row, far: Point): void {
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    const r = v as Row;
    need(!(typeof r.x === 'number' && typeof r.y === 'number' && typeof r.z === 'number' && distance(r as Point, far) <= 0.75), 'hidden far-owner point cannot enter current observation, including rounded/nested coordinates');
    for (const child of Object.values(r)) visit(child);
  };
  visit(snapshot);
}
