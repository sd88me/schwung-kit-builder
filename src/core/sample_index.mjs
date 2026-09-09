/*
 * Kit Builder — sample index: recursive User Library scan, classification,
 * cached index file (spec §8).
 *
 * Runs in the module UI (QuickJS) — there is no DSP in the MVP. The scan is
 * CHUNKED: createScan() returns a pump whose step(budget) processes a bounded
 * number of directory entries and returns, so tick() stays responsive and the
 * scan never blocks the display (spec §4.1, §20). Filesystem metadata only —
 * no sample decoding during indexing (§20).
 */

import * as os from 'os';
import { toAbletonUri } from './path_mapping.mjs';
import { buildAliasIndex, classify } from './sample_classifier.mjs';

/* Writable Kit Builder data area (§8.3, §15). */
export const KB_DIR = '/data/UserData/UserLibrary/KitBuilder';
export const INDEX_PATH = KB_DIR + '/.sample-index.json';
export const INDEX_TMP = INDEX_PATH + '.tmp';
export const CONFIG_PATH = KB_DIR + '/config.json';

/*
 * Default configuration (spec §7.1). Kept in sync with config/default_kit_config.json
 * and src/kit_config.json. Embedded here so the module never has to locate and
 * read its own bundled file; a user config.json (if present) overrides it.
 */
export const DEFAULT_CONFIG = {
    schema_version: 1,
    sample_roots: {
        user: '/data/UserData/UserLibrary/Samples',
        core: '/data/CoreLibrary/Samples'
    },
    supported_extensions: ['.wav', '.aif', '.aiff'],
    role_rules: {
        kick:       { pads: [1], folder_aliases: ['kick', 'kicks', 'bd', 'bass drum'], fallback_roles: [] },
        snare:      { pads: [2], folder_aliases: ['snare', 'snares', 'sd'], fallback_roles: [] },
        clap:       { pads: [3], folder_aliases: ['clap', 'claps'], fallback_roles: ['snare'] },
        open_hat:   { pads: [4], folder_aliases: ['open hat', 'open hats', 'open_hat', 'open-hat', 'openhihat', 'oh'], fallback_roles: ['percussion'] },
        closed_hat: { pads: [5], folder_aliases: ['closed hat', 'closed hats', 'closed_hat', 'closed-hat', 'closedhihat', 'ch'], fallback_roles: ['percussion'] },
        percussion: { pads: [6], folder_aliases: ['percussion', 'perc'], fallback_roles: ['other'] },
        fx:         { pads: [7], folder_aliases: ['fx', 'sfx', 'effects'], fallback_roles: ['percussion', 'other'] },
        other:      { pads: [8, 9, 10, 11, 12, 13, 14, 15, 16], folder_aliases: ['other'], exclude_recognised_role_folders: true, fallback_roles: [] }
    }
};

/* All role names the MVP recognises, in pad order. */
export const ROLE_ORDER = ['kick', 'snare', 'clap', 'open_hat', 'closed_hat', 'percussion', 'fx', 'other'];

export function loadConfig() {
    try {
        const raw = (typeof host_read_file === 'function') ? host_read_file(CONFIG_PATH) : null;
        if (raw) {
            const parsed = JSON.parse(raw);
            return mergeConfig(DEFAULT_CONFIG, parsed);
        }
    } catch (e) {
        console.log('kit-builder: config.json unreadable, using defaults (' + e + ')');
    }
    return DEFAULT_CONFIG;
}

function mergeConfig(base, over) {
    const out = JSON.parse(JSON.stringify(base));
    if (over && typeof over === 'object') {
        if (over.sample_roots) Object.assign(out.sample_roots, over.sample_roots);
        if (Array.isArray(over.supported_extensions)) out.supported_extensions = over.supported_extensions.slice();
        if (over.role_rules && typeof over.role_rules === 'object') {
            for (const role of Object.keys(over.role_rules)) {
                out.role_rules[role] = Object.assign({}, out.role_rules[role], over.role_rules[role]);
            }
        }
        for (const k of Object.keys(over)) {
            if (['sample_roots', 'supported_extensions', 'role_rules'].indexOf(k) === -1) out[k] = over[k];
        }
    }
    return out;
}

/* ---- stat helpers (QuickJS os returns [value, errno]) ---------------------- */

function statOf(path) {
    try {
        const r = os.stat(path);
        if (Array.isArray(r)) {
            if (r[1]) return null;
            return r[0];
        }
        return r || null;
    } catch (e) { return null; }
}
function isDirStat(st) { return st && ((st.mode & 0o170000) === 0o040000); }

function readdirOf(path) {
    try {
        const r = os.readdir(path);
        if (Array.isArray(r)) {
            if (Array.isArray(r[0])) return r[0];
            return r;
        }
        return [];
    } catch (e) { return []; }
}

/* ---- chunked scanner ------------------------------------------------------- */

/*
 * createScan(config) -> {
 *   step(budget): process up to `budget` entries, return phase
 *   state: live progress object
 * }
 * phase: 'scanning' | 'done' | 'error'
 */
