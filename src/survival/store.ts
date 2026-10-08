// Durable survival episode store: atomic, checksummed, bounded JSON revisions
// under the explicit operator scope (same world profile / revision / bot
// profile as MB-MEM-001 memory, separate directory).
//
//   write  tmp (O_EXCL) -> fsync -> rename survival-<rev>.json -> fsync dir
//   load   newest revision whose envelope, schema, scope and sha256 verify;
//          unreadable newer revisions are reported (`recovered`); files that
//          exist but none verifies, or a newer schema, make it READ-ONLY
//          (never silently replaced by an empty store)
//   lock   one writer per scope (pid lock with liveness check)
//
// Writes are queued and never awaited on the lifecycle revocation path.
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryScope } from '../contracts/memory.ts';
import { SURVIVAL_FILE_FORMAT, SURVIVAL_SCHEMA_VERSION, SurvivalStoreBodySchema, SurvivalStoreFileSchema, type SurvivalStoreBody, type SurvivalStoreState } from '../contracts/survival.ts';

const FILE_RE = /^survival-(\d{8})\.json$/;
const TMP_RE = /^survival-\d{8}\.json\.tmp-/;
const LOCK = 'writer.lock';
const pad = (n: number) => String(n).padStart(8, '0');

export function survivalScopeDirectory(root: string, scope: MemoryScope): string {
  return join(root, scope.worldProfile, `r${scope.worldRevision}`, scope.botProfile);
}

/**
 * Schema v1 -> v2 (pure; plain JSON in, plain JSON out). v1 stored a manifest
 * item's REMAINING amount in `count` (regains decremented it) and recorded
 * each server-confirmed regain in the episode's `regained` list. v2 needs the
 * ORIGINAL lost count plus a separate `regained` counter, so each item becomes
 *   lost = v1 remaining + recorded regains of that key, regained = recorded regains,
 * with the state derived from those counters. Nothing is invented: no regain
 * that was not recorded, no item that was not in the manifest. A v1 `regained`
 * label (only possible at count 0, which v1 could never write) keeps its
 * recorded regains as both lost and regained. If v1's bounded regain list
 * dropped old entries, the reconstructed lost count is LOWER than the truth,
 * never higher, and the episode detail says the record was migrated.
 */
export function migrateV1Body(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const b = structuredClone(body) as { episodes?: Array<Record<string, unknown>> };
  for (const e of b.episodes ?? []) {
    const regainedByKey = new Map<string, number>();
    for (const r of (e['regained'] as Array<{ key?: unknown; count?: unknown }> | undefined) ?? []) {
      if (typeof r.key === 'string' && typeof r.count === 'number' && r.count > 0) regainedByKey.set(r.key, (regainedByKey.get(r.key) ?? 0) + r.count);
    }
    const manifest = e['manifest'] as { missing?: Array<Record<string, unknown>> } | undefined;
    for (const m of manifest?.missing ?? []) {
      const key = String(m['key']);
      const v1Count = typeof m['count'] === 'number' ? m['count'] : 0;
      const recorded = regainedByKey.get(key) ?? 0;
      if (m['state'] === 'regained') {
        const lost = recorded > 0 ? recorded : v1Count;
        m['count'] = lost;
        m['regained'] = lost;
        continue;
      }
      m['count'] = v1Count + recorded;
      m['regained'] = recorded;
      if (m['state'] === 'missing' && recorded > 0) m['state'] = v1Count > 0 ? 'partially_regained' : 'regained';
    }
    if (typeof e['detail'] === 'string' && (manifest?.missing?.length ?? 0) > 0) e['detail'] = `${e['detail'] ? `${e['detail']}; ` : ''}migrated from survival schema v1`.slice(0, 200);
  }
  return b;
}

