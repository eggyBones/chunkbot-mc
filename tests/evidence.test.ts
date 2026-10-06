import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isSecretKey, redact } from '../src/telemetry/redact.ts';
import { FileRunStore } from '../src/telemetry/run-store.ts';

describe('redaction', () => {
  it('redacts secret fields but keeps usage counts', () => {
    const out = redact({ accessToken: 'abc', api_key: 'k', password: 'p', Cookie: 'c', inputTokens: 1200, outputTokens: 0, userCode: 'ABCD-EFGH' }) as Record<string, unknown>;
    assert.equal(out['accessToken'], '[redacted]');
    assert.equal(out['api_key'], '[redacted]');
    assert.equal(out['password'], '[redacted]');
    assert.equal(out['Cookie'], '[redacted]');
    assert.equal(out['userCode'], '[redacted]');
    assert.equal(out['inputTokens'], 1200);
    assert.equal(isSecretKey('tokens'), false);
  });

  it('scrubs secret-looking values, masks UUIDs, and bounds payloads', () => {
    const text = redact(
      'key sk-or-v1-0123456789abcdef header Bearer abc.def.ghi jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c owner 6f1a3c2e-0d4b-4e1f-9a7b-1c2d3e4f5a6b',
    ) as string;
    assert.ok(!text.includes('sk-or-v1-0123456789abcdef'));
    assert.ok(!text.includes('abc.def.ghi'));
    assert.ok(!text.includes('eyJhbGci'));
    assert.ok(!text.includes('6f1a3c2e-0d4b'));
    assert.match(text, /uuid:6f1a…/);
    const long = redact('word '.repeat(1_000), { maxStringChars: 50, maxArrayItems: 3, maxDepth: 3 }) as string;
    assert.match(long, /truncated/);
    const list = redact([1, 2, 3, 4, 5], { maxStringChars: 50, maxArrayItems: 3, maxDepth: 3 }) as unknown[];
    assert.equal(list.length, 4);
    const deep = redact({ a: { b: { c: { d: 1 } } } }, { maxStringChars: 50, maxArrayItems: 3, maxDepth: 2 }) as Record<string, Record<string, unknown>>;
    assert.equal(deep['a']?.['b'], '[depth limit]');
  });
});

describe('run evidence store', () => {
  it('writes bounded redacted JSONL and a summary', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'chunkbot-runs-'));
    const store = new FileRunStore({ runsDir, runId: 'run-test1', clock: { now: () => 0 }, maxEvents: 3, maxEventChars: 100, keepRuns: 5 });
    for (let i = 0; i < 5; i += 1) store.record({ type: 'e', i, token: 'secret-value' });
    await store.close({ ok: true });
    const lines = readFileSync(store.eventsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.ok(!lines.join('\n').includes('secret-value'));
    const summary = JSON.parse(readFileSync(join(store.dir, 'summary.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(summary['eventsWritten'], 3);
    assert.equal(summary['eventsDropped'], 2);
  });

  it('keeps only the newest runs', () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'chunkbot-runs-'));
    for (let i = 0; i < 4; i += 1) {
      const dir = join(runsDir, `run-old${i}`);
      mkdirSync(dir);
      utimesSync(dir, new Date(1_000 * i), new Date(1_000 * i));
    }
    new FileRunStore({ runsDir, runId: 'run-new', clock: { now: () => 0 }, maxEvents: 10, maxEventChars: 100, keepRuns: 3 });
    assert.equal(existsSync(join(runsDir, 'run-old0')), false);
    assert.equal(existsSync(join(runsDir, 'run-old1')), false);
    assert.equal(existsSync(join(runsDir, 'run-old2')), true);
    assert.equal(existsSync(join(runsDir, 'run-old3')), true);
    assert.equal(existsSync(join(runsDir, 'run-new')), true);
  });
});
