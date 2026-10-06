// Durable, bounded, dated usage aggregates under ignored runtime storage
// (`<dataDir>/dashboard/usage-history.json`), independent of pruned run logs.
//
// - Day keys use the IANA zone recorded in the file; a zone change is a
//   recorded coverage gap rather than silent re-bucketing.
// - Each run has a cursor of the cumulative ledger state already applied, so
//   flushing repeatedly or re-observing an event never double counts.
// - A run still marked open whose process is gone ended uncleanly: anything
//   after its last flush is a recorded gap.
// - A corrupt file is moved aside (never parsed loosely) and a fresh history
//   starts with a `corrupt_reset` gap.
// - Display only. Nothing here reads into, or can replenish, the spending cap.
import { renameSync } from 'node:fs';
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
    jev: { attempts: 0, validatedResponses: 0, chargedFailures: 0, retainedAttempts: 0, releasedAttempts: 0, inputTokens: 0, outputTokens: 0, tokensUnknownAttempts: 0, confirmedNanoUsd: 0, retainedNanoUsd: 0 },
    planner: { turns: 0, completedTurns: 0, failedTurns: 0, usageUnknownTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
  };
}

export function emptyHistory(nowMs: number, timeZone: string): UsageHistory {
  return { schema: DASHBOARD_HISTORY_SCHEMA, version: DASHBOARD_HISTORY_VERSION, timeZone, recordedSinceMs: nowMs, updatedAtMs: nowMs, days: {}, runs: [], gaps: [] };
}

export type HistoryRead = { ok: true; history: UsageHistory } | { ok: false; reason: 'missing' | 'too_large' | 'unreadable' | 'corrupt'; detail: string };

/** Strict read (used by both the writer and the read-only viewer). */
export function readHistory(path: string): HistoryRead {
  const r = readBounded(path, DASHBOARD_BOUNDS.maxHistoryBytes);
  if (!r.ok) return r;
  let raw: unknown;
  try {
    raw = JSON.parse(r.text);
  } catch {
    return { ok: false, reason: 'corrupt', detail: 'usage history is not valid JSON' };
  }
  const parsed = UsageHistorySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: 'corrupt', detail: `usage history does not match the schema (${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'})`.slice(0, 300) };
  }
  return { ok: true, history: parsed.data };
}

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

const SEEN_PER_RUN = 512;

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
  private seenSet: Set<string>;
  private dirty = false;
  private lastFlushMs = 0;
  readonly timeZone: string;
  /** Last load/flush problem (shown as incomplete coverage). */
  problem: string | undefined;

  constructor(options: HistoryStoreOptions) {
    this.o = options;
    this.timeZone = options.timeZone ?? localTimeZone();
    const now = options.now();
    const read = readHistory(options.path);
    if (read.ok) {
      this.h = read.history;
    } else {
      this.h = emptyHistory(now, this.timeZone);
      if (read.reason !== 'missing') {
        const aside = `${options.path}.corrupt-${now}`;
        try {
          renameSync(options.path, aside);
        } catch {
          // unreadable and unmovable: it will be replaced by the next atomic write
        }
        this.gap(now, 'corrupt_reset', `previous usage history could not be used (${read.detail}); totals before ${new Date(now).toISOString()} are not included`);
        options.log?.(`[dashboard] usage history reset: ${read.detail}`);
      }
    }
    if (this.h.timeZone !== this.timeZone) {
      this.gap(now, 'time_zone_change', `day keys changed from ${this.h.timeZone} to ${this.timeZone}; earlier days stay keyed in the old zone`);
      this.h.timeZone = this.timeZone;
    }
    const alive = options.isPidAlive ?? pidAlive;
    for (const r of this.h.runs) {
      if (r.open && r.runId !== options.runId && (r.pid === options.pid || !alive(r.pid))) {
        r.open = false;
        r.endedUncleanly = true;
        this.gap(now, 'unclean_end', `run ${r.runId} ended without a final flush; usage after ${new Date(r.lastFlushAtMs).toISOString()} may be missing`);
      }
    }
    const existing = this.h.runs.find((r) => r.runId === options.runId);
    this.run = existing ?? { runId: options.runId, pid: options.pid, startedAtMs: options.startedAtMs, lastFlushAtMs: now, open: true, endedUncleanly: false, jev: { ...ZERO_CURSOR }, seen: [] };
    if (!existing) this.h.runs.push(this.run);
    this.seenSet = new Set(this.run.seen);
    this.pruneRuns(now);
    this.dirty = true;
    this.flush(true);
  }

  private gap(atMs: number, kind: UsageHistory['gaps'][number]['kind'], detail: string): void {
    this.h.gaps.push({ atMs, kind, detail: detail.slice(0, DASHBOARD_BOUNDS.text) });
    if (this.h.gaps.length > 64) this.h.gaps.splice(0, this.h.gaps.length - 64);
  }

  private pruneRuns(now: number): void {
    while (this.h.runs.length > DASHBOARD_BOUNDS.historyRuns) {
      const idx = this.h.runs.findIndex((r) => !r.open);
      if (idx < 0) break;
      this.h.runs.splice(idx, 1);
    }
    void now;
  }

  private pruneDays(now: number): void {
    const keys = Object.keys(this.h.days).sort();
    if (keys.length <= DASHBOARD_BOUNDS.historyDays) return;
    const drop = keys.slice(0, keys.length - DASHBOARD_BOUNDS.historyDays);
    for (const k of drop) delete this.h.days[k];
    this.gap(now, 'days_pruned', `days ${drop[0]}..${drop[drop.length - 1]} were pruned (retention ${DASHBOARD_BOUNDS.historyDays} days)`);
  }

  private day(atMs: number): DayAggregate {
    const key = dayKey(atMs, this.timeZone);
    let d = this.h.days[key];
    if (!d) {
      d = emptyDay();
      this.h.days[key] = d;
      this.pruneDays(atMs);
    }
    return d;
  }

  // ------------------------------------------------------------ UsageSink

  jev(delta: JevDayDelta, atMs: number): void {
    if (addInto(this.day(atMs).jev, delta)) this.touch();
  }

  planner(delta: PlannerDayDelta, atMs: number): void {
    if (addInto(this.day(atMs).planner, delta)) this.touch();
  }

  cursor(): LedgerCursor {
    return { ...this.run.jev };
  }

  setCursor(c: LedgerCursor): void {
    this.run.jev = { ...c };
    this.touch();
  }

  firstTime(id: string): boolean {
    if (this.seenSet.has(id)) return false;
    this.seenSet.add(id);
    this.run.seen.push(id);
    if (this.run.seen.length > SEEN_PER_RUN) {
      const removed = this.run.seen.splice(0, this.run.seen.length - SEEN_PER_RUN);
      for (const r of removed) this.seenSet.delete(r);
    }
    return true;
  }

  private touch(): void {
    this.dirty = true;
    this.flush(false);
  }

  /** Atomic write when dirty (throttled unless forced). Errors are reported, never thrown. */
  flush(force: boolean): void {
    if (!this.dirty) return;
    const now = this.o.now();
    if (!force && now - this.lastFlushMs < (this.o.flushIntervalMs ?? 1_000)) return;
    this.run.lastFlushAtMs = now;
    this.h.updatedAtMs = now;
    try {
      writeAtomic(this.o.path, `${JSON.stringify(this.h)}\n`);
      this.dirty = false;
      this.lastFlushMs = now;
      this.problem = undefined;
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
