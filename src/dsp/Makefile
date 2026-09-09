# Kit Builder — internal audition player DSP (spec §14)
#
# Produces dsp.so: a v2 sound-generator plugin (exports move_plugin_init_v2)
# for the Ableton Move (aarch64). Cross-compile via the Schwung toolchain:
#
#   CROSS_PREFIX=aarch64-linux-gnu- make          # or run scripts/build_dsp.sh (Docker)
#
CROSS_PREFIX ?=
CC      := $(CROSS_PREFIX)gcc
CFLAGS  := -std=gnu11 -O2 -fPIC -Wall -Wextra -ffast-math -Iinclude
LDFLAGS := -shared -lm -lpthread

SRC := kit_player.c
OUT := dsp.so

.PHONY: all clean
all: $(OUT)

$(OUT): $(SRC) kit_player.h include/host/plugin_api_v1.h
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LDFLAGS)
	@command -v $(CROSS_PREFIX)nm >/dev/null 2>&1 && \
	  $(CROSS_PREFIX)nm -D $(OUT) | grep -q move_plugin_init_v2 && \
	  echo "  ok: exports move_plugin_init_v2" || true

clean:
	rm -f $(OUT) *.o
