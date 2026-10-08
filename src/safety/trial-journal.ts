// Offline-testable durability/cleanup core of the leased mechanics harness.
// No Minecraft, credentials, networking or gameplay actuation.
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TrialOriginal {
  difficulty: string;
  forceload: Array<{ cx: number; cz: number }>;
  forceloadReply: string;
}

export function parseForceload(reply: string): Array<{ cx: number; cz: number }> | undefined {
  if (/no (?:force[- ]?loaded )?chunks.*(?:force[- ]?loaded|found)|no force[- ]?loaded chunks/i.test(reply)) return [];
  if (!/force[- ]?loaded chunk/i.test(reply)) return undefined;
  const pairs = [...reply.matchAll(/\[(-?\d+),\s*(-?\d+)\]/g)].map((m) => ({ cx: Number(m[1]), cz: Number(m[2]) }));
  const count = /(\d+) force[- ]?loaded chunks/i.exec(reply)?.[1];
  const expected = count !== undefined ? Number(count) : /(?:is a|a single) force[- ]?loaded chunk/i.test(reply) ? 1 : undefined;
  if (expected === undefined || pairs.length !== expected) return undefined;
  if (new Set(pairs.map((p) => `${p.cx},${p.cz}`)).size !== pairs.length) return undefined;
  return pairs.sort((a, b) => a.cx - b.cx || a.cz - b.cz);
}

export function sameChunks(a: TrialOriginal['forceload'], b: TrialOriginal['forceload']): boolean {
  const keys = (xs: TrialOriginal['forceload']) => xs.map((p) => `${p.cx},${p.cz}`).sort().join('|');
  return keys(a) === keys(b);
}

export function parseEntityTest(reply: string): boolean | undefined {
  if (/^Test passed(?:(?:, count: |\. Count: )[1-9]\d*)?[.!]?$/i.test(reply.trim())) return true;
  if (/^Test failed[.!]?$/i.test(reply.trim())) return false;
  return undefined;
}

/** The plan and every command intent reach fsynced disk BEFORE their write. */
export class SafetyTrialJournal {
  private data: { version: 1; original: TrialOriginal | null; state: Record<string, unknown>; commands: Array<{ command: string; phase: string; atMs: number; reply?: string }> } = { version: 1, original: null, state: {}, commands: [] };
  private readonly path: string;
  constructor(path: string) { this.path = path; }

  capture(original: TrialOriginal): void {
    if (this.data.original) throw new Error('original trial state is immutable');
    if (!['peaceful', 'easy', 'normal', 'hard'].includes(original.difficulty)) throw new Error('original difficulty unknown');
    this.data.original = structuredClone(original);
    this.save();
  }

  remember(state: Record<string, unknown>): void {
    Object.assign(this.data.state, structuredClone(state));
    this.save();
  }

  before(command: string, phase: string): number {
    if (!this.data.original) throw new Error('refusing mutation before original settings/forceload were durably captured');
    this.data.commands.push({ command, phase, atMs: Date.now() });
    this.save();
    return this.data.commands.length - 1;
  }

  after(index: number, reply: string): void {
    const entry = this.data.commands[index];
    if (!entry) throw new Error('unknown trial command');
    entry.reply = reply.slice(0, 500);
    this.save();
  }

  snapshot() { return structuredClone(this.data); }

  private save(): void {
    const temp = `${this.path}.tmp`;
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(this.data, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.path);
    const dir = openSync(dirname(this.path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}

/** Concurrent signal and finally callers share one real settlement. */
export function cleanupOnce(fn: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => (pending ??= Promise.resolve().then(fn));
}
