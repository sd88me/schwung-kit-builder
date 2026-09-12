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
import { stripWavString, isWavName } from './wav_strip.mjs';
import { wavFrameCount, base64Decode } from './wav_info.mjs';
import { exportKit as buildAndWriteExport } from '../exporters/mrdrums_json.mjs';
import { exportXpm as buildAndWriteXpm, MPC_EXPORT_ROOT } from '../exporters/mpc_xpm.mjs';

export const KITS_DIR = KB_DIR + '/Kits';
export const CURRENT_KIT_PATH = KB_DIR + '/current-kit.json';
/* Move's own Track Presets folder — an exported .ablpreset is the native Move
 * drum-rack preset format: it shows up in Move's own preset browser and also
 * loads straight into MrDrums. */
export const MRDRUMS_EXPORT_DIR = '/data/UserData/UserLibrary/Track Presets';

/* Which exporters a Save runs. Persisted in config.json under `exports`
 * (alongside next_kit_number). The Move drum preset (.ablpreset) is on by
 * default; the MPC .xpm and the Force push are opt-in. Batch D (+ Force push). */
export const EXPORT_IDS = ['mrdrums', 'mpcxpm', 'force'];
const EXPORT_DEFAULTS = { mrdrums: true, mpcxpm: false, force: false };

export function loadExportPrefs() {
    const e = readRawConfig().exports;
    const out = {};
    for (const id of EXPORT_IDS) {
        out[id] = (e && typeof e[id] === 'boolean') ? e[id] : EXPORT_DEFAULTS[id];
    }
    return out;
}

export function saveExportPrefs(prefs) {
    const cfg = readRawConfig();
    cfg.exports = cfg.exports || {};
    for (const id of EXPORT_IDS) if (prefs && typeof prefs[id] === 'boolean') cfg.exports[id] = prefs[id];
    hMkdir(KB_DIR);
    return writeJsonAtomic(CONFIG_PATH, cfg);
}

/* Scan-time filters (Batch F). Persisted in config.json under `scan_filters`
 * — the same key `loadConfig()` merges, so a Rescan picks the override up.
 * `skip_loops` default on; `max_sample_size` a human string ("2mb") or null. */
const SCAN_FILTER_DEFAULTS = { skip_loops: true, max_sample_size: null };

export function loadScanPrefs() {
    const sf = readRawConfig().scan_filters || {};
    return {
        skip_loops: typeof sf.skip_loops === 'boolean' ? sf.skip_loops : SCAN_FILTER_DEFAULTS.skip_loops,
        max_sample_size: (sf.max_sample_size === null || typeof sf.max_sample_size === 'string' || typeof sf.max_sample_size === 'number')
            ? sf.max_sample_size : SCAN_FILTER_DEFAULTS.max_sample_size
    };
}

export function saveScanPrefs(prefs) {
    const cfg = readRawConfig();
    cfg.scan_filters = Object.assign({}, SCAN_FILTER_DEFAULTS, cfg.scan_filters, prefs || {});
    hMkdir(KB_DIR);
    return writeJsonAtomic(CONFIG_PATH, cfg);
}

/* "Send to Force": push the exported MPC kit to an Akai Force running
 * MockbaMod over SSH. Persisted in config.json under `force` — host and
 * kits_path are Sam's own setup, there's no way to discover either
 * automatically. kits_path default matches the FAT volume MockbaMod mounts
 * SD-card content under. */
const FORCE_DEFAULTS = { host: '', kits_path: '/media/662522/Kits' };

export function loadForcePrefs() {
    const f = readRawConfig().force || {};
    return {
        host: typeof f.host === 'string' ? f.host : FORCE_DEFAULTS.host,
        kits_path: (typeof f.kits_path === 'string' && f.kits_path) ? f.kits_path : FORCE_DEFAULTS.kits_path
    };
}

