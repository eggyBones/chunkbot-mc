// Dedicated ordinary locator harness evidence oracles. No I/O or gameplay.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Point = { x: number; y: number; z: number };
export const eventMs = (e: Row): number => Date.parse(String(e.t));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const point = (p: unknown): p is Point => !!p && typeof p === 'object' && ['x', 'y', 'z'].every((k) => Number.isFinite((p as Row)[k]));
const same = (a: Point, b: Point) => distance(a, b) <= 0.18; // rendered positions round each axis to 0.1
const dim = (s: string) => s.replace(/^minecraft:/, '');

export interface ActionInterval {
  actionId: string; capability: string; goalId: string; goalEpoch: number; connectionEpoch: number;
  taskId: string; leaseId: number; startMs: number; endMs: number | null; binding: Row; outcome: Row | null;
}

/** Starts lack goal IDs: prove the binding through the lease AND admitted task choice/continuation. */
export function actionIntervals(events: readonly Row[]): ActionInterval[] {
  return events.filter((s) => s.type === 'skill_started' && s.owner === 'goal').flatMap((s) => {
    const startMs = eventMs(s);
    const lease = events.find((e) => e.type === 'lease_acquired' && e.leaseId === s.leaseId && eventMs(e) <= startMs);
    const binding = events.find((e) => ['task_choice', 'task_local_continuation'].includes(e.type) && (e.candidateId ?? e.actionId) === s.actionId && e.capability === s.capability && eventMs(e) <= startMs);
    if (!binding || lease?.owner !== `goal:${binding.goalEpoch}`) return [];
    const task = events.find((e) => e.type === 'task_admitted' && e.taskId === binding.taskId && e.goalId === binding.goalId && e.epoch === binding.goalEpoch);
    const ready = events.filter((e) => e.type === 'connection_ready' && eventMs(e) <= startMs).at(-1);
    if (!task || !ready) return [];
    const outcome = events.find((e) => e.type === 'skill_outcome' && e.actionId === s.actionId && e.owner === 'goal' && e.goalId === binding.goalId && e.goalEpoch === binding.goalEpoch && e.taskId === binding.taskId && e.connectionEpoch === ready.connectionEpoch && e.capability === s.capability && eventMs(e) >= startMs);
    const revoked = events.find((e) => e.type === 'lease_revoked' && e.leaseId === s.leaseId && eventMs(e) >= startMs);
    const ends = [outcome, revoked].filter(Boolean).map((e) => eventMs(e!));
    return [{ actionId: s.actionId, capability: s.capability, goalId: binding.goalId, goalEpoch: binding.goalEpoch, connectionEpoch: ready.connectionEpoch, taskId: binding.taskId, leaseId: s.leaseId, startMs, endMs: ends.length ? Math.min(...ends) : null, binding, outcome: outcome ?? null }];
  });
}

export interface ObserverSample {
  runId: string;
  atMs: number; serverAtMs: number; bot: Point; owner: Point | null;
  snapshot: Row; dashboard: Row; scenario: string;
}
export interface Trip { fromMs: number; toMs: number; goalId: string; goalEpoch: number; connectionEpoch: number }

