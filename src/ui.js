/*
 * Kit Builder — Overtake module
 * ------------------------------------------------------
 * MVP spec: docs/KIT_BUILDER_SPEC.md
 *
 * Stage 1 (spec §23 / §27) — hardware shell:
 *   - opens as an overtake module; receives pad + Shift+Pad events
 *     (left 4x4 drum-rack block -> Kit Builder pads 1-16)
 *   - drives RGB pad LEDs; Shift+Pad toggles a visual-only lock
 *   - jog-wheel TURN moves between pages (RANDOM / KIT / SYSTEM)
 *   - jog-wheel PRESS is the page's momentary button
 *   - Back parks the module with state intact (capabilities.suspend_keeps_js);
 *     Shift+Back fully exits. onResume() repaints on unpark.
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
 *   - RANDOM page: Up/Down pick an action, jog-press fires it —
 *       Assign      = seeded random fill of every unlocked pad, ascending pad
 *                     order, duplicate-avoided, current-sample-avoided (§10.2)
 *       Clear       = empty every unlocked pad (§13.2)
 *       Unlock All  = drop every lock (§13.2)
 *     Knob 3 turn toggles Duplicates (Avoid / Allow). All momentary actions
 *     honour the §10.7 in-flight guard.
 *   - KIT page: Knob 1 selects a pad, jog-press = Clear Pad (§13.3)
 *   - LEDs: green = assigned+unlocked, white = assigned+locked, teal = empty,
 *     dim white = empty+locked, red flash = a role had no candidate (§12)
 *   Core logic: core/kit_model.mjs, core/random_assign.mjs, core/sample_index.mjs.
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
 * Stage 6 (spec §16) — MrDrums export:
 *   - Save also writes an Ableton drum-rack `.ablpreset` to
 *     Move's Track Presets folder — the format the shipping MrDrums actually
 *     loads (instrumentRack -> drumRack -> one chain per assigned pad, gain as
 *     Volume dB, `ableton:/user-library/` %-encoded sampleUri). See
 *     core/exporters/mrdrums_json.mjs. An export failure never touches the
 *     saved kit file (§16.5).
 *
 * NOT here yet: packaging (Stage 7).
 */

import {
    MidiNoteOn, MidiNoteOff, MidiCC,
    MoveShift, MoveBack, MoveMainButton, MoveMainKnob, MoveUp, MoveDown,
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
    loadConfig, loadIndex, createScan, summarize, summarizeRecords
} from './core/sample_index.mjs';

import {
    createKit, toggleLock, clearUnlocked, unlockAll, clearPad, setPadGain, gainToDbLabel,
    lockedCount as kitLockedCount, assignedCount as kitAssignedCount
} from './core/kit_model.mjs';

import { assignKit, rerollPad, randomSeed } from './core/random_assign.mjs';

import {
    saveKit, saveCurrentKit, loadCurrentKit, markMissingSamples, exportMrDrums,
    generatedKitName, nextKitNumber, commitKitNumber
} from './core/storage.mjs';

import {
    openTextEntry, isTextEntryActive, handleTextEntryMidi,
    tickTextEntry, drawTextEntry
} from '/data/UserData/schwung/shared/text_entry.mjs';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const MODULE_TAG = 'kit-builder';
const VERSION = '0.1.0';
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

const PAGES = ['RANDOM', 'KIT', 'SYSTEM'];

/* RANDOM-page action list — Up/Down (or step buttons 1..N) select, jog-press
 * or a step double-press fires (spec §13.2). Each has a step-button LED colour. */
const RANDOM_ACTIONS = [
    { name: 'Assign',     color: Green },
    { name: 'New',        color: Blue },
    { name: 'Save',       color: LightAmber },
    { name: 'Clear',      color: Red },
    { name: 'Unlock All', color: White }
];
const DOUBLE_PRESS_MS = 400;   // step-button double-press window
const ARM_TICKS = 390;         // ~9 s confirm window for New

/* Knob CCs used as encoder controls in this overtake shell. */
const KNOB_PAD_SELECT = MoveKnob1;   // 71 — KIT page: Selected Pad (§13.3 encoder 1)
const KNOB_SOURCE = MoveKnob1 + 1;   // 72 — knob 2 — RANDOM: Source (§13.2 encoder 2)
const KNOB_DUPLICATES = 73;          // knob 3 — RANDOM: Duplicates (§13.2 encoder 3)
const KNOB_GAIN = MoveKnob1 + 4;     // 75 — knob 5 — KIT page: per-pad Gain (§13.3)
const GAIN_STEP = 0.04;

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
 * a jog-press on the SYSTEM page (§13.4 "Rebuild"), with the §10.7 in-flight
 * guard. */
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

