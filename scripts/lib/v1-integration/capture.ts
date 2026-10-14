// Credential-free sidecar reader for the coordinator's approved transport
// capture sink. Reading a file is never proof: the oracle binds every body to
// the application's actual request ID/timestamp/digest and complete coverage.
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { ModelCaptureReader, PayloadCapture } from './types.ts';

export function parseCapture(value: unknown, goalId: string): { captures: PayloadCapture[]; complete: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid capture envelope');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => !['version', 'captures', 'completeGoalIds'].includes(k)) || v.version !== 1 || !Array.isArray(v.captures) || v.captures.length > 2_000 || !Array.isArray(v.completeGoalIds) || v.completeGoalIds.some((id) => typeof id !== 'string')) throw new Error('invalid or incomplete capture envelope');
  const captures = v.captures.map((raw: unknown): PayloadCapture => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid payload capture');
    const c = raw as Record<string, unknown>;
    if (Object.keys(c).some((k) => !['provider', 'requestId', 'goalId', 'atMs', 'body', 'attempt'].includes(k)) || !['planner', 'jev'].includes(String(c.provider)) || typeof c.requestId !== 'string' || !c.requestId || typeof c.goalId !== 'string' || !c.goalId || typeof c.atMs !== 'number' || !Number.isFinite(c.atMs) || typeof c.body !== 'string' || c.body.length > 256_000 || (c.attempt !== undefined && (!Number.isSafeInteger(c.attempt) || Number(c.attempt) < 1))) throw new Error('invalid payload capture (credentials/headers/private reasoning are not admitted fields)');
    return c as unknown as PayloadCapture;
  });
  return { captures: captures.filter((c) => c.goalId === goalId), complete: v.completeGoalIds.includes(goalId) };
}
export function captureReader(root: string, file: string): ModelCaptureReader {
  return { async read(goalId) {
    const allowed = realpathSync(join(root, 'var', 'live-check')) + sep;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || !realpathSync(file).startsWith(allowed)) throw new Error('capture sidecar must be a regular file <=16 MiB inside this worktree var/live-check');
    return parseCapture(JSON.parse(readFileSync(file, 'utf8')) as unknown, goalId);
  } };
}
