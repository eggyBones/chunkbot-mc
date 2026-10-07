#!/bin/zsh
# Start Chunkbot (the registered accepted release) if it is not running, then open its dashboard.
# MB-OPS-002-L1: thin wrapper; all logic is in scripts/play-controls.py.
emulate -L zsh
setopt no_unset
here=${0:A:h}
exec python3 "$here/scripts/play-controls.py" play "$@"
