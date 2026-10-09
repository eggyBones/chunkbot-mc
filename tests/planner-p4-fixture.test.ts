// P-PLAN-R20: actual 262 real-Codex/real-Jev P4 ("bring me some bread",
// goal-d885cb5cd4bb, run-bfecf3f6d9a6) ended cannot_execute. This control
// records the DECLARED-SCENE and code facts around that result, using the real
// PerceptionService, VersionKnowledge and proposal schema over the actual scene
// commands and the harness's actual P4 setup (read from source; the harness has
// top-level fixture side effects and is never imported). No inference.
//
// Scope: these facts cover only the declared scene commands and the P4 setup.
// The goal's ORIGINAL admission radius (128) extends beyond that scene, and the
// wider fixture world (including containers left by other trials) is UNKNOWN
// here; nothing below proves a quantity unattainable in the whole world or the
// whole authorized radius.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { PlannerProposalSchema, sequentialIds, systemClock, type ObservationSnapshot } from '../src/contracts/index.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { sceneCommands } from '../scripts/lib/scene.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2 } from './skill-fakes.ts';

const SOURCE = readFileSync(new URL('../scripts/planner-live-check.ts', import.meta.url), 'utf8');
const P4 = SOURCE.slice(SOURCE.indexOf("await check('P4'"), SOURCE.indexOf("await check('P5'"));
const summon = /summon item (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) \{Item:\{id:"minecraft:bread",count:(\d+)\}/.exec(P4);
const ownerTp = /tp FixtureOwner (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/.exec(P4);
const BREAD = { x: Number(summon?.[1]), y: Number(summon?.[2]), z: Number(summon?.[3]), count: Number(summon?.[4]) };
const OWNER_AT = { x: Number(ownerTp?.[1]), z: Number(ownerTp?.[3]) };
const START = { x: 205.5, z: 205.5 }; // SCENE.start (journaled admission anchor 205.5,-60,205.5)
const EXPLORED = { x: 204.5, z: 185.5 }; // journaled explore_frontier end position (frt-3455, "0 drops")

function view(at: { x: number; z: number }) {
  const client = fakeClient();
  const fake = fakeMineflayerBot(client, { loaded: 400, at: { x: at.x, y: -60, z: at.z } });
  fake.fill(150, -61, 150, 270, -61, 270, 'grass_block');
  for (const c of sceneCommands()) {
    const a = c.split(' '); const b = (s: string) => s.replace(/\[.*$/, '');
    if (a[0] === 'fill') { const v = a.slice(1, 7).map(Number) as [number, number, number, number, number, number]; fake.fill(...v, b(a[7]!)); }
    else if (a[0] === 'setblock') fake.setBlock(Number(a[1]), Number(a[2]), Number(a[3]), b(a[4]!));
  }
  const bread = fake.addEntity({ id: 77, type: 'other', name: 'item', at: { x: BREAD.x, y: BREAD.y, z: BREAD.z }, height: 0.25 });
  Object.assign(bread, { getDroppedItem: () => ({ name: 'bread', count: BREAD.count }) });
  const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never); evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const p = new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 32, travelRadius: 128 });
  return p.take(1) as ObservationSnapshot;
}

describe('P-PLAN-R20 P4 fixture and code facts (real perception/knowledge/schema)', () => {
  it('the declared P4 setup supplies exactly ONE pickable bread and the declared scene commands place no wheat/bread source (wider world unknown)', () => {
    assert.deepEqual({ ...BREAD }, { x: 203.5, y: -60, z: 208.5, count: 1 });
    assert.ok(!sceneCommands().some((c) => /wheat|hay_block|bread|farmland/.test(c) && !/chunkbot_front/.test(c)), 'the declared scene commands place no wheat, hay or other bread');
    assert.match(P4, /kill @e\[type=item,tag=chunkbot_front\]/, 'the base scene bread (unpickable) is removed first');
    const k = new VersionKnowledge({ version: '26.2' });
    const recipe = JSON.stringify(k.answerOne({ kind: 'recipe', output: 'minecraft:bread' }));
    assert.match(recipe, /minecraft:wheat/, 'bread needs wheat; so the declared scene alone cannot supply possess >= 2 bread (the wider world within the radius is unknown)');
  });

  it('occluded from the start and from the actual north exploration end; visible from the owner position and the south/east sides', () => {
    const drops = (at: { x: number; z: number }) => view(at).drops.filter((d) => d.key === 'minecraft:bread').length;
    assert.equal(drops(START), 0, 'start: hidden behind the chest (actual first windows saw no bread)');
    assert.equal(drops(EXPLORED), 0, 'actual north frontier end: still hidden (journaled 0 drops)');
    assert.equal(drops(OWNER_AT), 1, 'from the owner position (the delivery destination) the bread is visible');
    for (const at of [{ x: 205.5, z: 208.5 }, { x: 207.5, z: 205.5 }]) assert.equal(drops(at), 1, JSON.stringify(at));
    const dirs = view(START).frontiers.map((f) => f.direction).sort();
    assert.deepEqual(dirs, ['east', 'north', 'north_east', 'north_west', 'south', 'south_east', 'south_west', 'west'], 'eight directions were offered; north is the one leading away');
  });

  it('the actual zero-quantity task completions were correctly refused by the real schema (atLeast >= 1)', () => {
    const raw = { version: 1, interpretation: 'Bringing you 3 bread, held in my inventory when I reach you. I will first check the nearby chest for supplies.', disposition: 'plan', outcome: { kind: 'finite', outcome: { predicate: 'all', of: [{ predicate: 'inventory_amount', selector: 'minecraft:bread', atLeast: 3, mode: 'possess' }, { predicate: 'near_target', target: { kind: 'owner' }, within: 2 }] } }, tasks: [{ objective: 'Check the nearby chest for bread and ingredients.', decisionInstruction: 'Inspect the chest and obtain a fresh server-confirmed contents read before withdrawing anything.', allowedCapabilities: ['inspect_container'], targetSelectors: [{ kind: 'observed', snapshotId: 'snap-0213aed7d574', handle: 'blk-2743' }], parameters: {}, completion: { predicate: 'container_state', target: { kind: 'observed', snapshotId: 'snap-0213aed7d574', handle: 'blk-2743' }, selector: 'minecraft:bread', atLeast: 0 } }], morePlanningNeeded: true };
    const r = PlannerProposalSchema.safeParse(raw);
    assert.equal(r.success, false);
    assert.ok(!r.success && r.error.issues.some((i) => i.path.join('.') === 'tasks.0.completion.atLeast'));
    raw.tasks[0]!.completion.atLeast = 1;
    assert.equal(PlannerProposalSchema.safeParse(raw).success, true, 'the same proposal with a real quantity is valid');
  });

  it('harness evidence names the admitted task objective (R20 printed "undefined")', () => {
    assert.match(P4, /find\(\(e\) => e\.type === 'task_admitted' && e\.taskId === t\.taskId\)\?\.objective/);
    assert.ok(!/"\$\{String\(t\.objective\)\.slice\(0, 100\)\}"/.test(P4));
  });
});
