/*
 * Automatic loudness matching (Batch E1). The DSP measures RMS; this module
 * turns the readings into per-pad makeup gains.
 */
import { assert, eq } from './run.js';
import { parseLoudness, matchGains } from '../src/core/loudness.mjs';

export const tests = [
    { name: 'parseLoudness -> 16 floats, junk/negatives become 0', fn() {
        const l = parseLoudness('0.10 0.20 0.0000 0.4  -1 x');
        eq(l.length, 16);
        eq(l[0], 0.10); eq(l[1], 0.20); eq(l[2], 0); eq(l[3], 0.4);
        eq(l[4], 0); eq(l[5], 0);            // "-1" and "x" -> 0
        eq(l[15], 0);
        eq(parseLoudness(null).every((x) => x === 0), true);
    }},

    { name: 'matchGains: pulls a lopsided kit toward the median', fn() {
        // median of [0.1, 0.2, 0.4] is 0.2 -> gains 2.0, 1.0, 0.5
        const g = matchGains([0.1, 0.2, 0.4]);
        eq(g[0], 2.0);
        eq(g[1], 1.0);
        eq(g[2], 0.5);
        for (let i = 3; i < 16; i++) eq(g[i], 1.0);   // empty slots untouched
    }},

    { name: 'matchGains: empty / silent slots keep gain 1.0', fn() {
        const g = matchGains([0.2, 0, 0.05, 0]);
        eq(g[1], 1.0);
        eq(g[3], 1.0);
        assert(g[2] > 1.0, 'the quiet-but-present slot is boosted');
    }},

    { name: 'matchGains: all-silent -> all 1.0', fn() {
        eq(matchGains([0, 0, 0]).every((x) => x === 1.0), true);
        eq(matchGains([]).every((x) => x === 1.0), true);
    }},

    { name: 'matchGains: respects the gain caps', fn() {
        // one very quiet, one very loud sample against a mid target
        const g = matchGains([0.005, 0.5, 0.1], { target: 0.1 });
        eq(g[0], 2.0);      // 0.1/0.005 = 20 -> clamped to maxGain 2.0
        eq(g[1], 0.25);     // 0.1/0.5 = 0.2 -> clamped to minGain 0.25
        eq(g[2], 1.0);
    }},

    { name: 'matchGains: explicit target + custom caps', fn() {
        const g = matchGains([0.2, 0.1], { target: 0.2, minGain: 0.5, maxGain: 4 });
        eq(g[0], 1.0);
        eq(g[1], 2.0);     // 0.2/0.1 = 2, within [0.5, 4]
    }}
];
