// MB-MEM-001 M4: atomic versioned store — interrupted writes, corrupt newest
// revision, schema migration/newer schema, writer lock, scope isolation.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { MEMORY_SCHEMA_VERSION, type MemoryScope, type MemoryStoreBody } from '../src/contracts/memory.ts';
import { MemoryBook } from '../src/memory/book.ts';
import { MemoryFileStore, bodyChecksum, scopeDirectory, type MemoryMigration } from '../src/memory/store.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'chunkbot-mem-store-'));
  roots.push(r);
  return r;
}

const SCOPE: MemoryScope = { worldProfile: 'fixture-world', worldRevision: 1, botProfile: 'chunkbot' };
let t = 1_000_000;
const clock = { now: () => (t += 1_000) };
let pid = 50_000;
const store = (dir: string, extra: Partial<ConstructorParameters<typeof MemoryFileStore>[0]> = {}) => new MemoryFileStore({ dir, scope: SCOPE, clock, pid: (pid += 1), isAlive: () => false, ...extra });

function bodyWithHome(label = 'home'): MemoryStoreBody {
  const book = new MemoryBook(SCOPE, clock.now());
  book.designate({ category: 'home', label, location: { dimension: 'minecraft:overworld', at: { x: 10, y: 64, z: -3 } }, evidence: { kind: 'owner_instruction', atMs: clock.now(), detail: 'owner designated home', ownerText: 'remember this as home' }, nowMs: clock.now() });
  return book.body();
}

const files = (dir: string) => readdirSync(dir).filter((n) => n.startsWith('memory-')).sort();

