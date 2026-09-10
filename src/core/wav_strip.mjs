/*
 * Kit Builder — WAV metadata stripping (Batch F, adapted from
 * github.com/klingklangmatze/drum-kit-generator `strip_wav_metadata`).
 *
 * Keeps only the `fmt `, `fact` and `data` chunks of a little-endian
 * RIFF/WAVE file and drops everything else — LIST/INFO, bext, iXML, ID3,
 * PEAK, JUNK, cue, smpl, … — so a copied sample is smaller and an importer
 * has less to choke on. Used by the MPC `.xpm` gather (storage.hCopy).
 *
 * Pure: bytes in, bytes out, no `os` / `host_*`. Anything that is not a
 * well-formed RIFF/WAVE (AIFF, FLAC, MP3, truncated, or a header we don't
 * understand) is returned UNCHANGED — same fallback as the Python.
 *
 *   stripWav(bytes)        Uint8Array | number[]  -> Uint8Array
 *   stripWavString(str)    latin1-ish string      -> string
 *
 * `stripWavString` is the bridge for the `host_read_file` → `host_write_file`
 * round-trip (each char treated as one byte). It carries the same
 * binary-safety caveat as that round-trip: if the host mangled bytes ≥ 0x80
 * on read, chunk walking bails out and the original string is returned
 * untouched. `stripWav` (the byte-array form) is kept for any future
 * exporter that copies audio directly.
 */

const KEEP = { 'fmt ': 1, 'fact': 1, 'data': 1 };

function u32le(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function w32le(b, o, v) {
    b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff;
    b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
}
function tag(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}
function putTag(b, o, t) {
    for (let i = 0; i < 4; i++) b[o + i] = t.charCodeAt(i);
}

export function stripWav(input) {
    const b = input instanceof Uint8Array ? input : Uint8Array.from(input || []);
    if (b.length < 12 || tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'WAVE') return b;

    const kept = [];               // { id, body, size }
    let o = 12, sawFmt = false, sawData = false;
    while (o + 8 <= b.length) {
        const id = tag(b, o);
        const size = u32le(b, o + 4);
        const body = o + 8;
        if (body + size > b.length) break;          // truncated chunk — stop here
        if (KEEP[id]) {
            kept.push({ id, body, size });
            if (id === 'fmt ') sawFmt = true;
            else if (id === 'data') sawData = true;
        }
        o = body + size + (size & 1);               // chunks are word-aligned
    }
    if (!sawFmt || !sawData) return b;              // not a shape we can rebuild

    let total = 12;
    for (const k of kept) total += 8 + k.size + (k.size & 1);
    if (total >= b.length) return b;                // nothing to gain — keep original

    const out = new Uint8Array(total);
    putTag(out, 0, 'RIFF');
    w32le(out, 4, total - 8);
    putTag(out, 8, 'WAVE');
    let p = 12;
    for (const k of kept) {
        putTag(out, p, k.id);
        w32le(out, p + 4, k.size);
        out.set(b.subarray(k.body, k.body + k.size), p + 8);
        p += 8 + k.size;
        if (k.size & 1) out[p++] = 0;               // re-pad to word alignment
    }
    return out;
}

export function stripWavString(s) {
    if (typeof s !== 'string' || s.length < 12) return s;
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    const out = stripWav(b);
    if (out === b || out.length === b.length) return s;   // passthrough — keep exact original
    let r = '';
    for (let i = 0; i < out.length; i++) r += String.fromCharCode(out[i]);
    return r;
}

export function isWavName(name) {
    return /\.wav$/i.test(String(name || ''));
}
