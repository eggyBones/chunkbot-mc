// App-owned planner processes. Every planner turn runs in its OWN new process
// group (detached spawn: pgid = child pid). Cancellation signals only that
// group plus processes PROVEN to descend from the owned child (attributable
// children that left the group, e.g. via setsid), never a shared
// Codex/T3/DSH process. Output is captured line by line with hard bounds.
//
// MB-PLAN-001: once a descendant's parent dies it is reparented (ppid 1), so a
// fresh process-table walk can no longer attribute it. The tracker therefore
// OBSERVES the tree while the turn runs (and at termination) and RETAINS every
// proven descendant by identity (pid + process start time). Later signals and
// the final verification use those retained identities; a pid reused by an
// unrelated process has a different start time and is never touched. Cleanup
// is bounded (TERM, grace, KILL, verification polling) and reports the actual
// survivors.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** Process start time (ms) when the table provides it; identity guard against pid reuse. */
  startMs?: number;
}

export interface ProcessTable {
  /** `pid ppid pgid start` rows for all processes (read-only `ps`). */
  list(): ProcRow[];
}

export const psTable: ProcessTable = {
  list() {
    const r = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } });
    if (r.status !== 0 || typeof r.stdout !== 'string') return [];
    const rows: ProcRow[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const startMs = Date.parse(`${m[4]} UTC`);
      rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), ...(Number.isFinite(startMs) ? { startMs } : {}) });
    }
    return rows;
  },
};

const sameIdentity = (a: number | undefined, b: number | undefined) => a === b;

/**
 * Proven ownership of one turn's process tree. Seeds: the root (identity
 * pinned at first sight), live members of the root's process group, and
 * previously proven descendants whose identity still matches. Closure: any
 * process whose parent is owned. Proven identities are retained for the turn.
 */
export class OwnershipTracker {
  readonly rootPid: number;
  private readonly table: ProcessTable;
  private rootStartMs: number | undefined;
  private readonly known = new Map<number, number | undefined>();

  constructor(rootPid: number, table: ProcessTable = psTable) {
    this.rootPid = rootPid;
    this.table = table;
  }

  /** Re-reads the table, adds newly proven descendants, returns currently alive owned pids. */
  observe(): number[] {
    const rows = this.table.list();
    const root = rows.find((r) => r.pid === this.rootPid);
    if (root && this.rootStartMs === undefined && !this.known.has(this.rootPid)) {
      this.rootStartMs = root.startMs;
      this.known.set(this.rootPid, root.startMs);
    }
    const owned = new Set<number>();
    for (const r of rows) {
      if (r.pid === process.pid) continue;
      const knownStart = this.known.get(r.pid);
      const provenIdentity = this.known.has(r.pid) && sameIdentity(knownStart, r.startMs);
      // group members started no earlier than the root (a recycled group number is not ours)
      const groupMember = r.pgid === this.rootPid && (this.rootStartMs === undefined || r.startMs === undefined || r.startMs >= this.rootStartMs - 1_000);
      if (provenIdentity || groupMember) owned.add(r.pid);
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) {
        if (!owned.has(r.pid) && owned.has(r.ppid) && r.pid !== process.pid) {
          owned.add(r.pid);
          grew = true;
        }
      }
    }
    for (const r of rows) if (owned.has(r.pid) && !this.known.has(r.pid)) this.known.set(r.pid, r.startMs);
    return [...owned].sort((a, b) => a - b);
  }

  /** Every identity proven so far (alive or not). */
  provenPids(): number[] {
    return [...this.known.keys()].sort((a, b) => a - b);
  }
}

/** Processes owned by a turn right now (single observation; no retained history). */
export function ownedPids(rootPid: number, table: ProcessTable = psTable): number[] {
  return new OwnershipTracker(rootPid, table).observe();
}

export interface CleanupEvidence {
  pid: number;
  reason: string;
  signals: string[];
  elapsedMs: number;
  exitCode: number | null;
  exitSignal: string | null;
  /** Owned pids seen before signalling (group + descendants). */
  ownedBefore: number[];
  /** Owned pids still present after cleanup (must be empty). */
  remaining: number[];
}

export interface OwnedProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  /** Hard bound on total stdout bytes; exceeding it kills the turn. */
  maxStdoutBytes: number;
  maxLineBytes: number;
  maxStderrBytes: number;
  onLine(line: string): void;
  /** Called once when an output bound is exceeded. */
  onOverflow(what: string): void;
  table?: ProcessTable;
  graceMs?: number;
  /** Process-tree observation interval while the turn runs (default 250 ms). */
  observeIntervalMs?: number;
}

