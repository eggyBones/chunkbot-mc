# A newer local logout/update authority clears on flags still awaiting their tick.
# Off is never erased by a pulse, even when it superseded an acknowledged on.
scoreboard players reset * chunkbot_on
execute if score #request cb_ctl matches 1 run data modify storage chunkbot_control:bridge state.request.action set value 0
execute if score #request cb_ctl matches 1 run scoreboard players operation #ack cb_ctl = #generation cb_ctl
execute if score #request cb_ctl matches 1 store result storage chunkbot_control:bridge state.acknowledged int 1 run scoreboard players get #ack cb_ctl
execute if score #request cb_ctl matches 1 run scoreboard players set #request cb_ctl 0
