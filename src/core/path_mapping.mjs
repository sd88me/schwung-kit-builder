/*
 * Kit Builder — filesystem-path → Ableton-URI mapping (spec §9)
 *
 * Pure module: no `os`, no `host_*`. Unit-tested by tests/test_path_mapping.js.
 *
 * Rules (§9.3): reject paths outside known roots, preserve filename/directory
 * case, use `/` separators, collapse duplicate slashes, reject `..` traversal,
 * return both a value and an error state, never guess a URI for an unknown root.
 */

/* Known roots. The filesystem prefixes match spec §7.1 defaults; the URI
 * prefixes are the Ableton conventions from §9.1 / §9.2. All three sources
 * (user / core / both) are active — the `core` root is enabled (§9.2, Batch B). */
export const ROOTS = [
    {
        source: 'user',
        fsPrefix: '/data/UserData/UserLibrary/Samples',
        uriPrefix: 'ableton:/user-library/Samples'
    },
    {
        source: 'core',
        fsPrefix: '/data/CoreLibrary/Samples',
        uriPrefix: 'ableton:/packs/abl-core-library/Samples'
    }
];

/* Collapse duplicate slashes, drop any trailing slash (but keep a lone "/"). */
export function normalizePath(p) {
    if (typeof p !== 'string' || p.length === 0) return '';
    const collapsed = p.replace(/\/{2,}/g, '/');
    if (collapsed.length > 1 && collapsed.endsWith('/')) return collapsed.slice(0, -1);
    return collapsed;
}

/* Split a normalized absolute path into its non-empty components. */
export function pathComponents(p) {
    return normalizePath(p).split('/').filter((s) => s.length > 0);
}

/*
 * Convert an absolute filesystem path to an Ableton URI.
 * Returns { uri, source, error }. On failure `uri` is null and `error` is one
 * of: 'not_absolute', 'traversal', 'unknown_root'.
 */
export function toAbletonUri(fsPath, roots = ROOTS) {
    if (typeof fsPath !== 'string' || fsPath[0] !== '/') {
        return { uri: null, source: null, error: 'not_absolute' };
    }
    const norm = normalizePath(fsPath);
    if (norm === '..' || norm.startsWith('../') || norm.endsWith('/..') || norm.includes('/../')) {
        return { uri: null, source: null, error: 'traversal' };
    }

    for (const root of roots) {
        const prefix = normalizePath(root.fsPrefix);
        if (norm === prefix || norm.startsWith(prefix + '/')) {
            const rest = norm.slice(prefix.length); // '' or '/sub/dir/file.wav'
            const uri = normalizePath(root.uriPrefix + rest);
            return { uri, source: root.source, error: null };
        }
    }
    return { uri: null, source: null, error: 'unknown_root' };
}

/* True when `fsPath` sits inside one of the known roots. */
export function isKnownRoot(fsPath, roots = ROOTS) {
    return toAbletonUri(fsPath, roots).error === null;
}
