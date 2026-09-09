#!/usr/bin/env bash
#
# Cut a Kit Builder release (spec §23 Stage 7).
#
#   1. full build (DSP included)  -> dist/kit-builder/  + dist/kit-builder-module.tar.gz
#                                    + dist/kit-builder-<version>.tar.gz
#   2. full validation            -> scripts/validate_release.sh
#   3. refresh release.json's download_url from the module version + repo
#   4. print the tag + upload steps
#
# The GitHub owner/repo is read from the `origin` remote when present, else
# from $RELEASE_REPO (default sd88me/schwung-kit-builder).
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(python3 -c 'import json; print(json.load(open("src/module.json"))["version"])')"
ID="$(python3 -c 'import json; print(json.load(open("src/module.json"))["id"])')"
ASSET="${ID}-module.tar.gz"

REPO="${RELEASE_REPO:-}"
if [ -z "$REPO" ] && git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
  REPO="$(git -C "$ROOT" remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
fi
REPO="${REPO:-sd88me/schwung-kit-builder}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${ASSET}"

echo "=== Kit Builder release v$VERSION  ($REPO) ==="
echo

echo "==> build"
bash scripts/build_kit_builder.sh
echo
echo "==> validate"
bash scripts/validate_release.sh
echo

echo "==> release.json"
python3 - "$VERSION" "$DOWNLOAD_URL" <<'PY'
import json, sys
p = "release.json"
try:
    d = json.load(open(p))
except Exception:
    d = {}
d["version"] = sys.argv[1]
d["download_url"] = sys.argv[2]
with open(p, "w") as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("    " + json.dumps({"version": d["version"], "download_url": d["download_url"]}))
PY
echo

cat <<EOF
Next:
  1. Commit (src/module.json version, CHANGELOG.md, release.json).
  2. git tag v$VERSION && git push origin main --tags
  3. Attach dist/${ID}-${VERSION}.tar.gz to the GitHub release as "${ASSET}"
     (the release-workflow.yml does this automatically on a v* tag).
  4. First install / update on a Move:
       Schwung Manager (:7700) -> Module Store -> add ${REPO}
     or manually:  scripts/install.sh
EOF
