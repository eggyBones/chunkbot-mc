$scoreboard players set #ack cb_ctl $(generation)
$data modify storage chunkbot_control:bridge state.acknowledged set value $(generation)
scoreboard players set #request cb_ctl 0
data modify storage chunkbot_control:bridge state.request.action set value 0
$scoreboard players set #disposition cb_ctl $(disposition)
execute as @a run function chunkbot_control:ack_owner with storage chunkbot_control:bridge bound