/* Step buttons 1..N carry the RANDOM action colours; the rest stay dark. */
function paintStepLeds() {
    for (let i = 0; i < MoveSteps.length; i++) {
        setLED(MoveSteps[i], i < RANDOM_ACTIONS.length ? RANDOM_ACTIONS[i].color : Black);
    }
}

/* Build the full LED list once; setupLedBatch feeds it out ≤8/frame. */
function buildLedList() {
    const leds = [];
    leds.push({ type: 'cc', id: MoveBack, color: WhiteLedDim });
    for (let i = 0; i < PAD_COUNT; i++) {
        leds.push({ type: 'note', id: KIT_PAD_NOTES[i], color: ledForPad(i) });
    }
    for (let i = 0; i < MoveSteps.length; i++) {
        leds.push({ type: 'note', id: MoveSteps[i], color: i < RANDOM_ACTIONS.length ? RANDOM_ACTIONS[i].color : Black });
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
    for (let i = 0; i < PAD_COUNT; i++) {
        setLED(KIT_PAD_NOTES[i], ledForPad(i), force);
    }
    for (let i = 0; i < RANDOM_ACTIONS.length; i++) {
        setLED(MoveSteps[i], RANDOM_ACTIONS[i].color, force);
    }
}

function requestFullLedRepaint() {
    ledList = buildLedList();
    ledInitIndex = 0;
    ledInitPending = true;
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
    selectedPad = index;   // KIT page follows the last-touched pad
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
        source: sourceMode, preventDuplicates
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
        source: sourceMode, preventDuplicates, padIndex: index
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
    persistWorkingKit();
    paintPads();
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
                /* §3.3: a save also writes the MrDrums export. */
                const ex = exportMrDrums(kit, res.name);
                if (ex.ok) {
                    footer = `${res.overwrote ? 'Updated' : 'Saved'}: ${res.name}` +
                        (ex.warnings.length ? ` (${ex.warnings.length} warn)` : '');
                    console.log(`${MODULE_TAG}: saved ${res.path}; exported ${ex.path} (${ex.padCount} pads, ${ex.warnings.length} warn)`);
                } else {
                    footer = `Kit saved, MrDrums export failed`;   // §17.3
                    console.log(`${MODULE_TAG}: saved ${res.path}; export failed — ${ex.errors.join(', ')}`);
                }
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
        case 'Assign':     fireAssign(); break;
        case 'New':        fireNew(); break;
        case 'Save':       fireSave(); break;
        case 'Clear':      fireClear(); break;
        case 'Unlock All': fireUnlockAll(); break;
    }
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
    indexAgeText = relativeAge(indexInfo && indexInfo.generated_at);
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
    scan = createScan(config);
    if (scan.state.phase === 'error') {
        finishScan();
        return;
    }
    footer = 'Scanning User Library...';
    console.log(`${MODULE_TAG}: rescan started root=${scan.state.root}`);
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
            records: st.records
        };
        refreshIndexView();
        footer = `Index rebuilt: ${indexSummary.indexed} files`;
        console.log(`${MODULE_TAG}: index rebuilt files=${indexSummary.indexed} dirs=${st.dirsVisited} ` +
            `kick=${indexSummary.kick} snare=${indexSummary.snare} hats=${indexSummary.hats} other=${indexSummary.other}`);
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

/* ------------------------------------------------------------------ *
 * MIDI
 * ------------------------------------------------------------------ */

