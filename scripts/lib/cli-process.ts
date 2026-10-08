// Drives the real built CLI (`node dist/cli.js ...`) as a child process for
// live checks: line capture, pattern waits, and `[diag-json]` parsing.
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROJECT_ROOT } from '../../src/app/fixture-layout.ts';

export const CLI = join(PROJECT_ROOT, 'dist', 'cli.js');

export class CliProcess {
  readonly lines: Array<{ atMs: number; text: string }> = [];
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly name: string;
  private cursor = 0;

  constructor(name: string, args: string[], env?: NodeJS.ProcessEnv) {
    this.name = name;
    this.child = spawn(process.execPath, [CLI, ...args], { cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    const collect = (stream: NodeJS.ReadableStream | null, prefix: string) => {
      let partial = '';
      stream?.on('data', (chunk: Buffer) => {
        partial += chunk.toString('utf8');
        const parts = partial.split('\n');
        partial = parts.pop() ?? '';
        for (const line of parts) this.lines.push({ atMs: Date.now(), text: `${prefix}${line}` });
      });
    };
    collect(this.child.stdout, '');
    collect(this.child.stderr, 'stderr: ');
    this.exited = new Promise((resolve) => this.child.on('exit', (code, signal) => resolve({ code, signal })));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Waits for a line matching `pattern` after the cursor; advances past it. */
  async waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = this.cursor; i < this.lines.length; i += 1) {
        const line = this.lines[i]?.text ?? '';
        if (pattern.test(line)) {
          this.cursor = i + 1;
          return line;
        }
      }
      await sleep(20);
    }
    throw new Error(`${this.name}: timed out waiting for ${pattern}; last lines:\n${this.lines.slice(-10).map((l) => l.text.slice(0, 300)).join('\n')}`);
  }

  /** Waits for the next `[diag-json]` line of a kind and returns its parsed payload. */
  async json<T = Record<string, unknown>>(kind: string, timeoutMs = 30_000): Promise<T> {
    const line = await this.waitFor(new RegExp(`^\\[diag-json\\] \\{"kind":"${kind}"`), timeoutMs);
    return JSON.parse(line.slice('[diag-json] '.length)) as T;
  }

  /** Index for `waitSince`: lines from here on are searched regardless of the cursor. */
  get length(): number {
    return this.lines.length;
  }

  /** Every output line at or after `fromIndex` (does not move the cursor). */
  since(fromIndex: number): string[] {
    return this.lines.slice(fromIndex).map((l) => l.text);
  }

  /** Waits for a line matching `pattern` at or after `fromIndex` (does not move the cursor). */
  async waitSince(pattern: RegExp, fromIndex: number, timeoutMs = 20_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.lines.slice(fromIndex).find((l) => pattern.test(l.text));
      if (hit) return hit.text;
      await sleep(20);
    }
    throw new Error(`${this.name}: timed out waiting for ${pattern} since line ${fromIndex}`);
  }

  send(line: string): number {
    this.child.stdin?.write(`${line}\n`);
    return Date.now();
  }

  mark(): void {
    this.cursor = this.lines.length;
  }

  save(dir: string): void {
    writeFileSync(join(dir, `${this.name}.log`), `${this.lines.map((l) => `${new Date(l.atMs).toISOString()} ${l.text}`).join('\n')}\n`);
  }
}
