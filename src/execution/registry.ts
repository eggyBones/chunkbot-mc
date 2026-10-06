// Capability registry generated from the registered skill definitions. The
// catalog supplied to the planner, the IDs accepted by proposal validation,
// candidate generation, and execution all read these same definitions.
import { createHash } from 'node:crypto';
import { CapabilityCatalogSchema, type CapabilityCatalog, type CapabilityRegistry } from '../contracts/index.ts';
import type { AnySkill } from '../skills/definition.ts';

export class SkillRegistry implements CapabilityRegistry {
  private readonly defs = new Map<string, AnySkill>();
  private readonly value: CapabilityCatalog;

  constructor(skills: readonly AnySkill[]) {
    for (const skill of skills) {
      if (this.defs.has(skill.descriptor.id)) throw new Error(`duplicate capability ${skill.descriptor.id}`);
      this.defs.set(skill.descriptor.id, skill);
    }
    const capabilities = [...this.defs.values()].map((d) => d.descriptor);
    const digest = createHash('sha256').update(JSON.stringify(capabilities)).digest('hex').slice(0, 12);
    // Validated against the shared contract: the catalog is exactly what definitions declare.
    this.value = CapabilityCatalogSchema.parse({ catalogVersion: `skills-${capabilities.length}-${digest}`, capabilities });
  }

  catalog(): CapabilityCatalog {
    return this.value;
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  get(id: string): AnySkill | undefined {
    return this.defs.get(id);
  }

  all(): AnySkill[] {
    return [...this.defs.values()];
  }
}
