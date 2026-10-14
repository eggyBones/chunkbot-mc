scoreboard players reset * chunkbot_on
scoreboard players reset * chunkbot_off
scoreboard players reset * chunkbot_status
scoreboard players set #armed cb_ctl 0
scoreboard players set #heartbeat cb_ctl 0
scoreboard players set #clock cb_ctl 0
scoreboard players set #generation cb_ctl 0
scoreboard players set #ack cb_ctl 0
scoreboard players set #request cb_ctl 0
scoreboard players set #request_tick cb_ctl 0
scoreboard players set #owner_session cb_ctl 0
scoreboard players set #present cb_ctl 0
scoreboard players set #was_present cb_ctl 0
scoreboard players set #leave cb_ctl 0
scoreboard players set #manager_gen cb_ctl 0
scoreboard players set #display cb_ctl 0
scoreboard players set #blocker cb_ctl 7
scoreboard players set #off_latch cb_ctl 0
data modify storage chunkbot_control:bridge state.session set value "closed"
data modify storage chunkbot_control:bridge state.clock set value 0
data modify storage chunkbot_control:bridge state.heartbeat set value 0
data modify storage chunkbot_control:bridge state.display set value 0
data modify storage chunkbot_control:bridge state.blocker set value 7
data modify storage chunkbot_control:bridge state.managerGeneration set value 0
data modify storage chunkbot_control:bridge state.generation set value 0
data modify storage chunkbot_control:bridge state.acknowledged set value 0
data modify storage chunkbot_control:bridge state.ownerSession set value 0
data modify storage chunkbot_control:bridge state.ownerPresent set value 0
data modify storage chunkbot_control:bridge state.request set value {generation:0,tick:0,action:0,owner:[I;0,0,0,0],ownerSession:0,managerGeneration:0}
