execute unless score #heartbeat cb_ctl matches 1.. run tellraw @s {"text":"Chunkbot: bridge unavailable (heartbeat expired); cached online state is unknown. Use local controls or start the manager.","color":"red"}
execute if score #heartbeat cb_ctl matches 1.. if score #display cb_ctl matches 0 run tellraw @s {"text":"Chunkbot: bridge initializing; application state unavailable.","color":"yellow"}
execute if score #heartbeat cb_ctl matches 1.. if score #display cb_ctl matches 1 run tellraw @s {"text":"Chunkbot: offline; manager confirms child and connection absent (fresh bridge heartbeat).","color":"gray"}
execute if score #heartbeat cb_ctl matches 1.. if score #display cb_ctl matches 2 run tellraw @s {"text":"Chunkbot: joining; spawn not yet confirmed (fresh bridge heartbeat).","color":"yellow"}
execute if score #heartbeat cb_ctl matches 1.. if score #display cb_ctl matches 3 run tellraw @s {"text":"Chunkbot: online; current bot spawn and identity confirmed (fresh bridge heartbeat).","color":"green"}
execute if score #heartbeat cb_ctl matches 1.. if score #display cb_ctl matches 4 run tellraw @s {"text":"Chunkbot: logging out; cleanup is still pending (fresh bridge heartbeat).","color":"yellow"}
execute if score #heartbeat cb_ctl matches 1.. if score #display cb_ctl matches 5 run function chunkbot_control:blocked
