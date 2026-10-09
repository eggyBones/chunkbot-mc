// P-JEV-R19: J1 ("Walk over to the chest you can see.") staging visibility.
// Actual R19 real-Jev 261 (report 9aa6038f…a165a9, goal-dcd7ba30fa70): from
// tp 214.5,-60,196.5 the first completion was `unknown` ("no visible
// minecraft:chest"), round 1 offered six explore_frontier options with
// move_near:no_grounded_destination, Jev explored east and the task wandered
// 240 s / 44 actions before a different chest satisfied near_target; the harness
// timed out. Every retained earlier J1 (2026-10-05 real, 2026-10-06 fault,
// 2026-10-09 R17 real) also began explore-only.
//
// Faithful control: the REAL PerceptionService and TaskCandidateGenerator with
// the registered skills over the ACTUAL scene commands (scripts/lib/scene.ts,
// as the harness applies them) on the fixture's flat ground. jev-live-check.ts
// has top-level fixture side effects, so its declared J1 start is read from
// the source text, never imported.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { sequentialIds, systemClock, type ObservationSnapshot, type TaskSpec } from '../src/contracts/index.ts';
import { TaskCandidateGenerator } from '../src/execution/candidates.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { ServerEvidence } from '../src/game/server-evidence.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { allSkills } from '../src/skills/index.ts';
import { SCENE, sceneCommands } from '../scripts/lib/scene.ts';
import { fakeClient, fakeMineflayerBot, REGISTRY_26_1_2 } from './skill-fakes.ts';

const SOURCE = readFileSync(new URL('../scripts/jev-live-check.ts', import.meta.url), 'utf8');
const declared = /const J1_START = \{ x: (-?[\d.]+), y: (-?[\d.]+), z: (-?[\d.]+) \} as const;/.exec(SOURCE);
const J1_START = declared ? { x: Number(declared[1]), y: Number(declared[2]), z: Number(declared[3]) } : undefined;
const R19_START = { x: 214.5, y: -60, z: 196.5 }; // actual R19 setup `tp Chunkbot 214.5 -60 196.5 0 0`
const J1_SPEC: TaskSpec = {
  objective: 'Walk over to the chest you can see.',
  decisionInstruction: 'Choose the option that brings you next to the visible chest; avoid wandering elsewhere.',
  allowedCapabilities: ['move_near', 'explore_frontier'],
  targetSelectors: [{ kind: 'registry', key: 'minecraft:chest' }],
  parameters: {},
  completion: { predicate: 'near_target', target: { kind: 'registry', key: 'minecraft:chest' }, within: 3 },
};

/** The actual J0 scene (block commands exactly as recorded) on flat fixture ground (grass at -61). */
function j1World(at: { x: number; y: number; z: number }) {
  const client = fakeClient();
  const fake = fakeMineflayerBot(client, { loaded: 400, at, dimension: 'overworld' });
  fake.fill(150, -61, 150, 270, -61, 270, 'grass_block');
  for (const c of sceneCommands()) {
    const a = c.split(' ');
    const block = (s: string) => s.replace(/^minecraft:/, '').replace(/\[.*$/, '');
    if (a[0] === 'fill') { const [x1, y1, z1, x2, y2, z2] = a.slice(1, 7).map(Number) as [number, number, number, number, number, number]; fake.fill(x1, y1, z1, x2, y2, z2, block(a[7]!)); }
    else if (a[0] === 'setblock') fake.setBlock(Number(a[1]), Number(a[2]), Number(a[3]), block(a[4]!));
  }
  const evidence = new ServerEvidence(client, REGISTRY_26_1_2 as never); evidence.attach();
  const session = { bot: fake.bot, connectionEpoch: 1, evidence } as unknown as GameSession;
  const perception = new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 32, travelRadius: 128 });
  assert.equal(perception.admitTravelAnchor(1), true);
  const registry = new SkillRegistry(allSkills());
  const services = { perception, knowledge: new VersionKnowledge({ version: '26.1.2', catalog: () => registry.catalog() }), ledger: new EvidenceLedger(systemClock, () => 1), clock: systemClock, limits: { travelRadius: 128, observationRadius: 32, ownerLossMs: 1_000 } };
  const candidates = new TaskCandidateGenerator({ registry, services, session: () => session, ids: sequentialIds() });
  const snap = perception.take(1) as ObservationSnapshot;
  const chest = snap.blocks.find((b) => b.key === 'minecraft:chest' && b.at.x === SCENE.chest.x && b.at.y === SCENE.chest.y && b.at.z === SCENE.chest.z);
  return { snap, chest, nowVisible: perception.blockVisibleNow(SCENE.chest.x, SCENE.chest.y, SCENE.chest.z), set: candidates.generate(J1_SPEC, snap) };
}

