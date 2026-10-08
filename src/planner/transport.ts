// One isolated `codex exec` turn in an app-owned process group.
//
// The JSONL event stream (exec_events.rs of the pinned CLI) is validated as it
// arrives. Allowed: thread.started, turn.started, turn.completed, turn.failed,
// error, and items of type agent_message (the structured final answer),
// reasoning (discarded, never stored) and error (warnings; a "model rerouted"
// error is a model fallback and rejects the turn). ANY other item type
// (command_execution, file_change, mcp_tool_call, collab_tool_call, web_search,
// todo_list, or an unknown type) is a prohibited tool/agent event: the turn is
// killed and rejected even if a valid-looking final JSON also arrives.
import type { CleanupEvidence, ProcessTable } from './process.ts';
import { OwnedProcess } from './process.ts';
import { classifyPlannerMessage, PlannerError } from './errors.ts';
import type { PlannerFailureKind } from '../contracts/index.ts';

/**
 * Token usage reported by the CLI's `turn.completed` event. Input and output
 * counts are required (otherwise the whole usage is unknown: `null`); the
 * cached-input and reasoning breakdowns are `null` when absent or invalid.
 * Absence is never turned into 0 (MB-UI-001-C1).
 */
export interface TurnUsage {
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number | null;
}

const tokenCount = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Parses a `turn.completed` usage object; null when the core input/output counts are missing or invalid. */
export function parseTurnUsage(raw: unknown): TurnUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const u = raw as Record<string, unknown>;
  const inputTokens = tokenCount(u['input_tokens']);
  const outputTokens = tokenCount(u['output_tokens']);
  if (inputTokens === null || outputTokens === null) return null;
  return { inputTokens, cachedInputTokens: tokenCount(u['cached_input_tokens']), outputTokens, reasoningOutputTokens: tokenCount(u['reasoning_output_tokens']) };
}

export interface TurnResult {
  finalText: string;
  usage: TurnUsage | null;
  threadId: string | null;
  elapsedMs: number;
  pid: number;
  /** Counts of stream event/item types seen (evidence; no content). */
  eventCounts: Record<string, number>;
  warnings: string[];
  cleanup: CleanupEvidence | null;
}

export interface TurnSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  table?: ProcessTable;
  /** Observes cleanup evidence of every terminated turn (also for failures). */
  onCleanup?(evidence: CleanupEvidence): void;
  /** Observes stream event types (no content), e.g. to detect `turn.started` in diagnostics. */
  onEvent?(type: string): void;
  /** First allowed agent-message stream item, before parsing its content or
   * waiting for process cleanup. Content/reasoning is never passed to observers. */
  onResponseStart?(): void;
}

