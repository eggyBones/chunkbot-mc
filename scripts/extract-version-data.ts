// Extracts version-specific game knowledge from the OFFICIAL server jar that the
// fixture setup downloaded and SHA-1-verified (see src/app/fixture-layout.ts):
//
//   - every recipe definition (data/minecraft/recipe/*.json): crafting, cooking
//     (smelting/blasting/smoking/campfire), stonecutting, smithing, special
//   - every item tag (data/minecraft/tags/item/*.json), needed to resolve
//     tag ingredients such as #minecraft:planks
//   - vanilla furnace fuel burn times, decoded from FuelValues.vanillaBurnTimes
//     bytecode (Mojang ships 26.x unobfuscated; there is no fuel data file)
//
// Output: src/knowledge/data/vanilla-<version>.ts (generated, checked in, with
// provenance). Run after the fixture profile's first start (the bundler
// unpacks the inner jar):
//
//   npm run extract-version-data                       26.1.2 (default fixture)
//   npm run extract-version-data -- --fixture 26.2     26.2 fixture (MB-SERVER-001)
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import minecraftData from 'minecraft-data';
import { PROJECT_ROOT, fixturePaths, fixturePins, fixtureProfileFromArgv } from '../src/app/fixture-layout.ts';
import { OP, parseClass, pushedInt } from './lib/classfile.ts';

const FIXTURE_PINS = fixturePins(fixtureProfileFromArgv(process.argv));
const fx = fixturePaths(PROJECT_ROOT, FIXTURE_PINS);
const jar = fx.innerJar;
const outFile = join(PROJECT_ROOT, 'src', 'knowledge', 'data', `vanilla-${FIXTURE_PINS.minecraftVersion}.ts`);

