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

/*
 * assignKit({ kit, index, config, seed, source, preventDuplicates })
 *   -> {
 *        pads,              // proposed 16-pad array to commit
 *        seed,              // the seed actually used (store it in the kit)
 *        changed,           // [padNum] whose sample changed
 *        unresolved,        // [{ pad, role }] with no eligible candidate
 *        relaxed,           // [{ pad, role }] where duplicate-prevention was relaxed
 *        warning            // user-facing string or null
 *      }
 */
export function assignKit(opts) {
    const kit = opts.kit;
    const index = opts.index || {};
    const config = opts.config || {};
    const roleRules = config.role_rules || {};
    const source = opts.source || 'user';
    const preventDuplicates = opts.preventDuplicates !== false;
    const seed = (opts.seed >>> 0) || randomSeed();
    const rng = makeRng(seed);

    /* Bucket index records by category, honouring the source filter (§10.1). */
    const records = Array.isArray(index.records) ? index.records : [];
    const byRole = {};
    for (const rec of records) {
        if (source && source !== 'both' && rec.source && rec.source !== source) continue;
        if (!rec.filesystem_path || !rec.category) continue;
        (byRole[rec.category] || (byRole[rec.category] = [])).push(rec);
    }

    /* Proposed state = deep-ish copy of the current pads (§10.2 step 1). */
    const pads = kit.pads.map((p) => ({
        pad: p.pad,
        midi_note: p.midi_note,
        role: p.role,
        locked: p.locked,
        sample: p.sample ? Object.assign({}, p.sample) : null,
        playback: Object.assign({}, p.playback)
    }));

    /* Samples on locked pads count as already used (§10.4). */
    const used = new Set();
    for (const p of pads) if (p.locked && p.sample) used.add(p.sample.filesystem_path);

    const changed = [];
    const unresolved = [];
    const relaxed = [];

    /* Process unlocked pads in ascending pad-number order (§10.2 step 3,
     * decision 4). pads[] is already index 0 = pad 1. */
    for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p.locked) continue;

        const roleChain = [p.role].concat((roleRules[p.role] && roleRules[p.role].fallback_roles) || []);

        /* Primary + fallback pools with duplicate-avoided candidates (§10.2
         * steps 3-7). */
        let pool = [];
        let poolRole = p.role;
        for (const role of roleChain) {
            const cands = (byRole[role] || []).filter((rec) => !preventDuplicates || !used.has(rec.filesystem_path));
            if (cands.length) { pool = cands; poolRole = role; break; }
        }

        /* Avoid immediately reselecting this pad's current sample (§10.5). */
        if (p.sample && pool.length) {
            const alt = pool.filter((rec) => rec.filesystem_path !== p.sample.filesystem_path);
            if (alt.length) pool = alt;
        }

        /* Relaxation: if duplicate-prevention emptied every pool, allow a
         * repeat for this role after unique candidates are exhausted (§10.4). */
        let didRelax = false;
        if (!pool.length && preventDuplicates) {
            for (const role of roleChain) {
                let all = (byRole[role] || []).slice();
                if (!all.length) continue;
                if (p.sample) {
                    const alt = all.filter((rec) => rec.filesystem_path !== p.sample.filesystem_path);
                    if (alt.length) all = alt;
                }
                pool = all; poolRole = role; didRelax = true; break;
            }
        }

        if (!pool.length) {
            /* Unresolved: keep whatever this pad already had (§10.3). */
            unresolved.push({ pad: p.pad, role: p.role });
            continue;
        }

        const pick = pool[Math.floor(rng() * pool.length)];
        const prevPath = p.sample ? p.sample.filesystem_path : null;
        p.sample = sampleFromRecord(pick);
        used.add(pick.filesystem_path);
        if (didRelax) relaxed.push({ pad: p.pad, role: poolRole });
        if (pick.filesystem_path !== prevPath) changed.push(p.pad);
    }

    let warning = null;
    if (unresolved.length) {
        const done = 16 - unresolved.length;
        warning = `Assigned ${done} pads, ${unresolved.length} unavailable`;
    } else if (relaxed.length) {
        warning = `Duplicates allowed on ${relaxed.length} pad(s)`;
    }

    return { pads, seed, changed, unresolved, relaxed, warning };
}
