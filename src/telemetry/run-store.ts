// Local JSONL run evidence with bounded size and retention. Persisted evidence
// is redacted; active goals are never persisted or resumed.
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock, EvidenceEvent, RunStore } from '../contracts/index.ts';
import { redact, type RedactOptions } from './redact.ts';

export interface FileRunStoreOptions {
  runsDir: string;
  runId: string;
  clock: Clock;
  maxEvents: number;
  maxEventChars: number;
  keepRuns: number;
}

export class FileRunStore implements RunStore {
  readonly runId: string;
  readonly dir: string;
  readonly eventsPath: string;
  private readonly clock: Clock;
  private readonly maxEvents: number;
  private readonly redactOptions: RedactOptions;
  private written = 0;
  private dropped = 0;
  private closed = false;

  constructor(options: FileRunStoreOptions) {
    this.runId = options.runId;
    this.clock = options.clock;
    this.maxEvents = options.maxEvents;
    this.redactOptions = { maxStringChars: options.maxEventChars, maxArrayItems: 32, maxDepth: 6 };
    mkdirSync(options.runsDir, { recursive: true, mode: 0o700 });
    pruneRuns(options.runsDir, options.keepRuns - 1);
    this.dir = join(options.runsDir, options.runId);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.eventsPath = join(this.dir, 'events.jsonl');
    writeFileSync(this.eventsPath, '', { mode: 0o600 });
  }

  record(event: EvidenceEvent): void {
    if (this.closed) return;
    if (this.written >= this.maxEvents) {
      this.dropped += 1;
      return;
    }
    const line = { t: new Date(this.clock.now()).toISOString(), run: this.runId, ...(redact(event, this.redactOptions) as object) };
    try {
      appendFileSync(this.eventsPath, `${JSON.stringify(line)}\n`);
      this.written += 1;
    } catch {
      this.dropped += 1;
    }
  }

  async close(summary: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const body = {
      runId: this.runId,
      closedAt: new Date(this.clock.now()).toISOString(),
      eventsWritten: this.written,
      eventsDropped: this.dropped,
      ...(redact(summary, this.redactOptions) as object),
    };
    writeFileSync(join(this.dir, 'summary.json'), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  }
}

/** Removes the oldest run directories so at most `keep` remain. */
export function pruneRuns(runsDir: string, keep: number): void {
  let entries: { name: string; mtime: number }[];
  try {
    entries = readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
      .map((e) => ({ name: e.name, mtime: statSync(join(runsDir, e.name)).mtimeMs }));
  } catch {
    return;
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const stale of entries.slice(Math.max(0, keep))) {
    rmSync(join(runsDir, stale.name), { recursive: true, force: true });
  }
}

/** In-memory store for tests. */
export class MemoryRunStore implements RunStore {
  readonly runId = 'run-memory';
  readonly events: EvidenceEvent[] = [];
  summary: Record<string, unknown> | undefined;
  record(event: EvidenceEvent): void {
    this.events.push(redact(event) as EvidenceEvent);
  }
  async close(summary: Record<string, unknown>): Promise<void> {
    this.summary = summary;
  }
  ofType(type: string): EvidenceEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}
