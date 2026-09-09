# Kit Builder

A standalone [Schwung](https://github.com/charlesvestal/schwung) **Overtake module**
for Ableton Move: build 16-pad drum kits by randomly drawing samples from the Move
User Library by role, audition them on the pads, lock the ones that work, re-roll
the rest, then save — and export a **MrDrums-loadable `.ablpreset`** into Move's
Track Presets.

- MVP specification: [`docs/KIT_BUILDER_SPEC.md`](docs/KIT_BUILDER_SPEC.md)
- Implementation decisions + MrDrums comparison: [`docs/DESIGN_NOTES.md`](docs/DESIGN_NOTES.md)
- Changes: [`CHANGELOG.md`](CHANGELOG.md)

**v0.1.0 — feature-complete MVP.** All seven implementation stages of §23 are
done; on-device hardware testing across stages 1–6 passed, packaging is stage 7.

---

## Install

**Requires** Schwung on the Move (`min_host_version` 0.12.0) and drum samples in
`/data/UserData/UserLibrary/Samples/`, sorted into folders whose names name the
role (`Kick`, `Snare`, `Clap`, `Open Hat`, `Closed Hat`, `Percussion`, `FX`,
anything else lands in "Other").

### Schwung Manager (recommended)

Add `sd88me/schwung-kit-builder` in Schwung Manager (`http://move.local:7700` →
Module Store). It reads `release.json` and installs / updates from the GitHub
release.

### Manual

```bash
scripts/build_kit_builder.sh          # builds dsp.so (needs Docker or aarch64-gcc)
MOVE_HOST=move.local scripts/install.sh
```

or straight from a release tarball:

```bash
scp kit-builder-module.tar.gz move:/data/UserData/
ssh move 'tar -xzf /data/UserData/kit-builder-module.tar.gz \
  -C /data/UserData/schwung/modules/overtake/'
```

Open it from **Schwung → Overtake → Kit Builder**. After a native (`dsp.so`)
update, fully exit (**Shift + Back**) and reopen, or reboot the Move.

---

## Using it

Three pages, moved between by **turning the jog wheel**: `RANDOM`, `KIT`, `SYSTEM`.
**Jog press** fires the current page's action.

### Pads (left 4×4 block, Move drum-rack layout — kick bottom-left)

| LED | meaning |
|---|---|
| green | sample loaded |
| white | loaded **and** locked |
| bright | currently sounding |
| amber | sample file could not be loaded |
| teal | empty |
| dim white | empty and locked |
| red flash | that role had no eligible sample |

Press an assigned pad to hear it (velocity-sensitive). **Shift + Pad** locks /
unlocks — locked pads survive Assign and Clear. **Back** parks the module (state
kept, silent); **Shift + Back** exits.

### RANDOM page

**Up/Down** (or **step buttons 1–5**, colour-coded) select an action;
**jog press** — or a second step-button press within ~0.4 s — fires it:

- **Assign** — fill every unlocked pad with a random sample of its role
  (ascending pad order, no duplicates, avoids each pad's current sample; seeded
  and the seed is stored in the kit).
- **New** — start a blank kit (press again within ~9 s to confirm).
- **Save** — name it on the keyboard (default `Kit Builder NNN YYYY-MM-DD`),
  write `KitBuilder/Kits/<name>.kitbuilder.json`, and export
  `Track Presets/<name>.ablpreset` for MrDrums. Re-saving the same session
  overwrites one file; changing the name is a "save as".
- **Clear** — empty every unlocked pad.
- **Unlock All** — drop every lock.

**Knob 3** toggles **Duplicates** (Avoid / Allow).

### KIT page

**Knob 1** selects a pad (role / sample / lock shown); **jog press** clears it
unless locked.

### SYSTEM page

**Jog press** = **Rescan**: walks the User Library, classifies each sample by
folder name (case- and separator-insensitive; the deepest matching folder wins),
and caches the index to `KitBuilder/.sample-index.json`. Runs in bounded chunks
so the display never stalls. Shows per-category counts and how long ago the index
was built. Config is the §7.1 default, overridable by `KitBuilder/config.json`.

The working kit is written to `KitBuilder/current-kit.json` on every change and
**restored on next launch** — `New` is the way to a blank slate.

---

## Known limitations (MVP)

- **No in-tool browsing / reloading of saved kits.** Save writes a working file
  and `current-kit.json` restores the last session, but there is no UI to load
  an arbitrary older kit back in (spec §2.2, §3.1).
- **MrDrums export only.** Direct Ableton `.ablpreset` for Move's own instrument
  rack, `.ablpresetbundle` (with copied sample audio), and Akai MPC `.xpm` are
  not generated. The exported file references samples in place by
  `ableton:/user-library/` URI.
- **User Library only.** The Core Library is not scanned; the `Source` control
  has one option.
- **No per-pad editing.** Pan, tune, sample start/end, filter and envelope are
  out of scope; playback is `gain` only (fixed at 0 dB), no choke groups.
- **One voice per pad.** A fast repeat on the same pad retriggers rather than
  layering.
- No waveform display, no automatic loudness matching, no audio-analysis
  classification.

Nothing modifies or deletes source sample files.

---

## Development

```
src/
  module.json ui.js help.json kit_config.json
  core/       kit_model · random_assign · sample_index · sample_classifier ·
              path_mapping · storage · validation      (ES modules, pure = unit-tested)
  exporters/  mrdrums_json.mjs
  dsp/        kit_player.c/.h · Makefile · include/host/plugin_api_v1.h
scripts/      build_kit_builder.sh · build_dsp.sh · install.sh ·
              validate_release.sh · package_release.sh · Dockerfile.dsp
tests/        run.js + test_*.js   (dependency-free; `npm test`)
```

- `scripts/build_kit_builder.sh` — assemble `dist/kit-builder/` + tarballs. The
  DSP cross-compiles via a local `aarch64-linux-gnu-gcc`, an existing
  `schwung-builder` Docker image, or `scripts/Dockerfile.dsp`. `SKIP_DSP=1`
  packages the UI only.
- `npm test` runs the classifier / path-mapping / assignment / storage /
  MrDrums-export suites (needs Node; the device has none).
- `scripts/package_release.sh` builds, validates, refreshes `release.json`, and
  prints the tag + upload steps. `.github/workflows/release.yml` does this on a
  `v*` tag.

### Logs

```bash
ssh move 'touch /data/UserData/schwung/debug_log_on'
ssh move 'tail -f /data/UserData/schwung/debug.log'   # lines prefixed "kit-builder:"
```

## License

MIT — see [`LICENSE`](LICENSE).
