// Read-only memory inspection for doctor and an operator CLI subcommand.
// Opens the configured scope WITHOUT the writer lock, temp-file cleanup or any
// write, and reports state, revision and bounded fact summaries. No world data
// beyond what memory already holds, no inference.
import type { Clock } from '../contracts/index.ts';
import { scopeKey, type MemoryConfig, type MemoryFact } from '../contracts/memory.ts';
import { isTrusted } from './book.ts';
import { MemoryFileStore, scopeDirectory } from './store.ts';

export interface MemoryReport {
  enabled: boolean;
  state: string;
  detail: string;
  scope?: string;
  revision: number;
  corruptRevisions: number[];
  facts: Array<{ id: string; category: string; label: string; source: string; status: string; location?: string; lastConfirmed: string }>;
  counts: { total: number; active: number; trusted: number; untrusted: number };
}

const at = (f: MemoryFact) => (f.location ? `${f.location.dimension} ${Math.round(f.location.at.x)},${Math.round(f.location.at.y)},${Math.round(f.location.at.z)}` : undefined);

export function inspectMemory(rootDir: string, config: MemoryConfig | undefined, clock: Clock, options: { limit?: number; includeInactive?: boolean } = {}): MemoryReport {
  if (!config || !config.enabled) return { enabled: false, state: 'disabled', detail: 'no memory world profile configured', revision: 0, corruptRevisions: [], facts: [], counts: { total: 0, active: 0, trusted: 0, untrusted: 0 } };
  const scope = { worldProfile: config.worldProfile, worldRevision: config.worldRevision, botProfile: config.botProfile };
  const store = new MemoryFileStore({ dir: scopeDirectory(rootDir, scope), scope, clock });
  const load = store.open({ readOnly: true });
  const all = load.body?.facts ?? [];
  const active = all.filter((f) => f.status === 'active');
  const shown = (options.includeInactive ? all : active).slice(-(options.limit ?? 40));
  const state = load.state === 'read_only' && load.body ? (load.corruptRevisions.length ? 'recovered' : 'ready') : load.state;
  return {
    enabled: true,
    state,
    detail: load.detail.replace(/ read-only: opened for read-only inspection/, ''),
    scope: scopeKey(scope),
    revision: load.revision,
    corruptRevisions: load.corruptRevisions,
    facts: shown.map((f) => ({ id: f.id, category: f.category, label: f.label, source: f.source, status: f.status, ...(at(f) ? { location: at(f) as string } : {}), lastConfirmed: new Date(f.lastConfirmedMs).toISOString() })),
    counts: { total: all.length, active: active.length, trusted: active.filter(isTrusted).length, untrusted: active.filter((f) => !isTrusted(f)).length },
  };
}

export function renderMemoryReport(r: MemoryReport): string[] {
  if (!r.enabled) return [`memory: disabled (${r.detail})`];
  const lines = [`memory: ${r.state} ${r.scope} rev ${r.revision}; ${r.counts.active} active (${r.counts.trusted} trusted, ${r.counts.untrusted} untrusted notes), ${r.counts.total} stored`, `memory detail: ${r.detail}`];
  if (r.corruptRevisions.length) lines.push(`memory unreadable revisions: ${r.corruptRevisions.join(', ')}`);
  for (const f of r.facts) lines.push(`  ${f.id} ${f.status} ${f.category} "${f.label}" ${f.source}${f.location ? ` @ ${f.location}` : ''} (confirmed ${f.lastConfirmed})`);
  return lines;
}
