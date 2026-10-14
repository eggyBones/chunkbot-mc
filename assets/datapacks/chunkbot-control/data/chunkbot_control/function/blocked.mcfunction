execute if score #blocker cb_ctl matches 0 run tellraw @s {"text":"Chunkbot: blocked by manager policy.","color":"red"}
execute if score #blocker cb_ctl matches 1 run tellraw @s {"text":"Chunkbot: blocked; bot sign-in required through explicit local auth. No automatic login.","color":"red"}
execute if score #blocker cb_ctl matches 2 run tellraw @s {"text":"Chunkbot: blocked; server whitelist denied the bot.","color":"red"}
execute if score #blocker cb_ctl matches 3 run tellraw @s {"text":"Chunkbot: blocked; configured server version is unsupported or mismatched.","color":"red"}
execute if score #blocker cb_ctl matches 4 run tellraw @s {"text":"Chunkbot: blocked; configured server or private tunnel is unreachable.","color":"red"}
execute if score #blocker cb_ctl matches 5 run tellraw @s {"text":"Chunkbot: blocked; bot or owner identity mismatch.","color":"red"}
execute if score #blocker cb_ctl matches 6 run tellraw @s {"text":"Chunkbot: blocked; old child or connection cleanup is unconfirmed.","color":"red"}
execute if score #blocker cb_ctl matches 7 run tellraw @s {"text":"Chunkbot: manager unavailable; no automatic reconnect.","color":"red"}
