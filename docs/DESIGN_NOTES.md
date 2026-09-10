# Kit Builder — implementation decisions

A running log of build decisions that aren't obvious from the code or the spec,
with the reasoning. The MVP spec is `KIT_BUILDER_SPEC.md`; this file records how
it was realised and where the implementation deliberately diverges.

---

## Module shape & hardware surface

### Overtake module, not a Tool
`component_type: "overtake"`. Kit Builder needs the whole 4×4 pad grid, Shift+Pad,
RGB LEDs and the display at once (spec §2.1). Overtake modules get exactly that —
full display + LED ownership — where a plain Tool would fight Move for the surface.
Installed at `modules/overtake/kit-builder/`.

### `suspend_keeps_js` — Back parks, Shift+Back exits
`capabilities.suspend_keeps_js: true`. This matches the TB-3PO / Maze behaviour the
spec's spike (§27) calls for: plain **Back** parks the module in the background with
its JS state and tick loop alive; **Shift+Back** fully exits. The host owns both
gestures — the module must *not* handle `MoveBack` itself.

> **Gotcha (cost us three rounds):** while parked, the host keeps calling the
> module's `tick()` with the draw/LED bindings stubbed to no-ops. On resume the
> host needs several frames before queued LED writes reach the hardware, so a
> single repaint in `onResume()` is silently dropped. Fix: `onResume()` +
> `tick()` **force-repaint the whole pad surface repeatedly for ~30 frames**
> (`RESUME_PAINT_FRAMES`), mirroring `mono`. Also early-return `tick()` while
> `globalThis.overtakeParked` is set.

### Navigation: jog wheel, not encoder buttons
Move's encoders don't physically click, so the eight "encoder buttons" of spec
§13.2/§13.3/§13.4 can't be taken literally in an overtake shell. Mapping:

- **Jog turn** → move between the `RANDOM` / `KIT` / `SYSTEM` pages.
- **Jog press** → fire the current page's primary button.
- **RANDOM page** is an **Up/Down action list** (`Assign`, `Save`, `Clear`,
  `Unlock All`); jog press fires the highlighted one. Knob 3 turns the
  `Duplicates` enum.
- **KIT page**: Knob 1 = Selected Pad; jog press = Clear Pad.
- **SYSTEM page**: jog press = Rescan.

An overtake module reads raw MIDI, so this is all hand-rolled from the CC map
rather than Schwung's param-widget system.

### Display: 6 px left margin, every line clamped
The Move OLED panel crops a few columns at each edge. Text at `x=2` (the
convention in reference modules) gets clipped on the left — moved to `x=6`, and
every content line runs through a `text_width()`-based clamp so nothing overflows
either side.

---

## JavaScript structure

### Core logic in `src/core/*.mjs`, imported by `ui.js`
`kit_model`, `random_assign`, `sample_index`, `sample_classifier`, `path_mapping`,
`storage`, `validation`. `.mjs` extension and relative imports (`./core/…`) —
matches the proven pattern in Schwung's `chain` module (`./midi_fx/index.mjs`).
The build script copies `src/core/` into the module payload; `validate_release.sh`
checks every relative import in `ui.js` exists in the payload.

The pure modules (`kit_model`, `random_assign`, `sample_classifier`,
`path_mapping`, `validation`) have no `os`/`host_*` dependency and are unit-tested
with a dependency-free runner (`tests/run.js`, `npm test`).

### Config: embedded default + optional override file
`DEFAULT_CONFIG` (spec §7.1) is a literal in `sample_index.mjs`. A module can't
easily locate and read its own bundled file, so the default lives in code and
`/data/UserData/UserLibrary/KitBuilder/config.json` (if present) overrides it.
`config/default_kit_config.json` and `src/kit_config.json` are kept in sync as
the human-readable source of truth. The counter for generated kit names
(`next_kit_number`, §3.3.1) also lives in `config.json`.

### The internal kit is the single source of truth (§4.1)
`kit_model.createKit()` produces the spec §6 object directly. `ui.js` holds one
`kit`; a parallel `padFx[]` array carries *transient* LED effects (flash,
fail-flash) so they never touch the persisted model.

### Assignment engine (§10)
`random_assign.assignKit()` is pure and never mutates the input kit — it returns
a proposed 16-pad array plus a report, and the caller commits it as one
transaction (§10.3). `mulberry32` PRNG; unlocked pads resolved in **ascending
pad-number order** (§10.2, decision 4). Rev. 3: each pad's pool is the **union**
of the categories in `config.pad_layout[i]` (the `["other"]` sentinel expands to
every unslotted category + `fx`); no fallback chain. Duplicate prevention counts
locked-pad samples as used and reports a relaxation when a pool runs dry; the
pad's current sample is dropped from its own pool when alternatives exist. An
empty pool leaves that pad unresolved and the kit stays valid.