export function createScan(config) {
    const cfg = config || DEFAULT_CONFIG;
    const root = (cfg.sample_roots && cfg.sample_roots.user) || DEFAULT_CONFIG.sample_roots.user;
    const rootPrefix = root.replace(/\/+$/, '');
    const exts = (cfg.supported_extensions || []).map((e) => String(e).toLowerCase());
    const aliasIndex = buildAliasIndex(cfg.role_rules);

    const rootStat = statOf(rootPrefix);
    const rootOk = isDirStat(rootStat);

    const state = {
        phase: rootOk ? 'scanning' : 'error',
        error: rootOk ? null : 'no_root',
        root: rootPrefix,
        stack: rootOk ? [rootPrefix] : [],
        records: [],
        counts: emptyCounts(),
        dirsVisited: 0,
        filesSeen: 0,
        indexPath: null,
        startedMs: Date.now(),
        finishedMs: 0
    };

    function step(budget) {
        if (state.phase !== 'scanning') return state.phase;
        let work = 0;
        const max = budget > 0 ? budget : 250;
        while (state.stack.length && work < max) {
            const dir = state.stack.pop();
            state.dirsVisited++;
            const names = readdirOf(dir);
            for (let i = 0; i < names.length; i++) {
                const name = names[i];
                if (name === '.' || name === '..') continue;
                if (name.charAt(0) === '.') continue;              // hidden / temp
                work++;
                const full = dir + '/' + name;
                const st = statOf(full);
                if (!st) continue;
                if (isDirStat(st)) { state.stack.push(full); continue; }

                state.filesSeen++;
                const lower = name.toLowerCase();
                if (lower.endsWith('.tmp')) continue;
                const dot = lower.lastIndexOf('.');
                const ext = dot >= 0 ? lower.slice(dot) : '';
                if (exts.indexOf(ext) === -1) continue;

                const rel = full.slice(rootPrefix.length + 1);
                const parts = rel.split('/');
                const dirParts = parts.slice(0, -1);
                const role = classify(dirParts, aliasIndex);
                const mapped = toAbletonUri(full);

                state.records.push({
                    filesystem_path: full,
                    ableton_uri: mapped.error ? null : mapped.uri,
                    source: mapped.source || 'user',
                    category: role,
                    filename: name,
                    extension: ext,
                    size_bytes: st.size || 0,
                    modified_time: st.mtime ? Math.floor(st.mtime / 1000) : 0
                });
                state.counts[role] = (state.counts[role] || 0) + 1;
            }
        }
        if (!state.stack.length) {
            state.phase = 'done';
            state.finishedMs = Date.now();
            try {
                state.indexPath = writeIndex(state, cfg);
            } catch (e) {
                state.phase = 'error';
                state.error = 'write_failed';
                console.log('kit-builder: index write failed: ' + e);
            }
        }
        return state.phase;
    }

    return { step, state };
}

function emptyCounts() {
    const c = {};
    for (const r of ROLE_ORDER) c[r] = 0;
    return c;
}

/* Atomic-ish write (§8.5): tmp -> parse-check -> rename (or overwrite). */
function writeIndex(state, cfg) {
    if (typeof host_ensure_dir === 'function') host_ensure_dir(KB_DIR);
    const payload = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        sample_root: state.root,
        source: 'user',
        count: state.records.length,
        counts: state.counts,
        records: state.records
    };
    const json = JSON.stringify(payload);
    if (typeof host_write_file !== 'function') throw new Error('no host_write_file');
    if (!host_write_file(INDEX_TMP, json)) throw new Error('tmp write returned false');
    const back = (typeof host_read_file === 'function') ? host_read_file(INDEX_TMP) : json;
    JSON.parse(back); // throws → caller keeps old index
    let renamed = false;
    try {
        if (os && typeof os.rename === 'function') { const rc = os.rename(INDEX_TMP, INDEX_PATH); renamed = !rc; }
    } catch (e) { renamed = false; }
    if (!renamed) {
        if (!host_write_file(INDEX_PATH, json)) throw new Error('final write returned false');
        try { if (os && typeof os.remove === 'function') os.remove(INDEX_TMP); } catch (e) {}
    }
    return INDEX_PATH;
}

/* Load a previously written index (§3.1 step 2). Returns null if absent/bad. */
export function loadIndex() {
    try {
        if (typeof host_file_exists === 'function' && !host_file_exists(INDEX_PATH)) return null;
        const raw = (typeof host_read_file === 'function') ? host_read_file(INDEX_PATH) : null;
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.records)) return null;
        if (!parsed.counts) {
            parsed.counts = emptyCounts();
            for (const rec of parsed.records) parsed.counts[rec.category] = (parsed.counts[rec.category] || 0) + 1;
        }
        return parsed;
    } catch (e) {
        console.log('kit-builder: cached index malformed, will rebuild (' + e + ')');
        return null;
    }
}

/* Condensed counts for the System page (§13.4). */
export function summarize(counts) {
    const c = counts || emptyCounts();
    const indexed = ROLE_ORDER.reduce((n, r) => n + (c[r] || 0), 0);
    return {
        indexed,
        kick: c.kick || 0,
        snare: c.snare || 0,
        clap: c.clap || 0,
        hats: (c.open_hat || 0) + (c.closed_hat || 0),
        perc: c.percussion || 0,
        fx: c.fx || 0,
        other: c.other || 0
    };
}
