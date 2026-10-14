execute if score #armed cb_ctl matches 1 run scoreboard players add #clock cb_ctl 1
execute if score #heartbeat cb_ctl matches 1.. run scoreboard players remove #heartbeat cb_ctl 1
execute if score #armed cb_ctl matches 1 if score #heartbeat cb_ctl matches 0 run function chunkbot_control:expire
execute if score #clock cb_ctl matches 2000000000.. run function chunkbot_control:expire
execute if score #generation cb_ctl matches 2000000000.. run function chunkbot_control:expire
execute if score #owner_session cb_ctl matches 2000000000.. run function chunkbot_control:expire
scoreboard players operation #was_present cb_ctl = #present cb_ctl
scoreboard players set #present cb_ctl 0
execute if data storage chunkbot_control:bridge bound run function chunkbot_control:tick_bound with storage chunkbot_control:bridge bound
execute store result storage chunkbot_control:bridge state.clock int 1 run scoreboard players get #clock cb_ctl
execute store result storage chunkbot_control:bridge state.heartbeat int 1 run scoreboard players get #heartbeat cb_ctl
execute store result storage chunkbot_control:bridge state.ownerSession int 1 run scoreboard players get #owner_session cb_ctl
execute store result storage chunkbot_control:bridge state.ownerPresent int 1 run scoreboard players get #present cb_ctl
