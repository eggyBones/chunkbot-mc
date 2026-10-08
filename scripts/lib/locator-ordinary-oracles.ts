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
  capture?: {
    requestedAtMs: number; receivedAtMs: number; runId: string;
    connectionEpochBefore: number; connectionEpochAfter: number;
    before: OwnerServerRead; after: OwnerServerRead;
    botBefore?: OwnerServerRead; botAfter?: OwnerServerRead;
  };
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

export interface OwnerIdentity { name: string; uuid: string }
export interface OwnerServerRead extends OwnerIdentity {
  at: Point; dimension: string; fromMs: number; toMs: number;
  replies: { position: string; uuid: string; dimension: string };
}

/** Parse only successful named-player readbacks; errors/absence are never coordinates or identity. */
export function parseOwnerServerRead(name: string, replies: OwnerServerRead['replies'], fromMs: number, toMs: number): OwnerServerRead {
  const data = (reply: string) => {
    const prefix = `${name} has the following entity data: `;
    if (!reply.startsWith(prefix)) throw new Error(`unverified server read for ${name}`);
    return reply.slice(prefix.length).trim();
  };
  const pos = /^\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]$/.exec(data(replies.position));
  const ids = /^\[I;\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\]$/.exec(data(replies.uuid));
  const dimension = /^"minecraft:([a-z_]+)"$/.exec(data(replies.dimension));
  if (!pos || !ids || !dimension) throw new Error(`unreadable server point/UUID/dimension for ${name}`);
  const at = { x: Number(pos[1]), y: Number(pos[2]), z: Number(pos[3]) };
  const words = ids.slice(1).map(Number);
  if (!point(at) || words.some((n) => !Number.isInteger(n) || n < -2_147_483_648 || n > 2_147_483_647)) throw new Error('invalid server point/UUID');
  const hex = words.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { name, uuid, at, dimension: dimension[1]!, fromMs, toMs, replies };
}

export interface HistoryProof {
  runId: string; anchorId: string; at: Point; dimension: string; connectionEpoch: number;
  observedAtMs: number; snapshotId: string; serverAtMs: number; goalEpoch: number;
  ownerIdentity: OwnerIdentity; ownerHandle: string; capture: NonNullable<ObserverSample['capture']>;
}

/** Snapshot start precedes remember(). Its timestamp must lie INSIDE the actual bounded read, never beyond read completion. */
export function verifiedHistory(observations: readonly ObserverSample[], ownerIdentity: OwnerIdentity): HistoryProof[] {
  return observations.flatMap((o) => {
    const s = o.snapshot, c = o.capture;
    if (!c || c.runId !== o.runId || c.connectionEpochBefore !== s.connectionEpoch || c.connectionEpochAfter !== s.connectionEpoch) return [];
    if (o.atMs !== s.takenAtMs || typeof s.id !== 'string' || !s.id || !Number.isInteger(s.connectionEpoch) || s.connectionEpoch < 1) return [];
    // Reparse retained raw replies; caller-supplied point/identity labels alone cannot prove anything.
    let before: OwnerServerRead, after: OwnerServerRead;
    try {
      before = parseOwnerServerRead(ownerIdentity.name, c.before.replies, c.before.fromMs, c.before.toMs);
      after = parseOwnerServerRead(ownerIdentity.name, c.after.replies, c.after.fromMs, c.after.toMs);
    } catch { return []; }
    if ([before, after].some((r, i) => {
      const stated = i === 0 ? c.before : c.after;
      return stated.name !== r.name || stated.uuid !== r.uuid || stated.dimension !== r.dimension || !point(stated.at) || distance(stated.at, r.at) > 0.000001;
    })) return [];
    if ([before, after].some((r) => r.uuid !== ownerIdentity.uuid || dim(r.dimension) !== dim(s.dimension))) return [];
    const times = [before.fromMs, before.toMs, c.requestedAtMs, s.takenAtMs, c.receivedAtMs, after.fromMs, after.toMs];
    if (times.some((t, i) => !Number.isFinite(t) || (i > 0 && t < times[i - 1]!)) || after.toMs - before.fromMs > 1_500) return [];
    if (s.owner?.visible !== true || !point(s.owner.at) || !o.owner || !same(s.owner.at, before.at) || !same(o.owner, before.at) || distance(before.at, after.at) > 0.000001 || o.serverAtMs !== before.toMs || distance(o.bot, before.at) > 32.2) return [];
    const entity = (s.entities ?? []).find((e: Row) => e.label === 'owner' && e.key === 'minecraft:player' && typeof e.handle === 'string' && point(e.at) && same(e.at, s.owner.at));
    if (!entity || !Number.isInteger(s.goalEpoch)) return [];
    return (s.remembered ?? []).filter((r: Row) => r.label === 'owner last seen' && r.source === 'observed' && typeof r.anchorId === 'string' && point(r.at) && same(r.at, s.owner.at) && dim(r.dimension) === dim(s.dimension) && Number.isFinite(r.observedAtMs) && r.observedAtMs >= s.takenAtMs && r.observedAtMs <= c.receivedAtMs).map((r: Row) => ({ runId: o.runId, anchorId: r.anchorId, at: r.at, dimension: dim(r.dimension), connectionEpoch: s.connectionEpoch, goalEpoch: s.goalEpoch, observedAtMs: r.observedAtMs, snapshotId: s.id, serverAtMs: o.serverAtMs, ownerIdentity, ownerHandle: entity.handle, capture: c }));
  });
}

