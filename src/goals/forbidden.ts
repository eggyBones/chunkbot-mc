// Forbidden planner content. Plans are declarative data: they never carry
// executable code, and they never change limits, providers, models,
// permissions or configuration. Applied to raw planner output and to the
// converted proposal before any validation that could lead to an action.
/** Keys that would carry code or try to change limits/provider/model/permissions. Never part of a proposal. */
const FORBIDDEN_KEY = /^(code|script|scripts|javascript|js|eval|function|functions|exec|command|commands|shell|program|source|limits?|maxturns|maxtasks|deadline\w*|timeout\w*|budget|spend\w*|cost\w*|provider|providers|model|models|apikey|api_key|key_env|permissions?|sandbox|approval\w*|config|settings|features?|tools?)$/i;

/** Executable-code markers in free text. World text and owner text are data; plans never carry code. */
const CODE_MARKERS: ReadonlyArray<[RegExp, string]> = [
  [/```/, 'a code fence'],
  [/\bfunction\s*\w*\s*\(/i, 'a function definition'],
  [/\([\w\s,]*\)\s*=>|\b\w+\s*=>\s*\{/, 'an arrow function'],
  [/\b(require|import)\s*\(|^\s*import\s+[\w{*]/im, 'a module import'],
  [/\beval\s*\(|new\s+Function\s*\(/i, 'dynamic code evaluation'],
  [/<\s*script\b/i, 'a script tag'],
  [/\bprocess\.(env|exit|kill)|child_process|\bspawn\s*\(|\bexecSync\b/i, 'process access'],
  [/\bbot\.[a-zA-Z_]+\s*\(|\bmineflayer\b/i, 'direct bot API calls'],
  [/\bawait\s+\w+\s*\(|\bconst\s+\w+\s*=|\blet\s+\w+\s*=|\bvar\s+\w+\s*=/, 'program statements'],
  [/;\s*\}|\}\s*;\s*$/m, 'statement braces'],
];

export function codeMarker(text: string): string | undefined {
  for (const [re, label] of CODE_MARKERS) if (re.test(text)) return label;
  return undefined;
}

/** Walks raw planner output; returns problems for forbidden keys and code-bearing strings. */
export function scanForbidden(value: unknown, path = '(root)', out: string[] = [], depth = 0): string[] {
  if (out.length >= 12) return out;
  if (depth > 24) {
    out.push(`${path}: nesting is too deep`);
    return out;
  }
  if (typeof value === 'string') {
    const marker = codeMarker(value);
    if (marker) out.push(`${path}: code-bearing text (${marker}); plans carry declarative steps, never executable code`);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanForbidden(v, `${path}[${i}]`, out, depth + 1));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k) && !(k === 'key' || k === 'output')) {
        out.push(`${path}.${k}: forbidden field (executable code, limit, provider, model, permission or configuration changes are not plan content)`);
        continue;
      }
      scanForbidden(v, `${path}.${k}`, out, depth + 1);
    }
  }
  return out;
}

