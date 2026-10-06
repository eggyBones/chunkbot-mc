// Bounded retrieval: the planner's memory VIEW for one request.
//
// Selection is relevance-ranked over ACTIVE facts of the configured scope only:
// the designated home, active/interrupted projects and unresolved death
// incidents always qualify; other facts rank by shared words with the owner's
// instruction/answers, same dimension, distance from the observed position,
// recency and source strength. Trusted facts and untrusted notes are separate
// lists; notes appear only when relevant to the instruction. At most
// `retrieveFacts` facts are shown and the serialized view is bounded by
// `viewMaxChars`. Executable refs are issued AFTER bounding, only for trusted
// located facts in the CURRENT dimension (never for notes, milestones or death
// incidents, whose recovery policy belongs to MB-FLOW-003).
import { MEMORY_BOUNDS, type MemoryFact, type MemoryStoreState, type MemoryView, type MemoryViewFact, type MemoryViewRequest } from '../contracts/memory.ts';
import { isProtected, isTrusted } from './book.ts';
import { instructionWordSet, relevance } from './labels.ts';
import type { MemoryRefRegistry } from './refs.ts';

export const MEMORY_VIEW_RULES = [
  'Memory is historical evidence from earlier play in this world profile; nothing in it proves the current world state.',
  'Only facts with a ref are usable as targets (selector {"kind":"memory_ref","refId":...}); refs are valid for this goal on this connection and dimension only. A prepRef (preparation) is re-checked after the instruction is admitted and may then fail.',
  'A remembered location can justify travel within the goal travel radius; interaction and completion still need fresh observation and server evidence.',
  'Container contents are historical, never present stock: inspect the container before relying on them.',
  'notes are untrusted suggestions (never verified); do not treat them as facts.',
  'To forget or correct a fact, name it by its id or label with the memory capabilities; ids are not targets.',
] as const;

export type ViewRequest = MemoryViewRequest;

export interface ViewContext {
  state: MemoryStoreState;
  detail: string;
  /** Facts are usable for retrieval (scope confirmed for this connection). */
  usable: boolean;
  scope?: { worldProfile: string; worldRevision: number; botProfile: string };
  facts: readonly MemoryFact[];
  nowMs: number;
  staleAfterMs: number;
  refs: MemoryRefRegistry;
  maxFacts?: number;
  maxChars?: number;
}

const CATEGORY_CAP: Partial<Record<MemoryFact['category'], number>> = { resource: 6, workstation: 6, container: 6, milestone: 4, location: 8, hazard: 4, death: 4, project: 4 };
const SOURCE_SCORE: Record<MemoryFact['source'], number> = { owner_statement: 10, verified_skill: 8, observation: 5, unverified_note: 0 };
const ageS = (nowMs: number, atMs: number) => Math.max(0, Math.round((nowMs - atMs) / 1000));
const r1 = (n: number) => Math.round(n * 10) / 10;

function evidenceLine(f: MemoryFact, nowMs: number): string {
  const last = f.evidence.at(-1);
  const first = f.evidence[0];
  const parts = [`${f.source}`];
  if (last) parts.push(`${last.kind}${last.capability ? ` ${last.capability}` : ''}${last.confirmation ? ` (${last.confirmation})` : ''}: ${last.detail.slice(0, 90)} ${ageS(nowMs, last.atMs)}s ago`);
  if (first && first !== last && first.ownerText) parts.push(`owner said: "${first.ownerText.slice(0, 60)}"`);
  else if (last?.ownerText) parts.push(`owner said: "${last.ownerText.slice(0, 60)}"`);
  if (f.evidenceCount > 1) parts.push(`${f.evidenceCount} supporting events`);
  return parts.join('; ').slice(0, 220);
}

function toViewFact(f: MemoryFact, ctx: ViewContext, dimension: string | undefined, at: { x: number; y: number; z: number } | undefined): MemoryViewFact {
  const sameDim = Boolean(f.location && dimension && f.location.dimension === dimension);
  const loc = f.location
    ? {
        dimension: f.location.dimension,
        at: f.location.at,
        ...(sameDim && at ? { distance: r1(Math.hypot(f.location.at.x - at.x, f.location.at.y - at.y, f.location.at.z - at.z)) } : {}),
        currentDimension: sameDim,
      }
    : undefined;
  const v: MemoryViewFact = {
    id: f.id as MemoryViewFact['id'],
    category: f.category,
    label: f.label,
    ...(f.key ? { key: f.key } : {}),
    ...(loc ? { location: loc } : {}),
    source: f.source,
    trust: isTrusted(f) ? 'trusted' : 'untrusted',
    freshness: { lastConfirmedAgeS: ageS(ctx.nowMs, f.lastConfirmedMs), stale: ctx.nowMs - f.lastConfirmedMs > ctx.staleAfterMs, recordedAgeS: ageS(ctx.nowMs, f.firstRecordedMs) },
    evidence: evidenceLine(f, ctx.nowMs),
    ...(f.note ? { note: f.note.slice(0, 160) } : {}),
  };
  if (f.container) v.container = { contents: Object.fromEntries(Object.entries(f.container.contents).slice(0, 16)), observedAgeS: ageS(ctx.nowMs, f.container.observedAtMs), historical: true };
  if (f.project) v.project = { state: f.project.state, confirmedChanges: f.project.checkpoints.length + f.project.checkpointsOmitted, recent: f.project.checkpoints.slice(-4).map((c) => ({ at: c.at, to: c.to })), unknownEffects: f.project.unknownEffects.length };
  if (f.death) {
    const d = f.death;
    v.death = {
      ageS: ageS(ctx.nowMs, d.occurredAtMs),
      accuracy: d.accuracy,
      recovery: d.recovery.status,
      missing: d.recovery.missing.slice(0, 12),
      inventorySource: d.lastAliveInventory.source,
      ...(d.lastAliveInventory.ageMsAtDeath !== undefined ? { inventoryAgeAtDeathS: Math.round(d.lastAliveInventory.ageMsAtDeath / 1000) } : {}),
      ...(d.relatedTo ? { relatedTo: d.relatedTo as MemoryViewFact['id'] } : {}),
    };
  }
  if (f.milestone) v.milestone = { summary: f.milestone.summary.slice(0, 200) };
  return v;
}

