/*
 * Kit Builder — Overtake module
 * ------------------------------------------------------
 * Spec: docs/KIT_BUILDER_SPEC.md
 *
 * Stage 1 (spec §23 / §27) — hardware shell:
 *   - opens as an overtake module; receives pad + Shift+Pad events
 *     (left 4x4 drum-rack block -> Kit Builder pads 1-16)
 *   - drives RGB pad LEDs; Shift+Pad toggles a visual-only lock
 *   - jog-wheel TURN moves between pages (RANDOM / KIT / SYSTEM / EXPORT),
 *     except while a door is open (see "doors" below), where it scrolls one
 *   - jog-wheel PRESS is the page's momentary button, or opens/closes a door
 *   - Back parks the module with state intact (capabilities.suspend_keeps_js);
 *     Shift+Back fully exits. onResume() repaints on unpark. Because
 *     suspend_keeps_js hands plain Back to the host rather than to us, this
 *     module has no Back of its own — a door has to close on its own click.
 *
 * Stage 2 (spec §8) — sample index:
 *   - loads config (embedded default + optional KitBuilder/config.json)
 *   - SYSTEM page jog-press = Rescan: chunked recursive scan of the User
 *     Library, folder-role classification (deepest-match), path->URI mapping,
 *     cached to KitBuilder/.sample-index.json
 *   - SYSTEM page reports sample counts by category
 *
 * Stage 4 (spec §14) — internal audition player:
 *   - core/dsp: kit_player.c, a v2 sound-generator plugin the shim runs as
 *     `overtake_dsp`. 16 one-shot slots, one voice per pad, velocity-scaled.
 *   - the shim delivers pad note events straight to the DSP's on_midi, so
 *     pressing an assigned pad plays its sample with no JS round-trip.
 *   - ui.js pushes each pad's WAV path to the DSP (`slot_<N>` param) after
 *     Assign / Clear / Clear Pad, polls `sounding` for the "currently
 *     auditioning" LED, and `slot_status` for load errors.
 *
 * Stage 3 (spec §6, §10) — kit model + seeded assignment:
 *   - 16-pad internal kit model (core/kit_model.mjs), the single source of truth
 *   - RANDOM page: Up/Down (or step buttons) pick an action; the list itself
 *     lives behind a DOOR (PARAM_PAGES.md) — jog-press opens it, jog scrolls,
 *     a second press fires the highlighted one and closes it again —
 *       Assign      = seeded random fill of every unlocked pad, ascending pad
 *                     order, duplicate-avoided, current-sample-avoided (§10.2)
 *       Clear       = empty every unlocked pad (§13.2)
 *       Unlock All  = drop every lock (§13.2)
 *     Knob 3 turn toggles Duplicates (Avoid / Allow), Knob 4 cycles Source.
 *     All momentary actions honour the §10.7 in-flight guard.
 *   - KIT page: Knob 1 selects a pad, Knob 2 trims its gain, jog-press = Clear
 *     Pad (§13.3)
 *   - LEDs: green = assigned+unlocked, white = assigned+locked, teal = empty,
 *     dim white = empty+locked, red flash = a role had no candidate (§12)
 *   Core logic: core/kit_model.mjs, core/random_assign.mjs, core/sample_index.mjs.
 *   Knob-grid layout for RANDOM / KIT / SYSTEM: see the KNOB1..KNOB4 table
 *   above the constants below, and the per-page draw functions' own comments.
 *
 * Stage 5 (spec §15) — persistence:
 *   - RANDOM page gains New and Save. Save opens the shared keyboard (mutes the
 *     player so pad-typing is silent) on a generated name; repeated saves of
 *     the same session overwrite one file, a name change or New starts another.
 *   - The working kit is written to current-kit.json on every change and on
 *     unload, and RESTORED on next launch (New = fresh blank kit).
 *   - Step buttons 1..N mirror the RANDOM action list, coloured to match:
 *     single press selects, a second press within DOUBLE_PRESS_MS fires.
 *
 * Stage 6 (spec §16) — Move drum preset export:
 *   - Save also writes a native Move drum-rack `.ablpreset` to Move's Track
 *     Presets folder. It is the format Move writes for its own presets, so it
 *     loads in Move and, being the same file, in MrDrums too (instrumentRack
 *     -> drumRack -> one chain per assigned pad, gain as Volume dB,
 *     `ableton:/user-library/` %-encoded sampleUri). See
 *     core/exporters/mrdrums_json.mjs. An export failure never touches the
 *     saved kit file (§16.5).
 *   - The EXPORT page adds an opt-in Akai MPC `.xpm` exporter alongside it.
 */

import {
    MidiNoteOn, MidiNoteOff, MidiCC,
    MoveShift, MoveBack, MoveMainButton, MoveMainKnob, MoveUp, MoveDown,
    MovePlay, MoveRec,
    MoveKnob1, MovePads, MoveSteps,
    Black, White, DarkGrey,
    Green, Red, Blue,
    DarkCyanTeal, LightAmber,
    WhiteLedDim
} from '/data/UserData/schwung/shared/constants.mjs';

import {
    shouldFilterMessage, decodeDelta,
    setLED, setButtonLED, clearAllLEDs, invalidateLedCache
} from '/data/UserData/schwung/shared/input_filter.mjs';

import {
    drawMenuHeader, drawMenuFooter, drawMenuList,
    showOverlay, tickOverlay, drawOverlay, hideOverlay, isOverlayActive
} from '/data/UserData/schwung/shared/menu_layout.mjs';

/* Knob-ring LEDs (CC 71-78): the chain editor's own "which physical knob does
 * something" cue (knobs 1-4 white, 5-8 amber, dark = unbound). Kit Builder
 * only ever drives knobs 1-4, page-dependent — see knobLedValues() below. */
import {
    updateKnobLEDs, resetKnobLedCache
} from '/data/UserData/schwung/shared/param_pages/knob_leds.mjs';

import {
    loadConfig, loadIndex, createScan, summarize, summarizeRecords
} from './core/sample_index.mjs';

import { SIZE_CAP_CHOICES, SIZE_CAP_LABELS } from './core/scan_filters.mjs';
import { parseLoudness, matchGains } from './core/loudness.mjs';

import {
    createKit, toggleLock, clearUnlocked, unlockAll, clearPad, setPadGain, gainToDbLabel,
    padPool, lockedCount as kitLockedCount, assignedCount as kitAssignedCount
} from './core/kit_model.mjs';

import { assignKit, rerollPad, randomSeed } from './core/random_assign.mjs';

import {
    saveKit, saveCurrentKit, loadCurrentKit, markMissingSamples, exportMrDrums,
    generatedKitName, nextKitNumber, commitKitNumber, loadPrefs, savePrefs,
    runExports, loadExportPrefs, saveExportPrefs, loadScanPrefs, saveScanPrefs
} from './core/storage.mjs';

import {
    openTextEntry, isTextEntryActive, handleTextEntryMidi,
    tickTextEntry, drawTextEntry
} from '/data/UserData/schwung/shared/text_entry.mjs';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const MODULE_TAG = 'kit-builder';
const VERSION = '1.0.1';
const PAD_COUNT = 16;

/* Kit Builder pad 1..16 -> hardware pad note.
 *
 * Standard Move drum-rack layout: the LEFT 4x4 block of the 4x8 grid, with
 * pad 1 (kick) bottom-left, numbered left->right then bottom->top — matching
 * spec §6.4 (pad 1 = note 36 ... pad 16 = note 51).
 *
 * Hardware grid note math (cf. shared song-mode): the bottom row is notes
 * 68-75, each row up adds 8, so the left four columns of each row are:
 *   bottom row : 68 69 70 71     (kit pads 1-4)
 *   row 2      : 76 77 78 79     (kit pads 5-8)
 *   row 3      : 84 85 86 87     (kit pads 9-12)
 *   top row    : 92 93 94 95     (kit pads 13-16)
 * The right four columns stay dark. */
const KIT_PAD_NOTES = [
    68, 69, 70, 71,
    76, 77, 78, 79,
    84, 85, 86, 87,
    92, 93, 94, 95
];
const UNUSED_PAD_NOTES = MovePads.filter((n) => !KIT_PAD_NOTES.includes(n));

/* LED palette for pad state (spec §12 / §12.1 priority). */
const LED = {
    EMPTY_UNLOCKED:    DarkCyanTeal,   // dim blue-teal  — available for assignment
    EMPTY_LOCKED:      DarkGrey,       // dim white      — empty pad protected
    ASSIGNED_UNLOCKED: Green,          // green          — loaded & replaceable
    ASSIGNED_LOCKED:   White,          // white          — loaded pad protected
    SOUNDING:          White,          // bright flash    — pad is auditioning
    MISSING:           LightAmber,     // amber          — saved path unresolved (Stage 5+)
    FAIL_FLASH:        Red             // temporary red   — no eligible sample
};

const PAGES = ['RANDOM', 'KIT', 'SYSTEM', 'EXPORT'];

/* EXPORT page (Batch D): rows 0..n-1 toggle an exporter; the last row runs
 * every enabled one now. Up/Down always select; the list is also a door — a
 * jog-click opens it, the jog wheel then scrolls too, and a click toggles a
 * row (stays open) or runs Export now (closes). */
const EXPORT_ROWS = [
    { id: 'mrdrums', label: 'Move preset .ablpreset' },
    { id: 'mpcxpm',  label: 'MPC .xpm' },
    { id: '__now',   label: 'Export now' }
];

/* RANDOM-page action list — Up/Down (or step buttons 1..N) select, jog-press
 * or a step double-press fires (spec §13.2). Each has a step-button LED colour. */
const RANDOM_ACTIONS = [
    { name: 'Assign',       color: Green },
    { name: 'New',          color: Blue },
    { name: 'Save',         color: LightAmber },
    { name: 'Clear',        color: Red },
    { name: 'Unlock All',   color: White },
    { name: 'Match Levels', color: DarkCyanTeal }
];
const DOUBLE_PRESS_MS = 400;   // step-button double-press window
const ARM_TICKS = 390;         // ~9 s confirm window for New

/* Knob CCs used as encoder controls in this overtake shell. Each of the four
 * is one physical knob shared by several pages — same pattern the grid uses
 * everywhere else, just picked by page instead of by a chain_params contract:
 *   KNOB1  71  RANDOM: (door, no knob)   KIT: Gain         SYSTEM: Loop
 *   KNOB2  72  RANDOM: (door, no knob)   KIT: (no knob)    SYSTEM: Max size
 *   KNOB3  73  RANDOM: Duplicates        KIT: (readout)    SYSTEM: Rescan
 *   KNOB4  74  RANDOM: Source            KIT: (readout)    SYSTEM: (door)
 * KIT has no Pad knob — pressing a pad already selects it (onPadPress).
 */
const KNOB1 = MoveKnob1;
const KNOB2 = MoveKnob1 + 1;
const KNOB3 = MoveKnob1 + 2;
const KNOB4 = MoveKnob1 + 3;
const GAIN_STEP = 0.04;
/* A momentary fires from the KNOB, not a click — PARAM_PAGES.md "a momentary
 * fires from the knob too, and it latches per gesture": one flick of the
 * encoder is a dozen detents, so a raw per-detent fire would rescan a dozen
 * times. The first detent of a turn fires; further detents just extend the
 * gesture, and it can fire again once the knob has been still this long. */