export interface VisibleOwnerProof {
  runId: string; snapshotId: string; takenAtMs: number; requestAtMs: number;
  goalEpoch: number; connectionEpoch: number; dimension: string;
  owner: Point; bot: Point; ownerIdentity: OwnerIdentity; botIdentity: OwnerIdentity;
  witnessSnapshotId?: string; capture?: NonNullable<ObserverSample['capture']>;
  serverReads?: ServerVisibilityRead[];
  binding?: ModelObservationBinding;
}
export interface VisibilityScope { runId: string; goalEpoch: number; connectionEpoch: number }
export interface ServerVisibilityRead { scopeBefore: VisibilityScope; scopeAfter: VisibilityScope; owner: OwnerServerRead; bot: OwnerServerRead }
export interface VisibilityContext {
  runId: string; atMs: number; goalEpoch: number; connectionEpoch: number;
  ownerIdentity: OwnerIdentity; botIdentity: OwnerIdentity; snapshotId: string; takenAtMs: number;
  binding?: ModelObservationBinding;
}
export interface ModelObservationBinding {
  snapshotId: string; takenAtMs: number; goalEpoch: number; connectionEpoch: number;
  requestId: string; journal: Row;
}
/** P 28796a1: task ownership and planning subject scope never substitute for snapshot scope. */
export function modelObservationBinding(s: Row, events: readonly Row[], context: { source: 'jev_request' | 'planner_prompt'; runId: string; atMs: number; connectionEpoch: number }): ModelObservationBinding | undefined {
  const type = context.source === 'jev_request' ? 'task_round' : 'planner_turn_started';
  const e = events.filter((e) => e.type === type && e.run === context.runId && e.snapshotId === s.snapshotId && Number.isFinite(eventMs(e)) && eventMs(e) <= context.atMs).at(-1);
  if (!e || typeof e.requestId !== 'string' || !e.requestId || typeof s.snapshotId !== 'string' || !s.snapshotId) return undefined;
  if (type === 'planner_turn_started' && (typeof e.subject !== 'string' || !e.subject)) return undefined;
  const goalEpoch = context.source === 'jev_request' ? e.snapshotGoalEpoch : e.goalEpoch;
  if (!Number.isInteger(goalEpoch) || goalEpoch < 0 || goalEpoch !== s.goalEpoch || !Number.isInteger(e.connectionEpoch) || e.connectionEpoch < 1 || e.connectionEpoch !== context.connectionEpoch || e.connectionEpoch !== s.connectionEpoch || !Number.isFinite(e.snapshotTakenAtMs) || e.snapshotTakenAtMs !== s.takenAtMs || e.snapshotTakenAtMs > eventMs(e)) return undefined;
  return { snapshotId: e.snapshotId, takenAtMs: e.snapshotTakenAtMs, goalEpoch, connectionEpoch: e.connectionEpoch, requestId: e.requestId, journal: e };
}
/** Consistency at the identified observation time, never at an arbitrarily nearby HTTP/server sample. */
export function visibleOwnerConsistency(s: Row, witnesses: readonly ObserverSample[], ctx: VisibilityContext, reads: readonly ServerVisibilityRead[] = []): { proof?: VisibleOwnerProof; errors: string[] } {
  const fail = (reason: string) => ({ errors: [reason] });
  if (s.owner?.visible !== true || !point(s.owner.at) || !point(s.self?.at)) return fail('visible_owner_point_missing');
  if (s.snapshotId !== ctx.snapshotId || !Number.isInteger(s.goalEpoch) || s.goalEpoch !== ctx.goalEpoch || !Number.isInteger(s.connectionEpoch) || s.connectionEpoch !== ctx.connectionEpoch) return fail('visible_owner_snapshot_scope_unproven');
  if (!Number.isFinite(s.takenAtMs) || s.takenAtMs !== ctx.takenAtMs || s.takenAtMs > ctx.atMs || ctx.atMs - s.takenAtMs > 1_500) return fail('visible_owner_snapshot_time_unproven');
  const grounding = (s.entities ?? []).some((e: Row | string) => typeof e === 'string' ? /^player \(owner\) \d+(?:\.\d+)?m$/.test(e) : e.key === 'minecraft:player' && e.label === 'owner' && typeof e.handle === 'string' && point(e.at) && same(e.at, s.owner.at));
  if (!grounding) return fail('visible_owner_grounding_missing');
  type Frame = { before: OwnerServerRead; after: OwnerServerRead; botBefore?: OwnerServerRead; botAfter?: OwnerServerRead; times: number[]; witnessSnapshotId?: string; capture?: NonNullable<ObserverSample['capture']>; serverReads?: ServerVisibilityRead[] };
  const frames: Frame[] = [];
  const scopeMatches = (r: VisibilityScope) => r.runId === ctx.runId && r.goalEpoch === ctx.goalEpoch && r.connectionEpoch === ctx.connectionEpoch;
  for (let i = 0; i < reads.length; i++) for (const skip of [1, 2]) {
    const b = reads[i], a = reads[i + skip];
    if (!b || !a || b.bot.toMs > s.takenAtMs || a.owner.fromMs < s.takenAtMs || a.bot.toMs - b.owner.fromMs > 1500 || ![b.scopeBefore, b.scopeAfter, a.scopeBefore, a.scopeAfter].every(scopeMatches)) continue;
    const range = reads.slice(i, i + skip + 1);
    if (!range.flatMap((r) => [r.scopeBefore, r.scopeAfter]).every(scopeMatches)) continue;
    frames.push({ before: b.owner, after: a.owner, botBefore: b.bot, botAfter: a.bot, times: range.flatMap((r) => [r.owner.fromMs, r.owner.toMs, r.bot.fromMs, r.bot.toMs]), serverReads: range });
  }
  for (const o of witnesses) {
    const c = o.capture;
    if (!c || o.runId !== ctx.runId || c.runId !== ctx.runId || c.connectionEpochBefore !== ctx.connectionEpoch || c.connectionEpochAfter !== ctx.connectionEpoch || o.snapshot.connectionEpoch !== ctx.connectionEpoch || o.snapshot.goalEpoch !== ctx.goalEpoch || dim(o.snapshot.dimension) !== dim(s.dimension)) continue;
    frames.push({ before: c.before, after: c.after, ...(c.botBefore ? { botBefore: c.botBefore } : {}), ...(c.botAfter ? { botAfter: c.botAfter } : {}), times: [c.before.fromMs, c.before.toMs, c.requestedAtMs, o.snapshot.takenAtMs, c.receivedAtMs, c.after.fromMs, c.after.toMs], witnessSnapshotId: o.snapshot.id, capture: c });
  }
  let mismatch = false;
  for (const c of frames) {
    let before: OwnerServerRead, after: OwnerServerRead;
    const reparse = (r: OwnerServerRead, identity: OwnerIdentity) => {
      const parsed = parseOwnerServerRead(identity.name, r.replies, r.fromMs, r.toMs);
      if (parsed.name !== r.name || parsed.uuid !== r.uuid || parsed.uuid !== identity.uuid || parsed.dimension !== r.dimension || dim(parsed.dimension) !== dim(s.dimension) || !point(r.at) || distance(parsed.at, r.at) > 0.000001) throw new Error('server identity/point mismatch');
      return parsed;
    };
    try { before = reparse(c.before, ctx.ownerIdentity); after = reparse(c.after, ctx.ownerIdentity); } catch { continue; }
    const times = c.times;
    if (times.some((t, i) => !Number.isFinite(t) || (i > 0 && t < times[i - 1]!)) || after.toMs - before.fromMs > 1_500 || s.takenAtMs < before.toMs || s.takenAtMs > after.fromMs) continue;
    if (distance(before.at, after.at) > 0.000001) continue; // a changing owner point is no independent current-position proof
    if (!same(s.owner.at, before.at)) { mismatch = true; continue; }
    if (!c.botBefore || !c.botAfter) continue;
    let botBefore: OwnerServerRead, botAfter: OwnerServerRead;
    try { botBefore = reparse(c.botBefore, ctx.botIdentity); botAfter = reparse(c.botAfter, ctx.botIdentity); } catch { continue; }
    if (c.serverReads) {
      try { if (c.serverReads.some((r) => distance(reparse(r.owner, ctx.ownerIdentity).at, before.at) > 0.000001 || !same(reparse(r.bot, ctx.botIdentity).at, s.self.at))) continue; } catch { continue; }
    }
    if (!(before.toMs <= botBefore.fromMs && botBefore.fromMs <= botBefore.toMs && botBefore.toMs <= (c.capture?.requestedAtMs ?? s.takenAtMs) && botBefore.toMs <= s.takenAtMs && after.toMs <= botAfter.fromMs && botAfter.fromMs <= botAfter.toMs) || botAfter.toMs - before.fromMs > 1_500) continue;
    // Both sides independently agree with the shown self; no extrapolation/interpolation of unobserved motion.
    if (!same(s.self.at, botBefore.at) || !same(s.self.at, botAfter.at) || distance(s.self.at, before.at) > 32.2) continue;
    return { errors: [], proof: { runId: ctx.runId, snapshotId: s.snapshotId, takenAtMs: s.takenAtMs, requestAtMs: ctx.atMs, goalEpoch: ctx.goalEpoch, connectionEpoch: ctx.connectionEpoch, dimension: dim(s.dimension), owner: s.owner.at, bot: s.self.at, ownerIdentity: ctx.ownerIdentity, botIdentity: ctx.botIdentity, ...(ctx.binding ? { binding: ctx.binding } : {}), ...(c.witnessSnapshotId ? { witnessSnapshotId: c.witnessSnapshotId } : {}), ...(c.capture ? { capture: c.capture } : {}), ...(c.serverReads ? { serverReads: c.serverReads } : {}) } };
  }
  return fail(mismatch ? 'visible_owner_position_disagrees_with_bracket' : 'visible_owner_independent_bracket_missing');
}

