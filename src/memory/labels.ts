// Label normalization and owner grounding.
//
// An owner designation ("remember this as home") is interpreted by the planner,
// but the DESIGNATION is trusted only when its label is quoted from the owner's
// own words (the goal instruction or the owner's clarification answers). This
// is provenance validation, not an intent table: any words are allowed as long
// as the owner said them. Labels the owner never used are kept only as
// unverified notes (or refused for destructive operations).

const STOP = new Set(['a', 'an', 'the', 'my', 'our', 'your', 'this', 'that', 'these', 'those', 'of', 'at', 'as', 'to', 'in', 'on', 'for', 'and', 'is', 'it', 'its', 'here', 'there', 'spot', 'place']);

/** Lowercase words of a text (letters/digits), bounded. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0)
    .slice(0, 400);
}

/** Canonical label key used for matching (content words joined by single spaces). */
export function labelKey(label: string): string {
  const content = words(label).filter((w) => !STOP.has(w));
  return (content.length > 0 ? content : words(label)).join(' ').slice(0, 80);
}

/** Singular-insensitive word comparison (logs/log, chests/chest). */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('es') && /(ches|shes|xes|ses)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * Whether every content word of `label` appears in the owner's text. Returns
 * the matched owner excerpt (bounded) for durable evidence, or undefined.
 */
export function ownerGrounding(label: string, ownerTexts: readonly string[]): { excerpt: string } | undefined {
  const wanted = labelKey(label).split(' ').filter(Boolean).map(stem);
  if (wanted.length === 0) return undefined;
  for (const text of ownerTexts) {
    const have = new Set(words(text).map(stem));
    if (wanted.every((w) => have.has(w))) return { excerpt: text.trim().slice(0, 200) };
  }
  // Words may be spread across the instruction and an answer.
  const all = new Set(ownerTexts.flatMap((t) => words(t).map(stem)));
  if (wanted.every((w) => all.has(w))) return { excerpt: ownerTexts.map((t) => t.trim()).join(' / ').slice(0, 200) };
  return undefined;
}

/** Relevance of a label/key to an instruction: shared content words (0 when none). */
export function relevance(instructionWords: ReadonlySet<string>, ...texts: Array<string | undefined>): number {
  let score = 0;
  const seen = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const w of words(t.replace(/^#?minecraft:/, '').replace(/_/g, ' '))) {
      const s = stem(w);
      if (STOP.has(w) || seen.has(s)) continue;
      seen.add(s);
      if (instructionWords.has(s)) score += 1;
    }
  }
  return score;
}

export function instructionWordSet(texts: readonly string[]): Set<string> {
  return new Set(texts.flatMap((t) => words(t)).filter((w) => !STOP.has(w)).map(stem));
}
