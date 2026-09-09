/*
 * Kit Builder — MrDrums export (spec §16, §24)
 *
 * The "MrDrums-compatible JSON" of the spec is, in the shipping MrDrums
 * (handcraftedcc/schwung-mrdrums), the **Ableton native drum-rack preset**:
 * MrDrums loads a `.ablpreset` / `.json` via set_param("ui_preset_path", …)
 * and walks  instrumentRack -> drumRack -> chains[] , one chain per pad:
 *
 *   { "drumZoneSettings": { "receivingNote": 36..51, "chokeGroup": null },
 *     "devices": [ { "kind": "drumCell",
 *       "deviceData": { "sampleUri": "<uri>" },
 *       "parameters": { "Volume": <dB>, "Pan": 0, "Voice_Transpose": 0,
 *                       "Voice_PlaybackStart": 0, "Voice_Envelope_Attack": 0,
 *                       "Voice_Envelope_Decay": 0.25 } } ] }
 *
 * MrDrums maps Volume dB -> gain as  gain = 10^((dB+12)/20)  (so -12 dB = 1.0),
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
const AUDIO_EXT = ['.wav', '.aif', '.aiff'];

function hasAudioExt(p) {
    const lo = String(p || '').toLowerCase();
    return AUDIO_EXT.some((e) => lo.endsWith(e));
}

/* Percent-encode a path, keeping '/' as the separator (Ableton convention). */
function encodePath(p) {
    return String(p).split('/').map(encodeURIComponent).join('/');
}

/* Build the sampleUri MrDrums will resolve back to sample.filesystem_path. */
export function sampleUriFor(sample) {
    if (sample.ableton_uri && sample.ableton_uri.indexOf(USER_URI_PREFIX) === 0) {
        return USER_URI_PREFIX + encodePath(sample.ableton_uri.slice(USER_URI_PREFIX.length));
    }
    const fs = sample.filesystem_path || '';
    if (fs.indexOf(USER_FS_PREFIX) === 0) {
        return USER_URI_PREFIX + encodePath(fs.slice(USER_FS_PREFIX.length));
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

function drumCell(sample, gain) {
    return {
        kind: 'drumCell',
        deviceData: { sampleUri: sampleUriFor(sample) },
        parameters: {
            Volume: gainToDb(gain),
            Pan: 0.0,
            Voice_Transpose: 0,
            Voice_PlaybackStart: 0.0,
            Voice_Envelope_Attack: 0.0,
            Voice_Envelope_Decay: 0.25
        }
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
