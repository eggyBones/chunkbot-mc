// Explicit not-ready adapters installed by the foundation. They make the
// missing planner/capability/knowledge/execution adapters visible in status
// instead of faking gameplay success. Later assignments replace them through
// the same ports.
import type {
  CapabilityCatalog,
  CapabilityRegistry,
  DecisionChoice,
  DecisionPort,
  KnowledgePort,
  KnowledgeQuery,
  KnowledgeResult,
  ObservationPort,
  ObservationSnapshot,
  PlannerPort,
  PlannerProposal,
  Readiness,
  SkillExecutor,
  SkillOutcome,
} from '../contracts/index.ts';

export class AdapterNotReadyError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'AdapterNotReadyError';
  }
}

export const NOT_READY = {
  planner: 'Codex subscription gameplay planner is not installed in this composition (MB-V1-04 planner absent or disabled by an inference-free profile)',
  knowledge: 'game-knowledge adapter is not installed yet (MB-V1-02)',
  observation: 'perception adapter is not installed yet (MB-V1-02)',
  executor: 'skill execution adapters are not installed yet (MB-V1-02/MB-V1-03)',
  decision: 'Jev decision adapter is not installed yet (MB-V1-03)',
} as const;

export class NotReadyPlanner implements PlannerPort {
  private readonly detail: string;
  constructor(detail: string = NOT_READY.planner) {
    this.detail = detail;
  }
  readiness(): Readiness {
    return { ready: false, detail: this.detail };
  }
  async propose(): Promise<PlannerProposal> {
    throw new AdapterNotReadyError(this.detail);
  }
}

export class NotReadyKnowledge implements KnowledgePort {
  readiness(): Readiness {
    return { ready: false, detail: NOT_READY.knowledge };
  }
  async answer(queries: readonly KnowledgeQuery[]): Promise<KnowledgeResult[]> {
    return queries.map((query) => ({ status: 'unavailable' as const, query, detail: NOT_READY.knowledge }));
  }
}

export class NotReadyObservation implements ObservationPort {
  readiness(): Readiness {
    return { ready: false, detail: NOT_READY.observation };
  }
  async snapshot(): Promise<ObservationSnapshot | null> {
    return null;
  }
}

export class NotReadySkillExecutor implements SkillExecutor {
  readiness(): Readiness {
    return { ready: false, detail: NOT_READY.executor };
  }
  async execute(): Promise<SkillOutcome> {
    throw new AdapterNotReadyError(NOT_READY.executor);
  }
}

export class NotReadyDecision implements DecisionPort {
  readiness(): Readiness {
    return { ready: false, detail: NOT_READY.decision };
  }
  async choose(): Promise<DecisionChoice> {
    throw new AdapterNotReadyError(NOT_READY.decision);
  }
}

/** Capability registry populated from implemented definitions; empty in the foundation. */
export class StaticCapabilityRegistry implements CapabilityRegistry {
  private readonly value: CapabilityCatalog;
  private readonly ids: Set<string>;
  constructor(catalog: CapabilityCatalog = { catalogVersion: 'foundation-0', capabilities: [] }) {
    this.value = catalog;
    this.ids = new Set(catalog.capabilities.map((c) => c.id));
  }
  catalog(): CapabilityCatalog {
    return this.value;
  }
  has(id: string): boolean {
    return this.ids.has(id);
  }
}
