// Durable, bounded, dated usage aggregates under ignored runtime storage
// (`<dataDir>/dashboard/usage-history.json`), independent of pruned run logs.
//
// - Day keys use the IANA zone recorded in the file; a zone change is a
//   recorded coverage gap rather than silent re-bucketing.
// - Each run has a cursor of the cumulative ledger state already applied. The
//   cursor and the dated delta it implies are changed together in memory and
//   committed by ONE atomic write, so no file ever holds an advanced cursor
//   without its charge (MB-UI-001-C2).
// - Event identities are deduplicated in memory for the run (runs are
//   per-process); they are not persisted (MB-UI-001-C1).
// - The serialized file is kept under `historyWriteTargetBytes` (well inside the
//   reader bound) by compacting: closed run cursors first, then the oldest days
//   into a running `rollup` that keeps their sums, then the oldest gap notes
//   (counted). Totals and coverage are never discarded to save space.
// - A run still marked open whose process is gone ended uncleanly.
// - An unparseable file is moved aside with a `corrupt_reset` gap; a valid
//   version-1 or oversized file of our own is migrated/compacted, not reset.
// - Display only. Nothing here reads into, or can replenish, the spending cap.
import { renameSync } from 'node:fs';
import { z } from 'zod';
import {
  DASHBOARD_BOUNDS,
  DASHBOARD_HISTORY_SCHEMA,
  DASHBOARD_HISTORY_VERSION,
  UsageHistorySchema,
  type DayAggregate,
  type RunCursor,
  type UsageHistory,
} from '../contracts/dashboard.ts';
import { readBounded, writeAtomic } from './files.ts';
import { ZERO_CURSOR, type JevDayDelta, type LedgerCursor, type PlannerDayDelta, type UsageSink } from './usage.ts';

