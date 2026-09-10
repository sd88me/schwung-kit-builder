/*
 * Kit Builder — automatic loudness matching (spec §28 / Batch E1).
 *
 * The DSP measures each loaded slot's RMS (fraction of full scale) and reports
 * it via get_param("loudness"). This module turns those readings into a
 * per-pad makeup gain that pulls every pad toward a common level. Pure — no
 * `os` / `host_*`; the caller applies the gains to the kit model and the DSP.
 */

const EPS = 1e-5;

/* Parse the DSP's "loudness" string ("0.1832 0.2010 0.0000 ...") to 16 floats. */
export function parseLoudness(s) {
    const out = new Array(16).fill(0);
    const parts = String(s == null ? '' : s).trim().split(/\s+/);
    for (let i = 0; i < 16; i++) {
        const v = parseFloat(parts[i]);
        out[i] = (isFinite(v) && v > 0) ? v : 0;
    }
    return out;
}

/*
 * matchGains(loudnesses, opts) -> number[16]
 *   loudnesses  array of RMS fractions; 0 (or missing) = slot left at gain 1.0
 *   opts.target   reference level; default = median of the non-zero readings
 *   opts.minGain  default 0.25   opts.maxGain default 2.0 (the kit model cap)
 * Gains are rounded to 1e-3.
 */
export function matchGains(loudnesses, opts) {
    opts = opts || {};
    const lo = (Array.isArray(loudnesses) ? loudnesses : []).slice(0, 16);
    while (lo.length < 16) lo.push(0);

    const nz = lo.filter((x) => Number(x) > EPS).map(Number).sort((a, b) => a - b);
    if (!nz.length) return lo.map(() => 1.0);

    const target = opts.target != null ? Number(opts.target) : nz[Math.floor(nz.length / 2)];
    const minG = opts.minGain != null ? Number(opts.minGain) : 0.25;
    const maxG = opts.maxGain != null ? Number(opts.maxGain) : 2.0;

    return lo.map((x) => {
        const v = Number(x);
        if (!(v > EPS)) return 1.0;
        let g = target / v;
        if (g < minG) g = minG; else if (g > maxG) g = maxG;
        return Math.round(g * 1000) / 1000;
    });
}