const ALLOWED_ITEMS = new Set(['agent_message', 'reasoning', 'error']);
const MAX_FINAL_CHARS = 200_000;
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export async function runCodexTurn(spec: TurnSpec): Promise<TurnResult> {
  if (spec.signal.aborted) throw new PlannerError('aborted', 'the owning goal was revoked before the turn started');
  const started = Date.now();
  const counts: Record<string, number> = {};
  const warnings: string[] = [];
  let finalText: string | undefined;
  let usage: TurnUsage | null = null;
  let threadId: string | null = null;
  let turnCompleted = false;
  let failure: { kind: PlannerFailureKind; detail: string } | undefined;
  let streamError: string | undefined;
  let responseStarted = false;
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  let proc: OwnedProcess | undefined;
  let wake: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (wake = resolve));
  const fail = (kind: PlannerFailureKind, detail: string) => {
    if (!failure) failure = { kind, detail: clip(detail, 600) };
    proc?.discardOutput();
    wake();
  };

  const onLine = (line: string) => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return fail('invalid_output', `non-JSON line in the event stream: ${clip(line, 120)}`);
    }
    const type = String(ev['type'] ?? '');
    count(type);
    spec.onEvent?.(type);
    switch (type) {
      case 'thread.started':
        threadId = typeof ev['thread_id'] === 'string' ? clip(ev['thread_id'], 64) : null;
        return;
      case 'turn.started':
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = (ev['item'] ?? {}) as Record<string, unknown>;
        const itemType = String(item['type'] ?? '');
        count(`item:${itemType}`);
        if (!ALLOWED_ITEMS.has(itemType)) return fail('prohibited_event', `prohibited ${itemType || 'untyped'} item in the planner stream (tools/agents are not allowed); the turn is rejected even if a final answer follows`);
        if (itemType === 'agent_message' && !responseStarted) {
          responseStarted = true;
          spec.onResponseStart?.();
        }
        if (itemType === 'error') {
          const message = String(item['message'] ?? '');
          if (classifyPlannerMessage(message) === 'model_mismatch') return fail('model_mismatch', clip(message, 300));
          if (warnings.length < 8) warnings.push(clip(message, 300));
          return;
        }
        if (itemType === 'agent_message' && type === 'item.completed') {
          const text = String(item['text'] ?? '');
          if (text.length > MAX_FINAL_CHARS) return fail('invalid_output', `final message exceeds ${MAX_FINAL_CHARS} characters`);
          finalText = text;
        }
        return; // reasoning content is never read or stored
      }
      case 'turn.completed': {
        turnCompleted = true;
        usage = parseTurnUsage(ev['usage']);
        return;
      }
      case 'turn.failed': {
        const message = String(((ev['error'] ?? {}) as Record<string, unknown>)['message'] ?? streamError ?? 'turn failed');
        return fail(classifyPlannerMessage(message), message);
      }
      case 'error':
        streamError = clip(String(ev['message'] ?? 'stream error'), 600);
        if (classifyPlannerMessage(streamError) === 'model_mismatch') return fail('model_mismatch', streamError);
        return;
      default:
        return fail('prohibited_event', `unknown event type ${clip(type, 40)} in the planner stream (CLI protocol changed; fail closed)`);
    }
  };

  try {
    proc = new OwnedProcess({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      stdin: spec.prompt,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxLineBytes: 512 * 1024,
      maxStderrBytes: 8_000,
      onLine,
      onOverflow: (what) => fail('invalid_output', what),
      ...(spec.table ? { table: spec.table } : {}),
    });
  } catch (error) {
    throw new PlannerError('process_error', `cannot start the planner process: ${error instanceof Error ? error.message : String(error)}`);
  }
  const owned = proc;
  let timer: NodeJS.Timeout | undefined;
  const onAbort = () => {
    const reason = spec.signal.reason instanceof Error ? spec.signal.reason.message : '';
    fail('aborted', reason ? `turn aborted: ${clip(reason, 120)}` : 'the owning goal was revoked (stop, replacement, lifecycle or deadline)');
  };
  spec.signal.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(() => fail('timeout', `planner turn exceeded ${spec.timeoutMs} ms`), spec.timeoutMs);
  let cleanup: CleanupEvidence | null = null;
  try {
    await Promise.race([owned.exited, stopped]);
    if (failure || !owned.hasExited) {
      cleanup = await owned.terminate(failure?.kind ?? 'stopped');
      spec.onCleanup?.(cleanup);
    } else {
      // Normal exit: verify nothing attributable was left behind.
      cleanup = await owned.terminate('exited');
      if (cleanup.remaining.length > 0 || cleanup.signals.length > 0) spec.onCleanup?.(cleanup);
    }
  } finally {
    if (timer) clearTimeout(timer);
    spec.signal.removeEventListener('abort', onAbort);
  }
  const elapsedMs = Date.now() - started;
  if (failure) {
    const f = failure as { kind: PlannerFailureKind; detail: string };
    throw new PlannerError(f.kind, f.detail);
  }
  const exit = await owned.exited;
  if (exit.code !== 0) {
    const text = streamError ?? owned.stderr.trim().split('\n').slice(-3).join(' ');
    throw new PlannerError(classifyPlannerMessage(text || 'exit'), `planner process exited ${exit.code ?? exit.signal}: ${clip(text || 'no detail', 400)}`);
  }
  if (!turnCompleted || finalText === undefined) {
    throw new PlannerError('invalid_output', `the turn ended without ${turnCompleted ? 'a final message' : 'turn.completed'}${streamError ? ` (${streamError})` : ''}`);
  }
  return { finalText, usage, threadId, elapsedMs, pid: owned.pid, eventCounts: counts, warnings, cleanup };
}
