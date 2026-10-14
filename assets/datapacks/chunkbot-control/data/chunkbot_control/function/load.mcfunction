# Reload/server restart revokes the mailbox. Durable installation binding survives.
scoreboard objectives add chunkbot_on trigger
scoreboard objectives add chunkbot_off trigger
scoreboard objectives add chunkbot_status trigger
scoreboard objectives add cb_ctl dummy
scoreboard objectives add cb_leave minecraft.custom:minecraft.leave_game
execute unless data storage chunkbot_control:bridge state run data modify storage chunkbot_control:bridge state set value {protocol:1,installation:"00000000000000000000000000000000",world:"unset",bot:"unset",owner:[I;0,0,0,0],version:"26_2",session:"closed",clock:0,heartbeat:0,display:0,blocker:7,generation:0,acknowledged:0,ownerSession:0,ownerPresent:0,request:{generation:0,tick:0,action:0,owner:[I;0,0,0,0],ownerSession:0}}
function chunkbot_control:reset
