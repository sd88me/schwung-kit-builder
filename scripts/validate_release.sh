#!/usr/bin/env bash
#
# Validate the built Kit Builder payload before a deploy or a release.
# Checks the acceptance-test §21.1 install prerequisites: valid manifest,
# correct component_type, a loadable DSP, resolvable imports, valid JSON
# assets, and version agreement across module.json / release.json / CHANGELOG.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$ROOT/src/module.json")"
OUT="$ROOT/dist/$MODULE_ID"
fail=0
say()  { echo "  $*"; }
bad()  { echo "  FAIL: $*"; fail=1; }

[ -d "$OUT" ] || { echo "Build first: scripts/build_kit_builder.sh"; exit 1; }

# ---- manifest ------------------------------------------------------------
[ -f "$OUT/module.json" ] || bad "no module.json"
[ -f "$OUT/ui.js" ]       || bad "no ui.js"

MJ_VERSION="$(python3 - "$OUT/module.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
assert m["component_type"] == "overtake", "component_type=" + str(m.get("component_type"))
for k in ("id", "name", "version"):
    assert m.get(k), k + " required"
if "dsp" in m:
    assert m.get("api_version") == 2, "dsp modules must declare api_version 2"
    assert m.get("capabilities", {}).get("audio_out"), "dsp modules should declare capabilities.audio_out"
print(m["version"])
PY
)" || bad "module.json invalid"
say "module.json OK: $MODULE_ID v$MJ_VERSION overtake"
[ "$(wc -c < "$OUT/module.json")" -le 8192 ] || bad "module.json > 8 KB"

# ---- JSON assets ------------------------------------------------------------
for f in help.json kit_config.json; do
  [ -f "$OUT/$f" ] || continue
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT/$f" || bad "$f is not valid JSON"
done

# ---- ui.js entry points --------------------------------------------------
for sym in "globalThis.init" "globalThis.tick" "onMidiMessageInternal" "onMidiMessageExternal"; do
  grep -q "$sym" "$OUT/ui.js" || bad "ui.js missing entry point: $sym"
done

# ---- every relative import resolves inside the payload -----------------
rm -f /tmp/kb_vr_fail
while IFS= read -r src; do
  base="$(dirname "$src")"
  for rel in $(grep -oE "from '(\.\.?/)[^']+'" "$src" 2>/dev/null | sed "s/from '//;s/'$//" || true); do
    resolved="$(cd "$base" 2>/dev/null && cd "$(dirname "$rel")" 2>/dev/null && echo "$(pwd)/$(basename "$rel")" || true)"
    case "$resolved" in
      "$OUT"/*) [ -f "$resolved" ] || { echo "  FAIL: missing import $rel (in ${src#"$OUT"/})"; touch /tmp/kb_vr_fail; } ;;
      *)        echo "  FAIL: import escapes payload: $rel (in ${src#"$OUT"/})"; touch /tmp/kb_vr_fail ;;
    esac
  done
done < <(find "$OUT" \( -name '*.js' -o -name '*.mjs' \))
[ -f /tmp/kb_vr_fail ] && { fail=1; rm -f /tmp/kb_vr_fail; }

# ---- DSP -----------------------------------------------------------------
if grep -q '"dsp"' "$OUT/module.json"; then
  DSO="$OUT/dsp.so"
  if [ ! -f "$DSO" ]; then
    bad "module.json declares a dsp but dsp.so is missing"
  else
    [ -x "$DSO" ] || bad "dsp.so is not executable"
    if command -v aarch64-linux-gnu-nm >/dev/null 2>&1; then
      aarch64-linux-gnu-nm -D "$DSO" | grep -q move_plugin_init_v2 || bad "dsp.so does not export move_plugin_init_v2"
    elif command -v strings >/dev/null 2>&1; then
      strings "$DSO" | grep -q move_plugin_init_v2 || bad "dsp.so has no move_plugin_init_v2 symbol string"
    fi
    head -c4 "$DSO" | grep -q $'\x7fELF' && say "dsp.so: ELF, exports move_plugin_init_v2"
  fi
fi

# ---- version agreement ------------------------------------------------
if [ -f "$ROOT/release.json" ]; then
  RJ_VERSION="$(python3 -c 'import json; print(json.load(open("release.json")).get("version",""))' 2>/dev/null || true)"
  [ "$RJ_VERSION" = "$MJ_VERSION" ] || bad "release.json version ($RJ_VERSION) != module.json ($MJ_VERSION)"
fi
if [ -f "$ROOT/CHANGELOG.md" ]; then
  grep -q "\[$MJ_VERSION\]" "$ROOT/CHANGELOG.md" || bad "CHANGELOG.md has no [$MJ_VERSION] section"
fi

if [ "$fail" -eq 0 ]; then echo "validate_release: PASS"; else echo "validate_release: FAIL"; exit 1; fi
