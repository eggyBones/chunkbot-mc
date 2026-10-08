// Helpers shared by skill executors and resolvers. Executors only act through
// the fenced Actuator; resolvers only read.
import { Vec3 } from 'vec3';
import type { JsonValue, RemovalCarry } from '../contracts/index.ts';
import type { Actuator } from '../execution/actuator.ts';
import { inventoryFromConfirmed, type Counts, type InventoryView } from '../execution/ledger.ts';
import type { GameSession } from '../game/connection.ts';
import { BLOCK_REACH, eyeOf, groupLineageScore, sessionWorld, type HandleRecord } from '../perception/perception.ts';
import { UNCONFIRMED_BLOCK, type Vec } from '../perception/visibility.ts';
import type { ResolveContext, SkillServices, TaskHints, Unavailable } from './definition.ts';

type Bot = GameSession['bot'];

export const mk = (name: string) => (name.includes(':') ? name : `minecraft:${name}`);
export const bare = (key: string) => key.replace(/^#?minecraft:/, '');
const round1 = (n: number) => Math.round(n * 10) / 10;
export const pos3 = (p: Vec) => ({ x: round1(p.x), y: round1(p.y), z: round1(p.z) });

/** Client-model inventory counts (optimistic; for candidate preconditions only). */
export function clientCounts(bot: Bot): Counts {
  const counts: Counts = new Map();
  for (const item of bot.inventory.items()) counts.set(mk(item.name), (counts.get(mk(item.name)) ?? 0) + item.count);
  return counts;
}

export function countsRecord(counts: Counts, keys?: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys ?? counts.keys()) out[key] = counts.get(key) ?? 0;
  return out;
}

/** Server-confirmed inventory via a forced resync of the current window. */
export async function confirmInventory(act: Actuator, services: SkillServices): Promise<InventoryView | undefined> {
  const confirmed = await act.confirmWindow();
  if (!confirmed) return undefined;
  const window = act.window() as unknown as { id: number; inventoryStart: number };
  const view = inventoryFromConfirmed(confirmed, window.inventoryStart, services.clock.now());
  services.ledger.setInventory(view);
  return view;
}

export function countMatching(counts: Counts, selector: string, services: SkillServices): number {
  const book = services.knowledge.recipes;
  let total = 0;
  for (const [key, n] of counts) {
    if (selector.startsWith('#') ? book?.matches(selector, key) : key === selector) total += n;
  }
  return total;
}

/** Whether an item key matches any hint key (exact or tag), or there are no item hints. */
export function matchesHints(key: string, hints: TaskHints, services: SkillServices): boolean {
  if (hints.keys.length === 0) return true;
  const book = services.knowledge.recipes;
  return hints.keys.some((h) => (h.startsWith('#') ? Boolean(book?.matches(h, key)) : h === key));
}

/**
 * Puts `key` in the main hand using fenced clicks (no Mineflayer equip macro),
 * then confirms the held slot with a server resync. `null` empties the hand.
 */
/**
 * Puts an item (or an empty hand) in the main hand. The client model only
 * chooses the slot; the result is server-confirmed by a forced inventory
 * resync, and `confirmed` is false when no authoritative resync arrived (the
 * caller must then not claim server confirmation).
 */
export async function ensureInHand(act: Actuator, services: SkillServices, key: string | null): Promise<{ ok: boolean; detail: string; hotbar?: number; confirmed: boolean }> {
  const bot = act.bot;
  if (bot.currentWindow) return { ok: false, detail: 'another interface is open', confirmed: false };
  const inv = bot.inventory.slots;
  const held = bot.quickBarSlot ?? 0;
  const keyAt = (slot: number) => (inv[slot] ? mk(inv[slot]!.name) : null);
  let hotbar: number | undefined;
  if (keyAt(36 + held) === key) {
    const view = await confirmInventory(act, services);
    if (!view) return { ok: true, detail: 'already in hand (client model; no server resync)', hotbar: held, confirmed: false };
    const confirmed = view.slots.get(36 + held)?.key ?? null;
    if (confirmed === key) return { ok: true, detail: 'already in hand (server-confirmed)', hotbar: held, confirmed: true };
    // The client model was stale; fall through and choose from the confirmed view's client mirror.
  }
  hotbar = undefined;
  for (let i = 0; i < 9; i += 1) if (keyAt(36 + i) === key) hotbar = i;
  if (hotbar === undefined) {
    if (key === null) {
      return { ok: false, detail: 'no empty hotbar slot to empty the hand', confirmed: false };
    }
    let source: number | undefined;
    for (let s = 9; s <= 35; s += 1) if (keyAt(s) === key) source = s;
    if (source === undefined) return { ok: false, detail: `${key} is not in the inventory`, confirmed: false };
    let target: number | undefined;
    for (let i = 0; i < 9; i += 1) if (!inv[36 + i]) target = target ?? i;
    target ??= held;
    act.usedInventoryGrid = true; // cursor use: inventory close returns a carried stack on revocation
    await act.click(source, 0, 0, 0);
    await act.click(36 + target, 0, 0, 0);
    if ((bot.inventory as unknown as { selectedItem: unknown }).selectedItem) await act.click(source, 0, 0, 0);
    hotbar = target;
  }
  act.selectHotbar(hotbar);
  const view = await confirmInventory(act, services);
  if (!view) return { ok: false, detail: `no server inventory resync after selecting hotbar ${hotbar}`, hotbar, confirmed: false };
  const confirmed = view.slots.get(36 + hotbar)?.key ?? null;
  if (confirmed !== key) return { ok: false, detail: `server reports ${confirmed ?? 'empty'} in hotbar ${hotbar}`, confirmed: true };
  return { ok: true, detail: `selected hotbar ${hotbar} (server-confirmed)`, hotbar, confirmed: true };
}

