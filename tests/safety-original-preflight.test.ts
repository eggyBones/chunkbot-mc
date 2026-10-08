import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { guardOriginalTrialVolume, guardMutationVolume, SAFETY_RAISED_LAYOUT } from '../src/safety/trial-arena.ts';

interface Body { type: string; name?: string; tag?: string; min: [number, number, number]; max: [number, number, number] }
const box = (min: Body['min'], max: Body['max'], type = 'zombie_horse'): Body => ({ min, max, type });
/** Server selector oracle follows the official AABB delta+1/intersection
 * semantics already verified for both releases; centers are never consulted. */
function server(bodies: Body[], unloaded = '', unknown = '') {
  const commands: string[] = [];
  const read = async (command: string) => {
    commands.push(command);
    if (unknown && command.includes(unknown)) return 'Unknown command';
    if (command.startsWith('execute if loaded ')) return command === unloaded ? 'Test failed' : 'Test passed. Count: 1';
    const bounds = /x=(-?\d+),y=(-?\d+),z=(-?\d+),dx=(\d+),dy=(\d+),dz=(\d+)/.exec(command);
    assert.ok(bounds, `unknown selector ${command}`);
    const nums = bounds.slice(1).map(Number);
    const min = nums.slice(0, 3), max = min.map((n, i) => n + nums[i + 3]! + 1);
    const found = bodies.some((b) => {
      if (command.includes('@a[')) { if (b.type !== 'player' || b.name === 'Chunkbot') return false; }
      else {
        if (command.includes('type=!player') && b.type === 'player') return false;
        if (command.includes('type=!item') && b.type === 'item') return false;
        if (command.includes('type=!experience_orb') && b.type === 'experience_orb') return false;
        if (b.tag === 'unique_run') return false;
      }
      return min.every((n, i) => b.max[i]! > n && b.min[i]! < max[i]!);
    });
    return found ? 'Test passed. Count: 1' : 'Test failed.';
  };
  return { read, commands };
}
const ignore = () => undefined;

