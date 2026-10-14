// MB-FLOW-001-C5 durable scope consistency, plus the durable control store
// (fail-closed recovery, writer lock). No world, no inference.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AutonomyControl } from '../src/autonomy/control.ts';
import { resolveAutonomyScope } from '../src/autonomy/scope.ts';
import { autonomyScopeDirectory } from '../src/autonomy/store.ts';
import { autonomyHarness } from './autonomy-fakes.ts';
import { followPlan } from './handoff-fakes.ts';
import { until } from './helpers.ts';

const mem = { enabled: true, worldProfile: 'world-a', worldRevision: 1, botProfile: 'bot-a' };
const clock = { now: () => 1_000 };

describe('MB-FLOW-001-C5 one consistent durable scope', () => {
  it('the memory profile is used by default; an identical explicit autonomy.scope is accepted', () => {
    assert.deepEqual(resolveAutonomyScope(undefined, mem), { scope: { worldProfile: 'world-a', worldRevision: 1, botProfile: 'bot-a' }, source: 'memory' });
    assert.equal(resolveAutonomyScope({ worldProfile: 'world-a', worldRevision: 1, botProfile: 'bot-a' }, mem).source, 'both');
    assert.equal(resolveAutonomyScope({ worldProfile: 'w', worldRevision: 2, botProfile: 'b' }, undefined).source, 'autonomy');
    assert.equal(resolveAutonomyScope({ worldProfile: 'w', worldRevision: 2, botProfile: 'b' }, { ...mem, enabled: false }).source, 'autonomy', 'a disabled memory profile is not a second scope');
    assert.equal(resolveAutonomyScope(undefined, undefined).source, 'none');
  });

  for (const field of ['worldProfile', 'worldRevision', 'botProfile'] as const) {
    it(`a ${field} mismatch is a visible conflict that blocks automatic work only`, async () => {
      const explicit = { worldProfile: 'world-a', worldRevision: 1, botProfile: 'bot-a', [field]: field === 'worldRevision' ? 2 : 'other' };
      const r = resolveAutonomyScope(explicit, mem);
      assert.equal(r.source, 'conflict');
      assert.match(r.conflict ?? '', new RegExp(field));
      const control = new AutonomyControl({ scope: undefined, scopeConflict: r.conflict!, rootDir: mkdtempSync(join(tmpdir(), 'chunkbot-scope-')), endpoint: '127.0.0.1:25566', rebindEndpoint: false, clock });
      control.open();
      assert.equal(control.persistence().state, 'conflict');
      assert.equal(control.usable(), false);
    });
  }

  it('the supervisor reports scope_blocked with the conflict and makes no automatic call; manual goals run', async () => {
    const h = autonomyHarness(() => ({ kind: 'reply', proposal: followPlan() }), { scope: false });
    // (the harness has no scope; the CLI seam passes the conflict detail through AutonomyControl, tested above)
    await h.supervisor.assessNow();
    assert.equal(h.planner.count, 0);
    assert.equal(h.supervisor.status().mode, 'scope_blocked');
  });
});

