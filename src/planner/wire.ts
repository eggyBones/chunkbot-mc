// Strict planner OUTPUT wire format for the Codex `--output-schema` turn.
//
// The structured-output server mode needs a closed JSON schema: every object
// lists all of its properties as required and forbids additional properties,
// and the root is a single object. Optional contract fields are therefore
// nullable wire fields, open parameter records are `{name, valueJson}` pairs,
// and recursive predicates use `$defs`. The schema is GENERATED from the
// implemented capability catalog and the code-owned contract vocabulary, so
// the planner cannot name an unimplemented capability, predicate, selector or
// knowledge kind; it is never hand-maintained per goal.
//
// The conversion back to the shared `PlannerProposal` contract is strict as
// well: a field that does not belong to the chosen disposition/predicate/
// selector kind must be null or empty. Forbidden keys (code, limits, provider
// or model changes) and code-bearing text are rejected before any validation
// that could lead to an action. Schema conformance is only the first gate;
// the goal engine then validates references and semantics (src/goals/proposal.ts).
import { createHash } from 'node:crypto';
import {
  KnowledgeQuerySchema,
  PLANNER_PROPOSAL_VERSION,
  type CapabilityCatalog,
  type JsonValue,
  type KnowledgeQuery,
  type OutcomePredicate,
  type PlannerProposal,
  type TargetSelector,
  type TaskSpec,
} from '../contracts/index.ts';
import { scanForbidden } from '../goals/forbidden.ts';
import { ownerQuestionProblems } from '../goals/declarative.ts';
import { SURVIVAL_CAPABILITIES, SURVIVAL_ROUTINES } from '../contracts/survival.ts';

/** MB-PLAN-006: there is no owner-question disposition (Chunkbot never asks follow-up questions). */
export const DISPOSITIONS = ['plan', 'needs_information', 'cannot_execute'] as const;

/** Wire fields each predicate kind uses (mirrors the contract's AtomicPredicateSchema). */
export const PREDICATE_FIELDS = {
  inventory_amount: ['selector', 'atLeast', 'mode'],
  inventory_delta: ['selector', 'atLeast', 'mayBeConsumedLater'],
  equipped: ['selector', 'slot'],
  near_target: ['target', 'within'],
  visited_location: ['target', 'within'],
  block_state: ['target', 'expect'],
  container_state: ['target', 'selector', 'atLeast'],
  crafting_result: ['output', 'atLeast'],
  smelting_result: ['output', 'atLeast'],
  entity_outcome: ['target', 'outcome'],
  /** MB-PLAN-006: removal of one observed block group / block. */
  blocks_removed: ['target', 'selector'],
  /** MB-MEM-001 (offered only when memory capabilities are installed). */
  memory_state: ['label', 'expect'],
  /** MB-FLOW-001 (offered only when home construction capabilities are installed). */
  structure_state: ['structure', 'expect'],
  /** MB-FLOW-003 (offered only when survival capabilities are installed). */
  survival_state: ['routine', 'expect'],
  all: ['of'],
  any: ['of'],
  not: ['of'],
} as const satisfies Record<string, readonly string[]>;
type PredicateKindWire = keyof typeof PREDICATE_FIELDS;
const PREDICATE_KINDS = Object.keys(PREDICATE_FIELDS) as PredicateKindWire[];
const ALL_PREDICATE_FIELDS = ['selector', 'atLeast', 'mode', 'mayBeConsumedLater', 'slot', 'target', 'within', 'expect', 'output', 'outcome', 'of', 'label', 'structure', 'routine'] as const;
/** Predicate kinds whose `expect` is an enum word, never a registry key (no namespace normalization). */
const ENUM_EXPECT = new Set<string>(['memory_state', 'structure_state', 'survival_state']);

/** Wire fields each selector kind uses (mirrors the contract's TargetSelectorSchema). */
export const SELECTOR_FIELDS = {
  registry: ['key'],
  observed: ['snapshotId', 'handle'],
  remembered_anchor: ['anchorId'],
  owner_destination: ['dimension', 'at', 'ownerText'],
  owner: [],
  prior_result: ['actionId'],
  /** MB-MEM-001 (offered only when memory capabilities are installed). */
  memory_ref: ['refId'],
} as const satisfies Record<string, readonly string[]>;
type SelectorKindWire = keyof typeof SELECTOR_FIELDS;
const SELECTOR_KINDS = Object.keys(SELECTOR_FIELDS) as SelectorKindWire[];
const ALL_SELECTOR_FIELDS = ['key', 'snapshotId', 'handle', 'anchorId', 'dimension', 'at', 'ownerText', 'actionId', 'refId'] as const;

