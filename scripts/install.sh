#!/usr/bin/env bash
#
# Install the built Kit Builder module onto a Move over SSH.
#
#   scripts/build_kit_builder.sh && scripts/install.sh
#
# Host: $MOVE_HOST (default move.local). If you use an ssh config alias, e.g.
#   Host move
#     HostName 192.168.x.x
#     User root
# then run:  MOVE_HOST=move scripts/install.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ID="$(python3 -c 'import json; print(json.load(open("'"$ROOT"'/src/module.json"))["id"])')"
SRC="$ROOT/dist/$ID"
DEST="/data/UserData/schwung/modules/overtake/$ID"
MOVE_HOST="${MOVE_HOST:-move.local}"
SSH_USER="${MOVE_SSH_USER:-}"        # empty -> rely on ssh config; else user@host
TARGET="${SSH_USER:+$SSH_USER@}$MOVE_HOST"

[ -d "$SRC" ] || { echo "Missing $SRC — run scripts/build_kit_builder.sh first." >&2; exit 1; }

echo "=== Installing $ID to $TARGET:$DEST ==="
ssh "$TARGET" "rm -rf '$DEST' && mkdir -p '$DEST'"
scp -q -r "$SRC/"* "$TARGET:$DEST/"
ssh "$TARGET" "chmod -R a+rX '$DEST' && [ -f '$DEST/dsp.so' ] && chmod +x '$DEST/dsp.so' || true"

echo
echo "Installed. Native (dsp.so) changes need a full exit + reopen of the module"
echo "(Shift+Back, then reopen from the Schwung overtake menu) or a Move reboot."
