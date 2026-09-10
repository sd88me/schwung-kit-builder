/*
 * Kit Builder — seeded random assignment engine (spec §10)
 *
 * Pure module: no `os`, no `host_*`. Never mutates the input kit — returns a
 * proposed pad array plus a report; the caller commits it as a transaction
 * (§10.3). Not part of any audio callback (§4.1).
 */

import { sampleFromRecord, DEFAULT_PAD_LAYOUT } from './kit_model.mjs';

/* mulberry32 — small deterministic PRNG. Same seed -> same sequence, which,
 * with a fixed pad-processing order, gives the repeatability contract of
 * §10.6. */
export function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function randomSeed() {
    return (Math.floor(Math.random() * 0xFFFFFFFF) >>> 0) || 1;
}

/* Bucket index records by category, honouring the source filter (§10.1). */
export function bucketByRole(index, source) {
    const records = Array.isArray(index && index.records) ? index.records : [];
    const byRole = {};
    for (const rec of records) {
        if (source && source !== 'both' && rec.source && rec.source !== source) continue;
        if (!rec.filesystem_path || !rec.category) continue;
        (byRole[rec.category] || (byRole[rec.category] = [])).push(rec);
    }
    return byRole;
}

/* Rev. 3 — the category union a pad draws from. `pad_layout[i]` is a list of
 * categories; the sentinel `["other"]` expands to every category that has no
 * dedicated pad slot, plus `fx` (Sam's call — fx sits on pad 12 AND in the
 * catch-all pads). Falls back to the built-in layout / list if the config is
 * incomplete. */
const OTHER_FALLBACK = ['vox', 'bass', 'synth', 'stab', 'chord', 'lead', 'pad', 'other', 'fx'];

export function otherPoolCats(config, padLayout) {
    const all = Object.keys((config && config.role_rules) || {});
    if (all.length < 8) return OTHER_FALLBACK.slice();
    const slotted = new Set();
    for (const e of padLayout) {
        if (Array.isArray(e) && !(e.length === 1 && e[0] === 'other')) {
            for (const c of e) slotted.add(c);
        }
    }
    const out = all.filter((c) => !slotted.has(c));
    if (out.indexOf('fx') === -1) out.push('fx');
    return out;
}

export function poolCatsForPad(padIndex, config, otherCats) {
    const layout = (config && Array.isArray(config.pad_layout) && config.pad_layout.length === 16)
        ? config.pad_layout : DEFAULT_PAD_LAYOUT;
    let cats = layout[padIndex];
    if (!Array.isArray(cats) || !cats.length) cats = ['other'];
    if (cats.length === 1 && cats[0] === 'other') return otherCats.slice();
    return cats.slice();
}

/*
 * Resolve one pad against its category-union pool (spec §10.2 steps 3-8).
 * `poolCats` is the already-expanded list of categories. `used` is the set of
 * sample paths already spoken for. Returns { pick, poolRole, poolCat, relaxed }
 * or null when nothing is eligible even after relaxation.
 */
export function resolveOne(pad, poolCats, byRole, rng, used, preventDuplicates, rejects, favourites) {
    const notRejected = (rec) => !(rejects && rejects.has(rec.filesystem_path));
    const poolRole = poolCats.length === 1 ? poolCats[0] : poolCats.join('/');

    const union = (filterFn) => {
        const out = [];
        for (const cat of poolCats) {
            for (const rec of (byRole[cat] || [])) if (filterFn(rec)) out.push(rec);
        }
        return out;
    };

    let pool = union((rec) => notRejected(rec) && (!preventDuplicates || !used.has(rec.filesystem_path)));

    /* Avoid immediately reselecting this pad's current sample (§10.5). */
    if (pad.sample && pool.length) {
        const alt = pool.filter((rec) => rec.filesystem_path !== pad.sample.filesystem_path);
        if (alt.length) pool = alt;
    }

    /* Relaxation: after unique candidates are exhausted, allow a repeat from the
     * pool (§10.4). Rejects are never relaxed. */
    let didRelax = false;
    if (!pool.length && preventDuplicates) {
        let all = union(notRejected);
        if (all.length && pad.sample) {
            const alt = all.filter((rec) => rec.filesystem_path !== pad.sample.filesystem_path);
            if (alt.length) all = alt;
        }
        if (all.length) { pool = all; didRelax = true; }
    }
    if (!pool.length) return null;

    /* Weight favourites: give each a second entry so it comes up ~2x as often. */
    let weighted = pool;
    if (favourites && favourites.size) {
        weighted = pool.slice();
        for (const rec of pool) if (favourites.has(rec.filesystem_path)) weighted.push(rec);
    }

    const pick = weighted[Math.floor(rng() * weighted.length)];
    return { pick, poolRole, poolCat: pick.category, relaxed: didRelax };
}

