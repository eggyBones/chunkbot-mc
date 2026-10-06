// MB-MEM-001-C3: the COMPLETE serialized memory view (facts, notes, every fact
// and checkpoint ref, rules, omission metadata) never exceeds viewMaxChars,
// keeps the designated home, and refs are issued only for retained facts.
// Pure: MemoryBook + buildView + a fresh MemoryRefRegistry (no store, no fixture).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MEMORY_BOUNDS, type MemoryEvidence, type MemoryScope, type MemorySubject, type MemoryView } from '../src/contracts/memory.ts';
import { MemoryBook } from '../src/memory/book.ts';
import { MemoryRefRegistry } from '../src/memory/refs.ts';
import { buildView } from '../src/memory/retrieval.ts';
import { MemoryService } from '../src/memory/service.ts';
import { cleanupRoots, harness } from './memory-helpers.ts';
import { after } from 'node:test';

after(cleanupRoots);

const OW = 'minecraft:overworld';
const SCOPE: MemoryScope = { worldProfile: 'bound-world', worldRevision: 1, botProfile: 'chunkbot' };
const NOW = 1_700_000_000_000;
const long = (s: string, n: number) => (s + ' ').repeat(Math.ceil(n / (s.length + 1))).slice(0, n);
const ev = (detail: string): MemoryEvidence => ({ kind: 'skill_outcome', atMs: NOW, detail: long(detail, 200), capability: 'place_block', confirmation: 'server_packet', ownerText: long('please build the big castle wall near the river', 200) });

/** A project-heavy, worst-case book: home, 16 interrupted 64-checkpoint projects, full containers, deaths, notes. */
function heavyBook(): MemoryBook {
  const book = new MemoryBook(SCOPE, NOW);
  book.designate({ category: 'home', label: 'home', location: { dimension: OW, at: { x: 100.5, y: 64, z: -40.5 } }, evidence: { kind: 'owner_instruction', atMs: NOW, detail: long('owner designated home', 200), ownerText: 'remember this as home' }, nowMs: NOW, note: long('next to the big oak tree', 200) });
  for (let p = 0; p < 16; p += 1) {
    const goalId = `goal-proj${String(p).padStart(4, '0')}`;
    for (let c = 0; c < 64; c += 1) {
      book.addCheckpoint({ goalId, label: long(`build castle wall section ${p}`, 80), dimension: OW, checkpoint: { at: { x: 1000 + p * 10 + (c % 8), y: 64 + Math.floor(c / 8), z: 2000 - p }, from: 'minecraft:air', to: 'minecraft:polished_blackstone_brick_stairs', confirmedAtMs: NOW, capability: 'place_block' }, evidence: ev(`placed block ${c}`), nowMs: NOW });
    }
    book.addUnknownEffect(goalId, { atMs: NOW, capability: 'place_block', commandsAfterLastConfirmation: 3, detail: long('cancelled', 200) }, NOW);
    book.setProjectState(goalId, 'interrupted', ev('stopped'), NOW);
  }
  for (let i = 0; i < 12; i += 1) {
    const contents: Record<string, number> = {};
    for (let k = 0; k < 16; k += 1) contents[`minecraft:${long(`item_kind_${k}`, 40).replace(/ /g, '_')}_${k}`] = 64;
    book.recordWorldFact({ category: 'container', source: 'verified_skill', key: 'minecraft:chest', label: 'chest', location: { dimension: OW, at: { x: 50 + i, y: 64, z: 50 } }, container: { block: 'minecraft:chest', contents, observedAtMs: NOW, via: 'inspect_container' }, evidence: ev('inspected chest'), nowMs: NOW });
  }
  for (let d = 0; d < 3; d += 1) {
    book.addDeath({ location: { dimension: OW, at: { x: 300 + d, y: 12, z: 300 } }, death: { occurredAtMs: NOW, accuracy: 'client_position_at_death_event', cause: { kind: 'unknown', detail: long('no cause', 200) }, lastAliveInventory: { source: 'server_sync', capturedAtMs: NOW, ageMsAtDeath: 5_000, items: Array.from({ length: 30 }, (_, i) => ({ key: `minecraft:item_${i}`, count: 64 })) } }, evidence: { kind: 'lifecycle', atMs: NOW, detail: long('own death', 200) }, nowMs: NOW });
  }
  for (let n = 0; n < 8; n += 1) book.note({ label: `castle idea ${n}`, text: long('build the castle wall taller near the river', 200), evidence: { kind: 'planner_note', atMs: NOW, detail: long('note', 200) }, nowMs: NOW });
  return book;
}

function view(book: MemoryBook, refs: MemoryRefRegistry, subject: MemorySubject): MemoryView {
  return buildView(
    { subject, requestId: 'req-bound01', instruction: 'finish building the castle wall near the river and check the chest', observation: { dimension: OW, self: { at: { x: 1000, y: 64, z: 2000 } }, connectionEpoch: 3 } },
    { state: 'ready', detail: 'loaded revision 9', usable: true, scope: SCOPE, facts: book.facts(), nowMs: NOW + 60_000, staleAfterMs: 86_400_000, refs },
  );
}

