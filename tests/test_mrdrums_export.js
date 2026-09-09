/*
 * MrDrums export (spec §16, §21.7). The target is the Ableton drum-rack
 * .ablpreset that handcraftedcc/schwung-mrdrums actually loads. These checks
 * mirror MrDrums's own url_decode + resolve_sample_uri + Volume-dB maths to
 * prove the file it emits round-trips back to the source sample paths.
 */
import { assert, eq } from './run.js';
import { createKit, sampleFromRecord } from '../src/core/kit_model.mjs';
import { DEFAULT_CONFIG } from '../src/core/sample_index.mjs';
import { buildMrDrumsPreset, exportKit, sampleUriFor, gainToDb } from '../src/exporters/mrdrums_json.mjs';

/* --- MrDrums-side reimplementations (from src/dsp/mrdrums_plugin.cpp) --- */
function mrdrumsUrlDecode(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '%' && i + 2 < s.length) { out += String.fromCharCode(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
        else if (c === '+') out += ' ';
        else out += c;
    }
    return out;
}
function mrdrumsResolve(uri) {
    const d = mrdrumsUrlDecode(uri);
    if (d.startsWith('ableton:/user-library/')) return '/data/UserData/UserLibrary/' + d.slice('ableton:/user-library/'.length);
    if (d.startsWith('ableton:/packs/abl-core-library/')) return '/data/CoreLibrary/' + d.slice('ableton:/packs/abl-core-library/'.length);
    if (d.startsWith('ableton:/')) return '';
    if (d[0] === '/') return d;
    return null; // relative
}
function mrdrumsDbToGain(db) { return Math.pow(10, (db + 12) / 20); }

/* --- fixture kit --- */
function rec(cat, name) {
    return {
        filesystem_path: `/data/UserData/UserLibrary/Samples/${cat}/${name}`,
        ableton_uri: `ableton:/user-library/Samples/${cat}/${name}`,
        source: 'user', category: cat, filename: name, extension: '.wav'
    };
}
function kitWith(pairs) {
    const kit = createKit(DEFAULT_CONFIG);
    kit.name = 'Round Trip Kit';
    for (const [padIdx, cat, name] of pairs) kit.pads[padIdx].sample = sampleFromRecord(rec(cat, name));
    return kit;
}

export const tests = [
    { name: 'preset shape matches MrDrums (instrumentRack -> drumRack -> chains)', fn() {
        const { doc, padCount } = buildMrDrumsPreset(kitWith([[0, 'Kick', 'k.wav'], [1, 'Snare', 's.wav']]));
        eq(doc.kind, 'instrumentRack');
        eq(doc.name, 'Round Trip Kit');
        const rack = doc.chains[0].devices[0];
        eq(rack.kind, 'drumRack');
        eq(rack.chains.length, 2);
        eq(padCount, 2);
        const cell = rack.chains[0].devices[0];
        eq(cell.kind, 'drumCell');
        assert(typeof cell.deviceData.sampleUri === 'string');
        assert(typeof cell.parameters.Volume === 'number');
    }},

    { name: 'only assigned pads get a chain; receivingNote = 35 + pad', fn() {
        const { doc } = buildMrDrumsPreset(kitWith([[0, 'Kick', 'k.wav'], [5, 'Percussion', 'p.wav'], [15, 'Other', 'o.wav']]));
        const notes = doc.chains[0].devices[0].chains.map((c) => c.drumZoneSettings.receivingNote);
        eq(notes, [36, 41, 51]);
        for (const c of doc.chains[0].devices[0].chains) eq(c.drumZoneSettings.chokeGroup, null);
    }},

    { name: 'sampleUri round-trips through MrDrums back to the source path (spaces, +)', fn() {
        const kit = kitWith([
            [0, 'Kick', 'Big Kick 01.wav'],
            [1, 'Open Hat', 'hat + snap.wav']
        ]);
        const { doc } = buildMrDrumsPreset(kit);
        const cells = doc.chains[0].devices[0].chains.map((c) => c.devices[0]);
        eq(mrdrumsResolve(cells[0].deviceData.sampleUri), '/data/UserData/UserLibrary/Samples/Kick/Big Kick 01.wav');
        eq(mrdrumsResolve(cells[1].deviceData.sampleUri), '/data/UserData/UserLibrary/Samples/Open Hat/hat + snap.wav');
        // a literal "+" must be percent-encoded — MrDrums url_decode turns bare + into space
        assert(cells[1].deviceData.sampleUri.indexOf('+') === -1, 'literal + must be percent-encoded');
        // and it stays inside the user-library scheme, not an absolute path
        assert(cells[0].deviceData.sampleUri.indexOf('ableton:/user-library/') === 0);
    }},

    { name: 'gain -> Volume dB uses MrDrums unity reference (-12 dB = 1.0)', fn() {
        eq(gainToDb(1.0), -12.0);
        assert(Math.abs(mrdrumsDbToGain(gainToDb(1.0)) - 1.0) < 1e-6);
        assert(Math.abs(mrdrumsDbToGain(gainToDb(2.0)) - 2.0) < 1e-3);
        assert(Math.abs(mrdrumsDbToGain(gainToDb(0.5)) - 0.5) < 1e-3);
    }},

    { name: 'exportKit writes, validates round-trip, reports pad count', fn() {
        const FS = new Map();
        const kit = kitWith([[0, 'Kick', 'k.wav'], [2, 'Clap', 'c.wav']]);
        const r = exportKit(kit, { dir: '/x', name: 'K', write: (p, s) => { FS.set(p, s); return true; } });
        assert(r.ok, JSON.stringify(r.errors));
        eq(r.path, '/x/K.ablpreset');
        eq(r.padCount, 2);
        const parsed = JSON.parse(FS.get('/x/K.ablpreset'));
        eq(parsed.chains[0].devices[0].chains.length, 2);
    }},

    { name: 'an all-empty kit is refused, not written', fn() {
        const r = exportKit(createKit(DEFAULT_CONFIG), { dir: '/x', name: 'E', write: () => { throw new Error('should not write'); } });
        eq(r.ok, false);
        assert(r.errors.join(' ').includes('no assigned pads'));
    }},

    { name: 'a wrong-extension sample is warned but still exported', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        kit.pads[0].sample = {
            filesystem_path: '/data/UserData/UserLibrary/Samples/x/thing.mp3',
            ableton_uri: 'ableton:/user-library/Samples/x/thing.mp3',
            filename: 'thing.mp3', source: 'user', category: 'kick'
        };
        const { warnings, padCount } = buildMrDrumsPreset(kit);
        eq(padCount, 1);
        assert(warnings.some((w) => w.includes('.wav')));
    }},

    { name: 'a sample with no usable path is dropped from the export', fn() {
        const kit = createKit(DEFAULT_CONFIG);
        kit.pads[0].sample = { filesystem_path: 'relative/thing.wav', filename: 'thing.wav', source: 'user', category: 'kick', ableton_uri: null };
        const { warnings, padCount } = buildMrDrumsPreset(kit);
        eq(padCount, 0);
        assert(warnings.some((w) => w.includes('could not form')));
    }}
];