export interface PrivacyMatch { path: string; value: string; reason: string; evidence?: HistoryProof; visibility?: VisibleOwnerProof }
export function parsePlannerInput(text: string): Row {
  const line = text.split('\n').find((l) => l.startsWith('{'));
  if (!line) throw new Error('planner input JSON is missing');
  return JSON.parse(line) as Row;
}

/** Keep the old numeric match strength, but authorize each occurrence with its exact field/point provenance. */
export function privacyOracle(input: Row, context: { runId: string; atMs: number; owner: Point; bot: Point; ownerIdentity: OwnerIdentity; connectionEpoch: number; dimension: string; history: readonly HistoryProof[]; visibility?: VisibleOwnerProof }): { findings: PrivacyMatch[]; allowed: PrivacyMatch[] } {
  const findings: PrivacyMatch[] = [], allowed: PrivacyMatch[] = [];
  const obs = input.observation ?? input.state?.observation;
  const v = context.visibility;
  const visible = v && obs?.owner?.visible === true && obs.snapshotId === v.snapshotId && obs.takenAtMs === v.takenAtMs && obs.connectionEpoch === v.connectionEpoch && obs.goalEpoch === v.goalEpoch && v.runId === context.runId && v.requestAtMs === context.atMs && v.connectionEpoch === context.connectionEpoch && v.dimension === dim(context.dimension) && v.ownerIdentity.name === context.ownerIdentity.name && v.ownerIdentity.uuid === context.ownerIdentity.uuid && point(obs.owner.at) && same(obs.owner.at, v.owner) ? v : undefined;
  const values = new Set<number>();
  for (const v of [context.owner.x, context.owner.z]) for (const b of [Math.floor(v), Math.round(v)]) for (const d of [-1, 0, 1]) values.add(b + d);
  const matches = (v: number) => Number.isFinite(v) && values.has(Math.trunc(v));
  const visit = (v: unknown, path: string, parent: Row | null, key: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${path}[${i}]`, null, String(i))); return; }
    if (v && typeof v === 'object') {
      const row = v as Row;
      const historical = /^(?:state\.)?observation\.remembered\[\d+\]$/.test(path) && row.label === 'owner last seen';
      let proof: HistoryProof | undefined;
      if (historical && point(row.at) && row.source === 'observed' && Number.isFinite(row.ageSeconds) && (row.ageSeconds > 0 || (row.ageSeconds === 0 && visible && same(row.at, visible.owner)))) {
        const observed = context.atMs - row.ageSeconds * 1_000;
        proof = context.history.find((h) => h.runId === context.runId && h.ownerIdentity.name === context.ownerIdentity.name && h.ownerIdentity.uuid === context.ownerIdentity.uuid && h.anchorId === row.anchorId && h.connectionEpoch === context.connectionEpoch && dim(row.dimension) === h.dimension && h.dimension === dim(context.dimension) && same(h.at, row.at) && h.observedAtMs < context.atMs && h.serverAtMs < context.atMs && h.capture.after.toMs < context.atMs && Math.abs(h.observedAtMs - observed) <= 1_500);
      }
      if (historical && !proof) findings.push({ path, value: JSON.stringify(row.at), reason: 'owner history lacks earlier visible observation/server proof' });
      for (const [k, x] of Object.entries(row)) {
        if (k === 'at' && point(x) && historical && proof) {
          for (const axis of ['x', 'y', 'z'] as const) if (matches(x[axis])) allowed.push({ path: `${path}.at.${axis}`, value: String(x[axis]), reason: 'verified earlier visible owner', evidence: proof });
          allowed.push({ path, value: JSON.stringify(x), reason: 'verified earlier visible owner history (not current presence)', evidence: proof });
          for (const [extra, value] of Object.entries(x)) if (!['x', 'y', 'z'].includes(extra)) visit(value, `${path}.at.${extra}`, x, extra);
        } else visit(x, path ? `${path}.${k}` : k, row, k);
      }
      return;
    }
    if (typeof v === 'number' && matches(v)) {
      if (visible && /^(?:state\.)?observation\.self\.at\.[xyz]$/.test(path) && parent && point(parent) && same(parent, visible.bot)) {
        allowed.push({ path, value: String(v), reason: 'identified self field independently bracketed at observation time', visibility: visible });
        return;
      }
      const visiblePath = /^(?:state\.)?observation\.owner\.at\.[xyz]$/.test(path);
      const entity = /^(?:state\.)?observation\.entities\[(\d+)\]\.at\.[xyz]$/.exec(path);
      const groundedOwner = entity ? obs.entities[Number(entity[1])] : undefined;
      if (visible && parent && point(parent) && same(parent, visible.owner) && (visiblePath || (groundedOwner?.key === 'minecraft:player' && groundedOwner.label === 'owner' && typeof groundedOwner.handle === 'string'))) {
        allowed.push({ path, value: String(v), reason: 'identified visible-owner field independently bracketed at observation time', visibility: visible });
        return;
      }
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