const shownRefs = (v: MemoryView) => [...v.facts.flatMap((f) => [f.ref ?? f.prepRef, ...(f.project?.recent ?? []).map((c) => c.ref ?? c.prepRef)])].filter((x): x is string => Boolean(x));

describe('memory view bound (MB-MEM-001-C3)', () => {
  it('an executable, project-heavy view serializes COMPLETE within viewMaxChars, keeps home, and issues refs only for shown facts', () => {
    const book = heavyBook();
    const refs = new MemoryRefRegistry('abc123');
    const v = view(book, refs, { kind: 'goal', goalId: 'goal-bound01', goalEpoch: 7 });
    const chars = JSON.stringify(v).length;
    assert.ok(chars <= MEMORY_BOUNDS.viewMaxChars, `serialized ${chars} > ${MEMORY_BOUNDS.viewMaxChars}`);
    assert.ok(v.facts.length + v.notes.length <= MEMORY_BOUNDS.retrieveFacts);
    assert.ok(v.facts.some((f) => f.category === 'home'), 'designated home retained');
    assert.ok(v.facts.length >= 2, 'more than the home fits');
    assert.ok(v.omitted.count > 0 && /bounded to 8000 characters/.test(v.omitted.reason), v.omitted.reason);
    const ids = shownRefs(v);
    assert.ok(ids.length > 0 && ids.some((id) => v.facts.some((f) => f.project?.recent.some((c) => c.ref === id))), 'checkpoint refs are part of the bounded view');
    assert.equal(refs.size, ids.length, 'every issued ref is shown; none issued for dropped facts');
    for (const id of ids) assert.ok(!('error' in refs.resolve(id, { goalEpoch: 7, goalId: 'goal-bound01', connectionEpoch: 3, dimension: OW }, (x) => book.get(x))), id);
  });

  it('a preparation view obeys the same exact bound with prepared refs only', () => {
    const book = heavyBook();
    const refs = new MemoryRefRegistry('def456');
    const v = view(book, refs, { kind: 'preparation', intentId: 'intent-bound01', generation: 2, connectionEpoch: 3, activeGoalId: null });
    const chars = JSON.stringify(v).length;
    assert.ok(chars <= MEMORY_BOUNDS.viewMaxChars, `serialized ${chars} > ${MEMORY_BOUNDS.viewMaxChars}`);
    assert.ok(v.facts.some((f) => f.category === 'home'));
    assert.ok(v.facts.every((f) => !f.ref && (f.project?.recent ?? []).every((c) => !c.ref)), 'no executable refs');
    const ids = shownRefs(v);
    assert.ok(ids.length > 0 && ids.every((id) => id.startsWith('mprep-')));
    assert.equal(refs.size, ids.length);
    assert.equal(refs.shownPrepared({ intentId: 'intent-bound01', generation: 2 }).size, ids.length);
  });

  it('the bound holds for every smaller cap and ref ids at their longest generated length', () => {
    const book = heavyBook();
    for (const maxChars of [2_500, 4_000, 6_000, 8_000]) {
      const refs = new MemoryRefRegistry('zzzzzz');
      const v = buildView(
        { subject: { kind: 'goal', goalId: 'goal-bound02', goalEpoch: 8 }, requestId: 'req-bound02', instruction: 'go home and finish the castle wall', observation: { dimension: OW, self: { at: { x: 100, y: 64, z: -40 } }, connectionEpoch: 3 } },
        { state: 'ready', detail: 'x', usable: true, scope: SCOPE, facts: book.facts(), nowMs: NOW, staleAfterMs: 86_400_000, refs, maxChars },
      );
      assert.ok(JSON.stringify(v).length <= maxChars, `cap ${maxChars}: ${JSON.stringify(v).length}`);
      assert.ok(v.facts.some((f) => f.category === 'home'), `cap ${maxChars}: home kept`);
      assert.equal(refs.size, shownRefs(v).length, `cap ${maxChars}: refs only for shown facts`);
    }
  });

  it('MemoryService records a whitelisted memory_view event (counts and sizes only)', async () => {
    const h = harness();
    h.memory.beginGoal({ goalId: 'goal-0001', epoch: 1, instruction: 'remember this as home' });
    await h.memory.designate({ goalId: 'goal-0001', category: 'home', label: 'home', location: { dimension: OW, at: { x: 1, y: 2, z: 3 } }, basis: 'x' });
    const v = h.memory.view({ subject: { kind: 'goal', goalId: 'goal-0002', goalEpoch: 2 }, requestId: 'req-0002', instruction: 'go home secret words', observation: { dimension: OW, self: { at: { x: 0, y: 0, z: 0 } }, connectionEpoch: 1 } });
    const e = h.events.filter((x) => x['type'] === 'memory_view').at(-1);
    assert.deepEqual(Object.keys(e ?? {}).sort(), ['facts', 'historicalContainers', 'notes', 'requestId', 'serializedChars', 'shownRefs', 'subjectId', 'subjectKind', 'type']);
    assert.equal(e?.['serializedChars'], JSON.stringify(v).length);
    assert.equal(e?.['shownRefs'], 1);
    assert.ok(!JSON.stringify(e).includes('secret'), 'no owner words or request text');
    assert.ok(MemoryService);
    await h.memory.close();
  });
});
