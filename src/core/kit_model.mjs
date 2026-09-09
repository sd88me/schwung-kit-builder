/*
 * Kit Builder — internal kit data model (spec §6)
 *
 * The internal model is the single source of truth (§4.1) and stays
 * independent of Ableton / MPC file structures. Pure module: no `os`,
 * no `host_*`.
 */

/* Pad 1..16 -> MIDI note 36..51 (spec §6.4). Configurable later if MrDrums
 * uses a different contract. */
export const PAD_MIDI_NOTES = Array.from({ length: 16 }, (_, i) => 36 + i);

/* Fallback default role labels (spec §6.4), used only if the config's
 * role_rules don't place a pad. */
const FALLBACK_ROLE_BY_PAD = [
    'kick', 'snare', 'clap', 'open_hat', 'closed_hat', 'percussion', 'fx',
    'other', 'other', 'other', 'other', 'other', 'other', 'other', 'other', 'other'
];

function nowIso() { return new Date().toISOString(); }

/* Cheap UUID-ish id for diagnostics (§6.1 kit_id). Not crypto-grade. */
export function kitId() {
    const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${h()}${h()}-${h()}-4${h().slice(1)}-${((Math.random() * 4) | 8).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
}

/* Which role owns a given pad number, per config.role_rules[*].pads (§7.1). */
export function roleForPad(padNum, roleRules) {
    if (roleRules) {
        for (const role of Object.keys(roleRules)) {
            const pads = (roleRules[role] && roleRules[role].pads) || [];
            if (pads.indexOf(padNum) !== -1) return role;
        }
    }
    return FALLBACK_ROLE_BY_PAD[padNum - 1] || 'other';
}

/* One pad object (spec §6.2 / §6.3). Empty pad -> sample: null. */
export function makePad(padNum, roleRules) {
    return {
        pad: padNum,
        midi_note: PAD_MIDI_NOTES[padNum - 1],
        role: roleForPad(padNum, roleRules),
        locked: false,
        sample: null,
        playback: { gain: 1.0 }   // Rev. 2: gain only
    };
}

/* A fresh, empty 16-pad kit (spec §6.1, §3.1 "always opens a blank kit"). */
export function createKit(config) {
    const roleRules = config && config.role_rules;
    return {
        schema_version: 1,
        application: 'kit-builder',
        kit_id: kitId(),
        name: '',
        created_at: nowIso(),
        modified_at: nowIso(),
        source_mode: (config && config.source_mode) || 'user',
        random_seed: 0,
        prevent_duplicates: true,
        pads: Array.from({ length: 16 }, (_, i) => makePad(i + 1, roleRules))
    };
}

/* Build the sample sub-object stored on a pad from an index record (§6.2). */
export function sampleFromRecord(rec) {
    return {
        filesystem_path: rec.filesystem_path,
        ableton_uri: rec.ableton_uri || null,
        source: rec.source || 'user',
        filename: rec.filename,
        category: rec.category
    };
}

export function lockedCount(kit) {
    return kit.pads.reduce((n, p) => n + (p.locked ? 1 : 0), 0);
}
export function assignedCount(kit) {
    return kit.pads.reduce((n, p) => n + (p.sample ? 1 : 0), 0);
}

/* Toggle one pad's lock (spec §11.2 / §11.3). Locking an empty pad is allowed. */
export function toggleLock(kit, padIndex) {
    const p = kit.pads[padIndex];
    p.locked = !p.locked;
    kit.modified_at = nowIso();
    return p.locked;
}

/* Clear all UNLOCKED pads (spec §13.2 Clear / §11.3). Never touches audio
 * files (§19). Returns how many pads were cleared. */
export function clearUnlocked(kit) {
    let n = 0;
    for (const p of kit.pads) {
        if (!p.locked && p.sample) { p.sample = null; n++; }
    }
    if (n) kit.modified_at = nowIso();
    return n;
}

/* Remove the lock from every pad (spec §13.2 Unlock All). Returns how many
 * were actually unlocked. */
export function unlockAll(kit) {
    let n = 0;
    for (const p of kit.pads) {
        if (p.locked) { p.locked = false; n++; }
    }
    if (n) kit.modified_at = nowIso();
    return n;
}

/* Clear one pad if it is unlocked (spec §13.3 Clear Pad). Returns
 * 'cleared' | 'locked' | 'empty'. */
export function clearPad(kit, padIndex) {
    const p = kit.pads[padIndex];
    if (p.locked) return 'locked';
    if (!p.sample) return 'empty';
    p.sample = null;
    kit.modified_at = nowIso();
    return 'cleared';
}

/* Per-pad playback gain, 0.0..2.0 (1.0 = 0 dB). Spec §13.3 Gain. */
export function setPadGain(kit, padIndex, gain) {
    const p = kit.pads[padIndex];
    if (!p) return 1.0;
    const g = Math.max(0, Math.min(2, Number(gain) || 0));
    p.playback.gain = g;
    kit.modified_at = nowIso();
    return g;
}

export function gainToDbLabel(gain) {
    const g = Number(gain);
    if (!(g > 0)) return '-inf dB';
    const db = 20 * Math.log10(g);
    return (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB';
}
