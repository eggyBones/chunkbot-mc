import type { Scenario } from './types.ts';

// Examples live only in the acceptance harness. No planner proposal/template
// is supplied: the ordinary pipeline must choose every task and prerequisite.
export const SCENARIOS: readonly Scenario[] = [
  { id: 'V1-MOVE', criteria: ['V1-1', 'V1-2'], family: 'movement', instruction: 'Come here', supplies: {}, outputs: {} },
  { id: 'V1-FOLLOW', criteria: ['V1-1', 'V1-2'], family: 'movement', instruction: 'Follow me', supplies: {}, outputs: {}, persistent: true },
  { id: 'V1-RESOURCE-EMPTY', criteria: ['V1-2', 'V1-3'], family: 'resource', instruction: 'Collect four additional cobblestone', supplies: {}, outputs: { 'minecraft:cobblestone': 4 } },
  { id: 'V1-RESOURCE-TOOL', criteria: ['V1-2', 'V1-3'], family: 'resource', instruction: 'Collect four additional cobblestone', supplies: { 'minecraft:iron_pickaxe': 1 }, outputs: { 'minecraft:cobblestone': 4 } },
  { id: 'V1-RESOURCE-STOCK', criteria: ['V1-2', 'V1-3'], family: 'resource', instruction: 'Collect four additional cobblestone', supplies: { 'minecraft:cobblestone': 7, 'minecraft:oak_planks': 12, 'minecraft:stick': 4, 'minecraft:crafting_table': 1 }, outputs: { 'minecraft:cobblestone': 4 } },
  { id: 'V1-STONE', criteria: ['V1-2'], family: 'resource', instruction: 'Get four stone blocks', supplies: { 'minecraft:iron_pickaxe': 1 }, outputs: { 'minecraft:stone': 4 } },
  { id: 'V1-HELMET', criteria: ['V1-2'], family: 'equipment', instruction: 'Make and equip an iron helmet', supplies: { 'minecraft:iron_ingot': 5, 'minecraft:crafting_table': 1 }, outputs: {} },
  { id: 'V1-COMPOSITION', criteria: ['V1-3'], family: 'composition', instruction: '', supplies: {}, outputs: {} },
  { id: 'V1-REPLAN', criteria: ['V1-4'], family: 'replan', instruction: 'Collect four additional cobblestone', supplies: { 'minecraft:iron_pickaxe': 1 }, outputs: { 'minecraft:cobblestone': 4 }, trigger: 'remove_target' },
  ...(['planner', 'decision', 'movement', 'mining', 'crafting', 'furnace'] as const).map((trigger): Scenario => ({
    id: `V1-STOP-${trigger.toUpperCase()}`, criteria: ['V1-4'], family: 'stop', trigger,
    instruction: trigger === 'movement' ? 'Follow me' : trigger === 'crafting' ? 'Make an iron helmet' : trigger === 'furnace' ? 'Get four stone blocks' : 'Collect four additional cobblestone',
    supplies: trigger === 'crafting' ? { 'minecraft:iron_ingot': 5, 'minecraft:crafting_table': 1 } : trigger === 'mining' || trigger === 'furnace' ? { 'minecraft:iron_pickaxe': 1 } : {}, outputs: {},
  })),
  { id: 'V1-DISCONNECT', criteria: ['V1-4'], family: 'lifecycle', instruction: 'Follow me', supplies: {}, outputs: {}, trigger: 'disconnect' },
  { id: 'V1-RESTART', criteria: ['V1-4'], family: 'lifecycle', instruction: 'Follow me', supplies: {}, outputs: {}, trigger: 'restart' },
  { id: 'V1-DEATH', criteria: ['V1-4'], family: 'lifecycle', instruction: 'Follow me', supplies: {}, outputs: {}, trigger: 'death' },
  { id: 'V1-PRIVACY', criteria: ['V1-4'], family: 'privacy', instruction: 'Find a diamond ore block', supplies: {}, outputs: {}, trigger: 'decision' },
];

export function selectScenarios(ids?: string[], composition?: { instruction: string; outputs: Record<string, number>; returnToOwner?: boolean }): Scenario[] {
  if (ids && (ids.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !SCENARIOS.some((s) => s.id === id)))) throw new Error('unknown, empty or duplicate scenario selection');
  if (composition && (Object.keys(composition).some((key) => !['instruction', 'outputs', 'returnToOwner'].includes(key)) || typeof composition.instruction !== 'string' || !composition.instruction.trim() || composition.instruction.length > 500 || !composition.outputs || Array.isArray(composition.outputs) || typeof composition.outputs !== 'object' || Object.keys(composition.outputs).length < 2 || Object.entries(composition.outputs).some(([key, n]) => !/^minecraft:[a-z0-9_]+$/.test(key) || !Number.isSafeInteger(n) || n < 1 || n > 64) || (composition.returnToOwner !== undefined && typeof composition.returnToOwner !== 'boolean'))) throw new Error('composition requires only an acceptance-selected instruction, two exact item outputs (1..64), and optional returnToOwner boolean');
  return SCENARIOS.filter((s) => !ids || ids.includes(s.id)).map((s) => s.family === 'composition' && composition ? { ...s, instruction: composition.instruction, outputs: composition.outputs, ...(composition.returnToOwner === undefined ? {} : { returnToOwner: composition.returnToOwner }) } : s);
}
