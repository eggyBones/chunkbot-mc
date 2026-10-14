# ADMIN ONLY, then disable/remove this datapack. Removes only task-owned state.
function chunkbot_control:reset
scoreboard objectives remove chunkbot_on
scoreboard objectives remove chunkbot_off
scoreboard objectives remove chunkbot_status
scoreboard objectives remove cb_ctl
scoreboard objectives remove cb_leave
data remove storage chunkbot_control:bridge state
data remove storage chunkbot_control:bridge bound
