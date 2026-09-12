#!/usr/bin/env bash
#
# Build the Kit Builder Schwung module into dist/.
#
# Assembles the flat module payload (module.json, ui.js, help.json,
# kit_config.json, core/*.mjs, exporters/*.mjs, dsp.so,
# vendor/dropbear-aarch64/*) under dist/<id>/ and tars it to
# dist/<id>-module.tar.gz. SKIP_DSP=1 skips the native build.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src"
DIST="$ROOT/dist"
MODULE_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$SRC/module.json")"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC/module.json")"
OUT="$DIST/$MODULE_ID"

echo "==> Validating module.json"
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$SRC/module.json"
BYTES=$(wc -c < "$SRC/module.json")
if [ "$BYTES" -gt 8192 ]; then echo "module.json > 8 KB ($BYTES)"; exit 1; fi

echo "==> Validating JSON assets"
for f in "$SRC/help.json" "$SRC/kit_config.json"; do
  [ -f "$f" ] && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f"
done

echo "==> Assembling $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$SRC/module.json" "$SRC/ui.js" "$OUT/"
[ -f "$SRC/help.json" ]       && cp "$SRC/help.json" "$OUT/"
[ -f "$SRC/kit_config.json" ] && cp "$SRC/kit_config.json" "$OUT/"

# Core ES modules imported by ui.js (Stage 2+). Validate each parses.
if [ -d "$SRC/core" ]; then
  mkdir -p "$OUT/core"
  for f in "$SRC"/core/*.mjs; do
    [ -e "$f" ] || continue
    node --check "$f" 2>/dev/null || echo "   (note: could not node --check $(basename "$f"))"
    cp "$f" "$OUT/core/"
  done
fi
if [ -d "$SRC/exporters" ]; then
  for f in "$SRC"/exporters/*.mjs; do
    [ -e "$f" ] || continue
    mkdir -p "$OUT/exporters"
    cp "$f" "$OUT/exporters/"
  done
fi

# Vendored dropbear client ("Send to Force") — committed binaries, not built
# here; see scripts/build_dropbear.sh + docs/refs/README.md.
if [ -d "$SRC/vendor/dropbear-aarch64" ]; then
  mkdir -p "$OUT/vendor/dropbear-aarch64"
  cp "$SRC"/vendor/dropbear-aarch64/dbclient "$SRC"/vendor/dropbear-aarch64/scp "$SRC"/vendor/dropbear-aarch64/dropbearkey "$OUT/vendor/dropbear-aarch64/"
  chmod +x "$OUT"/vendor/dropbear-aarch64/*
  [ -f "$SRC/vendor/dropbear-aarch64/LICENSE" ] && cp "$SRC/vendor/dropbear-aarch64/LICENSE" "$OUT/vendor/dropbear-aarch64/"
  echo "    included vendor/dropbear-aarch64 (dbclient, scp, dropbearkey)"
fi

# Audition-player DSP (Stage 4). Build it unless SKIP_DSP=1; a stale/missing
# dsp.so would ship a UI that expects an engine that isn't there.
if [ "${SKIP_DSP:-0}" != "1" ] && [ -f "$SRC/dsp/kit_player.c" ]; then
  echo "==> Building DSP"
  bash "$ROOT/scripts/build_dsp.sh"
fi
if [ -f "$SRC/dsp/dsp.so" ]; then
  cp "$SRC/dsp/dsp.so" "$OUT/"
  chmod +x "$OUT/dsp.so"
  echo "    included dsp.so"
elif grep -q '"dsp"' "$SRC/module.json"; then
  echo "WARNING: module.json declares a dsp but src/dsp/dsp.so is missing" >&2
fi

echo "==> Packing tarball"
# Deterministic tarball: sorted entries, fixed mtime/owner so the same source
# always produces the same archive.
TARBALL="$DIST/${MODULE_ID}-module.tar.gz"
( cd "$DIST" && tar --sort=name --mtime='2026-01-01 00:00:00Z' \
    --owner=0 --group=0 --numeric-owner -czf "${MODULE_ID}-module.tar.gz" "$MODULE_ID" )
# Versioned copy for a release attachment.
cp "$TARBALL" "$DIST/${MODULE_ID}-${VERSION}.tar.gz"

echo "==> Done  (v$VERSION)"
echo "    folder : $OUT"
echo "    tarball: $TARBALL"
echo "    release: $DIST/${MODULE_ID}-${VERSION}.tar.gz"
echo "    deploy : scp $TARBALL move:/data/UserData/ && \\"
echo "             ssh move 'tar -xzf /data/UserData/${MODULE_ID}-module.tar.gz -C /data/UserData/schwung/modules/overtake/'"
