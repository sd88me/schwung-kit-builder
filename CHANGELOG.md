# Changelog

All notable changes to Kit Builder are recorded here.

## [1.0.1] — 2026-09-11

Fix: a track playing elsewhere could still trigger Kit Builder's pads while
it was merely parked (Back), not actually exited.

- `suspend_keeps_js` keeps the module (and its DSP) loaded across a plain
  Back so resuming is instant — but that also keeps the DSP's `on_midi` hook
  wired to Move's internal pad-note stream the whole time it's parked, which
  is the same stream a playing track's own notes land on (see [1.0.0]'s
  background-transport fix). A phantom note reaching a parked Kit Builder
  triggered its pad samples off-screen, with no UI up to explain why.
- Kit Builder now mutes its own DSP the moment it's parked (`kit_player.c`'s
  existing `muted` flag — the same one that silences the audition player
  while the Save keyboard is open) and unmutes on resume. The DSP and its
  loaded samples stay warm, so parking is still instant; nothing can sound
  until you're actually looking at it again.

## [1.0.0] — 2026-09-11

Knob-grid redesign — every page redrawn on the schwung param-page grid
(docs/PARAM_PAGES.md): real knob / enum-square / trigger widgets, doors for
the three list-shaped pages, knob-ring LEDs, and a background-playback fix.
Hardware-tested.

### Doors — RANDOM, SYSTEM, EXPORT

