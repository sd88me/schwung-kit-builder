/*
 * Kit Builder — Move drum preset export (spec §16, §24)
 *
 * The export target is the **native Move drum-rack preset** — the same
 * `.ablpreset` Move writes for its own Track Presets. It is not a
 * MrDrums-proprietary format; MrDrums (handcraftedcc/schwung-mrdrums) just
 * happens to load the same file, via set_param("ui_preset_path", …), by
 * walking  instrumentRack -> drumRack -> chains[] , one chain per pad:
 *
 *   { "drumZoneSettings": { "receivingNote": 36..51, "chokeGroup": null },
 *     "devices": [ { "kind": "drumCell",
 *       "deviceData": { "sampleUri": "<uri>" },
 *       "parameters": { <full 42-param block — see DRUM_CELL_DEFAULTS> } } ] }
 *
 * The drumCell parameter block is written in full (verbatim from a real Move
 * drum-rack export) so the preset satisfies Move's own Track-Preset loader.
 * Kit Builder only drives `Volume` (from pad gain) and `Pan`; a consumer that
 * reads the preset (Move, MrDrums) takes the rest from these defaults.
 *
 * A loader maps Volume dB -> gain as  gain = 10^((dB+12)/20)  (so -12 dB = 1.0),
 * and resolves sampleUri: `ableton:/user-library/X` -> `/data/UserData/UserLibrary/X`,
 * `ableton:/packs/abl-core-library/X` -> `/data/CoreLibrary/X`, absolute `/…`
 * as-is; the string is url-decoded first (so `%20` and `+` both mean space).
 *
 * We emit one chain per ASSIGNED pad (empty pads are simply absent, as in a
 * real Ableton drum rack), with `ableton:/user-library/` percent-encoded URIs.
 * Pure module — the caller does the file write.
 */

const SCHEMA = 'http://tech.ableton.com/schema/song/1.8.2/devicePreset.json';
const USER_URI_PREFIX = 'ableton:/user-library/';
const USER_FS_PREFIX = '/data/UserData/UserLibrary/';
const CORE_URI_PREFIX = 'ableton:/packs/abl-core-library/';
const CORE_FS_PREFIX = '/data/CoreLibrary/';
const AUDIO_EXT = ['.wav', '.aif', '.aiff'];

function hasAudioExt(p) {
    const lo = String(p || '').toLowerCase();
    return AUDIO_EXT.some((e) => lo.endsWith(e));
}

/* Percent-encode a path, keeping '/' as the separator (Ableton convention). */
function encodePath(p) {
    return String(p).split('/').map(encodeURIComponent).join('/');
}

/* Build the sampleUri a loader resolves back to sample.filesystem_path. */
export function sampleUriFor(sample) {
    if (sample.ableton_uri && sample.ableton_uri.indexOf(USER_URI_PREFIX) === 0) {
        return USER_URI_PREFIX + encodePath(sample.ableton_uri.slice(USER_URI_PREFIX.length));
    }
    if (sample.ableton_uri && sample.ableton_uri.indexOf(CORE_URI_PREFIX) === 0) {
        return CORE_URI_PREFIX + encodePath(sample.ableton_uri.slice(CORE_URI_PREFIX.length));
    }
    const fs = sample.filesystem_path || '';
    if (fs.indexOf(USER_FS_PREFIX) === 0) {
        return USER_URI_PREFIX + encodePath(fs.slice(USER_FS_PREFIX.length));
    }
    if (fs.indexOf(CORE_FS_PREFIX) === 0) {
        return CORE_URI_PREFIX + encodePath(fs.slice(CORE_FS_PREFIX.length));
    }
    if (fs.charAt(0) === '/') {
        return '/' + fs.split('/').filter((s) => s.length > 0).map(encodeURIComponent).join('/');
    }
    return '';
}

/* gain (0..2] -> Ableton Volume dB. gain 1.0 -> -12.0 (MrDrums unity ref). */
export function gainToDb(gain) {
    const g = Math.max(1e-4, Math.min(2, Number(gain) || 1));
    return Math.round((20 * Math.log10(g) - 12) * 1e4) / 1e4;
}

/*
 * A drumCell's full 42-parameter block, verbatim from a real Move drum-rack
 * export (every pad carried an identical block). MrDrums only reads the
 * handful it needs, but writing the complete set keeps the preset valid for
 * Move's own Track-Preset loader too. `Volume` and `Pan` are the only two
 * Kit Builder drives from the kit model.
 */
