# Minimal cross-compile image for the Kit Builder audition-player DSP.
# aarch64 target (Ableton Move). Mirrors the Schwung build toolchain.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc-aarch64-linux-gnu \
    binutils-aarch64-linux-gnu \
    libc6-dev-arm64-cross \
    make \
    && rm -rf /var/lib/apt/lists/*

ENV CROSS_PREFIX=aarch64-linux-gnu-
WORKDIR /build
CMD ["make", "-C", "src/dsp", "clean", "all"]
