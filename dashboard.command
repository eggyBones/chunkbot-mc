#!/bin/zsh
# Open the read-only Chunkbot dashboard (starts the viewer if needed; never joins Minecraft).
# MB-OPS-002-L1: thin wrapper; all logic is in scripts/play-controls.py.
emulate -L zsh
setopt no_unset
here=${0:A:h}
exec python3 "$here/scripts/play-controls.py" dashboard "$@"
