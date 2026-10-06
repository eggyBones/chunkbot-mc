// Durable memory store: atomic, versioned, bounded JSON revisions (M-G1).
//
// Decision (gate M-G1): plain atomic files, no SQLite/vector service and no new
// dependency. Node 24 offers no stable built-in SQLite we may rely on under the
// pinned toolchain, the data set is small and bounded (<= 512 facts, <= 1 MB),
// and whole-file revisions make crash consistency simple to prove:
//
//   write  tmp file (O_EXCL) -> fsync -> rename to memory-<rev>.json -> fsync dir
//   load   newest revision whose envelope, schema version, scope and sha256
//          checksum verify; newer unreadable revisions are reported (recovered)
//   keep   the newest `keepRevisions` complete revisions for recovery
//
// A crash before the rename leaves only a temp file (discarded and reported);
// a torn or corrupt newest file fails its checksum and the previous complete
// revision loads with visible `recovered` status. When files exist but none is
// readable, or they were written by a newer schema, the store is READ-ONLY:
// it never silently replaces readable or unreadable older data with empty
// memory. A writer lock prevents two processes from writing one scope.
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../contracts/index.ts';
import {
  MEMORY_BOUNDS,
  MEMORY_FILE_FORMAT,
  MEMORY_SCHEMA_VERSION,
  MemoryStoreBodySchema,
  MemoryStoreFileSchema,
  type MemoryScope,
  type MemoryStoreBody,
} from '../contracts/memory.ts';

const FILE_RE = /^memory-(\d{8})\.json$/;
const TMP_RE = /^memory-\d{8}\.json\.tmp-/;
const LOCK = 'writer.lock';

/** Upgrades a parsed store document of schema version N to N+1 (keys are N). */
export type MemoryMigration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Real migrations. Version 1 is the first released schema, so there are none yet. */
export const MEMORY_MIGRATIONS: ReadonlyMap<number, MemoryMigration> = new Map();

export interface MemoryFileStoreOptions {
  /** Scope directory (see scopeDirectory). */
  dir: string;
  scope: MemoryScope;
  clock: Clock;
  keepRevisions?: number;
  migrations?: ReadonlyMap<number, MemoryMigration>;
  /** Test fault seam: runs after the temp file is durable and before the rename. */
  beforeRename?: (tmpPath: string) => void | Promise<void>;
  pid?: number;
  /** Liveness probe for a lock holder (default: process.kill(pid, 0)). */
  isAlive?: (pid: number) => boolean;
}

export interface MemoryLoad {
  body: MemoryStoreBody | undefined;
  state: 'empty' | 'ready' | 'recovered' | 'migrated' | 'read_only';
  detail: string;
  revision: number;
  corruptRevisions: number[];
  recoveredFromRevision?: number;
  migratedFromSchema?: number;
  discardedPartialWrites: number;
  writable: boolean;
}

/** `<root>/<worldProfile>/r<worldRevision>/<botProfile>` (profile ids are path-safe by schema). */
export function scopeDirectory(root: string, scope: MemoryScope): string {
  return join(root, scope.worldProfile, `r${scope.worldRevision}`, scope.botProfile);
}

export function bodyChecksum(body: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}

