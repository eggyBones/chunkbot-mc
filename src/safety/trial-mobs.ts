// Harness-only mechanics staging; no gameplay permissions or model inputs.
import type { SafetyEntityFact, SafetyPlan, SafetySelfFacts } from '../contracts/safety.ts';
import { mobStageRefusals, SAFETY_TRIAL_BOX, trialEntitySelector, type MobTrialGate, type TrialSummon } from './trial-arena.ts';
import { parseEntityTest } from './trial-journal.ts';

export interface MobStageReads {
  now(): number;
  self(): SafetySelfFacts | undefined;
  visible(): SafetyEntityFact[];
  summons(): TrialSummon[];
  plan(self: SafetySelfFacts, visible: SafetyEntityFact[]): SafetyPlan;
}

/** Read-end time is sampled from the actual clock AFTER all synchronous
 * self/entity/LOS/policy work. Never advance it to an observation's claimed
 * timestamp: genuinely future/stale facts must still fail the same guard. */
export function readMobStage(gate: MobTrialGate, reads: MobStageReads) {
  const readStartedAtMs = reads.now();
  const self = reads.self();
  if (!self) throw new Error('staging_unready: fresh self facts unavailable');
  const visible = reads.visible();
  const summons = reads.summons();
  const plan = reads.plan(self, visible);
  const atMs = reads.now();
  const refusals = mobStageRefusals(gate, summons, visible, plan, atMs);
  return { gate, readStartedAtMs, atMs, summons, visible, self, plan, refusals };
}

/** Only the staged ordinary zombie needs daylight protection. Both official
 * Creeper.spawnLingeringCloud implementations copy ANY active effects into
 * an untagged cloud on explosion. Giving a creeper Fire Resistance would
 * create unrelated staging obstacles. No fuse/AI/explosion limit is changed. */
export function trialSummonEffects(kind: string, tag: string): string[] {
  if (!/^[A-Za-z0-9_]+$/.test(tag)) throw new Error('invalid summon tag');
  return kind === 'zombie' ? [`effect give @e[tag=${tag},${trialEntitySelector(SAFETY_TRIAL_BOX)}] minecraft:fire_resistance infinite 0 true`] : [];
}

/** Absence of entry[0] proves the current creeper has no active effects.
 * Missing entities, command errors and unknown replies do not prove absence.
 * Retain the reply before refusal. Re-read after prerequisite awaits. */
export async function verifyEffectFreeCreeper(read: (command: string) => Promise<string>, tag: string, record: (command: string, reply: string) => void): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(tag)) throw new Error('invalid summon tag');
  const command = `execute if data entity @e[tag=${tag},limit=1,${trialEntitySelector(SAFETY_TRIAL_BOX)}] active_effects[0]`;
  const reply = await read(command);
  record(command, reply);
  if (parseEntityTest(reply) !== false) throw new Error('staging_unready: current creeper active effects present or unknown; no effect/cloud removal is permitted');
}