export function checksum(body: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SurvivalStoreOptions {
  dir: string;
  scope: MemoryScope;
  now: () => number;
  keepRevisions?: number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** Test fault seam: runs after the temp file is durable and before the rename. */
  beforeRename?: (tmp: string) => void | Promise<void>;
}

export interface SurvivalLoad {
  body: SurvivalStoreBody | undefined;
  state: Exclude<SurvivalStoreState, 'unscoped' | 'disabled'>;
  detail: string;
  revision: number;
  corrupt: number[];
  discardedPartialWrites: number;
}

export class SurvivalFileStore {
  readonly dir: string;
  private readonly options: SurvivalStoreOptions;
  private readonly keep: number;
  private writable = false;
  private lockHeld = false;
  private queue: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  revision = 0;
  lastError: string | undefined;
  lastWriteAtMs: number | undefined;

  constructor(options: SurvivalStoreOptions) {
    this.options = options;
    this.dir = options.dir;
    this.keep = Math.max(2, options.keepRevisions ?? 3);
  }

  get canWrite(): boolean {
    return this.writable;
  }

  get pending(): number {
    return this.pendingCount;
  }

  /** Synchronous startup load (and writer lock). */
  open(): SurvivalLoad {
    mkdirSync(this.dir, { recursive: true });
    let discarded = 0;
    const revisions: number[] = [];
    for (const name of readdirSync(this.dir)) {
      if (TMP_RE.test(name)) {
        rmSync(join(this.dir, name), { force: true });
        discarded += 1;
        continue;
      }
      const m = FILE_RE.exec(name);
      if (m) revisions.push(Number(m[1]));
    }
    revisions.sort((a, b) => b - a);
    const corrupt: number[] = [];
    let body: SurvivalStoreBody | undefined;
    let loaded = 0;
    let loadedSchema = SURVIVAL_SCHEMA_VERSION as number;
    let newerSchema = false;
    for (const rev of revisions) {
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, `survival-${pad(rev)}.json`), 'utf8')) as Record<string, unknown>;
        if (typeof raw['schemaVersion'] === 'number' && raw['schemaVersion'] > SURVIVAL_SCHEMA_VERSION) {
          newerSchema = true;
          break;
        }
        // The checksum covers the body exactly as written (a v1 body has no v2 defaults yet).
        if (typeof raw['checksum'] !== 'string' || raw['checksum'] !== checksum(raw['body'])) throw new Error('checksum mismatch');
        // v1 -> v2 migration AFTER the raw checksum and BEFORE the v2 schema (defaults and consistency rules).
        const file = SurvivalStoreFileSchema.parse(raw['schemaVersion'] === 1 ? { ...raw, body: migrateV1Body(raw['body']) } : raw);
        const s = file.body.scope;
        const want = this.options.scope;
        if (s.worldProfile !== want.worldProfile || s.worldRevision !== want.worldRevision || s.botProfile !== want.botProfile) throw new Error('scope mismatch');
        body = file.body;
        loaded = rev;
        loadedSchema = file.schemaVersion;
        break;
      } catch {
        corrupt.push(rev);
      }
    }
    this.revision = Math.max(0, ...revisions);
    if (newerSchema) return { body: undefined, state: 'read_only', detail: `survival store was written by a newer schema; read-only (not overwritten)`, revision: this.revision, corrupt, discardedPartialWrites: discarded };
    if (!body && revisions.length > 0) return { body: undefined, state: 'read_only', detail: `no survival store revision verifies (${corrupt.length} unreadable); read-only, nothing replaced`, revision: this.revision, corrupt, discardedPartialWrites: discarded };
    const migrated = body && loadedSchema < SURVIVAL_SCHEMA_VERSION ? ` (schema v${loadedSchema} migrated to v${SURVIVAL_SCHEMA_VERSION}: lost = v1 remaining + recorded regains; nothing invented)` : '';
    this.writable = this.lock();
    const state = !body ? 'empty' : corrupt.length > 0 ? 'recovered' : 'ready';
    const detail = !this.writable
      ? 'another process holds the survival store writer lock; read-only'
      : !body
        ? 'no survival episodes recorded yet'
        : corrupt.length > 0
          ? `loaded revision ${loaded}${migrated}; newer unreadable revision(s) ${corrupt.join(', ')} kept for inspection`
          : `loaded revision ${loaded}${migrated}`;
    return { body, state: this.writable ? state : 'read_only', detail, revision: this.revision, corrupt, discardedPartialWrites: discarded };
  }

  private lock(): boolean {
    const path = join(this.dir, LOCK);
    const pid = this.options.pid ?? process.pid;
    const isAlive = this.options.isAlive ?? alive;
    for (let i = 0; i < 2; i += 1) {
      try {
        const fd = openSync(path, 'wx');
        writeFileSync(fd, String(pid));
        fsyncSync(fd);
        closeSync(fd);
        this.lockHeld = true;
        return true;
      } catch {
        let holder = NaN;
        try {
          holder = Number(readFileSync(path, 'utf8').trim());
        } catch {
          // unreadable lock: treat as stale
        }
        if (Number.isInteger(holder) && holder > 0 && holder !== pid && isAlive(holder)) return false;
        rmSync(path, { force: true });
      }
    }
    return false;
  }

  /** Queues one complete revision write; resolves with the revision or undefined on failure. */
  write(body: SurvivalStoreBody): Promise<number | undefined> {
    if (!this.writable) return Promise.resolve(undefined);
    const parsed = SurvivalStoreBodySchema.safeParse(body);
    if (!parsed.success) {
      // C9: name the exact invalid field so a rejected revision is diagnosable from the event alone.
      const issue = parsed.error.issues[0];
      this.lastError = `invalid survival body${issue?.path.length ? ` at ${issue.path.join('.')}` : ''}: ${issue?.message ?? 'invalid'}`;
      return Promise.resolve(undefined);
    }
    this.pendingCount += 1;
    const snapshot = structuredClone(parsed.data);
    const run = async (): Promise<number | undefined> => {
      const rev = this.revision + 1;
      const file = { format: SURVIVAL_FILE_FORMAT, schemaVersion: SURVIVAL_SCHEMA_VERSION, revision: rev, writtenAtMs: this.options.now(), checksum: checksum(snapshot), body: snapshot };
      const final = join(this.dir, `survival-${pad(rev)}.json`);
      const tmp = `${final}.tmp-${process.pid}-${rev}`;
      try {
        const fh = await open(tmp, 'wx');
        try {
          await fh.writeFile(JSON.stringify(file));
          await fh.sync();
        } finally {
          await fh.close();
        }
        await this.options.beforeRename?.(tmp);
        await rename(tmp, final);
        try {
          const dfd = openSync(this.dir, 'r');
          fsyncSync(dfd);
          closeSync(dfd);
        } catch {
          // directory fsync is best effort on some platforms
        }
        this.revision = rev;
        this.lastWriteAtMs = this.options.now();
        this.lastError = undefined;
        await this.prune();
        return rev;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        await rm(tmp, { force: true }).catch(() => undefined);
        return undefined;
      } finally {
        this.pendingCount -= 1;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  private async prune(): Promise<void> {
    const revs = readdirSync(this.dir)
      .map((n) => FILE_RE.exec(n))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map((m) => Number(m[1]))
      .sort((a, b) => b - a);
    for (const r of revs.slice(this.keep)) await rm(join(this.dir, `survival-${pad(r)}.json`), { force: true });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.lockHeld) rmSync(join(this.dir, LOCK), { force: true });
    this.lockHeld = false;
    this.writable = false;
  }
}
