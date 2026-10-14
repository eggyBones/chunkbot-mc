scoreboard players set #armed cb_ctl 0
scoreboard players set #heartbeat cb_ctl 0
scoreboard players set #display cb_ctl 0
scoreboard players set #blocker cb_ctl 7
scoreboard players set #request cb_ctl 0
scoreboard players reset * chunkbot_on
scoreboard players reset * chunkbot_off
data modify storage chunkbot_control:bridge state.heartbeat set value 0
data modify storage chunkbot_control:bridge state.display set value 0
data modify storage chunkbot_control:bridge state.blocker set value 7
data modify storage chunkbot_control:bridge state.request.action set value 0