const RESCAN_GESTURE_TICKS = 12;   // ~270ms at ~44Hz
/* PARAM_PAGES.md: "a turn PEEKS the list", ~700ms — the on-screen cell stays
 * a bare label; the live value shows in a short overlay instead. Kit Builder
 * has only one such knob (KIT's Gain) so this borrows the shared toast
 * overlay directly rather than a second timing system. */
const KNOB_PEEK_TICKS = 30;        // ~700ms at ~44Hz
/* The Move encoders have no detents and fire several ticks per light touch.
 * Enum knobs (Duplicates / Source) accumulate ticks and only step once the
 * run crosses this threshold, so a stray brush doesn't flip them. */
const ENUM_KNOB_TICKS = 8;

/* Momentary flash / feedback durations, in ticks (~44 Hz). */
const FLASH_TICKS = 6;
const FAIL_FLASH_TICKS = 14;         // red assignment-failure flash (§12)
/* Assign runs synchronously; the guard just spans a few frames so a second
 * press mid-repaint is dropped rather than queued (§10.7). */
const ASSIGN_INFLIGHT_TICKS = 8;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/* The internal kit is the single source of truth (spec §4.1, §6). */
let kit = null;
/* Transient per-pad LED effects, parallel to kit.pads (kept off the model). */
const padFx = Array.from({ length: PAD_COUNT }, () => ({ flash: 0, failFlash: 0 }));

let shiftHeld = false;
let pageIndex = 0;
let selectedPad = 0;       // 0-based, KIT page "Selected Pad"
let randomSel = 0;         // 0-based index into RANDOM_ACTIONS
let preventDuplicates = true;
const SOURCE_MODES = ['user', 'core', 'both'];      // §13.2 Source enum
const SOURCE_LABEL = { user: 'User', core: 'Core', both: 'Both' };
let sourceMode = 'user';
let dupKnobTicks = 0;      // accumulated encoder ticks for the Duplicates knob
let srcKnobTicks = 0;      // accumulated encoder ticks for the Source knob

/* Batch F — SYSTEM-page scan filters, persisted in config.json. */
let scanPrefs = { skip_loops: true, max_sample_size: null };
let scanLoopKnobTicks = 0;   // knob 1 on SYSTEM — loop filter toggle
let scanSizeKnobTicks = 0;   // knob 2 on SYSTEM — size-cap enum
function scanSizeLabel() {
    const i = SIZE_CAP_CHOICES.indexOf(scanPrefs.max_sample_size);
    return SIZE_CAP_LABELS[i >= 0 ? i : 0];
}

/* Library-wide reject / favourite memory (Batch C). Sets of filesystem_path;
 * loaded once at init, persisted on every change. Not reset by New. */
let rejects = new Set();
let favourites = new Set();

/* EXPORT page state (Batch D). */
let exportSel = 0;
let exportPrefs = { mrdrums: true, mpcxpm: false };

/* RANDOM's action list and SYSTEM's index report are DOORS (PARAM_PAGES.md:
 * "a door you were sent to opens; one you paged past stays shut") — the page
 * shows a closed preview, a jog-click opens it full-screen, and the jog wheel
 * repurposes from page-turn to list-scroll while it's open. There is no Back
 * out of it (suspend_keeps_js hands plain Back to the host, never to us — see
 * Stage 1), so a second jog-click is what closes it: on RANDOM that click also
 * fires the highlighted action, on SYSTEM it's a plain close. */
let doorOpen = false;
let systemInfoSel = 0;      // scroll cursor inside the open SYSTEM door
let rescanKnobCooldown = 0; // ticks left in the current Rescan knob gesture

/* E2 — audition step sequencer. Rec toggles the edit view; Play toggles run.
 * 16 fixed steps, one 16-bit mask per pad. Transient: not saved, not exported. */
let seqMode = false;                          // Rec view — step buttons edit the grid
let seqRunning = false;                       // Play — clock running (DSP owns the real one)
let seqStep = 0;                              // playhead, polled from the DSP
let seqPollTick = 0;
const seqPattern = new Array(PAD_COUNT).fill(0);
const SEQ_STEP_ON = DarkCyanTeal;            // an armed step
const SEQ_STEP_HEAD = White;                 // the playhead

let assignHeld = false;         // jog-press currently down
let assignInFlight = 0;         // >0 while an Assign is settling (reentrancy guard)
let assignFireCount = 0;
let assignDroppedCount = 0;     // momentary presses dropped by the in-flight guard

/* Stage 5+: the working kit's on-disk name (null = never saved this session).
 * Repeated Save overwrites this file; a name change or New starts a new one. */
let currentKitName = null;
let newArmed = 0;              // ticks left in the New confirm window
let lastStepIdx = -1;         // step-button double-press tracking
let lastStepAt = 0;
let heldPad = -1;            // pad currently held (for hold-pad + Assign = re-roll)

let footer = 'Kit Builder ready';
let needsRedraw = true;

/* ---- Stage 2: sample index (spec §8) --------------------------------------- *
 * config + a cached-or-live index summary. The recursive scan is pumped from
 * tick() in bounded chunks so it never blocks the display. Rescan is fired by
 * turning Knob 3 on the SYSTEM page (§13.4 "Rebuild"), with the §10.7
 * in-flight guard. */
let config = null;
let indexInfo = null;        // parsed cached index, or null
let indexSummary = summarize(null);
let indexAgeText = 'never';
let scan = null;             // active createScan() pump, or null
const SCAN_PER_TICK = 400;   // directory entries processed per tick while scanning

/* ---- Stage 4: audition player (spec §14) --------------------------------- *
 * The DSP (overtake_dsp) is addressed through host_module_set/get_param.
 * `soundingMask` mirrors which pads currently have an active voice; `slotStat`
 * is the DSP's per-slot load status string ('o' ok / 'm' missing / 'x' decode
 * error / '.' loading / '-' empty). */
let soundingMask = 0;
let slotStat = '----------------';
let statPollTick = 0;

/* Progressive LED init — overtake modules must stay under the MIDI buffer
 * (spec references/ui.md bug 6, references/realtime.md). */
let ledInitPending = false;
let ledInitIndex = 0;
const LEDS_PER_FRAME = 8;

/* After a resume, keep force-repainting the LED surface for ~30 frames: the
 * first frames land while the host is still settling the overtake LED queue /
 * SHM after unpark, so a single repaint in onResume() is not enough. This
 * mirrors mono's resumePaints pattern (spread, forced). */
let resumePaints = 0;
const RESUME_PAINT_FRAMES = 30;

/* Stopping a background track on open (see stopBackgroundTransport below):
 * stopTransportRelease counts down to the release half of the injected Play
 * press; suppressPlayEcho briefly ignores our own MovePlay case in case the
 * injection loops back to us too — it disarms itself quickly either way, so
 * a genuine later Play press is never the one that gets eaten. */
let stopTransportRelease = 0;
let suppressPlayEcho = 0;

/* suspend_keeps_js means a plain Back doesn't unload us — the DSP (and this
 * very tick()) keeps running in the background so a park-and-return is
 * instant. That is also the bug: the DSP's on_midi hook stays wired to
 * Move's internal pad-note stream while parked, so a track that starts
 * playing while Kit Builder is merely backgrounded (not exited) still
 * triggers its pads — the same phantom-note problem as the foreground case,
 * just with the screen gone too. Muted for the duration of the park (once,
 * on the way in) and unmuted in onResume() — the DSP and its loaded samples
 * stay warm, they just make no sound until you're actually looking at it
 * again. Shift+Back (a real exit) doesn't need this: the DSP is unloaded. */
let mutedForPark = false;

/* ------------------------------------------------------------------ *
 * LED helpers
 * ------------------------------------------------------------------ */

/* Resting LED colour for pad `index`, LED priority per spec §12.1:
 * fail-flash > missing > sounding > locked > assigned > empty. */
function ledForPad(index) {
    const fx = padFx[index];
    if (fx.failFlash > 0) return LED.FAIL_FLASH;
    const p = kit.pads[index];
    const assigned = !!p.sample;
    const st = slotStat.charAt(index);
    if (assigned && (st === 'm' || st === 'x')) return LED.MISSING;   // amber
    if (assigned && ((soundingMask & (1 << index)) || fx.flash > 0)) return LED.SOUNDING;
    if (!assigned && fx.flash > 0) return LED.SOUNDING;               // empty-pad press blip
    if (assigned && p.locked) return LED.ASSIGNED_LOCKED;
    if (assigned) return LED.ASSIGNED_UNLOCKED;
    if (p.locked) return LED.EMPTY_LOCKED;
    return LED.EMPTY_UNLOCKED;
}

function paintPad(index) {
    setLED(KIT_PAD_NOTES[index], ledForPad(index));
}
function paintPads() {
    for (let i = 0; i < PAD_COUNT; i++) paintPad(i);
}

/* Colour for step button `i`: the sequencer grid while editing, otherwise the
 * RANDOM action shortcuts. */
function stepLedColor(i) {
    if (seqMode) {
        if (seqRunning && i === seqStep) return SEQ_STEP_HEAD;
        return (seqPattern[selectedPad] & (1 << i)) ? SEQ_STEP_ON : Black;
    }
    return i < RANDOM_ACTIONS.length ? RANDOM_ACTIONS[i].color : Black;
}

function paintStepLeds() {
    for (let i = 0; i < MoveSteps.length; i++) setLED(MoveSteps[i], stepLedColor(i));
}

/* Build the full LED list once; setupLedBatch feeds it out ≤8/frame. */
function buildLedList() {
    const leds = [];
    leds.push({ type: 'cc', id: MoveBack, color: WhiteLedDim });
    leds.push({ type: 'cc', id: MoveRec, color: seqMode ? Red : Black });
    leds.push({ type: 'cc', id: MovePlay, color: seqRunning ? Green : Black });
    for (let i = 0; i < PAD_COUNT; i++) {
        leds.push({ type: 'note', id: KIT_PAD_NOTES[i], color: ledForPad(i) });
    }
    for (let i = 0; i < MoveSteps.length; i++) {
        leds.push({ type: 'note', id: MoveSteps[i], color: stepLedColor(i) });
    }
    for (const note of UNUSED_PAD_NOTES) {
        leds.push({ type: 'note', id: note, color: Black });
    }
    return leds;
}

let ledList = [];
function setupLedBatch() {
    const end = Math.min(ledInitIndex + LEDS_PER_FRAME, ledList.length);
    for (let i = ledInitIndex; i < end; i++) {
        const l = ledList[i];
        if (l.type === 'cc') setButtonLED(l.id, l.color);
        else setLED(l.id, l.color);
    }
    ledInitIndex = end;
    if (ledInitIndex >= ledList.length) ledInitPending = false;
}

/* Paint the whole surface we own in one pass (Back + 16 pads + action steps).
 * Used on resume: the host needs a few frames after unpark before queued LED
 * writes actually reach the hardware, so onResume() + tick() call this,
 * forced, repeatedly for RESUME_PAINT_FRAMES (mirrors mono). The unused
 * right-hand pads are left alone — init() blacks them and the host's suspend
 * clears them, so they are already dark here. */
