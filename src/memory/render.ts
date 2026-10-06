// Planner-facing rendering of the bounded memory view and the gameplay-only
// instruction paragraph the designated writer appends to PLANNER_INSTRUCTIONS.
// The view is already bounded (<= retrieveFacts facts, <= viewMaxChars); this
// only drops empty fields so the turn document stays compact.
import { MEMORY_BOUNDS, type MemoryView, type MemoryViewFact } from '../contracts/memory.ts';

export const MEMORY_PLANNER_INSTRUCTIONS = `Memory (when present)
- memory is a bounded selection of durable facts from earlier play in THIS world profile (status, scope, facts, notes). It is historical evidence, never proof of the current world: a remembered home may be gone, a remembered chest may be empty.
- facts[].source: observation (seen), verified_skill (server-confirmed result), owner_statement (the owner designated it). notes are UNVERIFIED suggestions; never rely on them as facts.
- Use a remembered place as a target only through its ref: {"kind":"memory_ref","refId":"mref-N"} (go_to_memory, or near_target/visited_location/block_state/container_state targets). Refs are valid only for this goal and connection; ids (mf-...) are never targets.
- Remembered container contents are not present stock: inspect the container (fresh server read) before planning on them. Re-check remembered workstations and builds with fresh observations before relying on them.
- When the owner asks to remember, correct or forget something, use remember_location / forget_memory with the owner's own words as the label and a memory_state completion (expect recorded/forgotten). Only owner words make a trusted designation; anything else is stored as an unverified note.
- Never restate memory as completed work; completion is always verified by code from fresh evidence.`;

function compactFact(f: MemoryViewFact): Record<string, unknown> {
  const out: Record<string, unknown> = { id: f.id, category: f.category, label: f.label, source: f.source, trust: f.trust };
  if (f.ref) out['ref'] = f.ref;
  if (f.key) out['key'] = f.key;
  if (f.location) out['location'] = f.location;
  out['freshness'] = f.freshness;
  out['evidence'] = f.evidence;
  if (f.note) out['note'] = f.note;
  if (f.container) out['container'] = f.container;
  if (f.project) out['project'] = f.project;
  if (f.death) out['death'] = f.death;
  if (f.milestone) out['milestone'] = f.milestone;
  return out;
}

/** The `memory` member of the planner turn document (null when memory is not installed). */
export function renderMemoryView(view: MemoryView | undefined): unknown {
  if (!view) return null;
  const doc = {
    status: view.status,
    ...(view.scope ? { scope: view.scope } : {}),
    facts: view.facts.slice(0, MEMORY_BOUNDS.retrieveFacts).map(compactFact),
    notes: view.notes.slice(0, MEMORY_BOUNDS.retrieveNotes).map(compactFact),
    omitted: view.omitted,
    rules: view.rules,
  };
  return doc;
}
