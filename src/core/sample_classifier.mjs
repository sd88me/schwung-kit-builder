/*
 * Kit Builder — folder-based sample classification (spec §7.2)
 *
 * Pure module: no `os`, no `host_*`. Unit-tested by tests/test_classifier.js.
 *
 * Folder matching (§7.2):
 *  - case-insensitive
 *  - leading/trailing whitespace ignored
 *  - spaces, underscores and hyphens are equivalent  → we strip them all, so
 *    "open hat" / "open_hat" / "open-hat" / "openhat" all normalise the same
 *  - any directory component may match, not only the immediate parent
 *  - deepest (most nested) matching component wins  (Rev. 2, decision 5)
 *  - exactly one primary category per sample; unmatched → "other" (§7.3)
 */

/* lowercase, trim, then remove every space / underscore / hyphen */
export function normalizeToken(s) {
    return String(s == null ? '' : s)
        .toLowerCase()
        .trim()
        .replace(/[\s_-]+/g, '');
}

/*
 * Build a lookup from normalised folder alias -> role name.
 * `roleRules` is the `role_rules` object from the config (§7.1). "other" is
 * excluded from the alias index: it is the fallback, not a folder match, and
 * it carries `exclude_recognised_role_folders` (§7.3).
 */
export function buildAliasIndex(roleRules) {
    const index = new Map();
    for (const role of Object.keys(roleRules || {})) {
        if (role === 'other') continue;
        const aliases = (roleRules[role] && roleRules[role].folder_aliases) || [];
        for (const alias of aliases) {
            const key = normalizeToken(alias);
            if (key && !index.has(key)) index.set(key, role);
        }
    }
    return index;
}

/*
 * Classify one sample from the directory components between the sample root and
 * the file (filename NOT included). Walks shallow -> deep so the deepest match
 * wins. Returns a role name, or 'other' when nothing matches.
 *
 *   classify(['Percussion', 'Closed Hat'], idx) -> 'closed_hat'   (not 'percussion')
 *   classify(['Textures'], idx)                  -> 'other'
 */
export function classify(dirComponents, aliasIndex) {
    let role = 'other';
    for (const comp of dirComponents || []) {
        const hit = aliasIndex.get(normalizeToken(comp));
        if (hit) role = hit; // keep going: a deeper component may override
    }
    return role;
}