describe('durable control store fail-closed rules', () => {
  const scope = { worldProfile: 'world-a', worldRevision: 1, botProfile: 'bot-a' };

  it('a corrupt NEWEST revision recovers the older one and forces the latch paused (a lost stop is never undone)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chunkbot-ctl-'));
    const c1 = new AutonomyControl({ scope, rootDir: root, endpoint: 'e', rebindEndpoint: false, clock, store: { pid: 10_001, isAlive: () => false } });
    c1.open();
    await c1.setLatch({ paused: false });
    await c1.flush();
    await c1.close();
    const dir = autonomyScopeDirectory(root, scope);
    const newest = readdirSync(dir).filter((n) => n.startsWith('control-')).sort().at(-1)!;
    const next = newest.replace(/\d{8}/, (m) => String(Number(m) + 1).padStart(8, '0'));
    writeFileSync(join(dir, next), '{"format":"chunkbot-autonomy","schemaVersion":1,"torn');
    const c2 = new AutonomyControl({ scope, rootDir: root, endpoint: 'e', rebindEndpoint: false, clock, store: { pid: 10_002, isAlive: () => false } });
    c2.open();
    assert.equal(c2.latch().paused, true);
    assert.equal(c2.latch().source, 'store_recovery');
  });

  it('another live writer makes the scope read-only (automatic work blocked)', () => {
    const root = mkdtempSync(join(tmpdir(), 'chunkbot-ctl-'));
    const a = new AutonomyControl({ scope, rootDir: root, endpoint: 'e', rebindEndpoint: false, clock, store: { pid: 20_001, isAlive: () => true } });
    a.open();
    const b = new AutonomyControl({ scope, rootDir: root, endpoint: 'e', rebindEndpoint: false, clock, store: { pid: 20_002, isAlive: () => true } });
    b.open();
    assert.equal(b.persistence().state, 'read_only');
    assert.equal(b.usable(), false);
  });

  it('a different endpoint for the same scope is a conflict unless rebound', () => {
    const root = mkdtempSync(join(tmpdir(), 'chunkbot-ctl-'));
    const a = new AutonomyControl({ scope, rootDir: root, endpoint: '127.0.0.1:1', rebindEndpoint: false, clock, store: { pid: 30_001, isAlive: () => false } });
    a.open();
    a.onConnectionReady();
    return a.flush().then(async () => {
      await a.close();
      const b = new AutonomyControl({ scope, rootDir: root, endpoint: '127.0.0.1:2', rebindEndpoint: false, clock, store: { pid: 30_002, isAlive: () => false } });
      b.open();
      b.onConnectionReady();
      assert.equal(b.persistence().state, 'conflict');
    });
  });

  it('an earlier pause write cannot mark a later pause durable across an intervening resume', async () => {
    const gates: Array<() => void> = [];
    const rootDir = mkdtempSync(join(tmpdir(), 'chunkbot-latch-order-'));
    const c = new AutonomyControl({ scope, rootDir, endpoint: 'e', rebindEndpoint: false, clock,
      store: { beforeRename: () => new Promise<void>((resolve) => gates.push(resolve)) },
    });
    c.open();
    const first = c.setLatch({ paused: true, sinceMs: 1, source: 'first' });
    await until(() => gates.length === 1);
    const resumed = c.setLatch({ paused: false });
    const latest = c.setLatch({ paused: true, sinceMs: 2, source: 'latest' });
    gates[0]!();
    assert.equal(await first, true);
    assert.equal(c.latchDurability(), 'pending', 'latest pause is still queued, despite the same boolean being on disk');
    await until(() => gates.length === 2);
    gates[1]!();
    await resumed;
    assert.equal(c.latchDurability(), 'pending');
    await until(() => gates.length === 3);
    gates[2]!();
    assert.equal(await latest, true);
    assert.equal(c.latchDurability(), 'written');
    await c.close();
    const loaded = new AutonomyControl({ scope, rootDir, endpoint: 'e', rebindEndpoint: false, clock });
    loaded.open();
    assert.deepEqual(loaded.latch(), { paused: true, sinceMs: 2, source: 'latest' });
    await loaded.close();
  });

  it('close fences new mutations immediately and drains the exact queued stop before releasing the scope', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'chunkbot-close-latch-'));
    let release!: () => void;
    let writing = false;
    const c = new AutonomyControl({ scope, rootDir, endpoint: 'e', rebindEndpoint: false, clock, store: { beforeRename: () => {
      writing = true;
      return new Promise<void>((resolve) => { release = resolve; });
    } } });
    c.open();
    const stopped = c.setLatch({ paused: true, source: 'stop' });
    await until(() => writing);
    const closed = c.close();
    assert.equal(c.usable(), false);
    assert.equal(await c.setLatch({ paused: false }), false);
    assert.equal(await c.setHome(undefined, 'late'), false);
    assert.equal(c.latch().paused, true);
    release();
    assert.equal(await stopped, true);
    await closed;
    const loaded = new AutonomyControl({ scope, rootDir, endpoint: 'e', rebindEndpoint: false, clock });
    loaded.open();
    assert.equal(loaded.persistence().state, 'ready', 'lock released after final stop revision');
    assert.equal(loaded.latch().paused, true);
    await loaded.close();
  });
});
