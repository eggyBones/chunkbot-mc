import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ManagerFault, type ManagerLease } from './ports.ts';

/** A single shared profile path MUST be supplied by integration, never release-local. */
export function acquireManagerLease(directory: string): ManagerLease & { release(): void } {
  if (!isAbsolute(directory)) throw new ManagerFault('ownership_unproven', 'manager lease must be absolute');
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch { throw new ManagerFault('ownership_unproven', 'manager profile lease already exists or is unavailable; no automatic stale takeover'); }
  const file = join(directory, 'owner.json');
  const token = randomUUID();
  let released = false;
  try { writeFileSync(file, JSON.stringify({ version: 1, token, pid: process.pid }), { mode: 0o600, flag: 'wx' }); }
  catch {
    // Fail closed, retaining the directory for explicit inspection if the write failed.
    throw new ManagerFault('ownership_unproven', 'manager lease ownership write failed');
  }
  const assertHeld = () => {
    try {
      const stat = lstatSync(directory);
      const owner = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown; pid?: unknown };
      if (released || !stat.isDirectory() || stat.isSymbolicLink() || owner.token !== token || owner.pid !== process.pid) throw new Error('lost lease');
    } catch { throw new ManagerFault('ownership_unproven', 'manager profile lease ownership lost'); }
  };
  return {
    assertHeld,
    // Call only AFTER manager.off() proved cleanup; retained on uncertain cleanup/crash.
    release() { assertHeld(); unlinkSync(file); rmdirSync(directory); released = true; },
  };
}
