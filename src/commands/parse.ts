// Command parsing for Minecraft chat and the local terminal. There is no
// keyword gating of goals: anything that is not a reserved control verb is an
// open-ended instruction forwarded verbatim to the single goal intake surface.
//
// Reserved first words: `stop`, `status`, `answer`, and the explicit `goal`
// alias. Use `goal <text>` to send an instruction that starts with a reserved word.

export type ParsedCommand =
  | { kind: 'goal'; instruction: string; via: 'implicit' | 'goal_alias' }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'answer'; ref?: string; reply: string }
  | { kind: 'operator'; verb: OperatorVerb }
  /** Terminal-only operator mechanic diagnostics (`/diag ...`); never goals, never chat. */
  | { kind: 'diagnostic'; args: string }
  /** Terminal-only operator task controller diagnostic (`/task ...`); never chat, never natural-language goals. */
  | { kind: 'task'; args: string }
  | { kind: 'invalid'; detail: string };

/** Terminal-only operator commands (slash-prefixed so they never collide with instructions). */
export const OPERATOR_VERBS = ['quit', 'reconnect', 'help'] as const;
export type OperatorVerb = (typeof OPERATOR_VERBS)[number];

function firstWord(text: string): { word: string; rest: string } {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return { word: '', rest: '' };
  return { word: (match[1] ?? '').toLowerCase().replace(/[.!?,:;]+$/, ''), rest: (match[2] ?? '').trim() };
}

/** Parses the text after the prefix (chat) or a whole terminal line. */
export function parseCommandBody(body: string): ParsedCommand {
  const text = body.trim();
  const { word, rest } = firstWord(text);
  switch (word) {
    case 'stop':
      return { kind: 'stop' };
    case 'status':
      return { kind: 'status' };
    case 'goal':
      return { kind: 'goal', instruction: rest, via: 'goal_alias' };
    case 'answer': {
      const refMatch = /^(q[0-9]{1,6})(?:[:\s]+|$)([\s\S]*)$/i.exec(rest);
      if (refMatch) return { kind: 'answer', ref: (refMatch[1] ?? '').toLowerCase(), reply: (refMatch[2] ?? '').trim() };
      return { kind: 'answer', reply: rest };
    }
    default:
      // Includes the empty instruction; the intake rejects it before replacing work.
      return { kind: 'goal', instruction: text, via: 'implicit' };
  }
}

/**
 * Parses a chat line. Returns null when the line is not addressed to Chunkbot
 * (no prefix) — ordinary chat is data, not an instruction.
 */
export function parseChatLine(text: string, prefix: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (trimmed.length < prefix.length) return null;
  const head = trimmed.slice(0, prefix.length);
  if (head.toLowerCase() !== prefix.toLowerCase()) return null;
  const after = trimmed.slice(prefix.length);
  if (after.length > 0 && !/^\s/.test(after)) return null; // e.g. "!chunkbotfoo" is not addressed to Chunkbot
  return parseCommandBody(after);
}

/** Parses one terminal line. Returns null for blank lines. */
export function parseTerminalLine(line: string, prefix: string): ParsedCommand | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/')) {
    const verb = trimmed.slice(1).trim().toLowerCase();
    if (verb === 'diag' || verb.startsWith('diag ')) return { kind: 'diagnostic', args: trimmed.slice(1).trim().slice(4).trim() };
    if (verb === 'task' || verb.startsWith('task ')) return { kind: 'task', args: trimmed.slice(1).trim().slice(4).trim() };
    if (verb === 'exit') return { kind: 'operator', verb: 'quit' };
    if ((OPERATOR_VERBS as readonly string[]).includes(verb)) return { kind: 'operator', verb: verb as OperatorVerb };
    return { kind: 'invalid', detail: `unknown operator command /${verb}; try /help` };
  }
  // Operators may paste the chat form; it means the same thing.
  const chat = parseChatLine(trimmed, prefix);
  if (chat) return chat;
  return parseCommandBody(trimmed);
}
