import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AtomicPredicateSchema, sequentialIds, systemClock, type ObservationSnapshot, type TaskSpec } from '../src/contracts/index.ts';
import { TaskCandidateGenerator, taskHints } from '../src/execution/candidates.ts';
import { EvidenceLedger } from '../src/execution/ledger.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import type { GameSession } from '../src/game/connection.ts';
import { checkProposal } from '../src/goals/proposal.ts';
import { VersionKnowledge } from '../src/knowledge/knowledge.ts';
import { PerceptionService } from '../src/perception/perception.ts';
import { allSkills } from '../src/skills/index.ts';
import { evidenceFor, fakeClient } from './skill-fakes.ts';

const PREDICATE_KINDS = new Set(AtomicPredicateSchema.options.map((o) => o.shape.predicate.value as string));

describe('capability catalog generated from registered skill definitions', () => {
  it('validates every descriptor against the shared contract and covers the required families', () => {
    const catalog = new SkillRegistry(allSkills()).catalog();
    assert.equal(catalog.capabilities.length, allSkills().length);
    assert.match(catalog.catalogVersion, /^skills-20-[0-9a-f]{12}$/);
    assert.equal(new SkillRegistry(allSkills()).catalog().catalogVersion, catalog.catalogVersion, 'stable');
    const families = new Set(catalog.capabilities.map((c) => c.family));
    for (const f of ['movement', 'exploration', 'observation', 'resource', 'inventory', 'crafting', 'placement', 'interaction', 'processing', 'transfer', 'entity']) assert.ok(families.has(f), f);
    for (const c of catalog.capabilities) {
      assert.ok(c.targets && c.targets.length > 0, `${c.id} declares targets`);
      assert.ok(c.evidence && c.evidence.length > 0, `${c.id} declares evidence`);
      assert.ok(c.limitations.length > 0 && c.cancellation.length > 0, `${c.id} declares limits and cancellation`);
      for (const p of c.supportedPredicates) assert.ok(PREDICATE_KINDS.has(p), `${c.id}: ${p} is a contract predicate`);
    }
    assert.throws(() => new SkillRegistry([...allSkills(), allSkills()[0]!]), /duplicate/);
  });

  it('planner proposal validation accepts implemented capabilities and rejects others (same registry)', () => {
    const registry = new SkillRegistry(allSkills());
    const plan = (caps: string[]) => ({
      version: 1,
      disposition: 'plan',
      interpretation: 'x',
      outcome: { kind: 'finite', outcome: { predicate: 'crafting_result', output: 'minecraft:furnace', atLeast: 1 } },
      tasks: [{ objective: 'o', decisionInstruction: 'd', allowedCapabilities: caps, completion: { predicate: 'crafting_result', output: 'minecraft:furnace', atLeast: 1 } }],
      morePlanningNeeded: true,
    });
    const facts = { registry: new VersionKnowledge({ version: '26.1.2' }) };
    assert.equal(checkProposal(plan(['craft_item', 'move_near']), registry, { planWindowSteps: 8, remainingTaskAllowance: 64 }, facts).ok, true);
    const bad = checkProposal(plan(['craft_item', 'smelt_everything']), registry, { planWindowSteps: 8, remainingTaskAllowance: 64 }, facts);
    assert.equal(bad.ok, false);
  });

  it('skills and execution contain no hardcoded resource progressions or goal keyword switches', () => {
    const resources = /minecraft:(oak_log|[a-z_]*_planks|stick|cobblestone|stone|iron_ingot|iron_ore|diamond|wooden_pickaxe|stone_pickaxe|coal)['"]/;
    const goalWords = /\b(collect stone|make armor|get wood|follow me)\b/i;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    for (const d of ['src/skills', 'src/execution', 'src/perception', 'src/app', 'src/planner', 'src/goals', 'src/tasks']) walk(d);
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      assert.doesNotMatch(text, resources, `${f} names a specific resource item`);
      assert.doesNotMatch(text, goalWords, `${f} switches on goal phrasing`);
    }
  });
});

describe('task-driven candidate generation', () => {
  it('derives generic hints from selectors and completion predicates (no task type)', () => {
    const task: TaskSpec = {
      objective: 'Bring a crafted item near the owner.',
      decisionInstruction: 'Choose the next grounded action.',
      allowedCapabilities: ['craft_item', 'move_near'],
      targetSelectors: [{ kind: 'owner' }],
      parameters: {},
      completion: {
        predicate: 'all',
        of: [
          { predicate: 'crafting_result', output: 'minecraft:lantern', atLeast: 2 },
          { predicate: 'near_target', target: { kind: 'remembered_anchor', anchorId: 'anchor-3' }, within: 3 },
          { predicate: 'not', of: { predicate: 'inventory_amount', selector: 'minecraft:dirt', atLeast: 1, mode: 'possess' } },
        ],
      },
    };
    const hints = taskHints(task);
    assert.deepEqual(hints.keys, ['minecraft:lantern']);
    assert.deepEqual(hints.outputs, [{ key: 'minecraft:lantern', count: 2 }]);
    assert.equal(hints.wantsOwner, true);
    assert.deepEqual(hints.anchors, ['anchor-3']);
  });

  it('reports unimplemented capabilities and stale snapshots as structured evidence', () => {
    const client = fakeClient();
    const session = { bot: { inventory: { items: () => [] }, entity: { position: { x: 0, y: 0, z: 0 } } }, connectionEpoch: 2, evidence: evidenceFor(client) } as unknown as GameSession;
    const services = {
      perception: new PerceptionService({ session: () => session, clock: systemClock, ids: sequentialIds(), observationRadius: 8, travelRadius: 32 }),
      knowledge: new VersionKnowledge({ version: '26.1.2' }),
      ledger: new EvidenceLedger(systemClock),
      clock: systemClock,
      limits: { observationRadius: 8, travelRadius: 32, ownerLossMs: 1_000 },
    };
    const gen = new TaskCandidateGenerator({ registry: new SkillRegistry(allSkills()), services, session: () => session, ids: sequentialIds() });
    const snapshot = { id: 'snap-0001', connectionEpoch: 1, goalEpoch: 1 } as ObservationSnapshot;
    const set = gen.generate(
      { objective: 'o', decisionInstruction: 'd', allowedCapabilities: ['craft_item', 'teleport_home'], targetSelectors: [], parameters: {}, completion: { predicate: 'crafting_result', output: 'minecraft:lantern', atLeast: 1 } },
      snapshot,
    );
    assert.equal(set.candidates.length, 0);
    assert.deepEqual(
      set.unavailable.map((u) => [u.capability, u.reason]),
      [
        ['craft_item', 'stale_snapshot'],
        ['teleport_home', 'capability_not_implemented'],
      ],
    );
  });
});
