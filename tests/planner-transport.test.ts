// One planner turn through a generated fake `codex` executable (the same
// fault fixture the live harness uses): event validation, typed failures,
// abort/timeout cleanup of the OWNED process group (including a child), late
// output discarded, environment scrubbing. No real CLI or inference.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { plannerEnv } from '../src/planner/codex-cli.ts';
import { isPlannerError } from '../src/planner/errors.ts';
import { ownedPids } from '../src/planner/process.ts';
import { runCodexTurn, type TurnSpec } from '../src/planner/transport.ts';
import { setFaultTurns, writeFaultCodex, type FaultTurn } from '../scripts/lib/fault-codex.ts';

const proposal = { disposition: 'needs_information', interpretation: 'x', queries: [{ kind: 'recipe', key: 'minecraft:stick' }] };

function fixture(turns: FaultTurn[]): { command: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chunkbot-fake-codex-'));
  const command = writeFaultCodex(dir, '/nonexistent/codex');
  setFaultTurns(dir, '/nonexistent/codex', turns);
  return { command, dir };
}

const spec = (command: string, over: Partial<TurnSpec> = {}): TurnSpec => ({ command, args: ['exec', '--json', '-'], cwd: tmpdir(), env: plannerEnv({ ...process.env, OPENROUTER_API_KEY: 'sk-or-should-never-arrive' }, ['OPENROUTER_API_KEY']), prompt: 'planner input', timeoutMs: 5_000, signal: new AbortController().signal, ...over });

async function failure(p: Promise<unknown>): Promise<{ kind: string; detail: string }> {
  try {
    await p;
  } catch (e) {
    assert.ok(isPlannerError(e), String(e));
    return e.failure;
  }
  throw new Error('expected a planner failure');
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('planner turn transport', () => {
  it('returns the final structured message and usage; the scrubbed environment never contains the Jev key', async () => {
    const { command, dir } = fixture([{ kind: 'proposal', proposal }]);
    const r = await runCodexTurn(spec(command));
    assert.deepEqual(JSON.parse(r.finalText), proposal);
    assert.equal(r.usage?.outputTokens, 50);
    assert.equal(r.eventCounts['item:agent_message'], 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'fault-codex-last-prompt-chars.json'), 'utf8')).hasJevKeyName, false);
  });

  it('rejects a turn with a prohibited tool event even though a valid final answer follows', async () => {
    const { command } = fixture([{ kind: 'tool', proposal }]);
    const f = await failure(runCodexTurn(spec(command)));
    assert.equal(f.kind, 'prohibited_event');
    assert.match(f.detail, /command_execution/);
  });

  it('rejects a model reroute (fallback) event', async () => {
    const { command } = fixture([{ kind: 'reroute', proposal }]);
    assert.equal((await failure(runCodexTurn(spec(command)))).kind, 'model_mismatch');
  });

  it('classifies subscription quota and auth failures', async () => {
    assert.equal((await failure(runCodexTurn(spec(fixture([{ kind: 'quota' }]).command)))).kind, 'quota');
    assert.equal((await failure(runCodexTurn(spec(fixture([{ kind: 'auth' }]).command)))).kind, 'auth');
  });

  it('abort kills the owned process group INCLUDING its child; nothing owned remains; no late output is used', async () => {
    const { command, dir } = fixture([{ kind: 'hang' }]);
    const abort = new AbortController();
    const cleanups: Array<{ remaining: number[]; ownedBefore: number[]; signals: string[] }> = [];
    let started = false;
    const p = runCodexTurn(spec(command, { signal: abort.signal, onEvent: (t) => (started ||= t === 'turn.started'), onCleanup: (c) => cleanups.push(c) }));
    const deadline = Date.now() + 5_000;
    let child: number | undefined;
    while (Date.now() < deadline && child === undefined) {
      await new Promise((r) => setTimeout(r, 20));
      try {
        child = (JSON.parse(readFileSync(join(dir, 'fault-codex-hang-child.json'), 'utf8')) as { child: number }).child;
      } catch {
        // not yet
      }
    }
    assert.ok(started && child, 'turn started and the fake spawned an attributable child');
    assert.equal(alive(child!), true);
    const t = Date.now();
    abort.abort(new Error('owner stop'));
    const f = await failure(p);
    assert.equal(f.kind, 'aborted');
    assert.match(f.detail, /owner stop/);
    assert.ok(Date.now() - t < 1_500, 'bounded cleanup');
    assert.equal(cleanups.length, 1);
    assert.ok(cleanups[0]!.ownedBefore.includes(child!), 'the child was attributed to the owned group');
    assert.deepEqual(cleanups[0]!.remaining, []);
    assert.equal(alive(child!), false, 'child is gone');
  });

  it('times out a hanging turn with the same bounded group cleanup', async () => {
    const { command } = fixture([{ kind: 'hang' }]);
    const cleanups: unknown[] = [];
    const f = await failure(runCodexTurn(spec(command, { timeoutMs: 300, onCleanup: (c) => cleanups.push(c) })));
    assert.equal(f.kind, 'timeout');
    assert.equal(cleanups.length, 1);
  });

  it('ownedPids never includes unrelated processes or this process', () => {
    const table = { list: () => [{ pid: 10, ppid: 1, pgid: 10 }, { pid: 11, ppid: 10, pgid: 10 }, { pid: 12, ppid: 11, pgid: 12 }, { pid: 13, ppid: 1, pgid: 13 }, { pid: process.pid, ppid: 1, pgid: 10 }] };
    assert.deepEqual(ownedPids(10, table), [10, 11, 12]);
  });
});
