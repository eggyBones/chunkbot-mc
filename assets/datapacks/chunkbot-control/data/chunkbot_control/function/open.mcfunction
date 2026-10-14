# A mismatched binding or active heartbeat cannot be adopted.
$execute unless score #heartbeat cb_ctl matches 1.. if data storage chunkbot_control:bridge state{protocol:1,installation:"$(installation)",world:"$(world)",bot:"$(bot)",owner:[I;$(a),$(b),$(c),$(d)],version:"$(version)"} run function chunkbot_control:open_apply {session:"$(session)"}
