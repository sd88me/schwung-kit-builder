/*
 * MPC .xpm export (Batch D3). Validates the template-substitution approach:
 * structure preserved, per-pad SampleName set, 128 instruments, PadNoteMap
 * regenerated, CRLF endings, MANIFEST mapping.
 */
import { assert, eq } from './run.js';
import { createKit, sampleFromRecord } from '../src/core/kit_model.mjs';
import { DEFAULT_CONFIG } from '../src/core/sample_index.mjs';
import { buildXpm, exportXpm, mpcSampleName, manifestText } from '../src/exporters/mpc_xpm.mjs';

function rec(cat, name, root) {
    const base = root || '/data/UserData/UserLibrary/Samples';
    return {
        filesystem_path: `${base}/${cat}/${name}`,
        ableton_uri: null, source: 'user', category: cat, filename: name, extension: '.wav'
    };
}
function kitWith(pairs, kitName) {
    const kit = createKit(DEFAULT_CONFIG);
    kit.name = kitName || 'Crunchy Kit';
    for (const [i, cat, name] of pairs) kit.pads[i].sample = sampleFromRecord(rec(cat, name));
    return kit;
}

export const tests = [
    { name: 'header + program name + drum type preserved from the template', fn() {
        const { text } = buildXpm(kitWith([[0, 'Kick', 'bd.wav']], 'My Kit'));
        assert(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'xml decl');
        assert(text.includes('<Application>MPC-V</Application>'));
        assert(text.includes('<File_Version>2.1</File_Version>'));
        assert(text.includes('<Program type="Drum">'));
        assert(text.includes('<ProgramName>My Kit</ProgramName>'));
    }},

    { name: 'exactly 128 instruments, numbered 1..128', fn() {
        const { text } = buildXpm(kitWith([[0, 'Kick', 'k.wav']]));
        const nums = (text.match(/<Instrument number="(\d+)">/g) || []).map((s) => +s.replace(/\D/g, ''));
        eq(nums.length, 128);
        eq(nums[0], 1);
        eq(nums[127], 128);
    }},

    { name: 'assigned pads get a Layer-1 SampleName; empty pads stay empty', fn() {
        const { text, padCount, manifest } = buildXpm(kitWith([
            [0, 'Kick', 'Big Kick.wav'], [1, 'Snare', 'snare 1.wav'], [15, 'Other', 'zap.wav']
        ], 'Kit A'));
        eq(padCount, 3);
        eq(manifest.map((m) => m.pad), [1, 2, 16]);
        assert(text.includes('<SampleName>Kit_A-01-Big_Kick</SampleName>'), 'pad 1 name');
        assert(text.includes('<SampleName>Kit_A-02-snare_1</SampleName>'), 'pad 2 name');
        assert(text.includes('<SampleName>Kit_A-16-zap</SampleName>'), 'pad 16 name');
        // template's first-instrument sample name must be gone
        assert(!text.includes('PRGKIT26BD1'), 'template placeholder leaked');
        // an unassigned pad (3) keeps an empty name
        const inst3 = text.slice(text.indexOf('<Instrument number="3">'), text.indexOf('<Instrument number="4">'));
        assert(inst3.includes('<SampleName></SampleName>'), 'pad 3 empty');
    }},

    { name: 'PadNoteMap: Note = (35 + pad) wrapped to 0..127, all 128 pads', fn() {
        const { text } = buildXpm(kitWith([[0, 'Kick', 'k.wav']]));
        const map = text.slice(text.indexOf('<PadNoteMap>'), text.indexOf('</PadNoteMap>'));
        assert(map.includes('<PadNote number="1">\r\n        <Note>36</Note>'));
        assert(map.includes('<PadNote number="16">\r\n        <Note>51</Note>'));
        assert(map.includes('<PadNote number="92">\r\n        <Note>127</Note>'));
        assert(map.includes('<PadNote number="93">\r\n        <Note>0</Note>'));
        assert(map.includes('<PadNote number="128">\r\n        <Note>35</Note>'));
        eq((map.match(/<PadNote number=/g) || []).length, 128);
    }},

    { name: 'CRLF line endings on structure, closes cleanly', fn() {
        const { text } = buildXpm(kitWith([[0, 'Kick', 'k.wav']]));
        assert(text.includes('<Program type="Drum">\r\n'), 'crlf on structure');
        assert(text.endsWith('  </Program>\r\n</MPCVObject>\r\n'), JSON.stringify(text.slice(-40)));
        assert(text.includes('<QLinkAssignments/>'), 'self-closed qlink');
        // ProgramPads JSON body stays LF (matches a real MPC export)
        assert(text.includes('<ProgramPads-v2.10>{\n'), 'progpads body is LF');
        assert(text.includes('}</ProgramPads-v2.10>\r\n'), 'progpads closes with CRLF');
    }},

    { name: 'mpcSampleName: no extension, safe chars, capped, pad-numbered', fn() {
        eq(mpcSampleName('Kit A', 3, 'Deep Kick 01.wav'), 'Kit_A-03-Deep_Kick_01');
        eq(mpcSampleName('K', 12, 'a/b\\c.aif'), 'K-12-c');
        assert(mpcSampleName('very long kit name here', 1, 'and a very long sample name too.wav').length <= 42);
    }},

    { name: 'exportXpm writes .xpm + MANIFEST, makes the folder, reports path', fn() {
        const FS = new Map(); const DIRS = [];
        const kit = kitWith([[0, 'Kick', 'k.wav'], [4, 'Closed Hat', 'ch.wav']], 'RT Kit');
        const r = exportXpm(kit, {
            dir: '/exp/MPC', name: 'RT Kit',
            mkdir: (p) => DIRS.push(p),
            write: (p, s) => { FS.set(p, s); return true; }
        });
        assert(r.ok, JSON.stringify(r.errors));
        eq(r.path, '/exp/MPC/RT Kit/RT Kit.xpm');
        eq(r.padCount, 2);
        assert(DIRS.includes('/exp/MPC/RT Kit'));
        assert(FS.has('/exp/MPC/RT Kit/MANIFEST.txt'));
        const man = FS.get('/exp/MPC/RT Kit/MANIFEST.txt');
        assert(man.includes('RT_Kit-01-k\t/data/UserData/UserLibrary/Samples/Kick/k.wav'));
        assert(man.includes('RT_Kit-05-ch\t/data/UserData/UserLibrary/Samples/Closed Hat/ch.wav'));
    }},

    { name: 'an all-empty kit is refused', fn() {
        const r = exportXpm(createKit(DEFAULT_CONFIG), { dir: '/x', name: 'E', write: () => { throw new Error('no'); } });
        eq(r.ok, false);
        assert(r.errors.join(' ').includes('no assigned pads'));
    }},

    { name: 'duplicate sample on two pads still yields distinct SampleNames', fn() {
        const { text } = buildXpm(kitWith([[0, 'Kick', 'k.wav'], [1, 'Kick', 'k.wav']], 'Dup'));
        const names = (text.match(/<SampleName>Dup-[^<]+<\/SampleName>/g) || []);
        eq(names.length, 2);
        assert(names[0] !== names[1], names.join(' == '));
    }}
];
