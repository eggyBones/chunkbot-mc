// Repeatable controlled survival scene for skill live checks, built ONLY in the
// isolated loopback fixture world through RCON setup commands (recorded by the
// caller). The area x 196..224, z 190..224 is reset each run; nothing outside
// it is touched.
//
// Layout (flat world, ground = grass_block at y=-61, standing y=-60):
//   bot start            (205.5, -60, 205.5)
//   oak log trunk        x=208 z=202, y -60..-58   (hand/axe harvestable, drops itself)
//   stone pair           x=202 z=203..204, y -60     (needs a pickaxe, drops cobblestone)
//   chest                (203, -60, 207)
//   occlusion wall       x 203..208, z=212, y -60..-57 (stone bricks) with a glass
//                        window at (207, -59, 212)
//   behind the wall      diamond_ore (205,-60,214) hidden; emerald_block (207,-59,214)
//                        visible through glass; NoAI cow (205.5,-60,215.5) hidden;
//                        apple item (204.5,-60,214.5) hidden
//   in front             NoAI pig (201.5,-60,209.5) visible; bread item (204.5,-60,209.5)
//   animals              NoAI cow (210.5,-60,206.5), sheep (210.5,-60,204.5),
//                        chicken (211.5,-60,208.5)
//   obsidian             (200, -60, 205) for dig-cancellation (unharvestable by hand)

export const SCENE = {
  start: { x: 205.5, y: -60, z: 205.5 },
  area: { x1: 196, z1: 190, x2: 224, z2: 224 },
  logs: [
    { x: 208, y: -60, z: 202 },
    { x: 208, y: -59, z: 202 },
    { x: 208, y: -58, z: 202 },
  ],
  stone: [
    { x: 202, y: -60, z: 203 },
    { x: 202, y: -60, z: 204 },
  ],
  chest: { x: 203, y: -60, z: 207 },
  wall: { x1: 203, x2: 208, z: 212, y1: -60, y2: -57 },
  glass: { x: 207, y: -59, z: 212 },
  hiddenOre: { x: 205, y: -60, z: 214 },
  throughGlass: { x: 207, y: -59, z: 214 },
  obsidian: { x: 200, y: -60, z: 205 },
} as const;

/**
 * Phase 1: remove previous scene entities. Mobs killed here drop loot, so the
 * caller waits ~1.5 s before phase 2 removes item entities and rebuilds.
 */
export function sceneClearCommands(bot = 'Chunkbot'): string[] {
  const { x1, z1, x2, z2 } = SCENE.area;
  return [
    `forceload add ${x1} ${z1} ${x2} ${z2}`,
    `tp ${bot} ${SCENE.start.x} ${SCENE.start.y + 30} ${SCENE.start.z}`,
    `effect give ${bot} slow_falling 5 0 true`,
    `kill @e[type=!player,x=${x1},y=-64,z=${z1},dx=${x2 - x1},dy=40,dz=${z2 - z1}]`,
  ];
}

/** Phase 2: ordered RCON setup commands for the scene (only Chunkbot's state is reset). */
export function sceneCommands(bot = 'Chunkbot'): string[] {
  const { x1, z1, x2, z2 } = SCENE.area;
  const w = SCENE.wall;
  const cmds = [
    `kill @e[type=item,x=${x1},y=-64,z=${z1},dx=${x2 - x1},dy=40,dz=${z2 - z1}]`,
    `kill @e[type=experience_orb,x=${x1},y=-64,z=${z1},dx=${x2 - x1},dy=40,dz=${z2 - z1}]`,
    `fill ${x1} -60 ${z1} ${x2} -50 ${z2} air`,
    `fill ${x1} -61 ${z1} ${x2} -61 ${z2} grass_block`,
    `fill ${x1} -63 ${z1} ${x2} -62 ${z2} dirt`,
    ...SCENE.logs.map((p) => `setblock ${p.x} ${p.y} ${p.z} oak_log`),
    ...SCENE.stone.map((p) => `setblock ${p.x} ${p.y} ${p.z} stone`),
    `setblock ${SCENE.chest.x} ${SCENE.chest.y} ${SCENE.chest.z} chest[facing=north]`,
    `fill ${w.x1} ${w.y1} ${w.z} ${w.x2} ${w.y2} ${w.z} stone_bricks`,
    `setblock ${SCENE.glass.x} ${SCENE.glass.y} ${SCENE.glass.z} glass`,
    `setblock ${SCENE.hiddenOre.x} ${SCENE.hiddenOre.y} ${SCENE.hiddenOre.z} diamond_ore`,
    `setblock ${SCENE.throughGlass.x} ${SCENE.throughGlass.y} ${SCENE.throughGlass.z} emerald_block`,
    `setblock ${SCENE.obsidian.x} ${SCENE.obsidian.y} ${SCENE.obsidian.z} obsidian`,
    `summon cow 205.5 -60 215.5 {NoAI:1b,Tags:["chunkbot_hidden"]}`,
    `summon item 204.5 -60 214.5 {Item:{id:"minecraft:apple",count:1},PickupDelay:32767s,Tags:["chunkbot_hidden"]}`,
    `summon pig 201.5 -60 209.5 {NoAI:1b,Tags:["chunkbot_front"]}`,
    `summon item 204.5 -60 209.5 {Item:{id:"minecraft:bread",count:1},PickupDelay:32767s,Tags:["chunkbot_front"]}`,
    `summon cow 210.5 -60 206.5 {NoAI:1b,Tags:["chunkbot_animal"]}`,
    `summon sheep 210.5 -60 204.5 {NoAI:1b,Color:0b,Tags:["chunkbot_animal"]}`,
    `summon chicken 211.5 -60 208.5 {NoAI:1b,Tags:["chunkbot_animal"]}`,
    `clear ${bot}`,
    'clear FixtureOwner',
    `effect clear ${bot}`,
    `gamemode survival ${bot}`,
    `tp ${bot} ${SCENE.start.x} ${SCENE.start.y} ${SCENE.start.z} 0 0`,
  ];
  return cmds;
}