/** Memory vocabulary is offered to the planner only when memory capabilities are registered. */
export const MEMORY_CAPABILITIES = ['remember_location', 'forget_memory', 'note_memory', 'go_to_memory'] as const;
export function catalogHasMemory(catalog: CapabilityCatalog): boolean {
  return catalog.capabilities.some((c) => (MEMORY_CAPABILITIES as readonly string[]).includes(c.id));
}
/** MB-FLOW-001 home construction capabilities (structure_state is offered only with them). */
export const CONSTRUCTION_CAPABILITIES = ['select_home_site', 'build_home'] as const;
export function catalogHasConstruction(catalog: CapabilityCatalog): boolean {
  return catalog.capabilities.some((c) => (CONSTRUCTION_CAPABILITIES as readonly string[]).includes(c.id));
}
/** MB-FLOW-003 survival capabilities (survival_state is offered only with them). */
export function catalogHasSurvival(catalog: CapabilityCatalog): boolean {
  const ids = Object.values(SURVIVAL_CAPABILITIES) as readonly string[];
  return catalog.capabilities.some((c) => ids.includes(c.id));
}

/** Knowledge query kinds and the contract field the wire `key` maps to. */
export const QUERY_KEY_FIELD: Record<KnowledgeQuery['kind'], string | null> = {
  item: 'key',
  recipe: 'output',
  harvest: 'block',
  tool: 'forBlock',
  smelting: 'input',
  capability: 'id',
  fuel: 'item',
  tag: 'key',
  uses: 'ingredient',
};
const QUERY_KINDS = Object.keys(QUERY_KEY_FIELD) as KnowledgeQuery['kind'][];

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const str = { type: 'string' };
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });

/**
 * Generates the strict output schema for one capability catalog. Predicates
 * and selectors are `anyOf` variants, one closed object per kind (only that
 * kind's fields), so the model never has to emit irrelevant nullable fields.
 * Bounds (lengths, counts, ranges) are enforced by code after parsing, not by
 * the schema, so the schema stays within the structured-output subset.
 */
