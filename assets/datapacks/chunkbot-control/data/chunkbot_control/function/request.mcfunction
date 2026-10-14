scoreboard players add #generation cb_ctl 1
scoreboard players operation #request_tick cb_ctl = #clock cb_ctl
execute store result storage chunkbot_control:bridge state.generation int 1 run scoreboard players get #generation cb_ctl
execute store result storage chunkbot_control:bridge state.request.generation int 1 run scoreboard players get #generation cb_ctl
execute store result storage chunkbot_control:bridge state.request.tick int 1 run scoreboard players get #clock cb_ctl
execute store result storage chunkbot_control:bridge state.request.action int 1 run scoreboard players get #request cb_ctl
execute store result storage chunkbot_control:bridge state.request.ownerSession int 1 run scoreboard players get #owner_session cb_ctl
execute store result storage chunkbot_control:bridge state.request.managerGeneration int 1 run scoreboard players get #manager_gen cb_ctl
data modify storage chunkbot_control:bridge state.request.owner set from entity @s UUID
tellraw @s {"text":"Chunkbot: trigger recorded; completion awaits the managed application.","color":"yellow"}
