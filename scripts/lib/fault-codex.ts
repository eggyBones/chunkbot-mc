// PLANNER FAULT FIXTURE for live harnesses (never acceptance evidence for
// planning quality). Writes an executable stand-in for the `codex` CLI into a
// harness directory:
//   * `--version`, `debug models --bundled` and `features list` are passed
//     through to the REAL installed CLI, so the application's isolation gate
//     runs against real installed data;
//   * `exec` reads the prompt from stdin and replays a scripted JSONL event
//     stream chosen by a control file next to the script (the application
//     scrubs the environment, so the fixture cannot be steered by env vars).
// Scripted behaviors: a proposal sequence (one entry per exec turn), a quota
// failure, a model reroute event, a prohibited tool event, and a hang that also
// spawns an attributable child process (to verify process-group cleanup).
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type FaultTurn =
  /** `usage`: override the turn.completed usage object (null omits it) for usage-parsing tests. */
  | { kind: 'proposal'; proposal: unknown; delayMs?: number; usage?: Record<string, unknown> | null }
  | { kind: 'quota' }
  | { kind: 'auth' }
  | { kind: 'reroute'; proposal: unknown }
  | { kind: 'tool'; proposal: unknown }
  | { kind: 'hang' };

export type FaultAuthMode = 'passthrough' | 'chatgpt' | 'api_key' | 'absent' | 'other';

export interface FaultControl {
  realCodex: string;
  turns: FaultTurn[];
  /** `login status` answer: passthrough to the real CLI (default) or a scripted mode line. */
  authMode?: FaultAuthMode;
}

const SCRIPT = (node: string) => `#!${node}
// Generated planner fault fixture (see scripts/lib/fault-codex.ts). Harness validation only.
const { readFileSync, writeFileSync, existsSync, appendFileSync } = require('node:fs');
const { spawnSync, spawn } = require('node:child_process');
const { join } = require('node:path');
const dir = __dirname;
const control = JSON.parse(readFileSync(join(dir, 'fault-codex-control.json'), 'utf8'));
const args = process.argv.slice(2);
const isExec = args.includes('exec');
(function main() {
if (args[0] === 'login' && control.authMode && control.authMode !== 'passthrough') {
  // Mode lines exactly as the pinned CLI prints them (cli/src/login.rs); never a real credential.
  const line = { chatgpt: 'Logged in using ChatGPT', api_key: 'Logged in using an API key - sk-fixtu***never', absent: 'Not logged in', other: 'Logged in using personal access token' }[control.authMode] || 'garbled';
  process.stderr.write(line + '\\n');
  process.exitCode = control.authMode === 'absent' ? 1 : 0;
  return;
}
if (!isExec) {
  const r = spawnSync(control.realCodex, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exitCode = r.status === null ? 1 : r.status; // let the pipes drain (no process.exit)
  return;
}
const counterPath = join(dir, 'fault-codex-counter.json');
const n = existsSync(counterPath) ? JSON.parse(readFileSync(counterPath, 'utf8')).n : 0;
writeFileSync(counterPath, JSON.stringify({ n: n + 1 }));
const turn = control.turns[Math.min(n, control.turns.length - 1)] || { kind: 'quota' };
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  writeFileSync(join(dir, 'fault-codex-last-prompt-chars.json'), JSON.stringify({ n, chars: input.length, hasJevKeyName: /OPENROUTER|sk-or-/.test(JSON.stringify(process.env)) }));
  // Structural metadata of the planner input (no content): which goal origin and context blocks it carried.
  let meta = {};
  try {
    const doc = JSON.parse(input.split('\\n').find((l) => l.startsWith('{')) || '{}');
    const g = doc.goal || {};
    meta = { origin: g.origin || null, subject: g.status || null, turnKind: g.turnKind || null, autonomy: doc.autonomy ? { source: doc.autonomy.source && doc.autonomy.source.kind, home: doc.autonomy.home ? doc.autonomy.home.state : null, milestones: (doc.autonomy.recentMilestones || []).length, plannerTurnsLeft: doc.autonomy.session && doc.autonomy.session.plannerTurnsLeft } : null, route: Boolean(doc.route), locator: Boolean(doc.locator) };
  } catch (e) { meta = { parseError: String(e).slice(0, 120) }; }
  appendFileSync(join(dir, 'fault-codex-prompts.jsonl'), JSON.stringify({ n, atMs: Date.now(), chars: input.length, ...meta }) + '\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'thread.started', thread_id: 'fault-fixture-thread-' + n });
  out({ type: 'turn.started' });
  const usage = { input_tokens: Math.round(input.length / 4), cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0 };
  const final = (p) => { out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: JSON.stringify(p) } }); const u = 'usage' in turn ? turn.usage : usage; out(u === null ? { type: 'turn.completed' } : { type: 'turn.completed', usage: u }); };
  switch (turn.kind) {
    case 'proposal':
      setTimeout(() => { final(turn.proposal); process.exit(0); }, turn.delayMs || 50);
      return;
    case 'quota':
      out({ type: 'error', message: "You've hit your usage limit. Upgrade to Pro or try again later." });
      out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro or try again later." } });
      process.exit(1);
      return;
    case 'auth':
      out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: please log in again' } });
      process.exit(1);
      return;
    case 'reroute':
      out({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'model rerouted: gpt-6.1-sol -> gpt-fallback-mini (capacity)' } });
      final(turn.proposal);
      process.exit(0);
      return;
    case 'tool':
      out({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: null, status: 'in_progress' } });
      final(turn.proposal);
      process.exit(0);
      return;
    case 'hang': {
      const child = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
      writeFileSync(join(dir, 'fault-codex-hang-child.json'), JSON.stringify({ parent: process.pid, child: child.pid }));
      setInterval(() => {}, 1000);
      return;
    }
  }
});
})();
`;

/** Writes the fixture script; returns its path. `control` is (re)written with `setFaultTurns`. */
export function writeFaultCodex(dir: string, realCodex: string): string {
  const path = join(dir, 'fault-codex.cjs');
  writeFileSync(path, SCRIPT(process.execPath));
  chmodSync(path, 0o755);
  setFaultTurns(dir, realCodex, []);
  return path;
}

export function setFaultTurns(dir: string, realCodex: string, turns: FaultTurn[], authMode: FaultAuthMode = 'passthrough'): void {
  const control: FaultControl = { realCodex, turns, authMode };
  writeFileSync(join(dir, 'fault-codex-control.json'), JSON.stringify(control));
  writeFileSync(join(dir, 'fault-codex-counter.json'), JSON.stringify({ n: 0 }));
}