- All three list-shaped pages now sit behind a **door**: closed, a
  chevron-edged frame previews the content; a jog press opens it full-screen
  (the jog wheel, repurposed from page-turn, scrolls while it's open); a
  second press acts on the highlighted row. A door has to close on its own
  click — there is no Back inside an overtake module to fall back on
  (suspend_keeps_js hands it to the host).
  - **RANDOM**'s door holds the action list; firing an action closes it.
  - **SYSTEM**'s door holds the full index report; closes on any click —
    nothing there to act on.
  - **EXPORT**'s door wraps the whole page, since nothing else uses its
    knobs. Rows are checkbox-first (checkbox left, format name beside it);
    **Export now** drops the checkbox for a pill so it reads as an action.
    Toggling a checkbox stays open, so several can be flipped in a row;
    running Export now closes it.

### RANDOM

- **Duplicates** is an enum square (`AVOID`/`ALLOW`) on Knob 3; **Source** an
  enum square on Knob 4 — both freed from the door's old cells. **Asn/Lck**
  sit as a plain readout (value above, label below, like every knob widget)
  on Knob 7/8's span, tightened to read apart from Dup/Src above them.

### KIT

- No Pad-select knob — pressing a pad already selects it, so a second control
  for the same thing was dropped. **Gain** takes Knob 1 / cell 1 instead: the
  cell only ever shows "Gain", and the value peeks in a short overlay while
  the knob turns (~700ms), the way a plain schwung knob does, rather than
  being crammed into the cell permanently. Cell 2 is just a "which pad"
  readout. No lock line — the pad LED already carries it. Row 2 is the pool,
  then the sample name in an inverted-pill (knocked-out) style.

### SYSTEM

- **Loop** and **Max sample size** are enum squares (Knob 1/2). **Rescan** is
  a cap-button fired by turning Knob 3 — a trigger fires from the knob, not a
  click (PARAM_PAGES.md) — latched to one Rescan per turn gesture
  (`RESCAN_GESTURE_TICKS`). "Max size" stacks as two lines so it doesn't
  overflow into neighbouring cells; the Rescan label shortened to "Scan" so
  it doesn't clip against the panel's left edge.

### Knob-ring LEDs

- Knobs 1-4 light (white, brightness tracking value; dark = unbound) to show
  which knob does something on the current page — schwung's own
  `param_pages/knob_leds.mjs`, reused rather than reinvented.

### Stops a playing background track on open

- A Schwung track playing in the background sends its own notes onto the same
  channel a real pad press does — confirmed from a device capture: identical
  status byte, channel and shape, nothing to filter on. Kit Builder now checks
  Move's transport on open and resume and, if it's already running, stops it
  (a real Play-button press, injected — the technique `song-mode/ui.js`
  already uses to drive Move's transport), removing the phantom presses at
  the source instead of trying to tell them apart from real ones.

### Fixes

- Every centred label now clamps to the panel's safe margin instead of
  running off it when centred near an edge or too wide for its cell (root
  cause of the Rescan clipping, and a general safety net going forward).
- Footer hints are `"Key: action"` strings, not `[key, action]` pairs — the
  shared `drawMenuFooter` inverts only the key into its pill and prints the
  action plain beside it; a bare pair had no colon to split on and collapsed
  into one `JOG,PAGE`-style pill with the action lost.

## [0.3.1] — 2026-09-10

Display overhaul + sequencer fixes.

### Shared UI chrome

- **Header** → the shared `drawMenuHeader` (`menu_layout.mjs`) — the standard
  movy top strip (kit name left, page name right), same as `mono` and the
  other Schwung modules. Replaces the hand-drawn title + separator.
- **Footer** → `drawMenuFooter` hint pills on *every* page — contextual
  key→action hints (`Jog:page`, `Clk:Assign`, `K1:pad`, …). Previously only
  the RANDOM page had a footer and it was a bare status string.
- **Transient status** ("Assigned 14 pads", "Saved: …", "Rescan to apply", …)
  → a shared overlay-card toast (`showOverlay`), held ~11 s and dismissable by
  any input after a short grace. No more persistent bottom line. Every shared
  call is `typeof`-guarded so an older `menu_layout` degrades to a no-op
  rather than breaking input.
- **EXPORT page** body → the shared scrolling `drawMenuList` widget.
- RANDOM and SYSTEM keep purpose-built compact bodies inside the new chrome
  (RANDOM: actions + the Dup/Src/Asn/Lck controls; SYSTEM: the filter
  controls + a 3×3 category-count grid — both fit without scrolling).
- KIT stays a bespoke per-pad detail view, refitted into the shared band.

### Sequencer fixes

- `init()` now force-clears the sequencer (`seqReset` + `seq_run=0`) on every
  module start — nothing can be left playing "from before" after a reopen.
- **Play always toggles run/stop** — dropped a guard that could refuse to stop
  when it judged the pattern empty. `New` also fully clears the sequencer.

### Other

- The init log line reported `v0.1.0` regardless of the real version — now
  tracks `module.json`.

## [0.3.0] — 2026-09-10

Batch E — engine v2 (loudness matching + audition step sequencer). Includes
everything from the unreleased 0.2.0 line below (post-MVP Batches A–G).

### E1 — automatic loudness matching

- The DSP loader thread measures each decoded slot's **peak-window RMS** (the
  loudest ~125 ms — whole-sample RMS let a long quiet tail drag a punchy
  hit's number down) and reports all 16 via `get_param("loudness")`.
- `src/core/loudness.mjs` (pure): `matchGains()` is **attenuate-only** by
  default — the target is a low percentile of the readings, so the quietest
  pads keep unity gain and everything louder is turned *down* to meet them.
  Nothing is boosted, so the match can't add clipping. Empty slots stay at
  1.0; `opts` (`percentile` / `target` / `minGain` / `maxGain`) can re-enable
  makeup boost.
- **RANDOM page → "Match Levels"** (6th action; step button 6). Applies the
  gains to every assigned pad's `playback.gain` + the DSP `slot_gain`, and
  persists. A manual Knob-5 trim afterwards still overrides.
- Tests: `test_loudness.js` (7).

### E2 — audition step sequencer

- Internal 16-step clock in the DSP, tempo from the host's global BPM
  (`move_plugin_init_v2` now keeps the `host_api` pointer). One 16-bit lane
  per pad; `render_block` advances the step accumulator and fires each step's
  lanes through a shared `trigger_slot()`. Fixed 16 steps, no swing.
- **Foreground gate:** the UI pumps a `seq_fg` heartbeat each tick; without
  one for ~30 render blocks the sequencer pauses and resets to step 1, so a
  parked tool falls silent.
- **Rec button** toggles the pattern-edit view (LED stays lit). **Play
  button** runs / stops — independent of the view, so you can leave edit mode
  with it still playing. In edit mode the 16 step buttons toggle the selected
  pad's lane (Knob 1 picks the pad), the step LEDs show the grid + a walking
  playhead, and a full-screen SEQ readout replaces the page.
- `onResume` brings the sequencer back **stopped at step 1**, keeping the
  pattern; `New` clears it. The pattern is transient — not saved, not
  exported (spec §28 first cut).
- DSP params: `set_param` `seq_run` / `seq_lane_<N>` / `seq_clear` / `seq_fg`;
  `get_param "seq"` → `"<run> <step>"`.

## [0.2.0] — unreleased

Post-MVP work — see [`docs/POST_MVP.md`](docs/POST_MVP.md) for the batch plan.

### Batch A — small wins

- **Per-pad gain trim** (spec §13.3). KIT page **Knob 5** trims the selected
  pad's `playback.gain` (0.0–2.0, 1.0 = 0 dB); shown on the page as dB. The DSP
  gained a `slot_gain_<N>` param and multiplies it into the voice level; `Clear`
  / `New` reset it to unity. The MrDrums export already carries `playback.gain`
  as `Volume` dB, so trims travel with the kit.
- **Re-roll one pad.** Hold a pad and fire **Assign** to re-roll just that pad
  from its role pool (duplicate- and current-sample-avoided), leaving the rest
  of the kit untouched. `random_assign.mjs` factored into a shared `resolveOne`
  used by both `assignKit` and the new `rerollPad`.
- `random_assign.resolveOne` also takes optional `rejects` / `favourites` sets
  (wired for Batch C; no behaviour change until passed).
- Tests: `test_assignment.js` +3 cases (reroll changes one pad, refuses a
  locked pad, rejects/favourites weighting).

### Batch B — Core Library as source

- **Source selector** (spec §13.2). RANDOM page **Knob 2** cycles the sample
  source: **User** (`/data/UserData/UserLibrary/Samples`), **Core**
  (`/data/CoreLibrary/Samples`), or **Both**. Shown on the RANDOM and SYSTEM
  pages; resets to User on a fresh `New`/launch, preserved across a Back-park.
- RANDOM-page knob layout: **Knob 1 = Duplicates, Knob 2 = Source** (Duplicates
  moved off knob 3). Both enum knobs now accumulate encoder ticks and only step
  once a turn crosses `ENUM_KNOB_TICKS` (8) — the detent-less Move encoders fire
  several ticks per light touch, so a brush no longer flips them.
- `sample_index.createScan` now walks **every library root that exists** in one
  pass, tagging each record with its `source`. The cached index stores
  `sample_roots` + `counts_by_source`; `summarizeRecords(records, source)`
  recomputes the SYSTEM-page category counts for the chosen source.
- `assignKit` / `rerollPad` already filtered candidates by `source`
  (`bucketByRole`), so the selector just feeds them the mode. `both` draws from
  the union.
- MrDrums export learned the **`ableton:/packs/abl-core-library/`** scheme so
  Core-library pads resolve on load (from `ableton_uri` or, failing that, a
  `/data/CoreLibrary/` filesystem path).
- Tests: `test_assignment.js` +1 (source filter restricts / unions picks);
  `test_mrdrums_export.js` +1 (core samples round-trip through MrDrums).

### Batch C — reject / favourite memory

- Library-wide **reject** and **favourite** lists, keyed by sample path,
  persisted in `KitBuilder/preferences.json`. A rejected sample is never
  picked by Assign or re-roll; a favourite is weighted ~2× in its role pool.
  Not tied to a kit and not cleared by `New`.
- KIT page: **Up** favourites / **Down** rejects the selected pad's sample
  (mutually exclusive, toggles off on repeat). **Shift+Up** / **Shift+Down**
  clear the whole favourite / reject list. The KIT page shows this sample's
  `FAV`/`REJ` standing and the running `R n F n` totals.
- Engine was already wired (`resolveOne` takes `rejects` / `favourites`
  Sets); `fireAssign` / `fireRerollPad` now pass the loaded sets. Rejects
  are dropped before duplicate-relaxation, so relaxation never reinstates
  one.
- Tests: `test_storage.js` +2 (prefs round-trip as Sets; malformed file
  loads empty), `test_assignment.js` +1 (re-roll never lands on a reject).

### Batch D — export system

- **EXPORT page** (4th page). Rows toggle each exporter on/off — MrDrums
  `.ablpreset` (on by default), **MPC `.xpm`** (off by default) — plus an
  **Export now** row. Up/Down select, jog-press acts on the selection. The
  toggles persist in `config.json → exports` (next to `next_kit_number`).
  A Save runs every enabled exporter and reports per-type success.
- **MPC `.xpm` exporter** (`exporters/mpc_xpm.mjs` + `xpm_template.mjs`).
  Method per github.com/psrpinto/roger: a real MPC-V 2.1 drum program is the
  structural template; the export keeps it byte-for-byte and changes only
  `<ProgramName>`, each used pad's Layer-1 `<SampleName>`, and regenerates
  `<PadNoteMap>` (Note = (35 + pad) mod 128) / `<PadGroupMap>`. Output is
  structurally identical to the reference file (verified by diff).
- **Sample gather.** `exportXpm` takes an optional `copy(src, dest)`; when
  supplied it copies each assigned sample into the `.xpm`'s folder as
  `<SampleName><ext>` and reports a `gathered` count. `MANIFEST.txt` is
  always written as the fallback, with rows tagged `[gathered]` / `[MISSING]`.
  `storage.hCopy` prefers a real host copy primitive, then an allowlisted
  `cp`, then a `host_read_file`/`host_write_file` round-trip (WAVs run through
  `wav_strip` first — see Batch F).
- **`<SampleName>` = the source file's own basename** (extension dropped,
  spaces/parens kept, other unsafe punctuation → `_`, capped at 42). Was
  `<kit>-<NN>-<name>`; duplicate names across pads still disambiguated.
- **`.ablpresetbundle` (D2) dropped.** It is an inbound/import format (built
  off-device, uploaded to Move via Move Manager or opened in Note); a kit
  leaving Move with its samples is Move's native `.ablbundle` drum-rack save.
- Tests: `test_mpc_xpm.js` (14 — template preserved, 128 instruments, per-pad
  names, PadNoteMap wrap, CRLF, dedup, manifest, gather + `[MISSING]` tag).

### Batch F — adopted from drum-kit-generator

_(github.com/klingklangmatze/drum-kit-generator — pure-JS, tested.)_

- **Scan-time loop + size filters** (`core/scan_filters.mjs`). Drop a file
  from the index when its name looks like a loop (`loop`, `[120bpm]`,
  `128 bpm`) or it exceeds a byte cap. **SYSTEM knob 1** toggles the loop
  filter, **knob 2** cycles the size cap (Off / 1M / 2M / 5M / 10M); both
  persist in `config.json → scan_filters` and take effect on the next
  Rescan. Skipped counts show on the SYSTEM page. Default: loop-skip on, no
  size cap.
- **WAV metadata stripping** (`core/wav_strip.mjs`). `stripWav()` keeps only
  the `fmt `/`fact`/`data` chunks, dropping LIST/bext/iXML/ID3/JUNK/…;
  anything that isn't a clean little-endian RIFF/WAVE passes through
  untouched. Wired into `storage.hCopy` so the MPC gather writes lean WAVs.
- **Full 42-param `drumCell`** in the MrDrums export, verbatim from a real
  Move drum-rack export, so the preset also satisfies Move's own Track-Preset
  loader. Kit Builder still only drives `Volume` (pad gain) and `Pan`.
- **Enriched folder aliases** — the classifier alias table gained the
  generator's vocabulary (later extended to the full Rev. 3 set).
- Tests: `test_scan_filters.js`, `test_wav_strip.js`,
  `test_mrdrums_export.js` +2.

### Batch G — Revision 3 category / pad model

Spec bumped to **Revision 3** (see its revision history).

- **22 classification categories** (adds `rim tom conga crash ride cymbal
  hat` + melodic `vox bass synth stab chord lead pad`). `role_rules` entries
  carry `folder_aliases` only.
- **`config.pad_layout`** — an array of 16 category lists. Each pad draws
  from the **union** of its list, picked uniformly. `role_rules[*].pads` and
  `fallback_roles` removed; **no fallback chain** — an empty pool leaves the
  pad unresolved.
- **`["other"]` layout sentinel** expands to every category with no dedicated
  pad slot, **plus `fx`** — so `fx` sits on pad 12 *and* the catch-all pads
  13–16.
- **`pad.role`** is now the pool's first category (display / kit
  back-compat); older kits load unchanged.
