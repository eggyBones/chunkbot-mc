# UUID is read from the server entity, never a scoreboard name or chat rendering.
$execute if entity @a[nbt={UUID:[I;$(a),$(b),$(c),$(d)]}] run scoreboard players set #present cb_ctl 1
execute if score #present cb_ctl matches 1 if score #was_present cb_ctl matches 0 run scoreboard players add #owner_session cb_ctl 1
$scoreboard players reset @a[nbt=!{UUID:[I;$(a),$(b),$(c),$(d)]}] chunkbot_on
$scoreboard players reset @a[nbt=!{UUID:[I;$(a),$(b),$(c),$(d)]}] chunkbot_off
$scoreboard players reset @a[nbt=!{UUID:[I;$(a),$(b),$(c),$(d)]}] chunkbot_status
$execute as @a[nbt={UUID:[I;$(a),$(b),$(c),$(d)]}] run function chunkbot_control:tick_owner
