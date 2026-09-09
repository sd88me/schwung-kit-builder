/*
 * Seeded random assignment engine (spec §10, §21.3).
 */
import { assert, eq } from './run.js';
import { createKit } from '../src/core/kit_model.mjs';
import { assignKit } from '../src/core/random_assign.mjs';
import { DEFAULT_CONFIG } from '../src/core/sample_index.mjs';

/* Build a fake index with `n` samples in each named category. */
function fakeIndex(spec) {
    const records = [];
    for (const cat of Object.keys(spec)) {
        for (let i = 1; i <= spec[cat]; i++) {
            records.push({
                filesystem_path: `/lib/${cat}/${cat}_${i}.wav`,
                ableton_uri: `ableton:/user-library/Samples/${cat}/${cat}_${i}.wav`,
                source: 'user',
                category: cat,
                filename: `${cat}_${i}.wav`,
                extension: '.wav',
                size_bytes: 1000,
                modified_time: 0
            });
        }
    }
    return { records };
}

const FULL = fakeIndex({
    kick: 20, snare: 20, clap: 20, open_hat: 20, closed_hat: 20,
    percussion: 30, fx: 10, other: 200
});

function run(kit, index, over) {
    return assignKit(Object.assign({
        kit, index, config: DEFAULT_CONFIG, seed: 12345,
        source: 'user', preventDuplicates: true
    }, over));
}

export const tests = [
    { name: 'fills every unlocked pad that has a candidate (§21.3)', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        const res = run(kit, FULL);
        eq(res.pads.filter((p) => p.sample).length, 16);
        eq(res.unresolved.length, 0);
    }},

    { name: 'each pad draws from its configured role (§21.3)', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        const res = run(kit, FULL);
        eq(res.pads[0].sample.category, 'kick');    // pad 1
        eq(res.pads[1].sample.category, 'snare');   // pad 2
        eq(res.pads[2].sample.category, 'clap');    // pad 3
        eq(res.pads[3].sample.category, 'open_hat');
        eq(res.pads[4].sample.category, 'closed_hat');
        eq(res.pads[5].sample.category, 'percussion');
        eq(res.pads[6].sample.category, 'fx');
        for (let i = 7; i < 16; i++) eq(res.pads[i].sample.category, 'other');
    }},

    { name: 'same seed + same lock state -> identical result (§10.6)', fn() {
        const a = run(createKit(DEFAULT_CONFIG), FULL);
        const b = run(createKit(DEFAULT_CONFIG), FULL);
        eq(a.pads.map((p) => p.sample && p.sample.filesystem_path),
           b.pads.map((p) => p.sample && p.sample.filesystem_path));
    }},

    { name: 'no duplicate sample across pads when alternatives exist (§10.4)', fn() {
        const res = run(createKit(DEFAULT_CONFIG), FULL);
        const paths = res.pads.map((p) => p.sample.filesystem_path);
        eq(new Set(paths).size, 16);
    }},

    { name: 'locked pads never change; unlocked ones do (§21.3)', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        let cur = run(kit, FULL);
        for (let i = 0; i < 16; i++) kit.pads[i] = cur.pads[i];
        // lock pads 1 and 8
        kit.pads[0].locked = true;
        kit.pads[7].locked = true;
        const lockedKick = kit.pads[0].sample.filesystem_path;
        const lockedOther = kit.pads[7].sample.filesystem_path;
        const before = kit.pads.map((p) => p.sample.filesystem_path);
        const res = run(kit, FULL, { seed: 999 });
        eq(res.pads[0].sample.filesystem_path, lockedKick);
        eq(res.pads[7].sample.filesystem_path, lockedOther);
        // at least some unlocked pad changed
        let changed = 0;
        for (let i = 0; i < 16; i++) if (res.pads[i].sample.filesystem_path !== before[i]) changed++;
        assert(changed > 0, 'expected some unlocked pads to change');
    }},

    { name: 'current sample not immediately reselected when alternatives exist (§10.5)', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        let res = run(kit, FULL, { seed: 1 });
        for (let i = 0; i < 16; i++) kit.pads[i] = res.pads[i];
        const kickBefore = kit.pads[0].sample.filesystem_path;
        // re-run many seeds; kick pad should move off its current pick most of the time
        let stayed = 0, total = 40;
        for (let s = 1; s <= total; s++) {
            const r = run(kit, FULL, { seed: s * 7 + 1 });
            if (r.pads[0].sample.filesystem_path === kickBefore) stayed++;
        }
        assert(stayed === 0, `kick pad kept its current sample ${stayed}/${total} times (should be 0)`);
    }},

    { name: 'a role with no candidates leaves that pad, reports unresolved, kit stays valid (§10.3)', fn() {
        const idx = fakeIndex({ kick: 5, snare: 5, other: 50 }); // no clap/hats/perc/fx
        const kit = createKit(DEFAULT_CONFIG);
        const res = run(kit, idx);
        // clap falls back to snare (config), so clap pad resolves; open_hat/closed_hat
        // fall back to percussion which is also empty -> unresolved. fx falls back to
        // percussion then other -> resolves.
        const unresolvedRoles = res.unresolved.map((u) => u.role);
        assert(unresolvedRoles.includes('open_hat'), 'open_hat should be unresolved');
        assert(unresolvedRoles.includes('closed_hat'), 'closed_hat should be unresolved');
        eq(res.pads[3].sample, null);   // open_hat pad stays empty
        assert(res.warning && res.warning.includes('unavailable'), res.warning);
        eq(res.pads.length, 16);
    }},

    { name: 'small pool relaxes duplicate-prevention and reports it (§10.4)', fn() {
        // 9 "other" pads (8..16) but only 3 unique other samples
        const idx = fakeIndex({ kick: 5, snare: 5, clap: 5, percussion: 5, fx: 5, other: 3 });
        idx.records.push(
            { filesystem_path: '/lib/open_hat/oh_1.wav', source: 'user', category: 'open_hat', filename: 'oh_1.wav', extension: '.wav' },
            { filesystem_path: '/lib/closed_hat/ch_1.wav', source: 'user', category: 'closed_hat', filename: 'ch_1.wav', extension: '.wav' }
        );
        const res = run(createKit(DEFAULT_CONFIG), idx);
        assert(res.relaxed.length > 0, 'expected duplicate relaxation on the Other pads');
        // every other pad still ends up assigned
        for (let i = 7; i < 16; i++) assert(res.pads[i].sample, `pad ${i + 1} should be assigned`);
    }}
];
