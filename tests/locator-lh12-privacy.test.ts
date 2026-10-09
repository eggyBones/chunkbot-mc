// L-H12: the retained 26.2 lease-50 O4 planner prompt flagged four frontier
// handles (frt-2016..2019) because their counter values coincide with the hidden
// owner's x (2017.5 -> window 2016..2019). These tests reproduce that exact
// failure from the retained artifact, prove the handles' producer provenance
// through the application's own digest-bound journal row and producer
// invariants, and keep every other model-visible field scanned. No world, RCON,
// provider or inference. The retained report stays failed (overall exit 1).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { sequentialIds, subjectRef, type PlannerRequest } from '../src/contracts/index.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { renderRequest } from '../src/planner/prompt.ts';
import { allSkills } from '../src/skills/index.ts';
import { frontierHandleProof, parsePlannerInput, plannerPromptBinding, privacyOracle, verifiedHistory, type ObserverSample, type PrivacyMatch } from '../scripts/lib/locator-ordinary-oracles.ts';
import { evidenceFor, fakeClient, fakeMineflayerBot } from './skill-fakes.ts';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const retained = JSON.parse(readFileSync(new URL('./fixtures/locator-lh12-privacy.json', import.meta.url), 'utf8')) as Row;
const TEXT: string = retained.prompt.text;
const AT: number = retained.prompt.atMs;
const ready = (retained.events as Row[]).filter((e) => e.type === 'connection_ready' && Date.parse(e.t) <= AT).at(-1)!;
const RUN: string = ready.run;
const history = verifiedHistory((retained.observations as Array<{ row: ObserverSample }>).map((o) => o.row), retained.ownerIdentity);
const key = (m: Pick<PrivacyMatch, 'path' | 'value' | 'reason'>) => `${m.path}|${m.value}|${m.reason}`;
const HANDLE_REASON = 'producer-proven opaque frontier handle (counter identity, not a coordinate)';
const FLAGGED = [1, 2, 3, 4].map((i) => `observation.frontiers[${i}].handle`);

/** The harness's exact privacy call for one planner prompt (sample, ready connection, history, optional journal binding). */
function scan(text: string, opts: { bind?: boolean; events?: Row[]; runId?: string; input?: Row } = {}) {
  const input = opts.input ?? parsePlannerInput(text);
  const obs = input.observation;
  const promptBinding = opts.bind === false ? undefined : plannerPromptBinding(text, obs, opts.events ?? retained.events, { runId: opts.runId ?? RUN, atMs: AT, connectionEpoch: ready.connectionEpoch });
  return { promptBinding, ...privacyOracle(input, { runId: opts.runId ?? RUN, atMs: AT, owner: retained.sample.owner, bot: retained.sample.bot, ownerIdentity: retained.ownerIdentity, connectionEpoch: ready.connectionEpoch, dimension: obs.dimension, history, journalDimension: ready.info.dimension, ...(promptBinding ? { promptBinding } : {}) }) };
}
/** A copy of the retained input with an edit, scanned with the ORIGINAL (genuine) journal binding: proves the oracle conditions themselves. */
function scanInputEdit(edit: (doc: Row) => void) {
  const doc = parsePlannerInput(TEXT);
  edit(doc);
  const promptBinding = plannerPromptBinding(TEXT, parsePlannerInput(TEXT).observation, retained.events, { runId: RUN, atMs: AT, connectionEpoch: ready.connectionEpoch });
  assert.ok(promptBinding, 'the genuine binding exists');
  return privacyOracle(doc, { runId: RUN, atMs: AT, owner: retained.sample.owner, bot: retained.sample.bot, ownerIdentity: retained.ownerIdentity, connectionEpoch: ready.connectionEpoch, dimension: doc.observation.dimension, history, promptBinding, journalDimension: ready.info.dimension });
}
const flaggedHandles = (r: { findings: PrivacyMatch[] }) => r.findings.filter((f) => FLAGGED.includes(f.path)).map((f) => f.path).sort();

