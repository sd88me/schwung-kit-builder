# Changelog

All notable changes to Kit Builder are recorded here.

## [0.1.0] — unreleased

### Stage 1 — hardware shell (spec §23)

- Scaffolded the repository structure from spec §5.
- Added `src/module.json` — `component_type: overtake`, id `kit-builder`.
- Implemented `src/ui.js`: minimal Overtake-style module that
  - opens on Move from the Schwung overtake menu,
  - maps pads 1–16 to the **left 4×4 block** in standard Move drum-rack order
    (kick bottom-left; hardware notes 68-71 / 76-79 / 84-87 / 92-95),
  - receives pad events and Shift + Pad,
  - drives RGB pad LEDs (dim blue-teal = empty, dim white = empty+locked,
    bright flash on press),
  - toggles per-pad lock state on Shift + Pad (visual feedback only),
  - renders one working **Assign** momentary button on the `RANDOM` page
    (jog-wheel press), with the spec §10.7 reentrancy guard and no logic behind it,
  - navigates `RANDOM` / `KIT` / `SYSTEM` pages by **turning the jog wheel**,
  - declares `capabilities.suspend_keeps_js`: **Back** parks the module with its
    state intact, **Shift + Back** fully exits.
  - `tick()` early-returns while `globalThis.overtakeParked` is set (framework
    contract) so state and LEDs freeze cleanly during a park.
  - LED-on-resume: the host needs several frames after unpark before queued LED
    writes reach the hardware, so `onResume()` + `tick()` force-repaint the full
    pad surface repeatedly for `RESUME_PAINT_FRAMES` (30), mirroring `mono`.
    A single repaint in `onResume()` was silently dropped.
- Added `src/help.json`, `src/kit_config.json`, `config/default_kit_config.json`
  (spec §7.1 default configuration).
- Added build/validate scripts and stub `core/`, `exporters/`, `dsp/`, `tests/`
  files naming their implementation stage.

**Stage 1 exit criterion met:** a minimal module opens correctly, receives pad
events, changes LED colours and displays a working button.

### Stage 2 — sample index + classification (spec §8)

- `src/core/path_mapping.mjs` — filesystem-path → Ableton-URI conversion (§9):
  user + core roots, `..` and unknown-root rejection, case/slash normalisation,
  `{ uri, source, error }` result. Unit-tested (`tests/test_path_mapping.js`).
- `src/core/sample_classifier.mjs` — folder-role classification (§7.2):
  case- and separator-insensitive (`open hat` = `open_hat` = `openhat`),
  any directory component, **deepest match wins**, unmatched → `other`.
  Unit-tested (`tests/test_classifier.js`).
- `src/core/sample_index.mjs` — config loader (embedded §7.1 default + optional
  `KitBuilder/config.json` override), chunked recursive User Library scanner
  (bounded work per `tick()`, no blocking, metadata only), index record per
  §8.2, atomic-ish write to `KitBuilder/.sample-index.json` (§8.3/§8.5),
  cached-index load on startup (§3.1), category-count summary for the UI.
- `ui.js`: SYSTEM page now shows live sample counts (Indexed / Kick / Snare /
  Hats / Perc / FX / Other) and index age; jog-press on the SYSTEM page is the
  **Rescan / Rebuild** button (§13.4), with the §10.7 in-flight guard. The scan
  is pumped from `tick()` in ~400-entry chunks; progress shows in the footer.
- Build script copies `src/core/*.mjs`; `validate_release.sh` checks every
  relative `ui.js` import is present in the payload. Added `package.json`
  (`type: module`) and a dependency-free test runner (`tests/run.js`).

- Display: left margin moved x=2 → x=6 and every content line is clamped with
  `text_width()` so nothing clips on either edge (the Move panel crops a few
  columns per side). SYSTEM page trimmed to the figures spec §13.4 lists —
  Indexed / Kicks / Snares / Hats / Other / Age.

**Stage 2 exit criterion met:** the module reports reliable sample counts by
category after a Rescan (verified on device — 6384 files indexed, sensible
per-category split, UI stayed responsive during the scan).

