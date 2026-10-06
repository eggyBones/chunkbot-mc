// Human-readable summary of a goal's accepted outcome contract for the
// dashboard's main flow. It is a generic rendering of the code-owned predicate
// vocabulary (atomic predicates composed with all/any/not), not a list of
// known intents. The goal record carries `"<kind>: <predicate JSON>"`
// (bounded; it may be truncated). Anything that does not parse/validate is NOT
// guessed at: the summary is null and only the technical text is offered.
import { OutcomePredicateSchema, type OutcomePredicate } from '../contracts/predicate.ts';
import type { TargetSelector } from '../contracts/selector.ts';

export interface OutcomeText {
  /** Concise owner-facing sentence, or null when the contract could not be read. */
  summary: string | null;
  /** The raw bounded contract text (for an optional technical disclosure). */
  technical: string;
}

const thing = (key: string): string => {
  const tag = key.startsWith('#');
  const words = key.replace(/^#/, '').replace(/^minecraft:/, '').replace(/[_/]/g, ' ').trim();
  return tag ? `any ${words}` : words;
};

const qty = (n: number, key: string) => (key.startsWith('#') ? `${n} of ${thing(key)}` : `${n} ${thing(key)}`);

const SLOT: Record<string, string> = { hand: 'main hand', off_hand: 'off hand', head: 'head slot', torso: 'chest slot', legs: 'legs slot', feet: 'feet slot' };

export function describeTarget(t: TargetSelector): string {
  switch (t.kind) {
    case 'registry':
      return thing(t.key);
    case 'observed':
      return 'a target it observed';
    case 'remembered_anchor':
      return 'a remembered place';
    case 'owner_destination':
      return `“${t.ownerText}” (${Math.round(t.at.x)} ${Math.round(t.at.y)} ${Math.round(t.at.z)}, ${t.dimension.replace(/^minecraft:/, '')})`;
    case 'owner':
      return 'you';
    case 'prior_result':
      return 'something it made earlier';
  }
}

export function describePredicate(p: OutcomePredicate): string {
  switch (p.predicate) {
    case 'inventory_amount':
      return p.mode === 'possess' ? `holds at least ${qty(p.atLeast, p.selector)}` : `collects ${qty(p.atLeast, p.selector)} more than it had at the start`;
    case 'inventory_delta':
      return `gains ${qty(p.atLeast, p.selector)} since the goal started${p.mayBeConsumedLater ? ' (they may be used up afterwards)' : ''}`;
    case 'equipped':
      return `has ${thing(p.selector)} in its ${SLOT[p.slot] ?? p.slot}`;
    case 'near_target':
      return `is within ${p.within} blocks of ${describeTarget(p.target)}`;
    case 'visited_location':
      return `has been within ${p.within} blocks of ${describeTarget(p.target)}`;
    case 'block_state':
      return `confirms ${describeTarget(p.target)} is ${thing(p.expect)}`;
    case 'container_state':
      return `confirms ${describeTarget(p.target)} contains at least ${qty(p.atLeast, p.selector)}`;
    case 'crafting_result':
      return `crafts ${qty(p.atLeast, p.output)}`;
    case 'smelting_result':
      return `takes ${qty(p.atLeast, p.output)} out of a furnace`;
    case 'entity_outcome':
      return p.outcome === 'observed_defeated' ? `sees ${describeTarget(p.target)} defeated` : `sees ${describeTarget(p.target)} present`;
    case 'all':
      return join(p.of, 'and');
    case 'any':
      return join(p.of, 'or');
    case 'not':
      return `no longer meets this: ${part(p.of)}`;
  }
}

const isComposite = (p: OutcomePredicate) => p.predicate === 'all' || p.predicate === 'any' || p.predicate === 'not';
const part = (p: OutcomePredicate) => (isComposite(p) ? `(${describePredicate(p)})` : describePredicate(p));

function join(of: OutcomePredicate[], word: 'and' | 'or'): string {
  const parts = of.map(part);
  if (parts.length === 1) return describePredicate(of[0]!);
  if (parts.length === 2) return `${parts[0]} ${word} ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, ${word} ${parts[parts.length - 1]}`;
}

/** Parses the goal record's bounded outcome text; never invents a summary for unreadable input. */
export function describeOutcome(text: string): OutcomeText {
  const m = /^(finite|persistent): ([\s\S]*)$/.exec(text);
  if (!m) return { summary: null, technical: text };
  let raw: unknown;
  try {
    raw = JSON.parse(m[2] ?? '');
  } catch {
    return { summary: null, technical: text };
  }
  const p = OutcomePredicateSchema.safeParse(raw);
  if (!p.success) return { summary: null, technical: text };
  const body = describePredicate(p.data);
  return { summary: m[1] === 'finite' ? `Done when the bot ${body}.` : `Keeps going while the bot ${body} (until stopped or blocked).`, technical: text };
}
