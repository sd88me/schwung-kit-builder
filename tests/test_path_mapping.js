/*
 * Filesystem-path -> Ableton-URI mapping (spec §9).
 */
import { eq, assert } from './run.js';
import { toAbletonUri, normalizePath, pathComponents } from '../src/core/path_mapping.mjs';

export const tests = [
    { name: 'user library conversion (§9.1)', fn() {
        const r = toAbletonUri('/data/UserData/UserLibrary/Samples/Kick/Kick01.wav');
        eq(r.error, null);
        eq(r.source, 'user');
        eq(r.uri, 'ableton:/user-library/Samples/Kick/Kick01.wav');
    }},

    { name: 'core library conversion is prepared (§9.2)', fn() {
        const r = toAbletonUri('/data/CoreLibrary/Samples/Drums/Kick01.wav');
        eq(r.error, null);
        eq(r.source, 'core');
        eq(r.uri, 'ableton:/packs/abl-core-library/Samples/Drums/Kick01.wav');
    }},

    { name: 'preserves case and spaces (§9.3)', fn() {
        const r = toAbletonUri('/data/UserData/UserLibrary/Samples/Open Hat/OH_01.WAV');
        eq(r.uri, 'ableton:/user-library/Samples/Open Hat/OH_01.WAV');
    }},

    { name: 'collapses duplicate slashes (§9.3)', fn() {
        const r = toAbletonUri('/data/UserData/UserLibrary/Samples//Kick///k.wav');
        eq(r.uri, 'ableton:/user-library/Samples/Kick/k.wav');
    }},

    { name: 'rejects unknown roots — never guesses (§9.3)', fn() {
        const r = toAbletonUri('/data/UserData/SomethingElse/x.wav');
        eq(r.uri, null);
        eq(r.error, 'unknown_root');
    }},

    { name: 'rejects .. traversal (§9.3)', fn() {
        const r = toAbletonUri('/data/UserData/UserLibrary/Samples/../../etc/passwd');
        eq(r.uri, null);
        eq(r.error, 'traversal');
    }},

    { name: 'rejects non-absolute input', fn() {
        eq(toAbletonUri('relative/path.wav').error, 'not_absolute');
    }},

    { name: 'helpers', fn() {
        eq(normalizePath('/a//b/c/'), '/a/b/c');
        eq(pathComponents('/a//b/c/'), ['a', 'b', 'c']);
    }},
];
