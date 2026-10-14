$execute unless score #manager_gen cb_ctl matches $(manager_generation) run function chunkbot_control:fence_on
$scoreboard players set #manager_gen cb_ctl $(manager_generation)
execute store result storage chunkbot_control:bridge state.managerGeneration int 1 run scoreboard players get #manager_gen cb_ctl
$scoreboard players set #heartbeat cb_ctl $(ticks)
$scoreboard players set #display cb_ctl $(display)
$scoreboard players set #blocker cb_ctl $(blocker)
execute store result storage chunkbot_control:bridge state.heartbeat int 1 run scoreboard players get #heartbeat cb_ctl
execute store result storage chunkbot_control:bridge state.display int 1 run scoreboard players get #display cb_ctl
execute store result storage chunkbot_control:bridge state.blocker int 1 run scoreboard players get #blocker cb_ctl
# Queue acknowledgment is not logout completion. Only current verified offline opens on.
execute if score #display cb_ctl matches 1 if score #request cb_ctl matches 0 run scoreboard players set #off_latch cb_ctl 0
execute if score #display cb_ctl matches 4 run scoreboard players set #off_latch cb_ctl 1