### Sample scan is chunked, pumped from `tick()`
`sample_index.createScan()` returns a pump; `tick()` calls `step(400)` per frame
so the recursive `os.readdir`/`os.stat` walk of the User Library never blocks the
display (spec §4.1, §20). Metadata only — no decoding during indexing. The result
is cached to `KitBuilder/.sample-index.json` (tmp → parse-check → rename, §8.5).
Folder→role classification is separator- and case-insensitive with a
**deepest-folder-wins** tie-break (§7.2).

---

## Audition player DSP (`src/dsp/kit_player.c`)

Kit Builder's first native code. A **v2 sound-generator plugin**
(`move_plugin_init_v2`) that the Schwung shim loads as `overtake_dsp`. The shim
delivers cable-0 pad notes straight to `on_midi`, so pressing an assigned pad
plays it with no JS round-trip; `ui.js` only pushes each pad's file path via the
`slot_<N>` param and polls `sounding` / `slot_status` for the LEDs.

### One voice per pad, hard retrigger
Spec §14.4 explicitly permits this as the risk-reduced v0.1.0 option ("voice
retriggering may replace the previous voice for the same pad"). A global voice
pool with stealing is deferred; the anti-click ramp (below) covers the audible
cost of fast repeats on one pad.

### Sample loading is off the audio thread
`plugin_api_v1.h` is emphatic that `set_param` / `on_midi` / `render_block` run on
the SPI audio thread — no file I/O, no `malloc`/`free`, no cross-thread locks.
So:

- `set_param("slot_N", path)` only does a bounded `strcpy` into a seqlock-guarded
  `pending_path` and flips a status.
- A **demoted `SCHED_OTHER` worker thread** (started in `create_instance`, pinned
  off core 3) does the file read + decode + `malloc`.
- The worker publishes the decoded sample to the audio thread with a single
  `__atomic` pointer store. The previous buffer is **retired, not freed** — it's
  released one reload later, plus the worker stops the slot's voice and sleeps
  past two audio blocks before swapping, so a voice can never read a freed
  buffer (spec §14.3, §21.8).

This matters for Kit Builder specifically because **Assign pushes 16 slot changes
at once, repeatedly, while pads are being hit** — exactly the §21.8 stress test.

### Decode: WAV + AIFF, format sniffed by magic bytes
- WAV: PCM 8/16/24/32-bit + IEEE float, mono/stereo, `WAVE_FORMAT_EXTENSIBLE`.
- AIFF/AIFC: big-endian PCM 8/16/24/32, 80-bit extended sample rate, `sowt`
  (little-endian) variant. Real AIFC compression is rejected.
- Dispatch is by `RIFF`/`FORM` magic, not the file extension.

### Load-time resample to 44.1 kHz interleaved int16, stereo preserved
Any source rate is linear-resampled to 44.1 kHz **once at load**, and playback is
a plain integer advance. MrDrums instead keeps the native rate and resamples
per-sample in `render_block` — which buys per-pad `tune`, but Rev. 2 cut tune
from Kit Builder (§2.2), so we take the cheaper per-frame path. Stereo source
files keep their image (mono float and stereo int16 cost the same 4 bytes/frame).
Per-slot length is capped (`MAX_SLOT_SECONDS`, currently **5 s**) so a stray
ambient sample can't hog memory or ring past the point of use (spec §25).

### Float mix bus + one clip per block + anti-click ramps
Added after the MrDrums review:

- Voices sum into a stack `float` buffer; the block is converted to int16 **once**,
  with a `tanh` soft-knee above 0.95 full-scale. A per-voice int16 clamp (the
  original approach) compounds into audible crunch when 16 pads are loaded and
  played fast.
- A ~1 ms position-derived **fade-in** on every note-on (also softens a
  retrigger) and a ~5 ms **fade-out** over the sample's tail, so a chopped
  one-shot never hard-cuts. Both are derived from playback position — no extra
  voice state.

### Bugs found and fixed
- 24-bit WAV was scaled 256× too hot (`/256` where it needed `/65536`) —
  distorted 24-bit packs only.

---

## Comparison with MrDrums (`handcraftedcc/schwung-mrdrums`)

MrDrums is the reference drum instrument Kit Builder exports to (Stage 6). Its
DSP was reviewed to sanity-check ours.

| Axis | **Kit Builder** | **MrDrums** |
|---|---|---|
| Voices | 1 / pad, hard retrigger (§14.4 fallback) | 64-voice pool, steal oldest by age |
| Sample store | int16, **stereo kept**, resampled to 44.1 k **at load** | float **mono downmix**, native rate kept, resampled **per sample in render** |
| Mix bus | float sum, **one soft-clip per block** | float L/R, `tanh` soft-clip, one conversion |
| Envelope | ~1 ms attack + ~5 ms tail release (anti-click only) | per-pad attack + decay/release ms, gate vs one-shot |
| Sample loading | **off-thread worker + atomic pointer swap + retired buffer** | **synchronous in `set_param`** — `fopen`/`fread`/`malloc`/`free` on the audio thread |
| Per-block alloc | none (stack buffer) | `std::vector<float>` heap alloc every `render_block` |
| Formats | WAV + AIFF, sniffed by magic bytes | WAV + AIFF, dispatched by extension |
| Extras | — | choke groups, pan, tune, velocity curves, humanize, per-hit random, chance % |
| `get_error` | terse `slot_status` char array | human-readable last-error string |

### Where we deliberately differ, and why

- **Async loader vs synchronous load.** MrDrums decodes and frees on the audio
  thread inside `set_param` — the exact pattern `plugin_api_v1.h` and
  `REALTIME_SAFETY.md` call out as the #1 mistake (78 ms file-I/O spikes; a
  `free()` racing a playing voice). It ships fine because a user picks a file
  *rarely*. Kit Builder's Assign rewrites all 16 slots at once, repeatedly,
  during play, so we pay for the worker thread + atomic handoff.