export interface LiveBlock {
  x: number;
  y: number;
  z: number;
  name: string;
  stateId: number;
  record: HandleRecord;
}

/** Resolves a block handle and revalidates the live block (same type, still loaded). */
export function liveBlock(services: SkillServices, session: GameSession, snapshotId: string, handle: string): LiveBlock | { error: string; detail: string } {
  const rec = services.perception.resolve(snapshotId, handle);
  if ('error' in rec) return { error: rec.error, detail: `handle ${handle} cannot be resolved (${rec.error})` };
  if (rec.target.kind !== 'block') return { error: 'wrong_target_kind', detail: `${handle} is a ${rec.target.kind}, not a block` };
  const { x, y, z, name } = rec.target;
  // Same authority seam as perception: a pending client prediction is not a fact.
  if (sessionWorld(session).blockAt(x, y, z)?.name === UNCONFIRMED_BLOCK) {
    return { error: 'target_unconfirmed', detail: `block at ${x},${y},${z} has a local change the server has not confirmed yet` };
  }
  const block = session.bot.blockAt(new Vec3(x, y, z));
  if (!block) return { error: 'target_unloaded', detail: `block at ${x},${y},${z} is no longer loaded` };
  if (block.name !== name) return { error: 'target_changed', detail: `block at ${x},${y},${z} is now ${block.name} (was ${name})` };
  return { x, y, z, name, stateId: block.stateId, record: rec };
}

export interface LiveEntity {
  entityId: number;
  name: string;
  position: Vec;
  height: number;
  record: HandleRecord;
}

export function liveEntity(services: SkillServices, session: GameSession, snapshotId: string, handle: string): LiveEntity | { error: string; detail: string } {
  const rec = services.perception.resolve(snapshotId, handle);
  if ('error' in rec) return { error: rec.error, detail: `handle ${handle} cannot be resolved (${rec.error})` };
  if (rec.target.kind !== 'entity' && rec.target.kind !== 'drop') return { error: 'wrong_target_kind', detail: `${handle} is not an entity or drop` };
  const entity = session.bot.entities[rec.target.entityId];
  if (!entity?.position || (entity as { isValid?: boolean }).isValid === false) return { error: 'target_gone', detail: `${handle} is no longer present` };
  return { entityId: rec.target.entityId, name: entity.name ?? 'unknown', position: entity.position, height: (entity as { height?: number }).height ?? 1, record: rec };
}

export function eyeDistanceToBlock(bot: Bot, x: number, y: number, z: number): number {
  const e = eyeOf(bot);
  return Math.hypot(x + 0.5 - e.x, y + 0.5 - e.y, z + 0.5 - e.z);
}

export function inBlockReach(bot: Bot, x: number, y: number, z: number): boolean {
  return eyeDistanceToBlock(bot, x, y, z) <= BLOCK_REACH;
}

export interface TargetScope {
  /** True when the task names explicit world targets (then nothing else is eligible). */
  named: boolean;
  /** Named handles re-grounded in the current snapshot. */
  current: ReadonlySet<string>;
  /**
   * MB-PLAN-006: positions ("x,y,z") of the visible members of named block
   * GROUPS re-grounded in this snapshot (e.g. one bound tree). A block handle at
   * one of these positions is in scope; nothing outside the bound group is.
   */
  groupMembers: ReadonlySet<string>;
  allows(handle: string): boolean;
}

/**
 * Primary-target authority. When a task names targets (observed selectors),
 * only those — re-grounded in THIS snapshot by the candidate generator — are
 * eligible; a named target that is stale, removed, or from another snapshot,
 * connection or dimension admits NOTHING (never a fallback to every handle).
 * A named group handle admits exactly the block handles of its visible
 * members in this snapshot (resolved through perception when available).
 */