function paintAllLeds(force) {
    setButtonLED(MoveBack, WhiteLedDim, force);
    setButtonLED(MoveRec, seqMode ? Red : Black, force);
    setButtonLED(MovePlay, seqRunning ? Green : Black, force);
    for (let i = 0; i < PAD_COUNT; i++) {
        setLED(KIT_PAD_NOTES[i], ledForPad(i), force);
    }
    for (let i = 0; i < MoveSteps.length; i++) {
        setLED(MoveSteps[i], stepLedColor(i), force);
    }
}

function requestFullLedRepaint() {
    ledList = buildLedList();
    ledInitIndex = 0;
    ledInitPending = true;
}

/* Knob-ring LEDs: one normalised 0..1 value per physical knob (null = dark,
 * "nothing bound here" — knob_leds.mjs). Mirrors the KNOB1..KNOB4 table in
 * the constants above exactly, so a lit ring and a working knob never
 * disagree about which knob that is. Knobs 5-8 are never driven by this
 * module and stay dark. */
function knobLedValues() {
    const v = new Array(8).fill(null);
    if (seqMode) {
        v[0] = PAD_COUNT > 1 ? selectedPad / (PAD_COUNT - 1) : 0;   // Knob 1: pad-lane select
        return v;
    }
    switch (PAGES[pageIndex]) {
        case 'RANDOM':
            v[2] = preventDuplicates ? 1 : 0;
            v[3] = SOURCE_MODES.length > 1 ? SOURCE_MODES.indexOf(sourceMode) / (SOURCE_MODES.length - 1) : 0;
            break;
        case 'KIT': {
            const p = kit.pads[selectedPad];
            const gain = (p.playback && p.playback.gain != null) ? p.playback.gain : 1;
            v[0] = Math.max(0, Math.min(1, gain / 2));   // Knob 1 — no Pad knob to light
            break;
        }
        case 'SYSTEM': {
            v[0] = scanPrefs.skip_loops ? 1 : 0;
            const at = Math.max(0, SIZE_CAP_CHOICES.indexOf(scanPrefs.max_sample_size));
            v[1] = SIZE_CAP_CHOICES.length > 1 ? at / (SIZE_CAP_CHOICES.length - 1) : 0;
            v[2] = 1;   // Rescan — a trigger reads as "ready", not as a level
            break;
        }
        // EXPORT: Up/Down + jog only, no knob does anything.
    }
    return v;
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function lockedCount() { return kitLockedCount(kit); }
function assignedCount() { return kitAssignedCount(kit); }

/* True while a long-running action owns the surface — every momentary action
 * defers to it (spec §10.7). */
function busy() { return assignInFlight > 0 || !!scan; }

function shortName(name, max) {
    if (!name) return '';
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    return stem.length > max ? stem.slice(0, max - 1) + '.' : stem;
}

function onPadPress(index, velocity) {
    const p = kit.pads[index];
    const padChanged = index !== selectedPad;
    selectedPad = index;   // KIT page follows the last-touched pad
    if (seqMode && padChanged) seqRepaintSteps();   // step LEDs follow the tapped pad's lane
    if (!shiftHeld) heldPad = index;   // hold pad + Assign = re-roll just this pad
    if (shiftHeld) {
        /* Shift + Pad -> toggle lock (spec §11.2 / §11.3). No trigger. */
        const locked = toggleLock(kit, index);
        paintPad(index);
        persistWorkingKit();
        footer = `Pad ${p.pad} ${locked ? 'locked' : 'unlocked'}`;
        console.log(`${MODULE_TAG}: pad ${p.pad} lock=${locked}`);
        needsRedraw = true;
        return;
    }

    if (!p.sample) {
        /* Empty pad (spec §11.1): no sound, brief "No sample". */
        padFx[index].flash = FLASH_TICKS;
        paintPad(index);
        footer = `Pad ${p.pad}: No sample`;
        needsRedraw = true;
        return;
    }

    /* Assigned pad: the shim routes the note straight to the DSP, which plays
     * the sample — nothing to trigger from here. Flash the LED and show it. */
    padFx[index].flash = FLASH_TICKS;
    paintPad(index);
    footer = `Pad ${p.pad}: ${shortName(p.sample.filename, 16)}`;
    needsRedraw = true;
}

/* ---- RANDOM-page actions --------------------------------------------------- */

function fireAssign() {
    if (busy()) {
        assignDroppedCount++;
        footer = scan ? 'Busy scanning — try again' : `Assign busy — press dropped`;
        console.log(`${MODULE_TAG}: assign press dropped (busy)`);
        needsRedraw = true;
        return;
    }
    /* Hold a pad + Assign = re-roll just that pad. */
    if (heldPad >= 0) { fireRerollPad(heldPad); return; }
    if (!indexInfo || !Array.isArray(indexInfo.records) || indexInfo.records.length === 0) {
        footer = 'No samples indexed — Rescan first';   // §17.3
        needsRedraw = true;
        return;
    }

    assignInFlight = ASSIGN_INFLIGHT_TICKS;
    assignFireCount++;

    const seed = randomSeed();
    const res = assignKit({
        kit, index: indexInfo, config, seed,
        source: sourceMode, preventDuplicates, rejects, favourites
    });

    /* Commit the proposed state as one transaction (spec §10.3). */
    for (let i = 0; i < PAD_COUNT; i++) kit.pads[i] = res.pads[i];
    kit.random_seed = res.seed;
    kit.modified_at = new Date().toISOString();

    for (const u of res.unresolved) padFx[u.pad - 1].failFlash = FAIL_FLASH_TICKS;
    syncAllSlots();      // hand the new sample set to the audition player
    paintPads();
    persistWorkingKit();

    footer = res.warning || `Assigned ${assignedCount()}/16 pads`;
    console.log(`${MODULE_TAG}: assign #${assignFireCount} seed=${res.seed} ` +
        `changed=${res.changed.length} unresolved=${res.unresolved.length} relaxed=${res.relaxed.length}`);
    needsRedraw = true;
}

/* Re-roll a single held pad (spec §10, one-pad slice). */
function fireRerollPad(index) {
    if (busy()) { footer = 'Busy — try again'; needsRedraw = true; return; }
    const p = kit.pads[index];
    if (p.locked) { footer = `Pad ${p.pad} is locked`; needsRedraw = true; return; }
    if (!indexInfo || !Array.isArray(indexInfo.records) || indexInfo.records.length === 0) {
        footer = 'No samples indexed'; needsRedraw = true; return;
    }
    const res = rerollPad({
        kit, index: indexInfo, config, seed: randomSeed(),
        source: sourceMode, preventDuplicates, padIndex: index, rejects, favourites
    });
    if (!res.pad || !res.changed) {
        footer = res.warning ? `Pad ${p.pad}: ${res.warning}` : `Pad ${p.pad} unchanged`;
        needsRedraw = true;
        return;
    }
    kit.pads[index] = res.pad;
    kit.modified_at = new Date().toISOString();
    syncSlot(index);
    paintPad(index);
    persistWorkingKit();
    footer = `Pad ${p.pad}: ${shortName(res.pad.sample.filename, 16)}${res.relaxed ? ' (dup)' : ''}`;
    console.log(`${MODULE_TAG}: reroll pad ${p.pad} -> ${res.pad.sample.filename}`);
    needsRedraw = true;
}

function fireClear() {
    if (busy()) { footer = 'Busy — try again'; needsRedraw = true; return; }
    const n = clearUnlocked(kit);
    if (n) { syncAllSlots(); persistWorkingKit(); }
    paintPads();
    footer = n ? `Cleared ${n} pad(s)` : 'No unlocked pads to clear';   // §17.3
    console.log(`${MODULE_TAG}: clear unlocked -> ${n}`);
    needsRedraw = true;
}

function fireUnlockAll() {
    if (busy()) { footer = 'Busy — try again'; needsRedraw = true; return; }
    const n = unlockAll(kit);
    if (n) persistWorkingKit();
    paintPads();
    footer = n ? `Unlocked ${n} pad(s)` : 'Nothing was locked';
    console.log(`${MODULE_TAG}: unlock all -> ${n}`);
    needsRedraw = true;
}

/* New — start a blank kit. Destructive to unsaved work, so it takes a second
 * press within ARM_TICKS to confirm. Clears currentKitName so the next Save
 * generates a fresh number. */
function fireNew() {
    if (busy() || isTextEntryActive()) { footer = 'Busy — try again'; needsRedraw = true; return; }
    if (newArmed <= 0) {
        newArmed = ARM_TICKS;
        footer = 'Press New again to discard';
        needsRedraw = true;
        return;
    }
    newArmed = 0;
    kit = createKit(config);
    for (const fx of padFx) { fx.flash = 0; fx.failFlash = 0; }
    currentKitName = null;
    soundingMask = 0;
    dspSet('clear_all', '1');
    seqReset();                 // E2 — a fresh slate clears the pattern too
    persistWorkingKit();
    requestFullLedRepaint();
    footer = 'New kit';
    console.log(`${MODULE_TAG}: new kit`);
    needsRedraw = true;
}

/* Save (spec §3.3, §13.2 / §3.3.1). First save of a session generates a name
 * and consumes a counter value; later saves of the same kit overwrite that
 * file. The keyboard mutes the audition player so pad-typing is silent. */
function fireSave() {
    if (busy() || isTextEntryActive()) { footer = 'Busy — try again'; needsRedraw = true; return; }
    const fresh = !currentKitName;
    const num = fresh ? nextKitNumber() : 0;
    const suggested = fresh ? generatedKitName(num) : currentKitName;
    const overwrite = currentKitName;

    dspSet('mute', '1');
    openTextEntry({
        title: 'Kit name',
        initialText: suggested,
        padSelect: true,
        onConfirm: (text) => {
            const name = text || suggested;
            const res = saveKit(kit, name, overwrite);
            if (res.ok) {
                if (fresh && !res.overwrote) commitKitNumber(num);
                currentKitName = res.name;
                /* §3.3: a save also runs every enabled exporter (Batch D). */
                const ex = runExports(kit, res.name, exportPrefs);
                const failed = ex.filter((r) => !r.ok);
                const warns = ex.reduce((n, r) => n + r.warnings.length, 0);
                if (!failed.length) {
                    footer = `${res.overwrote ? 'Updated' : 'Saved'}: ${res.name}` +
                        (ex.length ? ` — ${ex.length} export${ex.length > 1 ? 's' : ''}` : '') +
                        (warns ? ` (${warns} warn)` : '');
                } else {
                    footer = `Saved; ${failed.map((r) => r.id).join('+')} export failed`;   // §17.3
                }
                console.log(`${MODULE_TAG}: saved ${res.path}; exports ` +
                    ex.map((r) => `${r.id}:${r.ok ? 'ok' : 'FAIL'}`).join(' '));
            } else {
                footer = `Save failed: ${res.error}`;   // §17.3
                console.log(`${MODULE_TAG}: save failed — ${res.error}`);
            }
            afterTextEntry();
        },
        onCancel: () => { footer = 'Save cancelled'; afterTextEntry(); }
    });
    needsRedraw = true;
}

/* Text entry paints its own screen and (padSelect) its own pad LEDs — unmute
 * the player and force a full repaint of our surface when it closes. */
function afterTextEntry() {
    dspSet('mute', '0');
    invalidateLedCache();
    resumePaints = RESUME_PAINT_FRAMES;
    needsRedraw = true;
}

/* Persist the working kit to current-kit.json so it survives a relaunch. */
function persistWorkingKit() {
    if (kit) saveCurrentKit(kit);
}

function fireRandomAction() {
    switch (RANDOM_ACTIONS[randomSel].name) {
        case 'Assign':       fireAssign(); break;
        case 'New':          fireNew(); break;
        case 'Save':         fireSave(); break;
        case 'Clear':        fireClear(); break;
        case 'Unlock All':   fireUnlockAll(); break;
        case 'Match Levels': fireMatchLevels(); break;
    }
}

/* E1 — read each loaded slot's RMS from the DSP, set a per-pad makeup gain
 * that pulls every assigned pad toward the median level, apply it to the kit
 * model + DSP, and persist. A manual Knob-5 trim afterwards still overrides. */
function fireMatchLevels() {
    if (busy()) { footer = 'Busy — try again'; needsRedraw = true; return; }
    if (assignedCount() === 0) { footer = 'Nothing to match — assign a kit'; needsRedraw = true; return; }
    const gains = matchGains(parseLoudness(dspGet('loudness')));
    let n = 0;
    for (let i = 0; i < PAD_COUNT; i++) {
        if (!kit.pads[i].sample) continue;
        const g = setPadGain(kit, i, gains[i]);
        dspSet('slot_gain_' + i, g);
        n++;
    }
    persistWorkingKit();
    footer = `Levels matched — ${n} pad${n === 1 ? '' : 's'}`;
    needsRedraw = true;
}

/* ---- E2 audition step sequencer -------------------------------------- */

function seqHasSteps() {
    for (let i = 0; i < PAD_COUNT; i++) if (seqPattern[i]) return true;
    return false;
}

/* Rec button — enter / leave pattern-edit. The step buttons + their LEDs are
 * the whole UI (no on-screen grid — it added nothing); on enter we jump to the
 * KIT page so the pad being edited and its sample are visible. Playback (Play)
 * is independent, so leaving edit mode does not stop a running sequence. */
function toggleSeqMode() {
    seqMode = !seqMode;
    setButtonLED(MoveRec, seqMode ? Red : Black, true);
    if (seqMode) {
        pageIndex = PAGES.indexOf('KIT');
        footer = `Seq: pad ${selectedPad + 1} — steps edit, Play runs`;
        seqRepaintSteps();     // show this pad's lane right away
    } else {
        footer = seqRunning ? 'Seq running (Rec to edit)' : 'Seq edit closed';
    }
    requestFullLedRepaint();   // step LEDs switch between grid and action colours; Rec/Play/pads
    needsRedraw = true;
}

/* Play button — always toggles run/stop, like a normal transport. An empty
 * pattern just runs a silent clock; pressing Play again stops it. */
function toggleSeqRun() {
    seqRunning = !seqRunning;
    dspSet('seq_run', seqRunning ? '1' : '0');
    if (seqRunning) dspSet('seq_fg', '1');
    else seqStep = 0;
    setButtonLED(MovePlay, seqRunning ? Green : Black, true);
    footer = seqRunning ? 'Seq running' : 'Seq stopped';
    paintStepLeds();
    needsRedraw = true;
}

/* Toggle step `st` in the selected pad's lane and push it to the DSP. */
function seqToggleStep(st) {
    if (st < 0 || st > 15) return;
    seqPattern[selectedPad] ^= (1 << st);
    dspSet('seq_lane_' + selectedPad, String(seqPattern[selectedPad]));
    seqRepaintSteps();
    needsRedraw = true;
}

/* Force-repaint the 16 step LEDs for the current pad's lane — used whenever
 * `selectedPad` changes in edit mode (knob OR pad press), so the cache can
 * never suppress the switch. */
function seqRepaintSteps() {
    for (let i = 0; i < MoveSteps.length; i++) setLED(MoveSteps[i], stepLedColor(i), true);
}

/* Clear the whole pattern + stop (called by New). */
function seqReset() {
    seqPattern.fill(0);
    seqRunning = false;
    seqMode = false;
    seqStep = 0;
    dspSet('seq_clear', '1');
    setButtonLED(MoveRec, Black, true);
    setButtonLED(MovePlay, Black, true);
}

/* Step button `idx` (0-based) pressed: single = select the matching RANDOM
 * action (and switch to that page); double within DOUBLE_PRESS_MS = fire it.
 * Exception: once New is armed for its discard confirm, a SINGLE press
 * confirms — the double-press was only to arm it. */
function onStepAction(idx) {
    const now = Date.now();
    const isDouble = (idx === lastStepIdx) && (now - lastStepAt < DOUBLE_PRESS_MS);
    lastStepIdx = idx;
    lastStepAt = now;

    pageIndex = PAGES.indexOf('RANDOM');
    randomSel = idx;
    doorOpen = false;   // a step-button shortcut jumps pages; any open door goes with it
    needsRedraw = true;

    const armed = RANDOM_ACTIONS[idx].name === 'New' && newArmed > 0;
    if (isDouble || armed) {
        lastStepIdx = -1;   // consume — a third quick press starts fresh
        fireRandomAction();
    } else {
        footer = `${RANDOM_ACTIONS[idx].name} — press again to run`;
    }
}

/* ---- KIT-page action ----------------------------------------------------- */

function fireClearPad() {
    if (busy()) { footer = 'Busy — try again'; needsRedraw = true; return; }
    const p = kit.pads[selectedPad];
    const r = clearPad(kit, selectedPad);
    if (r === 'locked') footer = `Pad ${p.pad} is locked`;
    else if (r === 'empty') footer = `Pad ${p.pad} already empty`;
    else { syncSlot(selectedPad); paintPad(selectedPad); persistWorkingKit(); footer = `Cleared pad ${p.pad}`; }
    needsRedraw = true;
}

/* ---- reject / favourite memory (Batch C) ------------------------------- */

/* Toggle the selected pad's sample in the reject or favourite list. The two
 * are mutually exclusive per sample. Persisted immediately. */
function markPref(kind) {
    const p = kit.pads[selectedPad];
    if (!p || !p.sample) { footer = `Pad ${selectedPad + 1}: no sample`; needsRedraw = true; return; }
    const path = p.sample.filesystem_path;
    const nm = shortName(p.sample.filename, 12);
    if (kind === 'fav') {
        if (favourites.has(path)) { favourites.delete(path); footer = `${nm}: favourite off`; }
        else { favourites.add(path); rejects.delete(path); footer = `${nm}: favourite`; }
    } else {
        if (rejects.has(path)) { rejects.delete(path); footer = `${nm}: reject off`; }
        else { rejects.add(path); favourites.delete(path); footer = `${nm}: reject`; }
    }
    savePrefs(rejects, favourites);
    needsRedraw = true;
}

function clearAllPref(kind) {
    if (kind === 'fav') { const n = favourites.size; favourites.clear(); footer = `Cleared ${n} favourite(s)`; }
    else                { const n = rejects.size;    rejects.clear();    footer = `Cleared ${n} reject(s)`; }
    savePrefs(rejects, favourites);
    needsRedraw = true;
}

/* ---- sample index (Stage 2) --------------------------------------------- */

function relativeAge(iso) {
    if (!iso) return 'never';
    const then = Date.parse(iso);
    if (isNaN(then)) return 'unknown';
    const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    return Math.floor(secs / 86400) + 'd ago';
}

function refreshIndexView() {
    if (indexInfo && Array.isArray(indexInfo.records)) {
        indexSummary = summarizeRecords(indexInfo.records, sourceMode);   // source-filtered
    } else {
        indexSummary = summarize(indexInfo && indexInfo.counts);
    }
    indexSummary.skippedLoops = (indexInfo && indexInfo.skipped_loops) || 0;
    indexSummary.skippedOversize = (indexInfo && indexInfo.skipped_oversize) || 0;
    indexAgeText = relativeAge(indexInfo && indexInfo.generated_at);
}

/* Rows for the SYSTEM info door — the full index report, one row per line.
 * Shared by the door preview (first few), the open full-screen list, and the
 * scroll clamp, so all three always agree on what there is to show. */
function systemInfoRows() {
    const s = indexSummary;
    return [
        { label: 'Indexed', value: `${s.indexed} · ${indexAgeText}` },
        { label: 'Cut', value: `${s.skippedLoops || 0} loop, ${s.skippedOversize || 0} big` },
        { label: 'Kick', value: String(s.kick) },
        { label: 'Snare', value: String(s.snare) },
        { label: 'Clap', value: String(s.clap) },
        { label: 'Hats', value: String(s.hats) },
        { label: 'Toms', value: String(s.toms) },
        { label: 'Perc', value: String(s.perc) },
        { label: 'Cymbal', value: String(s.cym) },
        { label: 'FX', value: String(s.fx) },
        { label: 'Other', value: String(s.other) }
    ];
}

function fireRescan() {
    /* §10.7 reentrancy: ignore while a scan or an Assign is in flight. */
    if (busy()) {
        footer = scan ? 'Rescan already running' : 'Busy — try again';
        console.log(`${MODULE_TAG}: rescan press dropped (busy)`);
        needsRedraw = true;
        return;
    }
    if (!config) config = loadConfig();
    config.scan_filters = { skip_loops: scanPrefs.skip_loops, max_sample_size: scanPrefs.max_sample_size };
    scan = createScan(config);
    if (scan.state.phase === 'error') {
        finishScan();
        return;
    }
    footer = 'Scanning User Library...';
    console.log(`${MODULE_TAG}: rescan started root=${scan.state.root}`);
    needsRedraw = true;
}

/* ---- EXPORT-page action (Batch D) ------------------------------------- */

function fireExportAction() {
    const row = EXPORT_ROWS[exportSel];
    if (!row) return;

    if (row.id !== '__now') {
        exportPrefs[row.id] = !exportPrefs[row.id];
        saveExportPrefs(exportPrefs);
        footer = `${row.label}: ${exportPrefs[row.id] ? 'on' : 'off'}`;
        needsRedraw = true;
        return;
    }

    /* Export now — run every enabled exporter against the working kit. */
    if (busy()) { footer = 'Busy — try again'; needsRedraw = true; return; }
    if (assignedCount() === 0) { footer = 'Nothing to export — assign a kit'; needsRedraw = true; return; }
    const enabled = EXPORT_ROWS.filter((r) => r.id !== '__now' && exportPrefs[r.id]);
    if (!enabled.length) { footer = 'No exporters enabled'; needsRedraw = true; return; }

    const name = currentKitName || kit.name || 'Kit Builder';
    const res = runExports(kit, name, exportPrefs);
    const failed = res.filter((r) => !r.ok);
    const warns = res.reduce((n, r) => n + r.warnings.length, 0);
    footer = failed.length
        ? `Exported ${res.length - failed.length}/${res.length} — ${failed.map((r) => r.id).join('+')} failed`
        : `Exported ${res.length} type${res.length > 1 ? 's' : ''}${warns ? ` (${warns} warn)` : ''}`;
    console.log(`${MODULE_TAG}: export now "${name}" — ` + res.map((r) => `${r.id}:${r.ok ? 'ok' : 'FAIL'}`).join(' '));
    needsRedraw = true;
}

function pumpScan() {
    if (!scan) return;
    const phase = scan.step(SCAN_PER_TICK);
    const st = scan.state;
    if (phase === 'scanning') {
        footer = `Scanning... ${st.filesSeen} files`;
        needsRedraw = true;
        return;
    }
    finishScan();
}

function finishScan() {
    const st = scan ? scan.state : null;
    if (st && st.phase === 'done') {
        indexInfo = {
            generated_at: new Date().toISOString(),
            counts: st.counts,
            skipped_loops: st.skippedLoops || 0,
            skipped_oversize: st.skippedOversize || 0,
            records: st.records
        };
        refreshIndexView();
        footer = `Index rebuilt: ${indexSummary.indexed} files`;
        console.log(`${MODULE_TAG}: index rebuilt files=${indexSummary.indexed} dirs=${st.dirsVisited} ` +
            `kick=${indexSummary.kick} snare=${indexSummary.snare} hats=${indexSummary.hats} other=${indexSummary.other} ` +
            `cut=${st.skippedLoops || 0}loop/${st.skippedOversize || 0}big`);
    } else if (st && st.error === 'no_root') {
        footer = 'No User Library sample folder found';
        console.log(`${MODULE_TAG}: rescan failed — no sample root`);
    } else {
        footer = 'Sample index rebuild failed';
        console.log(`${MODULE_TAG}: rescan failed — ${st && st.error}`);
    }
    scan = null;
    needsRedraw = true;
}

/* ---- audition player DSP bridge (Stage 4) ------------------------------- */

function dspSet(key, val) {
    if (typeof host_module_set_param !== 'function') return;
    host_module_set_param(key, val == null ? '' : String(val));
}
function dspGet(key) {
    if (typeof host_module_get_param !== 'function') return null;
    const v = host_module_get_param(key);
    return (v === null || v === undefined) ? null : String(v);
}

/* Push one pad's sample path (or "" to clear) and its gain to the DSP slot. */
function syncSlot(i) {
    const p = kit.pads[i];
    dspSet('slot_' + i, p.sample ? p.sample.filesystem_path : '');
    dspSet('slot_gain_' + i, (p.playback && p.playback.gain != null) ? p.playback.gain : 1);
}
function syncAllSlots() {
    for (let i = 0; i < PAD_COUNT; i++) syncSlot(i);
}

/* Poll the DSP for the currently-sounding pad mask; returns true if it changed. */
function pollSounding() {
    const v = dspGet('sounding');
    if (v === null) return false;
    const m = parseInt(v, 10) || 0;
    if (m === soundingMask) return false;
    soundingMask = m;
    return true;
}
function pollSlotStatus() {
    const v = dspGet('slot_status');
    if (v === null || v === slotStat) return;
    slotStat = v;
    let bad = 0;
    for (let i = 0; i < PAD_COUNT; i++) {
        const c = slotStat.charAt(i);
        if (c === 'm' || c === 'x') bad++;
    }
    if (bad) footer = `${bad} sample${bad > 1 ? 's' : ''} could not be loaded`;
    needsRedraw = true;
}

/* Stop Move's own transport if it's already running when Kit Builder opens or
 * resumes. A playing track's own notes reach onMidiMessageInternal
 * indistinguishable from a real pad press (see the pad-note comment below —
 * confirmed from a device capture, no field to filter on), so this removes
 * them at the source instead. A real Play press is a CC85 (MovePlay) press +
 * release injected on cable-0 — the pattern song-mode/ui.js established for
 * driving Move's transport the same way a physical press would — and it only
 * ever fires when shadow_get_overlay_state() reports transport already
 * playing, so it can never accidentally START it. */
function stopBackgroundTransport() {
    if (typeof shadow_get_overlay_state !== 'function') return;
    if (typeof move_midi_inject_to_move !== 'function') return;
    const ov = shadow_get_overlay_state();
    if (!ov || !ov.transportPlaying) return;
    suppressPlayEcho = 6;   // in case the injection loops back to our own MovePlay case too
    move_midi_inject_to_move([0x0B, 0xB0, MovePlay, 127]);
    stopTransportRelease = 2;
    footer = 'Stopped background playback';
    console.log(`${MODULE_TAG}: transport was playing on open — stopping it`);
}

/* ------------------------------------------------------------------ *
 * MIDI
 * ------------------------------------------------------------------ */

globalThis.onMidiMessageInternal = function (data) {
    if (shouldFilterMessage(data)) return;

    /* The Save keyboard owns all input while open. */
    if (isTextEntryActive()) { handleTextEntryMidi(data); return; }

    /* Input clears a lingering status toast (after the grace) — without
     * consuming the press, so the same button both dismisses and acts. */
    if (toastGrace <= 0 && toastActive()) {
        if (typeof hideOverlay === 'function') hideOverlay();
        footerShown = footer;
        needsRedraw = true;
    }

    const status = data[0] & 0xF0;
    const d1 = data[1];
    const d2 = data[2];

    if (status === MidiNoteOn || status === MidiNoteOff) {
        const isOn = status === MidiNoteOn && d2 > 0;

        /* Step buttons 1..N shortcut the RANDOM action list: a single press
         * selects (and jumps to RANDOM), a second press within DOUBLE_PRESS_MS
         * fires it. */
        const stepIdx = MoveSteps.indexOf(d1);
        if (stepIdx >= 0) {
            if (isOn && seqMode) seqToggleStep(stepIdx);
            else if (isOn && stepIdx < RANDOM_ACTIONS.length) onStepAction(stepIdx);
            return;
        }

        const padIdx = KIT_PAD_NOTES.indexOf(d1);
        if (padIdx === -1) return;              // ignore the unused 16 pads
        /* A background Schwung track's own playing notes reach here
         * indistinguishable from a real pad press — same status byte 0x90/
         * 0x80, same channel 0, no source id in the 3-byte message. Confirmed
         * from a device capture (2026-09-11): no field to filter on. Fixed at
         * the source instead — stopBackgroundTransport() stops Move's
         * transport on open/resume when it's already running. */
        if (isOn) onPadPress(padIdx, d2);
        else if (heldPad === padIdx) heldPad = -1;   // released
        return;
    }

    if (status === MidiCC) {
        switch (d1) {
            case MoveShift:
                shiftHeld = d2 === 127;
                footer = shiftHeld ? 'Shift held — Pad toggles lock' : footer;
                needsRedraw = true;
                return;

            case MoveRec:        /* E2 — toggle the step-sequencer edit view */
                if (d2 === 127) toggleSeqMode();
                return;

            case MovePlay:       /* E2 — run / stop the sequencer */
                if (suppressPlayEcho > 0 && d2 === 127) { suppressPlayEcho = 0; return; }
                if (d2 === 127) toggleSeqRun();
                return;

            /* Back is NOT handled here: with capabilities.suspend_keeps_js the
             * host owns it — plain Back parks this module in the background
             * (JS state + this tick loop kept alive), Shift+Back fully exits.
             * See onResume(). */

            case MoveMainKnob: {
                /* Jog-wheel turn: page navigation when no door is open. RANDOM's
                 * action list, SYSTEM's info report and EXPORT's row list are
                 * doors — while one is open the jog scrolls IT instead, and
                 * paging is unavailable until a click closes it (see doorOpen
                 * above). */
                const delta = decodeDelta(d2);
                if (delta === 0) return;
                const dir = delta > 0 ? 1 : -1;

                if (doorOpen && PAGES[pageIndex] === 'RANDOM') {
                    randomSel = (randomSel + dir + RANDOM_ACTIONS.length) % RANDOM_ACTIONS.length;
                    needsRedraw = true;
                    return;
                }
                if (doorOpen && PAGES[pageIndex] === 'SYSTEM') {
                    const n = systemInfoRows().length;
                    systemInfoSel = Math.max(0, Math.min(n - 1, systemInfoSel + dir));
                    needsRedraw = true;
                    return;
                }
                if (doorOpen && PAGES[pageIndex] === 'EXPORT') {
                    exportSel = (exportSel + dir + EXPORT_ROWS.length) % EXPORT_ROWS.length;
                    needsRedraw = true;
                    return;
                }

                pageIndex = (pageIndex + dir + PAGES.length) % PAGES.length;
                needsRedraw = true;
                return;
            }

            case MoveUp:
            case MoveDown:
                if (d2 > 0 && PAGES[pageIndex] === 'RANDOM') {
                    /* Move the action selection (spec §13.2 row). */
                    const dir = d1 === MoveDown ? 1 : -1;
                    randomSel = (randomSel + dir + RANDOM_ACTIONS.length) % RANDOM_ACTIONS.length;
                    needsRedraw = true;
                } else if (d2 > 0 && PAGES[pageIndex] === 'KIT') {
                    /* Batch C: Up = favourite the selected pad's sample,
                     * Down = reject it; Shift + either clears that whole list. */
                    if (shiftHeld) clearAllPref(d1 === MoveUp ? 'fav' : 'rej');
                    else           markPref(d1 === MoveUp ? 'fav' : 'rej');
                } else if (d2 > 0 && PAGES[pageIndex] === 'EXPORT') {
                    /* Batch D: move the exporter selection. */
                    const dir = d1 === MoveDown ? 1 : -1;
                    exportSel = (exportSel + dir + EXPORT_ROWS.length) % EXPORT_ROWS.length;
                    needsRedraw = true;
                }
                return;

            case KNOB1: {   /* CC 71 — KIT: Gain trim · SYSTEM: Loop filter (RANDOM: door, no knob) */
                const delta = decodeDelta(d2);
                if (delta === 0) return;

                if (seqMode) {
                    /* Pick the pad whose 16-step lane the step buttons edit. */
                    const dir = delta > 0 ? 1 : -1;
                    const np = Math.max(0, Math.min(PAD_COUNT - 1, selectedPad + dir));
                    if (np !== selectedPad) {
                        selectedPad = np;
                        seqRepaintSteps();
                        needsRedraw = true;
                    }
                    return;
                }

                if (PAGES[pageIndex] === 'KIT') {
                    /* Per-pad gain trim (spec §13.3). No Pad-select knob — a
                     * pad press already picks the pad (onPadPress) — so Gain
                     * takes the freed seat. The cell only ever shows "Gain";
                     * the value peeks in an overlay while the knob turns, the
                     * way a plain schwung knob does. */
                    const g = setPadGain(kit, selectedPad, (kit.pads[selectedPad].playback.gain || 1) + delta * GAIN_STEP);
                    dspSet('slot_gain_' + selectedPad, g);
                    persistWorkingKit();
                    if (typeof showOverlay === 'function') showOverlay('Gain', gainToDbLabel(g), KNOB_PEEK_TICKS);
                    needsRedraw = true;   // the knob's own arc still redraws live
                    return;
                }

                if (PAGES[pageIndex] === 'SYSTEM') {
                    /* Loop filter toggle — CW = skip, CCW = keep (Batch F). */
                    scanLoopKnobTicks += delta;
                    if (Math.abs(scanLoopKnobTicks) < ENUM_KNOB_TICKS) return;
                    const next = scanLoopKnobTicks > 0;
                    scanLoopKnobTicks = 0;
                    if (next !== scanPrefs.skip_loops) {
                        scanPrefs.skip_loops = next;
                        saveScanPrefs(scanPrefs);
                        footer = `Loops: ${next ? 'skip' : 'keep'} — Rescan to apply`;
                        needsRedraw = true;
                    }
                }
                return;
            }

            case KNOB2: {   /* CC 72 — SYSTEM: Max sample size (RANDOM/KIT: nothing on this knob) */
                const delta = decodeDelta(d2);
                if (delta === 0) return;

                if (PAGES[pageIndex] === 'SYSTEM') {
                    /* Size-cap enum: Off -> 1M -> 2M -> 5M -> 10M (Batch F). */
                    scanSizeKnobTicks += delta;
                    if (Math.abs(scanSizeKnobTicks) < ENUM_KNOB_TICKS) return;
                    const dir = scanSizeKnobTicks > 0 ? 1 : -1;
                    scanSizeKnobTicks = 0;
                    const at = Math.max(0, SIZE_CAP_CHOICES.indexOf(scanPrefs.max_sample_size));
                    const nextCap = SIZE_CAP_CHOICES[(at + dir + SIZE_CAP_CHOICES.length) % SIZE_CAP_CHOICES.length];
                    if (nextCap !== scanPrefs.max_sample_size) {
                        scanPrefs.max_sample_size = nextCap;
                        saveScanPrefs(scanPrefs);
                        footer = `Max sample: ${scanSizeLabel()} — Rescan to apply`;
                        needsRedraw = true;
                    }
                }
                return;
            }

            case KNOB3: {   /* CC 73 — RANDOM: Duplicates · SYSTEM: Rescan trigger (KIT: readout, no knob) */
                const delta = decodeDelta(d2);
                if (delta === 0) return;

                if (PAGES[pageIndex] === 'RANDOM') {
                    /* Duplicates enum — CW = Allow, CCW = Avoid (§13.2).
                     * Accumulate ticks so a light touch doesn't flip it. */
                    dupKnobTicks += delta;
                    if (Math.abs(dupKnobTicks) < ENUM_KNOB_TICKS) return;
                    const next = dupKnobTicks < 0;   // CCW -> Avoid
                    dupKnobTicks = 0;
                    if (next !== preventDuplicates) {
                        preventDuplicates = next;
                        footer = `Duplicates: ${preventDuplicates ? 'Avoid' : 'Allow'}`;
                        needsRedraw = true;
                    }
                    return;
                }

                if (PAGES[pageIndex] === 'SYSTEM') {
                    /* A trigger fires from the KNOB, not a click (PARAM_PAGES.md)
                     * — the first detent of a turn fires Rescan, further detents
                     * just extend the gesture (RESCAN_GESTURE_TICKS, decayed in
                     * tick()) so one flick can't queue several rescans. */
                    if (rescanKnobCooldown <= 0) fireRescan();
                    rescanKnobCooldown = RESCAN_GESTURE_TICKS;
                }
                return;
            }

            case KNOB4: {   /* CC 74 — RANDOM: Source (KIT/SYSTEM: readout / door, no knob) */
                if (PAGES[pageIndex] !== 'RANDOM') return;
                const delta = decodeDelta(d2);
                if (delta === 0) return;
                /* Source enum — cycles User -> Core -> Both (§13.2). Same tick
                 * accumulation as Duplicates. */
                srcKnobTicks += delta;
                if (Math.abs(srcKnobTicks) < ENUM_KNOB_TICKS) return;
                const dir = srcKnobTicks > 0 ? 1 : -1;
                srcKnobTicks = 0;
                const at = SOURCE_MODES.indexOf(sourceMode);
                const nextMode = SOURCE_MODES[(at + dir + SOURCE_MODES.length) % SOURCE_MODES.length];
                if (nextMode !== sourceMode) {
                    sourceMode = nextMode;
                    refreshIndexView();   // SYSTEM counts follow the chosen Source
                    footer = `Source: ${SOURCE_LABEL[sourceMode]}`;
                    needsRedraw = true;
                }
                return;
            }

            case MoveMainButton:
                /* Jog-press acts on the page's focus. RANDOM, SYSTEM and
                 * EXPORT all carry a door instead of a direct action: closed,
                 * a click opens it; open, a click acts on the highlighted row
                 * — there is no Back to fall back on inside an overtake module
                 * (suspend_keeps_js hands it to the host, see Stage 1), so the
                 * door has to close on its own click. A TERMINAL action closes
                 * it (RANDOM's fire, EXPORT's Export now); a non-terminal one
                 * doesn't, so a checkbox row can be toggled repeatedly without
                 * reopening (EXPORT), and SYSTEM's read-only report just closes
                 * on any click since there's nothing there to act on.
                 *   KIT -> Clear Pad
                 * A held flag drives the on-screen button; fires on press only. */
                if (d2 > 0 && !assignHeld) {
                    assignHeld = true;
                    const pg = PAGES[pageIndex];
                    if (pg === 'RANDOM') {
                        if (doorOpen) { fireRandomAction(); doorOpen = false; }
                        else doorOpen = true;
                    } else if (pg === 'KIT') {
                        fireClearPad();
                    } else if (pg === 'SYSTEM') {
                        if (doorOpen) doorOpen = false;
                        else { doorOpen = true; systemInfoSel = 0; }
                    } else if (pg === 'EXPORT') {
                        if (doorOpen) {
                            const terminal = EXPORT_ROWS[exportSel].id === '__now';
                            fireExportAction();
                            if (terminal) doorOpen = false;
                        } else {
                            doorOpen = true;
                        }
                    }
                    needsRedraw = true;
                } else if (d2 === 0 && assignHeld) {
                    assignHeld = false;
                    needsRedraw = true;
                }
                return;

            default:
                return;
        }
    }
};

globalThis.onMidiMessageExternal = function (_data) {
    /* Stage 1: no USB-A device handling. */
};

/* ------------------------------------------------------------------ *
 * Drawing
 *
 * Layout budget (128x64): left margin MX, right edge RX. The Move panel
 * crops a few columns at each edge, so keep a real margin — text at x=2 gets
 * clipped on the left. Every content line is passed through clamp() so nothing
 * runs off either side.
 * ------------------------------------------------------------------ */

const MX = 6;          // left margin
const RX = 122;        // right edge (usable)

/* Shared chrome puts the header in rows 0..6 and the hint footer in 57..63,
 * so every page body lives between — the same knob-grid band schwung's own
 * param pages draw into (PARAM_PAGES.md, render_page_movy.mjs): four 32px
 * columns, a row of controls at BODY_TOP with its label below, a second row
 * lower down. RANDOM and SYSTEM each give half that grid to a DOOR instead of
 * knobs — see doorOpen above. */
const BODY_TOP = 10;
const BODY_BOTTOM = 55;
const CELL_W = 32;
const LBL0_Y = BODY_TOP + 15;   // row-0 widgets are ~15px tall; label goes under
const ROW1_Y = 33;
const LBL1_Y = ROW1_Y + 15;
function cellCX(col) { return col * CELL_W + CELL_W / 2; }

function tw(s) {
    return (typeof text_width === 'function') ? text_width(String(s)) : String(s).length * 5;
}
function clamp(s, maxPx) {
    let t = String(s);
    if (tw(t) <= maxPx) return t;
    while (t.length > 1 && tw(t + '..') > maxPx) t = t.slice(0, -1);
    return t + '..';
}
function line(x, y, s) {
    print(x, y, clamp(s, RX - x), 1);
}
/* Every centered label goes through here — clamped to the same MX/RX margin
 * `line()` uses, so a word too wide for its cell (or centred near the panel's
 * own edge, which crops before x=MX) shifts in from that edge instead of
 * running off it. Only the POSITION moves; nothing is truncated. */
function centerPrint(cx, y, s) {
    const w = tw(s);
    let x = Math.round(cx - w / 2);
    if (x < MX) x = MX;
    else if (x + w > RX) x = Math.max(MX, RX - w);
    print(x, y, s, 1);
}

/* ---- knob-grid widgets (PARAM_PAGES.md vocabulary, drawn with the native
 * fill_rect / draw_line / draw_circle / draw_arc bindings js_display.c gives
 * every module — the same primitives schwung's own render_page_movy.mjs
 * reaches for when it has them). ------------------------------------------- */

function frameRect(x, y, w, h, fg) {
    fg = fg === undefined ? 1 : fg;
    fill_rect(x, y, w, 1, fg);
    fill_rect(x, y + h - 1, w, 1, fg);
    fill_rect(x, y, 1, h, fg);
    fill_rect(x + w - 1, y, 1, h, fg);
}
/* The one idiom every framed widget below wears: clear the four corner
 * pixels so a filled/framed rect reads as a rounded plate, not a hard box.
 * `fg` is the frame's own colour — the notch clears to whatever's behind it. */
function notchCorners(x, y, w, h, fg) {
    const bg = (fg === undefined ? 1 : fg) ? 0 : 1;
    fill_rect(x, y, 1, 1, bg);
    fill_rect(x + w - 1, y, 1, 1, bg);
    fill_rect(x, y + h - 1, 1, 1, bg);
    fill_rect(x + w - 1, y + h - 1, 1, 1, bg);
}

const BOX_H = 15;

/* A short list, 3+ options: a notched frame sized to the value, the value
 * printed inside it. Src, Loop, Max size. */
function drawEnumSquare(cx, topY, text) {
    const w = Math.max(20, Math.min(CELL_W - 4, tw(text) + 8));
    const x = Math.round(cx - w / 2);
    frameRect(x, topY, w, BOX_H);
    notchCorners(x, topY, w, BOX_H);
    print(Math.round(cx - tw(text) / 2), topY + 4, text, 1);
}

const ARC_START_DEG = 230, ARC_SWEEP_DEG = 260;     // the track — open at the bottom
const KNOB_START_DEG = 225, KNOB_SWEEP_DEG = 270;   // the pointer's travel

/* A turnable value: an open arc (the gap marks the ends of travel) with a
 * pointer floating between hub and rim. Pad, Gain. `val` is 0..1. */
function drawKnob(cx, topY, val) {
    const r = 6, cy = topY + 7;
    draw_arc(cx, cy, r, ARC_START_DEG, ARC_SWEEP_DEG);
    const deg = KNOB_START_DEG + Math.max(0, Math.min(1, val)) * KNOB_SWEEP_DEG;
    const rad = deg * Math.PI / 180;
    const sin = Math.sin(rad), cos = Math.cos(rad);
    draw_line(Math.round(cx + r * 0.15 * sin), Math.round(cy - r * 0.15 * cos),
              Math.round(cx + r * 0.82 * sin), Math.round(cy - r * 0.82 * cos));
}

/* A momentary: a circle, filled while it's doing its thing. Rescan — fired by
 * turning its knob, not by clicking the widget (see KNOB3 below), so "filled"
 * here means "a scan is running" rather than "just clicked". */
function drawTrigger(cx, topY, active) {
    const r = 6, cy = topY + 7;
    if (active) fill_circle(cx, cy, r); else draw_circle(cx, cy, r);
}

/* A door: no knob, a way in. Broken right edge + a chevron in the gap, a
 * title, and as many preview lines as fit — the same shape as an opaque box,
 * stretched to hold a whole list's worth of preview instead of one value. */
/* The door's own frame: a notched box with its right edge broken by a
 * chevron — "no knob here, only a way in". Shared by every door on the
 * grid; each page draws its own content inside it. */
function drawDoorFrame(x, y, w, h) {
    const gapY = y + Math.floor(h / 2) - 2;
    fill_rect(x, y, w, 1, 1);
    fill_rect(x, y + h - 1, w, 1, 1);
    fill_rect(x, y, 1, h, 1);
    fill_rect(x + w - 1, y, 1, gapY - y, 1);
    fill_rect(x + w - 1, gapY + 5, 1, y + h - (gapY + 5), 1);
    notchCorners(x, y, w, h);
    for (let i = 0; i < 3; i++) {
        fill_rect(x + w - 6 + i, gapY + i, 1, 1, 1);
        fill_rect(x + w - 6 + i, gapY + 4 - i, 1, 1, 1);
    }
}

/* A door showing static preview TEXT — RANDOM's action list, SYSTEM's index
 * report. EXPORT's door instead draws its own checkbox rows straight into a
 * drawDoorFrame (see drawExportPage) since a plain text line can't show a
 * checkbox. */
function drawDoorPreview(x, y, w, h, title, previewLines) {
    drawDoorFrame(x, y, w, h);
    print(x + 3, y + 2, clamp(title, w - 10), 1);
    for (let i = 0; i < previewLines.length; i++) {
        print(x + 3, y + 12 + i * 8, clamp(previewLines[i], w - 6), 1);
    }
}

function drawCheckbox(x, y, on, inverted) {
    const fg = inverted ? 0 : 1;
    frameRect(x, y, 5, 5, fg);
    notchCorners(x, y, 5, 5, fg);
    if (on) fill_rect(x + 1, y + 1, 3, 3, fg);
}

/* The inverted-pill style: a filled notched plate with the text knocked out —
 * used for the KIT page's sample name, the one piece of text on these pages
 * that's a VALUE worth setting apart from its label. */
function drawInvertedPill(x, y, w, text) {
    const h = 9;
    fill_rect(x, y, w, h, 1);
    notchCorners(x, y, w, h);
    print(x + 3, y + 1, clamp(text, w - 6), 0);
}

/* Top strip — shared movy header: kit name left, page name right. */
function drawHeader() {
    drawMenuHeader(currentKitName || 'Kit Builder', seqMode ? 'SEQ' : PAGES[pageIndex]);
}

/* Bottom strip — shared hint pills, per page. Each hint is "Key: action" —
 * drawMenuFooter inverts only the key into its pill and prints the action
 * plain beside it (menu_layout.mjs's drawFooter). A bare [key, action] pair
 * has no colon to split on and collapses into one pill with the action lost,
 * which is what this used to pass. */
function drawPageFooter() {
    let hints;
    if (seqMode) {
        hints = ['Step: edit', 'K1: pad', `Play: ${seqRunning ? 'stop' : 'run'}`, 'Rec: close'];
    } else if (PAGES[pageIndex] === 'RANDOM') {
        hints = doorOpen
            ? ['Jog: sel', `Clk: ${RANDOM_ACTIONS[randomSel].name}`]
            : ['Jog: page', 'Clk: open', 'K3: dup', 'K4: src'];
    } else if (PAGES[pageIndex] === 'KIT') {
        hints = ['Jog: page', 'Pad: select', 'K1: gain', 'Up/Dn: fav/rej'];
    } else if (PAGES[pageIndex] === 'SYSTEM') {
        hints = doorOpen
            ? ['Jog: scroll', 'Clk: close']
            : ['Jog: page', 'K3: scan', 'Clk: info'];
    } else { // EXPORT
        hints = doorOpen
            ? [`Clk: ${EXPORT_ROWS[exportSel].id === '__now' ? 'export' : 'toggle'}`, 'Jog: sel']
            : ['Jog: page', 'Clk: open', 'Up/Dn: sel'];
    }
    drawMenuFooter(hints);
}

/* RANDOM, door closed: the action list previews inside the door (cells
 * K1/K2/K5/K6, x0..64); Dup (K3) and Src (K4) are ordinary widgets; Asn/Lck
 * are a plain readout under them (K7/K8). Door open is drawn by drawUI(). */
function drawRandomPage() {
    const doorH = 53 - BODY_TOP;
    const maxLines = 4;
    const start = Math.max(0, Math.min(RANDOM_ACTIONS.length - maxLines, randomSel - 1));
    const preview = [];
    for (let i = start; i < Math.min(RANDOM_ACTIONS.length, start + maxLines); i++) {
        const label = RANDOM_ACTIONS[i].name + (newArmed > 0 && RANDOM_ACTIONS[i].name === 'New' ? ' ?' : '');
        preview.push((i === randomSel ? '>' : ' ') + label);
    }
    drawDoorPreview(0, BODY_TOP, 2 * CELL_W, doorH, 'Actions', preview);

    drawEnumSquare(cellCX(2), BODY_TOP, preventDuplicates ? 'AVOID' : 'ALLOW');
    centerPrint(cellCX(2), LBL0_Y, 'Dup');

    drawEnumSquare(cellCX(3), BODY_TOP, SOURCE_LABEL[sourceMode].toUpperCase());
    centerPrint(cellCX(3), LBL0_Y, 'Src');

    /* Value on top, label on bottom — the same order every knob widget uses,
     * so a plain readout doesn't read as a different kind of thing. Tighter
     * than LBL1_Y's usual gap on purpose: the pair reads as one unit and
     * separate from Dup/Src above it, rather than drifting down to meet them. */
    centerPrint(cellCX(2), ROW1_Y + 3, `${assignedCount()}/16`);
    centerPrint(cellCX(2), ROW1_Y + 12, 'Asn');
    centerPrint(cellCX(3), ROW1_Y + 3, `${lockedCount()}/16`);
    centerPrint(cellCX(3), ROW1_Y + 12, 'Lck');
}

/* KIT — Gain is the one knob (K1); pressing a pad selects it directly, so
 * cell 2 is just a "which pad" readout, no knob of its own. K3/K4 carry a
 * readout (the sample's fav/reject standing normally, the sequencer's own
 * status while editing); row 2 is the pool and, in the inverted-pill style,
 * the sample name. No lock indicator — the pad LED already carries it. */
function drawKitPage() {
    const p = kit.pads[selectedPad];
    const gain = (p.playback && p.playback.gain != null) ? p.playback.gain : 1;
    const pool = padPool(p.pad, config);

    /* No Pad-select knob — pressing a pad already selects it (onPadPress), so
     * a knob doing the same thing would be a second control for one action.
     * Gain takes the freed knob 1 / cell 1 seat; its value is a peek (a short
     * overlay while the knob turns, see KNOB1 below), same as a plain schwung
     * knob — the cell itself only ever shows the label. */
    drawKnob(cellCX(0), BODY_TOP, Math.max(0, Math.min(1, gain / 2)));
    centerPrint(cellCX(0), LBL0_Y, 'Gain');

    centerPrint(cellCX(1), BODY_TOP + 4, String(p.pad));
    centerPrint(cellCX(1), LBL0_Y, 'Pad');

    const rx = 2 * CELL_W + 4;
    if (seqMode) {
        let n = 0, m = seqPattern[selectedPad];
        while (m) { n += m & 1; m >>= 1; }
        line(rx, BODY_TOP + 2,  `Seq: ${n} step${n === 1 ? '' : 's'}`);
        line(rx, BODY_TOP + 11, seqRunning ? `Playing - step ${seqStep + 1}` : 'Stopped');
    } else {
        let standing = '-';
        if (p.sample) {
            const fp = p.sample.filesystem_path;
            standing = favourites.has(fp) ? 'FAV' : rejects.has(fp) ? 'REJ' : '-';
        }
        line(rx, BODY_TOP + 2,  `Sample: ${standing}`);
        line(rx, BODY_TOP + 11, `R${rejects.size} F${favourites.size}`);
    }

    line(MX, ROW1_Y + 2, `Pool  ${pool.join('/')}`);
    if (p.sample) {
        const st = slotStat.charAt(selectedPad);
        const tag = st === 'm' ? '(missing) ' : st === 'x' ? '(bad file) ' : st === '.' ? '(loading) ' : '';
        drawInvertedPill(MX, ROW1_Y + 10, RX - MX, tag + p.sample.filename);
    } else {
        line(MX, ROW1_Y + 12, 'empty - hold pad + Assign');
    }
}

/* SYSTEM — Loop (K1) and Max size (K2) are enum squares; Rescan sits at K5
 * (row 2) so the whole right half (K3/K4/K7/K8) is free for the info door.
 * Turning K3 fires Rescan regardless of where its widget is drawn — the
 * label says so, because that decoupling isn't otherwise guessable. */
function drawSystemPage() {
    drawEnumSquare(cellCX(0), BODY_TOP, scanPrefs.skip_loops ? 'SKIP' : 'KEEP');
    centerPrint(cellCX(0), LBL0_Y, 'Loop');

    drawEnumSquare(cellCX(1), BODY_TOP, scanSizeLabel().toUpperCase());
    /* Stacked, not "Max size" side by side — two words at once overflows a
     * 32px cell into its neighbours. */
    centerPrint(cellCX(1), LBL0_Y,     'Max');
    centerPrint(cellCX(1), LBL0_Y + 8, 'size');

    drawTrigger(cellCX(0), ROW1_Y, !!scan);
    centerPrint(cellCX(0), LBL1_Y, 'Scan');   // fired by K3 — see the footer hint

    const rows = systemInfoRows();
    const preview = rows.slice(0, 4).map((r) => `${r.label} ${r.value}`);
    drawDoorPreview(2 * CELL_W, BODY_TOP, 2 * CELL_W, 53 - BODY_TOP, 'Index', preview);
}

/* EXPORT — checkbox on the left, the format's name beside it; Export now
 * drops the checkbox for a pill, so it reads as an action, not a toggle. */
/* The rows themselves — checkbox + label, Export now as a pill with no
 * checkbox — shared by the door closed (condensed, framed) and open (full
 * width, no frame) renders; only the geometry differs between the two. */
function drawExportRows(x0, y0, rowH, rightEdge) {
    let y = y0;
    for (let i = 0; i < EXPORT_ROWS.length; i++) {
        const row = EXPORT_ROWS[i];
        const sel = i === exportSel;
        if (row.id === '__now') {
            const w = tw(row.label) + 10;
            if (sel) fill_rect(x0, y - 1, w, 9, 1); else frameRect(x0, y - 1, w, 9);
            notchCorners(x0, y - 1, w, 9);
            print(x0 + 5, y, row.label, sel ? 0 : 1);
        } else {
            const hlX = Math.max(0, x0 - 2);
            if (sel) fill_rect(hlX, y - 1, rightEdge - hlX + 2, 9, 1);
            drawCheckbox(x0, y, !!exportPrefs[row.id], sel);
            print(x0 + 9, y, clamp(row.label, rightEdge - (x0 + 9)), sel ? 0 : 1);
        }
        y += rowH;
    }
}

/* EXPORT, door closed: nothing else uses these knobs, so the whole body is
 * one door — rows condensed to fit inside the frame. Door open (drawUI)
 * drops the frame and gives the same rows the full width. */
function drawExportPage() {
    drawDoorFrame(0, BODY_TOP, 128, 53 - BODY_TOP);
    drawExportRows(8, BODY_TOP + 4, 10, 118);
}

/* Status toast — a shared overlay card. Held ~11 s, then dismissable by any
 * input, but only after a short grace so the press that raised it can't clear
 * it. Every shared call is typeof-guarded: if an older menu_layout lacks the
 * overlay API the toast just no-ops instead of killing the handler. */
let footerShown = null;
let toastGrace = 0;
const TOAST_TICKS = 480;   // ~11 s
const TOAST_GRACE_TICKS = 20;

function showToast(msg) {
    if (typeof showOverlay === 'function') showOverlay(msg, '', TOAST_TICKS);
    footerShown = msg;
    toastGrace = TOAST_GRACE_TICKS;
}
function toastActive() {
    return typeof isOverlayActive === 'function' && isOverlayActive();
}

function drawUI() {
    clear_screen();
    drawHeader();
    if (seqMode) {
        drawKitPage();
    } else if (doorOpen && PAGES[pageIndex] === 'RANDOM') {
        /* The door open, full-screen: the shared list widget every other menu
         * in schwung uses, so scrolling and firing look like the rest of the
         * fleet, not a bespoke overlay. */
        drawMenuList({
            items: RANDOM_ACTIONS,
            selectedIndex: randomSel,
            getLabel: (a) => a.name + (newArmed > 0 && a.name === 'New' ? ' ?' : ''),
            listArea: { topY: BODY_TOP, bottomY: BODY_BOTTOM }
        });
    } else if (doorOpen && PAGES[pageIndex] === 'SYSTEM') {
        drawMenuList({
            items: systemInfoRows(),
            selectedIndex: systemInfoSel,
            getLabel: (r) => r.label,
            getValue: (r) => r.value,
            listArea: { topY: BODY_TOP, bottomY: BODY_BOTTOM }
        });
    } else if (doorOpen && PAGES[pageIndex] === 'EXPORT') {
        /* Open: the frame drops away and the same rows get the full width —
         * checkboxes stay checkboxes rather than switching to the generic
         * list widget's value column. */
        drawExportRows(MX, BODY_TOP + 2, 11, RX);
    } else {
        switch (PAGES[pageIndex]) {
            case 'RANDOM': drawRandomPage(); break;
            case 'KIT':    drawKitPage();    break;
            case 'SYSTEM': drawSystemPage(); break;
            case 'EXPORT': drawExportPage(); break;
        }
    }
    drawPageFooter();
    /* Transient status -> a shared overlay card. `footer` is still set all over
     * the code; here it just feeds the toast. */
    if (footer && footer !== footerShown) showToast(footer);
    if (typeof drawOverlay === 'function') drawOverlay();
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

globalThis.init = function () {
    console.log(`${MODULE_TAG}: init (v${VERSION})`);

    shiftHeld = false;
    pageIndex = 0;
    selectedPad = 0;
    randomSel = 0;
    preventDuplicates = true;
    sourceMode = 'user';
    dupKnobTicks = 0;
    srcKnobTicks = 0;
    doorOpen = false;
    systemInfoSel = 0;
    rescanKnobCooldown = 0;
    assignHeld = false;
    assignInFlight = 0;
    assignFireCount = 0;
    assignDroppedCount = 0;
    newArmed = 0;
    lastStepIdx = -1;
    heldPad = -1;
    for (const fx of padFx) { fx.flash = 0; fx.failFlash = 0; }
    footer = 'Kit Builder ready';
    footerShown = null;

    /* E2 — start with the sequencer fully stopped and empty, in case the DSP
     * carried a run flag / lanes across a reload. */
    seqReset();
    dspSet('seq_run', '0');

    /* Stage 2: load config, then any cached sample index (§3.1 steps 1-2). */
    scan = null;
    config = loadConfig();
    indexInfo = loadIndex();
    refreshIndexView();

    /* Batch C: library-wide reject / favourite memory. */
    const prefs = loadPrefs();
    rejects = prefs.rejects;
    favourites = prefs.favourites;

    /* Batch D: which exporters a Save runs. */
    exportPrefs = loadExportPrefs();
    exportSel = 0;

    /* Batch F: SYSTEM-page scan filters. */
    scanPrefs = loadScanPrefs();

    /* Restore the last working kit if there is one (Sam's request — reverses
     * the §3.1 "always blank" default; New gives a fresh slate). Missing
     * sample files are flagged, not dropped (§8.6). */
    const restored = loadCurrentKit();
    if (restored.ok) {
        kit = restored.kit;
        const gone = markMissingSamples(kit);
        currentKitName = kit.name && kit.name.length ? kit.name : null;
        console.log(`${MODULE_TAG}: restored working kit "${kit.name}" — ${assignedCount()} pads, ${gone} missing`);
    } else {
        kit = createKit(config);
        currentKitName = null;
    }

    /* Stage 4: hand the kit's samples to the audition player. */
    soundingMask = 0;
    slotStat = '----------------';
    statPollTick = 0;
    mutedForPark = false;
    dspSet('mute', '0');   // defensive — a prior session could have left this DSP muted (park)
    dspSet('clear_all', '1');
    syncAllSlots();
    if (indexInfo) {
        console.log(`${MODULE_TAG}: cached index loaded — ${indexSummary.indexed} files (${indexAgeText})`);
    } else {
        console.log(`${MODULE_TAG}: no cached index — Rescan on the System page to build one`);
    }

    clear_screen();
    host_flush_display();

    /* Host cleared LEDs before handing us the surface; repaint ours
     * progressively. resetKnobLedCache too — it's knob_leds.mjs's own cache,
     * which can outlive an unload/reload within one shadow_ui session. */
    clearAllLEDs();
    resetKnobLedCache();
    requestFullLedRepaint();

    stopBackgroundTransport();

    needsRedraw = true;
};

globalThis.tick = function () {
    /* While parked (Back pressed, module in background) the host calls this
     * with the draw/LED bindings stubbed to no-ops, but it keeps calling it —
     * this module's JS, and its DSP, are still alive (suspend_keeps_js). Mute
     * once on the way in (see mutedForPark above) so a track that starts
     * playing while we're backgrounded can't make our pads sound off-screen;
     * everything else stays frozen until onResume(). */
    if (globalThis.overtakeParked) {
        if (!mutedForPark) { mutedForPark = true; dspSet('mute', '1'); }
        return;
    }

    /* The Save keyboard draws its own screen and manages its own pad LEDs. */
    if (isTextEntryActive()) { tickTextEntry(); drawTextEntry(); return; }

    /* Knob-ring LEDs: cheap to call every tick — updateKnobLEDs diffs against
     * its own cache and only emits the knobs that actually changed colour. */
    updateKnobLEDs(knobLedValues());

    if (toastGrace > 0) toastGrace--;
    if (typeof tickOverlay === 'function' && tickOverlay()) needsRedraw = true;   // toast timed out

    if (ledInitPending) setupLedBatch();

    /* Re-assert LEDs (forced) for a while after a resume — see RESUME_PAINT_FRAMES. */
    if (resumePaints > 0) {
        if (resumePaints % 6 === 0) paintAllLeds(true);
        resumePaints--;
    }

    /* Pump the sample-index scan in bounded chunks (Stage 2). */
    if (scan) pumpScan();

    /* Stage 4: follow the audition player. `sounding` every frame (cheap),
     * `slot_status` occasionally. Repaint pads whose lit state changed. */
    if (pollSounding()) { paintPads(); needsRedraw = true; }
    if (++statPollTick >= 15) { statPollTick = 0; pollSlotStatus(); }

    /* E2: heartbeat so the DSP sequencer only sounds while we're foreground;
     * follow the playhead for the step-LED walk + the SEQ page readout. */
    if (seqRunning) {
        dspSet('seq_fg', '1');
        if (++seqPollTick >= 2) {
            seqPollTick = 0;
            const v = String(dspGet('seq') || '').split(' ');
            const run = v[0] === '1';
            const st = parseInt(v[1], 10);
            if (Number.isFinite(st) && st !== seqStep) {
                seqStep = st;
                if (seqMode) paintStepLeds();
                if (seqMode) needsRedraw = true;
            }
            if (!run && seqRunning) {   // DSP paused itself (shouldn't happen foreground)
                seqRunning = false;
                setButtonLED(MovePlay, Black, true);
                paintStepLeds();
                needsRedraw = true;
            }
        }
    }

    /* Decay per-pad LED effects (sounding flash, assignment-failure flash). */
    for (let i = 0; i < PAD_COUNT; i++) {
        const fx = padFx[i];
        if (fx.flash > 0 || fx.failFlash > 0) {
            if (fx.flash > 0) fx.flash--;
            if (fx.failFlash > 0) fx.failFlash--;
            if (fx.flash === 0 && fx.failFlash === 0) { paintPad(i); needsRedraw = true; }
        }
    }

    /* Wind down the Assign in-flight guard (spec §10.7) and the New confirm. */
    if (assignInFlight > 0) assignInFlight--;
    if (rescanKnobCooldown > 0) rescanKnobCooldown--;
    if (suppressPlayEcho > 0) suppressPlayEcho--;
    if (stopTransportRelease > 0 && --stopTransportRelease === 0) {
        if (typeof move_midi_inject_to_move === 'function') {
            move_midi_inject_to_move([0x0B, 0xB0, MovePlay, 0]);
        }
    }
    if (newArmed > 0 && --newArmed === 0) { footer = 'New cancelled'; needsRedraw = true; }

    if (needsRedraw) {
        drawUI();
        needsRedraw = false;
    }
};

/* Called each time the module is brought back after a plain-Back suspend
 * (capabilities.suspend_keeps_js). init() is NOT re-run, so all state — pad
 * locks, current page, Assign counters — is exactly as the user left it.
 * Only the hardware surface needs restoring: LEDs were cleared while parked
 * and the display was Move's, so drop the LED cache and force a full repaint. */
globalThis.onResume = function () {
    console.log(`${MODULE_TAG}: onResume (state preserved)`);
    /* Transient input state can't survive a park cleanly. */
    shiftHeld = false;
    assignHeld = false;
    heldPad = -1;
    dupKnobTicks = 0;
    srcKnobTicks = 0;
    doorOpen = false;
    rescanKnobCooldown = 0;
    footer = 'Resumed';
    refreshIndexView();   /* index age is relative to now */

    /* E2 (Sam's call): the sequencer comes back STOPPED after a park, playhead
     * at step 1. The pattern + edit view are kept. */
    if (seqRunning) { seqRunning = false; seqStep = 0; footer = 'Resumed — seq stopped'; }

    /* Undo the park mute (see mutedForPark above) unconditionally — even if
     * our own flag is somehow out of sync, a real park always muted, and
     * un-muting an already-unmuted DSP is a harmless no-op. */
    mutedForPark = false;
    dspSet('mute', '0');

    /* The overtake DSP may have been reloaded (fresh, empty) while parked —
     * re-push the kit's samples + the pattern. */
    soundingMask = 0;
    syncAllSlots();
    dspSet('seq_run', '0');
    for (let i = 0; i < PAD_COUNT; i++) {
        if (seqPattern[i]) dspSet('seq_lane_' + i, String(seqPattern[i]));
    }

    /* Hardware was cleared while parked. Drop the LED cache so nothing is
     * suppressed, then repaint our whole surface now (not deferred), and
     * again on the next few frames. resetKnobLedCache is knob_leds.mjs's own
     * cache, dropped for the same reason — it survives a ui.js hot-reload
     * since it lives in the shared module, not in ours. */
    invalidateLedCache();
    resetKnobLedCache();
    paintAllLeds(true);
    resumePaints = RESUME_PAINT_FRAMES;
    ledInitPending = false;   /* supersede any half-done progressive batch */

    clear_screen();
    host_flush_display();

    stopBackgroundTransport();

    needsRedraw = true;
};

globalThis.onUnload = function () {
    console.log(`${MODULE_TAG}: onUnload`);
    /* Keep the working kit so a relaunch restores it (Sam's request). */
    persistWorkingKit();
    clearAllLEDs();
};
