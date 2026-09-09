/*
 * Storage layer — save, reload, validate, missing-sample handling
 * (spec §15, §21.6). No UI reload path exists in the MVP; these exercise the
 * storage layer directly, per §21.6.
 */
import { assert, eq } from './run.js';
import { createKit, sampleFromRecord } from '../src/core/kit_model.mjs';
import { assignKit } from '../src/core/random_assign.mjs';
import { DEFAULT_CONFIG } from '../src/core/sample_index.mjs';
import { validateKit } from '../src/core/validation.mjs';

/* ---- in-memory fs mock for host_* + os.rename -------------------------- */
const FS = new Map();
function installFsMock() {
    FS.clear();
    globalThis.host_read_file   = (p) => (FS.has(p) ? FS.get(p) : null);
    globalThis.host_write_file  = (p, s) => { FS.set(p, String(s)); return true; };
    globalThis.host_file_exists = (p) => FS.has(p);
    globalThis.host_ensure_dir  = () => true;
}
installFsMock();

/* import AFTER the mock so module-load-time refs (if any) see it */
const storage = await import('../src/core/storage.mjs');
const {
    saveKit, loadKit, loadKitFromString, markMissingSamples,
    sanitizeFilename, generatedKitName, nextKitNumber, commitKitNumber,
    KITS_DIR, CURRENT_KIT_PATH
} = storage;

const FAKE_INDEX = (() => {
    const records = [];
    const cats = { kick: 8, snare: 8, clap: 8, open_hat: 8, closed_hat: 8, percussion: 12, fx: 6, other: 60 };
    for (const c of Object.keys(cats)) {
        for (let i = 1; i <= cats[c]; i++) {
            records.push({
                filesystem_path: `/data/UserData/UserLibrary/Samples/${c}/${c}_${i}.wav`,
                ableton_uri: null, source: 'user', category: c,
                filename: `${c}_${i}.wav`, extension: '.wav', size_bytes: 1, modified_time: 0
            });
        }
    }
    return { records };
})();

function assignedKit() {
    const kit = createKit(DEFAULT_CONFIG);
    const res = assignKit({ kit, index: FAKE_INDEX, config: DEFAULT_CONFIG, seed: 42, source: 'user', preventDuplicates: true });
    for (let i = 0; i < 16; i++) kit.pads[i] = res.pads[i];
    return kit;
}

