# Kit Builder MVP Technical Specification

**Document status:** Draft for implementation (Revision 3)
**Target platform:** Ableton Move running Schwung
**Module type:** Standalone Overtake-style Tool
**Working name:** Kit Builder *(renamed from "Kit Forge" in Revision 2)*
**Initial release:** v0.1.0 MVP

## Revision history

**Revision 2 — 2026-09-08.** Reviewed against the original Copilot-drafted spec and revised with the following decisions:

1. Renamed the module from "Kit Forge" to "Kit Builder" throughout (identifiers, paths, file extensions, log names).
2. Internal audition player confirmed as necessary scope, not redundant with MrDrums — see §14.1. MrDrums is not guaranteed to be loaded when Kit Builder (a standalone Tool module) is active, so Kit Builder cannot rely on triggering MrDrums's engine for preview.
3. Pad playback model simplified: `gain` only. `pan`, `tune_semitones` and `choke_group` are dropped from the MVP data model, export, and UI (including hat choke behaviour). See §6.2, §6.3, §13.3, §14.2, §16.2, §16.4, §2.2.
4. Random-assignment pad-processing order fixed at ascending pad number (1–16) as part of the deterministic seed contract. Pool-fairness within shared-pool roles (e.g. "Other") is noted as a candidate for revisit once pad rules are developed further. See §10.2, §10.6.
5. Folder-classification tie-break rule made explicit: deepest matching directory component wins. See §7.2.
6. Startup behaviour changed: Kit Builder always opens a blank kit, rather than auto-loading the most recently edited kit. See §3.1 for the consequence this has on reload access, and §15.2/§21.6/Stage 5 for how this is reconciled with persistence testing.
7. Generated kit name format defined explicitly: counter + date. See §3.3.1.
8. Assign (and other momentary actions) now explicitly ignore reactivation while a previous invocation is still in flight, rather than queuing or restarting it. See §10.7, §13.5.

**Revision 3 — 2026-09-10.** Category / pad model reworked, adopting the vocabulary and pad layout of github.com/klingklangmatze/drum-kit-generator:

1. **Classification vocabulary expanded** from 8 to 22 categories: `kick snare rim clap hat closed_hat open_hat tom conga percussion crash ride cymbal fx vox bass synth stab chord lead pad other`. Folder aliases only — a category no longer implies a pad. See §7.1, §7.2.
2. **Pad placement moved to `config.pad_layout`** — an array of 16 category lists. Each pad draws from the **union** of its list, picked uniformly. `role_rules[*].pads` and `role_rules[*].fallback_roles` are removed; there is no fallback chain — an empty pool leaves the pad empty (§10.3 unchanged). See §7.4, §10.2.
3. **The `["other"]` layout sentinel** expands to every category with no dedicated pad slot (the melodic set `vox bass synth stab chord lead pad` plus `other`), **plus `fx`** — so `fx` sits on pad 12 *and* can land on the catch-all pads 13–16. See §7.4.
4. **`pad.role`** is retained for display/compat and holds the pad's *primary* category (first in its pool). Older kits load unchanged.
5. **SYSTEM page** shows 8 grouped buckets (Kick / Snr / Clap / Hats / Tom / Perc / Cym / FX) plus a combined Other, in a scrollable list. See §13.4.

**Rev. 3.x — 2026-09-10.** Follow-ups from device testing:

6. **Filename fallback for classification** — `classify_filenames` (default on): a token-exact keyword match on the file's own name when the folder path classifies it as `other`. Folder still wins. See §7.2.
7. **MPC `.xpm` sample names** are the source file's own basename (was `<kit>-<NN>-<name>`). See §16 / `mpc_xpm.mjs`.

---

## 1. Purpose

Kit Builder is a standalone Schwung tool for rapidly constructing, auditioning, refining and saving 16-pad drum kits.

The MVP will:

- Discover drum samples stored in the Move User Library.
- Categorise samples using configurable folder rules.
- Randomly assign samples to a 16-pad layout.
- Allow individual pads to be locked against further randomisation.
- Play assigned samples directly from the Move pads.
- Save Kit Builder project files.
- Export kits in a MrDrums-compatible JSON format.