export function plannerOutputSchema(catalog: CapabilityCatalog): Record<string, unknown> {
  const capabilityIds = catalog.capabilities.map((c) => c.id);
  const memory = catalogHasMemory(catalog);
  const construction = catalogHasConstruction(catalog);
  const survival = catalogHasSurvival(catalog);
  const one = (v: string) => ({ type: 'string', enum: [v] });
  const vec = obj({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } });
  const key = { type: 'string', description: 'namespaced registry key such as minecraft:oak_log or tag such as #minecraft:logs' };
  const targetRef = { $ref: '#/$defs/target' };
  const target = {
    anyOf: [
      obj({ kind: one('registry'), key }),
      obj({ kind: one('observed'), snapshotId: str, handle: str }),
      obj({ kind: one('remembered_anchor'), anchorId: str }),
      obj({ kind: one('owner_destination'), dimension: str, at: { $ref: '#/$defs/vec' }, ownerText: str }),
      obj({ kind: one('owner') }),
      obj({ kind: one('prior_result'), actionId: str }),
      ...(memory ? [obj({ kind: one('memory_ref'), refId: { type: 'string', description: 'a memory ref (mref-... or, while preparing, mprep-...) shown in this request' } })] : []),
    ],
  };
  const count = { type: 'integer' };
  const predicate = {
    anyOf: [
      obj({ predicate: one('inventory_amount'), selector: key, atLeast: count, mode: { type: 'string', enum: ['collect_additional', 'possess'] } }),
      obj({ predicate: one('inventory_delta'), selector: key, atLeast: count, mayBeConsumedLater: { type: 'boolean' } }),
      obj({ predicate: one('equipped'), selector: key, slot: { type: 'string', enum: ['hand', 'off_hand', 'head', 'torso', 'legs', 'feet'] } }),
      obj({ predicate: { type: 'string', enum: ['near_target', 'visited_location'] }, target: targetRef, within: { type: 'number' } }),
      obj({ predicate: one('block_state'), target: targetRef, expect: key }),
      obj({ predicate: one('container_state'), target: targetRef, selector: key, atLeast: count }),
      obj({ predicate: { type: 'string', enum: ['crafting_result', 'smelting_result'] }, output: key, atLeast: count }),
      obj({ predicate: one('entity_outcome'), target: targetRef, outcome: { type: 'string', enum: ['observed_defeated', 'observed_present'] } }),
      obj({ predicate: one('blocks_removed'), target: targetRef, selector: key }),
      ...(memory ? [obj({ predicate: one('memory_state'), label: str, expect: { type: 'string', enum: ['recorded', 'noted', 'forgotten'] } })] : []),
      ...(construction ? [obj({ predicate: one('structure_state'), structure: one('home'), expect: { type: 'string', enum: ['site_approved', 'enclosed', 'complete'] } })] : []),
      ...(survival ? [obj({ predicate: one('survival_state'), routine: { type: 'string', enum: [...SURVIVAL_ROUTINES] }, expect: { type: 'string', enum: ['recovered', 'concluded', 'satisfied'] } })] : []),
      obj({ predicate: { type: 'string', enum: ['all', 'any', 'not'] }, of: { type: 'array', items: { $ref: '#/$defs/predicate' } } }),
    ],
  };
  const task = obj({
    objective: str,
    decisionInstruction: str,
    allowedCapabilities: { type: 'array', items: { type: 'string', enum: capabilityIds } },
    targetSelectors: { type: 'array', items: targetRef },
    parameters: { type: 'array', items: obj({ name: str, valueJson: str }) },
    completion: { $ref: '#/$defs/predicate' },
  });
  const query = obj({ kind: { type: 'string', enum: QUERY_KINDS }, key: nullable(str) });
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: `chunkbot-planner-proposal-v${PLANNER_PROPOSAL_VERSION}`,
    type: 'object',
    additionalProperties: false,
    properties: {
      disposition: { type: 'string', enum: DISPOSITIONS },
      interpretation: str,
      outcome: nullable(obj({ kind: { type: 'string', enum: ['finite', 'persistent'] }, predicate: { $ref: '#/$defs/predicate' } })),
      tasks: { type: 'array', items: { $ref: '#/$defs/task' } },
      morePlanningNeeded: { type: 'boolean' },
      queries: { type: 'array', items: { $ref: '#/$defs/query' } },
      missing: nullable(str),
      missingCapabilities: { type: 'array', items: str },
      verifiedProgress: nullable(str),
    },
    required: ['disposition', 'interpretation', 'outcome', 'tasks', 'morePlanningNeeded', 'queries', 'missing', 'missingCapabilities', 'verifiedProgress'],
    $defs: { vec, target, predicate, task, query },
  };
}

/** Code-owned normalization: a bare registry name gets the vanilla namespace (`stone` -> `minecraft:stone`, `#logs` -> `#minecraft:logs`). The registry check still verifies it exists. */
export function normalizeKey(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const m = /^(#?)([a-z0-9_./-]+)$/.exec(v.trim());
  return m ? `${m[1]}minecraft:${m[2]}` : v.trim();
}
const KEY_FIELDS = new Set(['key', 'selector', 'expect', 'output']);

export function schemaDigest(schema: unknown): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex').slice(0, 12);
}

// ------------------------------------------------------------------ wire -> contract

export class WireError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.slice(0, 4).join('; '));
    this.name = 'WireError';
    this.problems = problems;
  }
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const emptyish = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);

function requireOnly(o: Raw, allowed: readonly string[], all: readonly string[], where: string, problems: string[]): void {
  for (const f of all) {
    if (!allowed.includes(f) && !emptyish(o[f])) problems.push(`${where}.${f} must be null for this kind`);
  }
  for (const f of allowed) if (o[f] === null || o[f] === undefined) problems.push(`${where}.${f} is required for this kind`);
}

