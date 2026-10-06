// Dashboard storage layout and bounded atomic file I/O. Only the bounded
// public status snapshot and the usage aggregates live here; run directories
// are never served.
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DashboardPaths {
  dir: string;
  status: string;
  history: string;
}

/** `<dataDir>/dashboard/{status.json,usage-history.json}` (dataDir is the ignored runtime storage). */
export function dashboardPaths(dataDir: string): DashboardPaths {
  const dir = join(dataDir, 'dashboard');
  return { dir, status: join(dir, 'status.json'), history: join(dir, 'usage-history.json') };
}

let tmpCounter = 0;

/** Write-then-rename so readers never observe a partial file. Owner-only permissions. */
export function writeAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  tmpCounter = (tmpCounter + 1) % 1_000_000;
  const tmp = `${path}.${process.pid}.${tmpCounter}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export type BoundedRead = { ok: true; text: string; mtimeMs: number } | { ok: false; reason: 'missing' | 'too_large' | 'unreadable'; detail: string };

/** Reads at most `maxBytes`; larger files are refused without being parsed. */
export function readBounded(path: string, maxBytes: number): BoundedRead {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { ok: false, reason: 'missing', detail: 'no file yet' } : { ok: false, reason: 'unreadable', detail: `cannot open (${code ?? 'error'})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'unreadable', detail: 'not a regular file' };
    if (st.size > maxBytes) return { ok: false, reason: 'too_large', detail: `${st.size} bytes exceeds the ${maxBytes}-byte bound` };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { ok: true, text: buf.subarray(0, off).toString('utf8'), mtimeMs: st.mtimeMs };
  } catch (error) {
    return { ok: false, reason: 'unreadable', detail: `read failed (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  } finally {
    closeSync(fd);
  }
}
