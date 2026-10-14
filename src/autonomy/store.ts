// Durable autonomy control state (MB-FLOW-001 P2): the owner pause latch and
// the scope's home construction project, one atomic revision file per write.
//
//   write  tmp (O_EXCL) -> fsync -> rename control-<rev>.json -> fsync dir
//   load   newest revision whose envelope, schema, scope and sha256 checksum
//          verify. A NEWER unreadable revision may have held a pause the older
//          one lacks, so a recovered load is FAIL-CLOSED: the latch is forced
//          paused (source `store_recovery`) until the owner resumes.
//   lock   one writer per scope (O_EXCL lock file with the holder pid; a live
//          holder makes this process read-only = automatic work scope-blocked).
//
// Files live under <dataDir>/<autonomy.dir>/<worldProfile>/r<rev>/<botProfile>/.
// Nothing here connects, unpauses, admits goals or replays actions.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../contracts/index.ts';
import {
  AUTONOMY_FILE_FORMAT,
  AUTONOMY_SCHEMA_VERSION,
  AutonomyBodySchema,
  AutonomyFileSchema,
  type AutonomyBody,
  type AutonomyScope,
} from '../contracts/autonomy.ts';
import { bodyChecksum } from '../memory/store.ts';
import { canonicalProject } from './blueprint.ts';

const FILE_RE = /^control-(\d{8})\.json$/;
const TMP_RE = /^control-\d{8}\.json\.tmp-/;
const LOCK = 'writer.lock';
const KEEP = 4;
const MAX_BYTES = 256 * 1024;

const pad = (n: number) => String(n).padStart(8, '0');