- **Filename fallback for classification** (`classify_filenames`, default
  on). When a folder path yields `other`, `classifyFilename()` does a
  token-exact keyword match on the file's own name (contiguous joins of up to
  3 tokens, longest first; no substrings, so `bassline` ≠ `bass`). Folder
  still wins.
- **SYSTEM page** is a fixed header + a 4-row scrollable list (Up/Down):
  Indexed · Loop filter · Max size · Cut · the 8 category buckets · Other.
- Touched: `kit_model` (`DEFAULT_PAD_LAYOUT`, `padPool`), `sample_index`
  (`DEFAULT_CONFIG`, `ROLE_ORDER`, `SYSTEM_BUCKETS`, `summarize`),
  `random_assign` (union `resolveOne`, `otherPoolCats`, `poolCatsForPad`),
  `validation.ROLES`, both `kit_config.json`, `ui.js`, spec
  §6.4/§7.1–§7.4/§10.2/§13.4.
- Tests: `test_assignment.js` rewritten for union pools; `test_classifier.js`
  Rev. 3 vocab + filename fallback.

### Fixes

- **`sanitizeFilename`** (§15.6) stripped path separators *after* collapsing
  dot-runs and then removed every leading dot, so `../../etc/passwd` became
  `etcpasswd`. Now: separators first, then collapse `..` to one dot, trim
  surrounding whitespace only, fall back to `Kit Builder` for an empty or
  dots-only result. Still can't traverse.

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
