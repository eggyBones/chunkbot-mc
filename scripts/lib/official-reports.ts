// Compact digests of the OFFICIAL vanilla data-generator reports
// (`java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --reports`)
// and their comparison with the INSTALLED minecraft-data / protocol codec.
//
// The digest is independent evidence from Mojang's own jar: every block's
// properties and state-id range, and the protocol-id order of the registries
// and packets that the network codec depends on. Comparison decodes every
// block state through the installed prismarine-block (the same code the bot
// uses for chunk palettes) and checks registry/packet id alignment.
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';

const require = createRequire(import.meta.url);

export interface ReportDigest {
  provenance: {
    minecraftVersion: string;
    serverJarSha1: string;
    generator: string;
    note: string;
  };
  /** block name (no namespace) -> [minStateId, maxStateId, defaultStateId, properties in Mojang order] */
  blocks: Record<string, [number, number, number, Array<[string, string[]]>]>;
  /** registry key (no namespace) -> entry names (no namespace) in protocol-id order */
  registries: Record<string, string[]>;
  /** phase -> direction -> packet names (Mojang, no namespace) in protocol-id order */
  packets: Record<string, Record<string, string[]>>;
}

/** Registries whose protocol ids the network codec or the bot depends on. */
export const DIGEST_REGISTRIES = [
  'item',
  'block',
  'entity_type',
  'block_entity_type',
  'data_component_type',
  'particle_type',
  'menu',
  'attribute',
  'mob_effect',
  'sound_event',
  'recipe_book_category',
  'recipe_display',
  'slot_display',
  'command_argument_type',
  'game_event',
] as const;

const strip = (key: string) => key.replace(/^minecraft:/, '');

interface RawBlockReport {
  properties?: Record<string, string[]>;
  states: Array<{ id: number; default?: boolean; properties?: Record<string, string> }>;
}

/** Builds the digest and asserts the cartesian state layout it relies on. */
export function buildDigest(
  reports: { blocks: Record<string, RawBlockReport>; registries: Record<string, { entries: Record<string, { protocol_id: number }> }>; packets: Record<string, Record<string, Record<string, { protocol_id: number }>>> },
  provenance: ReportDigest['provenance'],
): ReportDigest {
  const blocks: ReportDigest['blocks'] = {};
  for (const [key, block] of Object.entries(reports.blocks)) {
    const ids = block.states.map((s) => s.id);
    const min = Math.min(...ids);
    const max = Math.max(...ids);
    const def = block.states.find((s) => s.default)?.id ?? min;
    // Mojang enumerates states as a cartesian product (last property in the
    // enumeration order varies fastest). The report lists properties sorted by
    // name, so find the enumeration order that reproduces every state id exactly.
    const props = layoutOrder(key, Object.entries(block.properties ?? {}), block.states, min);
    blocks[strip(key)] = [min, max, def, props];
  }
  const registries: ReportDigest['registries'] = {};
  for (const name of DIGEST_REGISTRIES) {
    const reg = reports.registries[`minecraft:${name}`];
    if (!reg) throw new Error(`report has no registry minecraft:${name}`);
    registries[name] = Object.entries(reg.entries)
      .sort((a, b) => a[1].protocol_id - b[1].protocol_id)
      .map(([k]) => strip(k));
  }
  const packets: ReportDigest['packets'] = {};
  for (const [phase, dirs] of Object.entries(reports.packets)) {
    packets[phase] = {};
    for (const [dir, list] of Object.entries(dirs)) {
      packets[phase][dir] = Object.entries(list)
        .sort((a, b) => a[1].protocol_id - b[1].protocol_id)
        .map(([k]) => strip(k));
    }
  }
  return { provenance, blocks, registries, packets };
}

function permutations<T>(list: T[]): T[][] {
  if (list.length <= 1) return [list];
  return list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [item, ...rest]));
}

function layoutOrder(
  key: string,
  props: Array<[string, string[]]>,
  states: Array<{ id: number; properties?: Record<string, string> }>,
  min: number,
): Array<[string, string[]]> {
  for (const order of permutations(props)) {
    const fits = states.every((state) => {
      let index = 0;
      for (const [name, values] of order) index = index * values.length + values.indexOf(state.properties?.[name] ?? '');
      return state.id === min + index;
    });
    if (fits) return order;
  }
  throw new Error(`${key}: states are not a cartesian product of the listed property values`);
}

export interface Finding {
  area: string;
  ok: boolean;
  detail: string;
}

/**
 * REVIEWED label-only aliases: official registry name -> the label the
 * installed codec uses for the SAME protocol id. Comparison maps official
 * names through this table and then requires exact per-id equality, so a
 * differing identity (a shifted or wrong id) can never pass. Every entry
 * states why the wire identity is unchanged. No other normalization exists.
 */