const DRUM_CELL_DEFAULTS = {
    Effect_EightBitFilterDecay: 5, Effect_EightBitResamplingRate: 14080,
    Effect_FmAmount: 0, Effect_FmFrequency: 1000,
    Effect_LoopLength: 0.3, Effect_LoopOffset: 0.02,
    Effect_NoiseAmount: 0, Effect_NoiseFrequency: 10000,
    Effect_On: true, Effect_PitchEnvelopeAmount: 0, Effect_PitchEnvelopeDecay: 0.3,
    Effect_PunchAmount: 0, Effect_PunchTime: 0.12,
    Effect_RingModAmount: 0, Effect_RingModFrequency: 1000,
    Effect_StretchFactor: 1, Effect_StretchGrainSize: 0.1,
    Effect_SubOscAmount: 0, Effect_SubOscFrequency: 60,
    Effect_Type: 'Stretch',
    Enabled: true, NotePitchBend: true, Pan: 0,
    Voice_Detune: 0,
    Voice_Envelope_Attack: 0.0001, Voice_Envelope_Decay: 1,
    Voice_Envelope_Hold: 0.3, Voice_Envelope_Mode: 'A-H-D',
    Voice_Filter_Frequency: 22000, Voice_Filter_On: true,
    Voice_Filter_PeakGain: 1, Voice_Filter_Resonance: 0, Voice_Filter_Type: 'Lowpass',
    Voice_Gain: 1,
    Voice_ModulationAmount: 0, Voice_ModulationSource: 'Velocity', Voice_ModulationTarget: 'Filter',
    Voice_PlaybackLength: 1, Voice_PlaybackStart: 0,
    Voice_Transpose: 0, Voice_VelocityToVolume: 0.35,
    Volume: -12
};

function drumCell(sample, gain) {
    return {
        kind: 'drumCell',
        deviceData: { sampleUri: sampleUriFor(sample) },
        parameters: Object.assign({}, DRUM_CELL_DEFAULTS, {
            Volume: gainToDb(gain),
            Pan: 0.0
        })
    };
}

/*
 * buildMrDrumsPreset(kit) -> { doc, warnings }
 * `doc` is the .ablpreset object; `warnings` lists per-pad issues that don't
 * block the export (a sample path that is not absolute, wrong extension, or a
 * URI that could not be formed).
 */
export function buildMrDrumsPreset(kit) {
    const warnings = [];
    const rackChains = [];

    for (const p of kit.pads) {
        if (!p.sample) continue;                       // empty pad -> absent (§21.7)
        const fs = p.sample.filesystem_path || '';
        if (fs.charAt(0) !== '/') warnings.push(`pad ${p.pad}: sample path is not absolute`);
        if (!hasAudioExt(fs))     warnings.push(`pad ${p.pad}: ${p.sample.filename || 'sample'} is not .wav/.aif/.aiff`);
        const uri = sampleUriFor(p.sample);
        if (!uri) { warnings.push(`pad ${p.pad}: could not form a sample URI`); continue; }

        rackChains.push({
            drumZoneSettings: { receivingNote: p.midi_note, chokeGroup: null },
            devices: [drumCell(p.sample, (p.playback && p.playback.gain) || 1.0)]
        });
    }

    const doc = {
        $schema: SCHEMA,
        kind: 'instrumentRack',
        name: kit.name || 'Kit Builder',
        chains: [
            { devices: [ { kind: 'drumRack', chains: rackChains } ] }
        ]
    };
    return { doc, warnings, padCount: rackChains.length };
}

/*
 * exportKit(kit, { write, dir, name }) -> { ok, path, warnings, errors, padCount }
 *   write(path, jsonString) -> boolean   (caller supplies; keeps this pure)
 *   dir   default Move's Track Presets folder
 *   name  default kit.name
 * Matches the deferred-exporter shape of §24. Never throws.
 */
export function exportKit(kit, opts) {
    opts = opts || {};
    const errors = [];
    if (!kit || !Array.isArray(kit.pads)) return { ok: false, errors: ['no kit'], warnings: [] };

    const { doc, warnings, padCount } = buildMrDrumsPreset(kit);
    if (padCount === 0) return { ok: false, errors: ['kit has no assigned pads'], warnings };

    const dir = opts.dir || '/data/UserData/UserLibrary/Track Presets';
    const name = String(opts.name || kit.name || 'Kit Builder').replace(/[\/\\]/g, '_');
    const path = `${dir}/${name}.ablpreset`;

    let json;
    try { json = JSON.stringify(doc, null, 2); } catch (e) { return { ok: false, errors: ['serialise: ' + e], warnings }; }

    /* Validate the written form parses and keeps its shape (§16.5). */
    try {
        const rt = JSON.parse(json);
        const rc = rt.chains[0].devices[0].chains;
        if (!Array.isArray(rc) || rc.length !== padCount) errors.push('round-trip pad count mismatch');
    } catch (e) { errors.push('round-trip parse failed: ' + e); }
    if (errors.length) return { ok: false, errors, warnings, path };

    if (typeof opts.write !== 'function') return { ok: false, errors: ['no write() provided'], warnings, path, json };
    if (!opts.write(path, json)) return { ok: false, errors: ['write failed'], warnings, path };

    return { ok: true, path, warnings, errors: [], padCount };
}