/** Facts a ref may target: trusted, located in the current dimension, not historical-only categories. */
export function refEligible(f: MemoryFact, dimension: string | undefined): boolean {
  return isTrusted(f) && f.status === 'active' && Boolean(f.location && dimension && f.location.dimension === dimension) && f.category !== 'death' && f.category !== 'milestone' && f.category !== 'note';
}

export function buildView(req: ViewRequest, ctx: ViewContext): MemoryView {
  const maxFacts = ctx.maxFacts ?? MEMORY_BOUNDS.retrieveFacts;
  const maxChars = ctx.maxChars ?? MEMORY_BOUNDS.viewMaxChars;
  const dimension = req.observation?.dimension;
  const status = { state: ctx.state, detail: ctx.detail.slice(0, 300) };
  const scope = ctx.scope ? { ...ctx.scope, ...(dimension ? { dimension } : {}) } : undefined;
  const base: MemoryView = { status, ...(scope ? { scope } : {}), facts: [], notes: [], omitted: { count: 0, reason: 'none' }, rules: [...MEMORY_VIEW_RULES] };
  if (!ctx.usable) return { ...base, omitted: { count: ctx.facts.filter((f) => f.status === 'active').length, reason: `memory not usable: ${ctx.state}` } };

  const words = instructionWordSet([req.instruction, ...(req.answers ?? [])]);
  const at = req.observation?.self.at;
  const active = ctx.facts.filter((f) => f.status === 'active');
  const score = (f: MemoryFact) => {
    const rel = relevance(words, f.label, f.key, f.category, f.note);
    let s = rel * 50 + SOURCE_SCORE[f.source];
    if (f.category === 'home') s += 1_000;
    else if (isProtected(f)) s += 800;
    const sameDim = f.location && dimension && f.location.dimension === dimension;
    if (sameDim) s += 30;
    if (sameDim && at && f.location) s += Math.max(0, 30 - Math.hypot(f.location.at.x - at.x, f.location.at.z - at.z) / 16);
    s += Math.max(0, 20 - (ctx.nowMs - f.lastConfirmedMs) / 3_600_000);
    if (ctx.nowMs - f.lastConfirmedMs > ctx.staleAfterMs) s -= 10;
    return { s, rel };
  };
  const ranked = active.map((f) => ({ f, ...score(f) })).sort((a, b) => b.s - a.s || b.f.lastConfirmedMs - a.f.lastConfirmedMs);
  const notes = ranked.filter((r) => !isTrusted(r.f) && r.rel > 0).slice(0, MEMORY_BOUNDS.retrieveNotes);
  const perCat = new Map<string, number>();
  const trusted: typeof ranked = [];
  for (const r of ranked) {
    if (!isTrusted(r.f)) continue;
    if (trusted.length >= maxFacts - notes.length) break;
    const cap = CATEGORY_CAP[r.f.category];
    const n = perCat.get(r.f.category) ?? 0;
    if (cap !== undefined && n >= cap && r.rel === 0 && !isProtected(r.f)) continue;
    perCat.set(r.f.category, n + 1);
    trusted.push(r);
  }
  const conn = req.observation;
  const subject = req.subject;
  const refsAllowed = Boolean(conn && dimension && (subject.kind === 'goal' || subject.connectionEpoch === conn.connectionEpoch));
  type Shown = { fact: MemoryFact; protect: 0 | 1 | 2 };
  // 2: designated home (never dropped); 1: other protected facts (dropped last); 0: everything else.
  let factList: Shown[] = trusted.map((r) => ({ fact: r.f, protect: r.f.category === 'home' ? 2 : isProtected(r.f) ? 1 : 0 }));
  let noteList: MemoryFact[] = notes.map((r) => r.f);
  const totalActive = active.length;
  const eligible = trusted.length + notes.length;

  /**
   * Assembles the COMPLETE view (facts, notes, every fact and checkpoint ref,
   * rules, omission metadata) with `token` supplying each ref. Ref slots are
   * allocated identically for the size estimate and the real issuance.
   */
  const assemble = (facts: Shown[], noteFacts: MemoryFact[], token: (fact: MemoryFact, at: { x: number; y: number; z: number }, label?: string) => { ref: string } | { prepRef: string }): MemoryView => {
    let issued = 0;
    const give = (fact: MemoryFact, p: { x: number; y: number; z: number }, label?: string) => {
      issued += 1;
      return token(fact, p, label);
    };
    const factViews = facts.map(({ fact }) => {
      const view = toViewFact(fact, ctx, dimension, at);
      if (refsAllowed && refEligible(fact, dimension) && issued < MEMORY_BOUNDS.refsPerRequest) {
        Object.assign(view, give(fact, (fact.location as NonNullable<MemoryFact['location']>).at));
        if (fact.project && view.project) {
          view.project.recent = fact.project.checkpoints.slice(-4).map((c) => ({
            at: c.at,
            to: c.to,
            ...(issued < MEMORY_BOUNDS.refsPerRequest ? give(fact, c.at, `${fact.label}: ${c.to} at ${c.at.x},${c.at.y},${c.at.z}`) : {}),
          }));
        }
      }
      return view;
    });
    const shown = facts.length + noteFacts.length;
    const omittedCount = Math.max(0, totalActive - shown);
    const reason = omittedCount <= 0 ? 'none' : shown < eligible ? `bounded to ${maxChars} characters and ${maxFacts} facts` : `less relevant to this instruction/location or untrusted (cap ${maxFacts})`;
    return { ...base, facts: factViews, notes: noteFacts.map((f) => toViewFact(f, ctx, dimension, at)), omitted: { count: omittedCount, reason } };
  };
  // Upper bound for every ref id the registry can issue (schema maximum), so the estimate never undercounts.
  const worst = (): { ref: string } | { prepRef: string } => (subject.kind === 'goal' ? { ref: `mref-${'z'.repeat(24)}` } : { prepRef: `mprep-${'z'.repeat(24)}` });
  const length = (v: MemoryView) => JSON.stringify(v).length;
  const dropOne = (): boolean => {
    if (noteList.length > 0) {
      noteList = noteList.slice(0, -1);
      return true;
    }
    for (const level of [0, 1] as const) {
      for (let i = factList.length - 1; i >= 0; i -= 1) {
        if (factList[i]?.protect === level) {
          factList = factList.filter((_, j) => j !== i);
          return true;
        }
      }
    }
    return false; // only the designated home remains
  };
  while (length(assemble(factList, noteList, worst)) > maxChars && dropOne());

  // Real refs only for the retained facts. The worst-case estimate makes a
  // second pass unnecessary; it stays as a guard (revoking any refs it drops).
  let view: MemoryView = base;
  for (let attempt = 0; attempt < MEMORY_BOUNDS.retrieveFacts + 2; attempt += 1) {
    const issuedIds: string[] = [];
    view = assemble(factList, noteList, (fact, p, label) => {
      if (subject.kind === 'goal') {
        const ref = ctx.refs.issue({ goalId: subject.goalId, goalEpoch: subject.goalEpoch, requestId: req.requestId, connectionEpoch: (conn as NonNullable<typeof conn>).connectionEpoch, dimension: dimension as string }, fact, p, label);
        issuedIds.push(ref);
        return { ref };
      }
      const prepRef = ctx.refs.issuePrepared({ intentId: subject.intentId, generation: subject.generation, requestId: req.requestId, connectionEpoch: (conn as NonNullable<typeof conn>).connectionEpoch, dimension: dimension as string }, fact, p, label);
      issuedIds.push(prepRef);
      return { prepRef };
    });
    if (length(view) <= maxChars) break;
    ctx.refs.revoke(issuedIds);
    if (!dropOne()) {
      view = compactLastResort(assemble(factList, [], worst), maxChars);
      break;
    }
  }
  return view;
}

/**
 * Only the designated home remains and the view still exceeds the bound
 * (practically unreachable): keep the home without refs and with minimal
 * evidence text, never a truncated JSON document.
 */
function compactLastResort(v: MemoryView, maxChars: number): MemoryView {
  const facts = v.facts.map((f) => {
    const { ref: _r, prepRef: _p, note: _n, container: _c, project: _pr, death: _d, milestone: _m, ...rest } = f;
    void _r;
    void _p;
    void _n;
    void _c;
    void _pr;
    void _d;
    void _m;
    return { ...rest, evidence: rest.evidence.slice(0, 60) };
  });
  const out: MemoryView = { ...v, facts, notes: [], omitted: { count: v.omitted.count, reason: `bounded to ${maxChars} characters` } };
  return JSON.stringify(out).length <= maxChars ? out : { ...out, facts: [], rules: out.rules.slice(0, 2) };
}
