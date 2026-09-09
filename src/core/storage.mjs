/*
 * Kit Builder — storage: native .kitbuilder.json working files, atomic-ish
 * writes, load + validate, kit-name generation (spec §3.3, §15).
 *
 * Uses host_* file APIs and QuickJS `os` when present; degrades cleanly under
 * node (for tests/test_storage.js, which injects an in-memory fs).
 */

import * as os from 'os';
import { KB_DIR, CONFIG_PATH } from './sample_index.mjs';
import { validateKit } from './validation.mjs';
import { exportKit as buildAndWriteExport } from '../exporters/mrdrums_json.mjs';

export const KITS_DIR = KB_DIR + '/Kits';
export const CURRENT_KIT_PATH = KB_DIR + '/current-kit.json';
/* Move's own Track Presets folder — an exported .ablpreset shows up in Move's
 * preset browser and can be loaded straight into MrDrums (Sam's call). */
export const MRDRUMS_EXPORT_DIR = '/data/UserData/UserLibrary/Track Presets';

/* ---- host shims (undefined under node) --------------------------------- */

function hRead(p)   { return (typeof host_read_file === 'function') ? host_read_file(p) : null; }
function hWrite(p, s){ return (typeof host_write_file === 'function') ? !!host_write_file(p, s) : false; }
function hExists(p) { return (typeof host_file_exists === 'function') ? !!host_file_exists(p) : false; }
function hMkdir(p)  { if (typeof host_ensure_dir === 'function') host_ensure_dir(p); }

/* ---- kit name (spec §3.3.1) ------------------------------------------- */

export function pad3(n) { return String(Math.max(0, n | 0)).padStart(3, '0'); }