export class OwnedProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly startedAtMs = Date.now();
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr = '';
  stdoutBytes = 0;
  private stopped = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly options: OwnedProcessOptions;
  private readonly tracker: OwnershipTracker;
  private observer: NodeJS.Timeout | undefined;
  private cleanup: Promise<CleanupEvidence> | undefined;

  constructor(options: OwnedProcessOptions) {
    this.options = options;
    // detached: a NEW process group led by the child, so a group signal reaches
    // only this turn's process tree.
    this.child = spawn(options.command, [...options.args], { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (this.child.pid === undefined) throw new Error('planner process did not start');
    this.pid = this.child.pid;
    // Observe the owned tree while the turn runs so descendants that leave the
    // group are proven before their parent can exit (MB-PLAN-001).
    this.tracker = new OwnershipTracker(this.pid, options.table ?? psTable);
    this.tracker.observe();
    this.observer = setInterval(() => this.tracker.observe(), options.observeIntervalMs ?? 250);
    this.observer.unref?.();
    // `exited` resolves when the ROOT exits and its stdio has drained ('close'),
    // or at most 250 ms after the exit: a descendant that inherited the stdout
    // pipe must not hold the turn open (it is cleaned by terminate()).
    this.exited = new Promise((resolve) => {
      let drainTimer: NodeJS.Timeout | undefined;
      const done = () => {
        if (drainTimer) clearTimeout(drainTimer);
        resolve(this.exitInfo ?? { code: null, signal: null });
      };
      this.child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        drainTimer = setTimeout(done, 250);
      });
      this.child.once('close', (code, signal) => {
        this.exitInfo ??= { code, signal };
        done();
      });
      this.child.once('error', () => {
        this.exitInfo ??= { code: null, signal: null };
        done();
      });
    });
    let partial = '';
    this.child.stdout?.on('data', (chunk: Buffer) => {
      if (this.stopped) return; // late output after cancellation is discarded
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > options.maxStdoutBytes) {
        this.stopped = true;
        options.onOverflow(`stdout exceeded ${options.maxStdoutBytes} bytes`);
        return;
      }
      partial += chunk.toString('utf8');
      let nl = partial.indexOf('\n');
      while (nl >= 0) {
        const line = partial.slice(0, nl);
        partial = partial.slice(nl + 1);
        if (line.trim()) options.onLine(line);
        if (this.stopped) return;
        nl = partial.indexOf('\n');
      }
      if (partial.length > options.maxLineBytes) {
        this.stopped = true;
        options.onOverflow(`an output line exceeded ${options.maxLineBytes} bytes`);
      }
    });
    this.child.stdout?.on('end', () => {
      if (!this.stopped && partial.trim()) options.onLine(partial);
      partial = '';
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      if (this.stderr.length < options.maxStderrBytes) this.stderr += chunk.toString('utf8').slice(0, options.maxStderrBytes - this.stderr.length);
    });
    this.child.stdin?.on('error', () => undefined);
    this.child.stdin?.end(options.stdin);
  }

  get hasExited(): boolean {
    return this.exitInfo !== undefined;
  }

  /** Stops delivering output (late lines are discarded) without signalling. */
  discardOutput(): void {
    this.stopped = true;
  }

  /**
   * Terminates the owned group and attributable descendants; idempotent and
   * bounded. Resolves with evidence of what was signalled and what remains.
   */
  terminate(reason: string): Promise<CleanupEvidence> {
    this.stopped = true;
    this.cleanup ??= (async () => {
      const started = Date.now();
      const signals: string[] = [];
      const alive = () => this.tracker.observe();
      const ownedBefore = [...new Set([...alive(), ...this.tracker.provenPids()])].sort((a, b) => a - b);
      if (this.observer) clearInterval(this.observer);
      const signalAll = (sig: NodeJS.Signals) => {
        signals.push(sig);
        if (this.exitInfo === undefined) {
          try {
            process.kill(-this.pid, sig); // the owned group only
          } catch {
            // group already gone
          }
        }
        for (const pid of alive()) {
          try {
            process.kill(pid, sig); // proven descendants (identity-checked by observe)
          } catch {
            // already gone
          }
        }
      };
      const settle = async (ms: number) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (this.exitInfo !== undefined && alive().length === 0) return true;
          await sleep(25);
        }
        return this.exitInfo !== undefined && alive().length === 0;
      };
      if (this.exitInfo === undefined || alive().length > 0) {
        signalAll('SIGTERM');
        if (!(await settle(this.options.graceMs ?? 1_000))) {
          signalAll('SIGKILL');
          await settle(1_000);
        }
      }
      const remaining = alive();
      if (this.exitInfo === undefined) await Promise.race([this.exited, sleep(200)]);
      const exit = this.exitInfo ?? { code: null, signal: null };
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      return { pid: this.pid, reason, signals, elapsedMs: Date.now() - started, exitCode: exit.code, exitSignal: exit.signal, ownedBefore, remaining };
    })();
    return this.cleanup;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)); // bounded waits keep cleanup alive