### Stage 3 — kit model + seeded assignment (spec §6, §10)

- `src/core/kit_model.mjs` — the 16-pad internal kit (§6.1–§6.4): kit object,
  pad object (`playback.gain` only, Rev. 2), empty pad = `null` sample,
  pad→note mapping, role-per-pad from config, plus `toggleLock` / `clearUnlocked`
  / `unlockAll` / `clearPad`. Never touches audio files (§19).
- `src/core/random_assign.mjs` — seeded engine (§10). `mulberry32` PRNG;
  processes unlocked pads in ascending pad order (§10.2 / decision 4); primary
  then fallback role pools; duplicate prevention with locked-pad samples counted
  as used and a reported relaxation when a pool runs dry (§10.4); current-sample
  exclusion (§10.5); transaction semantics — unresolved pads keep what they had
  and the kit stays valid (§10.3). Returns a proposed pad array + report; the
  caller commits. Unit-tested (`tests/test_assignment.js`, 8 cases).
- `ui.js`:
  - RANDOM page is now an action list — **Up/Down** select `Assign` / `Clear` /
    `Unlock All`, **jog-press** fires the selected one. **Knob 3** toggles
    Duplicates (Avoid/Allow). Shows Dup / Src / Assigned / Locked counts.
  - KIT page: **Knob 1** = Selected Pad; shows role, sample, lock; **jog-press**
    = Clear Pad (§13.3).
  - Pad LEDs now reflect real state — green (loaded), white (loaded+locked),
    teal (empty), dim white (empty+locked), red flash (a role had no candidate).
  - Pressing an assigned pad shows its sample name (no audio yet — Stage 4).
  - Every momentary action (`Assign` / `Clear` / `Unlock All` / `Rescan` /
    `Clear Pad`) drops re-presses while another is in flight (§10.7).
  - Always opens on a blank kit (§3.1, decision 6).

**Stage 3 exit criterion met:** repeated assignments produce valid internal
kits while preserving locked pads (verified on device).

### Stage 4 — internal audition player (spec §14)

- `src/dsp/kit_player.c` — a v2 sound-generator plugin (`move_plugin_init_v2`)
  the Schwung shim runs as `overtake_dsp`. 16 one-shot sample slots, one voice
  per pad (§14.4 retrigger model), velocity-scaled amplitude, overlapping
  playback across pads. Minimal WAV decoder (PCM 8/16/24/32-bit + float,
  mono/stereo, any rate → linear-resampled to 44.1 kHz, capped at 3 s/slot).
  All decoding runs on a demoted `SCHED_OTHER` worker thread pinned off core 3;
  the audio thread only ever reads a sample via an atomic pointer swap, with a
  retired-buffer + settle-delay so a reload can't pull a buffer out from under
  a playing voice (spec §14.3). `on_midi` / `render_block` / `set_param` /
  `get_param` do no file I/O, allocation, or locking.
- `src/dsp/{kit_player.h,Makefile}`, `scripts/{Dockerfile.dsp,build_dsp.sh}`;
  `build_kit_builder.sh` builds and bundles `dsp.so` (reuses a local
  `schwung-builder` image or an aarch64 cross-gcc).
