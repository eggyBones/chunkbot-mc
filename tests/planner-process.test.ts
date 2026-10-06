// MB-PLAN-001 maintained regression with REAL processes: a planner turn's
// attributable descendant that leaves the process group (setsid) cannot
// survive cancellation or normal-exit cleanup; an unrelated sentinel process is
// never touched; reused pid identities are never adopted.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, it } from 'node:test';
import { OwnedProcess, OwnershipTracker } from '../src/planner/process.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Python parent that starts a child in a NEW session/group, reports it, then sleeps (or exits after `exitAfter` s). */
function parentScript(exitAfter: number | null): string {
  return [
    'import subprocess,time,json',
    "p=subprocess.Popen(['/usr/bin/python3','-c','import time; time.sleep(30)'],start_new_session=True)",
    "print(json.dumps({'childPid':p.pid}),flush=True)",
    exitAfter === null ? 'time.sleep(30)' : `time.sleep(${exitAfter})`,
  ].join('\n');
}

function start(exitAfter: number | null): { owned: OwnedProcess; child: Promise<number> } {
  let resolve: (n: number) => void = () => undefined;
  const child = new Promise<number>((r) => (resolve = r));
  const owned = new OwnedProcess({
    command: '/usr/bin/python3',
    args: ['-c', parentScript(exitAfter)],
    cwd: '/tmp',
    env: { PATH: '/usr/bin:/bin' },
    stdin: '',
    maxStdoutBytes: 4096,
    maxLineBytes: 2048,
    maxStderrBytes: 2048,
    graceMs: 100,
    observeIntervalMs: 50,
    onLine: (line) => resolve((JSON.parse(line) as { childPid: number }).childPid),
    onOverflow: (what) => {
      throw new Error(what);
    },
  });
  return { owned, child };
}

function sentinel(): ChildProcess {
  // Unrelated process started by the test itself, in its own group: must survive.
  return spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
}

describe('MB-PLAN-001 owned planner process cleanup (real processes)', () => {
  it('cancellation kills an attributable child that left the group; an unrelated sentinel survives; cleanup reports truthfully', async () => {
    const s = sentinel();
    const { owned, child } = start(null);
    let childPid = 0;
    try {
      childPid = await child;
      await new Promise((r) => setTimeout(r, 150)); // at least one observation while the parent lives
      assert.equal(alive(childPid), true);
      const c = await owned.terminate('test-cancel');
      assert.ok(c.ownedBefore.includes(owned.pid) && c.ownedBefore.includes(childPid), JSON.stringify(c));
      assert.ok(!c.ownedBefore.includes(s.pid!), 'the sentinel is never attributed');
      assert.deepEqual(c.remaining, []);
      assert.equal(alive(childPid), false, 'attributable child is gone');
      assert.equal(alive(s.pid!), true, 'unrelated sentinel untouched');
      assert.ok(c.elapsedMs < 2_500, `bounded (${c.elapsedMs} ms)`);
    } finally {
      if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
      s.kill('SIGKILL');
    }
  });

  it('normal exit: a descendant observed while the parent ran is still cleaned after the parent exits (reparented), sentinel untouched', async () => {
    const s = sentinel();
    const { owned, child } = start(0.4);
    let childPid = 0;
    try {
      childPid = await child;
      await owned.exited; // the parent exited on its own; the child was reparented
      assert.equal(owned.hasExited, true);
      assert.equal(alive(childPid), true, 'precondition: the reparented child is still running');
      const c = await owned.terminate('exited');
      assert.ok(c.ownedBefore.includes(childPid), 'retained by identity across the parent exit');
      assert.ok(c.signals.length > 0, 'the leftover descendant was signalled');
      assert.deepEqual(c.remaining, []);
      assert.equal(alive(childPid), false);
      assert.equal(alive(s.pid!), true);
    } finally {
      if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL');
      s.kill('SIGKILL');
    }
  });

  it('never adopts a reused pid: a retained descendant identity must match its start time', () => {
    let rows = [
      { pid: 100, ppid: 1, pgid: 100, startMs: 100_000 },
      { pid: 200, ppid: 100, pgid: 200, startMs: 102_000 },
      { pid: 300, ppid: 1, pgid: 300, startMs: 50_000 },
    ];
    const t = new OwnershipTracker(100, { list: () => rows });
    assert.deepEqual(t.observe(), [100, 200]);
    rows = [{ pid: 200, ppid: 1, pgid: 200, startMs: 102_000 }, { pid: 300, ppid: 1, pgid: 300, startMs: 50_000 }];
    assert.deepEqual(t.observe(), [200], 'reparented proven descendant is retained');
    rows = [{ pid: 200, ppid: 1, pgid: 200, startMs: 190_000 }, { pid: 300, ppid: 1, pgid: 300, startMs: 50_000 }];
    assert.deepEqual(t.observe(), [], 'same pid, different start time: a reused identity is not ours');
    rows = [{ pid: 400, ppid: 1, pgid: 100, startMs: 10_000 }];
    assert.deepEqual(t.observe(), [], 'a recycled group number with an older process is not ours');
  });
});