describe('L-H12 retained 26.2 O4 planner prompt (lease 50, report efe14029, prompt 0003-1791490815854)', () => {
  it('the fixture is the exact retained model text and the app journal digest binds it', () => {
    assert.equal(createHash('sha256').update(TEXT).digest('hex'), retained.provenance.promptSha256);
    assert.equal(retained.provenance.promptSha256, '7c1b09a4025d37da0aa99da8aa2ddff5bcdba639509566980c2d18cea424955d');
    assert.equal(retained.provenance.reportSha256, 'efe14029db2d39087fa91b52c7d354415359da83643eea3b161c8dad1c5aa056');
    const turn = (retained.events as Row[]).find((e) => e.type === 'planner_turn_started')!;
    assert.equal(turn.promptDigest, retained.provenance.promptSha256.slice(0, 12));
    // The projected history rows prove exactly what the retained lines prove (checked at extraction too).
    assert.ok(history.length >= 1);
  });

  it('pre-fix rule set (no journal binding): exactly the four recorded findings and the 21 recorded allowed rows', () => {
    const r = scan(TEXT, { bind: false });
    assert.deepEqual(r.findings.map(key).sort(), (retained.recorded.findings as Row[]).map((f) => key(f as PrivacyMatch)).sort());
    assert.deepEqual(r.findings.map((f) => f.value).sort(), ['2016', '2017', '2018', '2019']);
    assert.deepEqual(r.allowed.map(key).sort(), (retained.recorded.allowed as Row[]).map((a) => key(a as PrivacyMatch)).sort());
  });

  it("with the application's own digest-bound journal row: the four frontier handles are producer-proven; nothing else changes", () => {
    const r = scan(TEXT);
    assert.equal(r.promptBinding?.requestId, 'req-c94ff4fe815a');
    assert.equal(r.promptBinding?.snapshotId, 'snap-6a57c1217564');
    assert.deepEqual(r.findings, []);
    const extra = r.allowed.filter((a) => a.reason === HANDLE_REASON);
    assert.deepEqual(extra.map((a) => `${a.path}=${a.value}`), FLAGGED.map((p, i) => `${p}=${2016 + i}`));
    for (const a of extra) assert.deepEqual(a.producer, { requestId: 'req-c94ff4fe815a', snapshotId: 'snap-6a57c1217564', takenAtMs: 1791490815750, subject: 'goal-ad3c5e163312', goalEpoch: 7, connectionEpoch: 1, first: 2015, count: 8 });
    // Every pre-fix allowed row is still produced with its original reason (the frontier .at points stay scanned).
    assert.deepEqual(r.allowed.filter((a) => a.reason !== HANDLE_REASON).map(key).sort(), (retained.recorded.allowed as Row[]).map((a) => key(a as PrivacyMatch)).sort());
    assert.ok(r.allowed.some((a) => /^observation\.frontiers\[\d\]\.at\.z$/.test(a.path) && a.value === '2017.5'), 'frontier coordinates are still judged as coordinates');
  });
});

describe('L-H12 binding provenance (exact text, journal row, run, scope)', () => {
  it('one changed character, a foreign run id, or a journal without this digest binds nothing: the four handles stay flagged', () => {
    const changed = TEXT.replace('"follow me"', '"follow me!"');
    assert.notEqual(changed, TEXT);
    const a = scan(changed);
    assert.equal(a.promptBinding, undefined);
    assert.deepEqual(flaggedHandles(a), FLAGGED);
    const b = scan(TEXT, { runId: 'run-000000000000' });
    assert.equal(b.promptBinding, undefined);
    assert.deepEqual(flaggedHandles(b), FLAGGED);
    const c = scan(TEXT, { events: (retained.events as Row[]).map((e) => (e.type === 'planner_turn_started' ? { ...e, promptDigest: '000000000000' } : e)) });
    assert.equal(c.promptBinding, undefined);
    assert.deepEqual(flaggedHandles(c), FLAGGED);
  });

  for (const [label, edit] of [
    ['snapshotId', (d: Row) => (d.observation.snapshotId = 'snap-000000000000')],
    ['takenAtMs', (d: Row) => (d.observation.takenAtMs += 1)],
    ['goalEpoch', (d: Row) => (d.observation.goalEpoch += 1)],
    ['connectionEpoch', (d: Row) => (d.observation.connectionEpoch += 1)],
    ['goalId', (d: Row) => (d.goal.goalId = 'goal-000000000000')],
    ['dimension', (d: Row) => (d.observation.dimension = 'the_nether')],
  ] as const) {
    it(`wrong reference (${label} differs from the bound journal row): no handle is proven`, () => {
      const r = scanInputEdit(edit);
      assert.deepEqual(flaggedHandles(r), FLAGGED, label);
      assert.ok(!r.allowed.some((a) => a.reason === HANDLE_REASON));
    });
  }
});