/** A successful server reunion alone cannot prove who/what drove the movement. */
export function reacquisitionProof(events: readonly Row[], observations: readonly ObserverSample[], trip: Trip): { pass: boolean; errors: string[]; actionIds: string[]; hiddenSamples: number; visibleSamples: number } {
  const errors: string[] = [];
  const local = observations.filter((o) => o.atMs >= trip.fromMs && o.atMs <= trip.toMs && o.snapshot.goalEpoch === trip.goalEpoch && o.snapshot.connectionEpoch === trip.connectionEpoch);
  const hidden = local.filter((o) => o.snapshot.owner?.visible === false && o.owner && distance(o.bot, o.owner) > 40);
  const visible = local.filter((o) => o.snapshot.owner?.visible === true && point(o.snapshot.owner.at) && o.owner && same(o.snapshot.owner.at, o.owner) && distance(o.bot, o.owner) <= 4.5);
  if (!hidden.length) errors.push('no actual filtered visibility loss with far server owner');
  if (!visible.length) errors.push('no filtered owner reacquisition with server reunion <=4.5');
  const seeks = actionIntervals(events).filter((a) => a.capability === 'seek_owner' && a.goalId === trip.goalId && a.goalEpoch === trip.goalEpoch && a.connectionEpoch === trip.connectionEpoch && a.startMs <= trip.toMs && (a.endMs ?? Infinity) > trip.fromMs);
  const authorized = seeks.filter((a) => {
    const during = hidden.filter((o) => o.atMs >= a.startMs && o.atMs < (a.endMs ?? Infinity));
    const cue = during.filter((o) => {
      const l = o.dashboard.directive?.autonomy?.locator;
      const r = o.dashboard.directive?.autonomy?.route;
      return o.dashboard.connection?.epoch === trip.connectionEpoch && o.dashboard.directive?.goal?.id === trip.goalId && o.dashboard.directive?.goal?.epoch === trip.goalEpoch && l?.actionable === true && l.reason === 'tracking' && typeof l.direction === 'string' && Number.isFinite(l.ageMs) && l.ageMs >= 0 && Math.abs(o.dashboard.publisher?.publishedAtMs - o.atMs) <= 2_000 && ['authorized', 'leg_active'].includes(r?.state);
    });
    const route = events.find((e) => e.type === 'route_authorized' && e.goalId === trip.goalId && e.goalEpoch === trip.goalEpoch && e.destinations?.includes('owner') && eventMs(e) <= a.startMs);
    const revoked = events.some((e) => e.type === 'route_revoked' && e.routeId === route?.routeId && eventMs(e) <= trip.toMs && eventMs(e) >= a.startMs);
    return cue.length > 0 && !!route && !revoked;
  });
  if (!authorized.length) errors.push('no owned seek interval during hidden travel with current owner cue and route');
  if (events.some((e) => e.type === 'planner_turn_started' && eventMs(e) >= trip.fromMs && eventMs(e) <= trip.toMs)) errors.push('extra planner turn during reacquisition');
  if (events.some((e) => e.type === 'goal_admitted' && eventMs(e) > trip.fromMs && eventMs(e) <= trip.toMs)) errors.push('new goal admitted during reacquisition');
  if (events.some((e) => e.type === 'goal_terminal' && e.goalId === trip.goalId && eventMs(e) <= trip.toMs)) errors.push('goal ended before reunion');
  return { pass: errors.length === 0, errors, actionIds: authorized.map((a) => a.actionId), hiddenSamples: hidden.length, visibleSamples: visible.length };
}

export interface HistoryProof { runId: string; anchorId: string; at: Point; dimension: string; connectionEpoch: number; observedAtMs: number; snapshotId: string; serverAtMs: number }

/** Only history co-stated with an actual visible owner AND independently sampled server position is trusted. */
export function verifiedHistory(observations: readonly ObserverSample[]): HistoryProof[] {
  return observations.flatMap((o) => {
    const s = o.snapshot;
    if (s.owner?.visible !== true || !point(s.owner.at) || !o.owner || !same(s.owner.at, o.owner) || Math.abs(s.takenAtMs - o.serverAtMs) > 1_500 || distance(o.bot, o.owner) > 32.2) return [];
    return (s.remembered ?? []).filter((r: Row) => r.label === 'owner last seen' && r.source === 'observed' && point(r.at) && same(r.at, s.owner.at) && dim(r.dimension) === dim(s.dimension) && r.observedAtMs <= s.takenAtMs && s.takenAtMs - r.observedAtMs <= 1_500).map((r: Row) => ({ runId: o.runId, anchorId: r.anchorId, at: r.at, dimension: dim(r.dimension), connectionEpoch: s.connectionEpoch, observedAtMs: r.observedAtMs, snapshotId: s.id, serverAtMs: o.serverAtMs }));
  });
}

export interface PrivacyMatch { path: string; value: string; reason: string; evidence?: HistoryProof }
export function parsePlannerInput(text: string): Row {
  const line = text.split('\n').find((l) => l.startsWith('{'));
  if (!line) throw new Error('planner input JSON is missing');
  return JSON.parse(line) as Row;
}

