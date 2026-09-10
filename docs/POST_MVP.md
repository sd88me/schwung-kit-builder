# Kit Builder — post-MVP backlog

v0.1.0 is the feature-complete MVP (spec §23). This is the agreed follow-on
work (Sam, 2026-09-09), grouped into batches with a test point after each so
changes stay reviewable. Rough sizings only.

Native Move drum-rack preset load — **already works** with the `.ablpreset`
we emit for MrDrums (verified on device), so no schema change is needed there.

---

## Batch A — small wins (JS + tiny DSP)  ·  **done** (v0.2.0)

### A1. Per-pad gain trim  ·  small
KIT-page **Knob 5** (spec §13.3 "Gain", reserved) trims the selected pad's
`playback.gain` (0.0–2.0, 0 dB = 1.0). DSP: `set_param("slot_gain_<N>", g)`,
multiply into the voice gain. Export path already maps `playback.gain` →
`Volume` dB. Persist via the existing `saveCurrentKit`.

### A2. Re-roll one pad  ·  small
**Hold a pad + fire Assign** re-rolls just that pad (if unlocked) from its
role pool, honouring duplicate-avoidance and current-sample exclusion. New
`rerollPad()` in `random_assign.mjs` (single-pad slice of `assignKit`). Track
`heldPad` on note-on / clear on note-off.

**Test A:** gain knob audibly trims a pad and survives save/reload; hold-pad +
Assign changes only that pad; locked pad is untouched.

---

## Batch B — sources  ·  **done** (v0.2.0)

### B1. Core Library as a source  ·  medium  ·  *shipped*
`Source` enum is **User / Core / Both** (RANDOM page Knob 2, §13.2). The
chunked scan now walks every library root that exists in one pass and tags each
record with `source`; the cached index stores `sample_roots` +
`counts_by_source`. `assignKit` / `rerollPad` filter by the selected source
(`bucketByRole`), `both` unions. RANDOM + SYSTEM pages show the mode;
`summarizeRecords()` recomputes SYSTEM category counts for it. MrDrums export
gained the `ableton:/packs/abl-core-library/` scheme so Core pads resolve.
Source resets to User on `New`/launch, survives a Back-park.

**Test B:** Source toggle changes which samples Assign draws; Core-only and
Both work; index rebuild covers both roots without stalling.

---

## Batch C — reject / favourite memory  ·  **done** (v0.2.0)

### C1. Reject + favourite lists  ·  medium  ·  *shipped*
KIT page: **Up** = favourite the selected pad's sample, **Down** = reject it
(mutually exclusive, toggle off on repeat); **Shift+Up / Shift+Down** clear the
whole list. Stored library-wide (flat path lists, not per-role) in
`KitBuilder/preferences.json` — not tied to a kit, not cleared by `New`.
`assignKit` / `rerollPad` drop rejects from the pool (before duplicate
relaxation) and weight favourites ~2×. KIT page shows the sample's `FAV`/`REJ`
standing plus `R n F n` totals.

**Test C:** a rejected sample never reappears on re-roll; a favourite comes up
markedly more often; lists persist and can be cleared.

---

## Batch D — export system  ·  *in progress* (D1 + D3 shipped v0.2.0)

### D1. EXPORT page with per-type toggles  ·  **done** (v0.2.0)
4th page **EXPORT**: rows toggle MrDrums `.ablpreset` (default on) and MPC
`.xpm` (default off), plus an **Export now** row. Up/Down select, jog-press
acts. Persisted in `config.json → exports`. Save runs every enabled exporter,
per-type success reported.

### D3. Akai MPC `.xpm` export  ·  **done** (v0.2.0)
Template-substitution off a real MPC-V 2.1 drum program (Sam supplied
`All_purposeCrunchy_Kit.xpm`; method per github.com/psrpinto/roger). Keeps the
program byte-for-byte, sets `<ProgramName>` + per-pad Layer-1 `<SampleName>`,
regenerates `<PadNoteMap>` ((35+pad) mod 128) / `<PadGroupMap>`. Output diffs
clean against the reference. Writes `KitBuilder/Exports/MPC/<Kit>/<Kit>.xpm` +
`MANIFEST.txt` and now **gathers** each sample into that folder as
`<SampleName><ext>` (`storage.hCopy` → `host_copy_file`, else an allowlisted
`cp`, else a string round-trip). Any copy that fails is tagged `[MISSING]` in
`MANIFEST.txt` for a manual step. `<SliceEnd>`=0 for now.