function unzip(args: string[]): Buffer {
  const r = spawnSync('unzip', args, { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`unzip ${args.join(' ')} exited ${r.status}: ${r.stderr.toString()}`);
  return r.stdout;
}

function listEntries(prefix: string): string[] {
  return unzip(['-Z1', jar])
    .toString('utf8')
    .split('\n')
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'));
}

function readJson(entry: string): unknown {
  return JSON.parse(unzip(['-p', jar, entry]).toString('utf8'));
}

const keyOf = (entry: string, prefix: string) => `minecraft:${entry.slice(prefix.length, -'.json'.length)}`;

function main(): void {
  // The inner jar is extracted by the vanilla bundler from the verified outer jar;
  // record its own hash too.
  const outerSha1 = createHash('sha1').update(readFileSync(fx.serverJar)).digest('hex');
  if (outerSha1 !== FIXTURE_PINS.serverJarSha1) throw new Error(`server jar sha1 ${outerSha1} != pinned ${FIXTURE_PINS.serverJarSha1}`);
  const innerSha1 = createHash('sha1').update(readFileSync(jar)).digest('hex');

  // ---------------------------------------------------------------- recipes
  const recipePrefix = 'data/minecraft/recipe/';
  const recipes: Array<Record<string, unknown>> = [];
  const typeCounts: Record<string, number> = {};
  for (const entry of listEntries(recipePrefix).sort()) {
    const raw = readJson(entry) as Record<string, unknown>;
    const type = String(raw['type']);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    recipes.push({ id: keyOf(entry, recipePrefix), ...raw });
  }

  // ---------------------------------------------------------------- item tags
  const tagPrefix = 'data/minecraft/tags/item/';
  const itemTags: Record<string, string[]> = {};
  for (const entry of listEntries(tagPrefix).sort()) {
    const raw = readJson(entry) as { values?: Array<string | { id: string; required?: boolean }> };
    itemTags[keyOf(entry, tagPrefix)] = (raw.values ?? []).map((v) => (typeof v === 'string' ? v : v.id));
  }

  // ---------------------------------------------------------------- fuels
  const classBuf = unzip(['-p', jar, 'net/minecraft/world/level/block/entity/FuelValues.class']);
  const cls = parseClass(classBuf);
  const method = cls.methods.find((m) => m.name === 'vanillaBurnTimes' && m.descriptor.includes(';I)'));
  const baseMethod = cls.methods.find((m) => m.name === 'vanillaBurnTimes' && !m.descriptor.includes(';I)'));
  if (!method || !baseMethod) throw new Error('FuelValues.vanillaBurnTimes not found');
  const baseIns = baseMethod.instructions.map((i) => pushedInt(cls, i)).find((v) => v !== undefined);
  if (baseIns === undefined) throw new Error('base smelt time not found');
  const base = baseIns;
  const fuels: Array<{ target: string; burnTicks: number }> = [];
  const removals: string[] = [];
  const unmapped: string[] = [];
  let target: string | undefined;
  let stack: number[] = [];
  const toKey = (owner: string, name: string): string | undefined => {
    const lower = `minecraft:${name.toLowerCase()}`;
    if (owner.endsWith('/ItemTags')) return `#${lower}`;
    if (owner.endsWith('/Items') || owner.endsWith('/Blocks')) return lower;
    return undefined;
  };
  for (const ins of method.instructions) {
    const n = pushedInt(cls, ins);
    if (ins.opcode === OP.getstatic && ins.operand !== undefined) {
      const r = cls.ref(ins.operand);
      target = r ? toKey(r.owner, r.name) : undefined;
      if (!target && r) unmapped.push(`${r.owner}.${r.name}`);
      stack = [];
    } else if (ins.opcode === 0x1c) stack.push(base); // iload_2: base smelt time argument
    else if (n !== undefined) stack.push(n);
    else if (ins.opcode === 0x68 || ins.opcode === 0x6c || ins.opcode === 0x60 || ins.opcode === 0x64) {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) continue;
      stack.push(ins.opcode === 0x68 ? a * b : ins.opcode === 0x6c ? Math.trunc(a / b) : ins.opcode === 0x60 ? a + b : a - b);
    } else if ((ins.opcode === OP.invokevirtual || ins.opcode === OP.invokeinterface) && ins.operand !== undefined) {
      const r = cls.ref(ins.operand);
      if (r?.owner.endsWith('FuelValues$Builder') && r.name === 'add' && target && stack.length === 1) {
        fuels.push({ target, burnTicks: stack[0] as number });
      } else if (r?.owner.endsWith('FuelValues$Builder') && r.name === 'remove' && target) {
        removals.push(target);
      }
      target = undefined;
      stack = [];
    }
  }

  // ---------------------------------------------------------------- verification
  const md = minecraftData(FIXTURE_PINS.minecraftVersion);
  if (!md) throw new Error('minecraft-data has no data for the fixture version');
  const missing: string[] = [];
  for (const f of [...fuels.map((x) => x.target), ...removals]) {
    if (f.startsWith('#')) {
      if (!itemTags[f.slice(1)]) missing.push(f);
    } else if (!md.itemsByName[f.slice('minecraft:'.length)]) missing.push(f);
  }
  const expected: Record<string, number> = { 'minecraft:coal': 1600, 'minecraft:lava_bucket': 20000, '#minecraft:logs': 300, '#minecraft:planks': 300 };
  for (const [k, v] of Object.entries(expected)) {
    const got = fuels.find((x) => x.target === k)?.burnTicks;
    if (got !== v) throw new Error(`fuel sanity check failed for ${k}: got ${got}, expected ${v}`);
  }
  if (missing.length) throw new Error(`fuel targets missing from item data/tags: ${missing.join(', ')}`);
  if (unmapped.length) process.stdout.write(`warning: unmapped fuel references ${unmapped.join(', ')}\n`);

  const data = {
    provenance: {
      minecraftVersion: FIXTURE_PINS.minecraftVersion,
      serverJarSha1: FIXTURE_PINS.serverJarSha1,
      innerJarSha1: innerSha1,
      sources: ['data/minecraft/recipe/*.json', 'data/minecraft/tags/item/*.json', 'FuelValues.vanillaBurnTimes bytecode'],
      extractor: 'scripts/extract-version-data.ts',
      baseSmeltTicks: base,
      recipeTypeCounts: typeCounts,
    },
    recipes,
    itemTags,
    fuels,
    fuelRemovals: removals,
  };
  const header = [
    '// GENERATED by scripts/extract-version-data.ts from the official, SHA-1-verified',
    `// Minecraft Java ${FIXTURE_PINS.minecraftVersion} server jar. Do not edit by hand.`,
    '// Recipes, item tags, and vanilla fuel burn times for knowledge queries and crafting.',
    "import type { VanillaData } from '../vanilla-data.ts';",
    '',
    `export const VANILLA_DATA: VanillaData = ${JSON.stringify(data)};`,
    '',
  ].join('\n');
  writeFileSync(outFile, header);
  process.stdout.write(
    `wrote ${outFile}: ${recipes.length} recipes ${JSON.stringify(typeCounts)}, ${Object.keys(itemTags).length} item tags, ${fuels.length} fuel entries, ${removals.length} removals\n`,
  );
}

main();