export const LABEL_ALIASES: Readonly<Record<string, { versions: readonly string[]; aliases: Readonly<Record<string, string>>; evidence: string }>> = {
  attribute: {
    versions: ['26.1.2', '26.2'],
    aliases: {
      armor: 'generic.armor',
      armor_toughness: 'generic.armor_toughness',
      attack_damage: 'generic.attack_damage',
      attack_knockback: 'generic.attack_knockback',
      attack_speed: 'generic.attack_speed',
      block_break_speed: 'player.block_break_speed',
      block_interaction_range: 'player.block_interaction_range',
      entity_interaction_range: 'player.entity_interaction_range',
      fall_damage_multiplier: 'generic.fall_damage_multiplier',
      flying_speed: 'generic.flying_speed',
      follow_range: 'generic.follow_range',
      gravity: 'generic.gravity',
      jump_strength: 'generic.jump_strength',
      knockback_resistance: 'generic.knockback_resistance',
      luck: 'generic.luck',
      max_absorption: 'generic.max_absorption',
      max_health: 'generic.max_health',
      movement_speed: 'generic.movement_speed',
      safe_fall_distance: 'generic.safe_fall_distance',
      scale: 'generic.scale',
      spawn_reinforcements: 'zombie.spawn_reinforcements',
      step_height: 'generic.step_height',
    },
    evidence:
      'Library-facing legacy key labels kept by minecraft-data (upstream #1254 convention) and read by mineflayer (e.g. explosion.js "generic.armor"). The wire value is the varint protocol id; only the decoded label string differs.',
  },
  particle_type: {
    versions: ['26.1.2', '26.2'],
    aliases: { trial_spawner_detection: 'trial_spawner_detected_player', trial_spawner_detection_ominous: 'trial_spawner_detected_player_ominous' },
    evidence: 'minecraft-data keeps its historical label for these two particle ids (upstream kept it deliberately in pc_26_2); particles.json and the codec agree on the id.',
  },
  slot_display: {
    versions: ['26.1.2', '26.2'],
    aliases: { dyed: 'dyed_slot_demo' },
    evidence: 'minecraft-data label for SlotDisplay type id 7; the payload layout is defined per id in the codec.',
  },
  command_argument_type: {
    versions: ['26.1.2', '26.2'],
    aliases: { nbt_compound_tag: 'nbt', team_color: 'color' },
    evidence:
      'Official ArgumentTypeInfos.bootstrap registers nbt_compound_tag (both versions), color (26.1.2) and its 26.2 rename team_color as SingletonArgumentInfo.contextFree (no serialized properties); the codec decodes minecraft:nbt / minecraft:color as void. Same id, no payload.',
  },
};

function aliasesFor(registry: string, version: string): Readonly<Record<string, string>> {
  const entry = LABEL_ALIASES[registry];
  return entry && entry.versions.includes(version) ? entry.aliases : {};
}

/** Packets added in a version, keyed phase/direction/mojangName -> reviewed minecraft-data name. */
export const REVIEWED_NEW_PACKETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // 26.2 replaces ServerboundSpectateEntityPacket with ServerboundSpectatorActionPacket (same play/serverbound id).
  '26.2': { 'play/serverbound/spectator_action': 'spectator_action' },
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Mapper names indexed by numeric id (hex keys such as "0x1a" included). */
function mapperValues(type: unknown, maxId = Number.MAX_SAFE_INTEGER): string[] | undefined {
  if (!Array.isArray(type) || type[0] !== 'mapper') return undefined;
  const mappings = (type[1] as { mappings?: Record<string, string> } | undefined)?.mappings;
  if (!mappings) return undefined;
  const out: string[] = [];
  for (const [k, v] of Object.entries(mappings)) {
    const id = Number(k);
    if (Number.isInteger(id) && id <= maxId) out[id] = v;
  }
  return out;
}

/** Every mapper type in a protocol.json, with its JSON path. */
function protocolMappers(protocol: unknown): Array<{ path: string; values: string[] }> {
  const out: Array<{ path: string; values: string[] }> = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      const values = mapperValues(node);
      if (values) out.push({ path, values });
      node.forEach((child, i) => walk(child, `${path}/${(child as { name?: string } | null)?.name ?? i}`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
    }
  };
  walk(protocol, '');
  return out;
}