describe('L-H12 adversarial controls (only the exact producer-shaped handle at its own index is opaque)', () => {
  for (const bad of ['frt-02017', 'frt-2017.5', 'frt-2017 ', ' frt-2017', 'frt-2017x', 'FRT-2017', 'frt--2017', 'frt-2017-1', 'frt-1000000', 'frt-0', 'blk-2017', 'frt-2017,frt-2018']) {
    it(`malformed frontier handle ${JSON.stringify(bad)} at frontiers[2]: the whole list proves nothing; every colliding value stays flagged`, () => {
      const r = scanInputEdit((d) => (d.observation.frontiers[2].handle = bad));
      assert.ok(!r.allowed.some((a) => a.reason === HANDLE_REASON));
      for (const p of ['observation.frontiers[1].handle', 'observation.frontiers[3].handle', 'observation.frontiers[4].handle']) assert.ok(r.findings.some((f) => f.path === p), `${p}: ${JSON.stringify(r.findings)}`);
      // The malformed field itself is scanned as plain text: a standalone owner-window number in it is a finding.
      const standalone = [...bad.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g)].some((m) => [2016, 2017, 2018, 2019].includes(Math.trunc(Number(m[0]))));
      assert.equal(r.findings.some((f) => f.path === 'observation.frontiers[2].handle'), standalone, `${bad}: scanned as text`);
    });
  }

  it('a correct handle string in a wrong field is scanned like any text (direction, block handle, instruction, locator note)', () => {
    const r = scanInputEdit((d) => {
      d.observation.frontiers[1].direction = 'frt-2016';
      d.observation.blocks[0].handle = 'frt-2017';
      d.goal.ownerInstruction = 'follow me to frt-2018';
    });
    for (const p of ['observation.frontiers[1].direction', 'observation.blocks[0].handle', 'goal.ownerInstruction']) assert.ok(r.findings.some((f) => f.path === p), `${p}: ${JSON.stringify(r.findings)}`);
    // The genuine handles at their own indices remain proven (the edits are elsewhere).
    assert.equal(r.allowed.filter((a) => a.reason === HANDLE_REASON).length, 4);
  });

  it('owner coordinates elsewhere in the same prompt are still findings while the handles are proven', () => {
    const r = scanInputEdit((d) => {
      d.observation.frontiers[3].at = { x: 2017.5, y: -60, z: 1737.5 }; // the hidden owner itself, behind a proven handle
      d.observation.blockSummary = [...(d.observation.blockSummary ?? []), { key: 'note owner 2017 1737', count: 1 }];
      d.locator = { ...(d.locator ?? {}), note: 'owner near x 2018' };
    });
    assert.ok(r.findings.some((f) => f.path === 'observation.frontiers[3].at.x' && f.value === '2017.5'), JSON.stringify(r.findings));
    assert.ok(r.findings.some((f) => f.path === 'observation.frontiers[3].at.z' && f.value === '1737.5'));
    assert.ok(r.findings.some((f) => f.path.startsWith('observation.blockSummary') && f.value === '2017'));
    assert.ok(r.findings.some((f) => f.path === 'locator.note' && f.value === '2018'));
    assert.equal(r.allowed.filter((a) => a.reason === HANDLE_REASON).length, 4, 'the handle proof never covers the .at point or other fields');
  });

  for (const [label, edit] of [
    ['two handles swapped (not one consecutive run in rendered order)', (d: Row) => { const f = d.observation.frontiers; [f[1].handle, f[2].handle] = [f[2].handle, f[1].handle]; }],
    ['a counter value reused by an entity handle', (d: Row) => (d.observation.entities = [...(d.observation.entities ?? []), { handle: 'ent-2016', key: 'minecraft:cow', at: { x: 2001.5, y: -60, z: 2001.5 }, distance: 1 }])],
    ['more frontiers than the producer can emit', (d: Row) => (d.observation.frontiers = [...d.observation.frontiers, { ...d.observation.frontiers[7], handle: 'frt-2023' }])],
    ['a frontier without a point', (d: Row) => delete d.observation.frontiers[5].at],
    ['a frontier list that skips a counter value', (d: Row) => (d.observation.frontiers[7].handle = 'frt-2023')],
  ] as const) {
    it(`producer invariant broken (${label}): no handle is proven`, () => {
      const r = scanInputEdit(edit);
      assert.ok(!r.allowed.some((a) => a.reason === HANDLE_REASON), label);
      assert.ok(flaggedHandles(r).length >= 3, `${label}: ${JSON.stringify(flaggedHandles(r))}`);
    });
  }

  it('a binding whose journal row belongs to another run (or is not a planner turn) proves nothing when handed directly to frontierHandleProof', () => {
    const doc = parsePlannerInput(TEXT);
    const binding = plannerPromptBinding(TEXT, doc.observation, retained.events, { runId: RUN, atMs: AT, connectionEpoch: ready.connectionEpoch })!;
    const ctx = { runId: RUN, connectionEpoch: 1, journalDimension: 'overworld' };
    assert.ok(frontierHandleProof(doc, binding, ctx).proof, 'genuine binding');
    assert.equal(frontierHandleProof(doc, { ...binding, journal: { ...binding.journal, run: 'run-000000000000' } }, ctx).proof, undefined);
    assert.equal(frontierHandleProof(doc, { ...binding, journal: { ...binding.journal, type: 'task_round' } }, ctx).proof, undefined);
    assert.equal(frontierHandleProof(doc, undefined, ctx).proof, undefined);
  });

  it('subject identity: an admitted goal OR a preparing intent, each only when it is the bound journal row subject', () => {
    const doc = parsePlannerInput(TEXT);
    const binding = plannerPromptBinding(TEXT, doc.observation, retained.events, { runId: RUN, atMs: AT, connectionEpoch: ready.connectionEpoch })!;
    const ctx = { runId: RUN, connectionEpoch: 1, journalDimension: 'overworld' };
    // A preparing intent bound to a journal row of that intent (the shape of the retained O4 replacement prompt 0004).
    const prep = structuredClone(doc);
    prep.goal = { intentId: 'intent-4b47fbb274f8', status: 'preparing', activeGoalId: 'goal-ad3c5e163312', origin: 'owner', ownerInstruction: 'come here instead' };
    const prepJournal = { ...binding.journal, goalId: undefined, intentId: 'intent-4b47fbb274f8', generation: 8, subject: 'intent-4b47fbb274f8' };
    assert.equal(frontierHandleProof(prep, { ...binding, journal: prepJournal }, ctx).proof?.subject, 'intent-4b47fbb274f8');
    // Crossed identities prove nothing.
    assert.equal(frontierHandleProof(prep, binding, ctx).proof, undefined, 'preparing prompt vs an admitted-goal journal row');
    assert.equal(frontierHandleProof(doc, { ...binding, journal: prepJournal }, ctx).proof, undefined, 'admitted prompt vs an intent journal row');
    assert.equal(frontierHandleProof({ ...prep, goal: { ...prep.goal, intentId: 'intent-000000000000' } }, { ...binding, journal: prepJournal }, ctx).proof, undefined, 'another intent');
    assert.equal(frontierHandleProof({ ...doc, goal: { ...doc.goal, status: 'preparing' } }, binding, ctx).proof, undefined, 'status must match the identity kind');
  });

  it('the counter wrap (999999 -> 1) is the producer sequence; any other break is not', () => {
    const doc = parsePlannerInput(TEXT);
    const binding = plannerPromptBinding(TEXT, doc.observation, retained.events, { runId: RUN, atMs: AT, connectionEpoch: ready.connectionEpoch });
    const wrapped = structuredClone(doc);
    wrapped.observation.frontiers.forEach((f: Row, i: number) => (f.handle = `frt-${[999998, 999999, 1, 2, 3, 4, 5, 6][i]}`));
    assert.ok(frontierHandleProof(wrapped, binding, { runId: RUN, connectionEpoch: 1, journalDimension: 'overworld' }).proof);
    assert.equal(frontierHandleProof(wrapped, binding, { runId: RUN, connectionEpoch: 1 }).proof, undefined, 'no independent journal dimension: nothing is proven');
    wrapped.observation.frontiers[2].handle = 'frt-1000000';
    assert.equal(frontierHandleProof(wrapped, binding, { runId: RUN, connectionEpoch: 1, journalDimension: 'overworld' }).proof, undefined);
  });
});