/** Keep the old numeric match strength, but authorize each occurrence with its exact field/point provenance. */
export function privacyOracle(input: Row, context: { runId: string; atMs: number; owner: Point; bot: Point; connectionEpoch: number; dimension: string; history: readonly HistoryProof[] }): { findings: PrivacyMatch[]; allowed: PrivacyMatch[] } {
  const findings: PrivacyMatch[] = [], allowed: PrivacyMatch[] = [];
  const values = new Set<number>();
  for (const v of [context.owner.x, context.owner.z]) for (const b of [Math.floor(v), Math.round(v)]) for (const d of [-1, 0, 1]) values.add(b + d);
  const matches = (v: number) => Number.isFinite(v) && values.has(Math.trunc(v));
  const visit = (v: unknown, path: string, parent: Row | null, key: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${path}[${i}]`, null, String(i))); return; }
    if (v && typeof v === 'object') {
      const row = v as Row;
      const historical = /^(?:state\.)?observation\.remembered\[\d+\]$/.test(path) && row.label === 'owner last seen';
      let proof: HistoryProof | undefined;
      if (historical && point(row.at) && row.source === 'observed' && Number.isFinite(row.ageSeconds) && row.ageSeconds > 0) {
        const observed = context.atMs - row.ageSeconds * 1_000;
        proof = context.history.find((h) => h.runId === context.runId && h.anchorId === row.anchorId && h.connectionEpoch === context.connectionEpoch && dim(row.dimension) === h.dimension && h.dimension === dim(context.dimension) && same(h.at, row.at) && h.observedAtMs < context.atMs && h.serverAtMs < context.atMs && Math.abs(h.observedAtMs - observed) <= 1_500);
      }
      if (historical && !proof) findings.push({ path, value: JSON.stringify(row.at), reason: 'owner history lacks earlier visible observation/server proof' });
      for (const [k, x] of Object.entries(row)) {
        if (k === 'at' && point(x) && historical && proof) {
          for (const axis of ['x', 'y', 'z'] as const) if (matches(x[axis])) allowed.push({ path: `${path}.at.${axis}`, value: String(x[axis]), reason: 'verified earlier visible owner', evidence: proof });
          for (const [extra, value] of Object.entries(x)) if (!['x', 'y', 'z'].includes(extra)) visit(value, `${path}.at.${extra}`, x, extra);
        } else visit(x, path ? `${path}.${k}` : k, row, k);
      }
      return;
    }
    if (typeof v === 'number' && matches(v)) {
      // Local self/terrain positions can share one coordinate with a far owner.
      // Only complete, current, spatially bounded points at declared observation paths qualify.
      const localPath = /^(?:state\.)?observation\.(?:self\.at|(?:blocks|entities|drops|frontiers)\[\d+\]\.at)\.[xyz]$/.test(path);
      if (localPath && parent && point(parent) && distance(parent, context.bot) <= 32.2 && distance(parent, context.owner) > 4.5 && (path.includes('.self.at.') ? same(parent, context.bot) : true)) allowed.push({ path, value: String(v), reason: 'current local point bounded by independently sampled bot position' });
      else findings.push({ path, value: String(v), reason: 'hidden current owner coordinate without field provenance' });
    } else if (typeof v === 'string') {
      if (v.startsWith('{') || v.startsWith('[')) { try { visit(JSON.parse(v), `${path}.$json`, parent, key); return; } catch { /* scan text below */ } }
      for (const m of v.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)) if (matches(Number(m[0]))) findings.push({ path, value: m[0], reason: 'hidden current coordinate in model-visible text' });
    }
  };
  visit(input, '', null, '');
  return { findings, allowed };
}

export function shutdownProblems(exit: { code: number | null; signal: string | null } | undefined, lines: readonly string[], events: readonly Row[], summary: Row | undefined): string[] {
  const errors: string[] = [];
  if (!exit || exit.code !== 0 || exit.signal !== null) errors.push(`CLI did not exit gracefully with code 0: ${JSON.stringify(exit)}`);
  if (!lines.includes('[chunkbot] shutdown complete')) errors.push('complete terminal shutdown missing');
  if (lines.some((l) => /exit watchdog:|SIGKILL/.test(l))) errors.push('forced exit/watchdog used');
  if (summary?.controlCleanupSettled !== true || !['ended', 'disconnected'].includes(summary?.connectionState)) errors.push('summary does not prove settled control cleanup/ended connection');
  for (const a of actionIntervals(events)) if (a.endMs === null) errors.push(`active action/lease at shutdown: ${a.actionId}`);
  for (const e of events) {
    if (e.type === 'lease_acquired' && !events.some((r) => r.type === 'lease_revoked' && r.leaseId === e.leaseId && eventMs(r) >= eventMs(e))) errors.push(`lease not revoked: ${e.leaseId}`);
    if (e.type === 'locator_attached' && !events.some((r) => r.type === 'locator_detached' && r.connectionEpoch === e.connectionEpoch && eventMs(r) >= eventMs(e))) errors.push(`locator callbacks not detached: ${e.connectionEpoch}`);
    if (e.type === 'route_authorized' && !events.some((r) => r.type === 'route_revoked' && r.routeId === e.routeId && eventMs(r) >= eventMs(e))) errors.push(`route controls not revoked: ${e.routeId}`);
  }
  if (summary?.eventsDropped !== 0) errors.push('run evidence is incomplete/dropped');
  if (summary?.lastGoal && !['completed', 'cancelled', 'blocked', 'failed'].includes(summary.lastGoal.state)) errors.push('last goal still owns work at shutdown');
  const shutdown = events.find((e) => e.type === 'shutdown_started');
  if (shutdown && events.some((e) => ['skill_started', 'planner_turn_started', 'goal_admitted', 'route_leg_started'].includes(e.type) && eventMs(e) > eventMs(shutdown))) errors.push('unrequested work after shutdown started');
  return errors;
}

export function reconnectProblems(events: readonly Row[], context: { goalId: string; goalEpoch: number; oldEpoch: number; newEpoch: number; routeId: string; disconnectedAtMs: number; readyAtMs: number; untilMs: number }): string[] {
  const errors: string[] = [];
  const beforeReady = (e: Row) => eventMs(e) >= context.disconnectedAtMs && eventMs(e) <= context.readyAtMs;
  if (!(context.newEpoch > context.oldEpoch)) errors.push('reconnect did not create a fresh connection epoch');
  if (!events.some((e) => e.type === 'connection_ended' && e.connectionEpoch === context.oldEpoch && beforeReady(e))) errors.push('old owned connection did not end');
  if (!events.some((e) => e.type === 'locator_detached' && e.connectionEpoch === context.oldEpoch && beforeReady(e))) errors.push('old locator callbacks were not detached');
  if (!events.some((e) => e.type === 'route_revoked' && e.routeId === context.routeId && e.goalEpoch === context.goalEpoch && beforeReady(e))) errors.push('old route was not revoked');
  if (!events.some((e) => e.type === 'goal_terminal' && e.goalId === context.goalId && e.reason !== 'outcome_verified' && beforeReady(e))) errors.push('old goal did not end without completing');
  if (!events.some((e) => e.type === 'locator_attached' && e.connectionEpoch === context.newEpoch && e.late === false && beforeReady(e))) errors.push('fresh locator was not attached before readiness');
  if (!events.some((e) => e.type === 'connection_ready' && e.connectionEpoch === context.newEpoch && eventMs(e) === context.readyAtMs)) errors.push('fresh connection readiness is missing');
  const after = events.filter((e) => eventMs(e) >= context.disconnectedAtMs && eventMs(e) <= context.untilMs);
  if (after.some((e) => ['skill_started', 'planner_turn_started', 'goal_admitted', 'route_leg_started', 'route_authorized'].includes(e.type))) errors.push('unrequested action/planning/admission after disconnect');
  if (after.some((e) => eventMs(e) >= context.readyAtMs && ['locator_owner_state', 'route_leg_started'].includes(e.type) && (e.connectionEpoch === context.oldEpoch || e.goalEpoch === context.goalEpoch))) errors.push('old callbacks/route controls survived rejoin');
  return errors;
}