export function saveForcePrefs(prefs) {
    const cfg = readRawConfig();
    cfg.force = Object.assign({}, FORCE_DEFAULTS, cfg.force, prefs || {});
    hMkdir(KB_DIR);
    return writeJsonAtomic(CONFIG_PATH, cfg);
}

/* ---- host shims (undefined under node) --------------------------------- */

function hRead(p)   { return (typeof host_read_file === 'function') ? host_read_file(p) : null; }
function hWrite(p, s){ return (typeof host_write_file === 'function') ? !!host_write_file(p, s) : false; }
function hExists(p) { return (typeof host_file_exists === 'function') ? !!host_file_exists(p) : false; }
function hMkdir(p)  { if (typeof host_ensure_dir === 'function') host_ensure_dir(p); }

/* Byte-copy src -> dest. Prefers a real host primitive; the shell path is a
 * fallback (allowlisted, shadow_ui only) and the string round-trip a last
 * resort — fine for text and the node test fs, best-effort for binary audio
 * (see docs/POST_MVP.md: a DSP byte-copy path is the eventual fix). On the
 * round-trip branch a .wav is run through stripWavString() first — drops
 * LIST/bext/iXML/… so the copy beside the .xpm is leaner (no-op if the host
 * mangled the bytes on read). */
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function hCopy(src, dest) {
    if (typeof host_copy_file === 'function') return !!host_copy_file(src, dest);
    if (typeof host_system_cmd === 'function') {
        host_system_cmd('cp -f -- ' + shq(src) + ' ' + shq(dest));
        return hExists(dest);
    }
    let buf = hRead(src);
    if (buf == null) return false;
    if (isWavName(dest)) buf = stripWavString(buf);
    return hWrite(dest, buf);
}

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
    s = s.replace(/[\/\\]/g, '');                   // path separators — first, so
    s = s.replace(/\.{2,}/g, '.');                  // then "../.." collapses to one dot
    s = s.replace(/[<>:"|?*]/g, '_');               // invalid filename chars
    s = s.replace(/^\s+|\s+$/g, '');                // trim surrounding whitespace only
    if (!s || /^\.+$/.test(s)) s = 'Kit Builder';   // empty or dots-only -> fallback
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

/* ---- reject / favourite memory (Batch C) ------------------------
 * Library-wide, not per-kit: a sample rejected here is skipped by every
 * future Assign / re-roll; a favourite is weighted up. Stored as two flat
 * lists of filesystem paths so the engine can use them as Sets directly. */
export const PREFS_PATH = KB_DIR + '/preferences.json';

export function loadPrefs() {
    try {
        const raw = hRead(PREFS_PATH);
        if (raw) {
            const p = JSON.parse(raw);
            return {
                rejects: new Set(Array.isArray(p.rejects) ? p.rejects : []),
                favourites: new Set(Array.isArray(p.favourites) ? p.favourites : [])
            };
        }
    } catch (e) {
        console.log('kit-builder: preferences.json unreadable, starting empty (' + e + ')');
    }
    return { rejects: new Set(), favourites: new Set() };
}

export function savePrefs(rejects, favourites) {
    try {
        hMkdir(KB_DIR);
        return writeJsonAtomic(PREFS_PATH, {
            schema_version: 1,
            rejects: Array.from(rejects || []),
            favourites: Array.from(favourites || [])
        });
    } catch (e) { return false; }
}

/* ---- Move drum preset export (spec §16, §3.3, §24) -------------- */

/*
 * exportMrDrums(kit, name) -> { ok, path, warnings, errors, padCount }
 * Writes a native Move drum-rack preset (.ablpreset) into Move's Track Presets
 * folder — loadable by Move itself and by MrDrums. The Kit Builder save is
 * independent of this: an export failure never touches it.
 */
export function exportMrDrums(kit, name) {
    hMkdir(MRDRUMS_EXPORT_DIR);
    return buildAndWriteExport(kit, {
        dir: MRDRUMS_EXPORT_DIR,
        name: name || kit.name || 'Kit Builder',
        write: (p, s) => hWrite(p, s)
    });
}

/* Real frame count for a pad's source WAV, for the .xpm's Layer-1 SliceEnd —
 * SliceStart 0 + SliceEnd 0 is a zero-length region (confirmed silent on a
 * real Akai Force). MUST read via host_read_file_base64, not host_read_file:
 * the latter feeds raw bytes through QuickJS's JS_NewString, which decodes
 * them as UTF-8 and corrupts arbitrary audio data; base64 is pure ASCII and
 * survives that round-trip intact. null (not 0) on anything unreadable/not a
 * WAV we understand, so the caller can tell "empty" from "couldn't measure". */
function sampleFrameCount(path) {
    if (typeof host_read_file_base64 !== 'function') return null;
    let b64;
    try { b64 = host_read_file_base64(path); } catch (e) { return null; }
    if (!b64) return null;
    try { return wavFrameCount(base64Decode(b64)); } catch (e) { return null; }
}

/* MPC .xpm export (Batch D3). Writes <Root>/<Kit>/<Kit>.xpm + MANIFEST.txt and
 * gathers each sample beside the .xpm (hCopy). Any copy that fails is tagged
 * [MISSING] in MANIFEST.txt for a manual step. */
export function exportMpcXpm(kit, name) {
    hMkdir(MPC_EXPORT_ROOT);
    return buildAndWriteXpm(kit, {
        dir: MPC_EXPORT_ROOT,
        name: name || kit.name || 'Kit Builder',
        mkdir: (p) => hMkdir(p),
        write: (p, s) => hWrite(p, s),
        copy: (src, dest) => hCopy(src, dest),
        frameCount: (p) => sampleFrameCount(p)
    });
}

/* ---- Send to Force (SSH push to an Akai Force running MockbaMod) -------
 *
 * Move ships sshd for *inbound* connections only — there's no outbound ssh
 * anywhere on the device (`/usr/bin/scp` execs a nonexistent `/usr/bin/ssh`;
 * confirmed by running it). src/vendor/dropbear-aarch64/ vendors a static
 * musl build of dropbear's dbclient/scp/dropbearkey instead — see
 * docs/refs/README.md for why it has to be musl, not glibc (a glibc-static
 * dbclient segfaults on Move on the very first invocation).
 *
 * Auth is an ed25519 keypair Kit Builder generates for itself once, never a
 * password: no interactive prompt is possible from this environment, and a
 * key means nothing has to change if MockbaMod's own default password ever
 * does. The matching public key still has to reach the Force by hand, once
 * — there's no keyboard-free way to hand it over automatically the first
 * time (see README's Force setup section for the one SSH command that
 * does it).
 */
const MODULE_DIR = '/data/UserData/schwung/modules/overtake/kit-builder';
const FORCE_BIN = MODULE_DIR + '/vendor/dropbear-aarch64';
export const FORCE_DBCLIENT = FORCE_BIN + '/dbclient';
export const FORCE_SCP = FORCE_BIN + '/scp';
const FORCE_DROPBEARKEY = FORCE_BIN + '/dropbearkey';
export const FORCE_KEY_PATH = KB_DIR + '/force_key';

/* Generate the keypair on first use; a no-op once it exists. Returns false
 * only if generation itself failed (host_system_cmd missing, or dropbearkey
 * exited non-zero) — an already-existing key is success, not skipped work. */
export function ensureForceKey() {
    if (hExists(FORCE_KEY_PATH)) return true;
    if (typeof host_system_cmd !== 'function') return false;
    hMkdir(KB_DIR);
    const real = FORCE_DROPBEARKEY + ' -t ed25519 -f ' + shq(FORCE_KEY_PATH) + ' -C kit-builder@move';
    host_system_cmd('sh -c ' + shq(real));
    return hExists(FORCE_KEY_PATH);
}

/* The public half, for the one-time copy onto the Force's authorized_keys.
 * null if no key has been generated yet (call ensureForceKey() first). */
export function readForcePublicKey() {
    if (!hExists(FORCE_KEY_PATH + '.pub')) return null;
    const raw = hRead(FORCE_KEY_PATH + '.pub');
    return raw ? raw.trim() : null;
}

/* Push `dir` (an already-exported MPC kit folder — .xpm + gathered samples)
 * to <force.kits_path>/<basename(dir)> on the Force. `-o StrictHostKeyChecking
 * =no` because there's no interactive prompt to confirm a host key from, and
 * no known_hosts management this environment can reasonably do; the Force is
 * assumed to be Sam's own, addressed by IP on his own LAN. -S points scp at
 * the vendored dbclient explicitly — dropbear's scp defaults to invoking
 * /usr/bin/dbclient by its compiled-in path, which doesn't exist here. */
export function pushKitToForce(dir, name) {
    const prefs = loadForcePrefs();
    if (!prefs.host) return { ok: false, error: 'no Force address set' };
    if (typeof host_system_cmd !== 'function') return { ok: false, error: 'host_system_cmd unavailable' };
    if (!ensureForceKey()) return { ok: false, error: 'key generation failed' };
    /* hExists() is a stat() — true even if the file can't actually be read.
     * shadow_ui runs this as `ableton`; a key that ended up root-owned (e.g.
     * from someone generating it by hand over an ssh root login instead of
     * through this function) exists but isn't readable, and dbclient would
     * just fail auth silently. Catch that here with a clear reason instead
     * of a bare "scp exited N" — this exact failure happened once already. */
    if (hRead(FORCE_KEY_PATH) == null) {
        return { ok: false, error: 'key exists but is unreadable — check its owner/permissions' };
    }

    const remote = prefs.kits_path + '/';
    const real = FORCE_SCP + ' -r -S ' + FORCE_DBCLIENT +
        ' -i ' + shq(FORCE_KEY_PATH) +
        ' -o StrictHostKeyChecking=no -o BatchMode=yes ' +
        shq(dir) + ' ' + shq('root@' + prefs.host + ':' + remote);
    const rc = host_system_cmd('sh -c ' + shq(real));
    return rc === 0
        ? { ok: true, path: prefs.kits_path + '/' + name }
        : { ok: false, error: `scp exited ${rc}` };
}

/* Run every enabled exporter for `kit`. Returns [{ id, ok, path, warnings,
 * errors }]. Order: mrdrums, mpcxpm, force. Force implies an MPC export even
 * if that toggle itself is off — there's nothing to push otherwise — but
 * only reports an `mpcxpm` row if the user actually asked for one. */
export function runExports(kit, name, prefs) {
    prefs = prefs || loadExportPrefs();
    const out = [];
    if (prefs.mrdrums) { const r = exportMrDrums(kit, name); out.push({ id: 'mrdrums', ok: r.ok, path: r.path, warnings: r.warnings || [], errors: r.errors || [] }); }

    let xpm = null;
    if (prefs.mpcxpm || prefs.force) {
        xpm = exportMpcXpm(kit, name);
        if (prefs.mpcxpm) out.push({ id: 'mpcxpm', ok: xpm.ok, path: xpm.path, warnings: xpm.warnings || [], errors: xpm.errors || [] });
    }
    if (prefs.force) {
        if (xpm && xpm.ok) {
            const r = pushKitToForce(xpm.dir, name || kit.name || 'Kit Builder');
            out.push({ id: 'force', ok: r.ok, path: r.path || '', warnings: [], errors: r.ok ? [] : [r.error] });
        } else {
            out.push({ id: 'force', ok: false, path: '', warnings: [], errors: ['MPC export failed — nothing to send'] });
        }
    }
    return out;
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