describe('L-H12 real producer and renderer control (actual PerceptionService handles through actual renderRequest)', () => {
  it('real frontier handles are one consecutive counter run in rendered order; a collision is flagged without the journal binding and proven with it; an owner leak elsewhere is still found', () => {
    const client = fakeClient();
    const scene = fakeMineflayerBot(client, { dimension: 'overworld' });
    scene.fill(-30, -1, -30, 30, -1, 30, 'grass_block');
    const evidence = evidenceFor(client);
    try {
      const session = { bot: scene.bot, evidence, connectionEpoch: 1 } as unknown as GameSession & { connectionEpoch: number };
      const perception = new PerceptionService({ session: () => session, clock: { now: () => 5_000 }, ids: sequentialIds(), observationRadius: 16, travelRadius: 128, rays: 800 });
      perception.admitTravelAnchor(1);
      perception.take(1);
      const snapshot = perception.take(1)!;
      const numbers = snapshot.frontiers.map((f) => Number(/^frt-(\d+)$/.exec(f.handle)![1]));
      assert.ok(numbers.length >= 2, 'the real producer emitted frontiers');
      numbers.slice(1).forEach((n, i) => assert.equal(n, numbers[i]! + 1, 'consecutive counter run in rendered order'));
      const catalog = new SkillRegistry(allSkills()).catalog();
      const request: PlannerRequest = { requestId: 'req-control', subject: { kind: 'goal', goalId: 'goal-control', goalEpoch: 1 }, instruction: 'follow me', turn: 1, maxTurns: 20, catalog, observation: snapshot, knowledge: [] };
      const text = renderRequest(request, 8);
      const doc = parsePlannerInput(text);
      assert.deepEqual(doc.observation.frontiers.map((f: Row) => f.handle), snapshot.frontiers.map((f) => f.handle), 'rendered verbatim, same order');
      // A hidden owner far away whose x coincides with the SECOND handle's counter value (collision manufactured on the owner side only).
      const owner = { x: numbers[1]! + 0.5, y: 0, z: 900.5 };
      const bot = { x: snapshot.self.at.x, y: snapshot.self.at.y, z: snapshot.self.at.z };
      // Journal row exactly as the planner records it (digest = sha256(prompt).slice(0, 12)); renderer control only.
      const journal = [{ t: new Date(5_100).toISOString(), run: 'run-control', type: 'planner_turn_started', requestId: 'req-control', goalId: 'goal-control', subject: subjectRef(request.subject), goalEpoch: 1, connectionEpoch: 1, snapshotId: snapshot.id, snapshotTakenAtMs: snapshot.takenAtMs, promptDigest: createHash('sha256').update(text).digest('hex').slice(0, 12) }];
      const ctx = { runId: 'run-control', atMs: 5_200, owner, bot, ownerIdentity: retained.ownerIdentity, connectionEpoch: 1, dimension: 'overworld', history: [], journalDimension: 'overworld' };
      const unbound = privacyOracle(doc, ctx);
      assert.ok(unbound.findings.some((f) => f.path === 'observation.frontiers[1].handle'), JSON.stringify(unbound.findings));
      const promptBinding = plannerPromptBinding(text, doc.observation, journal, { runId: 'run-control', atMs: 5_200, connectionEpoch: 1 });
      assert.ok(promptBinding);
      const bound = privacyOracle(doc, { ...ctx, promptBinding });
      assert.ok(!bound.findings.some((f) => /^observation\.frontiers\[\d+\]\.handle$/.test(f.path)), JSON.stringify(bound.findings));
      assert.ok(bound.allowed.some((a) => a.path === 'observation.frontiers[1].handle' && a.reason === HANDLE_REASON));
      const leaked = parsePlannerInput(text);
      leaked.goal.ownerInstruction = `meet at ${owner.x} ${owner.z}`;
      const leak = privacyOracle(leaked, { ...ctx, promptBinding });
      assert.ok(leak.findings.some((f) => f.path === 'goal.ownerInstruction'), 'an owner coordinate elsewhere is still a finding');
    } finally {
      evidence.detach();
    }
  });
});