describe('memory store (atomic revisions)', () => {
  it('starts empty, writes atomically and reloads the same facts', async () => {
    const dir = scopeDirectory(tempRoot(), SCOPE);
    const s1 = store(dir);
    const load = s1.open();
    assert.equal(load.state, 'empty');
    assert.equal(load.writable, true);
    const rev = await s1.write(bodyWithHome());
    assert.equal(rev, 1);
    await s1.close();
    const s2 = store(dir);
    const again = s2.open();
    assert.equal(again.state, 'ready');
    assert.equal(again.body?.facts[0]?.label, 'home');
    assert.equal(again.body?.facts[0]?.source, 'owner_statement');
    await s2.close();
  });

  it('a crash before the rename keeps the previous complete revision and discards the partial write visibly', async () => {
    const dir = scopeDirectory(tempRoot(), SCOPE);
    const s1 = store(dir);
    s1.open();
    await s1.write(bodyWithHome('home'));
    const crashing = s1 as unknown as { options: { beforeRename?: () => void } };
    crashing.options.beforeRename = () => {
      throw new Error('simulated crash before rename');
    };
    await assert.rejects(s1.write(bodyWithHome('second base')), /simulated crash/);
    // Simulate the process dying with a temp file left behind.
    writeFileSync(join(dir, 'memory-00000002.json.tmp-999-abc'), '{"format":"chunkbot-memory","partial');
    // (no close: the dead process never released its lock)
    const s2 = store(dir);
    const load = s2.open();
    assert.equal(load.state, 'ready');
    assert.equal(load.revision, 1);
    assert.equal(load.discardedPartialWrites, 1);
    assert.match(load.detail, /discarded 1 incomplete write/);
    assert.equal(load.body?.facts[0]?.label, 'home');
    assert.deepEqual(readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
    await s2.close();
  });

  it('a torn/corrupt newest revision recovers the previous complete revision with visible status, and the next write does not reuse its number', async () => {
    const dir = scopeDirectory(tempRoot(), SCOPE);
    const s1 = store(dir);
    s1.open();
    await s1.write(bodyWithHome('home'));
    await s1.write(bodyWithHome('home'));
    await s1.close();
    const newest = join(dir, 'memory-00000002.json');
    const text = readFileSync(newest, 'utf8');
    writeFileSync(newest, text.slice(0, Math.floor(text.length / 2))); // torn write
    const s2 = store(dir);
    const load = s2.open();
    assert.equal(load.state, 'recovered');
    assert.deepEqual(load.corruptRevisions, [2]);
    assert.equal(load.recoveredFromRevision, 1);
    assert.equal(load.body?.facts.length, 1);
    const rev = await s2.write(load.body as MemoryStoreBody);
    assert.equal(rev, 3, 'never overwrites the unreadable revision file');
    await s2.close();
  });

  it('a checksum mismatch (modified body) is treated as unreadable, not trusted', async () => {
    const dir = scopeDirectory(tempRoot(), SCOPE);
    const s1 = store(dir);
    s1.open();
    await s1.write(bodyWithHome('home'));
    await s1.write(bodyWithHome('home'));
    await s1.close();
    const p = join(dir, 'memory-00000002.json');
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    doc.body.facts[0].label = 'treasure'; // edited without a valid checksum
    writeFileSync(p, JSON.stringify(doc));
    const s2 = store(dir);
    const load = s2.open();
    assert.equal(load.state, 'recovered');
    assert.equal(load.body?.facts[0]?.label, 'home');
    await s2.close();
  });

  it('when every revision is unreadable the store is read-only and never replaced with empty memory', async () => {
    const dir = scopeDirectory(tempRoot(), SCOPE);
    const s1 = store(dir);
    s1.open();
    await s1.write(bodyWithHome());
    await s1.close();
    writeFileSync(join(dir, 'memory-00000001.json'), 'not json at all');
    const s2 = store(dir);
    const load = s2.open();
    assert.equal(load.state, 'read_only');
    assert.equal(load.writable, false);
    assert.equal(load.body, undefined);
    assert.match(load.detail, /will not be replaced with an empty store/);
    await assert.rejects(s2.write(new MemoryBook(SCOPE, clock.now()).body()), /read-only/);
    assert.deepEqual(files(dir), ['memory-00000001.json']);
    await s2.close();
  });

  it('migrates an older schema in memory with visible status (original kept); without a migration path it stays read-only', async () => {
    // Schema v1 is the first released schema; a v0 document in an older layout (body under "data") exercises the chain.
    const body = bodyWithHome('home');
    const legacy = { format: 'chunkbot-memory', schemaVersion: 0, revision: 1, writtenAtMs: 1, checksum: bodyChecksum({ data: body }), body: { data: body } };
    const migrations = new Map<number, MemoryMigration>([[0, (doc) => ({ ...doc, body: (doc['body'] as { data: unknown }).data })]]);
    const { mkdirSync } = await import('node:fs');
    const dir = scopeDirectory(tempRoot(), SCOPE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'memory-00000001.json'), JSON.stringify(legacy));
    const noPath = store(dir);
    const blocked = noPath.open();
    assert.equal(blocked.state, 'read_only');
    assert.match(blocked.detail, /no migration path/);
    await noPath.close();
    const s = store(dir, { migrations });
    const load = s.open();
    assert.equal(load.state, 'migrated');
    assert.equal(load.migratedFromSchema, 0);
    assert.equal(load.body?.facts[0]?.label, 'home');
    assert.equal(load.writable, true);
    const rev = await s.write(load.body as MemoryStoreBody);
    assert.equal(rev, 2);
    assert.deepEqual(files(dir), ['memory-00000001.json', 'memory-00000002.json'], 'original kept beside the migrated revision');
    assert.equal(JSON.parse(readFileSync(join(dir, 'memory-00000002.json'), 'utf8')).schemaVersion, MEMORY_SCHEMA_VERSION);
    await s.close();
  });

  it('a newer schema is never downgraded or overwritten', async () => {
    const dir2 = scopeDirectory(tempRoot(), SCOPE);
    const s3 = store(dir2);
    s3.open();
    await s3.write(bodyWithHome());
    await s3.close();
    const future = { format: 'chunkbot-memory', schemaVersion: MEMORY_SCHEMA_VERSION + 1, revision: 2, writtenAtMs: 2, checksum: 'sha256:' + '0'.repeat(64), body: {} };
    writeFileSync(join(dir2, 'memory-00000002.json'), JSON.stringify(future));
    const s4 = store(dir2);
    const load4 = s4.open();
    assert.equal(load4.state, 'read_only');
    assert.match(load4.detail, /newer memory schema/);
    assert.equal(load4.body?.facts[0]?.label, 'home', 'older readable revision is still visible read-only');
    await assert.rejects(s4.write(load4.body as MemoryStoreBody), /read-only/);
    await s4.close();
  });

  it('a live second writer gets read-only access; a dead lock holder is taken over', async () => {
    const dir = scopeDirectory(tempRoot(), SCOPE);
    const first = new MemoryFileStore({ dir, scope: SCOPE, clock, pid: 7001, isAlive: () => true });
    assert.equal(first.open().writable, true);
    const second = new MemoryFileStore({ dir, scope: SCOPE, clock, pid: 7002, isAlive: (p) => p === 7001 });
    const load = second.open();
    assert.equal(load.writable, false);
    assert.equal(load.state, 'read_only');
    assert.match(load.detail, /pid 7001/);
    // 7001 dies without releasing: a new process takes over.
    const third = new MemoryFileStore({ dir, scope: SCOPE, clock, pid: 7003, isAlive: () => false });
    assert.equal(third.open().writable, true);
    await third.close();
  });

  it('keeps a bounded number of complete revisions', async () => {
    const dir = scopeDirectory(tempRoot(), SCOPE);
    const s = store(dir, { keepRevisions: 3 });
    s.open();
    for (let i = 0; i < 6; i += 1) await s.write(bodyWithHome());
    await s.close();
    assert.deepEqual(files(dir), ['memory-00000004.json', 'memory-00000005.json', 'memory-00000006.json']);
  });

  it('scopes are separate directories: another world profile or revision cannot read this memory', async () => {
    const root = tempRoot();
    const a = store(scopeDirectory(root, SCOPE));
    a.open();
    await a.write(bodyWithHome());
    await a.close();
    for (const other of [{ ...SCOPE, worldRevision: 2 }, { ...SCOPE, worldProfile: 'other-world' }, { ...SCOPE, botProfile: 'helper' }]) {
      const s = new MemoryFileStore({ dir: scopeDirectory(root, other), scope: other, clock, pid: (pid += 1), isAlive: () => false });
      const load = s.open();
      assert.equal(load.state, 'empty', JSON.stringify(other));
      await s.close();
    }
    // A file copied into the wrong scope directory is rejected by its embedded scope.
    const wrong = { ...SCOPE, worldRevision: 3 };
    const dirWrong = scopeDirectory(root, wrong);
    const { mkdirSync, copyFileSync } = await import('node:fs');
    mkdirSync(dirWrong, { recursive: true });
    copyFileSync(join(scopeDirectory(root, SCOPE), 'memory-00000001.json'), join(dirWrong, 'memory-00000001.json'));
    const s = new MemoryFileStore({ dir: dirWrong, scope: wrong, clock, pid: (pid += 1), isAlive: () => false });
    const load = s.open();
    assert.equal(load.state, 'read_only');
    assert.equal(load.body, undefined);
    await s.close();
  });
});