- **No per-block allocation.** MrDrums `new[]`s its float mix buffers every
  `render_block`; ours are on the stack.
- **1 voice/pad vs 64-voice pool.** Spec-sanctioned simplification; revisit if
  roll realism is wanted.
- **Load-time resample, stereo kept.** We don't need `tune`, so we avoid the
  per-frame interpolation cost and keep stereo at no memory penalty.
- **No pan / tune / choke / humanize / chance.** Rev. 2 removed all of these
  from Kit Builder's scope (§2.2, §3, decision 3). Kit Builder's player "exists
  only to audition the generated kit" (§14.1) — it is not trying to be MrDrums.

### What we adopted from the review
Float mix bus, single soft-clip per block, and the attack/tail-release
anti-click ramps.

### Rough cost comparison (reasoned, not benchmarked on device)
Per 128-frame block (~2.9 ms, ~900 µs SPI budget): ours is ≤16 voices with no
interpolation and no allocation; MrDrums is up to 64 voices with per-sample
linear interpolation plus a heap allocation. Steady-state we're materially
lighter; on the load path MrDrums can spike the audio thread and we can't.

---

## Storage (`src/core/storage.mjs`, `validation.mjs`)

- Native working file: `KitBuilder/Kits/<name>.kitbuilder.json` (spec §15.1); a
  copy is also written to `KitBuilder/current-kit.json` for diagnostics (§15.2,
  **not** auto-loaded — §3.1 decision 6).
- **Atomic-ish write** (§15.5): serialize → temp file → read back + `JSON.parse`
  to validate → rename to final. `os.rename` isn't attested in the Schwung JS
  runtime (only `os.remove` is used anywhere in-repo), so there's a
  `host_write_file(final)` fallback. Not a hard atomic guarantee, but the final
  path is only touched after the temp validates, so an existing good file
  survives a failed save.
- **Filename sanitisation** (§15.6): strip control chars and `/` `\`, collapse
  `..`, replace `<>:"|?*` with `_`, trim, fall back to `Kit Builder`; append
  ` (2)`, ` (3)` … rather than overwrite.
- **Generated name** (§3.3.1): `Kit Builder <NNN> <YYYY-MM-DD>`, `NNN` from
  `config.json:next_kit_number`, incremented **only after a successful save**.
- **Load + validate** is a storage-layer function exercised by
  `tests/test_storage.js` — there is no in-UI browse/reload path in the MVP
  (§2.2), which is a deliberate trade-off (§3.1).
- **Missing samples don't block a load** (§8.6, §21.6): `markMissingSamples()`
  flags affected pads without dropping them.

### Revisions after Stage 5 testing (Sam's feedback)

- **Kit keeps one file across a session.** The counter only advances on the
  *first* Save; subsequent Saves overwrite `<name>.kitbuilder.json`. A name
  change is a "save as". `ui.js` tracks `currentKitName`; `New` clears it.
