// All registered skills. The capability catalog, candidate generation and the
// executor are built from exactly this list.
import { craftItem } from './crafting.ts';
import { containerTransfer, inspectContainer } from './containers.ts';
import type { AnySkill } from './definition.ts';
import { attackEntity, interactEntity } from './entities.ts';
import { furnaceInsert, furnaceTake, furnaceWait } from './furnace.ts';
import { dropItem, equipItem, inspectInventory } from './inventory.ts';
import { mineBlock, pickupItem } from './mining.ts';
import { exploreFrontier, followEntity, moveNear, surveySurroundings } from './movement.ts';
import { interactBlock, placeBlock, useHeldItem } from './placement.ts';

export function allSkills(): AnySkill[] {
  return [
    moveNear,
    followEntity,
    exploreFrontier,
    surveySurroundings,
    mineBlock,
    pickupItem,
    inspectInventory,
    equipItem,
    dropItem,
    craftItem,
    placeBlock,
    interactBlock,
    useHeldItem,
    furnaceInsert,
    furnaceWait,
    furnaceTake,
    inspectContainer,
    containerTransfer,
    interactEntity,
    attackEntity,
  ];
}