### D2. `.ablpresetbundle` export  ·  **dropped** (2026-09-10)
`.ablpresetbundle` is an *inbound* format — built off-device, pushed to Move
via Move Manager or opened in Note. Kit Builder runs on Move and already
lands its kit in Move's Track Presets (the MrDrums `.ablpreset`, samples
referenced in place), so there is no import step for a bundle to serve. A kit
leaving Move *with* its samples is Move's own drum-rack save (`.ablbundle`),
which Move does natively. Reimplementing a sample-zipping exporter here is
redundant and was hard-blocked on binary I/O from module JS anyway. Removed
from scope; the reference material was doc-only (never coded).

### D3. Akai MPC `.xpm` export  ·  **done** (see above)
Sample gathering now happens on export (`exportXpm`'s injected `copy`). The
on-device copy is best-effort for binary until a real `host_copy_file` lands;
`MANIFEST.txt` remains the fallback of record.

**Test D:** EXPORT toggles persist ✓; `.xpm` diffs clean vs the reference ✓;
still to verify — `.xpm` loads + plays on Sam's MPC.

---

## Batch E — engine v2  ·  *after D*

All DSP-side; do together since they touch the same code.

### E1. Automatic loudness matching  ·  medium
DSP measures each sample's RMS (or a simple loudness proxy) at load and offers
a per-pad makeup gain so a kit isn't lopsided. UI: a toggle ("match levels")
and/or a one-shot "level match" action; result folds into `playback.gain` so
it exports. Manual A1 trim still overrides.

### E2. Audition step sequencer  ·  **headline**  ·  medium–high
Spec §28. 16-step × 16-lane pattern in the DSP, advanced off Move's transport
clock (the shim already delivers clock/start/stop to `overtake_dsp` on the
audio thread). Record/Sample button flips the step row between the
action-shortcut mode and the pattern grid. Playhead LED. Plays only while the
tool is foreground (JS sets a param on park/resume). Pattern is transient in
the first cut (not saved, not exported).

Open questions to settle first (from §28.4):
- keep advancing silently while parked, or reset to step 1 on resume?
- swing / pattern length in v1, or later?
- does "double-press to run" also gate the on-screen jog-press, or stay
  step-button-only?

**Test E:** kit level is even after match; sequencer runs in time with Move's
transport, only while the tool is open, and the step row toggles cleanly
between modes.

---

## Batch F — adopted from drum-kit-generator  ·  **done**
*(github.com/klingklangmatze/drum-kit-generator; all pure-JS + tested.)*

### F1. Skip loops and oversized files during the scan  ·  **done**
`src/core/scan_filters.mjs`: `makeScanFilter(cfg).reject(name, size)` returns
`'loop'` (name has `loop`, a `[<n>` bpm tag, or `<n> bpm`), `'oversize'`
(over the cap), or `null`. `createScan` applies it after the extension check
and tallies `skipped_loops` / `skipped_oversize` into the index payload.
**Selectable on SYSTEM:** knob 1 toggles the loop filter, knob 2 cycles the
size cap (Off / 1M / 2M / 5M / 10M); both persist to `config.json`
`scan_filters` (`loadScanPrefs` / `saveScanPrefs`) and apply on the next
Rescan. Default: skip loops on, no size cap. SYSTEM page shows both toggles
and a `Cut nL nB` line. Narrow opt-out heuristic — not the general "filename
tag filters" idea still parked in Not planned.

### F2. Enrich the classifier alias table  ·  **done** (extended by Batch G)
`role_rules.*.folder_aliases` in `sample_index.DEFAULT_CONFIG` + both
`kit_config.json` copies expanded with the generator's vocabulary, normalised
singular+plural (matching is exact, no stemming). Batch F did this against the
original 7 roles; Batch G then took it to the full 22-category set (rim / tom /
conga / crash / ride / cymbal / hat split out, melodic vox/bass/synth/stab/
chord/lead/pad added). Still folder-component matching (spec §7.2) — filenames
untouched.

### F3. WAV metadata stripping  ·  **done**
`src/core/wav_strip.mjs`: `stripWav(bytes)` keeps only `fmt `/`fact`/`data`,
drops LIST/bext/iXML/ID3/PEAK/JUNK/…; anything not a clean little-endian
RIFF/WAVE is returned untouched. Wired into `storage.hCopy`'s JS round-trip
branch (`stripWavString`) so the MPC `.xpm` gather places lean WAVs beside the
`.xpm` (smaller, fewer MPC import quirks). `stripWav` (the byte-array form) is
kept for any future exporter that copies audio.

### F4. Full 42-param drumCell  ·  **done**
`mrdrums_json.drumCell()` now writes the complete parameter block
(`DRUM_CELL_DEFAULTS`) verbatim from a real Move drum-rack export; Kit
Builder still only drives `Volume` (pad gain) and `Pan`. MrDrums ignores the
extra keys; Move's own Track-Preset loader may want the full set.

**Test F:** `test_scan_filters` (loop/size/enum), `test_wav_strip`
(chunk-keep/passthrough/odd-pad/string bridge), `test_classifier` (new
aliases + deepest-match), `test_mrdrums_export` (42-param block, gain still
moves only Volume), `test_storage` (scan-pref persist/merge). ✓

---

## Batch G — Rev. 3 category / pad model  ·  **done**
*(Spec bumped to Revision 3 — see its revision history. Adopts the
drum-kit-generator's category vocabulary and pad layout.)*

- **22 categories** (`rim tom conga crash ride cymbal hat` + melodic `vox
  bass synth stab chord lead pad` added). Folder aliases only; a category no
  longer implies a pad. `sample_classifier` mechanism unchanged.
- **`config.pad_layout`** — 16 category lists; each pad draws the **union**,
  uniform pick. `role_rules[*].pads` / `fallback_roles` removed. No fallback
  chain — empty union → unresolved pad.
- **`["other"]` sentinel** → unslotted categories + `fx` (fx on pad 12 *and*
  the catch-all pads 13–16). `random_assign.otherPoolCats` / `poolCatsForPad`.
- **`pad.role`** = pool's first category (display/compat); old kits load
  unchanged. `roleForPad`/`makePad` now take the full `config`.
- **SYSTEM page** → 8 grouped buckets + Other (`SYSTEM_BUCKETS`, `summarize`).
  KIT page shows the pad's `Pool` and, for a sample outside it, `Drawn from`.
- Touched: `kit_model` (`DEFAULT_PAD_LAYOUT`, `padPool`), `sample_index`
  (`DEFAULT_CONFIG`, `ROLE_ORDER`, `SYSTEM_BUCKETS`, `mergeConfig`,
  `summarize`), `random_assign` (union `resolveOne`), `validation.ROLES`,
  both `kit_config.json`, `ui.js`, spec §6.4/§7.1/§7.3/§7.4/§10.2/§13.4.

**Test G:** `test_assignment` rewritten for union pools (each pad stays in
its pool, pools actually mix over seeds, fx on pad 12 + Other pads, no
fallback → unresolved, relaxation on a starved Other pool);
`test_classifier` Rev. 3 vocab (rim/tom/conga/crash/ride/cymbal, generic
`hat` vs closed/open + plurals, melodic categories, shaker→hat tie). ✓

---

## Deferred (explicitly, until the above land)

- **UI-editable pad→role map** — assign a custom role/pool to a pad from the
  device instead of only `config.json`.

## Not planned (spec §2.2 tail, no demand yet)

Waveform display, sample start/end/filter trim, `.sfz` export, audio-analysis
classification fallback, import/edit of existing kits, choke groups,
pool-fairness for shared-pool roles, filename tag filters.