export function todayIsoDate(now) {
    return (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
}

export function generatedKitName(counter, now) {
    return `Kit Builder ${pad3(counter)} ${todayIsoDate(now)}`;
}

/* ---- config.json counter (spec §3.3.1 / §15.3) ---------------------- */

/* Read config.json raw (preserving any user role overrides). */
export function readRawConfig() {
    try {
        const raw = hRead(CONFIG_PATH);
        if (raw) {
            const o = JSON.parse(raw);
            if (o && typeof o === 'object') return o;
        }
    } catch (e) { /* fall through */ }
    return {};
}

export function nextKitNumber() {
    const n = parseInt(readRawConfig().next_kit_number, 10);
    return (Number.isFinite(n) && n >= 1) ? n : 1;
}

/* Persist the counter so the NEXT save uses `used + 1`. Call only after a
 * successful save (§3.3.1). Returns the new value, or null on failure. */
export function commitKitNumber(used) {
    const cfg = readRawConfig();
    cfg.next_kit_number = (parseInt(used, 10) || 1) + 1;
    hMkdir(KB_DIR);
    return writeJsonAtomic(CONFIG_PATH, cfg) ? cfg.next_kit_number : null;
}

/* ---- filename sanitisation (spec §15.6) ----------------------------- */

export function sanitizeFilename(name) {
    let s = String(name == null ? '' : name);
    s = s.replace(/[\u0000-\u001f\u007f]/g, '');   // control characters
    s = s.replace(/\.{2,}/g, '.');                    // path-traversal runs
    s = s.replace(/[\/\\]/g, '');                   // path separators
    s = s.replace(/[<>:"|?*]/g, '_');                 // invalid filename chars
    s = s.replace(/^[.\s]+|\s+$/g, '');              // trim leading dot/space, trailing space
    if (!s) s = 'Kit Builder';                        // fallback
    return s;
}

/* ---- atomic-ish JSON write (spec §15.5) --------------------------- */

export function writeJsonAtomic(finalPath, obj) {
    let json;
    try { json = JSON.stringify(obj, null, 2); } catch (e) { return false; }
    const tmp = finalPath + '.tmp';
    if (!hWrite(tmp, json)) return false;
    try { JSON.parse(hRead(tmp)); } catch (e) { return false; }   // validate temp

    let renamed = false;
    try {
        if (os && typeof os.rename === 'function') {
            const rc = os.rename(tmp, finalPath);
            renamed = (rc === 0 || rc === undefined);
        }
    } catch (e) { renamed = false; }

    if (!renamed) {
        if (!hWrite(finalPath, json)) return false;
        try { if (os && typeof os.remove === 'function') os.remove(tmp); } catch (e) { /* ignore */ }
    }
    return true;
}

/* ---- save (spec §3.3, §15.1, §15.2) ------------------------------ */

function kitDoc(kit) {
    return JSON.parse(JSON.stringify(kit));   // plain copy; kit_model already matches §6
}

function uniquePath(baseNoExt, ext) {
    let p = baseNoExt + ext;
    if (!hExists(p)) return p;
    for (let i = 2; i < 1000; i++) {
        p = `${baseNoExt} (${i})${ext}`;
        if (!hExists(p)) return p;
    }
    return `${baseNoExt} (${Date.now()})${ext}`;
}

/*
 * saveKit(kit, name, overwriteName) -> { ok, path, name } | { ok:false, error }
 *
 * Writes the native working file and refreshes current-kit.json. Does NOT
 * touch the kit-name counter — the caller does that only on { ok:true }.
 *
 * If `overwriteName` is given and the (sanitised) new name equals it, the
 * existing `<name>.kitbuilder.json` is overwritten in place — this is how a
 * kit keeps one file across repeated saves of the same working session. A
 * changed name is a "save as": a new, non-colliding file.
 */
export function saveKit(kit, name, overwriteName) {
    const clean = sanitizeFilename(name || kit.name || 'Kit Builder');
    kit.name = clean;
    kit.modified_at = new Date().toISOString();

    const doc = kitDoc(kit);
    const bad = validateKit(doc);
    if (bad) return { ok: false, error: `invalid kit: ${bad}` };

    hMkdir(KITS_DIR);
    const same = overwriteName && sanitizeFilename(overwriteName) === clean;
    const path = same
        ? `${KITS_DIR}/${clean}.kitbuilder.json`
        : uniquePath(`${KITS_DIR}/${clean}`, '.kitbuilder.json');
    if (!writeJsonAtomic(path, doc)) return { ok: false, error: 'write failed' };

    saveCurrentKit(kit);   // diagnostics / restore-on-relaunch (§15.2)

    return { ok: true, path, name: clean, overwrote: !!same };
}

/* Persist the most-recently-edited state (spec §15.2). Called on save and on
 * every kit-changing action so an unsaved session survives a relaunch. */
export function saveCurrentKit(kit) {
    try {
        hMkdir(KB_DIR);
        return writeJsonAtomic(CURRENT_KIT_PATH, kitDoc(kit));
    } catch (e) { return false; }
}

export function loadCurrentKit() {
    return loadKit(CURRENT_KIT_PATH);
}

/* ---- MrDrums export (spec §16, §3.3, §24) ------------------------- */

/*
 * exportMrDrums(kit, name) -> { ok, path, warnings, errors, padCount }
 * Writes a MrDrums-loadable .ablpreset into Move's Track Presets folder. The
 * Kit Builder save is independent of this — an export failure never touches it.
 */
export function exportMrDrums(kit, name) {
    hMkdir(MRDRUMS_EXPORT_DIR);
    return buildAndWriteExport(kit, {
        dir: MRDRUMS_EXPORT_DIR,
        name: name || kit.name || 'Kit Builder',
        write: (p, s) => hWrite(p, s)
    });
}

/* ---- load + validate (spec §21.6 — storage-layer only) ------------ */

export function loadKitFromString(str) {
    let doc;
    try { doc = JSON.parse(str); } catch (e) { return { ok: false, error: `parse: ${e}` }; }
    const bad = validateKit(doc);
    if (bad) return { ok: false, error: `invalid: ${bad}` };
    return { ok: true, kit: doc };
}

export function loadKit(path) {
    if (!hExists(path)) return { ok: false, error: 'not found' };
    const raw = hRead(path);
    if (raw == null) return { ok: false, error: 'unreadable' };
    return loadKitFromString(raw);
}

/*
 * Flag pads whose sample file has gone missing WITHOUT dropping them (spec
 * §8.6, §21.6). `existsFn(path) -> bool` defaults to the host check.
 * Returns the count of missing samples.
 */
export function markMissingSamples(kit, existsFn) {
    const check = (typeof existsFn === 'function') ? existsFn : hExists;
    let missing = 0;
    for (const p of kit.pads) {
        if (p.sample && p.sample.filesystem_path) {
            const gone = !check(p.sample.filesystem_path);
            p.sample.missing = gone;
            if (gone) missing++;
        }
    }
    return missing;
}