const pad = (n: number) => String(n).padStart(8, '0');

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class MemoryFileStore {
  readonly dir: string;
  private readonly options: MemoryFileStoreOptions;
  private readonly keep: number;
  private highestRevision = 0;
  private readonly validRevisions: number[] = [];
  private writable = false;
  private lockHeld = false;
  private queue: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  lastWriteAtMs: number | undefined;
  lastError: string | undefined;
  revision = 0;

  constructor(options: MemoryFileStoreOptions) {
    this.options = options;
    this.dir = options.dir;
    this.keep = Math.max(2, options.keepRevisions ?? MEMORY_BOUNDS.keepRevisions);
  }

  get pending(): number {
    return this.pendingCount;
  }

  get canWrite(): boolean {
    return this.writable;
  }

  /**
   * Loads the newest complete revision (synchronous; startup only). With
   * `readOnly` (doctor/inspection) nothing on disk is created, locked or
   * removed and writes stay refused.
   */
  open(options: { readOnly?: boolean } = {}): MemoryLoad {
    if (options.readOnly) {
      let exists = true;
      try {
        readdirSync(this.dir);
      } catch {
        exists = false;
      }
      if (!exists) return { body: undefined, state: 'empty', detail: 'no stored memory for this scope', revision: 0, corruptRevisions: [], discardedPartialWrites: 0, writable: false };
    } else mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock: { ok: true } | { ok: false; detail: string } = options.readOnly ? { ok: false, detail: 'opened for read-only inspection' } : this.acquireLock();
    let discarded = 0;
    const names = readdirSync(this.dir);
    if (lock.ok) {
      for (const name of names.filter((n) => TMP_RE.test(n))) {
        rmSync(join(this.dir, name), { force: true });
        discarded += 1;
      }
    }
    const revisions = names
      .map((n) => FILE_RE.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => b - a);
    this.highestRevision = revisions[0] ?? 0;
    const corrupt: number[] = [];
    let newer: { revision: number; version: number } | undefined;
    let unmigratable: { revision: number; version: number } | undefined;
    for (const revision of revisions) {
      const r = this.readRevision(revision);
      if (r.kind === 'ok') {
        this.validRevisions.push(revision);
        this.revision = revision;
        const recovered = corrupt.length > 0;
        const blocked = newer ?? unmigratable;
        this.writable = lock.ok && !blocked;
        const base = { body: r.body, revision, corruptRevisions: corrupt, discardedPartialWrites: discarded, writable: this.writable };
        // Older complete revisions also count for recovery/pruning (verified, never assumed).
        for (const older of revisions.filter((x) => x < revision)) if (this.readRevision(older).kind === 'ok') this.validRevisions.push(older);
        if (newer) {
          return { ...base, state: 'read_only', detail: `revision ${newer.revision} was written by a newer memory schema (v${newer.version}); loaded revision ${revision} read-only and refusing to write (no downgrade)` };
        }
        if (unmigratable) {
          return { ...base, state: 'read_only', detail: `revision ${unmigratable.revision} uses schema v${unmigratable.version} with no migration path; loaded older revision ${revision} read-only so the newer data is never pruned or overwritten` };
        }
        if (!lock.ok) return { ...base, state: 'read_only', detail: `loaded revision ${revision} read-only: ${lock.detail}` };
        if (r.migratedFrom !== undefined) {
          return { ...base, state: 'migrated', migratedFromSchema: r.migratedFrom, detail: `revision ${revision} migrated from schema v${r.migratedFrom} to v${MEMORY_SCHEMA_VERSION} in memory; the original file is kept and the next write creates a new revision` };
        }
        if (recovered) {
          return { ...base, state: 'recovered', recoveredFromRevision: revision, detail: `newest revision(s) ${corrupt.join(', ')} unreadable; recovered complete revision ${revision}${discarded ? `; discarded ${discarded} incomplete write(s)` : ''}` };
        }
        return { ...base, state: 'ready', detail: `loaded revision ${revision}${discarded ? `; discarded ${discarded} incomplete write(s)` : ''}` };
      }
      if (r.kind === 'newer') newer ??= { revision, version: r.version };
      else if (r.kind === 'unmigratable') unmigratable ??= { revision, version: r.version };
      else corrupt.push(revision);
    }
    this.writable = false;
    if (revisions.length === 0) {
      this.writable = lock.ok;
      return {
        body: undefined,
        state: lock.ok ? 'empty' : 'read_only',
        detail: lock.ok ? `no stored memory for this scope; starting a fresh assessment${discarded ? ` (discarded ${discarded} incomplete write(s))` : ''}` : `no stored memory; ${lock.detail}`,
        revision: 0,
        corruptRevisions: [],
        discardedPartialWrites: discarded,
        writable: this.writable,
      };
    }
    const why = newer
      ? `revision ${newer.revision} was written by a newer memory schema (v${newer.version})`
      : unmigratable
        ? `revision ${unmigratable.revision} uses schema v${unmigratable.version} with no migration path`
        : `all ${revisions.length} stored revision(s) are unreadable (${corrupt.join(', ')})`;
    return {
      body: undefined,
      state: 'read_only',
      detail: `${why}; memory is read-only and will not be replaced with an empty store — move the files aside or configure a new world profile revision`,
      revision: 0,
      corruptRevisions: corrupt,
      discardedPartialWrites: discarded,
      writable: false,
    };
  }

  private readRevision(revision: number): { kind: 'ok'; body: MemoryStoreBody; migratedFrom?: number } | { kind: 'corrupt'; detail: string } | { kind: 'newer'; version: number } | { kind: 'unmigratable'; version: number } {
    let doc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(this.dir, `memory-${pad(revision)}.json`), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt', detail: 'not an object' };
      doc = parsed as Record<string, unknown>;
    } catch (error) {
      return { kind: 'corrupt', detail: error instanceof Error ? error.message : String(error) };
    }
    if (doc['format'] !== MEMORY_FILE_FORMAT) return { kind: 'corrupt', detail: 'unknown format' };
    const version = doc['schemaVersion'];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return { kind: 'corrupt', detail: 'bad schema version' };
    if (version > MEMORY_SCHEMA_VERSION) return { kind: 'newer', version };
    // Integrity first, under the rules of the version that wrote it.
    if (typeof doc['checksum'] !== 'string' || doc['checksum'] !== bodyChecksum(doc['body'])) return { kind: 'corrupt', detail: 'checksum mismatch (torn or modified file)' };
    let migratedFrom: number | undefined;
    if (version < MEMORY_SCHEMA_VERSION) {
      const migrations = this.options.migrations ?? MEMORY_MIGRATIONS;
      let v = version;
      while (v < MEMORY_SCHEMA_VERSION) {
        const step = migrations.get(v);
        if (!step) return { kind: 'unmigratable', version };
        try {
          doc = step(doc);
        } catch {
          return { kind: 'unmigratable', version };
        }
        v += 1;
      }
      migratedFrom = version;
      doc = { ...doc, schemaVersion: MEMORY_SCHEMA_VERSION, checksum: bodyChecksum(doc['body']) };
    }
    const file = MemoryStoreFileSchema.safeParse(doc);
    if (!file.success) return { kind: 'corrupt', detail: `schema: ${file.error.issues[0]?.message ?? 'invalid'}` };
    if (file.data.revision !== revision) return { kind: 'corrupt', detail: 'revision does not match the file name' };
    const s = file.data.body.scope;
    const want = this.options.scope;
    if (s.worldProfile !== want.worldProfile || s.worldRevision !== want.worldRevision || s.botProfile !== want.botProfile) return { kind: 'corrupt', detail: 'scope does not match this directory' };
    return { kind: 'ok', body: file.data.body, ...(migratedFrom !== undefined ? { migratedFrom } : {}) };
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
        if (holder !== undefined && holder !== pid && alive(holder)) return { ok: false, detail: `another Chunkbot process (pid ${holder}) holds the memory writer lock for this scope` };
        rmSync(path, { force: true }); // stale lock from a dead process (or our own pid)
      }
    }
    return { ok: false, detail: 'could not acquire the memory writer lock' };
  }

  /** Releases the writer lock after pending writes (shutdown). */
  async close(): Promise<void> {
    await this.flush();
    if (this.lockHeld) {
      this.lockHeld = false;
      this.writable = false;
      rmSync(join(this.dir, LOCK), { force: true });
    }
  }

  /** Resolves when every queued write has settled. */
  flush(): Promise<void> {
    return this.queue;
  }

  /**
   * Queues one atomic revision write of `body` (validated and bounded by the
   * caller). Resolves with the written revision; rejects (and records
   * lastError) without touching the previous revision on failure.
   */
  write(body: MemoryStoreBody): Promise<number> {
    if (!this.writable) return Promise.reject(new Error('memory store is read-only'));
    const parsed = MemoryStoreBodySchema.parse(body);
    const text = JSON.stringify(parsed);
    if (text.length > MEMORY_BOUNDS.maxStoreBytes) return Promise.reject(new Error(`memory body ${text.length} bytes exceeds ${MEMORY_BOUNDS.maxStoreBytes}`));
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

  private async writeNow(body: MemoryStoreBody): Promise<number> {
    const revision = this.highestRevision + 1;
    const final = join(this.dir, `memory-${pad(revision)}.json`);
    const tmp = `${final}.tmp-${this.options.pid ?? process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const now = this.options.clock.now();
    const doc = { format: MEMORY_FILE_FORMAT, schemaVersion: MEMORY_SCHEMA_VERSION, revision, writtenAtMs: now, checksum: bodyChecksum(body), body };
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
    this.highestRevision = revision;
    this.revision = revision;
    this.lastWriteAtMs = now;
    this.lastError = undefined;
    this.validRevisions.unshift(revision);
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
      // Some platforms cannot fsync a directory; the rename is still atomic.
    }
  }

  /** Keeps the newest `keep` complete revisions; older files (valid or not) are removed. */
  private prune(): void {
    const valid = [...new Set(this.validRevisions)].sort((a, b) => b - a);
    const floor = valid[this.keep - 1];
    if (floor === undefined) return;
    this.validRevisions.splice(0, this.validRevisions.length, ...valid.slice(0, this.keep));
    for (const name of readdirSync(this.dir)) {
      const m = FILE_RE.exec(name);
      if (m && Number(m[1]) < floor) rmSync(join(this.dir, name), { force: true });
    }
  }
}
