# Kit Builder

A standalone [Schwung](https://github.com/charlesvestal/schwung) **Overtake module**
for Ableton Move: build 16-pad drum kits by randomly drawing samples from the Move
library by role, audition them on the pads, lock the ones that work, re-roll the
rest, even out their levels, then save.

Save writes a working kit file **and** exports a **native Move drum preset**
(`.ablpreset`) into Move's Track Presets — the same format Move writes for its own
presets, so it loads in Move directly and, being the identical file, in
[MrDrums](https://github.com/handcraftedcc/schwung-mrdrums) as well. An optional
Akai MPC `.xpm` exporter is available alongside it.

## Features

- **Role-aware random fill.** Each pad draws from a union of sample categories
  (kick, snare, hats, percussion, FX, plus melodic categories); 22 categories
  classified from folder names, with a filename-keyword fallback.
- **Re-roll one pad** — hold a pad and fire **Assign** to redraw just that pad.
- **Locks** — locked pads survive Assign and Clear.
- **Internal audition player** — press a pad to hear its sample, velocity-scaled,
  no JS round-trip.
- **Automatic loudness matching** — *Match Levels* evens out pad loudness
  (attenuate-only by default, so it can't add clipping).
- **Audition step sequencer** — a 16-step internal clock at the Move's tempo for
  hearing the kit as a pattern. Transient: not saved, not exported.
- **Source select** — draw from the User Library, the Core Library, or both.
- **Per-pad gain trim** on the KIT page (travels with the kit as `Volume` dB).
- **Reject / favourite memory** — library-wide, persisted; a rejected sample is
  never drawn, a favourite is weighted up.
- **Scan filters** — skip loop-named files and cap sample size at scan time.
- **Exporters** — native Move drum preset (`.ablpreset`, on by default) and Akai
  MPC `.xpm` with gathered samples (opt-in), toggled on the EXPORT page.
- **Send to Force** (opt-in, bespoke — see below) — push the MPC export over
  SSH straight to an Akai Force running MockbaMod.
- **Session restore** — the working kit is saved on every change and restored on
  next launch; *New* is the way to a blank slate.

Nothing modifies or deletes source sample files.

## Requirements

- Schwung on the Move (`min_host_version` 0.12.0).
- Drum samples in `/data/UserData/UserLibrary/Samples/` (and/or
  `/data/CoreLibrary/Samples/`), sorted into folders whose names name the
  category (`Kick`, `Snare`, `Clap`, `Open Hat`, `Closed Hat`, `Percussion`,
  `FX`, …). Folder matching is case- and separator-insensitive and the deepest
  matching folder wins; anything unrecognised lands in "Other".

## Using it

Four pages, moved between by **turning the jog wheel**: `RANDOM`, `KIT`,
`SYSTEM`, `EXPORT`. **Jog press** fires the current page's action — or, on
RANDOM, SYSTEM and EXPORT, opens a **door**: a full-screen list that the jog
wheel scrolls instead of paging, closed by a second jog press (there's no Back
inside an overtake module to fall back on). Every page carries the shared
Schwung header (kit name / page name) and a footer of key→action hint pills;
transient status ("Assigned 14 pads", "Saved: …") shows as an auto-dismissing
overlay toast.

### Pads (left 4×4 block, Move drum-rack layout — kick bottom-left)

| LED | meaning |
|---|---|
| green | sample loaded |
| white | loaded **and** locked |
| bright | currently sounding |
| amber | sample file could not be loaded |
| teal | empty |
| dim white | empty and locked |
| red flash | that pad's pool had no eligible sample |

Press an assigned pad to hear it (velocity-sensitive). **Shift + Pad** locks /
unlocks — locked pads survive Assign and Clear. **Back** parks the module (state
kept, silent); **Shift + Back** exits.

### RANDOM page

The six actions — **Assign**, **New**, **Save**, **Clear**, **Unlock All**,
**Match Levels** — live behind a door. **Up/Down** move the selection; **jog
press** opens the door full-screen, the jog wheel then scrolls it, and a
second **jog press** fires the highlighted action and closes the door again.
**Step buttons 1–6** (colour-coded) fire the same actions directly without
opening the door — a single press selects, a **double click** within ~0.4 s
fires:

- **Assign** — fill every unlocked pad with a random sample of its pool
  (ascending pad order, no duplicates, avoids each pad's current sample; seeded
  and the seed is stored in the kit). Hold a pad while firing to re-roll only
  that pad.
- **New** — start a blank kit (press again within ~9 s to confirm). Also clears
  the sequencer.
- **Save** — name it on the keyboard (default `Kit Builder NNN YYYY-MM-DD`),
  write `KitBuilder/Kits/<name>.kitbuilder.json`, and run every enabled
  exporter. Re-saving the same session overwrites one file; changing the name is
  a "save as".
- **Clear** — empty every unlocked pad.
- **Unlock All** — drop every lock.
- **Match Levels** — measure each assigned pad and trim gains so they sit at a
  common loudness. A manual gain trim (KIT page, Knob 1) afterwards still
  overrides.

**Knob 3** toggles **Duplicates** (Avoid / Allow). **Knob 4** cycles **Source**
(User / Core / Both) — resets to User on a fresh `New` or launch.

### KIT page

- **Pressing a pad** selects it (pool / sample shown) — there's no separate
  Pad knob, since a pad press already does that.
- **Knob 1** trims the selected pad's gain: the cell just shows "Gain", and
  the value peeks in a short overlay while the knob turns.
- **Up** favourites / **Down** rejects the pad's sample for future draws
  (mutually exclusive, toggles off on repeat); **Shift+Up** / **Shift+Down**
  clear the whole favourite / reject list.
- **Jog press** clears the pad unless locked.

### SYSTEM page

- **Knob 1** toggles the loop-name filter; **Knob 2** cycles the
  max-sample-size cap (Off / 1M / 2M / 5M / 10M) — both persist in
  `KitBuilder/config.json` and take effect on the next Rescan.
- **Knob 3** fires **Rescan**: walks the selected library roots, classifies
  each sample by folder name (deepest match; filename-keyword fallback), and
  caches the index to `KitBuilder/.sample-index.json`. Runs in bounded chunks
  so the display never stalls.
- The index report — indexed count and age, skipped ("Cut") count, and counts
  for all eight categories plus "Other" — lives behind a door: **jog press**
  opens it full-screen, the jog wheel scrolls it, and a second **jog press**
  closes it.

### EXPORT page

Also a door — the whole page, since nothing else uses these knobs. **Up/Down**
move the selection; **jog press** opens it full-screen, the jog wheel then
scrolls it too, and a **jog press** toggles the highlighted row:

- **Move preset `.ablpreset`** (on by default) — the native Move drum-rack
  preset, written to `Track Presets/`; also loads in MrDrums.
- **MPC `.xpm`** (off by default) — an Akai MPC program with each assigned
  sample gathered beside it (`MANIFEST.txt` lists anything that couldn't be
  copied).
- **Send to Force** (off by default) — pushes that same MPC export over SSH to
  an Akai Force on your LAN. **Bespoke, advanced, opt-in only** — see
  [Send to Force](#send-to-force-optional--akai-force--mockbamod-only) below
  before turning it on; the first toggle prompts for the Force's IP.
- **Export now** — run the enabled formats for the current kit without a Save;
  running it closes the door, but toggling a format above leaves it open so
  you can flip several in a row.

The toggles persist in `config.json → exports`. A Save runs the same set.

### Sequencer

**Rec** toggles the pattern-edit view (LED stays lit); the 16 step buttons arm /
disarm steps for the pad on **Knob 1**, and a full-screen SEQ readout replaces
the page. **Play** runs / stops the clock, independent of the view. Tempo
follows the Move's global BPM. Parking (**Back**) or resuming brings it back
stopped at step 1 with the pattern intact; **New** clears it.

## Send to Force (optional — Akai Force + MockbaMod only)

The EXPORT page's **Send to Force** row pushes a kit's MPC export straight to
an [Akai Force](https://www.akaipro.com/force) over your LAN via SSH, landing
it in a Kits folder the Force can load from. **This is a bespoke feature for
one specific setup, not a general Force integration** — it only works if:

- your Force is running [MockbaMod](http://mockbatheb.org/). Stock Force
  firmware has no SSH server at all; MockbaMod's boot enables `sshd`
  automatically, with default credentials `root` / `force`.
- the Force is on the same network as the Move, reachable by IP.
- you've completed the one-time key handoff below.

None of that can be detected automatically. Turning the row on against a
stock (non-MockbaMod) Force, or one that's unreachable or unpaired, just
fails that one row cleanly — the rest of the export (and the MPC `.xpm` file
itself) still succeeds.

Auth is always by an SSH key Kit Builder generates for itself, never a
password — there's no interactive prompt anywhere on Move to type one into,
and a key means nothing has to change if MockbaMod's own default password
ever does.

### One-time setup

1. Boot the Force off its MockbaMod SD card and find its IP (WiFi screen →
   hold **Shift** → tap **info**).
2. On Kit Builder's EXPORT page, toggle **Send to Force** on for the first
   time. It prompts for the Force's IP on the on-screen keyboard and saves it
   to `KitBuilder/config.json` (`force.host`). There's no on-device flow to
   change it afterwards — edit that file by hand if the Force's IP changes.
3. Run any export with Send to Force enabled. This generates Kit Builder's
   own keypair on first use (`KitBuilder/force_key` / `force_key.pub`) — this
   first attempt is *expected* to fail with an auth error, since the Force
   doesn't have the public half yet.
4. Hand that public key to the Force. The Move itself has no way to reach a
   *third* machine on your network, so do this from a computer that can SSH
   to both:

   ```bash
   ssh ableton@move.local cat \
     /data/UserData/UserLibrary/KitBuilder/force_key.pub > force_key.pub
   scp force_key.pub root@<force-ip>:/tmp/
   ssh root@<force-ip> \
     'mkdir -p ~/.ssh && cat /tmp/force_key.pub >> ~/.ssh/authorized_keys && rm /tmp/force_key.pub'
   ```

   (password `force` when prompted for the Force login — MockbaMod's default;
   change it on the Force itself if you'd rather not rely on it.)
5. Re-run the export. Kits land in `force.kits_path` from `config.json`,
   default `/media/662522/Kits` — the typical mount point for a MockbaMod SD
   card's FAT volume. If kits don't show up where expected, confirm yours
   with `mount | grep 662522` over SSH on the Force and edit `config.json` if
   it differs.

---

## Install

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

## Not included

- **No in-tool browsing / reloading of saved kits.** Save writes a working file
  and `current-kit.json` restores the last session, but there is no UI to load
  an arbitrary older kit back in.
- **Reference-in-place export.** The `.ablpreset` references samples by
  `ableton:/user-library/` URI; `.ablpresetbundle` (with copied sample audio) is
  not generated. The MPC `.xpm` does gather its samples.
- **No per-pad editing beyond gain.** Pan, tune, sample start/end, filter and
  envelope are out of scope; no choke groups.
- **One voice per pad.** A fast repeat on the same pad retriggers rather than
  layering.
- No waveform display; classification is folder/filename only, not audio
  analysis.

## Development

```
src/
  module.json ui.js help.json kit_config.json
  core/       kit_model · random_assign · sample_index · sample_classifier ·
              scan_filters · loudness · path_mapping · storage · validation
              (ES modules, pure = unit-tested)
  exporters/  mrdrums_json.mjs · mpc_xpm.mjs · xpm_template.mjs · wav_strip.mjs
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
  loudness / scan-filter / export suites (needs Node; the device has none).
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