export function dayKey(atMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(atMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function emptyDay(): DayAggregate {
  return {
    jev: { attempts: 0, validatedResponses: 0, chargedFailures: 0, retainedAttempts: 0, releasedAttempts: 0, inputTokens: 0, outputTokens: 0, chargedFailuresTokensKnown: 0, chargedFailureInputTokens: 0, chargedFailureOutputTokens: 0, tokensUnknownAttempts: 0, confirmedNanoUsd: 0, retainedNanoUsd: 0 },
    planner: { turns: 0, completedTurns: 0, failedTurns: 0, usageUnknownTurns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cachedKnownTurns: 0, reasoningOutputTokens: 0, reasoningKnownTurns: 0 },
  };
}

export function emptyHistory(nowMs: number, timeZone: string): UsageHistory {
  return { schema: DASHBOARD_HISTORY_SCHEMA, version: DASHBOARD_HISTORY_VERSION, timeZone, recordedSinceMs: nowMs, updatedAtMs: nowMs, days: {}, rollup: null, runs: [], gaps: [], gapsOmitted: 0 };
}

function addDay(into: DayAggregate, from: DayAggregate): void {
  for (const part of ['jev', 'planner'] as const) {
    const t = into[part] as Record<string, number>;
    for (const [k, v] of Object.entries(from[part] as Record<string, number>)) t[k] = (t[k] ?? 0) + v;
  }
}

// ------------------------------------------------------------------ reading (incl. v1 migration)

const nn = z.number().int().nonnegative();
/** Version-1 files written by earlier MB-UI-001 builds (persisted `seen`, no rollup, v1 day fields). */
const LegacyV1Schema = z
  .object({
    schema: z.literal(DASHBOARD_HISTORY_SCHEMA),
    version: z.literal(1),
    timeZone: z.string().max(200),
    recordedSinceMs: nn,
    updatedAtMs: nn,
    days: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.object({ jev: z.record(z.string(), nn), planner: z.record(z.string(), nn) })),
    runs: z.array(z.object({ runId: z.string(), pid: z.number().int().positive(), startedAtMs: nn, lastFlushAtMs: nn, open: z.boolean(), endedUncleanly: z.boolean(), jev: z.record(z.string(), nn) }).passthrough()),
    gaps: z.array(z.object({ atMs: nn, kind: z.string(), detail: z.string() }).passthrough()),
  })
  .passthrough();

function migrateV1(raw: z.infer<typeof LegacyV1Schema>, nowMs: number): UsageHistory | undefined {
  const h = emptyHistory(raw.recordedSinceMs, raw.timeZone.slice(0, 200));
  h.updatedAtMs = raw.updatedAtMs;
  for (const [k, d] of Object.entries(raw.days)) {
    const day = emptyDay();
    for (const [f, v] of Object.entries(d.jev)) if (f in day.jev) (day.jev as Record<string, number>)[f] = v;
    for (const [f, v] of Object.entries(d.planner)) if (f in day.planner) (day.planner as Record<string, number>)[f] = v;
    // v1 summed cached/reasoning as if every completed turn reported them; their coverage is unknown now.
    h.days[k] = day;
  }
  h.runs = raw.runs.slice(-DASHBOARD_BOUNDS.historyRuns).map((r) => ({
    runId: r.runId,
    pid: r.pid,
    startedAtMs: r.startedAtMs,
    lastFlushAtMs: r.lastFlushAtMs,
    open: r.open,
    endedUncleanly: r.endedUncleanly,
    jev: { ...ZERO_CURSOR, ...Object.fromEntries(Object.entries(r.jev).filter(([k]) => k in ZERO_CURSOR)) },
  }));
  const kinds = new Set(['corrupt_reset', 'unclean_end', 'time_zone_change', 'days_pruned', 'runs_pruned', 'migrated']);
  h.gaps = raw.gaps.filter((g) => kinds.has(g.kind)).slice(-63).map((g) => ({ atMs: g.atMs, kind: g.kind as UsageHistory['gaps'][number]['kind'], detail: g.detail.slice(0, DASHBOARD_BOUNDS.text) }));
  h.gaps.push({ atMs: nowMs, kind: 'migrated', detail: 'usage history migrated from format 1; planner cached/reasoning breakdown coverage before this point is unknown' });
  const parsed = UsageHistorySchema.safeParse(h);
  return parsed.success ? parsed.data : undefined;
}

export type HistoryRead = { ok: true; history: UsageHistory; migrated?: boolean } | { ok: false; reason: 'missing' | 'too_large' | 'unreadable' | 'corrupt'; detail: string };

/** Strict read. `maxBytes` defaults to the viewer bound; the writer passes the larger recovery bound. */
export function readHistory(path: string, maxBytes: number = DASHBOARD_BOUNDS.maxHistoryBytes, nowMs = Date.now()): HistoryRead {
  const r = readBounded(path, maxBytes);
  if (!r.ok) return r;
  let raw: unknown;
  try {
    raw = JSON.parse(r.text);
  } catch {
    return { ok: false, reason: 'corrupt', detail: 'usage history is not valid JSON' };
  }
  const parsed = UsageHistorySchema.safeParse(raw);
  if (parsed.success) return { ok: true, history: parsed.data };
  const legacy = LegacyV1Schema.safeParse(raw);
  if (legacy.success) {
    const migrated = migrateV1(legacy.data, nowMs);
    if (migrated) return { ok: true, history: migrated, migrated: true };
  }
  const issue = parsed.error.issues[0];
  return { ok: false, reason: 'corrupt', detail: `usage history does not match the schema (${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'})`.slice(0, 300) };
}

// ------------------------------------------------------------------ compaction

const serialize = (h: UsageHistory) => `${JSON.stringify(h)}\n`;

/**
 * Compacts in place until the serialized size is at most `targetBytes`, keeping
 * every sum: closed run cursors, then oldest days into the rollup, then the
 * oldest gap notes (counted in `gapsOmitted`). Returns the serialized text.
 */
export function compactHistory(h: UsageHistory, targetBytes: number, nowMs: number, keepDays: number = DASHBOARD_BOUNDS.historyDays): string {
  const rollDay = (key: string) => {
    const d = h.days[key];
    if (!d) return;
    if (!h.rollup) h.rollup = { throughDay: key, days: 0, totals: emptyDay() };
    addDay(h.rollup.totals, d);
    h.rollup.days += 1;
    if (key > h.rollup.throughDay) h.rollup.throughDay = key;
    delete h.days[key];
  };
  // Retention by count (sums kept in the rollup).
  const keys = Object.keys(h.days).sort();
  const over = keys.length - keepDays;
  if (over > 0) {
    for (const k of keys.slice(0, over)) rollDay(k);
    pushGap(h, { atMs: nowMs, kind: 'days_pruned', detail: `per-day detail through ${h.rollup?.throughDay} folded into the rollup (retention ${keepDays} days); totals kept` });
  }
  while (h.runs.length > DASHBOARD_BOUNDS.historyRuns) {
    const i = h.runs.findIndex((r) => !r.open);
    if (i < 0) break;
    h.runs.splice(i, 1);
  }
  let text = serialize(h);
  let rolledForSize = 0;
  // Batch steps (each re-serializes once) so compaction stays linear for large files.
  while (Buffer.byteLength(text) > targetBytes) {
    const size = Buffer.byteLength(text);
    const closed = h.runs.filter((r) => !r.open);
    const dayKeys = Object.keys(h.days).sort();
    if (closed.length > 0) {
      // Closed cursors carry no totals; drop the oldest half (at least one).
      const drop = new Set(closed.slice(0, Math.max(1, Math.ceil(closed.length / 2))));
      h.runs = h.runs.filter((r) => !drop.has(r));
    } else if (dayKeys.length > 1) {
      const n = Math.min(dayKeys.length - 1, Math.max(1, Math.ceil((dayKeys.length * (size - targetBytes)) / size)));
      for (const k of dayKeys.slice(0, n)) rollDay(k);
      rolledForSize += n;
    } else if (h.gaps.length > 1) {
      const k = Math.min(Math.max(1, Math.ceil(h.gaps.length / 2)), h.gaps.length - 1);
      h.gaps.splice(0, k);
      h.gapsOmitted += k;
    } else break; // nothing more can be compacted without losing totals
    text = serialize(h);
  }
  if (rolledForSize > 0) {
    pushGap(h, { atMs: nowMs, kind: 'days_pruned', detail: `${rolledForSize} oldest day(s) folded into the rollup to keep the file under ${targetBytes} bytes; totals kept` });
    text = serialize(h);
  }
  return text;
}

function pushGap(h: UsageHistory, gap: UsageHistory['gaps'][number]): void {
  h.gaps.push({ ...gap, detail: gap.detail.slice(0, DASHBOARD_BOUNDS.text) });
  while (h.gaps.length > 64) {
    h.gaps.shift();
    h.gapsOmitted += 1;
  }
}

// ------------------------------------------------------------------ the writer

export interface HistoryStoreOptions {
  path: string;
  runId: string;
  pid: number;
  startedAtMs: number;
  now: () => number;
  timeZone?: string;
  /** Whether a process id is still running (unclean-end detection). */
  isPidAlive?: (pid: number) => boolean;
  /** Minimum interval between automatic flushes. */
  flushIntervalMs?: number;
  /** Serialized size the writer keeps the file under (default `historyWriteTargetBytes`). */
  targetBytes?: number;
  /** Write hook (tests: observe each committed file / simulate failures). */
  write?: (path: string, text: string) => void;
  log?: (line: string) => void;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function addInto<T extends Record<string, number>>(target: T, delta: Partial<T>): boolean {
  let changed = false;
  for (const [k, v] of Object.entries(delta)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || !(k in target)) continue;
    (target as Record<string, number>)[k] = ((target as Record<string, number>)[k] ?? 0) + Math.trunc(v);
    changed = true;
  }
  return changed;
}

/** The single writer of the aggregate file (the running Chunkbot application). */
export class UsageHistoryStore implements UsageSink {
  private readonly o: HistoryStoreOptions;
  private h: UsageHistory;
  private run: RunCursor;
  private readonly seen = new Set<string>();
  private dirty = false;
  private lastFlushMs = 0;
  readonly timeZone: string;
  /** Last load/flush problem (shown as incomplete coverage). */
  problem: string | undefined;

  constructor(options: HistoryStoreOptions) {
    this.o = options;
    this.timeZone = options.timeZone ?? localTimeZone();
    const now = options.now();
    const read = readHistory(options.path, DASHBOARD_BOUNDS.historyRecoverBytes, now);
    if (read.ok) {
      this.h = read.history;
      if (read.migrated) options.log?.('[dashboard] usage history migrated from format 1');
    } else {
      this.h = emptyHistory(now, this.timeZone);
      if (read.reason !== 'missing') {
        const aside = `${options.path}.corrupt-${now}`;
        try {
          renameSync(options.path, aside);
        } catch {
          // unreadable and unmovable: it will be replaced by the next atomic write
        }
        pushGap(this.h, { atMs: now, kind: 'corrupt_reset', detail: `previous usage history could not be used (${read.detail}); it was kept aside and totals before ${new Date(now).toISOString()} are not included` });
        options.log?.(`[dashboard] usage history reset: ${read.detail}`);
      }
    }
    if (this.h.timeZone !== this.timeZone) {
      pushGap(this.h, { atMs: now, kind: 'time_zone_change', detail: `day keys changed from ${this.h.timeZone} to ${this.timeZone}; earlier days stay keyed in the old zone` });
      this.h.timeZone = this.timeZone;
    }
    const alive = options.isPidAlive ?? pidAlive;
    for (const r of this.h.runs) {
      if (r.open && r.runId !== options.runId && (r.pid === options.pid || !alive(r.pid))) {
        r.open = false;
        r.endedUncleanly = true;
        pushGap(this.h, { atMs: now, kind: 'unclean_end', detail: `run ${r.runId} ended without a final flush; usage after ${new Date(r.lastFlushAtMs).toISOString()} may be missing` });
      }
    }
    const existing = this.h.runs.find((r) => r.runId === options.runId);
    this.run = existing ?? { runId: options.runId, pid: options.pid, startedAtMs: options.startedAtMs, lastFlushAtMs: now, open: true, endedUncleanly: false, jev: { ...ZERO_CURSOR } };
    if (!existing) this.h.runs.push(this.run);
    this.dirty = true;
    this.flush(true);
  }

  private day(atMs: number): DayAggregate {
    const key = dayKey(atMs, this.timeZone);
    let d = this.h.days[key];
    if (!d) {
      d = emptyDay();
      this.h.days[key] = d;
    }
    return d;
  }

  // ------------------------------------------------------------ UsageSink

  applyEvent(id: string, delta: { jev?: JevDayDelta; planner?: PlannerDayDelta }, atMs: number): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 8_192) this.seen.delete(this.seen.values().next().value as string);
    const d = this.day(atMs);
    const a = delta.jev ? addInto(d.jev, delta.jev) : false;
    const b = delta.planner ? addInto(d.planner, delta.planner) : false;
    if (a || b) this.touch();
    return true;
  }

  /** Advances the cursor AND applies its dated delta before any write can happen (single commit). */
  commitLedger(next: LedgerCursor, delta: JevDayDelta, atMs: number): void {
    this.run.jev = { ...next };
    addInto(this.day(atMs).jev, delta);
    this.touch();
  }

  cursor(): LedgerCursor {
    return { ...this.run.jev };
  }

  private touch(): void {
    this.dirty = true;
    this.flush(false);
  }

  /** Atomic, size-bounded write when dirty (throttled unless forced). Errors are reported, never thrown. */
  flush(force: boolean): void {
    if (!this.dirty) return;
    const now = this.o.now();
    if (!force && now - this.lastFlushMs < (this.o.flushIntervalMs ?? 1_000)) return;
    this.run.lastFlushAtMs = now;
    this.h.updatedAtMs = now;
    const text = compactHistory(this.h, this.o.targetBytes ?? DASHBOARD_BOUNDS.historyWriteTargetBytes, now);
    try {
      (this.o.write ?? writeAtomic)(this.o.path, text);
      this.dirty = false;
      this.lastFlushMs = now;
      this.problem = Buffer.byteLength(text) > DASHBOARD_BOUNDS.maxHistoryBytes ? 'usage history exceeds the reader bound even after compaction' : undefined;
    } catch (error) {
      this.problem = `usage history write failed (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
    }
  }

  /** Graceful end of this run: final flush, run closed. */
  close(): void {
    this.run.open = false;
    this.dirty = true;
    this.flush(true);
  }

  snapshot(): UsageHistory {
    return structuredClone(this.h);
  }
}