export const tests = [
    { name: 'sanitizeFilename strips separators, traversal, control + invalid chars (§15.6)', fn() {
        eq(sanitizeFilename('a/b\\c'), 'abc');
        eq(sanitizeFilename('../../etc/passwd'), '.etcpasswd');
        eq(sanitizeFilename('kit<>:"|?*x'), 'kit_______x');
        eq(sanitizeFilename('  spaced  '), 'spaced');
        eq(sanitizeFilename(''), 'Kit Builder');
        eq(sanitizeFilename('...'), 'Kit Builder');
        eq(sanitizeFilename('Kit Builder 007 2026-09-09'), 'Kit Builder 007 2026-09-09');
    }},

    { name: 'generated name format = counter + date (§3.3.1)', fn() {
        eq(generatedKitName(7, new Date('2026-09-09T10:00:00Z')), 'Kit Builder 007 2026-09-09');
        eq(generatedKitName(123, new Date('2026-01-02T00:00:00Z')), 'Kit Builder 123 2026-01-02');
    }},

    { name: 'save then reload — assignments, locks and name intact (§21.6)', fn() {
        installFsMock();
        const kit = assignedKit();
        kit.pads[0].locked = true;
        kit.pads[5].locked = true;
        kit.pads[9].locked = true;
        const before = kit.pads.map((p) => [p.pad, p.locked, p.sample && p.sample.filesystem_path]);

        const res = saveKit(kit, 'My Test Kit');
        assert(res.ok, res.error);
        eq(res.name, 'My Test Kit');
        assert(res.path.startsWith(KITS_DIR + '/My Test Kit'), res.path);

        const back = loadKit(res.path);
        assert(back.ok, back.error);
        eq(back.kit.name, 'My Test Kit');
        eq(back.kit.pads.map((p) => [p.pad, p.locked, p.sample && p.sample.filesystem_path]), before);
        assert(validateKit(back.kit) === null, 'reloaded kit should validate');
    }},

    { name: 'current-kit.json is refreshed on save (§15.2)', fn() {
        installFsMock();
        const r = saveKit(assignedKit(), 'X');
        assert(r.ok, r.error);
        const cur = loadKit(CURRENT_KIT_PATH);
        assert(cur.ok, 'current-kit.json should be loadable: ' + cur.error);
        eq(cur.kit.name, 'X');
    }},

    { name: 'duplicate names get " (2)", " (3)" — never overwrite (§15.6)', fn() {
        installFsMock();
        const a = saveKit(assignedKit(), 'Dup');
        const b = saveKit(assignedKit(), 'Dup');
        const c = saveKit(assignedKit(), 'Dup');
        assert(a.ok && b.ok && c.ok);
        assert(a.path.endsWith('/Dup.kitbuilder.json'), a.path);
        assert(b.path.endsWith('/Dup (2).kitbuilder.json'), b.path);
        assert(c.path.endsWith('/Dup (3).kitbuilder.json'), c.path);
    }},

    { name: 're-saving the same kit overwrites one file; a new name is a save-as', fn() {
        installFsMock();
        const k = assignedKit();
        const a = saveKit(k, 'Session Kit');                 // fresh
        const b = saveKit(k, 'Session Kit', 'Session Kit');  // same name -> overwrite
        const c = saveKit(k, 'Session Kit', 'Session Kit');  // still overwrite
        eq(a.path, b.path);
        eq(b.path, c.path);
        assert(b.overwrote && c.overwrote);
        // renaming while carrying the old name -> a new, non-colliding file
        const d = saveKit(k, 'Renamed', 'Session Kit');
        assert(!d.overwrote);
        assert(d.path.endsWith('/Renamed.kitbuilder.json'), d.path);
    }},

    { name: 'saveCurrentKit / loadCurrentKit round-trips the working state', fn() {
        installFsMock();
        const k = assignedKit();
        k.pads[3].locked = true;
        assert(storage.saveCurrentKit(k));
        const back = storage.loadCurrentKit();
        assert(back.ok, back.error);
        eq(back.kit.pads[3].locked, true);
        eq(back.kit.pads.map((p) => p.sample && p.sample.filesystem_path),
           k.pads.map((p) => p.sample && p.sample.filesystem_path));
    }},

    { name: 'kit-name counter starts at 1 and only advances on commit (§3.3.1)', fn() {
        installFsMock();
        eq(nextKitNumber(), 1);
        saveKit(assignedKit(), generatedKitName(nextKitNumber()));  // save without commit
        eq(nextKitNumber(), 1, 'counter must not move until commit');
        commitKitNumber(1);
        eq(nextKitNumber(), 2);
        commitKitNumber(2);
        eq(nextKitNumber(), 3);
    }},

    { name: 'missing sample files are flagged, not dropped (§8.6, §21.6)', fn() {
        installFsMock();
        const kit = assignedKit();
        const present = new Set([kit.pads[1].sample.filesystem_path, kit.pads[2].sample.filesystem_path]);
        const missing = markMissingSamples(kit, (p) => present.has(p));
        assert(missing >= 10, `expected many missing, got ${missing}`);
        eq(kit.pads.length, 16);
        assert(kit.pads[0].sample, 'pad 1 sample still present in the model');
        assert(kit.pads[0].sample.missing === true, 'pad 1 flagged missing');
        assert(kit.pads[1].sample.missing === false, 'pad 2 not flagged');
    }},

    { name: 'a bad file fails to load without throwing (§17.1)', fn() {
        eq(loadKitFromString('{not json').ok, false);
        eq(loadKitFromString(JSON.stringify({ schema_version: 2 })).ok, false);
        const k = createKit(DEFAULT_CONFIG);
        k.pads.pop();   // 15 pads
        eq(loadKitFromString(JSON.stringify(k)).ok, false);
    }},

    { name: 'a failed final write leaves the previous good file intact (§15.5)', fn() {
        installFsMock();
        const first = saveKit(assignedKit(), 'Keep');
        assert(first.ok);
        const good = FS.get(first.path);

        // now make writes to the final path fail, tmp still ok
        globalThis.host_write_file = (p, s) => {
            if (p === first.path) return false;
            FS.set(p, String(s));
            return true;
        };
        const kit2 = assignedKit();
        // force same target name by pre-seeding: saveKit picks "Keep (2)" since "Keep" exists,
        // so instead test writeJsonAtomic directly on the existing path
        const ok = storage.writeJsonAtomic(first.path, { schema_version: 1, application: 'kit-builder', name: 'ruined', pads: [] });
        eq(ok, false);
        eq(FS.get(first.path), good, 'original file must be unchanged after a failed write');
    }},
];
