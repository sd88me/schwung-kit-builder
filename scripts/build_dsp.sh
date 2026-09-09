#!/usr/bin/env bash
#
# Build src/dsp/dsp.so (aarch64) for the Kit Builder audition player.
#
# Order of preference:
#   1. local aarch64 cross-gcc (or $CROSS_PREFIX)
#   2. an existing Schwung-style cross-compile image (schwung-builder, *-builder)
#   3. scripts/Dockerfile.dsp (needs network the first time)
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

build_local() {
  echo "==> Building DSP with local cross-gcc"
  CROSS_PREFIX="${CROSS_PREFIX:-aarch64-linux-gnu-}" make -C src/dsp clean all
}

build_in_image() {
  local img="$1"
  echo "==> Building DSP in Docker image: $img"
  docker run --rm -v "$ROOT:/build" -w /build \
    -e CROSS_PREFIX=aarch64-linux-gnu- "$img" \
    make -C src/dsp clean all
}

if [ -n "${CROSS_PREFIX:-}" ] || command -v aarch64-linux-gnu-gcc >/dev/null 2>&1; then
  build_local
elif command -v docker >/dev/null 2>&1; then
  img=""
  for cand in schwung-builder kit-builder-dsp; do
    if docker image inspect "$cand" >/dev/null 2>&1; then img="$cand"; break; fi
  done
  if [ -z "$img" ]; then
    img="$(docker images --format '{{.Repository}}' | grep -E -- '-builder$|-build$' | head -n1 || true)"
  fi
  if [ -n "$img" ]; then
    build_in_image "$img"
  else
    echo "==> Building dedicated DSP image (scripts/Dockerfile.dsp)"
    docker build -t kit-builder-dsp -f scripts/Dockerfile.dsp .
    build_in_image kit-builder-dsp
  fi
else
  echo "No aarch64 cross-compiler and no Docker — cannot build the DSP." >&2
  exit 1
fi

[ -f src/dsp/dsp.so ] || { echo "Build produced no src/dsp/dsp.so" >&2; exit 1; }
echo "==> src/dsp/dsp.so"
ls -l src/dsp/dsp.so
