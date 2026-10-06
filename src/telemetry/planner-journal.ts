// Bounded, redacted planner journal for one application run: goal
// interpretations, accepted/rejected proposals and revisions, questions and
// answers, usage, and final predicate evidence. Deeper/longer bounds than the
// event log so a whole proposal is legible; still redacted and size-capped.
// Never contains private reasoning (the transport never reads it), secrets, or
// anything that could resume a goal after a restart.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock, EvidenceEvent } from '../contracts/index.ts';
import { redact } from './redact.ts';

export class PlannerJournal {
  readonly path: string;
  private readonly clock: Clock;
  private written = 0;
  private dropped = 0;
  private readonly maxRecords: number;
  private readonly maxRecordChars: number;

  constructor(dir: string, clock: Clock, maxRecords = 2_000, maxRecordChars = 48_000) {
    this.path = join(dir, 'planner.jsonl');
    this.clock = clock;
    this.maxRecords = maxRecords;
    this.maxRecordChars = maxRecordChars;
    writeFileSync(this.path, '', { mode: 0o600 });
  }

  record(event: EvidenceEvent): void {
    if (this.written >= this.maxRecords) {
      this.dropped += 1;
      return;
    }
    let line = JSON.stringify({ t: new Date(this.clock.now()).toISOString(), ...(redact(event, { maxStringChars: 4_000, maxArrayItems: 64, maxDepth: 16 }) as object) });
    if (line.length > this.maxRecordChars) line = JSON.stringify({ t: new Date(this.clock.now()).toISOString(), type: event.type, truncated: true, chars: line.length, head: line.slice(0, this.maxRecordChars - 200) });
    try {
      appendFileSync(this.path, `${line}\n`);
      this.written += 1;
    } catch {
      this.dropped += 1;
    }
  }

  get stats(): { written: number; dropped: number } {
    return { written: this.written, dropped: this.dropped };
  }
}
