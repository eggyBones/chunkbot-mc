// MB-FLOW-003 durable episode store: atomic checksummed revisions under the
// explicit scope; corruption recovers from an older revision; unreadable or
// newer data and a live second writer are read-only (never silently emptied).
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { SurvivalFileStore, survivalScopeDirectory } from '../src/survival/store.ts';
import { cleanupRoots, sampleEpisode, tempRoot } from './survival-helpers.ts';

after(cleanupRoots);

const scope = { worldProfile: 'w', worldRevision: 1, botProfile: 'b' };
const body = (n: number) => ({ scope, createdAtMs: 1, episodes: [sampleEpisode({ episodeId: `rep-${String(n).padStart(4, '0')}` })], interrupted: [], nextEpisode: n + 1, evicted: 0 });
const store = (dir: string, pid = 111, isAlive = () => false) => new SurvivalFileStore({ dir, scope, now: () => 5, pid, isAlive });

describe('survival store', () => {
  it('writes and reloads complete revisions', async () => {
    const dir = survivalScopeDirectory(tempRoot(), scope);
    const s = store(dir);
    assert.equal(s.open().state, 'empty');
    assert.equal(await s.write(body(1)), 1);
    assert.equal(await s.write(body(2)), 2);
    await s.close();
    const r = store(dir);
    const load = r.open();
    assert.equal(load.state, 'ready');
    assert.equal(load.body?.episodes[0]?.episodeId, 'rep-0002');
    await r.close();
  });

  it('a corrupt newest revision recovers the previous one, visibly', async () => {
    const dir = survivalScopeDirectory(tempRoot(), scope);
    const s = store(dir);
    s.open();
    await s.write(body(1));
    await s.write(body(2));
    await s.close();
    const newest = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().at(-1) as string;
    writeFileSync(join(dir, newest), readFileSync(join(dir, newest), 'utf8').replace('rep-0002', 'rep-0003'));
    const r = store(dir);
    const load = r.open();
    assert.equal(load.state, 'recovered');
    assert.equal(load.body?.episodes[0]?.episodeId, 'rep-0001');
    assert.deepEqual(load.corrupt, [2]);
    await r.close();
  });

  it('all revisions unreadable or a newer schema: read-only, nothing replaced', async () => {
    const dir = survivalScopeDirectory(tempRoot(), scope);
    const s = store(dir);
    s.open();
    await s.write(body(1));
    await s.close();
    const f = readdirSync(dir).find((x) => x.endsWith('.json')) as string;
    writeFileSync(join(dir, f), '{broken');
    const r = store(dir);
    assert.equal(r.open().state, 'read_only');
    assert.equal(await r.write(body(9)), undefined);
    writeFileSync(join(dir, f), JSON.stringify({ format: 'chunkbot-survival', schemaVersion: 99, body: {} }));
    const n = store(dir);
    assert.equal(n.open().state, 'read_only');
  });

  it('a live second writer is refused', () => {
    const dir = survivalScopeDirectory(tempRoot(), scope);
    const a = store(dir, 111, () => true);
    assert.notEqual(a.open().state, 'read_only');
    const b = store(dir, 222, () => true);
    assert.equal(b.open().state, 'read_only');
    assert.equal(b.canWrite, false);
  });

  it('rejects a body that violates the strict schema instead of writing it', async () => {
    const dir = survivalScopeDirectory(tempRoot(), scope);
    const s = store(dir);
    s.open();
    const bad = { ...body(1), episodes: [{ ...sampleEpisode(), lease: 'x' }] } as never;
    assert.equal(await s.write(bad), undefined);
    assert.match(s.lastError ?? '', /invalid survival body/);
    await s.close();
  });
});