- **Restore-on-relaunch replaces "always blank" (§3.1 decision 6).** The
  working kit is persisted to `current-kit.json` on every mutating action and
  in `onUnload`, and loaded back in `init()`. Rationale: losing an unsaved
  layout on a Back-exit was worse than the spec's tidiness argument. `New` is
  the deliberate path to a blank kit (two-press confirm, since it's
  destructive). The spec's §21.6 persistence tests are unaffected — they still
  exercise the storage layer directly.
- **`mute` param on the DSP.** The shim delivers pad notes straight to
  `overtake_dsp->on_midi`, bypassing JS, so opening the Save keyboard couldn't
  silence the pads from the UI side. Added `set_param("mute", "1"|"0")` — while
  muted the DSP drops new note-ons (ringing voices finish). `ui.js` mutes for
  the duration of any text entry.
- **Step buttons 1..N = RANDOM action shortcuts.** Colour-coded to the action
  (green/blue/amber/red/white). Single press = select + jump to RANDOM; second
  press within 400 ms = fire. This is the manual precursor to the §28 post-MVP
  sequencer, where the Record/Sample button will flip the step row between
  "action shortcuts" and "pattern input".

## MrDrums export (`src/exporters/mrdrums_json.mjs`)

### The "MrDrums-compatible JSON" is an Ableton drum-rack `.ablpreset`

The spec (§16, §1) assumed MrDrums had a bespoke JSON kit format. It doesn't.
The shipping MrDrums (`handcraftedcc/schwung-mrdrums`, `src/dsp/mrdrums_plugin.cpp
:: load_preset`) loads an **Ableton native drum-rack preset** — the same
`.ablpreset` / `.json` shape Move's own drum racks use — via
`set_param("ui_preset_path", <path>)`. It walks:

```
instrumentRack → chains[0].devices[0] (kind:"drumRack") → drumRack.chains[]
```

one chain per pad, keyed by `drumZoneSettings.receivingNote` (36–51 ⇒ pads
1–16), with the sample in `devices[0].deviceData.sampleUri` and gain/pan/etc.
in `devices[0].parameters`. So Stage 6 emits that format. §2.2 defers
`.ablpreset` *generation for Ableton itself*; a `.ablpresetbundle`
(sample-copying) exporter was considered and dropped in Rev. 3 (inbound
format — see spec §1). We produce the drum-rack JSON MrDrums reads and
reference samples in place.

### Mappings (verified against the MrDrums loader, not invented — §16.3)

| Kit Builder | `.ablpreset` field | Note |
|---|---|---|
| pad _n_ | `drumZoneSettings.receivingNote` = 35 + _n_ | MrDrums: `pad_index = note - 35` |
| `playback.gain` | `parameters.Volume` (dB) | MrDrums: `gain = 10^((dB+12)/20)`, so **gain 1.0 ⇒ −12.0 dB**; we invert: `dB = 20·log10(gain) − 12` |
| `sample.ableton_uri` | `deviceData.sampleUri` | `ableton:/user-library/<rel>` with each path segment `encodeURIComponent`-d |
| (no pan/tune/choke — Rev. 2) | `Pan` 0, `Voice_Transpose` 0, `chokeGroup` null, `Voice_Envelope_*` at MrDrums defaults | emitted explicitly so the file is self-describing |
| empty pad | *no chain* | matches a real Ableton drum rack and MrDrums's own fixtures; an all-empty kit is refused (MrDrums needs ≥1 mapped cell) |

**Percent-encoding is load-bearing.** MrDrums `url_decode` turns a bare `+`
into a space and decodes `%XX`, so a sample whose name contains `+` or `%`
*must* be encoded or MrDrums opens the wrong path. `encodeURIComponent` per
path segment covers spaces, `+`, `%` and non-ASCII (UTF-8); `/` stays a
separator.

### Where and how

- Written to Move's `Track Presets/<name>.ablpreset` (§15.4 — location confirmed 2026-09-09). Verified
  there is **no fixed kit directory** — MrDrums exposes `ui_preset_path` as a
  browse-to-any-file param, so the user opens MrDrums and picks the export.
- **A Save triggers the export** (§3.3); an export failure is reported
  (`"Kit saved, MrDrums export failed"`, §17.3) but never touches the
  `.kitbuilder.json` (§16.5).
- `exportKit()` is pure (caller supplies `write`); it re-parses its own output
  and checks the chain count before returning ok (§16.5). Matches the
  `exportKit(kit, options)` shape reserved in §24.
- **Not verifiable off-device:** an actual round-trip *load* in MrDrums
  (Stage 6 exit criterion) needs the hardware — load MrDrums, browse to the
  export, play it.