- `module.json`: `"dsp": "dsp.so"`, `api_version: 2`, `capabilities.audio_out`.
- `ui.js`: pushes each pad's WAV path to the DSP (`slot_<N>`) after
  Assign / Clear / Clear Pad / resume; the shim routes pad notes straight to
  the DSP's `on_midi`, so pressing an assigned pad plays it with no JS
  round-trip. Polls `sounding` for the "currently auditioning" LED (bright)
  and `slot_status` for load errors (amber pad + "N samples could not be
  loaded"). Assigned-pad press no longer claims "no sound".

**Stage 4 exit criterion met:** all 16 pads play reliably while assignments
are repeatedly changed (verified on device).

### Stage 5 — persistence (spec §15, §21.6)

- `src/core/validation.mjs` — `validateKit(doc)` returns null or a reason
  string; checks the spec §6 shape (schema/application, 16 pads, note range,
  lock/role/sample/playback.gain), tolerates unknown fields.
- `src/core/storage.mjs`:
  - `saveKit(kit, name)` → writes `KitBuilder/Kits/<name>.kitbuilder.json` and
    refreshes `KitBuilder/current-kit.json` (§15.1, §15.2).
  - **Atomic-ish write** (§15.5): serialize → temp → read-back + parse → rename
    (`os.rename`, with a `host_write_file` fallback since `os.rename` isn't
    attested in the runtime). A failed final write leaves the previous good
    file intact.
  - **Filename sanitisation** (§15.6): strips control chars / `/` `\`, collapses
    `..`, replaces `<>:"|?*`, trims, falls back to `Kit Builder`, and appends
    ` (2)` / ` (3)` rather than overwriting.
  - **Generated name** (§3.3.1): `Kit Builder <NNN> <YYYY-MM-DD>`; `NNN` from
    `config.json:next_kit_number`, bumped only after a successful save.
  - `loadKit` / `loadKitFromString` + `markMissingSamples` (flags missing
    sample files without dropping the pads — §8.6). Reload is a storage-layer
    function with no in-UI browse path (§2.2, §3.1), exercised by
    `tests/test_storage.js` (10 cases).
- `ui.js`: RANDOM page gains a **Save** action — opens the shared keyboard
  (`text_entry.mjs`, pad-typing enabled) pre-filled with the generated name;
  writes on confirm and repaints the surface on close.

**Stage 5 exit criterion met:** a saved kit's data survives serialization and
reload through the storage layer, with assignments and locks intact (verified
on device — files land in `KitBuilder/Kits/`).

### Stage 5 revisions (Sam's feedback)

- **Kit identity across saves.** The name counter used to advance on *every*
  Save. Now the first Save of a session generates a name and consumes a counter
  value; later Saves of the same kit **overwrite that one file**. `saveKit()`
  takes an `overwriteName`; a changed name is a "save as" (new file).
- **New action.** Added `New` to the RANDOM list — starts a blank kit and
  clears the current name so the next Save gets a fresh number. Destructive, so
  it takes a second press within ~9 s to confirm.
- **Restore on relaunch.** Reverses the §3.1 "always blank" default: the
  working kit is written to `current-kit.json` on every change and on unload,
  and **restored on next launch**. `New` is the only path to a blank slate.
  Missing sample files are flagged (amber), not dropped.
- **Silent keyboard.** Pads used to still trigger the audition player while the
  Save keyboard was open (the shim routes pad notes straight to the DSP). The
  DSP now has a `mute` param; `ui.js` sets it while text entry is active.
- **Step buttons as action shortcuts.** Step buttons 1..5 mirror the RANDOM
  action list (`Assign` green, `New` blue, `Save` amber, `Clear` red,
  `Unlock All` white). A single press selects (and jumps to RANDOM); a second
  press within 400 ms fires it.

### Stage 6 — MrDrums export (spec §16, §24)

- Reversed the spec's assumption: "MrDrums-compatible JSON" is the **Ableton
  drum-rack `.ablpreset`** the shipping MrDrums actually loads (verified against
  `mrdrums_plugin.cpp :: load_preset`, not invented — §16.3).
- `src/exporters/mrdrums_json.mjs` — `buildMrDrumsPreset(kit)` /
  `exportKit(kit, opts)` (the §24 shape): `instrumentRack → drumRack → chains[]`,
  one chain per assigned pad; `receivingNote = 35 + pad`; `playback.gain →
  parameters.Volume` in dB using MrDrums's `10^((dB+12)/20)` reference (gain
  1.0 ⇒ −12.0 dB); `sampleUri` as `ableton:/user-library/…` with each path
  segment percent-encoded (a bare `+`/space/`%` in a sample name would
  otherwise resolve to the wrong file). Empty pads omitted; an all-empty kit
  refused.
- `core/storage.mjs :: exportMrDrums()` writes to
  `Track Presets/<name>.ablpreset`. **Save now also exports**
  (§3.3); an export failure is reported but never touches the working file
  (§16.5). Round-trip parse + chain-count check before returning ok.
