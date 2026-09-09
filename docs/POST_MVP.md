# Kit Builder — post-MVP backlog

v0.1.0 is the feature-complete MVP (spec §23). This is the agreed follow-on
work (Sam, 2026-09-09), grouped into batches with a test point after each so
changes stay reviewable. Rough sizings only.

Native Move drum-rack preset load — **already works** with the `.ablpreset`
we emit for MrDrums (verified on device), so no schema change is needed there.

---

## Batch A — small wins (JS + tiny DSP)  ·  *next*

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

## Batch B — sources  ·  *after A*

### B1. Core Library as a source  ·  medium
`Source` enum becomes **User / Core / Both** (Knob 2, §13.2). The indexer
scans `/data/CoreLibrary/Samples` as well (`path_mapping.mjs` core→`ableton:/
packs/abl-core-library/` mapping is already in place); index records carry
`source`. `assignKit` filters candidates by the selected source (it already
takes a `source` arg). SYSTEM page shows counts per source or a combined total.
Bigger index — keep the chunked scan.

**Test B:** Source toggle changes which samples Assign draws; Core-only and
Both work; index rebuild covers both roots without stalling.

---

## Batch C — reject / favourite memory  ·  *after B*

### C1. Per-role reject + favourite lists  ·  medium
On the KIT page (or hold-pad gesture): mark the current sample **reject**
("never pick this for its role again") or **favourite** ("prefer it"). Stored
in `config.json` per role (`{ reject: [...paths], favourite: [...paths] }`).
`assignKit` drops rejects from the pool and weights favourites up. A way to
clear the lists (SYSTEM page action). Turns repeated Assign into guided search.

**Test C:** a rejected sample never reappears on re-roll for that role; a
favourite comes up markedly more often; lists persist and can be cleared.

---

## Batch D — export system  ·  *after C*

### D1. EXPORT page with per-type toggles  ·  small–medium
New 4th page **EXPORT**. Toggle each exporter on/off (persisted in
`config.json → exports`): MrDrums `.ablpreset` (on by default), Ableton
`.ablpresetbundle`, Akai MPC `.xpm`. Save runs every enabled exporter;
per-type success/failure reported. Jog-press on EXPORT = "export now" without
a save.

### D2. `.ablpresetbundle` export  ·  medium  ·  *binary I/O risk*
Zip containing the `.ablpreset` + a `Samples/` folder of copied WAVs, so a kit
is portable without the source library. Module JS can't do binary file I/O
safely (`host_read_file` → string), so the **DSP loader thread** does it:
`set_param("export_bundle", "<destpath>")` → read each slot's raw file, emit a
**store-only** (no-deflate) zip. Watch total size (16 samples can be tens of MB).

### D3. Akai MPC `.xpm` export  ·  medium  ·  *needs real reference files*
`.xpm` is XML — straightforward to template — but the schema drifts across
MPC 2.x / 3.x, so match a real file, don't invent (the MrDrums §16.3 lesson).
Per-pad sample path + tuning + envelope + (optional) velocity layers. For real
MPC transfer the samples must travel too (same binary-copy path as D2), or
export the `.xpm` referencing resolvable paths only.

**Test D:** EXPORT toggles persist; a bundle unzips to a working `.ablpreset`
+ samples; the `.xpm` loads on an MPC (or validates against a known-good file).

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

## Deferred (explicitly, until the above land)

- **UI-editable pad→role map** — assign a custom role/pool to a pad from the
  device instead of only `config.json`.

## Not planned (spec §2.2 tail, no demand yet)

Waveform display, sample start/end/filter trim, `.sfz` export, audio-analysis
classification fallback, import/edit of existing kits, choke groups,
pool-fairness for shared-pool roles, filename tag filters.
