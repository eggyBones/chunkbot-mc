// MB-FLOW-003-C9 (offline, real SurvivalService + real atomic store): a
// server-confirmed pickup that regains a whole manifest key must persist.
// Reproduces the leased trial batch002-2472442 failure ("invalid survival
// body: Too small: expected number to be >0" right after cobblestone x20 was
// collected), then proves durable full pickup, durable partial pickup, budget
// retention and an actual reload from disk.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { ManifestItemSchema, SurvivalStoreBodySchema, type SurvivalProposal } from '../src/contracts/survival.ts';
import { checksum, survivalScopeDirectory } from '../src/survival/store.ts';
import { NOW0, OW, assessInput, cleanupRoots, dieWithItems, harness, respawnFresh, sampleEpisode, settle, slot, tempRoot, type Harness } from './survival-helpers.ts';

after(cleanupRoots);

const SCOPE = { worldProfile: 'test-world', worldRevision: 1, botProfile: 'chunkbot' };
const OWNER = { goalId: 'goal-c9pick', goalEpoch: 5, connectionEpoch: 1 };
/** The trial kit: damaged pickaxe, bread 4, cobblestone 20, enchanted sword. */
const SWORD = slot('diamond_sword', 1, [{ type: 'enchantments', data: { levels: [{ id: 13, level: 3 }] } }]);
const KIT = { 36: slot('iron_pickaxe', 1, [{ type: 'damage', data: 200 }]), 37: slot('bread', 4), 38: slot('cobblestone', 20), 39: SWORD };

async function admittedRecovery(h: Harness): Promise<SurvivalProposal> {
  h.packets.inventory(KIT);
  h.packets.health(20, 20);
  dieWithItems(h, KIT, 'death.attack.genericKill');
  h.service.linkIncident(h.service.deathContext().captureId as string, 'mf-0001');
  respawnFresh(h, {}, { dimensionName: OW, location: { x: 30, y: 64, z: 10 } });
  await settle(h);
  const d = h.service.assess(assessInput(h));
  assert.equal(d.kind, 'propose', JSON.stringify(d));
  const p = (d as { proposal: SurvivalProposal }).proposal;
  h.service.onSupportAdmitted({ proposalId: p.proposalId, goalId: OWNER.goalId, goalEpoch: OWNER.goalEpoch, connectionEpoch: 1, admittedAtMs: h.clock.now() });
  await settle(h);
  assert.equal(h.service.durability(), 'durable');
  return p;
}

function latestOnDisk(root: string): { revision: number; body: unknown } {
  const dir = survivalScopeDirectory(root, SCOPE);
  const files = readdirSync(dir).filter((n) => /^survival-\d{8}\.json$/.test(n)).sort();
  const file = JSON.parse(readFileSync(`${dir}/${files.at(-1)}`, 'utf8')) as { revision: number; body: unknown };
  return file;
}

