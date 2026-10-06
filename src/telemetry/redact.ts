// Redaction and bounding for evidence. Evidence must never contain auth
// secrets, API keys, personal account identifiers, or unbounded payloads.

const SECRET_KEY_SUFFIXES = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'privatekey',
  'usercode',
  'devicecode',
  'accesscode',
] as const;

/** True for field names that hold secrets (`accessToken`, `api_key`), not counts (`inputTokens`). */
export function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
  return SECRET_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\bsk-[A-Za-z0-9_-]{10,}\b/g, // OpenAI/OpenRouter-style keys
  /\b[A-Za-z0-9+/_-]{48,}={0,2}/g, // long opaque tokens
];

const UUID_RE = /\b([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\b/gi;

export interface RedactOptions {
  maxStringChars: number;
  maxArrayItems: number;
  maxDepth: number;
}

export const DEFAULT_REDACT: RedactOptions = { maxStringChars: 2_000, maxArrayItems: 32, maxDepth: 6 };

export function redactString(value: string, maxChars: number): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, '[redacted]');
  // Personal account identifiers: keep a short prefix for correlation only.
  out = out.replace(UUID_RE, (_m, a: string) => `uuid:${a.slice(0, 4)}…`);
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…[truncated ${out.length - maxChars} chars]`;
  return out;
}

export function redact(value: unknown, options: RedactOptions = DEFAULT_REDACT, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value, options.maxStringChars);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { error: value.name, message: redactString(value.message, options.maxStringChars) };
  }
  if (depth >= options.maxDepth) return '[depth limit]';
  if (Array.isArray(value)) {
    const items = value.slice(0, options.maxArrayItems).map((v) => redact(v, options, depth + 1));
    if (value.length > options.maxArrayItems) items.push(`[${value.length - options.maxArrayItems} more items]`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? '[redacted]' : redact(v, options, depth + 1);
    }
    return out;
  }
  return `[${typeof value}]`;
}
