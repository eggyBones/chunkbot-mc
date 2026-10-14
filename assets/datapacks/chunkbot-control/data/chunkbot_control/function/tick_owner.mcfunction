scoreboard players add @s chunkbot_on 0
scoreboard players add @s chunkbot_off 0
scoreboard players add @s chunkbot_status 0
# Persistent server leave counter also detects logout/rejoin between two ticks.
scoreboard players add @s cb_leave 0
execute unless score @s cb_leave = #leave cb_ctl run scoreboard players add #owner_session cb_ctl 1
scoreboard players operation #leave cb_ctl = @s cb_leave
execute unless score @s chunkbot_on matches 0..1 run tellraw @s {"text":"Chunkbot: unsupported trigger value; use the bare trigger command.","color":"red"}
execute unless score @s chunkbot_off matches 0..1 run tellraw @s {"text":"Chunkbot: unsupported trigger value; use the bare trigger command.","color":"red"}
execute unless score @s chunkbot_status matches 0..1 run tellraw @s {"text":"Chunkbot: unsupported trigger value; use the bare trigger command.","color":"red"}
# Off wins ambiguous same-tick flags. It latches until verified logout, not queued ack.
execute if score #armed cb_ctl matches 1 if score #heartbeat cb_ctl matches 1.. if score #display cb_ctl matches 1..5 if score @s chunkbot_off matches 1 unless score #request cb_ctl matches 2 run function chunkbot_control:request_off
execute if score @s chunkbot_on matches 1 if score #off_latch cb_ctl matches 1 run tellraw @s {"text":"Chunkbot: on discarded while logout is pending. Send a new on after verified offline.","color":"yellow"}
execute if score #armed cb_ctl matches 1 if score #heartbeat cb_ctl matches 1.. if score #display cb_ctl matches 1..5 if score @s chunkbot_on matches 1 if score #off_latch cb_ctl matches 0 if score #request cb_ctl matches 0 run function chunkbot_control:request_on
execute if score @s chunkbot_status matches 1 run function chunkbot_control:status
scoreboard players reset @s chunkbot_on
scoreboard players reset @s chunkbot_off
scoreboard players reset @s chunkbot_status
scoreboard players enable @s chunkbot_status
execute if score #armed cb_ctl matches 1 if score #heartbeat cb_ctl matches 1.. if score #display cb_ctl matches 1..5 run scoreboard players enable @s chunkbot_on
execute if score #armed cb_ctl matches 1 if score #heartbeat cb_ctl matches 1.. if score #display cb_ctl matches 1..5 run scoreboard players enable @s chunkbot_off
