// Code-generated wording for AUTOMATIC goals (MB-FLOW-001). The instruction is
// deliberately generic: it names no resource, recipe, tier or ladder. The
// gameplay planner chooses the milestone and its prerequisites from the
// current observation, knowledge, bounded memory and the capability catalog;
// application code still verifies every outcome.
import type { AutonomyPlannerContext } from '../contracts/autonomy.ts';

/** Rules restated as data in every automatic planner request (bounded). */
export const AUTONOMY_RULES: string[] = [
  'This goal was started automatically; the owner did not ask for it. Owner instructions, stop and safety always take priority.',
  'Choose ONE bounded milestone that is attainable now with the implemented capabilities and has a FINITE code-verifiable outcome (persistent outcomes are refused for automatic goals).',
  'Prefer useful survival progress: supplies, better tools/equipment, food, and a small verified shelter (home). Use what is visible, remembered (memory view) and known (knowledge queries); do not invent targets.',
  'Do not repeat an outcome listed in autonomy.avoid unless the situation changed in a way that makes it attainable; if nothing useful is attainable now, answer cannot_execute with the exact missing prerequisite.',
  'Automatic goals, like all goals, never ask the owner questions: choose an attainable milestone or state one declarative blocker.',
  'A home is built only through the home construction capabilities (select_home_site, then build_home) and is complete only when structure_state home complete is verified by code; a chosen site or a remembered coordinate is not a home.',
  'Never attack players, use or empty containers you did not place unless they are in the verified home, or break blocks of structures the bot did not build.',
];

/** The generic progression instruction (no hardcoded milestone). */
export function progressionInstruction(context: AutonomyPlannerContext): string {
  const home = context.home
    ? ` The scope's home project is ${context.home.state} (${context.home.progress.ownConfirmed}/${context.home.progress.cells} blueprint cells confirmed; ${context.home.verified ? `last verification ${context.home.verified.status}` : 'not yet verified'}).`
    : ' No home project exists yet in this world profile.';
  return (
    'Automatic progression (no owner instruction is pending): assess Chunkbot\'s current situation — inventory, equipment, health and food, nearby terrain, ' +
    'remembered places and projects — and choose ONE useful, attainable survival milestone that improves supplies, tools/equipment, food or shelter, then achieve it ' +
    `with code-verifiable outcomes. Prefer prerequisites that unlock later progress.${home} See the autonomy context for recently verified milestones, outcomes to avoid and the remaining session allowance.`
  );
}
