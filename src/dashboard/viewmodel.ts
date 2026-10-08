// Viewer-side derivation: which snapshot to trust, whether it is live, and the
// display-ready view model the browser renders verbatim. All judgement lives
// here (tested TypeScript); the browser script only draws.
//
// Liveness: no file -> no_session; publisher stopped -> stopped; heartbeat
// missed -> stale (crashed when its process is gone); bot not connected ->
// disconnected; otherwise live. World readings are live only when the
// publisher is live AND they belong to the current connection epoch. Anything
// else is shown as historical with its time, never as live. A snapshot older
// than the accepted one (same run, lower seq; or an older run) is ignored.
import {
  DASHBOARD_BOUNDS,
  DashboardStatusSchema,
  nanoToUsd,
  type DashboardStatus,
  type Known,
  type RemoteMetadata,
  type UsageHistory,
} from '../contracts/dashboard.ts';
import { readBounded } from './files.ts';
import { dayKey } from './history.ts';
import { describeOutcome } from './outcome-text.ts';

export const VIEW_MODEL_VERSION = 1;

// ------------------------------------------------------------------ formatting

/** USD with enough precision for tiny Jev charges (never rounds a charge to $0.00). */
export function formatUsd(nano: number): string {
  if (!Number.isFinite(nano)) return 'unknown';
  const neg = nano < 0;
  const abs = Math.abs(Math.round(nano));
  if (abs === 0) return '$0.00';
  const usd = abs / 1e9;
  let s: string;
  if (usd >= 0.01) s = usd.toFixed(usd >= 100 ? 2 : 4).replace(/(\.\d\d\d*?)0+$/, '$1');
  else s = usd.toFixed(9).replace(/0+$/, '');
  if (!s.includes('.')) s += '.00';
  return `${neg ? '-' : ''}$${s}`;
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function itemName(key: string): string {
  const base = key.replace(/^minecraft:/, '');
  return base
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Short tile label (initials) and a stable hue for an item key. */
export function itemGlyph(key: string): { abbr: string; hue: number } {
  const words = key.replace(/^minecraft:/, '').split('_').filter(Boolean);
  const abbr = (words.length >= 2 ? `${words[0]![0]}${words[words.length - 1]![0]}` : (words[0] ?? '?').slice(0, 2)).toUpperCase();
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { abbr, hue: h % 360 };
}

export type Pip = 'full' | 'half' | 'empty';

/** Minecraft-style pips: one icon per 2 points of the actual maximum. */
export function pips(value: number, max: number, cap = 40): Pip[] {
  const n = Math.min(cap, Math.max(1, Math.ceil(max / 2)));
  const v = Math.max(0, Math.min(value, max));
  const out: Pip[] = [];
  for (let i = 0; i < n; i += 1) {
    const left = v - i * 2;
    out.push(left >= 2 ? 'full' : left >= 1 ? 'half' : 'empty');
  }
  return out;
}

/** A subset breakdown that may be reported for only some turns: never shown as 0 when unreported. */
export function breakdown(sum: number, knownTurns: number, turnsWithUsage: number): string {
  if (turnsWithUsage === 0) return 'n/a';
  if (knownTurns === 0) return 'unknown (not reported)';
  if (knownTurns < turnsWithUsage) return `≥ ${formatInt(sum)} (reported for ${knownTurns} of ${turnsWithUsage} turns)`;
  return formatInt(sum);
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const posText = (k: Known<{ x: number; y: number; z: number }>) => (k.known ? `${fmtNum(k.value.x)} ${fmtNum(k.value.y)} ${fmtNum(k.value.z)}${k.source === 'client_model' ? ' (client)' : ''}` : 'unknown');
const provTitle = (k: Known<unknown>) => (k.known ? `${k.source.replace('_', ' ')} · observed ${new Date(k.observedAtMs).toISOString()}` : `unknown: ${k.reason}`);

// ------------------------------------------------------------------ snapshot acceptance

export type ReadOutcome = { kind: 'missing' } | { kind: 'error'; detail: string } | { kind: 'ok'; status: DashboardStatus };

export function readStatusFile(path: string): ReadOutcome {
  const r = readBounded(path, DASHBOARD_BOUNDS.maxStatusBytes);
  if (!r.ok) return r.reason === 'missing' ? { kind: 'missing' } : { kind: 'error', detail: r.detail };
  let raw: unknown;
  try {
    raw = JSON.parse(r.text);
  } catch {
    return { kind: 'error', detail: 'status file is not valid JSON (partial or foreign write)' };
  }
  const p = DashboardStatusSchema.safeParse(raw);
  if (!p.success) {
    const issue = p.error.issues[0];
    return { kind: 'error', detail: `status file does not match the dashboard schema v1 (${issue ? issue.path.join('.') || '(root)' : 'invalid'})` };
  }
  return { kind: 'ok', status: p.data };
}

export type WorldSnapshot = { runId: string; epoch: number; asOfMs: number; vitals: DashboardStatus['vitals']; inventory: DashboardStatus['inventory'] };

/** Tracks the accepted snapshot across reads; rejects older/out-of-order ones. */
export class StatusFollower {
  current: DashboardStatus | undefined;
  lastError: string | undefined;
  ignored = 0;
  /** Most recent world readings that had any known value (kept across runs as historical). */
  lastKnownWorld: WorldSnapshot | undefined;
  /** Whether `lastKnownWorld` came from the currently accepted snapshot. */
  worldIsCurrent = false;
  missing = true;

  accept(outcome: ReadOutcome): void {
    if (outcome.kind === 'missing') {
      this.missing = this.current === undefined;
      this.lastError = undefined;
      return;
    }
    this.missing = false;
    if (outcome.kind === 'error') {
      this.lastError = outcome.detail;
      return;
    }
    this.lastError = undefined;
    const s = outcome.status;
    const c = this.current;
    if (c) {
      const sameRun = c.publisher.runId === s.publisher.runId;
      if (sameRun && s.publisher.seq <= c.publisher.seq) {
        if (s.publisher.seq < c.publisher.seq) this.ignored += 1;
        return;
      }
      if (!sameRun && s.publisher.startedAtMs < c.publisher.startedAtMs) {
        this.ignored += 1;
        return;
      }
    }
    this.current = s;
    const v = s.vitals;
    if (v.health.known || v.xp.known || s.inventory.contents.known) {
      const times = [v.health, v.food, v.xp, s.inventory.contents].filter((k) => k.known).map((k) => (k as { observedAtMs: number }).observedAtMs);
      this.lastKnownWorld = { runId: s.publisher.runId, epoch: v.epoch, asOfMs: Math.max(...times), vitals: v, inventory: s.inventory };
      this.worldIsCurrent = true;
    } else this.worldIsCurrent = false;
  }
}

export type Liveness = 'no_session' | 'live' | 'disconnected' | 'stale' | 'crashed' | 'stopped' | 'error';

export function staleAfterMs(status: DashboardStatus): number {
  return Math.max(2_000, status.publisher.heartbeatIntervalMs * 4);
}

export function liveness(f: StatusFollower, now: number, pidAlive: (pid: number) => boolean): { state: Liveness; title: string; detail: string } {
  const s = f.current;
  if (!s) {
    if (f.lastError) return { state: 'error', title: 'Status unreadable', detail: f.lastError };
    return { state: 'no_session', title: 'No Chunkbot session yet', detail: 'Start Chunkbot (npm run chunkbot -- run) and this page will follow it.' };
  }
  const p = s.publisher;
  if (p.state === 'stopped') return { state: 'stopped', title: 'Chunkbot stopped', detail: `Stopped ${p.stoppedReason ? `(${p.stoppedReason}) ` : ''}— everything below is the last known state.` };
  const age = now - p.publishedAtMs;
  if (age > staleAfterMs(s)) {
    const gone = !pidAlive(p.pid);
    return gone
      ? { state: 'crashed', title: 'Chunkbot is not running', detail: 'The process ended without a clean stop (crash or kill). Everything below is the last known state.' }
      : { state: 'stale', title: 'Updates stopped', detail: `No heartbeat for ${Math.round(age / 1000)} s. Values below are not live.` };
  }
  if (f.lastError) return { state: 'error', title: 'Status unreadable', detail: `${f.lastError}. Showing the last valid update.` };
  if (s.connection.state !== 'ready') {
    const what = s.connection.state === 'joining' ? 'Joining the server…' : s.connection.lastEnd ? `Disconnected (${s.connection.lastEnd.reason})` : 'Not connected';
    return { state: 'disconnected', title: what, detail: 'Chunkbot is running but the bot is not in the world. World values below are historical.' };
  }
  return { state: 'live', title: 'Live', detail: '' };
}

// ------------------------------------------------------------------ view model

export interface SlotVM {
  slot: number;
  key: string | null;
  name: string | null;
  count: number | null;
  abbr: string | null;
  hue: number | null;
}

export interface Row {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad' | 'muted';
  title?: string;
}

export interface ViewModel {
  version: number;
  generatedAtMs: number;
  banner: { state: Liveness; title: string; detail: string; updatedAtMs: number | null; ignoredOutOfOrder: number };
  identity: Row[];
  world: {
    historical: boolean;
    asOfMs: number | null;
    note: string;
    health: { text: string; pips: Pip[] | null; title: string; critical: boolean };
    food: { text: string; pips: Pip[] | null; title: string };
    saturation: string;
    xp: { level: string; progress: number | null; text: string; title: string };
    inventory: {
      status: string;
      complete: boolean;
      known: boolean;
      hotbar: SlotVM[];
      main: SlotVM[];
      armor: SlotVM[];
      offhand: SlotVM;
      selected: number | null;
      selectedTitle: string;
      container: string | null;
      totalItems: number | null;
    };
  };
  directive: {
    mode: string;
    phase: string;
    phaseTone: 'ok' | 'warn' | 'bad' | 'muted' | 'active';
    headline: string;
    instruction: string | null;
    details: Row[];
    task: { objective: string; detail: string } | null;
    lastTask: string | null;
    clarification: string | null;
    pending: { instruction: string; state: string; detail: string } | null;
    pendingInstalled: boolean;
    pause: { text: string; tone: 'warn' | 'muted' } | null;
    /** Raw bounded outcome contract, for an optional technical disclosure. */
    outcomeTechnical: string | null;
    survival: string | null;
    /** MB-FLOW-001 read-only automatic-work lines (null: not composed in this run). */
    autonomy: string[] | null;
    historical: boolean;
  };
  readiness: Array<{ name: string; ready: boolean; detail: string }>;
  usage: { jevSplit: Row[]; jev: Row[]; planner: Row[]; note: string; historical: boolean };
  history: { coverage: string; timeZone: string; days: Array<Record<string, string>>; gaps: string[]; available: boolean };
  remote: { cadence: string; openRouterKey: Row[]; openRouterStatus: string; wallet: string; codex: { status: string; detail: string; windows: Array<{ bucket: string; remaining: string; used: number; resets: string; duration: string }> } };
  memory: { installed: boolean; text: string; items: Row[] };
}

function slotVM(slot: number, map: Map<number, { item: string; count: number }>): SlotVM {
  const s = map.get(slot);
  if (!s) return { slot, key: null, name: null, count: null, abbr: null, hue: null };
  const g = itemGlyph(s.item);
  return { slot, key: s.item, name: itemName(s.item), count: s.count, abbr: g.abbr, hue: g.hue };
}

const PHASE_TONE: Record<string, ViewModel['directive']['phaseTone']> = {
  idle: 'muted',
  planning: 'active',
  executing: 'active',
  awaiting_owner: 'warn',
  stopping: 'warn',
  completed: 'ok',
  cancelled: 'muted',
  blocked: 'bad',
  failed: 'bad',
};
const PHASE_LABEL: Record<string, string> = {
  idle: 'Idle',
  planning: 'Planning',
  executing: 'Executing',
  // MB-PLAN-006: a legacy state from older releases only; never a request for a reply.
  awaiting_owner: 'Held (no reply is used)',
  stopping: 'Stopping',
  completed: 'Completed (verified)',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
  failed: 'Failed',
};

function durationText(mins: number | null): string {
  if (mins === null) return 'window length unknown';
  if (mins % 1440 === 0) return `${mins / 1440}-day window`;
  if (mins % 60 === 0) return `${mins / 60}-hour window`;
  return `${mins}-minute window`;
}

export interface ViewInputs {
  follower: StatusFollower;
  now: number;
  pidAlive: (pid: number) => boolean;
  history: { ok: true; history: UsageHistory } | { ok: false; detail: string } | undefined;
  remote: RemoteMetadata;
  timeZone: string;
  /** Actual per-source read cadence (from the configured sources). */
  cadence?: string;
}

export function buildViewModel(inp: ViewInputs): ViewModel {
  const { follower, now } = inp;
  const s = follower.current;
  const live = liveness(follower, now, inp.pidAlive);
  const appLive = live.state === 'live' || live.state === 'disconnected';
  const worldLive = Boolean(s && live.state === 'live' && s.vitals.epoch === s.connection.epoch && s.inventory.epoch === s.connection.epoch);

  // World readings: the latest snapshot that had any known reading (possibly a previous run/epoch).
  const world = follower.lastKnownWorld;
  const historical = !(worldLive && follower.worldIsCurrent);
  const v = world?.vitals;

  const healthK = v?.health;
  const maxK = v?.maxHealth;
  const health = (() => {
    if (!healthK || !healthK.known) return { text: 'unknown', pips: null, title: healthK ? provTitle(healthK) : 'no reading', critical: false };
    if (maxK?.known) return { text: `${fmtNum(healthK.value)} / ${fmtNum(maxK.value)}`, pips: pips(healthK.value, maxK.value), title: `${provTitle(healthK)}; max ${provTitle(maxK)}`, critical: healthK.value <= maxK.value * 0.3 };
    return { text: `${fmtNum(healthK.value)} (max unknown)`, pips: null, title: `${provTitle(healthK)}; max ${maxK ? provTitle(maxK) : 'unknown'}`, critical: false };
  })();
  const foodK = v?.food;
  const food = foodK?.known ? { text: `${fmtNum(foodK.value)} / 20`, pips: pips(foodK.value, 20), title: provTitle(foodK) } : { text: 'unknown', pips: null, title: foodK ? provTitle(foodK) : 'no reading' };
  const satK = v?.saturation;
  const xpK = v?.xp;
  const xp = xpK?.known
    ? { level: String(xpK.value.level), progress: xpK.value.progress, text: `${Math.floor(xpK.value.progress * 100)}% to level ${xpK.value.level + 1}`, title: `${provTitle(xpK)} · server total-experience field ${formatInt(xpK.value.totalPoints)} (not updated by /xp set)` }
    : { level: '?', progress: null, text: 'XP unknown', title: xpK ? provTitle(xpK) : 'no reading' };

  const inv = world?.inventory;
  const contents = inv?.contents;
  const map = new Map<number, { item: string; count: number }>();
  if (contents?.known) for (const sl of contents.value.slots) map.set(sl.slot, { item: sl.item, count: sl.count });
  const sel = inv?.selectedHotbar;
  const container = inv?.openContainer;
  const invStatus = !contents
    ? 'No inventory reading yet'
    : contents.known
      ? `${contents.value.complete ? 'Server-synced' : 'Partial server sync (no full restatement yet)'} · ${historical ? 'historical' : 'current'}`
      : `Inventory unknown — ${contents.reason}`;

  const dir = s?.directive;
  const goal = dir?.goal;
  const phase = goal?.phase ?? 'idle';
  const details: Row[] = [];
  if (goal?.interpretation) details.push({ label: 'Interpreted as', value: goal.interpretation });
  const outcome = goal?.outcome ? describeOutcome(goal.outcome) : undefined;
  if (outcome) details.push({ label: 'Goal outcome', value: outcome.summary ?? 'Outcome contract recorded (no readable summary; see technical details)', ...(outcome.summary ? {} : { tone: 'muted' as const }), title: 'Code verifies this outcome; a finished task is not goal completion' });
  if (goal?.progress) details.push({ label: 'Progress', value: goal.progress });
  if (goal?.terminal) details.push({ label: 'Ended', value: `${goal.terminal.reason.replace(/_/g, ' ')} — ${goal.terminal.detail}`, tone: goal.phase === 'completed' ? 'ok' : goal.phase === 'cancelled' ? 'muted' : 'bad' });
  if (goal?.counters) details.push({ label: 'Planner', value: `${goal.counters.plannerTurns} turns · ${goal.counters.windows} windows · ${goal.counters.tasksAdmitted} tasks · ${goal.counters.replans} replans`, tone: 'muted' });
  const modeLabel =
    dir?.mode === 'owner_directive'
      ? 'Owner directive'
      : dir?.mode === 'operator_diagnostic'
        ? 'Operator diagnostic (/task)'
        : dir?.mode === 'automatic_progression'
          ? 'Automatic progression (not an owner command)'
          : dir?.mode === 'automatic_support'
            ? 'Automatic survival support (not an owner command)'
            : 'No active directive';
  const au = dir?.autonomy;
  const autonomyLines: string[] | null = au
    ? [
        `Automatic work: ${au.mode.replace(/_/g, ' ')} — ${au.detail}`,
        `Stop latch: ${au.latch.paused ? `paused (${au.latch.source ?? 'stop'}; durable ${au.latch.durable}) — say resume to allow automatic work` : `clear (durable ${au.latch.durable})`}; scope ${au.scope ?? 'none'} (${au.persistence.state})`,
        ...(au.ownerIntent ? [`Your ${au.ownerIntent.state.replace(/_/g, ' ')} instruction: "${au.ownerIntent.instruction}"${au.ownerIntent.requiresOwnerDecision ? ' — held, not continued automatically (a new instruction replaces it)' : ' — held; continues when it is safe (stop cancels it)'}`] : []),
        `Session: progression ${au.session.progressionGoals}/${au.session.maxProgressionGoals}, support ${au.session.supportGoals}/${au.session.maxSupportGoals}, automatic planner turns ${au.session.plannerTurns}/${au.session.maxPlannerTurns}, verified ${au.session.completed}`,
        ...(au.blocker ? [`Waiting on: ${au.blocker.code.replace(/_/g, ' ')} — ${au.blocker.detail}`] : []),
        ...(au.home ? [`Home: ${au.home.state} at ${au.home.at.x} ${au.home.at.y} ${au.home.at.z} (${au.home.dimension}); own blocks ${au.home.ownConfirmed}/${au.home.cells}; ${au.home.verified ? `last check ${au.home.verified}` : 'not checked yet'}`] : []),
        ...(au.route ? [`Route: ${au.route.state}; legs ${au.route.legsUsed}/${au.route.maxLegs}; moved ${au.route.distanceUsed}/${au.route.maxTotalDistance}; ${Math.round(au.route.remainingMs / 1000)}s left${au.route.admissionAnchor ? `; original anchor ${au.route.admissionAnchor.x} ${au.route.admissionAnchor.y} ${au.route.admissionAnchor.z}` : ''}${au.route.blocker ? `; ${au.route.blocker}` : ''}`] : []),
        ...(au.locator ? [`Locator: ${au.locator.actionable ? `owner ${au.locator.direction ?? '?'}, ${au.locator.distanceBand}, ${au.locator.elevation}` : `not actionable (${au.locator.reason.replace(/_/g, ' ')})`} — a coarse hint, not visibility`] : []),
      ]
    : null;

  const u = s?.usage;
  const jevRows: Row[] = [];
  if (u?.jev.known) {
    const j = u.jev.value;
    jevRows.push({ label: 'Confirmed charges', value: formatUsd(j.confirmedNanoUsd), tone: 'ok', title: 'provider-reported cost of validated or trusted responses' });
    jevRows.push({ label: 'Retained (uncertain)', value: formatUsd(j.retainedNanoUsd), tone: j.retainedNanoUsd > 0 ? 'warn' : 'muted', title: 'full reservation kept for attempts whose charge is ambiguous (timeout/abort/5xx)' });
    jevRows.push({ label: 'Pending reservation', value: formatUsd(j.pendingNanoUsd), tone: j.pendingNanoUsd > 0 ? 'warn' : 'muted', title: 'in-flight request maximum' });
    jevRows.push({ label: 'Local cap remaining', value: `${formatUsd(j.remainingNanoUsd)} of ${formatUsd(j.capNanoUsd)}`, title: "this run's application spending cap — not the OpenRouter wallet" });
    jevRows.push({ label: 'Attempts', value: `${formatInt(j.attempts)} (${j.validatedResponses} validated, ${j.retries} retries, ${j.chargedFailures} charged failures, ${j.retainedAttempts} ambiguous, ${j.releasedAttempts} not charged, ${j.refused} refused locally)` });
    jevRows.push({ label: 'Tokens', value: `${formatInt(j.inputTokens)} in · ${formatInt(j.outputTokens)} out`, ...(j.tokensUnknownAttempts > 0 ? { title: `${j.tokensUnknownAttempts} attempt(s) have unknown token counts` } : {}) });
    if (j.chargedFailures > 0) {
      jevRows.push({
        label: 'Charged-failure tokens',
        value: j.chargedFailuresTokensKnown > 0 ? `${formatInt(j.chargedFailureInputTokens)} in · ${formatInt(j.chargedFailureOutputTokens)} out (reported for ${j.chargedFailuresTokensKnown} of ${j.chargedFailures})` : `unknown for all ${j.chargedFailures}`,
        tone: j.chargedFailuresTokensKnown < j.chargedFailures ? 'warn' : 'muted',
        title: 'charged attempts whose answer was unusable; their cost is in Confirmed charges',
      });
    }
    if (j.tokensUnknownAttempts > 0) jevRows.push({ label: 'Unknown tokens', value: `${j.tokensUnknownAttempts} attempt(s) — counts not reported`, tone: 'warn' });
  } else jevRows.push({ label: 'Jev', value: u && !u.jev.known ? `unknown — ${u.jev.reason}` : 'no session', tone: 'muted' });
  const plannerRows: Row[] = [];
  if (u?.planner.known) {
    const p = u.planner.value;
    plannerRows.push({ label: 'Turns', value: `${p.turns} (${p.completedTurns} completed, ${p.failedTurns} failed)` });
    plannerRows.push({ label: 'Input tokens', value: `${formatInt(p.inputTokens)} · cached ${breakdown(p.cachedInputTokens, p.cachedKnownTurns, p.usageKnownTurns)}`, title: 'cached is a subset of input, never added to it' });
    plannerRows.push({ label: 'Output tokens', value: `${formatInt(p.outputTokens)} · reasoning ${breakdown(p.reasoningOutputTokens, p.reasoningKnownTurns, p.usageKnownTurns)}`, title: 'reasoning is a subset of output, never added to it' });
    if (p.usageKnownTurns < p.completedTurns + p.failedTurns) plannerRows.push({ label: 'Token totals cover', value: `${p.usageKnownTurns} of ${p.completedTurns + p.failedTurns} finished turn(s)`, tone: 'warn' });
    if (p.usageUnknownTurns > 0) plannerRows.push({ label: 'Unknown usage', value: `${p.usageUnknownTurns} turn(s) — failed/cancelled turns report no usage`, tone: 'warn' });
    plannerRows.push({ label: 'Billing', value: 'Codex subscription usage — no API dollar charge', tone: 'muted' });
  } else plannerRows.push({ label: 'Planner', value: u && !u.planner.known ? `unknown — ${u.planner.reason}` : 'no session', tone: 'muted' });

  // History
  let historyVM: ViewModel['history'];
  if (inp.history?.ok) {
    const h = inp.history.history;
    const keys = Object.keys(h.days).sort().reverse().slice(0, 14);
    const today = dayKey(now, h.timeZone);
    const unclean = h.runs.filter((r) => r.endedUncleanly).length;
    historyVM = {
      available: true,
      timeZone: h.timeZone,
      coverage: `Recorded by this dashboard since ${new Date(h.recordedSinceMs).toISOString().slice(0, 10)} (${h.timeZone}); not lifetime account usage.${h.gaps.length + h.gapsOmitted ? ` ${h.gaps.length + h.gapsOmitted} coverage note(s).` : ''}${unclean ? ` ${unclean} run(s) ended uncleanly.` : ''}${h.rollup ? ` Earlier ${h.rollup.days} day(s) through ${h.rollup.throughDay} are kept as one total: Jev ${formatUsd(h.rollup.totals.jev.confirmedNanoUsd)} confirmed, ${formatUsd(h.rollup.totals.jev.retainedNanoUsd)} retained, ${formatInt(h.rollup.totals.jev.attempts)} calls, ${formatInt(h.rollup.totals.planner.turns)} planner turns.` : ''}`,
      days: keys.map((k) => {
        const d = h.days[k]!;
        return {
          day: k === today ? `${k} (today)` : k,
          jevUsd: formatUsd(d.jev.confirmedNanoUsd),
          retainedUsd: formatUsd(d.jev.retainedNanoUsd),
          jevAttempts: formatInt(d.jev.attempts),
          jevTokens: `${formatInt(d.jev.inputTokens)} / ${formatInt(d.jev.outputTokens)}${d.jev.chargedFailuresTokensKnown ? ` (+${formatInt(d.jev.chargedFailureInputTokens)} / ${formatInt(d.jev.chargedFailureOutputTokens)} charged failures)` : ''}${d.jev.tokensUnknownAttempts ? ` (+${d.jev.tokensUnknownAttempts} unknown)` : ''}`,
          plannerTurns: formatInt(d.planner.turns),
          plannerTokens: `${formatInt(d.planner.inputTokens)} / ${formatInt(d.planner.outputTokens)}${d.planner.usageUnknownTurns ? ` (+${d.planner.usageUnknownTurns} unknown)` : ''}`,
        };
      }),
      gaps: h.gaps.slice(-5).map((g) => `${new Date(g.atMs).toISOString().slice(0, 16).replace('T', ' ')} ${g.kind.replace(/_/g, ' ')}: ${g.detail}`),
    };
  } else {
    historyVM = { available: false, timeZone: inp.timeZone, coverage: inp.history ? `Usage history unavailable: ${inp.history.detail}` : 'No usage history recorded yet', days: [], gaps: [] };
  }

  // Remote
  const r = inp.remote;
  const kv = r.openRouterKey.value;
  const keyRows: Row[] = [];
  const kStr = (k: Known<number | null> | undefined, nullText: string) => (!k ? 'unknown' : !k.known ? 'not reported' : k.value === null ? nullText : formatUsd(k.value * 1e9));
  if (kv) {
    keyRows.push({ label: 'Key usage today', value: kStr(kv.dailyUsd, 'n/a') });
    keyRows.push({ label: 'This week / month', value: `${kStr(kv.weeklyUsd, 'n/a')} / ${kStr(kv.monthlyUsd, 'n/a')}` });
    keyRows.push({ label: 'Key limit', value: kStr(kv.limitUsd, 'no key cap reported (not unlimited credit)') });
    if (kv.limitRemainingUsd.known && kv.limitRemainingUsd.value !== null) keyRows.push({ label: 'Key limit remaining', value: formatUsd(kv.limitRemainingUsd.value * 1e9) });
  }
  const statusText = (st: string, checked: number | null, detail: string) =>
    st === 'fresh' ? `current · checked ${checked ? new Date(checked).toISOString().slice(11, 19) : '?'} UTC` : st === 'stale' ? `STALE — last success over 5 min ago (${detail})` : st === 'pending' ? 'checking…' : st === 'not_configured' ? `not configured — ${detail}` : `unavailable — ${detail}`;
  const q = r.codexQuota;
  const remote: ViewModel['remote'] = {
    cadence: inp.cadence ?? 'per source, shared by all tabs',
    openRouterKey: keyRows,
    openRouterStatus: `${statusText(r.openRouterKey.status, r.openRouterKey.checkedAtMs, r.openRouterKey.detail)} · includes every tool using this key`,
    wallet: `OpenRouter wallet balance unavailable — ${r.openRouterWallet.detail}`,
    codex: {
      status: q.status === 'fresh' || q.status === 'stale' ? statusText(q.status, q.checkedAtMs, q.detail) : `Remaining Codex allowance unavailable — ${q.detail}${q.checkedAtMs ? ` (last check ${new Date(q.checkedAtMs).toISOString().slice(11, 19)} UTC)` : ''}`,
      detail: 'Account-wide subscription windows (shared with your other Codex use); not reserved for Chunkbot.',
      windows: q.windows.map((w) => ({
        bucket: w.bucket,
        used: w.usedPercent,
        remaining: `${Math.max(0, 100 - w.usedPercent)}% left`,
        resets: w.resetsAtMs ? new Date(w.resetsAtMs).toISOString() : 'reset time unknown',
        duration: durationText(w.windowDurationMins),
      })),
    },
  };

  const mem = s?.memory;
  return {
    version: VIEW_MODEL_VERSION,
    generatedAtMs: now,
    banner: { ...live, updatedAtMs: s?.publisher.publishedAtMs ?? null, ignoredOutOfOrder: follower.ignored },
    identity: s
      ? [
          { label: 'Bot', value: s.connection.botName.known ? s.connection.botName.value : (world ? 'last session' : 'unknown') },
          { label: 'Connection', value: `${s.connection.state}${s.connection.lastEnd && s.connection.state !== 'ready' ? ` (${s.connection.lastEnd.reason})` : ''}`, tone: s.connection.state === 'ready' && appLive ? 'ok' : 'warn' },
          { label: 'Dimension', value: s.connection.dimension.known ? s.connection.dimension.value.replace(/^minecraft:/, '') : 'unknown' },
          { label: 'Mode', value: s.connection.gameMode.known ? s.connection.gameMode.value : 'unknown' },
          { label: 'Version', value: `${s.connection.profile.version} (${s.connection.profile.supportLevel})` },
          { label: 'Position', value: posText(s.connection.position), ...(s.connection.position.known ? {} : { tone: 'muted' as const }), title: `${provTitle(s.connection.position)}; last server-set position: ${s.connection.serverPosition.known ? `${posText(s.connection.serverPosition)} (${new Date(s.connection.serverPosition.observedAtMs).toISOString().slice(11, 19)} UTC)` : 'none on this connection'}` },
          { label: 'Epoch', value: `connection ${s.connection.epoch}`, tone: 'muted', title: `run ${s.publisher.runId}` },
        ]
      : [],
    world: {
      historical,
      asOfMs: world ? world.asOfMs : null,
      note: !world ? 'No readings yet' : historical ? `Last known — ${world.runId === s?.publisher.runId ? `connection ${world.epoch}` : 'a previous run'}; not live` : 'Live',
      health,
      food,
      saturation: satK?.known ? fmtNum(satK.value) : 'unknown',
      xp,
      inventory: {
        status: invStatus,
        complete: Boolean(contents?.known && contents.value.complete),
        known: Boolean(contents?.known),
        hotbar: Array.from({ length: 9 }, (_, i) => slotVM(36 + i, map)),
        main: Array.from({ length: 27 }, (_, i) => slotVM(9 + i, map)),
        armor: [5, 6, 7, 8].map((sl) => slotVM(sl, map)),
        offhand: slotVM(45, map),
        selected: sel?.known ? sel.value : null,
        selectedTitle: sel ? provTitle(sel) : 'unknown',
        container: container ? `Container open (${container.windowType}) — the player inventory below stays separate` : null,
        totalItems: contents?.known ? contents.value.slots.reduce((n, x) => n + x.count, 0) : null,
      },
    },
    directive: {
      mode: modeLabel,
      phase: PHASE_LABEL[phase] ?? phase,
      phaseTone: PHASE_TONE[phase] ?? 'muted',
      headline: goal ? goal.instruction : 'No directive yet',
      instruction: goal?.instruction ?? null,
      details,
      task: dir?.task.current ? { objective: dir.task.current.objective, detail: `${dir.task.current.mode} task · started ${new Date(dir.task.current.startedAtMs).toISOString().slice(11, 19)} UTC` } : null,
      lastTask: dir?.task.last ? `${dir.task.last.status} (${dir.task.last.reason.replace(/_/g, ' ')}) — ${dir.task.last.detail}` : null,
      // MB-PLAN-006: legacy question text (older releases) is never re-shown or answered.
      clarification: null,
      pending: dir?.pending ? { instruction: dir.pending.instruction, state: dir.pending.state.replace(/_/g, ' '), detail: dir.pending.detail ?? 'Not started — the current directive continues until the switch.' } : null,
      pendingInstalled: Boolean(s?.integrations.handoff),
      outcomeTechnical: outcome?.technical ?? null,
      pause: !s
        ? null
        : !s.integrations.pause || !dir?.pause
          ? { text: 'Pause state not reported by this Chunkbot build', tone: 'muted' }
          : dir.pause.paused
            ? { text: `Automatic work paused${dir.pause.manualGoalsAllowed ? '; a manual goal can still execute' : ''} — ${dir.pause.reason}${dir.pause.sinceMs ? ` (since ${new Date(dir.pause.sinceMs).toISOString().slice(11, 19)} UTC)` : ''}`, tone: 'warn' }
            : null,
      survival: dir?.survival ? `${dir.survival.routine}: ${dir.survival.reason}${dir.survival.phase ? ` (${dir.survival.phase}${dir.survival.attempt !== undefined ? `, attempt ${dir.survival.attempt}` : ''})` : ''}` : null,
      autonomy: autonomyLines,
      historical: !appLive,
    },
    readiness: s
      ? (Object.entries(s.readiness) as Array<[string, unknown]>)
          .filter(([, x]) => typeof x === 'object')
          .map(([name, x]) => ({ name, ready: (x as { ready: boolean }).ready, detail: (x as { detail: string }).detail }))
      : [],
    usage: { jevSplit: jevRows.length >= 4 && u?.jev.known ? jevRows.slice(0, 3) : [], jev: jevRows.length >= 4 && u?.jev.known ? jevRows.slice(3) : jevRows, planner: plannerRows, note: 'This run only. Dated totals below come from the durable usage history.', historical: !appLive },
    history: historyVM,
    remote,
    memory: !mem
      ? { installed: false, text: 'No session', items: [] }
      : mem.known
        ? {
            installed: true,
            text: `${mem.value.worldProfile ? `World profile ${mem.value.worldProfile.id} (revision ${mem.value.worldProfile.revision}) · ` : 'No world profile configured · '}${mem.value.totalItems} remembered item(s)`,
            items: [
              ...(mem.value.home
                ? [{ label: `Home: ${mem.value.home.label}`, value: `${mem.value.home.dimension.replace(/^minecraft:/, '')} ${fmtNum(mem.value.home.at.x)} ${fmtNum(mem.value.home.at.y)} ${fmtNum(mem.value.home.at.z)} · ${mem.value.home.source} · ${new Date(mem.value.home.observedAtMs).toISOString().slice(0, 16).replace('T', ' ')}${mem.value.home.stale ? ' · stale' : ''}`, ...(mem.value.home.stale ? { tone: 'warn' as const } : {}), title: 'remembered, not proof that it still exists' }]
                : [{ label: 'Home', value: 'none designated', tone: 'muted' as const }]),
              ...mem.value.items.map((m) => ({ label: m.label, value: `${m.kind}${m.dimension ? ` · ${m.dimension}` : ''}${m.at ? ` · ${fmtNum(m.at.x)} ${fmtNum(m.at.y)} ${fmtNum(m.at.z)}` : ''} · ${m.source} · ${new Date(m.observedAtMs).toISOString().slice(0, 16).replace('T', ' ')}` })),
            ],
          }
        : { installed: Boolean(s?.integrations.memory), text: mem.reason, items: [] },
  };
}

export { nanoToUsd };