function copyPads(kit) {
    return kit.pads.map((p) => ({
        pad: p.pad,
        midi_note: p.midi_note,
        role: p.role,
        locked: p.locked,
        sample: p.sample ? Object.assign({}, p.sample) : null,
        playback: Object.assign({}, p.playback)
    }));
}

/*
 * assignKit({ kit, index, config, seed, source, preventDuplicates, rejects, favourites })
 *   -> { pads, seed, changed, unresolved, relaxed, warning }
 * `rejects` / `favourites` are optional Sets of filesystem_path.
 */
export function assignKit(opts) {
    const kit = opts.kit;
    const config = opts.config || {};
    const source = opts.source || 'user';
    const preventDuplicates = opts.preventDuplicates !== false;
    const seed = (opts.seed >>> 0) || randomSeed();
    const rng = makeRng(seed);
    const rejects = opts.rejects || null;
    const favourites = opts.favourites || null;

    const byRole = bucketByRole(opts.index, source);
    const pads = copyPads(kit);
    const layout = (Array.isArray(config.pad_layout) && config.pad_layout.length === 16)
        ? config.pad_layout : DEFAULT_PAD_LAYOUT;
    const otherCats = otherPoolCats(config, layout);

    /* Samples on locked pads count as already used (§10.4). */
    const used = new Set();
    for (const p of pads) if (p.locked && p.sample) used.add(p.sample.filesystem_path);

    const changed = [];
    const unresolved = [];
    const relaxed = [];

    /* Unlocked pads, ascending pad-number order (§10.2 step 3, decision 4). */
    for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p.locked) continue;

        const poolCats = poolCatsForPad(i, config, otherCats);
        const r = resolveOne(p, poolCats, byRole, rng, used, preventDuplicates, rejects, favourites);
        if (!r) { unresolved.push({ pad: p.pad, role: p.role }); continue; }

        const prevPath = p.sample ? p.sample.filesystem_path : null;
        p.sample = sampleFromRecord(r.pick);
        used.add(r.pick.filesystem_path);
        if (r.relaxed) relaxed.push({ pad: p.pad, role: r.poolRole });
        if (r.pick.filesystem_path !== prevPath) changed.push(p.pad);
    }

    let warning = null;
    if (unresolved.length) {
        warning = `Assigned ${16 - unresolved.length} pads, ${unresolved.length} unavailable`;
    } else if (relaxed.length) {
        warning = `Duplicates allowed on ${relaxed.length} pad(s)`;
    }
    return { pads, seed, changed, unresolved, relaxed, warning };
}

/*
 * rerollPad({ kit, index, config, seed, source, preventDuplicates, padIndex, rejects, favourites })
 *   -> { pad, changed, relaxed, warning }
 * Re-rolls one unlocked pad, avoiding every sample currently in the kit (when
 * duplicate prevention is on) and its own current sample. Does not mutate kit.
 */
export function rerollPad(opts) {
    const kit = opts.kit;
    const i = opts.padIndex | 0;
    const src = kit.pads[i];
    if (!src) return { pad: null, changed: false, warning: 'no such pad' };
    if (src.locked) return { pad: src, changed: false, warning: 'pad is locked' };

    const config = opts.config || {};
    const source = opts.source || 'user';
    const preventDuplicates = opts.preventDuplicates !== false;
    const rng = makeRng((opts.seed >>> 0) || randomSeed());
    const byRole = bucketByRole(opts.index, source);
    const layout = (Array.isArray(config.pad_layout) && config.pad_layout.length === 16)
        ? config.pad_layout : DEFAULT_PAD_LAYOUT;
    const poolCats = poolCatsForPad(i, config, otherPoolCats(config, layout));

    const used = new Set();
    for (let j = 0; j < kit.pads.length; j++) {
        if (j === i) continue;
        const q = kit.pads[j];
        if (q.sample) used.add(q.sample.filesystem_path);
    }

    const pad = {
        pad: src.pad, midi_note: src.midi_note, role: src.role, locked: false,
        sample: src.sample ? Object.assign({}, src.sample) : null,
        playback: Object.assign({}, src.playback)
    };
    const r = resolveOne(pad, poolCats, byRole, rng, used, preventDuplicates, opts.rejects || null, opts.favourites || null);
    if (!r) return { pad: src, changed: false, warning: `no sample for ${src.role}` };

    const prevPath = pad.sample ? pad.sample.filesystem_path : null;
    pad.sample = sampleFromRecord(r.pick);
    return {
        pad,
        changed: r.pick.filesystem_path !== prevPath,
        relaxed: r.relaxed,
        warning: r.relaxed ? 'duplicate allowed' : null
    };
}
