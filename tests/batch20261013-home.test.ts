import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { AutonomyControl } from '../src/autonomy/control.ts';
import { HomeProjectService } from '../src/autonomy/home.ts';
import { canonicalProject, judgeCells, materialRequirements, smallShelterCells, verifyShelter } from '../src/autonomy/blueprint.ts';

const origin = { x: 10, y: 64, z: 10 };
const matches = (tag: string, key: string) => tag === '#minecraft:planks' && key.endsWith('_planks');
const scope = { worldProfile: 'home-offline', worldRevision: 1, botProfile: 'test-bot' };
const clock = { now: () => 100_000, sleep: async () => {} };
const cells = smallShelterCells(origin, 3, 'north');
function harness() {
  const root = resolve('var/home-offline');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(`${root}/project-`);
  const create = () => {
    const control = new AutonomyControl({ scope, rootDir: dir, endpoint: 'offline.invalid:1', rebindEndpoint: false, clock });
    control.open();
    return { control, home: new HomeProjectService({ control, clock, record: () => {} }) };
  };
  return { dir, create, ...create() };
}

describe('Oct13 home prerequisites and durable project fencing (no inference/world)', () => {
  it('allocates a stack once across walls/roof/aid and never invents material from unknown cells', () => {
    const verdicts = judgeCells(cells, () => ({ key: 'minecraft:air', evidence: 'visible' }), matches);
    const r = materialRequirements(verdicts, new Map([['minecraft:oak_planks', 40]]), matches);
    const structural = r.filter((x) => ['wall', 'roof', 'aid'].includes(x.role));
    assert.equal(structural.reduce((n, x) => n + x.count, 0), 56);
    assert.equal(structural.reduce((n, x) => n + x.held, 0), 40);
    assert.equal(structural.reduce((n, x) => n + x.missing, 0), 16);
    const unknown = materialRequirements(judgeCells(cells, () => ({ evidence: 'unknown' }), matches), new Map(), matches);
    assert.equal(unknown.reduce((n, x) => n + x.missing, 0), 0);
    assert.ok(unknown.some((x) => x.unknownCells > 0));
  });

  it('binds structural material while keeping crafting table/furnace/chest requirements exact', () => {
    const r = materialRequirements(judgeCells(cells, () => ({ key: 'minecraft:air', evidence: 'visible' }), matches), new Map([['minecraft:oak_planks', 64]]), matches, 'minecraft:cobblestone');
    assert.equal(r.find((x) => x.role === 'wall')?.held, 0);
    assert.ok(r.find((x) => x.accept[0] === 'minecraft:crafting_table'));
    assert.ok(r.find((x) => x.accept[0] === 'minecraft:furnace'));
    assert.ok(r.find((x) => x.accept[0] === 'minecraft:chest'));
  });

  it('serializes approval/checkpoint/verification and ignores a stale project writer', async () => {
    const h = harness();
    try {
      const [a, duplicate] = await Promise.all([h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: ['offline probe'] }), h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: ['offline probe'] })]);
      assert.equal(a.ok, true);
      assert.equal(duplicate.ok, false);
      if (!a.ok) return;
      const v = verifyShelter(cells, judgeCells(cells, () => ({ key: 'minecraft:air', evidence: 'visible' }), matches));
      const wall = cells.find((c) => c.role === 'wall')!;
      await Promise.all([h.home.checkpoint({ projectId: a.project.id, at: wall.at, to: 'minecraft:oak_planks', confirmedAtMs: 1_000, capability: 'build_home' }), h.home.verified(v, a.project.id)]);
      assert.equal(h.home.project()?.checkpoints.length, 1);
      assert.equal(await h.home.checkpoint({ projectId: 'proj-other', at: wall.at, to: 'minecraft:stone', confirmedAtMs: 1_000, capability: 'build_home' }), false);
      await h.home.interrupted('stop', 'proj-other');
      assert.equal(h.home.project()?.state, 'building');
      assert.equal(await h.home.checkpoint({ projectId: a.project.id, at: { x: 1, y: 2, z: 3 }, to: 'minecraft:stone', confirmedAtMs: 1_000, capability: 'build_home' }), false);
    } finally { await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('reloads a partial project as history, with no action replay or current inventory claim', async () => {
    const h = harness();
    try {
      const a = await h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: ['offline probe'] });
      assert.ok(a.ok);
      if (!a.ok) return;
      await h.home.checkpoint({ projectId: a.project.id, at: cells.find((c) => c.role === 'wall')!.at, to: 'minecraft:oak_planks', confirmedAtMs: 1_000, capability: 'build_home' });
      await h.home.interrupted('stop', a.project.id);
      await h.control.close();
      const next = h.create();
      try {
        assert.equal(next.home.project()?.id, a.project.id);
        assert.equal(next.home.project()?.state, 'interrupted');
        assert.equal(next.home.project()?.checkpoints.length, 1);
        assert.equal(next.home.summary()?.verified, null);
        assert.equal(next.home.project()?.verified, undefined);
      } finally { await next.control.close(); }
    } finally { await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });

  it('refuses a truncated canonical checklist and a cancelled queued admission', async () => {
    const h = harness();
    try {
      const cancelled = await h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: [] }, () => false);
      assert.equal(cancelled.ok, false);
      assert.equal(h.home.project(), undefined);
      const a = await h.home.approve({ origin, interior: 3, facing: 'north', dimension: 'overworld', checks: [] });
      assert.ok(a.ok);
      if (!a.ok) return;
      const p = structuredClone(a.project);
      p.cells.pop();
      assert.equal(canonicalProject(p), false);
      assert.equal(await h.control.setHome(p, 'tampered-checklist'), false);
      assert.match(h.control.persistence().detail, /canonical blueprint/);
    } finally { await h.control.close(); rmSync(h.dir, { recursive: true, force: true }); }
  });
});
