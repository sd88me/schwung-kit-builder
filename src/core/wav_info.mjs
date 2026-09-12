/*
 * Kit Builder — WAV sample-frame counting (MPC `.xpm` SliceEnd fix).
 *
 * The MPC `.xpm` reference kept its populated Layer-1 <SliceEnd> at the real
 * sample's frame count (33688, for a genuine 1-shot); mpc_xpm.mjs used to
 * leave every pad's SliceEnd at that same layer's inert `0` default instead.
 * SliceStart 0 + SliceEnd 0 is a zero-length region, so the pad played
 * silence — confirmed on a real Akai Force. This module computes the real
 * value from the sample's own WAV header.
 *
 * Pure module: bytes in, number out. No os / host_*. The host-side read
 * lives in storage.mjs and MUST go through host_read_file_base64, not
 * host_read_file: the latter hands raw bytes to QuickJS's JS_NewString,
 * which decodes them as UTF-8 and corrupts arbitrary audio bytes (this is
 * the same binary-safety hazard wav_strip.mjs's hCopy round-trip already
 * documents). host_read_file_base64's output is pure base64 ASCII, safe
 * through any string layer; base64Decode() below turns it back into bytes.
 */

function u32le(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function tag(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/* wavFrameCount(bytes) -> number | null
 * Walks a little-endian RIFF/WAVE's chunks for `fmt ` (channels, bits per
 * sample) and `data` (byte length); returns dataBytes / blockAlign. null for
 * anything that isn't a well-formed WAV we can read (AIFF, truncated, a
 * shape we don't understand) — caller falls back to the old SliceEnd 0. */
export function wavFrameCount(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    if (b.length < 12 || tag(b, 0) !== 'RIFF' || tag(b, 8) !== 'WAVE') return null;

    let channels = 0, bitsPerSample = 0, dataSize = -1;
    let o = 12;
    while (o + 8 <= b.length) {
        const id = tag(b, o);
        const size = u32le(b, o + 4);
        const body = o + 8;
        if (body + size > b.length) break;             // truncated chunk — stop here
        if (id === 'fmt ' && size >= 16) {
            channels = b[body + 2] | (b[body + 3] << 8);
            bitsPerSample = b[body + 14] | (b[body + 15] << 8);
        } else if (id === 'data') {
            dataSize = size;
        }
        o = body + size + (size & 1);                  // chunks are word-aligned
    }
    if (!channels || !bitsPerSample || dataSize < 0) return null;
    const blockAlign = channels * (bitsPerSample >> 3);
    return blockAlign > 0 ? Math.floor(dataSize / blockAlign) : null;
}

/* base64Decode(s) -> Uint8Array
 * Minimal RFC-4648 decoder for host_read_file_base64's output — there's no
 * atob() in QuickJS. Tolerant of stripped '=' padding; any other stray
 * character is dropped (the host only ever hands this trusted output). */
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function base64Decode(s) {
    s = String(s || '').replace(/[^A-Za-z0-9+/]/g, '');
    const len = s.length;
    const out = new Uint8Array(Math.floor(len * 3 / 4));
    let o = 0;
    for (let i = 0; i < len; i += 4) {
        const c0 = B64_CHARS.indexOf(s[i]);
        const c1 = B64_CHARS.indexOf(s[i + 1]);
        const c2 = i + 2 < len ? B64_CHARS.indexOf(s[i + 2]) : -1;
        const c3 = i + 3 < len ? B64_CHARS.indexOf(s[i + 3]) : -1;
        if (c0 < 0 || c1 < 0) break;
        out[o++] = (c0 << 2) | (c1 >> 4);
        if (c2 >= 0) out[o++] = ((c1 & 0xf) << 4) | (c2 >> 2);
        if (c3 >= 0) out[o++] = ((c2 & 0x3) << 6) | c3;
    }
    return o === out.length ? out : out.subarray(0, o);
}