describe('post-collection persistence (C9)', () => {
  it('regaining a WHOLE manifest key (cobblestone 20/20) writes a valid durable revision', async () => {
    const h = harness({ pid: 7101 });
    await admittedRecovery(h);
    const counted = h.service.recordRegain(OWNER, 'minecraft:cobblestone', 20, 'act-c9-1', { metadata: 'server_slot', digest: '0123456789abcdef' });
    assert.equal(counted, 20);
    await settle(h);
    const failures = h.events.filter((e) => e['type'] === 'survival_write_failed');
    assert.deepEqual(failures, [], `no write may fail after a full-key regain: ${JSON.stringify(failures)}`);
    assert.equal(h.service.durability(), 'durable');
    // Authority continues for the remaining items (the trial revoked it as attempt_write_failed).
    const t = h.service.recoveryTarget({ goalEpoch: OWNER.goalEpoch, connectionEpoch: 1, dimension: OW });
    assert.ok(!('error' in t), JSON.stringify(t));
    assert.deepEqual([...t.sought.entries()].sort(), [['minecraft:bread', 4], ['minecraft:diamond_sword', 1], ['minecraft:iron_pickaxe', 1]]);
    // The durable body itself validates and keeps the ORIGINAL lost count separate from the regain.
    const disk = latestOnDisk(h.root);
    const body = SurvivalStoreBodySchema.parse(disk.body);
    const cobble = body.episodes[0]?.manifest?.missing.find((m) => m.key === 'minecraft:cobblestone');
    assert.equal(cobble?.count, 20, 'the lost count is immutable');
    assert.equal(cobble?.regained, 20, 'regained is recorded separately');
    assert.equal(cobble?.state, 'regained');
    await h.service.close();
  });

  it('partial then full regain of one key, attempt + budgets survive an actual reload', async () => {
    const h = harness({ pid: 7102 });
    const p = await admittedRecovery(h);
    assert.equal(h.service.recordRegain(OWNER, 'minecraft:bread', 3, 'act-c9-2'), 3);
    await settle(h);
    assert.equal(h.service.recordRegain(OWNER, 'minecraft:bread', 5, 'act-c9-3'), 1, 'only the still-missing bread is counted (never more than lost)');
    await settle(h);
    h.service.onSupportTerminal({ proposalId: p.proposalId, goalId: OWNER.goalId, goalEpoch: OWNER.goalEpoch, state: 'blocked', reason: 'no_progress', detail: 'x', counters: { plannerTurns: 3, tasksAdmitted: 2, replans: 1 }, endedAtMs: h.clock.now() + 5_000 });
    await settle(h);
    assert.equal(h.events.filter((e) => e['type'] === 'survival_write_failed').length, 0);
    await h.service.close();
    // Actual reload from disk (new process stand-in, same scope/root).
    const h2 = harness({ root: h.root, pid: 7103 });
    const st = h2.service.status(h2.clock.now());
    assert.equal(st.store.state, 'ready', st.store.detail);
    const inc = st.incidents[0];
    assert.ok(inc);
    assert.equal(inc.status, 'partially_recovered');
    assert.deepEqual(inc.attempts, { used: 1, max: 2 }, 'the counted attempt persisted');
    assert.equal(inc.budget.plannerTurns, 3);
    assert.equal(inc.budget.tasks, 2);
    assert.equal(inc.budget.replans, 1);
    assert.equal(inc.regained.reduce((n, r) => n + r.count, 0), 4);
    const bread = inc.missing.find((m) => m.key === 'minecraft:bread');
    assert.equal(bread, undefined, 'fully regained bread is not listed as missing');
    assert.deepEqual(
      inc.missing.map((m) => [m.key, m.count, m.state]).sort(),
      [
        ['minecraft:cobblestone', 20, 'missing'],
        ['minecraft:diamond_sword', 1, 'missing'],
        ['minecraft:iron_pickaxe', 1, 'missing'],
      ],
    );
    await h2.service.close();
  });

  it('every episode-book mutation of a whole recovery keeps the durable body schema-valid', async () => {
    const h = harness({ pid: 7104 });
    const p = await admittedRecovery(h);
    for (const [key, n] of [['minecraft:iron_pickaxe', 1], ['minecraft:bread', 4], ['minecraft:cobblestone', 20]] as const) {
      h.service.recordRegain(OWNER, key, n, `act-${key}`);
      await settle(h);
    }
    // The valuable sword counts only with its exact server identity.
    const lost = h.service.tracker.latest()?.lastAlive.stacks.find((s) => s.key === 'minecraft:diamond_sword');
    assert.ok(lost?.meta.digest);
    assert.equal(h.service.recordRegain(OWNER, 'minecraft:diamond_sword', 1, 'act-sword-wrong', { metadata: 'server_slot', digest: 'ffffffffffffffff' }), 0);
    assert.equal(h.service.recordRegain(OWNER, 'minecraft:diamond_sword', 1, 'act-sword', lost.meta), 1);
    await settle(h);
    h.service.onSupportTerminal({ proposalId: p.proposalId, goalId: OWNER.goalId, goalEpoch: OWNER.goalEpoch, state: 'completed', reason: 'outcome_verified', detail: 'x', counters: { plannerTurns: 2, tasksAdmitted: 4, replans: 0 }, endedAtMs: h.clock.now() });
    await settle(h);
    assert.equal(h.events.filter((e) => e['type'] === 'survival_write_failed').length, 0);
    const body = SurvivalStoreBodySchema.parse(latestOnDisk(h.root).body);
    const e = body.episodes[0];
    assert.equal(e?.status, 'recovered');
    assert.ok(e?.manifest?.missing.every((m) => m.state === 'regained' && m.regained === m.count));
    await h.service.close();
  });

  it('v1 migration: lost = v1 remaining + recorded regains; sought, partial, regained and unknown records stay truthful; next write is v2', async () => {
    const root = tempRoot();
    const dir = survivalScopeDirectory(root, SCOPE);
    mkdirSync(dir, { recursive: true });
    const item = (key: string, count: number, state: string) => ({ key, count, valuable: false, metadata: 'server_slot', state });
    const v1Episode = {
      ...sampleEpisode({ phase: 'ready', status: 'partially_recovered', site: { source: 'server_death_location', dimension: 'overworld', at: { x: 30.5, y: 64, z: 10.5 }, observedAtMs: NOW0 } }),
      manifest: {
        assessedAtMs: NOW0,
        freshInventorySource: 'server_packets',
        lastAliveSource: 'server_packets',
        // v1 semantics: `count` is what was STILL missing (regains had been subtracted).
        missing: [item('minecraft:bread', 3, 'missing'), item('minecraft:cobblestone', 20, 'missing'), item('minecraft:iron_pickaxe', 1, 'regained'), item('minecraft:oak_log', 2, 'unknown')],
        retained: [],
        partial: false,
        detail: 'v1',
      },
      regained: [
        { key: 'minecraft:bread', count: 1, atMs: NOW0, provenance: 'scoped_visible_drop' },
        { key: 'minecraft:iron_pickaxe', count: 1, atMs: NOW0, provenance: 'scoped_visible_drop' },
        { key: 'minecraft:oak_log', count: 1, atMs: NOW0, provenance: 'scoped_visible_drop' },
      ],
    } as Record<string, unknown>;
    delete v1Episode['incidental'];
    const body = { scope: SCOPE, createdAtMs: NOW0, episodes: [v1Episode], interrupted: [], nextEpisode: 2, evicted: 0 };
    // The checksum covers the raw v1 body exactly as written (no v2 defaults).
    writeFileSync(`${dir}/survival-00000001.json`, JSON.stringify({ format: 'chunkbot-survival', schemaVersion: 1, revision: 1, writtenAtMs: NOW0, checksum: checksum(body), body }));
    const h = harness({ root, pid: 7105 });
    const st = h.service.status(h.clock.now());
    assert.equal(st.store.state, 'ready', st.store.detail);
    assert.match(st.store.detail, /schema v1 migrated to v2/);
    const row = (key: string) => {
      const m = st.incidents[0]?.missing.find((x) => x.key === key);
      return m ? [m.lost, m.regained, m.count, m.state] : undefined;
    };
    assert.deepEqual(row('minecraft:bread'), [4, 1, 3, 'partially_regained'], 'partial: original lost reconstructed from the recorded regain, 3 still sought');
    assert.deepEqual(row('minecraft:cobblestone'), [20, 0, 20, 'missing'], 'sought: unchanged');
    assert.equal(row('minecraft:iron_pickaxe'), undefined, 'already regained: not missing (lost 1, regained 1)');
    assert.deepEqual(row('minecraft:oak_log'), [3, 1, 2, 'unknown'], 'unknown keeps its remainder; not re-sought');
    assert.equal(st.incidents[0]?.regained.reduce((n, r) => n + r.count, 0), 3, 'recorded regains kept; none invented');
    // The planner proposal/missing quantities use the REMAINING amounts only.
    h.packets.inventory({});
    h.packets.health(20, 20);
    await settle(h);
    const d = h.service.assess(assessInput(h));
    assert.equal(d.kind, 'propose', JSON.stringify(d));
    const p = (d as { proposal: SurvivalProposal }).proposal;
    const facts = p.execution.kind === 'planner_goal' ? p.execution.context.facts.join(' | ') : '';
    assert.match(facts, /still sought [^|]*: 3 bread, 20 cobblestone \|/);
    assert.doesNotMatch(facts, /iron_pickaxe|oak_log|4 bread/);
    h.service.abandonRecovery('test write', h.clock.now());
    await settle(h);
    assert.equal(h.events.filter((e) => e['type'] === 'survival_write_failed').length, 0, 'the migrated body writes as valid v2');
    const file = JSON.parse(readFileSync(`${dir}/${readdirSync(dir).filter((n) => /^survival-\d{8}\.json$/.test(n)).sort().at(-1)}`, 'utf8')) as { schemaVersion: number; body: unknown };
    assert.equal(file.schemaVersion, 2);
    SurvivalStoreBodySchema.parse(file.body);
    await h.service.close();
  });

  it('old revisions load: a corrupt or tampered newest revision falls back to the last verified v1 revision (never replaced)', async () => {
    const root = tempRoot();
    const dir = survivalScopeDirectory(root, SCOPE);
    mkdirSync(dir, { recursive: true });
    const ep = { ...sampleEpisode({ phase: 'ready' }), manifest: { assessedAtMs: NOW0, freshInventorySource: 'server_packets', lastAliveSource: 'server_packets', missing: [{ key: 'minecraft:bread', count: 2, valuable: false, metadata: 'server_slot', state: 'missing' }], retained: [], partial: false, detail: 'v1' } } as Record<string, unknown>;
    delete ep['incidental'];
    const body = { scope: SCOPE, createdAtMs: NOW0, episodes: [ep], interrupted: [], nextEpisode: 2, evicted: 0 };
    writeFileSync(`${dir}/survival-00000001.json`, JSON.stringify({ format: 'chunkbot-survival', schemaVersion: 1, revision: 1, writtenAtMs: NOW0, checksum: checksum(body), body }));
    // Newest revision tampered after its checksum was computed (raw-body verification must reject it).
    const tampered = structuredClone(body) as typeof body;
    ((tampered.episodes[0] as { manifest: { missing: Array<{ count: number }> } }).manifest.missing[0] as { count: number }).count = 64;
    writeFileSync(`${dir}/survival-00000002.json`, JSON.stringify({ format: 'chunkbot-survival', schemaVersion: 1, revision: 2, writtenAtMs: NOW0, checksum: checksum(body), body: tampered }));
    const h = harness({ root, pid: 7109 });
    const st = h.service.status(h.clock.now());
    assert.equal(st.store.state, 'recovered', st.store.detail);
    assert.match(st.store.detail, /loaded revision 1 \(schema v1 migrated to v2.*newer unreadable revision\(s\) 2/);
    assert.equal(st.incidents[0]?.missing[0]?.count, 2, 'the tampered 64 was never used');
    await h.service.close();
  });

  it('state/count consistency is enforced by the durable schema', () => {
    const base = { key: 'minecraft:bread', valuable: false, metadata: 'server_slot' as const };
    const ok = (m: object) => ManifestItemSchema.safeParse(m).success;
    assert.ok(ok({ ...base, count: 4, regained: 0, state: 'missing' }));
    assert.ok(ok({ ...base, count: 4, regained: 2, state: 'partially_regained' }));
    assert.ok(ok({ ...base, count: 4, regained: 4, state: 'regained' }));
    assert.ok(ok({ ...base, count: 4, regained: 1, state: 'unknown' }));
    assert.ok(!ok({ ...base, count: 4, regained: 5, state: 'regained' }), 'regained cannot exceed the lost count');
    assert.ok(!ok({ ...base, count: 4, regained: 4, state: 'missing' }), 'a fully regained item cannot still be missing/sought');
    assert.ok(!ok({ ...base, count: 4, regained: 4, state: 'partially_regained' }), 'a fully regained item is not partial');
    assert.ok(!ok({ ...base, count: 4, regained: 2, state: 'regained' }), 'a partial regain is not complete');
    assert.ok(!ok({ ...base, count: 4, regained: 2, state: 'missing' }), 'a missing item has no regained units');
    assert.ok(!ok({ ...base, count: 4, regained: 0, state: 'partially_regained' }));
    assert.ok(!ok({ ...base, count: 4, regained: 4, state: 'unknown' }), 'unknown needs a remainder');
    assert.ok(!ok({ ...base, count: 0, regained: 0, state: 'missing' }), 'the lost count is positive');
  });

  it('a crash mid-attempt: the restart closes the attempt as counted restart_interrupted with UNKNOWN effects', async () => {
    const h = harness({ pid: 7106 });
    await admittedRecovery(h);
    assert.equal(h.service.recordRegain(OWNER, 'minecraft:bread', 2, 'act-crash'), 2);
    await settle(h);
    // No close(): the process "dies" holding its lock; the restart sees a dead pid (isAlive=false in the harness).
    const h2 = harness({ root: h.root, pid: 7107 });
    await settle(h2);
    const inc = h2.service.status(h2.clock.now()).incidents[0];
    assert.equal(inc?.attempts.used, 1, 'the interrupted attempt counts');
    assert.equal(inc?.effectsUnknown, true);
    assert.equal(inc?.regained.reduce((n, r) => n + r.count, 0), 2, 'the durable regain survived');
    assert.match(h2.service.statusLines(h2.clock.now()).join('\n'), /some attempt effects unknown/);
    const body = SurvivalStoreBodySchema.parse(latestOnDisk(h.root).body);
    assert.equal(body.episodes[0]?.attempts[0]?.outcome, 'restart_interrupted');
    await h2.service.close();
  });

  it('a rejected body names the exact invalid field (diagnosable from the event alone)', async () => {
    const h = harness({ pid: 7108 });
    await admittedRecovery(h);
    const e = (h.service as unknown as { book: { episodes(): Array<{ manifest?: { missing: Array<{ regained: number }> } }> } }).book.episodes()[0];
    (e?.manifest?.missing[0] as { regained: number }).regained = 99; // invariant violation injected
    h.service.abandonRecovery('force a write', h.clock.now());
    await settle(h);
    const failed = h.events.find((x) => x['type'] === 'survival_write_failed');
    assert.match(String(failed?.['error']), /at episodes\.0\.manifest\.missing\.0\.regained: regained exceeds the lost count/);
    await h.service.close();
  });
});