- `tests/test_mrdrums_export.js` (8 cases) reimplements MrDrums's
  `url_decode` + `resolve_sample_uri` + dB maths to prove the emitted file
  round-trips back to the source sample paths.

**Stage 6 exit criterion:** MrDrums loads and plays the exported 16-pad kit —
verifiable only on device (load MrDrums, browse to the export).

### DSP notes (from the MrDrums design review)

- Fix: 24-bit WAV decode was 256× too hot (`/256` instead of `/65536`), which
  distorted 24-bit sample packs. Bumped the per-slot length cap 3 s → 5 s.
- DSP hardening after a design review against MrDrums
  (`handcraftedcc/schwung-mrdrums`):
  - **Float mix bus.** Voices now sum in float and the block is clipped once
    (with a `tanh` soft-knee near full scale) instead of an int16 clamp after
    every voice — removes the compounding crunch on dense hits.
  - **Anti-click ramps.** A ~1 ms position-derived fade-in on every note-on
    (also softens a retrigger) and a ~5 ms fade-out over the sample's tail, so
    a chopped one-shot no longer hard-cuts.
  - **AIFF support.** Added an AIFF/AIFC decoder (big-endian PCM 8/16/24/32,
    80-bit extended sample rate, `sowt` little-endian variant); format is now
    sniffed from the magic bytes, not the extension. `.aif` / `.aiff` were
    already indexed (config §7.1) and now play.
  Not adopted from MrDrums: synchronous load on the audio thread, per-block
  heap allocation, mono downmix, playback-time resampling, or the
  choke/pan/tune features Rev. 2 cut from Kit Builder.

### Stage 7 — packaging & release (spec §23, §26)

- `scripts/build_kit_builder.sh` — deterministic tarball (`--sort`, fixed
  mtime/owner) plus a versioned `dist/kit-builder-<version>.tar.gz` for release
  attachments.
- `scripts/validate_release.sh` — full pre-release checks (§21.1): manifest +
  `component_type`, `api_version 2` / `audio_out` when a DSP is declared, JSON
  assets, `ui.js` entry points, every relative import resolves inside the
  payload, `dsp.so` is an ELF exporting `move_plugin_init_v2`, and the version
  agrees across `module.json` / `release.json` / `CHANGELOG.md`.
- `scripts/package_release.sh` — build → validate → refresh `release.json`
  `download_url` from the module version and the `origin` remote → print the
  tag + upload steps.
- `scripts/install.sh` — SSH install of the built payload to a Move
  (`overtake/kit-builder/`, `$MOVE_HOST`).
- `.github/workflows/release.yml` — cross-compiles the DSP and publishes the
  tarball on a `v*` tag.
- `docs/catalog-entry.json` — the object to add to Schwung's
  `module-catalog.json` so the Module Store lists and auto-updates it.
- README rewritten for release: install (Manager + manual), full control
  reference, and an explicit **known-limitations** list (no in-tool kit
  browsing, MrDrums export only, User Library only, no per-pad editing, one
  voice per pad).

**Stage 7 exit criterion:** a clean install from the release package works on
Move — verified by wiping `overtake/kit-builder/` and extracting the versioned
tarball fresh.

### Post-packaging display fixes

- The footer status line is now **RANDOM-page only** — on KIT and SYSTEM it just
  duplicated on-page data, so it's gone and those pages use the full height.
- **KIT** page uses the freed rows: selected pad + note, lock, role, the
  sample's category (flagged when a fallback role was used), the full filename,
  and the DSP load state (loaded / loading / file missing / decode error).
- **SYSTEM** page shows the Rescan button + index age, then a two-column count
  grid (Indexed / Other, Kick / Snare, Clap / Hat, Perc / FX).
- Content on every page stays within its bound (`CONTENT_BOTTOM` y=44 for the
  footered RANDOM page, `FULL_BOTTOM` y=56 for the others) so nothing bleeds
  past the panel edge.

---

_All seven MVP stages (spec §23) complete; §26 release criteria met bar the
on-device MrDrums round-trip, which needs the hardware._
