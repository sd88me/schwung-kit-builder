/*
 * Kit Builder — Akai MPC .xpm export (post-MVP Batch D3)
 *
 * The MPC program format is not documented; per github.com/psrpinto/roger the
 * safe approach is to take a real exported .xpm as a template and change only
 * what must change. `xpm_template.mjs` holds that reference (an MPC-V 2.1 Drum
 * program) split into structural chunks. Here we:
 *   - set <ProgramName>
 *   - emit 128 <Instrument> blocks (the MPC always writes the full pad
 *     complement); for kit pads 1..16 with a sample, set Layer 1's
 *     <SampleName>; empty pads keep the template's empty name
 *   - regenerate <PadNoteMap> (Note = 35 + pad) and <PadGroupMap> (all 0)
 * Everything else — per-pad envelopes, filters, LFO, pad colours in
 * <ProgramPads-v2.10> — is kept byte-for-byte from the reference.
 *
 * Samples are referenced by bare name; the MPC loads `<SampleName>.wav` from
 * the .xpm's own folder. We can't copy audio from module JS, so the export
 * writes a MANIFEST.txt mapping each name to its source path for the user (or
 * a later copy step) to gather. `<SliceEnd>` is left 0 (whole-sample one-shot,
 * as the template's unused layers are) — revisit if an MPC truncates playback.
 *
 * Pure module: no os / host_*. Caller supplies write()/mkdir().
 */

import {
    XPM_HEAD, XPM_PROGPADS, XPM_PROG_PARAMS, XPM_INSTRUMENT, XPM_TAIL,
    XPM_SAMPLENAME_MARK, XPM_SLICEEND_MARK, toCRLF
} from './xpm_template.mjs';

const N_INSTR = 128;    // MPC drum program: always 128 pads
const KIT_PADS = 16;
const NAME_MAX = 42;
export const MPC_EXPORT_ROOT = '/data/UserData/UserLibrary/KitBuilder/Exports/MPC';

function slug(s) {
    const t = String(s == null ? '' : s)
        .replace(/^.*[\/\\]/, '')                 // keep basename only
        .replace(/\.[^.]+$/, '')                  // drop extension
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return t || 'sample';
}

function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* MPC-safe sample name: "<kit>-<NN>-<file>", no extension, capped. */
export function mpcSampleName(kitName, pad, filename) {
    const nn = String(pad).padStart(2, '0');
    let name = `${slug(kitName)}-${nn}-${slug(filename)}`;
    if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).replace(/[_-]+$/, '');
    return name;
}

/* One <Instrument number="n"> block. `sampleName` '' => empty pad, which in a
 * real MPC export differs from a populated pad by two inert defaults
 * (WarpTempo 120 vs 20, Layer-1 SliceLoopCrossFadeLength -1 vs 0) — matched
 * here so the file is byte-identical in shape to the reference. */
function instrumentBlock(n, sampleName) {
    let b = XPM_INSTRUMENT.replace('<Instrument number="1">', `<Instrument number="${n}">`);
    b = b.replace(XPM_SAMPLENAME_MARK, `<SampleName>${xmlEscape(sampleName)}</SampleName>`);
    b = b.replace(XPM_SLICEEND_MARK, '<SliceEnd>0</SliceEnd>');
    if (!sampleName) {
        b = b.replace('<WarpTempo>20.000000</WarpTempo>', '<WarpTempo>120.000000</WarpTempo>');
        b = b.replace('<SliceLoopCrossFadeLength>0</SliceLoopCrossFadeLength>',
                      '<SliceLoopCrossFadeLength>-1</SliceLoopCrossFadeLength>');
    }
    return b;
}

function padNoteMap() {
    /* Note = 35 + pad, wrapped into MIDI range 0..127 (matches the reference:
     * pads 1..92 -> 36..127, pad 93 -> 0, ... pad 128 -> 35). */
    let s = '    <PadNoteMap>\n';
    for (let i = 1; i <= N_INSTR; i++) {
        s += `      <PadNote number="${i}">\n        <Note>${(35 + i) % 128}</Note>\n      </PadNote>\n`;
    }
    return s + '    </PadNoteMap>\n';
}

function padGroupMap() {
    let s = '    <PadGroupMap>\n';
    for (let i = 1; i <= N_INSTR; i++) {
        s += `      <PadGroup number="${i}">\n        <Group>0</Group>\n      </PadGroup>\n`;
    }
    return s + '    </PadGroupMap>\n';
}

/*
 * buildXpm(kit) -> { text, warnings, padCount, manifest }
 * `manifest` is [{ pad, sampleName, sourcePath }] for the assigned pads.
 */
export function buildXpm(kit) {
    const warnings = [];
    const name = (kit && kit.name) || 'Kit Builder';
    const pads = (kit && kit.pads) || [];

    const manifest = [];
    const seen = {};
    const instrs = [];
    for (let n = 1; n <= N_INSTR; n++) {
        let sn = '';
        if (n <= KIT_PADS) {
            const p = pads[n - 1];
            if (p && p.sample && p.sample.filesystem_path) {
                sn = mpcSampleName(name, n, p.sample.filename || p.sample.filesystem_path);
                if (seen[sn]) sn = (sn + '_' + n).slice(0, NAME_MAX);
                seen[sn] = true;
                const fs = p.sample.filesystem_path;
                if (fs.charAt(0) !== '/') warnings.push(`pad ${n}: sample path is not absolute`);
                manifest.push({ pad: n, sampleName: sn, sourcePath: fs });
            }
        }
        instrs.push(instrumentBlock(n, sn));
    }

    const progName = `    <ProgramName>${xmlEscape(name)}</ProgramName>\n`;
    const text =
        toCRLF(XPM_HEAD + progName) +
        XPM_PROGPADS +
        toCRLF(XPM_PROG_PARAMS + instrs.join('') + '    </Instruments>\n' + padNoteMap() + padGroupMap()) +
        toCRLF(XPM_TAIL);

    return { text, warnings, padCount: manifest.length, manifest };
}

export function manifestText(manifest) {
    return 'Kit Builder MPC export — place each source file next to this .xpm,\n' +
        'renamed to <SampleName>.wav (the MPC matches samples by name).\n\n' +
        (manifest || []).map((m) => `${m.sampleName}\t${m.sourcePath}`).join('\n') + '\n';
}

/*
 * exportXpm(kit, { dir, name, write, mkdir }) -> { ok, path, dir, warnings, errors, padCount }
 *   write(path, string) -> boolean   (required)
 *   mkdir(path)                       (optional)
 * Never throws.
 */
export function exportXpm(kit, opts) {
    opts = opts || {};
    if (!kit || !Array.isArray(kit.pads)) return { ok: false, errors: ['no kit'], warnings: [] };

    const { text, warnings, padCount, manifest } = buildXpm(kit);
    if (padCount === 0) return { ok: false, errors: ['kit has no assigned pads'], warnings };

    const base = String(opts.name || kit.name || 'Kit Builder').replace(/[\/\\]/g, '_');
    const dir = (opts.dir || MPC_EXPORT_ROOT) + '/' + base;
    if (typeof opts.mkdir === 'function') opts.mkdir(dir);

    const xpmPath = `${dir}/${base}.xpm`;
    if (typeof opts.write !== 'function') return { ok: false, errors: ['no write() provided'], warnings, path: xpmPath, text };
    if (!opts.write(xpmPath, text)) return { ok: false, errors: ['xpm write failed'], warnings, path: xpmPath };
    opts.write(`${dir}/MANIFEST.txt`, manifestText(manifest));   // best-effort

    return { ok: true, path: xpmPath, dir, warnings, errors: [], padCount };
}