globalThis.onMidiMessageInternal = function (data) {
    if (shouldFilterMessage(data)) return;

    /* The Save keyboard owns all input while open. */
    if (isTextEntryActive()) { handleTextEntryMidi(data); return; }

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
            if (isOn && stepIdx < RANDOM_ACTIONS.length) onStepAction(stepIdx);
            return;
        }

        const padIdx = KIT_PAD_NOTES.indexOf(d1);
        if (padIdx === -1) return;              // ignore the unused 16 pads
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

            /* Back is NOT handled here: with capabilities.suspend_keeps_js the
             * host owns it — plain Back parks this module in the background
             * (JS state + this tick loop kept alive), Shift+Back fully exits.
             * See onResume(). */

            case MoveMainKnob: {
                /* Jog-wheel turn = page navigation (RANDOM / KIT / SYSTEM).
                 * One page per detent regardless of turn speed. */
                const delta = decodeDelta(d2);
                if (delta !== 0) {
                    const dir = delta > 0 ? 1 : -1;
                    pageIndex = (pageIndex + dir + PAGES.length) % PAGES.length;
                    needsRedraw = true;
                }
                return;
            }

            case MoveUp:
            case MoveDown:
                /* RANDOM page: move the action selection (spec §13.2 row). */
                if (d2 > 0 && PAGES[pageIndex] === 'RANDOM') {
                    const dir = d1 === MoveDown ? 1 : -1;
                    randomSel = (randomSel + dir + RANDOM_ACTIONS.length) % RANDOM_ACTIONS.length;
                    needsRedraw = true;
                }
                return;

            case KNOB_DUPLICATES: {
                /* RANDOM page: Duplicates enum — CW = Allow, CCW = Avoid (§13.2). */
                if (PAGES[pageIndex] !== 'RANDOM') return;
                const delta = decodeDelta(d2);
                if (delta === 0) return;
                const next = delta < 0;   // CCW -> Avoid
                if (next !== preventDuplicates) {
                    preventDuplicates = next;
                    footer = `Duplicates: ${preventDuplicates ? 'Avoid' : 'Allow'}`;
                    needsRedraw = true;
                }
                return;
            }

            case KNOB_SOURCE: {
                /* RANDOM page: Source enum — cycles User -> Core -> User+Core (§13.2). */
                if (PAGES[pageIndex] !== 'RANDOM') return;
                const delta = decodeDelta(d2);
                if (delta === 0) return;
                const dir = delta > 0 ? 1 : -1;
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

            case KNOB_PAD_SELECT: {
                /* KIT page: Selected Pad 1..16 (spec §13.3 encoder 1). */
                if (PAGES[pageIndex] !== 'KIT') return;
                const delta = decodeDelta(d2);
                if (delta === 0) return;
                const dir = delta > 0 ? 1 : -1;
                selectedPad = Math.max(0, Math.min(PAD_COUNT - 1, selectedPad + dir));
                needsRedraw = true;
                return;
            }

            case KNOB_GAIN: {
                /* KIT page: per-pad gain trim (spec §13.3 encoder 5). */
                if (PAGES[pageIndex] !== 'KIT') return;
                const delta = decodeDelta(d2);
                if (delta === 0) return;
                const g = setPadGain(kit, selectedPad, (kit.pads[selectedPad].playback.gain || 1) + delta * GAIN_STEP);
                dspSet('slot_gain_' + selectedPad, g);
                persistWorkingKit();
                needsRedraw = true;   // gain shows on the KIT page itself
                return;
            }

            case MoveMainButton:
                /* Jog-press is the page's momentary button (Move's encoders
                 * don't physically click, so the jog stands in for the encoder
                 * buttons of spec §13.2 / §13.3 / §13.4):
                 *   RANDOM -> selected action   KIT -> Clear Pad   SYSTEM -> Rescan
                 * A held flag drives the on-screen button; fires on press only. */
                if (d2 > 0 && !assignHeld) {
                    assignHeld = true;
                    const pg = PAGES[pageIndex];
                    if (pg === 'RANDOM') fireRandomAction();
                    else if (pg === 'KIT') fireClearPad();
                    else if (pg === 'SYSTEM') fireRescan();
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
const SCREEN_W = 128;

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
function button(bx, by, bw, bh, label, active) {
    if (active) fill_rect(bx, by, bw, bh, 1);
    else draw_rect(bx, by, bw, bh, 1);
    print(bx + Math.max(2, Math.floor((bw - tw(label)) / 2)), by + Math.floor((bh - 7) / 2) + 1,
        label, active ? 0 : 1);
}

function drawHeader() {
    print(MX, 2, 'Kit Builder', 1);
    const pg = PAGES[pageIndex];
    print(RX - tw(pg), 2, pg, 1);
    fill_rect(0, 11, SCREEN_W, 1, 1);
}

/* The footer status line (separator y=52, text y=54) is drawn only on the
 * RANDOM page, where transient action results belong. Pages that keep it must
 * end their content by CONTENT_BOTTOM; footer-less pages get FULL_BOTTOM. */
const CONTENT_BOTTOM = 44;
const FULL_BOTTOM = 56;

function drawFooter() {
    fill_rect(0, 52, SCREEN_W, 1, 1);
    if (footer) print(MX, 54, clamp(footer, RX - MX), 1);
}

function drawRandomPage() {
    /* Action list — selected row inverted; jog-press (or step double-press)
     * fires it. Step buttons 1..N mirror this list. */
    for (let i = 0; i < RANDOM_ACTIONS.length; i++) {
        const y = 12 + i * 8;
        const label = RANDOM_ACTIONS[i].name + (newArmed > 0 && RANDOM_ACTIONS[i].name === 'New' ? '?' : '');
        if (i === randomSel) {
            fill_rect(0, y - 1, 62, 8, 1);
            print(MX, y, clamp(label, 56), 0);
        } else {
            print(MX, y, clamp(label, 56), 1);
        }
    }
    const rx = 70;
    line(rx, 12, `Dup ${preventDuplicates ? 'Avoid' : 'Allow'}`);
    line(rx, 20, `Src ${SOURCE_LABEL[sourceMode]}`);
    line(rx, 28, `Asn ${assignedCount()}/16`);
    line(rx, 36, `Lck ${lockedCount()}/16`);
    line(rx, 44, currentKitName || '(unsaved)');
}

function drawKitPage() {
    /* No footer here — a pad line would just repeat what the page shows.
     * Rows: pad+note / role / lock+gain / category / sample name (+status). */
    const p = kit.pads[selectedPad];
    const gain = (p.playback && p.playback.gain != null) ? p.playback.gain : 1;
    line(MX, 14, `Pad ${p.pad}   note ${p.midi_note}`);
    line(MX, 24, `Role   ${p.role}`);
    line(MX, 34, `Lock ${p.locked ? 'yes' : 'no'}     Gain ${gainToDbLabel(gain)}`);
    if (p.sample) {
        const cat = p.sample.category;
        line(MX, 44, cat && cat !== p.role ? `Drawn from  ${cat}` : `Category    ${cat || p.role}`);
        const st = slotStat.charAt(selectedPad);
        const tag = st === 'm' ? '(missing) ' : st === 'x' ? '(bad file) ' : st === '.' ? '(loading) ' : '';
        line(MX, 54, tag + p.sample.filename);
    } else {
        line(MX, 44, 'Sample  -  (empty pad)');
        line(MX, 54, 'hold pad + Assign to fill');
    }
}

function drawSystemPage() {
    /* No footer here either — the whole area is the index report. */
    const s = indexSummary;
    const scanning = !!scan;
    const cx = 74;
    button(MX, 13, 50, 12, scanning ? 'SCAN' : 'RESCAN', assignHeld && !scanning);
    line(MX + 56, 13, `Age ${indexAgeText}`);
    line(MX + 56, 22, `Src ${SOURCE_LABEL[sourceMode]}`);
    line(MX, 30, `Indexed ${s.indexed}`);  line(cx, 30, `Oth ${s.other}`);
    line(MX, 39, `Kick ${s.kick}`);        line(cx, 39, `Snr ${s.snare}`);
    line(MX, 48, `Clap ${s.clap}`);        line(cx, 48, `Hat ${s.hats}`);
    line(MX, FULL_BOTTOM, `Perc ${s.perc}`); line(cx, FULL_BOTTOM, `FX ${s.fx}`);
}

function drawUI() {
    clear_screen();
    drawHeader();
    switch (PAGES[pageIndex]) {
        case 'RANDOM': drawRandomPage(); drawFooter(); break;   // footer: RANDOM only
        case 'KIT':    drawKitPage();    break;
        case 'SYSTEM': drawSystemPage(); break;
    }
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
    assignHeld = false;
    assignInFlight = 0;
    assignFireCount = 0;
    assignDroppedCount = 0;
    newArmed = 0;
    lastStepIdx = -1;
    heldPad = -1;
    for (const fx of padFx) { fx.flash = 0; fx.failFlash = 0; }
    footer = 'Kit Builder ready';

    /* Stage 2: load config, then any cached sample index (§3.1 steps 1-2). */
    scan = null;
    config = loadConfig();
    indexInfo = loadIndex();
    refreshIndexView();

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
     * progressively. */
    clearAllLEDs();
    requestFullLedRepaint();

    needsRedraw = true;
};

globalThis.tick = function () {
    /* While parked (Back pressed, module in background) the host calls this
     * with the draw/LED bindings stubbed to no-ops. Do nothing — state is
     * frozen until onResume(). (Framework contract: check overtakeParked.) */
    if (globalThis.overtakeParked) return;

    /* The Save keyboard draws its own screen and manages its own pad LEDs. */
    if (isTextEntryActive()) { tickTextEntry(); drawTextEntry(); return; }

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
    footer = 'Resumed';
    refreshIndexView();   /* index age is relative to now */

    /* The overtake DSP may have been reloaded (fresh, empty) while parked —
     * re-push the kit's samples. */
    soundingMask = 0;
    syncAllSlots();

    /* Hardware was cleared while parked. Drop the LED cache so nothing is
     * suppressed, then repaint our whole surface now (not deferred), and
     * again on the next few frames. */
    invalidateLedCache();
    paintAllLeds(true);
    resumePaints = RESUME_PAINT_FRAMES;
    ledInitPending = false;   /* supersede any half-done progressive batch */

    clear_screen();
    host_flush_display();
    needsRedraw = true;
};

globalThis.onUnload = function () {
    console.log(`${MODULE_TAG}: onUnload`);
    /* Keep the working kit so a relaunch restores it (Sam's request). */
    persistWorkingKit();
    clearAllLEDs();
};