function firstMismatch(a: readonly string[], b: readonly string[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return -1;
}

export function orderFinding(area: string, official: readonly string[], installed: readonly string[], aliases: Readonly<Record<string, string>> = {}): Finding {
  const expected = official.map((name) => aliases[name] ?? name);
  const used = official.filter((name) => aliases[name] !== undefined && installed.includes(aliases[name] as string));
  const at = firstMismatch(expected, installed);
  const aliasNote = used.length ? `; reviewed label aliases ${used.map((n) => `${n}=${aliases[n]}`).join(', ')}` : '';
  if (at < 0) return { area, ok: true, detail: `${official.length} entries, identical protocol-id order${aliasNote}` };
  return {
    area,
    ok: false,
    detail: `official ${official.length} vs installed ${installed.length}; first mismatch at id ${at}: official ${official[at] ?? '(none)'}${aliases[official[at] ?? ''] ? ` (label ${aliases[official[at] ?? '']})` : ''} vs installed ${installed[at] ?? '(none)'}`,
  };
}

/**
 * Packet name correspondence (Mojang name -> minecraft-data name) learned from
 * a reference version whose installed codec is accepted, so the target
 * version's packet-id alignment can be checked by name.
 */
export function packetCorrespondence(reference: ReportDigest, referenceVersion: string): Map<string, string> {
  const md = minecraftData(referenceVersion);
  if (!md) throw new Error(`no minecraft-data for ${referenceVersion}`);
  const map = new Map<string, string>();
  for (const [phase, dirs] of Object.entries(reference.packets)) {
    for (const [dir, names] of Object.entries(dirs)) {
      const installed = installedPackets(md.protocol as Json, phase, dir);
      if (!installed) continue;
      names.forEach((mojang, i) => {
        const ours = installed[i];
        if (ours) map.set(`${phase}/${dir}/${mojang}`, ours);
      });
    }
  }
  return map;
}

const PHASE: Record<string, string> = { handshake: 'handshaking', status: 'status', login: 'login', configuration: 'configuration', play: 'play' };
const DIR: Record<string, string> = { clientbound: 'toClient', serverbound: 'toServer' };

function installedPackets(protocol: Json, phase: string, dir: string): string[] | undefined {
  const container = protocol[PHASE[phase] ?? phase]?.[DIR[dir] ?? dir]?.types?.packet;
  const nameField = Array.isArray(container) ? (container[1] as Array<{ name: string; type: unknown }>).find((f) => f.name === 'name') : undefined;
  // The handshake mapper also names the pre-netty legacy ping (0xfe), which is not a protocol packet.
  return nameField ? mapperValues(nameField.type, phase === 'handshake' ? 0x7f : Number.MAX_SAFE_INTEGER) : undefined;
}

export interface CompareOptions {
  /** Mojang->minecraft-data packet names learned from an accepted reference version. */
  correspondence?: Map<string, string>;
  /** Packet names (phase/dir/mojangName) that are new in this version, with their reviewed minecraft-data names. */
  newPackets?: Record<string, string>;
}

/** Compares the installed minecraft-data for `version` with an official digest. */
export function compareDigest(digest: ReportDigest, version: string, options: CompareOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const md = minecraftData(version);
  if (!md) return [{ area: 'data', ok: false, detail: `no installed minecraft-data for ${version}` }];
  const registry = require('prismarine-registry')(version);
  const Block = require('prismarine-block')(registry) as { fromStateId(id: number, biome: number): { name: string; getProperties(): Record<string, unknown> } };

  // ---------------------------------------------------------------- blocks and every state
  const officialBlocks = Object.keys(digest.blocks);
  const missing = officialBlocks.filter((b) => !md.blocksByName[b]);
  const extra = md.blocksArray.map((b) => b.name).filter((b) => !digest.blocks[b]);
  findings.push({ area: 'blocks.names', ok: !missing.length && !extra.length, detail: `${officialBlocks.length} official; missing ${missing.slice(0, 8).join(',') || 'none'}; extra ${extra.slice(0, 8).join(',') || 'none'}` });
  let rangeBad: string[] = [];
  let stateBad: string[] = [];
  let states = 0;
  for (const [name, [min, max, def, props]] of Object.entries(digest.blocks)) {
    const b = md.blocksByName[name] as (typeof md.blocksArray)[number] | undefined;
    if (!b) continue;
    if (b.minStateId !== min || b.maxStateId !== max || b.defaultState !== def) {
      rangeBad.push(`${name}[${b.minStateId}-${b.maxStateId} d${b.defaultState} vs ${min}-${max} d${def}]`);
      continue;
    }
    const total = max - min + 1;
    for (let i = 0; i < total; i++) {
      // Expected properties from the official cartesian layout (last property fastest).
      const expected: Record<string, string> = {};
      let rest = i;
      for (let p = props.length - 1; p >= 0; p--) {
        const [pname, values] = props[p] as [string, string[]];
        expected[pname] = values[rest % values.length] as string;
        rest = Math.floor(rest / values.length);
      }
      const block = Block.fromStateId(min + i, 0);
      const got = block.getProperties();
      states++;
      const same = block.name === name && Object.keys(expected).every((k) => String(got[k]) === expected[k]) && Object.keys(got).length === Object.keys(expected).length;
      if (!same && stateBad.length < 12) stateBad.push(`${min + i}:${name}${JSON.stringify(expected)}->${block.name}${JSON.stringify(got)}`);
    }
  }
  findings.push({ area: 'blocks.stateRanges', ok: !rangeBad.length, detail: rangeBad.length ? rangeBad.slice(0, 8).join('; ') : 'every block min/max/default state id matches' });
  findings.push({ area: 'blocks.stateDecode', ok: !stateBad.length, detail: stateBad.length ? stateBad.join('; ') : `${states} states decoded by prismarine-block match the official properties` });
  rangeBad = [];
  stateBad = [];

  // ---------------------------------------------------------------- registries
  const itemNames = md.itemsArray.slice().sort((a, b) => a.id - b.id).map((i) => i.name);
  findings.push(orderFinding('registry.item (items.json ids)', digest.registries['item'] ?? [], itemNames));
  const entityNames = md.entitiesArray.slice().sort((a, b) => a.id - b.id).map((e) => e.name);
  findings.push(orderFinding('registry.entity_type (entities.json ids)', digest.registries['entity_type'] ?? [], entityNames));
  const particleNames = ((md as unknown as { particlesArray?: Array<{ id: number; name: string }> }).particlesArray ?? []).slice().sort((a, b) => a.id - b.id).map((p) => p.name);
  findings.push(orderFinding('registry.particle_type (particles.json ids)', digest.registries['particle_type'] ?? [], particleNames));
  const blockIdNames = md.blocksArray.slice().sort((a, b) => a.id - b.id).map((b) => b.name);
  findings.push(orderFinding('registry.block (blocks.json ids)', digest.registries['block'] ?? [], blockIdNames));

  // Mapper types in the protocol codec that encode a registry by protocol id.
  const mappers = protocolMappers(md.protocol);
  const wanted: Array<{ area: string; path: RegExp; registry: string }> = [
    { area: 'codec.SlotComponentType', path: /^\/types\/SlotComponentType$/, registry: 'data_component_type' },
    { area: 'codec.Particle.type', path: /^\/types\/Particle\/1\/type\/type$/, registry: 'particle_type' },
    { area: 'codec.entity_update_attributes.key', path: /packet_entity_update_attributes\/.*\/key\/type$/, registry: 'attribute' },
    { area: 'codec.recipe_book_category', path: /\/category\/type$/, registry: 'recipe_book_category' },
    { area: 'codec.SlotDisplay.type', path: /\/types\/SlotDisplay\/1\/type\/type$/, registry: 'slot_display' },
    { area: 'codec.command_argument_parser', path: /\/types\/command_node\/.*\/parser\/type$/, registry: 'command_argument_type' },
  ];
  for (const w of wanted) {
    const found = mappers.filter((m) => w.path.test(m.path));
    if (!found.length) {
      findings.push({ area: w.area, ok: false, detail: `expected mapper not found in the codec (registry ${w.registry})` });
      continue;
    }
    for (const m of found) {
      // Codec labels may carry the minecraft:/brigadier: namespace only for command parsers; official names here are unnamespaced except brigadier:*.
      const values = m.values.map((v) => v.replace(/^minecraft:/, ''));
      findings.push(orderFinding(`${w.area} ${m.path}`, digest.registries[w.registry] ?? [], values, aliasesFor(w.registry, version)));
    }
  }

  // ---------------------------------------------------------------- packets
  if (options.correspondence) {
    for (const [phase, dirs] of Object.entries(digest.packets)) {
      for (const [dir, names] of Object.entries(dirs)) {
        const installed = installedPackets(md.protocol as Json, phase, dir);
        if (!installed) {
          if (names.length) findings.push({ area: `packets.${phase}.${dir}`, ok: phase === 'handshake' || phase === 'status', detail: `no installed packet mapper (${names.length} official)` });
          continue;
        }
        const bad: string[] = [];
        names.forEach((mojang, i) => {
          const key = `${phase}/${dir}/${mojang}`;
          const want = options.correspondence?.get(key) ?? options.newPackets?.[key];
          if (want === undefined) bad.push(`id ${i} ${mojang}: new packet without a reviewed name (installed ${installed[i] ?? 'none'})`);
          else if (installed[i] !== want) bad.push(`id ${i} ${mojang}: expected ${want}, installed ${installed[i] ?? 'none'}`);
        });
        if (installed.length !== names.length) bad.push(`count official ${names.length} vs installed ${installed.length}`);
        findings.push({ area: `packets.${phase}.${dir}`, ok: !bad.length, detail: bad.length ? bad.slice(0, 6).join('; ') : `${names.length} packet ids aligned by name` });
      }
    }
  }
  return findings;
}
