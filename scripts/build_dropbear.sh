#!/usr/bin/env bash
#
# Rebuild the vendored dropbear client binaries (src/vendor/dropbear-aarch64/):
# dbclient, scp, dropbearkey — used by the EXPORT page's "Send to Force"
# feature to push a kit over SSH to an Akai Force running MockbaMod.
#
# NOT run automatically by build_kit_builder.sh or CI. These binaries are a
# stable third-party dependency (unlike dsp.so, they don't change with kit-
# builder's own code), so they're committed to the repo and only rebuilt by
# hand when bumping the DROPBEAR_VERSION below. No Docker needed — the musl
# cross toolchain below is a self-contained tarball that runs directly on
# an x86_64 Linux host (unlike the DSP build, which needs Docker for the
# Debian-packaged glibc cross-toolchain).
#
# musl, not glibc: a glibc `-static` dbclient segfaults on Move on startup —
# glibc's NSS functions (getaddrinfo, getpwnam, ...) dlopen() shared libs at
# runtime even in a "static" binary, and that dlopen is broken/absent on
# Move's stripped runtime. musl resolves NSS at link time, so a musl-static
# binary has no such runtime dependency. Confirmed by building both ways and
# running each on the device: glibc exits 139 (SIGSEGV) on `dbclient` alone;
# musl runs cleanly and dropbearkey generates a real key on the hardware.
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/src/vendor/dropbear-aarch64"

DROPBEAR_VERSION="2026.94"
MUSL_CROSS_URL="https://musl.cc/aarch64-linux-musl-cross.tgz"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Fetching dropbear v$DROPBEAR_VERSION source"
curl -sL -o "$WORK/dropbear.tar.gz" \
  "https://github.com/mkj/dropbear/archive/refs/tags/DROPBEAR_${DROPBEAR_VERSION}.tar.gz"
tar xzf "$WORK/dropbear.tar.gz" -C "$WORK"
SRC="$WORK/dropbear-DROPBEAR_${DROPBEAR_VERSION}"

echo "==> Fetching aarch64-linux-musl cross toolchain (~100MB, cached in $WORK)"
curl -sL -o "$WORK/musl-cross.tgz" "$MUSL_CROSS_URL"
tar xzf "$WORK/musl-cross.tgz" -C "$WORK"
TOOLCHAIN="$WORK/aarch64-linux-musl-cross/bin"

echo "==> Configuring (static, client-only feature set)"
(
  cd "$SRC"
  export PATH="$TOOLCHAIN:$PATH"
  export CC=aarch64-linux-musl-gcc
  export AR=aarch64-linux-musl-ar
  export RANLIB=aarch64-linux-musl-ranlib
  ./configure --host=aarch64-linux-musl --enable-static \
    --disable-zlib --disable-utmp --disable-wtmp --disable-lastlog \
    --disable-syslog --disable-loginfunc --disable-pututline --disable-pututxline

  echo "==> Building dbclient, scp, dropbearkey"
  make dbclient scp dropbearkey
)

mkdir -p "$OUT"
cp "$SRC/dbclient" "$SRC/scp" "$SRC/dropbearkey" "$OUT/"
chmod +x "$OUT"/*

echo "==> Done"
sha256sum "$OUT"/*
echo "    Update docs/refs/dropbear.md's checksums + DROPBEAR_VERSION note if this changed."