describe('P-JEV-R19 J1 visible-chest staging (real perception and candidates over the actual scene)', () => {
  it('actual R19 start: the scene oak trunk hides the chest; the first round is explore-only with move_near:no_grounded_destination (as journaled)', () => {
    const w = j1World(R19_START);
    assert.equal(w.chest, undefined);
    assert.equal(w.nowVisible, false);
    // Geometry: the straight sight line to the chest passes through the trunk column (208,202).
    const t = (208.5 - R19_START.x) / (SCENE.chest.x + 0.5 - R19_START.x);
    assert.ok(Math.abs(R19_START.z + t * (SCENE.chest.z + 0.5 - R19_START.z) - 202.5) < 0.01);
    assert.ok(w.set.candidates.length > 0 && w.set.candidates.every((c) => c.capability === 'explore_frontier'));
    assert.ok(w.set.unavailable.some((u) => u.capability === 'move_near' && u.reason === 'no_grounded_destination'), JSON.stringify(w.set.unavailable));
  });

  it('declared J1 start: inside the original scene, a real walk away, and the chest is visible with margin and offered for approach', () => {
    assert.ok(J1_START, 'jev-live-check.ts declares J1_START');
    const s = J1_START!;
    assert.ok(s.x >= SCENE.area.x1 && s.x <= SCENE.area.x2 + 1 && s.z >= SCENE.area.z1 && s.z <= SCENE.area.z2 + 1 && s.y === -60, 'inside the original scene, standing level');
    assert.ok(Math.hypot(s.x - (SCENE.chest.x + 0.5), s.z - (SCENE.chest.z + 0.5)) > 3 + 3, 'more than a 3-block walk beyond the completion radius');
    for (const dx of [-0.3, 0, 0.3]) for (const dz of [-0.3, 0, 0.3]) {
      const w = j1World({ x: s.x + dx, y: s.y, z: s.z + dz });
      assert.ok(w.chest && w.nowVisible, `chest visible from ${s.x + dx},${s.z + dz} (snapshot and live LOS)`);
      assert.ok(w.chest.distance > 3, 'completion is not satisfied at the start');
      assert.ok(w.set.candidates.some((c) => c.capability === 'move_near' && /minecraft:chest/.test(c.description)), `approach offered: ${JSON.stringify(w.set.unavailable)}`);
    }
  });

  it('harness wiring: original task, timeout and RCON end proof unchanged; fresh CLI visibility/position proof precedes admission', () => {
    const j1 = SOURCE.slice(SOURCE.indexOf("await check('J1'"), SOURCE.indexOf("await check('J2'"));
    assert.match(j1, /await setup\(`tp Chunkbot \$\{J1_START\.x\} \$\{J1_START\.y\} \$\{J1_START\.z\} 0 0`\);/);
    assert.ok(j1.indexOf('j1VisibleChestReadiness(tpAtMs)') > 0 && j1.indexOf('j1VisibleChestReadiness(tpAtMs)') < j1.indexOf("runTask('move to the visible chest'"));
    assert.match(j1, /objective: 'Walk over to the chest you can see\.',/);
    assert.match(j1, /allowedCapabilities: \['move_near', 'explore_frontier'\],\n\s+targetSelectors: \[reg\('minecraft:chest'\)\],\n\s+completion: \{ predicate: 'near_target', target: reg\('minecraft:chest'\), within: 3 \},\n\s+\}\);/, 'no timeoutMs override: the original 240 s default applies');
    for (const kept of ["assert(t.terminal.status === 'completed'", "assert(t.terminal.decisions >= 1, 'at least one real Jev decision')", "assert(d <= 3.6, 'server position is near the chest')"]) assert.ok(j1.includes(kept), kept);
    assert.match(SOURCE, /opts\.timeoutMs \?\? 240_000/);
    const ready = SOURCE.slice(SOURCE.indexOf('async function j1VisibleChestReadiness'), SOURCE.indexOf('/** Admits one operator task diagnostic'));
    assert.match(ready, /chunkbot\.send\('\/diag observe'\)/);
    assert.match(ready, /Number\(snap\.takenAtMs\) >= sinceMs/);
    assert.match(ready, /Math\.hypot\(self\.x - J1_START\.x, self\.z - J1_START\.z\) <= 0\.5/);
    assert.match(ready, /Number\(chest\.distance\) > 3/);
    assert.ok(!/rconRaw|serverPos|setup\(/.test(ready), 'readiness uses only the actual CLI observation, no RCON');
  });
});
