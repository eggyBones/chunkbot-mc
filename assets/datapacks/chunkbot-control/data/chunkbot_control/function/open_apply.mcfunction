function chunkbot_control:reset
$data modify storage chunkbot_control:bridge state.session set value "$(session)"
scoreboard players set #armed cb_ctl 1
# Bootstrap lease remains unavailable until the first verified manager pulse.
scoreboard players set #heartbeat cb_ctl 100
data modify storage chunkbot_control:bridge state.heartbeat set value 100