export function targetScope(ctx: Pick<ResolveContext, 'hints' | 'snapshot'> & Partial<Pick<ResolveContext, 'services'>>): TargetScope {
  const primary = ctx.hints.primaryHandles ?? ctx.hints.handles;
  const named = primary.length > 0;
  const current = new Set(primary.filter((h) => h.snapshotId === ctx.snapshot.id).map((h) => h.handle));
  const groupMembers = new Set<string>();
  const perception = ctx.services?.perception;
  if (perception && typeof perception.groupMembers === 'function') {
    for (const h of current) for (const m of perception.groupMembers(ctx.snapshot.id, h) ?? []) groupMembers.add(`${m.x},${m.y},${m.z}`);
  }
  const removalScopes = (ctx.hints.removalHandles ?? []).map((h) => {
    const handles = new Set(h.snapshotId === ctx.snapshot.id ? [h.handle] : []);
    const members = new Set<string>();
    if (perception) for (const target of handles) for (const m of perception.groupMembers(ctx.snapshot.id, target) ?? []) members.add(`${m.x},${m.y},${m.z}`);
    return { handles, members };
  });
  const allows = (handle: string): boolean => {
    // Each removal predicate names separate required work. An action may work
    // on ONE member; it cannot satisfy three distinct handles simultaneously.
    // This work set still intersects the primary target set below, and the
    // original code-owned goal removal scope fences candidates and execution.
    if (removalScopes.length && !removalScopes.some((s) => {
      if (s.handles.has(handle)) return true;
      const r = perception?.resolve(ctx.snapshot.id, handle);
      return r && !('error' in r) && r.target.kind === 'block' && s.members.has(`${r.target.x},${r.target.y},${r.target.z}`);
    })) return false;
    if (!named || current.has(handle)) return true;
    if (groupMembers.size === 0 || !perception) return false;
    const r = perception.resolve(ctx.snapshot.id, handle);
    return !('error' in r) && r.target.kind === 'block' && groupMembers.has(`${r.target.x},${r.target.y},${r.target.z}`);
  };
  return { named, current, groupMembers, allows };
}

/** Final destructive fence over the goal's ORIGINAL bound removal lineage. */
export function removalScopeAllows(services: Pick<SkillServices, 'perception' | 'knowledge'>, target: unknown, scope: readonly RemovalCarry[], dimension: string): boolean {
  if (!target || typeof target !== 'object') return false;
  const ref = target as { snapshotId?: unknown; handle?: unknown };
  if (typeof ref.snapshotId !== 'string' || typeof ref.handle !== 'string') return false;
  const rec = services.perception.resolve(ref.snapshotId, ref.handle);
  if ('error' in rec || rec.target.kind !== 'block') return false;
  const t = rec.target;
  const key = mk(t.name);
  return scope.some((r) => {
    if (r.dimension !== dimension || !(r.selector.startsWith('#') ? services.knowledge.recipes?.matches(r.selector, key) : r.selector === key)) return false;
    if (r.members.some((m) => m.x === t.x && m.y === t.y && m.z === t.z && m.key === key)) return true;
    const id = r.identity;
    // Newly visible members must link to the ORIGINAL bounded component,
    // excluding every originally observed unrelated trunk; no target union.
    return Boolean(id && groupLineageScore({ ...id, anchors: new Set(id.anchors.map((p) => `${p.x},${p.y},${p.z}`)), others: new Set(id.others.map((p) => `${p.x},${p.y},${p.z}`)) }, { class: id.class, trunk: [t] }) > 0);
  });
}

/** Compatibility wrapper used by older call sites: same authority rule as targetScope. */
export function handleFilter(ctx: Pick<ResolveContext, 'hints' | 'snapshot'>): (handle: string) => boolean {
  return targetScope(ctx).allows;
}

/** Evidence for a named target that is not eligible in the current snapshot. */
export function namedTargetUnavailable(scope: TargetScope, what: string): Unavailable {
  return {
    reason: scope.current.size > 0 ? 'named_target_not_eligible' : 'named_target_not_visible',
    detail: scope.current.size > 0 ? `the task's named target is not a usable ${what} here` : `the task's named target is not visible in the current observation`,
  };
}

/**
 * Admitted task parameters for one capability: the task.parameters keys the
 * capability's registered schema declares, validated field by field. Resolvers
 * must honor these; the candidate generator also enforces them.
 */
export function admittedParameters(ctx: Pick<ResolveContext, 'hints'>, schema: unknown): { values: Record<string, unknown>; invalid: string[] } {
  const shape = (schema as { shape?: Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }> }).shape ?? {};
  const values: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const [key, value] of Object.entries(ctx.hints.parameters ?? {})) {
    const field = shape[key];
    if (!field) continue;
    const r = field.safeParse(value);
    if (r.success) values[key] = r.data;
    else invalid.push(key);
  }
  return { values, invalid };
}

export function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

/** Best harvest tool available in `counts` for a block, per installed data. */
export function chooseTool(services: SkillServices, blockKey: string, counts: Counts): { tool: string | null; requiresTool: boolean; validTools: string[] } {
  const k = services.knowledge;
  const validTools = k.harvestTools(blockKey);
  const speeds = k.toolSpeeds(blockKey);
  const have = (key: string) => (counts.get(key) ?? 0) > 0;
  if (validTools.length > 0) {
    const ranked = validTools.filter(have).sort((a, b) => (speeds.find((s) => s.tool === b)?.multiplier ?? 1) - (speeds.find((s) => s.tool === a)?.multiplier ?? 1));
    return { tool: ranked[0] ?? null, requiresTool: true, validTools };
  }
  const faster = speeds.find((s) => have(s.tool));
  return { tool: faster?.tool ?? null, requiresTool: false, validTools };
}
