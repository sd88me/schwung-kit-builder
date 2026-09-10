/*
 * WAV metadata stripping (Batch F — used by the MPC .xpm gather). Verifies
 * fmt+data survive byte-for-byte, junk chunks are dropped, odd-size padding is
 * handled, and anything we don't understand passes through untouched.
 */
import { assert, eq } from './run.js';
import { stripWav, stripWavString, isWavName } from '../src/core/wav_strip.mjs';

const enc = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

/* Build a RIFF/WAVE from [id, bytesArray] chunks. */
function wav(chunks) {
    let body = [];
    for (const [id, data] of chunks) {
        body = body.concat(enc(id), u32(data.length), data);
        if (data.length & 1) body.push(0);           // word-align pad
    }
    return Uint8Array.from(enc('RIFF').concat(u32(4 + body.length), enc('WAVE'), body));
}

const FMT = enc('\x01\x00\x02\x00' + '\x44\xAC\x00\x00' + '\x10\xB1\x02\x00' + '\x04\x00\x10\x00'); // 16-byte PCM fmt
const DATA = [1, 2, 3, 4, 5, 6, 7, 8];
const LIST = enc('INFOISFT' + '\x08\x00\x00\x00' + 'Ableton\x00');

function chunksOf(bytes) {
    const out = [];
    let o = 12;
    const tag = (p) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const u = (p) => (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
    while (o + 8 <= bytes.length) {
        const id = tag(o); const sz = u(o + 4);
        out.push({ id, sz, body: Array.from(bytes.subarray(o + 8, o + 8 + sz)) });
        o += 8 + sz + (sz & 1);
    }
    return out;
}

export const tests = [
    { name: 'drops a LIST/INFO chunk, keeps fmt + data byte-for-byte', fn() {
        const src = wav([['fmt ', FMT], ['LIST', LIST], ['data', DATA]]);
        const out = stripWav(src);
        const cs = chunksOf(out);
        eq(cs.map((c) => c.id), ['fmt ', 'data']);
        eq(cs[0].body, FMT);
        eq(cs[1].body, DATA);
        assert(out.length < src.length, 'stripped file is smaller');
        // RIFF size field = total - 8
        const riffSize = (out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24)) >>> 0;
        eq(riffSize, out.length - 8);
    }},

    { name: 'keeps fact (non-PCM) alongside fmt + data', fn() {
        const FACT = enc('\x10\x27\x00\x00');
        const out = stripWav(wav([['fmt ', FMT], ['fact', FACT], ['JUNK', [0, 0, 0, 0]], ['data', DATA]]));
        eq(chunksOf(out).map((c) => c.id), ['fmt ', 'fact', 'data']);
    }},

    { name: 'odd-size data chunk keeps its pad byte and word alignment', fn() {
        const ODD = [9, 9, 9];
        const out = stripWav(wav([['fmt ', FMT], ['bext', enc('meta')], ['data', ODD]]));
        const cs = chunksOf(out);
        eq(cs.map((c) => c.id), ['fmt ', 'data']);
        eq(cs[1].sz, 3);
        eq(cs[1].body, ODD);
        eq(out.length % 2, 0, 'total length stays even');
    }},

    { name: 'nothing to strip -> returns the original bytes unchanged', fn() {
        const src = wav([['fmt ', FMT], ['data', DATA]]);
        const out = stripWav(src);
        eq(Array.from(out), Array.from(src));
    }},

    { name: 'non-RIFF input passes through untouched', fn() {
        const aiff = Uint8Array.from(enc('FORM\x00\x00\x00\x10AIFF junk'));
        eq(stripWav(aiff), aiff);
        eq(Array.from(stripWav(Uint8Array.from([1, 2, 3]))), [1, 2, 3]);
    }},

    { name: 'truncated chunk -> passes through rather than corrupt', fn() {
        // declare a data chunk larger than the bytes present
        const bad = Uint8Array.from(enc('RIFF').concat(u32(100), enc('WAVE'), enc('fmt '), u32(16), FMT,
            enc('data'), u32(9999), [1, 2, 3]));
        eq(stripWav(bad), bad);
    }},

    { name: 'stripWavString round-trips through latin1 chars', fn() {
        const src = wav([['fmt ', FMT], ['LIST', LIST], ['data', DATA]]);
        const s = String.fromCharCode.apply(null, Array.from(src));
        const out = stripWavString(s);
        assert(out.length < s.length);
        eq(out.slice(0, 4), 'RIFF');
        eq(out.slice(8, 12), 'WAVE');
        // fmt + data payloads preserved
        const outBytes = Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
        eq(chunksOf(outBytes).map((c) => c.id), ['fmt ', 'data']);
    }},

    { name: 'stripWavString leaves a non-WAV / short string alone', fn() {
        eq(stripWavString('hello'), 'hello');
        eq(stripWavString('not a wav file at all, really'), 'not a wav file at all, really');
    }},

    { name: 'isWavName', fn() {
        assert(isWavName('kick.wav') && isWavName('KICK.WAV') && isWavName('a/b/c.Wav'));
        assert(!isWavName('kick.aif') && !isWavName('kick') && !isWavName(''));
    }}
];