export function autonomyScopeDirectory(root: string, scope: AutonomyScope): string {
  return join(root, scope.worldProfile, `r${scope.worldRevision}`, scope.botProfile);
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type ControlLoadState = 'empty' | 'ready' | 'recovered' | 'read_only';

export interface ControlLoad {
  body: AutonomyBody | undefined;
  state: ControlLoadState;
  detail: string;
  revision: number;
  corruptRevisions: number[];
  writable: boolean;
}

export interface ControlStoreOptions {
  dir: string;
  scope: AutonomyScope;
  clock: Clock;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** Test fault seam: after the temp file is durable, before the rename. */
  beforeRename?: (tmpPath: string) => void | Promise<void>;
}

export class ControlFileStore {
  readonly dir: string;
  private readonly options: ControlStoreOptions;
  private highest = 0;
  private valid: number[] = [];
  private writable = false;
  private lockHeld = false;
  private queue: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  revision = 0;
  lastWriteAtMs: number | undefined;
  lastError: string | undefined;

  constructor(options: ControlStoreOptions) {
    this.options = options;
    this.dir = options.dir;
  }

  get canWrite(): boolean {
    return this.writable;
  }

  get pending(): number {
    return this.pendingCount;
  }

  /** Synchronous startup load. `readOnly` (doctor/inspection) creates, locks and removes nothing. */
  open(options: { readOnly?: boolean } = {}): ControlLoad {
    if (options.readOnly) {
      try {
        readdirSync(this.dir);
      } catch {
        return { body: undefined, state: 'empty', detail: 'no stored autonomy state for this scope', revision: 0, corruptRevisions: [], writable: false };
      }
    } else {
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      } catch (error) {
        return { body: undefined, state: 'read_only', detail: `cannot create ${this.dir}: ${error instanceof Error ? error.message : String(error)}`, revision: 0, corruptRevisions: [], writable: false };
      }
    }
    const lock = options.readOnly ? ({ ok: false, detail: 'opened for read-only inspection' } as const) : this.acquireLock();
    const names = readdirSync(this.dir);
    if (lock.ok) for (const n of names.filter((x) => TMP_RE.test(x))) rmSync(join(this.dir, n), { force: true });
    const revisions = names
      .map((n) => FILE_RE.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => b - a);
    this.highest = revisions[0] ?? 0;
    const corrupt: number[] = [];
    let newer: number | undefined;
    for (const revision of revisions) {
      const r = this.read(revision);
      if (r.kind === 'ok') {
        this.revision = revision;
        this.valid = revisions.filter((x) => x <= revision && (x === revision || this.read(x).kind === 'ok'));
        this.writable = lock.ok && newer === undefined;
        const base = { body: r.body, revision, corruptRevisions: corrupt, writable: this.writable };
        if (newer !== undefined) return { ...base, state: 'read_only', detail: `revision ${newer} was written by a newer autonomy schema; loaded revision ${revision} read-only (no downgrade)` };
        if (!lock.ok) return { ...base, state: 'read_only', detail: `loaded revision ${revision} read-only: ${lock.detail}` };
        if (corrupt.length > 0) return { ...base, state: 'recovered', detail: `newest revision(s) ${corrupt.join(', ')} unreadable; recovered complete revision ${revision} (fail-closed: automatic work stays paused until resume)` };
        return { ...base, state: 'ready', detail: `loaded revision ${revision}` };
      }
      if (r.kind === 'newer') newer ??= revision;
      else corrupt.push(revision);
    }
    if (revisions.length === 0) {
      this.writable = lock.ok;
      return { body: undefined, state: lock.ok ? 'empty' : 'read_only', detail: lock.ok ? 'no stored autonomy state for this scope (fresh profile: automatic work allowed)' : `no stored state; ${lock.detail}`, revision: 0, corruptRevisions: [], writable: this.writable };
    }
    this.writable = false;
    const why = newer !== undefined ? `revision ${newer} was written by a newer autonomy schema` : `all ${revisions.length} stored revision(s) are unreadable (${corrupt.join(', ')})`;
    return { body: undefined, state: 'read_only', detail: `${why}; autonomy state is read-only and is never replaced with a fresh (unpaused) state — move the files aside or configure a new world profile revision`, revision: 0, corruptRevisions: corrupt, writable: false };
  }

  private read(revision: number): { kind: 'ok'; body: AutonomyBody } | { kind: 'corrupt'; detail: string } | { kind: 'newer' } {
    let doc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.dir, `control-${pad(revision)}.json`), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt', detail: 'not an object' };
      doc = parsed as Record<string, unknown>;
    } catch (error) {
      return { kind: 'corrupt', detail: error instanceof Error ? error.message : String(error) };
    }
    if (doc['format'] !== AUTONOMY_FILE_FORMAT) return { kind: 'corrupt', detail: 'unknown format' };
    if (typeof doc['schemaVersion'] === 'number' && doc['schemaVersion'] > AUTONOMY_SCHEMA_VERSION) return { kind: 'newer' };
    if (typeof doc['checksum'] !== 'string' || doc['checksum'] !== bodyChecksum(doc['body'])) return { kind: 'corrupt', detail: 'checksum mismatch' };
    const file = AutonomyFileSchema.safeParse(doc);
    if (!file.success) return { kind: 'corrupt', detail: `schema: ${file.error.issues[0]?.message ?? 'invalid'}` };
    if (file.data.body.home && !canonicalProject(file.data.body.home)) return { kind: 'corrupt', detail: 'home checklist differs from its canonical blueprint' };
    if (file.data.revision !== revision) return { kind: 'corrupt', detail: 'revision does not match the file name' };
    const s = file.data.body.scope;
    const want = this.options.scope;
    if (s.worldProfile !== want.worldProfile || s.worldRevision !== want.worldRevision || s.botProfile !== want.botProfile) return { kind: 'corrupt', detail: 'scope does not match this directory' };
    return { kind: 'ok', body: file.data.body };
  }

  private acquireLock(): { ok: true } | { ok: false; detail: string } {
    const path = join(this.dir, LOCK);
    const pid = this.options.pid ?? process.pid;
    const alive = this.options.isAlive ?? defaultAlive;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        writeFileSync(fd, JSON.stringify({ pid, atMs: this.options.clock.now() }));
        closeSync(fd);
        this.lockHeld = true;
        return { ok: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, detail: `cannot create the writer lock (${(error as Error).message})` };
        let holder: number | undefined;
        try {
          holder = (JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }).pid;
        } catch {
          holder = undefined;
        }
        if (holder !== undefined && holder !== pid && alive(holder)) return { ok: false, detail: `another Chunkbot process (pid ${holder}) holds the autonomy writer lock for this scope` };
        rmSync(path, { force: true });
      }
    }
    return { ok: false, detail: 'could not acquire the autonomy writer lock' };
  }

  /** Queues one atomic revision write. Rejects without touching the previous revision on failure. */
  write(body: AutonomyBody): Promise<number> {
    if (!this.writable) return Promise.reject(new Error('autonomy store is read-only'));
    let parsed: AutonomyBody;
    try {
      parsed = AutonomyBodySchema.parse(body);
      if (parsed.home && !canonicalProject(parsed.home)) throw new Error('home checklist differs from its canonical blueprint');
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (JSON.stringify(parsed).length > MAX_BYTES) return Promise.reject(new Error('autonomy body exceeds the size bound'));
    this.pendingCount += 1;
    const run = this.queue.then(() => this.writeNow(parsed));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.pendingCount -= 1;
    });
  }

  private async writeNow(body: AutonomyBody): Promise<number> {
    const revision = this.highest + 1;
    const final = join(this.dir, `control-${pad(revision)}.json`);
    const tmp = `${final}.tmp-${this.options.pid ?? process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const now = this.options.clock.now();
    const doc = { format: AUTONOMY_FILE_FORMAT, schemaVersion: AUTONOMY_SCHEMA_VERSION, revision, writtenAtMs: now, checksum: bodyChecksum(body), body };
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(doc)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.options.beforeRename?.(tmp);
      await rename(tmp, final);
      this.syncDir();
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    this.highest = revision;
    this.revision = revision;
    this.lastWriteAtMs = now;
    this.lastError = undefined;
    this.valid.unshift(revision);
    this.prune();
    return revision;
  }

  private syncDir(): void {
    try {
      const fd = openSync(this.dir, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Directory fsync is unsupported on some platforms; the rename is still atomic.
    }
  }

  private prune(): void {
    const valid = [...new Set(this.valid)].sort((a, b) => b - a);
    const floor = valid[KEEP - 1];
    if (floor === undefined) return;
    this.valid = valid.slice(0, KEEP);
    for (const name of readdirSync(this.dir)) {
      const m = FILE_RE.exec(name);
      if (m && Number(m[1]) < floor) rmSync(join(this.dir, name), { force: true });
    }
  }

  flush(): Promise<void> {
    return this.queue;
  }

  /** Flushes pending writes, then releases the writer lock. */
  async close(): Promise<void> {
    await this.flush();
    if (this.lockHeld) {
      this.lockHeld = false;
      this.writable = false;
      rmSync(join(this.dir, LOCK), { force: true });
    }
  }
}
