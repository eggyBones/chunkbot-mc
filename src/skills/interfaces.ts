// Shared fenced helpers for block interfaces (furnaces, containers): open a
// visible block's window, read its server-confirmed contents, and move items
// with single fenced clicks (no Mineflayer transfer/deposit macros).
import type { Actuator, ConfirmedWindow } from '../execution/actuator.ts';
import type { GameSession } from '../game/connection.ts';
import { BLOCK_REACH, sessionWorld, eyeOf } from '../perception/perception.ts';
import { visibleFaces, type FaceName } from '../perception/visibility.ts';
import { eyeDistanceToBlock, liveBlock, mk, type LiveBlock } from './common.ts';
import type { SkillServices } from './definition.ts';

export type Win = {
  id: number;
  type: string;
  slots: Array<{ name: string; count: number; stackSize: number } | null>;
  inventoryStart: number;
  inventoryEnd: number;
  selectedItem: { name: string; count: number } | null;
};

export interface OpenedInterface {
  win: Win;
  block: LiveBlock;
}

/** Validates a handle as a visible block in reach and of an allowed type; returns error text otherwise. */
export function interfaceBlock(services: SkillServices, session: GameSession, ref: { snapshotId: string; handle: string }, allowed: RegExp): (LiveBlock & { face: FaceName }) | { error: string; detail: string } {
  const live = liveBlock(services, session, ref.snapshotId, ref.handle);
  if ('error' in live) return live;
  if (!allowed.test(live.name)) return { error: 'wrong_block', detail: `${ref.handle} is ${live.name}` };
  const bot = session.bot;
  const d = eyeDistanceToBlock(bot, live.x, live.y, live.z);
  if (d > BLOCK_REACH) return { error: 'out_of_reach', detail: `${live.name} is ${d.toFixed(1)} blocks away (reach ${BLOCK_REACH})` };
  const faces = visibleFaces(sessionWorld(session), eyeOf(bot), live.x, live.y, live.z);
  if (faces.length === 0) return { error: 'not_visible', detail: `${live.name} is not visible` };
  return { ...live, face: faces[0] as FaceName };
}

export async function openInterface(act: Actuator, block: LiveBlock & { face: FaceName }): Promise<Win> {
  const w = await act.openBlockWindow(block, block.face);
  return w as unknown as Win;
}

/** Contents of window slots [start, end) from a server-confirmed resync. */
export function regionCounts(confirmed: ConfirmedWindow, start: number, end: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [slot, stack] of confirmed.slots) if (slot >= start && slot < end) out[stack.key] = (out[stack.key] ?? 0) + stack.count;
  return out;
}

export function slotStack(confirmed: ConfirmedWindow, slot: number): { key: string; count: number } | null {
  return confirmed.slots.get(slot) ?? null;
}

/**
 * Moves up to `count` of `item` from window slots [fromStart, fromEnd) into the
 * destination slots, one fenced click at a time. Returns the count moved
 * according to the local model (confirm with a server resync afterwards).
 */
export async function moveItems(
  act: Actuator,
  win: Win,
  item: string,
  count: number,
  from: [number, number],
  dest: number[],
  onMoved?: (movedSoFar: number) => void,
): Promise<number> {
  let moved = 0;
  const key = mk(item);
  const isItem = (s: Win["slots"][number] | undefined) => Boolean(s && mk(s.name) === key);
  while (moved < count) {
    let source: number | undefined;
    for (let s = from[0]; s < from[1]; s += 1) if (isItem(win.slots[s])) source ??= s;
    if (source === undefined) break;
    const target = dest.find((d) => !win.slots[d] || (isItem(win.slots[d]) && (win.slots[d] as { count: number; stackSize: number }).count < (win.slots[d] as { stackSize: number }).stackSize));
    if (target === undefined) break;
    const stackCount = (win.slots[source] as { count: number }).count;
    const need = count - moved;
    const room = win.slots[target] ? (win.slots[target] as { stackSize: number; count: number }).stackSize - (win.slots[target] as { count: number }).count : 64;
    await act.click(source, 0, 0, win.id); // pick up the stack
    if (stackCount <= need && stackCount <= room) {
      await act.click(target, 0, 0, win.id, () => onMoved?.(moved + stackCount)); // put all
      moved += stackCount;
    } else {
      const n = Math.min(need, room);
      for (let i = 0; i < n; i += 1) {
        await act.click(target, 1, 0, win.id, () => onMoved?.(moved + i + 1)); // one at a time
      }
      moved += n;
    }
    onMoved?.(moved);
    if (win.selectedItem) await act.click(source, 0, 0, win.id); // return the remainder
  }
  return moved;
}