describe('full ORIGINAL scene preflight before module staging', () => {
  it('empty full clone requires all six loaded chunks, then two serialized absence tests', async () => {
    const s = server([]);
    const seen: string[] = [];
    await guardOriginalTrialVolume(s.read, 'unique_run', 'Chunkbot', (kind) => { seen.push(kind); });
    assert.deepEqual(seen, ['loaded', 'loaded', 'loaded', 'loaded', 'loaded', 'loaded', 'entities', 'players']);
    assert.deepEqual(s.commands.slice(0, 6), [
      'execute if loaded 240 -61 190', 'execute if loaded 240 -61 192', 'execute if loaded 240 -61 208',
      'execute if loaded 256 -61 190', 'execute if loaded 256 -61 192', 'execute if loaded 256 -61 208',
    ]);
    assert.equal(s.commands[6], 'execute if entity @e[tag=!unique_run,type=!player,x=240,y=-61,z=190,dx=30,dy=13,dz=30]');
    assert.equal(s.commands[7], 'execute if entity @a[name=!Chunkbot,x=240,y=-61,z=190,dx=30,dy=13,dz=30]');
  });
  it('lower body nonintersecting raised staging still refuses original scene (no fate inference)', async () => {
    const s = server([box([252.8, -60, 200.8], [254.2, -58.4, 202.2])]);
    await guardMutationVolume(s.read, 'unique_run', 'Chunkbot', ignore, SAFETY_RAISED_LAYOUT);
    let cloned = false;
    await assert.rejects(async () => { await guardOriginalTrialVolume(s.read, 'unique_run', 'Chunkbot', ignore); cloned = true; }, /foreign arena occupants present/);
    assert.equal(cloned, false);
    assert.ok(!s.commands.some((c) => /^(kill|tp|fill|clone)/.test(c)), 'preflight itself is entirely read-only');
  });
  it('all six faces and inclusive last block use colliding bounding boxes, even when centers are outside', async () => {
    const min = [240, -61, 190], end = [271, -47, 221];
    for (let axis = 0; axis < 3; axis++) for (const high of [false, true]) {
      const lo: Body['min'] = [250, -55, 205], hi: Body['max'] = [251, -54, 206];
      lo[axis] = high ? end[axis]! - 0.01 : min[axis]! - 1;
      hi[axis] = high ? end[axis]! + 1 : min[axis]! + 0.01;
      const s = server([box(lo, hi)]);
      await assert.rejects(guardOriginalTrialVolume(s.read, 'unique_run', 'Chunkbot', ignore), /foreign arena occupants present/);
    }
    for (const p of [[270.7, -55, 205], [255, -47.1, 205], [255, -55, 220.7]] as const) {
      await assert.rejects(guardOriginalTrialVolume(server([box([...p], p.map((n) => n + 0.1) as Body['max'])]).read, 'unique_run', 'Chunkbot', ignore));
    }
    await guardOriginalTrialVolume(server([box([271, -55, 205], [272, -54, 206])]).read, 'unique_run', 'Chunkbot', ignore);
  });
  it('every species and initial item/xp body refuses; only current run tag/current bot is exempt', async () => {
    for (const type of ['zombie_horse', 'pig', 'area_effect_cloud', 'item', 'experience_orb', 'player']) {
      const body = box([255, -60, 205], [256, -58.2, 206], type);
      if (type === 'player') body.name = 'Foreign';
      await assert.rejects(guardOriginalTrialVolume(server([body]).read, 'unique_run', 'Chunkbot', ignore));
    }
    const bot = { ...box([255, -60, 205], [256, -58.2, 206], 'player'), name: 'Chunkbot' };
    const tagged = { ...box([255, -52, 205], [256, -50, 206]), tag: 'unique_run' };
    await guardOriginalTrialVolume(server([bot, tagged]).read, 'unique_run', 'Chunkbot', ignore);
    await assert.rejects(guardOriginalTrialVolume(server([{ ...tagged, tag: 'old_run' }]).read, 'unique_run', 'Chunkbot', ignore));
  });
  it('missing chunk/unknown load/absence replies stop immediately and retain exact partial reads', async () => {
    const unloaded = 'execute if loaded 240 -61 192';
    const s = server([], unloaded);
    const seen: Array<{ kind: string; command: string; reply: string }> = [];
    await assert.rejects(guardOriginalTrialVolume(s.read, 'unique_run', 'Chunkbot', (kind, command, reply) => { seen.push({ kind, command, reply }); }), /not verified loaded/);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.reply, 'Test failed');
    assert.ok(!s.commands.some((c) => c.includes('if entity')));
    await assert.rejects(guardOriginalTrialVolume(server([], '', 'loaded').read, 'unique_run', 'Chunkbot', ignore), /not verified loaded/);
    for (const unknown of ['Unknown command', 'Test failed.Test failed.', 'Test failed\nTest passed. Count: 1', '']) {
      const seenReplies: string[] = [];
      await assert.rejects(guardOriginalTrialVolume(async (c) => c.includes('if loaded') ? 'Test passed. Count: 1' : unknown, 'unique_run', 'Chunkbot', (_kind, _c, r) => { seenReplies.push(r); }), /unreadable/);
      assert.equal(seenReplies.length, 7);
      assert.equal(seenReplies.at(-1), unknown);
    }
  });
  it('invalid identity refuses before reading and harness calls full guard before backup mutation, preserving raised guards', async () => {
    let reads = 0;
    await assert.rejects(guardOriginalTrialVolume(async () => { reads++; return ''; }, '../tag', 'Chunkbot', ignore));
    assert.equal(reads, 0);
    const source = readFileSync(new URL('../scripts/safety-live-check.ts', import.meta.url), 'utf8');
    const load = source.indexOf('for (const ch of sceneChunks())');
    const guard = source.indexOf('await g.originalScenePreflight();', load);
    const backup = source.indexOf('const backupNonAir', load);
    assert.ok(load > 0 && guard > load && backup > guard);
    assert.ok(source.indexOf('backupPlanned = true;', backup) > guard);
    assert.match(source, /originalScenePreflight: \{ complete: false, reads \}/);
    assert.match(source, /originalScenePreflight: \{ complete: true, reads \}/);
    assert.match(source, /guardedStageMutation\([\s\S]+?}, LAYOUT\)/);
  });
});
