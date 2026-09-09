/*
 * Folder-role classification (spec §7.2, §22).
 */
import { assert, eq } from './run.js';
import { normalizeToken, buildAliasIndex, classify } from '../src/core/sample_classifier.mjs';
import { DEFAULT_CONFIG } from '../src/core/sample_index.mjs';

const idx = buildAliasIndex(DEFAULT_CONFIG.role_rules);
const role = (parts) => classify(parts, idx);

export const tests = [
    { name: 'normalizeToken strips case and separators', fn() {
        eq(normalizeToken(' Open-Hat '), 'openhat');
        eq(normalizeToken('OPEN_HIHAT'), 'openhihat');
        eq(normalizeToken('Bass Drum'), 'bassdrum');
    }},

    { name: 'plain category folders', fn() {
        eq(role(['Kick']), 'kick');
        eq(role(['Snare']), 'snare');
        eq(role(['Clap']), 'clap');
        eq(role(['Percussion']), 'percussion');
        eq(role(['FX']), 'fx');
    }},

    { name: 'aliases across case and separators all hit open_hat (§7.2)', fn() {
        eq(role(['Open Hat']), 'open_hat');
        eq(role(['open_hats']), 'open_hat');
        eq(role(['Drums', 'Open-Hat']), 'open_hat');
        eq(role(['OPEN_HIHAT']), 'open_hat');
        eq(role(['oh']), 'open_hat');
    }},

    { name: 'closed hat aliases', fn() {
        eq(role(['Closed Hat']), 'closed_hat');
        eq(role(['closedhihat']), 'closed_hat');
        eq(role(['ch']), 'closed_hat');
    }},

    { name: 'kick aliases bd / bass drum', fn() {
        eq(role(['BD']), 'kick');
        eq(role(['Bass Drum']), 'kick');
    }},

    { name: 'deepest matching component wins (§7.2 decision 5)', fn() {
        eq(role(['Percussion', 'Closed Hat']), 'closed_hat');
        eq(role(['Kicks', 'Layered', 'Snare']), 'snare');
        eq(role(['Open Hat', 'Kick']), 'kick');
    }},

    { name: 'unrecognised folders fall through to other (§7.3)', fn() {
        eq(role(['Textures']), 'other');
        eq(role([]), 'other');
        eq(role(['Weird', 'Nested', 'Thing']), 'other');
    }},

    { name: 'a nested subfolder under a recognised category keeps that category, not other', fn() {
        // §7.3: not "other" merely for being nested under a recognised category
        eq(role(['Kick', 'Vinyl']), 'kick');
    }},
];