Move `.ablpreset` and Akai MPC export are explicitly deferred until the core workflow is proven. *(Rev. 3: a `.ablpresetbundle` exporter was considered and dropped — it is an inbound/import format; a kit leaving Move with samples is Move's native `.ablbundle` drum-rack save.)*

## 2. Product boundaries

### 2.1 Included in the MVP

1. Standalone Kit Builder Schwung module.
2. Full control of Move's 4×4 pad grid.
3. User Library sample discovery.
4. Configurable sample-folder classification.
5. Random assignment by pad role.
6. Pad auditioning.
7. Shift + Pad locking.
8. Duplicate-sample prevention within the current kit.
9. Clearing unlocked pads.
10. Unlock All function.
11. Kit naming.
12. Save of Kit Builder working files.
13. MrDrums-compatible JSON export.
14. Basic sample playback using a lightweight internal 16-pad player.
15. Pad-state LED feedback.
16. Clear user feedback when samples or folders cannot be found.

### 2.2 Excluded from the MVP

The following are outside the first release, but planned for future releases:

- Direct `.ablpreset` generation.
- Core Library sample scanning.
- Akai MPC `.xpm` export.
- Audio analysis or machine-learning classification.
- Waveform display.
- Automatic loudness matching.
- Per-pad sample editing.
- Start, end, or filter/envelope controls.
- **Pan, tune and choke-group control per pad, including hat choke behaviour** *(new in Rev. 2 — see decision 3)*.
- In-tool file browsing, and by extension, reloading a previously saved kit from the UI *(see decision 6)*.
- Copying sample audio into exported folders.
- Loading native Ableton presets.
- Editing existing MrDrums kits.

These features may be added after the MVP architecture and hardware workflow have been validated.

## 3. Primary user workflow

### 3.1 Starting Kit Builder

When Kit Builder opens:

1. The module loads its saved configuration.
2. It checks for an existing sample index.
3. It validates whether the configured User Library sample root exists.
4. It opens a new, empty 16-pad kit.
5. Pad LEDs show the current state of each pad (all empty and unlocked).

> **Note (decision 6):** Earlier drafts had Kit Builder auto-load the most recently edited kit at startup. That's removed — every session now starts blank. Because in-tool file browsing is also excluded from the MVP (§2.2), there is currently **no UI path to bring a previously saved kit back into Kit Builder**. Save still writes a working file to disk (§15.1) and nothing is lost, but recovering it requires a future release with kit browsing/loading. This is a deliberate MVP trade-off, not an oversight — flagging it here so it's a conscious call rather than a surprise later.

The default sample root is:

```
/data/UserData/UserLibrary/Samples
```

### 3.2 Building a kit

1. User opens the Random page.
2. User presses the Assign button.
3. Kit Builder selects samples according to the configured pad rules.
4. Selected samples are loaded into the internal player.
5. Assigned pads turn green.
6. User presses pads to audition the kit.
7. User presses Shift + Pad to lock satisfactory sounds.
8. Locked pads turn white.
9. User presses Assign again.
10. Only unlocked pads receive new samples.
11. Process repeats until the user is satisfied.

### 3.3 Saving a kit

1. User selects Save.
2. User enters or accepts a generated kit name.
3. Kit Builder saves its native working file.
4. Kit Builder creates a MrDrums-compatible JSON export.
5. The module displays success or failure feedback.

#### 3.3.1 Generated kit name format *(new in Rev. 2 — decision 7)*

The suggested kit name is generated as:

```
Kit Builder <counter> <date>
```

e.g. `Kit Builder 007 2026-09-08`

- `<counter>` is a persistent integer (`next_kit_number`) stored in `config.json`, zero-padded to 3 digits, starting at 1.
- `<date>` is the current date as `YYYY-MM-DD`.
- The counter is read to build the suggested name, then incremented and persisted back to `config.json` **after** a successful save (an abandoned/never-saved kit does not consume a counter value).
- The user may accept or freely edit the suggested name before confirming Save; filename sanitisation rules (§15.6) still apply.

## 4. Module architecture

Kit Builder will be implemented as a standalone repository and installable Schwung module.

```
Kit Builder UI and Hardware Controller
  (knobs, pads, LEDs, display, Shift)
              │
              ▼
      Kit State Manager
     (pads, locks, names)
              │
   ┌──────────┼──────────────┐
   ▼          ▼              ▼
Sample     Assignment     Internal
Index       Engine       Drum Player
   │
   ▼
Storage and Export
(working kit + MrDrums JSON)
```

### 4.1 Architectural principles

- The internal kit model is the single source of truth.
- The UI must not directly manipulate export files.
- Filesystem paths and Ableton URIs are stored separately.
- Random assignment must not be part of the audio callback.
- File scanning must not occur in the audio callback.
- Saving and indexing must not block sample playback where avoidable.
- Exporters translate the internal model into destination formats.
- Future Ableton and MPC exporters must not require redesigning the core kit model.
- Unsupported or unknown metadata must be preserved wherever practical in later template-based exporters.

## 5. Proposed repository structure

```
schwung-kit-builder/
├── src/
│   ├── module.json
│   ├── help.json
│   ├── ui.js
│   ├── kit_config.json
│   ├── core/
│   │   ├── kit_model.js
│   │   ├── sample_index.js
│   │   ├── sample_classifier.js
│   │   ├── random_assign.js
│   │   ├── path_mapping.js
│   │   ├── storage.js
│   │   └── validation.js
│   ├── exporters/
│   │   └── mrdrums_json.js
│   └── dsp/
│       ├── kit_player.c
│       ├── kit_player.h
│       └── Makefile
├── config/
│   └── default_kit_config.json
├── scripts/
│   ├── build_kit_builder.sh
│   ├── package_release.sh
│   └── validate_release.sh
├── tests/
│   ├── fixtures/
│   ├── test_classifier.js
│   ├── test_assignment.js
│   ├── test_path_mapping.js
│   ├── test_storage.js
│   └── test_mrdrums_export.js
├── dist/
├── release.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

The final structure may need adjustment to match the exact Schwung Overtake module loading convention.

## 6. Internal kit data model

The internal data model must remain independent of Ableton and MPC file structures.

### 6.1 Kit object

```json
{
  "schema_version": 1,
  "application": "kit-builder",
  "kit_id": "8f63b39e-4ff6-4abd-83cb-cab54bf45e89",
  "name": "Kit Builder 001",
  "created_at": "2026-09-08T00:00:00Z",
  "modified_at": "2026-09-08T00:00:00Z",
  "source_mode": "user",
  "random_seed": 123456789,
  "prevent_duplicates": true,
  "pads": []
}
```

### 6.2 Pad object

Each kit contains exactly 16 pad objects. *(Rev. 2 — decision 3: `playback` simplified to `gain` only.)*

```json
{
  "pad": 1,
  "midi_note": 36,
  "role": "kick",
  "locked": false,
  "sample": {
    "filesystem_path": "/data/UserData/UserLibrary/Samples/Kick/Kick_012.wav",
    "ableton_uri": "ableton:/user-library/Samples/Kick/Kick_012.wav",
    "source": "user",
    "filename": "Kick_012.wav",
    "category": "kick"
  },
  "playback": {
    "gain": 1.0
  }
}
```

### 6.3 Empty pad representation

An empty pad uses `null` for its sample.

```json
{
  "pad": 8,
  "midi_note": 43,
  "role": "other",
  "locked": false,
  "sample": null,
  "playback": {
    "gain": 1.0
  }
}
```

### 6.4 MIDI note mapping

The default mapping is sequential: pad *n* → MIDI note 35 + *n* (pad 1 → 36 …
pad 16 → 51). It must be configurable if MrDrums uses a different pad-to-note
contract.

Each pad's default draw pool (`pad.role` = the pool's first category) is in
§7.4. In brief: 1 kick · 2 rim/snare · 3 snare · 4 clap/perc · 5 perc/tom/conga
· 6 hat · 7 closed_hat · 8 open_hat · 9 ride/cymbal/crash · 10 tom/perc/conga
· 11 perc · 12 fx · 13–16 Other.

## 7. Configuration model

Folder names must not be permanently hard-coded into the assignment engine.

### 7.1 Default configuration

*(Rev. 3 — `role_rules` entries now carry `folder_aliases` only; pad placement
is `pad_layout`, §7.4. `scan_filters` is Batch F. Abbreviated here — the
authoritative copy is `config/default_kit_config.json`.)*

```json
{
  "schema_version": 1,
  "sample_roots": {
    "user": "/data/UserData/UserLibrary/Samples",
    "core": "/data/CoreLibrary/Samples"
  },
  "supported_extensions": [".wav", ".aif", ".aiff"],
  "scan_filters": { "skip_loops": true, "max_sample_size": null },
  "role_rules": {
    "kick":       { "folder_aliases": ["kick", "kicks", "kck", "bd", "bass drum"] },
    "snare":      { "folder_aliases": ["snare", "snares", "snr", "sd"] },
    "rim":        { "folder_aliases": ["rim", "rimshot", "side stick"] },
    "clap":       { "folder_aliases": ["clap", "claps", "clp", "cp", "hand clap"] },
    "hat":        { "folder_aliases": ["hat", "hats", "hihat", "hh", "shaker"] },
    "closed_hat": { "folder_aliases": ["closed hat", "closed hihat", "ch", "chh"] },
    "open_hat":   { "folder_aliases": ["open hat", "open hihat", "oh", "ohh"] },
    "tom":        { "folder_aliases": ["tom", "toms", "floor", "rack"] },
    "conga":      { "folder_aliases": ["conga", "congas"] },
    "percussion": { "folder_aliases": ["percussion", "perc", "tambourine", "cowbell", "bongo", "shaker", "..."] },
    "crash":      { "folder_aliases": ["crash", "crashes"] },
    "ride":       { "folder_aliases": ["ride", "rides"] },
    "cymbal":     { "folder_aliases": ["cymbal", "cymbals", "cym"] },
    "fx":         { "folder_aliases": ["fx", "sfx", "noise", "impact", "riser", "sweep", "hit", "..."] },
    "vox":        { "folder_aliases": ["vox", "vocal", "voice", "chant", "choir"] },
    "bass":       { "folder_aliases": ["bass", "sub"] },
    "synth":      { "folder_aliases": ["synth", "synthesizer", "analog"] },
    "stab":       { "folder_aliases": ["stab", "chord hit"] },
    "chord":      { "folder_aliases": ["chord", "chords"] },
    "lead":       { "folder_aliases": ["lead", "melody", "melodic"] },
    "pad":        { "folder_aliases": ["pad", "atmosphere", "ambient", "texture", "strings", "keys", "piano", "..."] },
    "other":      { "folder_aliases": ["other"], "exclude_recognised_role_folders": true }
  },
  "pad_layout": [
    ["kick"], ["rim", "snare"], ["snare"], ["clap", "percussion"],
    ["percussion", "tom", "conga"], ["hat"], ["closed_hat"], ["open_hat"],
    ["ride", "cymbal", "crash"], ["tom", "percussion", "conga"], ["percussion"], ["fx"],
    ["other"], ["other"], ["other"], ["other"]
  ]
}
```

### 7.2 Folder matching rules

Folder matching must:

- Be case-insensitive.
- Ignore leading and trailing whitespace.
- Treat spaces, underscores and hyphens as equivalent.
- Match any directory component, not only the immediate parent.
- **When a sample's path matches multiple category aliases at different directory depths, the deepest (most nested) matching directory component wins** *(made explicit in Rev. 2 — decision 5; e.g. `/Percussion/Closed Hat/tick.wav` classifies as `closed_hat`, not `percussion`)*.
- Assign one primary category per sample.
- Preserve the original path and filename.

For example, each of these should classify as `open_hat`:

```
/Open Hat/OH_01.wav
/open_hats/hat_02.wav
/Drums/Open-Hat/sample.wav
/OPEN_HIHAT/hihat.wav
```

**Filename fallback** *(Rev. 3.x — config `classify_filenames`, default on)*: when
the folder path yields no category, the file's own name is tokenised
(separators, camelCase and letter/digit boundaries → lowercase tokens) and
matched against the same alias index — contiguous joins of up to 3 tokens,
longest window first, first hit wins. Token-exact (no substrings, so
`bassline.wav` is **not** `bass`). Folder structure always wins over the
filename. `classifyFilename()` in `sample_classifier.mjs`.

### 7.3 Other category

The Other candidate pool (the `["other"]` `pad_layout` sentinel) is:

> Every classification category that no pad's `pad_layout` entry names — the melodic set `vox bass synth stab chord lead pad` and `other` itself — **plus `fx`** (Rev. 3 decision 3: `fx` has its own pad 12 but also feeds the catch-all pads).

A sample must not be placed in a category's pool merely because it is stored in a nested subfolder beneath a recognised category folder (deepest-match rule, §7.2).

### 7.4 Pad layout (Rev. 3)

`config.pad_layout` is an array of 16 entries; entry *i* is the list of
classification categories pad *i*+1 draws from. Assignment pools the **union**
of those categories and picks uniformly (no weighting between categories, no
ordering preference). There is no fallback chain: if the union is empty the
pad is left unresolved (§10.3).

| Pad | Pool |
|-----|------|
| 1 | kick |
| 2 | rim, snare |
| 3 | snare |
| 4 | clap, percussion |
| 5 | percussion, tom, conga |
| 6 | hat |
| 7 | closed_hat |
| 8 | open_hat |
| 9 | ride, cymbal, crash |
| 10 | tom, percussion, conga |
| 11 | percussion |
| 12 | fx |
| 13–16 | Other (§7.3) |

`pad.role` in the kit model holds the pool's first category, for display only.

## 8. Sample index

### 8.1 Purpose

The sample index prevents a complete recursive filesystem scan every time the user presses Assign.

### 8.2 Index record

```json
{
  "filesystem_path": "/data/UserData/UserLibrary/Samples/Kick/Kick_012.wav",
  "ableton_uri": "ableton:/user-library/Samples/Kick/Kick_012.wav",
  "source": "user",
  "category": "kick",
  "filename": "Kick_012.wav",
  "extension": ".wav",
  "size_bytes": 582144,
  "modified_time": 1788738123
}
```

### 8.3 Index file

Suggested location: `/data/UserData/UserLibrary/KitBuilder/.sample-index.json`

### 8.4 Index creation

The indexer must:

1. Confirm that the sample root exists.
2. Recursively inspect all subdirectories.
3. Ignore unsupported file extensions.
4. Ignore hidden files and temporary files.
5. Normalise paths without changing filename case.
6. Classify each sample.
7. Generate its Ableton URI.
8. Store size and modification time.
9. Write the completed index atomically.

### 8.5 Atomic write requirement

The index must first be written to a temporary file (`.sample-index.json.tmp`). After successful serialization and validation, it is renamed to `.sample-index.json`. A failed or interrupted scan must not overwrite the previous valid index.

### 8.6 Refresh behaviour

The MVP Random page will include a Rescan action. Automatic filesystem change detection is not required for v0.1.0.

A rescan must not remove samples from the currently loaded kit. If a loaded sample no longer exists, the relevant pad must be marked as missing.

## 9. Filesystem-to-URI mapping

URI translation must be handled by a dedicated path-mapping component.

### 9.1 User Library conversion

`/data/UserData/UserLibrary/Samples/Kick/Kick01.wav` converts to `ableton:/user-library/Samples/Kick/Kick01.wav`

### 9.2 Core Library conversion

Core Library support is not enabled in the MVP, but the mapping function should be prepared for:

`/data/CoreLibrary/Samples/Drums/Kick01.wav` converting to `ableton:/packs/abl-core-library/Samples/Drums/Kick01.wav`

### 9.3 Mapping requirements

The path mapper must:

- Reject paths outside known roots.
- Preserve filename and directory case.
- Convert filesystem separators to `/`.
- Avoid duplicate slashes.
- Correctly handle spaces.
- Prevent `..` traversal.
- Return both a value and an error state.
- Never guess a URI for an unknown root.

## 10. Random assignment engine

### 10.1 Input

- Current kit.
- Sample index.
- Selected source.
- Pad role configuration.
- Duplicate-prevention setting.
- Random seed.
- Optional recent-selection history.

### 10.2 Core algorithm

1. Copy the current kit into a proposed working state.
2. Determine which pads are unlocked.
3. Process unlocked pads **in ascending pad-number order (1→16)** *(made explicit in Rev. 2 — decision 4)*. For each: build its candidate pool as the **union** of every category in that pad's `pad_layout` entry (§7.4), expanding the `["other"]` sentinel per §7.3.
4. Remove missing or invalid sample records from the pool.
5. Remove the pad's current sample from the pool where another candidate exists.
6. Remove samples already assigned elsewhere in this pass when duplicate prevention is enabled.
7. *(Rev. 3 — no fallback chain. If the union pool is empty the pad is unresolved, §10.3.)*
8. Select one candidate using the seeded random generator.
9. Assign the candidate to the proposed pad.
10. Continue until all unlocked pads have been processed.
11. Validate the proposed kit.
12. Commit the complete proposed state.
13. Send changed sample assignments to the player.
14. Update LEDs and user feedback.

### 10.3 Assignment transaction

Assignment must behave as a transaction. If a single role has no candidates, Kit Builder should not discard successful assignments for other roles. Instead:

- Successfully resolved pads are updated.
- Unresolved pads retain their current sample.
- Empty unresolved pads remain empty.
- A warning identifies unresolved pad roles.
- The kit remains valid and playable.

### 10.4 Duplicate prevention

Duplicate prevention is enabled by default. When enabled:

- The same sample cannot be assigned to more than one pad during the assignment pass.
- Samples on locked pads are considered already used.
- Existing samples on unlocked pads may be replaced.
- If a pad's union pool is too small, duplicate prevention may be relaxed for that pad after all unique candidates are exhausted.
- Any relaxation must be reported to the user.

### 10.5 Avoid immediate reselection

The current sample assigned to an unlocked pad should be removed from that pad's candidate pool when alternatives exist. If it is the only eligible candidate, it may remain assigned.

### 10.6 Seeded random generator

The random assignment engine should support a stored integer seed. The same sample index, configuration, pad lock state, source selection, random seed, **and pad-processing order** should produce the same assignment result.

The seed may be generated automatically for each Assign press in the MVP. It must still be stored within the kit for diagnostics and future repeatability.

> **Note (Rev. 2 — decision 4):** Because pads are always resolved in ascending order, pads sharing a pool (e.g. the four Other pads 13–16, or percussion on pads 4/5/10/11) resolve the lowest-numbered first, giving it first pick of duplicate-avoided candidates — later pads sharing that pool are more likely to hit the duplicate relaxation in §10.4. This is an accepted simplification. Revisiting pool fairness (e.g. randomising resolution order among pads that share a pool) is expected once pad rules are developed further with real libraries in use.

### 10.7 Reentrancy *(new in Rev. 2 — decision 8)*

Assign must ignore a new activation while a previous Assign pass is still in flight (index lookups, candidate-pool building, or player hand-off not yet complete). The button does not queue repeated presses or restart the in-flight pass — the new press is simply dropped. This applies to every momentary action in §13.5 (Assign, Clear, Unlock All, Rescan, Save, Clear Pad), not only Assign.

## 11. Pad interaction

### 11.1 Normal pad press

Pressing an assigned pad:

- Triggers the corresponding sample.
- Uses the pad velocity if supplied by the hardware.
- Briefly increases the pad LED brightness.
- Does not change the lock state.

Pressing an empty pad:

- Produces no sound.
- Briefly displays "No sample."
- Does not trigger an error state.

### 11.2 Shift + Pad

Pressing Shift + Pad:

- Toggles the selected pad's lock state.
- Does not trigger the sample.
- Updates the pad LED immediately.
- Updates the unsaved working state.

### 11.3 Lock semantics

A locked pad:

- Is excluded from Assign.
- Is excluded from Clear.
- Keeps its sample when another source is selected.
- Remains playable.
- Can be unlocked with Shift + Pad.
- Is included in duplicate-prevention checks.

Locking an empty pad is permitted. This allows users to intentionally preserve an empty slot.

## 12. Pad LED specification

| State | LED style | Meaning |
|---|---|---|
| Empty and unlocked | Dim blue-teal | Available for assignment |
| Assigned and unlocked | Green | Loaded and replaceable |
| Empty and locked | Dim white | Empty pad protected |
| Assigned and locked | White | Loaded pad protected |
| Currently sounding | Bright version of state colour | Pad is auditioning |
| Missing sample | Amber | Saved path cannot be loaded |
| Assignment failure | Temporary red flash | No eligible sample found |
| Fatal player error | Red | Sample player failed |

### 12.1 LED priority

If multiple states apply, LED priority is (highest first): Fatal error → Missing sample → Currently sounding → Locked → Assigned → Empty.

A temporary assignment-failure flash may override the normal state for a brief period before returning to the persistent state.

## 13. User interface

### 13.1 Page structure

The MVP should contain three pages: Random, Kit, System.

### 13.2 Random page

| Encoder | Control | Type | MVP behaviour |
|---|---|---|---|
| 1 | Assign | Button | Randomise all unlocked pads |
| 2 | Source | Enum | User Library only in MVP |
| 3 | Duplicates | Enum | Avoid or Allow |
| 4 | Clear | Button | Clear all unlocked pads |
| 5 | Unlock All | Button | Unlock all 16 pads |
| 6 | Rescan | Button | Rebuild sample index |
| 7 | Save | Button | Save native and MrDrums kit |
| 8 | Kit | Display/action | Show or edit kit name |

Even though Source has only one active MVP option, it should use an enum-compatible representation so Core Library and Both can be added later without changing the parameter identity.

### 13.3 Kit page

The Kit page provides status rather than deep per-pad editing. *(Rev. 2 — decision 3: Pan and Tune encoders removed; Gain retained as reserved.)*

| Encoder | Control | Behaviour |
|---|---|---|
| 1 | Selected Pad | Select pad 1 to 16 |
| 2 | Role | Display assigned role |
| 3 | Sample | Display shortened filename |
| 4 | Lock | Toggle selected pad lock |
| 5 | Gain | Reserved, fixed at 0 dB in MVP |
| 6 | Clear Pad | Clear selected pad if unlocked |
| 7–8 | — | Unused / reserved for future per-pad controls |

Reserved controls may be omitted if Schwung does not support cleanly displaying inactive parameters.

### 13.4 System page

Read-only index report plus two live controls (Batch F):

- **Knob 1** — loop filter (skip / keep); **Knob 2** — max sample size
  (Off / 1M / 2M / 5M / 10M). Both persist to `config.json` `scan_filters`
  and take effect on the next Rescan.
- **Jog-press** — Rescan (chunked recursive scan; §10.7 reentrancy applies).

Displayed: `Idx` (total indexed) · `Cut nL nB` (loop / oversize skipped) ·
`Loop` / `Max` (current filter state) · `Age` (last scan) · `Src` (source
mode) · and the **8 category buckets** — Kick, Snr (snare+rim), Clap, Hats
(hat+closed_hat+open_hat), Tom (tom+conga), Perc, Cym (crash+ride+cymbal), FX
— plus **Other** (the melodic categories + unclassified).

### 13.5 Button implementation

Assign, Clear, Unlock All, Rescan, Save and Clear Pad must be implemented as momentary button widgets. They must not use enum-square widgets and must not behave as persistent Boolean toggles.

Each button action should fire once per completed button press or parameter activation, and — per §10.7 — must ignore reactivation while its own previous invocation is still in flight.

## 14. Internal drum player

### 14.1 Purpose

The internal player exists only to audition the generated kit. It is not intended to replace MrDrums.

> **Architectural decision (Rev. 2 — decision 2):** This was reviewed against the alternative of having Kit Builder trigger MrDrums's own playback engine for preview, rather than building a second player. That alternative doesn't hold up: Kit Builder is a standalone Tool module, and MrDrums is not guaranteed to be loaded while it's active. Building an internal player is therefore necessary scope, not duplicated effort — but it does mean the "Sample decoding" risk in §25 is real engineering work, not a formality.

### 14.2 Minimum capabilities

The player must support:

- 16 independently assigned sample slots.
- MIDI notes 36 to 51.
- WAV loading.
- AIFF loading if supported by the selected decoder.
- Velocity-sensitive amplitude.
- One-shot playback.
- Overlapping playback between different pads.
- Safe sample replacement.
- Voice termination and cleanup.
- Sample-load error reporting to the UI.

### 14.3 Real-time constraints

The audio callback must not: scan directories, open files, parse JSON, allocate large memory blocks, save files, create exports, or perform blocking locks.

Samples should be loaded and decoded outside the audio callback, then safely handed to the player.

### 14.4 Voice design

The MVP should initially support at least one active voice per pad. A preferred implementation supports a small global voice pool so repeated pad strikes can overlap. If implementation risk is high, voice retriggering may replace the previous voice for the same pad in v0.1.0.

## 15. Storage

### 15.1 Kit Builder working files

Suggested directory: `/data/UserData/UserLibrary/KitBuilder/Kits`

Suggested filename: `Kit Builder 001.kitbuilder.json`

### 15.2 Current state

The most recently edited state may still be stored as `/data/UserData/UserLibrary/KitBuilder/current-kit.json` for diagnostics and forward compatibility, but — per the decision 6 startup change in §3.1 — **it is not read back automatically at startup in the MVP.**

### 15.3 Configuration

User-editable configuration may be stored as `/data/UserData/UserLibrary/KitBuilder/config.json`. This is also where the kit-naming counter (`next_kit_number`, §3.3.1) lives.

### 15.4 Export directory

MrDrums exports are written to Move's `/data/UserData/UserLibrary/Track Presets` folder so the exported `.ablpreset` appears in Move's own preset browser and loads straight into MrDrums (`ui_preset_path` is a browse-any-file parameter — there is no fixed kit directory). *(Location confirmed 2026-09-09.)*

### 15.5 Atomic saves

All JSON saves must: serialize to a temporary file → flush and close it → parse or validate it → rename it to the final destination → preserve the existing valid file if any step fails.

### 15.6 Filename sanitisation

Kit names used as filenames must:

- Remove `/` and `\`.
- Remove control characters.
- Remove path traversal sequences.
- Replace invalid filename characters with `_`.
- Trim leading and trailing spaces.
- Use a fallback name if the result is empty.
- Avoid silently overwriting an existing kit.

Suggested duplicate naming (kept as-is per Rev. 2 review — the `.json` vs `.kitbuilder.json` extension difference between this and §15.1 is accepted):

```
Kit Builder 001.json
Kit Builder 001 (2).json
Kit Builder 001 (3).json
```

## 16. MrDrums export

### 16.1 Export objective

The MVP will export a kit file that MrDrums can load without manually reassigning samples.

### 16.2 Export requirements

The exporter must include:

- Kit name.
- Pad number.
- MIDI note.
- Sample filesystem path.
- Sample URI if supported.
- Gain.
- Any mandatory MrDrums schema fields.
- A schema or format version where supported.

### 16.3 Export strategy

Before implementation, obtain and inspect:

1. A minimal valid MrDrums kit.
2. A complete 16-pad MrDrums kit.
3. A kit with at least one missing sample.
4. A kit using User Library samples.

The exporter should reproduce the real MrDrums schema rather than inventing an approximate format.

### 16.4 Example conceptual export

The exact property names remain subject to verification against MrDrums.

```json
{
  "name": "Kit Builder 001",
  "pads": [
    {
      "pad": 1,
      "note": 36,
      "sample": "/data/UserData/UserLibrary/Samples/Kick/Kick_012.wav",
      "gain": 1.0
    }
  ]
}
```

### 16.5 Export validation

After export, Kit Builder must:

- Confirm that exactly 16 pad records are present if required.
- Confirm that every assigned sample path is absolute and valid.
- Confirm that unassigned pads use the format expected by MrDrums.
- Parse the completed JSON.
- Report the final export path.
- Preserve the Kit Builder working file if MrDrums export fails.

## 17. Error handling

### 17.1 Recoverable errors

Sample root does not exist; no samples are indexed; a category has no eligible samples; a stored sample has been moved or deleted; a sample format cannot be decoded; an export filename already exists; a sample cannot be loaded; the cached index is malformed. These conditions should not crash or unload the module.

### 17.2 Fatal errors

Internal player initialization failure; kit state cannot be constructed; critical native module API mismatch; required storage directories cannot be created and no fallback is available; invalid internal schema that cannot be migrated. Fatal errors must show a concise user-facing message and record detailed diagnostic information.

### 17.3 User-facing messages

Recommended messages:

- "No User Library sample folder found"
- "No Kick samples found"
- "Assigned 14 pads, 2 categories unavailable"
- "Sample missing: Kick_012.wav"
- "Sample could not be loaded"
- "Sample index rebuilt: 2,438 files"
- "Kit saved"
- "Kit saved, MrDrums export failed"
- "All pads are locked"
- "No unlocked pads to clear"

## 18. Logging

Suggested log location: `/data/UserData/UserLibrary/KitBuilder/kit-builder.log`

Each entry should include: timestamp, severity, component, event, relevant pad or path, non-sensitive error details.

Example:

```
2026-09-08T00:13:41Z INFO index scan_complete samples=2438 duration_ms=1872
2026-09-08T00:14:02Z WARN assign empty_pool role=clap pad=3
2026-09-08T00:14:18Z ERROR player sample_load_failed pad=9 path=".../Texture01.wav"
```

Logging must not occur inside the real-time audio callback unless it uses a safe non-blocking mechanism. The MVP should use simple log rotation or truncate the file at a reasonable size to prevent unlimited growth.

## 19. Security and filesystem safety

Kit Builder must: treat sample paths as untrusted input; reject path traversal; never delete sample audio; never modify source sample files; restrict writes to Kit Builder and approved export directories; avoid shell execution for routine file operations; validate configuration paths before scanning; avoid following symbolic links outside allowed roots where possible; never overwrite Ableton system or Core Library files; treat the Core Library as read-only in future releases; preserve old kit files when migration or export fails.

The Clear operation must clear pad assignments only. It must never delete audio files.

## 20. Performance requirements

The MVP should target:

- Pad trigger response suitable for live auditioning.
- No audible glitch when pressing Assign after samples are loaded.
- No filesystem scanning in the audio thread.
- Assigning 16 pads in under one second after indexing.
- Smooth LED updates during playback.
- A sample index capable of handling at least 20,000 audio files.
- Memory release when kits are replaced or the module unloads.

Large samples should not all be decoded during index creation. Indexing should inspect filesystem metadata only.

## 21. Acceptance criteria

The MVP is complete when all mandatory acceptance tests pass.

### 21.1 Installation

- Kit Builder installs as a separate Schwung module.
- It appears under the appropriate Tool or Overtake category.
- Opening it displays its operational pages rather than a preset-only screen.
- All expected controls are visible and correctly typed.
- Button controls render and behave as momentary buttons.

### 21.2 Sample indexing

- The configured User Library sample root is recursively scanned.
- WAV files are indexed; AIF/AIFF indexed if supported; unsupported files ignored.
- Folder aliases are classified correctly, including the deepest-match tie-break rule (§7.2).
- Recognised drum folders are excluded from the Other pool.
- Rescan rebuilds the cache; a malformed cache can be recovered by rebuilding.

### 21.3 Assignment

- Assign populates every unlocked pad that has an eligible candidate, processed in ascending pad order (§10.2).
- Pad 1 selects from Kick; Pad 2 from Snare; Pad 3 from Clap; Pad 4 from Open Hat; Pad 5 from Closed Hat; Pad 6 from Percussion; Pad 7 from FX then configured fallbacks; Pads 8–16 from Other.
- Repeated Assign presses replace unlocked pads. Locked pads never change.
- Duplicate samples are avoided when sufficient alternatives exist.
- The current sample is not immediately reselected when alternatives exist.
- A second Assign press while one is already in flight is ignored (§10.7).

### 21.4 Pad control

- Assigned pads play their samples; velocity affects level.
- Shift + Pad toggles lock without playing the sample.
- Locked pads display white; assigned unlocked pads display green; empty unlocked pads display blue-teal; missing samples display amber.
- Active auditioning visibly flashes or brightens the pad.

### 21.5 Clear and unlock

- Clear removes samples from unlocked pads only, and does not affect locked pads.
- Unlock All removes all lock states.
- No source sample files are deleted.
- Locking an empty pad is supported.

### 21.6 Persistence

*(Rev. 2 note — decision 6: these criteria test the storage layer's correctness directly, not the absence of a UI reload/browse path, which is intentionally out of scope for the MVP — see §3.1 and §2.2.)*

- A kit can be saved.
- The storage layer can reload a previously saved working file with lock states, sample assignments and kit name intact, verified via test tooling even though the MVP UI does not auto-load or browse-load kits.
- Missing samples do not prevent the rest of the kit from loading.
- Interrupted writes do not corrupt the most recent valid file.

### 21.7 MrDrums export

- A valid MrDrums-compatible JSON file is produced; assigned pads load with the expected samples in MrDrums; empty pads behave correctly; pad note mapping is preserved.
- Export failure does not destroy the Kit Builder working file. The exported JSON can be parsed after writing.

### 21.8 Stability

- Fifty consecutive Assign operations do not crash the module, including presses that arrive while a previous Assign is still in flight (§10.7).
- Repeated pad triggering during Assign does not crash the player.
- Repeated kit loading does not cause unbounded memory growth.
- Missing and invalid sample files do not crash the module.
- Exiting and reopening Kit Builder restores a usable (blank) state.

## 22. Test fixture structure

A controlled test library should be created:

```
Samples/
├── Kick/
│   ├── kick_01.wav
│   └── kick_02.wav
├── Snare/
│   ├── snare_01.wav
│   └── snare_02.wav
├── Clap/
│   └── clap_01.wav
├── Open Hat/
│   └── open_hat_01.wav
├── Closed Hat/
│   └── closed_hat_01.wav
├── Percussion/
│   ├── perc_01.wav
│   └── perc_02.wav
├── FX/
│   └── fx_01.wav
├── Textures/
│   ├── texture_01.wav
│   └── texture_02.wav
└── Unsupported/
    ├── readme.txt
    └── preview.mp3
```

Tests should confirm: Textures samples enter the Other pool; recognised category samples do not enter the Other pool; MP3 and TXT files are ignored; folder aliases work with different case and separators (including the deepest-match tie-break); insufficient candidate pools are handled gracefully.

## 23. Implementation stages

### Stage 1: Reference validation

1. Confirm the Schwung Overtake module skeleton.
2. Confirm pad and Shift event access.
3. Confirm RGB pad LED control.
4. Confirm momentary button parameter definitions.
5. Confirm writable storage directories.
6. Inspect the latest MrDrums kit schema.
7. Confirm MrDrums MIDI note mapping.
8. Check the MrDrums licence and determine what code may be reused.

**Exit criterion:** A minimal module opens correctly, receives pad events, changes LED colours and displays a working button.

### Stage 2: Index and classification

Configuration loader; path normalisation; recursive User Library scan; extension filtering; folder-role classification (with deepest-match tie-break); path-to-URI conversion; cached sample index; Rescan action.

**Exit criterion:** The module reports reliable sample counts by category.

### Stage 3: Kit model and assignment

16-pad kit model; pad roles; lock state; seeded assignment with fixed ascending pad-processing order; duplicate prevention; current-sample exclusion; Clear and Unlock All; Assign reentrancy guard (§10.7).

**Exit criterion:** Repeated assignments produce valid internal kits while preserving locked pads.

### Stage 4: Audition player

Sample loading; 16 pad slots; note triggering; velocity scaling; LED audition feedback; safe assignment replacement.

**Exit criterion:** All 16 pads can be played reliably while assignments are repeatedly changed.

### Stage 5: Persistence

Native Kit Builder JSON; atomic save; load and validation (exercised via test tooling per §21.6); missing-sample handling.

**Exit criterion:** A saved kit's data survives serialization and reload through the storage layer, with assignments and locks intact — independent of whether the UI itself triggers that reload in the MVP.

### Stage 6: MrDrums export

Verified MrDrums schema; field mapping; export path; validation; round-trip testing in MrDrums.

**Exit criterion:** MrDrums loads and plays the exported 16-pad kit correctly.

### Stage 7: Packaging and release

Build script; release archive; `release.json`; README; installation instructions; known limitations; Schwung catalogue metadata.

**Exit criterion:** A clean installation from the release package works on Move.

## 24. Deferred exporter interfaces

The MVP architecture should reserve a common exporter interface: `exportKit(kit, options)`.

Each exporter should: validate the internal kit; check destination-specific requirements; convert internal paths and parameters; write atomically; validate the written output; return success, warnings, errors and destination paths.

Planned exporters: `mrdrums_json`, `ableton_ablpreset`, `akai_mpc_xpm`. *(An `ableton_ablpresetbundle` exporter was dropped in Rev. 3 — inbound/import format, see §1 / §2.2.)*

No Ableton-specific or MPC-specific fields should be added to the core pad model unless they represent genuine reusable pad properties.

## 25. Known technical risks

**High risk**

- *Schwung hardware ownership* — the exact method for taking control of all pads, Shift combinations and RGB states must be proven early.
- *MrDrums schema compatibility* — the export format needs to be taken from actual current MrDrums kit files. An assumed schema may produce files that parse but do not load correctly.
- *Sample decoding* — the internal player must use a decoder and sample-loading method compatible with the Move environment and Schwung build toolchain. (Confirmed necessary scope per decision 2 — not avoidable by delegating to MrDrums.)

**Medium risk**

- *Large library indexing* — very large folders may make an initial scan slow. The cache design reduces repeated cost.
- *Memory use* — loading sixteen long samples into memory may consume significant resources. The MVP may require sample-size limits or a practical maximum decoded duration.
- *Shift + Pad interception* — Shift may already have global Move behaviour. Kit Builder needs to receive or safely override the combination while active.
- *Directory permissions* — the selected indexes, kits, logs and exports directories must be writable by the Schwung runtime user.

**Low risk**

- *Random assignment* — once the sample index and internal model exist, category-based random selection is straightforward and independently testable.
- *LED state management* — the state model is simple, provided Schwung exposes the required RGB pad API.

## 26. MVP release criteria

Kit Builder v0.1.0 can be released when:

- The standalone hardware workflow is stable.
- Assign, audition, lock, clear and save are functional.
- User Library samples are correctly categorised.
- MrDrums can load the exported kit.
- Error states are understandable.
- No operation modifies or deletes source samples.
- The module survives repeated assignment and playback stress testing.
- Installation and removal are documented.
- Known limitations clearly state that Ableton and MPC exports, and in-tool reload/browsing of saved kits, are not yet included.

## 27. Immediate development inputs required

1. Current MrDrums source repository or release archive.
2. A minimal working MrDrums JSON kit.
3. A fully populated MrDrums JSON kit.
4. A working Schwung Overtake module with: pad input, Shift input, RGB pad output, encoder button widgets, display pages.
5. A small set of test WAV samples in the proposed folder structure.
6. The current Schwung module API headers used by the installed Move environment.
7. MrDrums licence details.
8. The exact writable directory used by installed Schwung modules for persistent data.

The first development spike should be a deliberately minimal **Kit Builder hardware shell** that proves page navigation, 16-pad input, Shift + Pad locking, RGB states and the Assign button before adding either sample indexing or DSP.
---

## 28. Post-MVP: built-in audition sequencer *(added 2026-09-09, not in v0.1.0)*

A lightweight step sequencer so the user can hear candidate samples **in the
context of a kit they are still building** — lock the pads that are working,
program a short pattern with them, then keep auditioning the unlocked pads
against that pattern.

### 28.1 Intent

- Play *only while Kit Builder is the active tool*. It must go silent when the
  module is parked (Back) or exited — it is a scratchpad, not a track.
- **Transport and tempo follow Move's global clock** (cable-0), so the pattern
  runs in time with whatever the user has playing on Move's normal tracks and
  the kit can be judged in a real musical context.
- Trigger the internal audition player (§14), not MrDrums.

### 28.2 Mode switch

The 16 step buttons are shared between two roles:

1. **Assign-control mode (default).** Step buttons 1..N mirror the Random-page
   action list (Assign, New, Save, Clear, Unlock All, …): a single press
   highlights the action on screen, a double press (or a second press) fires
   it. Button LEDs are coloured to match the action (green = Assign,
   white = Unlock All, …).
2. **Sequencer mode.** The step buttons become a 16-step pattern grid for the
   currently selected pad.

The **Record / Sample button** toggles between the two modes. Entering
sequencer mode is a clear, deliberate action.

### 28.3 Sequencer behaviour (first cut)

- One pattern, 16 steps, one lane per pad (16 lanes) — or a single selected-pad
  lane with a pad picker, whichever is simpler to land first.
- Step on/off per pad; fixed velocity to start (per-step velocity is a later
  refinement).
- Pattern length and swing can come later; 16 steps at 1/16 is enough to be
  useful.
- The pattern is **not** part of the saved kit or the MrDrums export in the
  first cut — it is transient audition state. Persisting it (so a
  work-in-progress groove survives a restart) is a candidate follow-up.
- LEDs while in sequencer mode: lit step = active, a brighter running-position
  indicator follows the global transport.

### 28.4 Open questions

- Does the sequencer keep running (silently advancing) while parked so it is
  in phase on resume, or reset to step 1 on resume?
- Interaction with `suspend_keeps_js`: the DSP keeps ticking while parked, so
  it must be told to stop emitting audio, not just stop being drawn.
- Whether "double press to fire" for the Assign controls also applies to the
  on-screen jog-press, or stays a step-button-only affordance.
