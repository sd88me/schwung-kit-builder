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
 * Samples are referenced by their own basename (extension dropped, made
 * filesystem/XML-safe); the MPC loads `<SampleName>.wav` from the .xpm's own
 * folder. When the caller supplies copy(src, dest) the export gathers each
 * source file into that folder as `<SampleName><ext>`; otherwise (and for any
 * copy that fails) MANIFEST.txt lists what to place by hand.
 * `<SliceEnd>` is left 0 (whole-sample one-shot, as the template's unused
 * layers are) — revisit if an MPC truncates playback.
 *
 * Pure module: no os / host_*. Caller supplies write()/mkdir()/copy().
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
        .replace(/[^A-Za-z0-9 ()_-]+/g, '_')      // keep spaces + parens; other punctuation -> _
        .replace(/\s+/g, ' ')                     // collapse whitespace runs
        .replace(/^[ _-]+|[ _-]+$/g, '');
    return t || 'sample';
}

function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* MPC sample name = the source file's own basename, extension dropped,
 * filesystem/XML-safe (spaces kept), capped at NAME_MAX. The MPC loads
 * "<SampleName>.wav" from the .xpm's folder, so the gathered copy is named to
 * match. Duplicate names across pads are disambiguated in buildXpm(). */
export function mpcSampleName(filename) {
    let name = slug(filename);
    if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).replace(/[ _-]+$/, '');
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
 * `manifest` is [{ pad, sampleName, sourcePath, ext, destName }] for the
 * assigned pads. destName = sampleName + source ext — the file the MPC wants
 * sitting next to the .xpm.
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
                sn = mpcSampleName(p.sample.filename || p.sample.filesystem_path);
                if (seen[sn]) sn = (sn + ' ' + n).slice(0, NAME_MAX);
                seen[sn] = true;
                const fs = p.sample.filesystem_path;
                if (fs.charAt(0) !== '/') warnings.push(`pad ${n}: sample path is not absolute`);
                const dot = fs.lastIndexOf('.');
                const ext = dot > fs.lastIndexOf('/') ? fs.slice(dot).toLowerCase() : '.wav';
                manifest.push({ pad: n, sampleName: sn, sourcePath: fs, ext, destName: sn + ext });
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

/* manifestText(manifest, { attempted }) -> string
 * `attempted` true => the export tried to copy the WAVs itself; each row is
 * tagged [gathered] or [MISSING] (a MISSING row must be placed by hand). */
export function manifestText(manifest, opts) {
    const attempted = !!(opts && opts.attempted);
    const rows = (manifest || []).map((m) => {
        const dest = m.destName || (m.sampleName + '.wav');
        const tag = attempted ? (m.gathered ? '\t[gathered]' : '\t[MISSING — copy by hand]') : '';
        return `${dest}\t${m.sourcePath}${tag}`;
    }).join('\n');
    const head = attempted
        ? 'Kit Builder MPC export — the files below were copied next to this .xpm.\n' +
          'Any row tagged [MISSING] must be placed by hand (keep the left-hand name).\n\n'
        : 'Kit Builder MPC export — place each source file next to this .xpm,\n' +
          'keeping the left-hand name (the MPC matches samples by name).\n\n';
    return head + rows + '\n';
}

/*
 * exportXpm(kit, { dir, name, write, mkdir, copy }) -> { ok, path, dir, warnings, errors, padCount, gathered }
 *   write(path, string) -> boolean        (required)
 *   mkdir(path)                           (optional)
 *   copy(srcPath, destPath) -> boolean    (optional) — gather the WAVs beside
 *       the .xpm; a falsy return leaves that sample for MANIFEST.txt
 * `gathered` is the count of samples copied in. Never throws.
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

    /* Gather the audio into the .xpm's folder when the caller can copy files.
     * Non-fatal: MANIFEST.txt still lists every source, tagged with the
     * outcome, so a failed copy just falls back to a manual step. */
    const canCopy = typeof opts.copy === 'function';
    let gathered = 0;
    for (const m of manifest) {
        if (m.ext && m.ext !== '.wav') {
            warnings.push(`pad ${m.pad}: source is ${m.ext}; the MPC loads ${m.sampleName}.wav beside the .xpm`);
        }
        if (!canCopy) { m.gathered = false; continue; }
        m.gathered = !!opts.copy(m.sourcePath, `${dir}/${m.destName}`);
        if (m.gathered) gathered++;
        else warnings.push(`pad ${m.pad}: could not copy ${m.sourcePath}`);
    }

    opts.write(`${dir}/MANIFEST.txt`, manifestText(manifest, { attempted: canCopy }));   // best-effort

    return { ok: true, path: xpmPath, dir, warnings, errors: [], padCount, gathered };
}
