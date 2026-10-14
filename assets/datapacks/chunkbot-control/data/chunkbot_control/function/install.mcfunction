# ADMIN ONLY. Explicit coordinator-reviewed installation; never called by the bridge.
$data modify storage chunkbot_control:bridge state set value {protocol:1,installation:"$(installation)",world:"$(world)",bot:"$(bot)",owner:[I;$(a),$(b),$(c),$(d)],version:"$(version)",session:"closed",clock:0,heartbeat:0,display:0,blocker:7,generation:0,acknowledged:0,ownerSession:0,ownerPresent:0,request:{generation:0,tick:0,action:0,owner:[I;0,0,0,0],ownerSession:0}}
$data modify storage chunkbot_control:bridge bound set value {a:$(a),b:$(b),c:$(c),d:$(d)}
function chunkbot_control:reset