function selectorFromWire(raw: unknown, where: string, problems: string[]): TargetSelector | undefined {
  if (!isObj(raw)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  const kind = raw['kind'] as SelectorKindWire;
  if (!SELECTOR_KINDS.includes(kind)) {
    problems.push(`${where}.kind ${JSON.stringify(raw['kind'])} is not a selector kind`);
    return undefined;
  }
  const before = problems.length;
  requireOnly(raw, SELECTOR_FIELDS[kind], ALL_SELECTOR_FIELDS, where, problems);
  if (problems.length > before) return undefined;
  const out: Raw = { kind };
  for (const f of SELECTOR_FIELDS[kind]) out[f] = KEY_FIELDS.has(f) ? normalizeKey(raw[f]) : raw[f];
  return out as unknown as TargetSelector;
}

function predicateFromWire(raw: unknown, where: string, problems: string[], depth = 0): OutcomePredicate | undefined {
  if (!isObj(raw)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  if (depth > 6) {
    problems.push(`${where}: predicate nesting is too deep`);
    return undefined;
  }
  const kind = raw['predicate'] as PredicateKindWire;
  if (!PREDICATE_KINDS.includes(kind)) {
    problems.push(`${where}.predicate ${JSON.stringify(raw['predicate'])} is not a predicate kind`);
    return undefined;
  }
  const before = problems.length;
  requireOnly(raw, PREDICATE_FIELDS[kind], ALL_PREDICATE_FIELDS, where, problems);
  if (problems.length > before) return undefined;
  if (kind === 'all' || kind === 'any' || kind === 'not') {
    const of = raw['of'];
    if (!Array.isArray(of) || of.length === 0) {
      problems.push(`${where}.of must list at least one predicate`);
      return undefined;
    }
    if (kind === 'not' && of.length !== 1) {
      problems.push(`${where}: "not" takes exactly one predicate in "of"`);
      return undefined;
    }
    const children = of.map((c, i) => predicateFromWire(c, `${where}.of[${i}]`, problems, depth + 1));
    if (children.some((c) => !c)) return undefined;
    return kind === 'not' ? { predicate: 'not', of: children[0] as OutcomePredicate } : { predicate: kind, of: children as OutcomePredicate[] };
  }
  const out: Raw = { predicate: kind };
  for (const f of PREDICATE_FIELDS[kind]) {
    if (f === 'target') {
      const sel = selectorFromWire(raw[f], `${where}.target`, problems);
      if (!sel) return undefined;
      out[f] = sel;
    } else out[f] = KEY_FIELDS.has(f) && !ENUM_EXPECT.has(kind) ? normalizeKey(raw[f]) : raw[f];
  }
  return out as unknown as OutcomePredicate;
}

const MAX_VALUE_JSON = 2_000;

function taskFromWire(raw: unknown, where: string, problems: string[]): TaskSpec | undefined {
  if (!isObj(raw)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  const selectors = Array.isArray(raw['targetSelectors']) ? raw['targetSelectors'].map((s, i) => selectorFromWire(s, `${where}.targetSelectors[${i}]`, problems)) : [];
  const completion = predicateFromWire(raw['completion'], `${where}.completion`, problems);
  const parameters: Record<string, JsonValue> = {};
  for (const [i, p] of (Array.isArray(raw['parameters']) ? raw['parameters'] : []).entries()) {
    if (!isObj(p) || typeof p['name'] !== 'string' || typeof p['valueJson'] !== 'string') {
      problems.push(`${where}.parameters[${i}] must be {name, valueJson}`);
      continue;
    }
    const name = p['name'];
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) {
      problems.push(`${where}.parameters[${i}].name ${JSON.stringify(name.slice(0, 40))} is not a parameter name`);
      continue;
    }
    if (name in parameters) {
      problems.push(`${where}.parameters: duplicate ${name}`);
      continue;
    }
    if (p['valueJson'].length > MAX_VALUE_JSON) {
      problems.push(`${where}.parameters.${name}: value is too large`);
      continue;
    }
    try {
      parameters[name] = JSON.parse(p['valueJson']) as JsonValue;
    } catch {
      problems.push(`${where}.parameters.${name}: valueJson is not JSON (values are data, never code)`);
    }
  }
  if (!completion || selectors.some((s) => !s)) return undefined;
  return {
    objective: raw['objective'] as string,
    decisionInstruction: raw['decisionInstruction'] as string,
    allowedCapabilities: raw['allowedCapabilities'] as string[],
    targetSelectors: selectors as TargetSelector[],
    parameters,
    completion,
  };
}

function queryFromWire(raw: unknown, where: string, problems: string[]): KnowledgeQuery | undefined {
  if (!isObj(raw)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  const kind = raw['kind'] as KnowledgeQuery['kind'];
  if (!QUERY_KINDS.includes(kind)) {
    problems.push(`${where}.kind ${JSON.stringify(raw['kind'])} is not a knowledge query kind`);
    return undefined;
  }
  const field = QUERY_KEY_FIELD[kind];
  const candidate = field && raw['key'] !== null && raw['key'] !== undefined ? { kind, [field]: kind === 'capability' ? raw['key'] : normalizeKey(raw['key']) } : { kind };
  const parsed = KnowledgeQuerySchema.safeParse(candidate);
  if (!parsed.success) {
    problems.push(`${where}: invalid ${kind} query (${parsed.error.issues[0]?.message ?? 'invalid'})`);
    return undefined;
  }
  return parsed.data;
}

/**
 * Converts one wire object to the shared contract shape. Throws WireError
 * listing every structural problem (used for a bounded repair turn).
 */
export function proposalFromWire(raw: unknown): PlannerProposal {
  const problems: string[] = [];
  if (!isObj(raw)) throw new WireError(['the final message is not a JSON object']);
  const forbidden = scanForbidden(raw);
  if (forbidden.length > 0) throw new WireError(forbidden);
  // MB-PLAN-006: a legacy/off-schema owner question is a counted policy repair, never a question to relay.
  if (raw['disposition'] === 'needs_clarification' || (raw['question'] !== undefined && raw['question'] !== null)) throw new WireError(ownerQuestionProblems({ ...raw, question: typeof raw['question'] === 'string' ? raw['question'] : 'question' }));
  const disposition = raw['disposition'] as (typeof DISPOSITIONS)[number];
  if (!DISPOSITIONS.includes(disposition)) throw new WireError([`disposition ${JSON.stringify(raw['disposition'])} is not one of ${DISPOSITIONS.join(', ')}`]);
  const interpretation = raw['interpretation'];
  const base = { version: PLANNER_PROPOSAL_VERSION, interpretation };
  // morePlanningNeeded is a required boolean in the strict schema; it only has meaning for "plan".
  const mustBeEmpty = (fields: string[]) => {
    for (const f of fields) if (f !== 'morePlanningNeeded' && !emptyish(raw[f])) problems.push(`${f} must be null/empty for disposition ${disposition}`);
  };
  let out: unknown;
  switch (disposition) {
    case 'plan': {
      // verifiedProgress is the planner's own note; only cannot_execute reports it (code evidence is authoritative).
      mustBeEmpty(['queries', 'missing', 'missingCapabilities']);
      const o = raw['outcome'];
      let outcome: unknown;
      if (!isObj(o)) problems.push('outcome is required for a plan');
      else {
        const p = predicateFromWire(o['predicate'], 'outcome.predicate', problems);
        if (p) outcome = o['kind'] === 'persistent' ? { kind: 'persistent', maintain: p } : o['kind'] === 'finite' ? { kind: 'finite', outcome: p } : problems.push('outcome.kind must be finite or persistent');
      }
      const tasks = Array.isArray(raw['tasks']) ? raw['tasks'].map((t, i) => taskFromWire(t, `tasks[${i}]`, problems)) : [];
      if (tasks.length === 0) problems.push('a plan needs at least one task');
      out = { ...base, disposition, outcome, tasks, morePlanningNeeded: raw['morePlanningNeeded'] };
      break;
    }
    // Non-plan dispositions never cause actions: fields that only a plan uses
    // (outcome, tasks) are ignored rather than rejected.
    case 'needs_information': {
      mustBeEmpty(['missing']);
      const queries = Array.isArray(raw['queries']) ? raw['queries'].map((q, i) => queryFromWire(q, `queries[${i}]`, problems)) : [];
      if (queries.length === 0) problems.push('needs_information needs at least one query');
      out = { ...base, disposition, queries };
      break;
    }
    case 'cannot_execute': {
      mustBeEmpty(['queries']);
      // missingCapabilities lists capability IDS; descriptive entries are folded into `missing` (text).
      const listed = Array.isArray(raw['missingCapabilities']) ? raw['missingCapabilities'].filter((x): x is string => typeof x === 'string') : [];
      const ids = listed.filter((x) => /^[a-z][a-z0-9_]{1,63}$/.test(x)).slice(0, 8);
      const prose = listed.filter((x) => !/^[a-z][a-z0-9_]{1,63}$/.test(x)).slice(0, 4);
      const missing = typeof raw['missing'] === 'string' && prose.length ? `${raw['missing']} (also missing: ${prose.join('; ')})` : raw['missing'];
      out = { ...base, disposition, missing, missingCapabilities: ids, verifiedProgress: raw['verifiedProgress'] ?? '' };
      break;
    }
  }
  if (problems.length > 0) throw new WireError(problems.slice(0, 12));
  return out as PlannerProposal;
}
