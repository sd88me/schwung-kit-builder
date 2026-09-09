/*
 * Kit Builder — seeded random assignment engine (spec §10)
 *
 * Pure module: no `os`, no `host_*`. Never mutates the input kit — returns a
 * proposed pad array plus a report; the caller commits it as a transaction
 * (§10.3). Not part of any audio callback (§4.1).
 */

import { sampleFromRecord } from './kit_model.mjs';

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

/*
 * Resolve one pad against the pools (spec §10.2 steps 3-8). `used` is the set
 * of sample paths already spoken for. Returns { pick, poolRole, relaxed } or
 * null when nothing is eligible even after relaxation.
 */
export function resolveOne(pad, byRole, roleRules, rng, used, preventDuplicates, rejects, favourites) {
    const roleChain = [pad.role].concat((roleRules[pad.role] && roleRules[pad.role].fallback_roles) || []);
    const notRejected = (rec) => !(rejects && rejects.has(rec.filesystem_path));

    let pool = [];
    let poolRole = pad.role;
    for (const role of roleChain) {
        const cands = (byRole[role] || []).filter(
            (rec) => notRejected(rec) && (!preventDuplicates || !used.has(rec.filesystem_path)));
        if (cands.length) { pool = cands; poolRole = role; break; }
    }

    /* Avoid immediately reselecting this pad's current sample (§10.5). */
    if (pad.sample && pool.length) {
        const alt = pool.filter((rec) => rec.filesystem_path !== pad.sample.filesystem_path);
        if (alt.length) pool = alt;
    }

    /* Relaxation: after unique candidates are exhausted, allow a repeat for the
     * role (§10.4). Rejects are never relaxed. */
    let didRelax = false;
    if (!pool.length && preventDuplicates) {
        for (const role of roleChain) {
            let all = (byRole[role] || []).filter(notRejected);
            if (!all.length) continue;
            if (pad.sample) {
                const alt = all.filter((rec) => rec.filesystem_path !== pad.sample.filesystem_path);
                if (alt.length) all = alt;
            }
            pool = all; poolRole = role; didRelax = true; break;
        }
    }
    if (!pool.length) return null;

    /* Weight favourites: give each a second entry so it comes up ~2x as often. */
    let weighted = pool;
    if (favourites && favourites.size) {
        weighted = pool.slice();
        for (const rec of pool) if (favourites.has(rec.filesystem_path)) weighted.push(rec);
    }

    const pick = weighted[Math.floor(rng() * weighted.length)];
    return { pick, poolRole, relaxed: didRelax };
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
    const roleRules = config.role_rules || {};
    const source = opts.source || 'user';
    const preventDuplicates = opts.preventDuplicates !== false;
    const seed = (opts.seed >>> 0) || randomSeed();
    const rng = makeRng(seed);
    const rejects = opts.rejects || null;
    const favourites = opts.favourites || null;

    const byRole = bucketByRole(opts.index, source);
    const pads = copyPads(kit);

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

        const r = resolveOne(p, byRole, roleRules, rng, used, preventDuplicates, rejects, favourites);
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
    const roleRules = config.role_rules || {};
    const source = opts.source || 'user';
    const preventDuplicates = opts.preventDuplicates !== false;
    const rng = makeRng((opts.seed >>> 0) || randomSeed());
    const byRole = bucketByRole(opts.index, source);

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
    const r = resolveOne(pad, byRole, roleRules, rng, used, preventDuplicates, opts.rejects || null, opts.favourites || null);
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
