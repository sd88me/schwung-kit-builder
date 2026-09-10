/*
 * Kit Builder — internal audition drum player (spec §14).
 * See kit_player.h for the design and the threading contract.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>
#include <pthread.h>
#include <unistd.h>
#include <sched.h>

#include "host/plugin_api_v1.h"

/* Host callbacks — captured in move_plugin_init_v2, used read-only from
 * render_block for tempo (E2 sequencer). Single plugin instance, so a
 * file-static is fine. Every field is NULL-guarded at the call site. */
static const host_api_v1_t *g_host = NULL;

#define NSLOTS            16
/* E2 sequencer: how many render blocks without a "seq_fg" heartbeat from the
 * UI before playback pauses + resets to step 1. tick() (~44 Hz) pumps the
 * heartbeat; a park freezes tick(), so ~30 blocks (~87 ms) means backgrounded. */
#define FG_TIMEOUT_BLOCKS 30
/* One-shot drum hits are short; anything longer is trimmed on load so a stray
 * long sample can't hog memory or play past the point of use (spec §25). */
#define MAX_SLOT_SECONDS  5
#define MAX_SLOT_FRAMES   (MAX_SLOT_SECONDS * MOVE_SAMPLE_RATE)
#define MAX_WAV_BYTES     (48 * 1024 * 1024)
#define PATH_MAX_LEN      512

/* Anti-click ramps, position-derived in render_block: a short fade-in on every
 * note-on (also softens a retrigger) and a fade-out over the sample's tail so a
 * chopped one-shot never hard-cuts. */
#define ATTACK_SAMPLES    (MOVE_SAMPLE_RATE / 1000)   /* ~1 ms */
#define RELEASE_SAMPLES   (MOVE_SAMPLE_RATE / 200)     /* ~5 ms */

/* Hardware pad note for kit pad 0..15 — the left 4x4 drum-rack block, matching
 * ui.js KIT_PAD_NOTES. The shim delivers cable-0 note events straight to
 * on_midi with this note number. */
static const int PAD_NOTE[NSLOTS] = {
    68, 69, 70, 71,
    76, 77, 78, 79,
    84, 85, 86, 87,
    92, 93, 94, 95
};
static int slot_for_note(int note) {
    for (int i = 0; i < NSLOTS; i++) if (PAD_NOTE[i] == note) return i;
    return -1;
}

/* ---- decoded sample ----------------------------------------------------- */

typedef struct {
    int16_t *data;      /* interleaved */
    int      frames;
    int      channels;  /* 1 or 2 */
} sample_t;

static void free_sample(sample_t *s) {
    if (s) { free(s->data); free(s); }
}

/* ---- slot + voice ----------------------------------------------------- */

enum { ST_EMPTY = 0, ST_OK = 1, ST_MISSING = 2, ST_DECODE_ERR = 3, ST_LOADING = 4 };

typedef struct {
    /* SPI thread writes pending_path via a seqlock; loader thread reads it. */
    volatile unsigned seq;
    char pending_path[PATH_MAX_LEN];

    /* loader-thread-owned */
    char loaded_path[PATH_MAX_LEN];
    sample_t *retired;          /* previous sample, freed one reload later */

    /* published to the audio thread by an atomic pointer store */
    sample_t *cur;
    volatile int status;
    volatile float loudness;   /* RMS of the decoded PCM, 0..~1 of full scale (E1) */
} slot_t;

typedef struct {
    volatile int active;
    sample_t *s;               /* captured at note-on */
    int   pos;
    float gain;
} voice_t;

typedef struct {
    char     module_dir[256];
    slot_t   slots[NSLOTS];
    voice_t  voices[NSLOTS];
    float    slot_gain[NSLOTS]; /* per-pad makeup gain, 0..2 (1 = 0 dB) */
    pthread_t loader;
    volatile int loader_run;
    volatile int ready;
    volatile int muted;        /* 1 = ignore new note-ons (keyboard is open) */

    /* E2 audition step sequencer. 16 steps (fixed), one 16-bit lane per pad.
     * seq_frac accumulates 16th-note steps at Move's tempo; render thread only. */
    volatile uint16_t seq_lane[NSLOTS];
    volatile int seq_run;      /* 1 = playing (Play toggles it) */
    volatile int seq_step;     /* published playhead, 0..15 */
    double       seq_frac;
    volatile int fg_blocks;    /* render blocks since the last "seq_fg" heartbeat */
} kit_t;

/* ---- audio decode: WAV + AIFF (loader thread only) ------------------- */

static uint32_t rd_u32le(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint16_t rd_u16le(const uint8_t *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}
static uint32_t rd_u32be(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | (uint32_t)p[3];
}
static uint16_t rd_u16be(const uint8_t *p) {
    return (uint16_t)(((uint16_t)p[0] << 8) | (uint16_t)p[1]);
}

/* 80-bit IEEE-754 extended (AIFF sample rate) -> double */
static double rd_f80be(const uint8_t *p) {
    int sign = p[0] >> 7;
    int exp = ((p[0] & 0x7f) << 8) | p[1];
    uint64_t mant = 0;
    for (int i = 0; i < 8; i++) mant = (mant << 8) | p[2 + i];
    if (exp == 0 && mant == 0) return 0.0;
    double v = ldexp((double)mant, exp - 16383 - 63);
    return sign ? -v : v;
}

/* Common description of the source PCM, ready to resample + convert. */
typedef struct {
    const uint8_t *data;   /* first sample byte */
    long   frames;         /* source frames */
    int    channels;
    int    bits;           /* 8 / 16 / 24 / 32 / 64 */
    uint32_t rate;
    int    is_float;       /* 1 = IEEE float PCM */
    int    big_endian;     /* 1 = AIFF byte order */
} src_pcm_t;

/* one source sample (interleaved index `idx`) -> float in int16 range */
static float read_samp(const src_pcm_t *s, long idx) {
    const uint8_t *d = s->data;
    int bits = s->bits;
    if (s->is_float) {
        if (bits == 32) { float f; memcpy(&f, d + idx * 4, 4); return f * 32767.0f; }
        if (bits == 64) { double f; memcpy(&f, d + idx * 8, 8); return (float)(f * 32767.0); }
        return 0.0f;
    }
    if (s->big_endian) {
        if (bits == 8)  { return (float)(int8_t)d[idx] * 256.0f; }        /* AIFF 8-bit is signed */
        if (bits == 16) { return (float)(int16_t)rd_u16be(d + idx * 2); }
        if (bits == 24) {
            const uint8_t *p = d + idx * 3;
            int32_t v = ((int32_t)(int8_t)p[0] << 24) | ((int32_t)p[1] << 16) | ((int32_t)p[2] << 8);
            return v / 65536.0f;
        }
        if (bits == 32) { return (int32_t)rd_u32be(d + idx * 4) / 65536.0f; }
        return 0.0f;
    }
    if (bits == 8)  { return ((int)d[idx] - 128) * 256.0f; }             /* WAV 8-bit is unsigned */
    if (bits == 16) { int16_t v; memcpy(&v, d + idx * 2, 2); return (float)v; }
    if (bits == 24) {
        /* LE 24-bit signed, packed into bits 8..31 for the sign; that is the
         * true sample << 8, and the true sample (+-2^23) needs >> 8 -> /65536. */
        const uint8_t *p = d + idx * 3;
        int32_t v = ((int32_t)p[0] << 8) | ((int32_t)p[1] << 16) | ((int32_t)(int8_t)p[2] << 24);
        return v / 65536.0f;
    }
    if (bits == 32) { int32_t v; memcpy(&v, d + idx * 4, 4); return v / 65536.0f; }
    return 0.0f;
}

static uint8_t *read_file(const char *path, long *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 44 || sz > MAX_WAV_BYTES) { fclose(f); return NULL; }
    uint8_t *b = malloc((size_t)sz);
    if (!b) { fclose(f); return NULL; }
    size_t nr = fread(b, 1, (size_t)sz, f);
    fclose(f);
    if ((long)nr != sz) { free(b); return NULL; }
    *out_len = sz;
    return b;
}

/* Resample `src` to 44.1 kHz interleaved int16, truncated at MAX_SLOT_FRAMES. */
static sample_t *build_sample(const src_pcm_t *src, int *status) {
    if (src->channels < 1 || src->frames <= 0) { *status = ST_DECODE_ERR; return NULL; }
    int outch = src->channels > 2 ? 2 : src->channels;
    double ratio = (double)MOVE_SAMPLE_RATE / (double)src->rate;
    long outFrames = (long)((double)src->frames * ratio);
    if (outFrames > MAX_SLOT_FRAMES) outFrames = MAX_SLOT_FRAMES;
    if (outFrames <= 0) { *status = ST_DECODE_ERR; return NULL; }

    int16_t *pcm = malloc(sizeof(int16_t) * (size_t)outch * (size_t)outFrames);
    if (!pcm) { *status = ST_DECODE_ERR; return NULL; }

    for (long of = 0; of < outFrames; of++) {
        double sp = of / ratio;
        long i0 = (long)sp;
        if (i0 >= src->frames) i0 = src->frames - 1;
        long i1 = i0 + 1; if (i1 >= src->frames) i1 = src->frames - 1;
        float frac = (float)(sp - (double)i0);
        for (int c = 0; c < outch; c++) {
            float a  = read_samp(src, i0 * src->channels + c);
            float bb = read_samp(src, i1 * src->channels + c);
            float v = a + (bb - a) * frac;
            long iv = lrintf(v);
            if (iv > 32767) iv = 32767; else if (iv < -32768) iv = -32768;
            pcm[of * outch + c] = (int16_t)iv;
        }
    }

    sample_t *out = malloc(sizeof(sample_t));
    if (!out) { free(pcm); *status = ST_DECODE_ERR; return NULL; }
    out->data = pcm;
    out->frames = (int)outFrames;
    out->channels = outch;
    *status = ST_OK;
    return out;
}

/* Perceived-loudness proxy for a decoded slot: the RMS of its LOUDEST ~125 ms
 * window, as a fraction of full scale (E1 loudness match). Whole-sample RMS
 * would let a long quiet tail drag a punchy hit's number down (and vice
 * versa); the peak window is what the ear actually judges. One O(frames) pass
 * with a sliding sum-of-squares. Loader thread only. Empty / silent -> 0. */
static float measure_rms(const sample_t *s) {
    if (!s || !s->data || s->frames <= 0) return 0.0f;
    const int ch = s->channels;
    const long total = s->frames;
    long win = MOVE_SAMPLE_RATE / 8;           /* 125 ms */
    if (win > total) win = total;
    if (win < 1) return 0.0f;
    const long nwin = win * ch;

    double acc = 0.0;
    for (long i = 0; i < nwin; i++) { double v = (double)s->data[i]; acc += v * v; }
    double best = acc;

    for (long f = win; f < total; f++) {
        for (int c = 0; c < ch; c++) {
            double a = (double)s->data[f * ch + c];
            double b = (double)s->data[(f - win) * ch + c];
            acc += a * a - b * b;
        }
        if (acc > best) best = acc;
    }
    if (best < 0.0) best = 0.0;                 /* fp drift guard */
    return (float)(sqrt(best / (double)nwin) / 32768.0);
}

static int valid_bits(int bits, int is_float) {
    if (is_float) return bits == 32 || bits == 64;
    return bits == 8 || bits == 16 || bits == 24 || bits == 32;
}

/* RIFF/WAVE */
static int parse_wav(const uint8_t *b, long len, src_pcm_t *src) {
    if (len < 12 || memcmp(b, "RIFF", 4) != 0 || memcmp(b + 8, "WAVE", 4) != 0) return 0;
    int fmt = 0, ch = 0, bits = 0;
    uint32_t rate = 0, datalen = 0;
    const uint8_t *data = NULL;
    long off = 12;
    while (off + 8 <= len) {
        const uint8_t *ck = b + off;
        uint32_t cksz = rd_u32le(ck + 4);
        long body = off + 8;
        if (body + (long)cksz > len) cksz = (uint32_t)(len - body);
        if (memcmp(ck, "fmt ", 4) == 0 && cksz >= 16) {
            fmt  = rd_u16le(b + body);
            ch   = rd_u16le(b + body + 2);
            rate = rd_u32le(b + body + 4);
            bits = rd_u16le(b + body + 14);
            if (fmt == 0xFFFE && cksz >= 26) fmt = rd_u16le(b + body + 24);
        } else if (memcmp(ck, "data", 4) == 0) {
            data = b + body;
            datalen = cksz;
        }
        off = body + cksz + (cksz & 1);
    }
    if (!data || ch < 1 || rate < 4000 || rate > 192000) return 0;
    int is_float = (fmt == 3);
    if (fmt != 1 && !is_float) return 0;
    if (!valid_bits(bits, is_float)) return 0;
    src->data = data;
    src->frames = (long)datalen / ((bits / 8) * ch);
    src->channels = ch;
    src->bits = bits;
    src->rate = rate;
    src->is_float = is_float;
    src->big_endian = 0;
    return src->frames > 0;
}

/* FORM/AIFF (and uncompressed AIFC: NONE / twos / sowt) */
static int parse_aiff(const uint8_t *b, long len, src_pcm_t *src) {
    if (len < 12 || memcmp(b, "FORM", 4) != 0) return 0;
    int aifc = (memcmp(b + 8, "AIFC", 4) == 0);
    if (!aifc && memcmp(b + 8, "AIFF", 4) != 0) return 0;

    int ch = 0, bits = 0;
    long frames = 0;
    uint32_t rate = 0;
    const uint8_t *data = NULL;
    uint32_t ssnd_offset = 0;
    long ssnd_bytes = 0;
    int little = 0;   /* AIFC 'sowt' = little-endian samples */

    long off = 12;
    while (off + 8 <= len) {
        const uint8_t *ck = b + off;
        uint32_t cksz = rd_u32be(ck + 4);
        long body = off + 8;
        if (body + (long)cksz > len) cksz = (uint32_t)(len - body);
        if (memcmp(ck, "COMM", 4) == 0 && cksz >= 18) {
            ch     = (int16_t)rd_u16be(b + body);
            frames = (long)rd_u32be(b + body + 2);
            bits   = (int16_t)rd_u16be(b + body + 6);
            rate   = (uint32_t)rd_f80be(b + body + 8);
            if (aifc && cksz >= 22) {
                const uint8_t *comp = b + body + 18;
                if (memcmp(comp, "sowt", 4) == 0) little = 1;
                else if (memcmp(comp, "NONE", 4) != 0 && memcmp(comp, "twos", 4) != 0 &&
                         memcmp(comp, "in24", 4) != 0 && memcmp(comp, "in32", 4) != 0)
                    return 0;   /* real compression — unsupported */
            }
        } else if (memcmp(ck, "SSND", 4) == 0 && cksz >= 8) {
            ssnd_offset = rd_u32be(b + body);
            data = b + body + 8;
            ssnd_bytes = (long)cksz - 8;
        }
        off = body + cksz + (cksz & 1);
    }
    if (!data || ch < 1 || rate < 4000 || rate > 192000 || frames <= 0) return 0;
    if (!valid_bits(bits, 0)) return 0;
    data += ssnd_offset;
    ssnd_bytes -= (long)ssnd_offset;
    long avail = ssnd_bytes / ((bits / 8) * ch);
    if (avail < frames) frames = avail;
    if (frames <= 0) return 0;
    src->data = data;
    src->frames = frames;
    src->channels = ch;
    src->bits = bits;
    src->rate = rate;
    src->is_float = 0;
    src->big_endian = !little;
    return 1;
}

/* status <- ST_OK / ST_MISSING / ST_DECODE_ERR. Format is sniffed from the
 * magic bytes, so the file extension does not matter. */
static sample_t *load_audio(const char *path, int *status) {
    long len = 0;
    uint8_t *b = read_file(path, &len);
    if (!b) { *status = ST_MISSING; return NULL; }

    src_pcm_t src;
    memset(&src, 0, sizeof(src));
    sample_t *out = NULL;
    if (parse_wav(b, len, &src) || parse_aiff(b, len, &src)) {
        out = build_sample(&src, status);
    } else {
        *status = ST_DECODE_ERR;
    }
    free(b);
    return out;
}

/* ---- loader worker thread ------------------------------------------------ */

static void demote_self(void) {
    struct sched_param sp = { .sched_priority = 0 };
    sched_setscheduler(0, SCHED_OTHER, &sp);
    cpu_set_t set;
    CPU_ZERO(&set);
    CPU_SET(0, &set); CPU_SET(1, &set); CPU_SET(2, &set);   /* keep core 3 for SPI */
    sched_setaffinity(0, sizeof(set), &set);
}

/* Swap in a freshly decoded sample for slot i. Runs on the loader thread. */
static void publish_slot(kit_t *k, int i, sample_t *smp, int status) {
    slot_t *s = &k->slots[i];

    /* Stop this slot's voice before we retire the buffer it may be reading,
     * then wait past a couple of audio blocks so the SPI thread has cycled. */
    __atomic_store_n(&k->voices[i].active, 0, __ATOMIC_RELEASE);
    usleep(6000);

    free_sample(s->retired);                                  /* freed one reload late */
    s->retired = __atomic_load_n(&s->cur, __ATOMIC_RELAXED);
    __atomic_store_n(&s->cur, smp, __ATOMIC_RELEASE);
    s->status = status;
}

static void *loader_main(void *arg) {
    kit_t *k = (kit_t *)arg;
    demote_self();

    while (__atomic_load_n(&k->loader_run, __ATOMIC_ACQUIRE)) {
        for (int i = 0; i < NSLOTS && __atomic_load_n(&k->loader_run, __ATOMIC_ACQUIRE); i++) {
            slot_t *s = &k->slots[i];

            /* seqlock read of pending_path */
            char want[PATH_MAX_LEN];
            unsigned s1, s2;
            int torn = 0;
            do {
                s1 = __atomic_load_n(&s->seq, __ATOMIC_ACQUIRE);
                if (s1 & 1u) { usleep(300); torn = 1; break; }
                memcpy(want, s->pending_path, sizeof(want));
                s2 = __atomic_load_n(&s->seq, __ATOMIC_ACQUIRE);
            } while (s1 != s2);
            if (torn) continue;

            if (strcmp(want, s->loaded_path) == 0) continue;

            if (want[0] == 0) {
                s->loudness = 0.0f;
                publish_slot(k, i, NULL, ST_EMPTY);
            } else {
                int st = ST_DECODE_ERR;
                sample_t *smp = load_audio(want, &st);
                s->loudness = (st == ST_OK) ? measure_rms(smp) : 0.0f;
                publish_slot(k, i, smp, st);
            }
            memcpy(s->loaded_path, want, sizeof(s->loaded_path));
        }
        usleep(3000);
    }
    return NULL;
}

/* ---- plugin v2 entry points (SPI audio thread) ------------------------- */

static void *create_instance(const char *module_dir, const char *json_defaults) {
    (void)json_defaults;
    kit_t *k = calloc(1, sizeof(kit_t));
    if (!k) return NULL;
    if (module_dir) {
        strncpy(k->module_dir, module_dir, sizeof(k->module_dir) - 1);
    }
    for (int i = 0; i < NSLOTS; i++) { k->slots[i].status = ST_EMPTY; k->slot_gain[i] = 1.0f; }
    k->loader_run = 1;
    if (pthread_create(&k->loader, NULL, loader_main, k) != 0) {
        free(k);
        return NULL;
    }
    k->ready = 1;
    return k;
}

static void destroy_instance(void *inst) {
    if (!inst) return;
    kit_t *k = (kit_t *)inst;
    __atomic_store_n(&k->loader_run, 0, __ATOMIC_RELEASE);
    pthread_join(k->loader, NULL);
    for (int i = 0; i < NSLOTS; i++) {
        free_sample(k->slots[i].retired);
        free_sample(k->slots[i].cur);
    }
    free(k);
}

/* Start slot i's voice at `vel` (0..127). Audio-thread safe: atomic loads /
 * stores only, no alloc / lock. Called from on_midi and the sequencer. */
static void trigger_slot(kit_t *k, int i, int vel) {
    if (i < 0 || i >= NSLOTS) return;
    if (__atomic_load_n(&k->muted, __ATOMIC_ACQUIRE)) return;   /* keyboard open */

    sample_t *smp = __atomic_load_n(&k->slots[i].cur, __ATOMIC_ACQUIRE);
    if (!smp || !smp->data || smp->frames <= 0) return;

    voice_t *v = &k->voices[i];
    v->s = smp;
    v->pos = 0;
    v->gain = ((float)vel / 127.0f) * k->slot_gain[i];   /* velocity x per-pad trim */
    __atomic_store_n(&v->active, 1, __ATOMIC_RELEASE);
}

static void on_midi(void *inst, const uint8_t *msg, int len, int source) {
    (void)source;
    if (!inst || len < 3) return;
    kit_t *k = (kit_t *)inst;
    int type = msg[0] & 0xF0;
    if (type != 0x90 && type != 0x80) return;

    int i = slot_for_note(msg[1]);
    if (i < 0) return;

    int vel = msg[2];
    if (type == 0x80 || vel == 0) return;        /* one-shot: ignore note-off */
    trigger_slot(k, i, vel);
}

/* E2 — advance the step clock and fire this block's step(s). Runs at the top
 * of render_block (audio thread). Tempo follows Move's global BPM; playback is
 * gated by the "seq_fg" heartbeat so it only sounds while the tool is up. */
static void seq_tick(kit_t *k, int frames) {
    if (!k) return;
    if (k->fg_blocks < 1000000) k->fg_blocks++;
    int foreground = k->fg_blocks < FG_TIMEOUT_BLOCKS;

    if (!k->seq_run || !foreground || __atomic_load_n(&k->muted, __ATOMIC_ACQUIRE)) {
        if (!foreground) { k->seq_step = 0; k->seq_frac = 0.0; }   /* park -> reset to step 1 */
        return;
    }

    float bpm = (g_host && g_host->get_bpm) ? g_host->get_bpm() : 120.0f;
    if (!(bpm >= 20.0f && bpm <= 400.0f)) bpm = 120.0f;
    /* 16 steps per bar = 16th notes: steps/sec = bpm/60 * 4 */
    double steps_per_frame = (double)bpm / 60.0 * 4.0 / (double)MOVE_SAMPLE_RATE;
    k->seq_frac += steps_per_frame * (double)frames;

    int guard = 0;
    while (k->seq_frac >= 1.0 && guard++ < 64) {
        k->seq_frac -= 1.0;
        int st = (k->seq_step + 1) & 15;
        k->seq_step = st;
        for (int i = 0; i < NSLOTS; i++)
            if (k->seq_lane[i] & (uint16_t)(1u << st)) trigger_slot(k, i, 100);
    }
}

static void render_block(void *inst, int16_t *out, int frames) {
    if (frames > MOVE_FRAMES_PER_BLOCK) frames = MOVE_FRAMES_PER_BLOCK;
    seq_tick((kit_t *)inst, frames);

    /* Sum every voice in float, then clip once per block (a per-voice int16
     * clamp compounds into audible crunch on dense hits). Stack buffer — no
     * allocation on the audio thread. */
    float mixL[MOVE_FRAMES_PER_BLOCK];
    float mixR[MOVE_FRAMES_PER_BLOCK];
    for (int f = 0; f < frames; f++) { mixL[f] = 0.0f; mixR[f] = 0.0f; }

    kit_t *k = (kit_t *)inst;
    if (k) for (int i = 0; i < NSLOTS; i++) {
        voice_t *v = &k->voices[i];
        if (!__atomic_load_n(&v->active, __ATOMIC_ACQUIRE)) continue;

        sample_t *s = v->s;
        if (!s || !s->data) { __atomic_store_n(&v->active, 0, __ATOMIC_RELEASE); continue; }

        int ch = s->channels;
        int pos = v->pos;
        float g = v->gain;
        int f;
        for (f = 0; f < frames && pos < s->frames; f++, pos++) {
            /* position-derived attack + tail-release envelope (anti-click) */
            float env = 1.0f;
            if (pos < ATTACK_SAMPLES) env = (float)pos / (float)ATTACK_SAMPLES;
            int left = s->frames - pos;
            if (left < RELEASE_SAMPLES) {
                float r = (float)left / (float)RELEASE_SAMPLES;
                env *= r;
            }
            float e = g * env;
            if (ch == 1) {
                float m = (float)s->data[pos] * e;
                mixL[f] += m; mixR[f] += m;
            } else {
                mixL[f] += (float)s->data[pos * 2]     * e;
                mixR[f] += (float)s->data[pos * 2 + 1] * e;
            }
        }
        v->pos = pos;
        if (pos >= s->frames) __atomic_store_n(&v->active, 0, __ATOMIC_RELEASE);
    }

    /* one conversion + soft-clip near full scale */
    for (int f = 0; f < frames; f++) {
        float l = mixL[f] * (1.0f / 32768.0f);
        float r = mixR[f] * (1.0f / 32768.0f);
        if (l > 0.95f || l < -0.95f) l = tanhf(l);
        if (r > 0.95f || r < -0.95f) r = tanhf(r);
        long sl = lrintf(l * 32767.0f);
        long sr = lrintf(r * 32767.0f);
        if (sl > 32767) sl = 32767; else if (sl < -32768) sl = -32768;
        if (sr > 32767) sr = 32767; else if (sr < -32768) sr = -32768;
        out[f * 2]     = (int16_t)sl;
        out[f * 2 + 1] = (int16_t)sr;
    }
}

static void set_param(void *inst, const char *key, const char *val) {
    if (!inst || !key) return;
    kit_t *k = (kit_t *)inst;

    if (strncmp(key, "slot_gain_", 10) == 0) {
        int i = atoi(key + 10);
        if (i < 0 || i >= NSLOTS) return;
        float g = val ? (float)atof(val) : 1.0f;
        if (g < 0.0f) g = 0.0f; else if (g > 2.0f) g = 2.0f;
        k->slot_gain[i] = g;
    } else if (strncmp(key, "slot_", 5) == 0) {
        int i = atoi(key + 5);
        if (i < 0 || i >= NSLOTS) return;
        slot_t *s = &k->slots[i];
        __atomic_store_n(&s->seq, s->seq + 1, __ATOMIC_RELEASE);    /* -> odd */
        size_t n = 0;
        if (val) {
            n = strnlen(val, sizeof(s->pending_path) - 1);
            memcpy(s->pending_path, val, n);
        }
        s->pending_path[n] = 0;
        __atomic_store_n(&s->seq, s->seq + 1, __ATOMIC_RELEASE);    /* -> even */
        s->status = (n == 0) ? ST_EMPTY : ST_LOADING;
    } else if (strcmp(key, "clear_all") == 0) {
        for (int i = 0; i < NSLOTS; i++) {
            slot_t *s = &k->slots[i];
            __atomic_store_n(&s->seq, s->seq + 1, __ATOMIC_RELEASE);
            s->pending_path[0] = 0;
            __atomic_store_n(&s->seq, s->seq + 1, __ATOMIC_RELEASE);
            s->status = ST_EMPTY;
            k->slot_gain[i] = 1.0f;
        }
    } else if (strcmp(key, "mute") == 0) {
        __atomic_store_n(&k->muted, (val && val[0] == '1') ? 1 : 0, __ATOMIC_RELEASE);
    } else if (strcmp(key, "seq_fg") == 0) {           /* E2 foreground heartbeat */
        k->fg_blocks = 0;
    } else if (strcmp(key, "seq_run") == 0) {
        int on = (val && val[0] == '1');
        if (on && !k->seq_run) {
            /* fire step 0 on the very first block after Play */
            k->seq_step = 15;
            k->seq_frac = 1.0;
            k->fg_blocks = 0;
        } else if (!on) {
            k->seq_step = 0;
            k->seq_frac = 0.0;
        }
        k->seq_run = on;
    } else if (strncmp(key, "seq_lane_", 9) == 0) {
        int i = atoi(key + 9);
        if (i < 0 || i >= NSLOTS) return;
        long m = val ? atol(val) : 0;
        k->seq_lane[i] = (uint16_t)(m & 0xFFFF);
    } else if (strcmp(key, "seq_clear") == 0) {
        for (int i = 0; i < NSLOTS; i++) k->seq_lane[i] = 0;
        k->seq_run = 0;
        k->seq_step = 0;
        k->seq_frac = 0.0;
    }
}

static int get_param(void *inst, const char *key, char *buf, int buf_len) {
    if (!key || !buf || buf_len <= 0) return -1;
    kit_t *k = (kit_t *)inst;

    if (strcmp(key, "module_id") == 0) return snprintf(buf, buf_len, "kit-builder");
    if (strcmp(key, "__ready") == 0)   return snprintf(buf, buf_len, "%d", (k && k->ready) ? 1 : 0);

    if (strcmp(key, "sounding") == 0) {
        int mask = 0;
        if (k) for (int i = 0; i < NSLOTS; i++)
            if (__atomic_load_n(&k->voices[i].active, __ATOMIC_ACQUIRE)) mask |= (1 << i);
        return snprintf(buf, buf_len, "%d", mask);
    }

    if (strcmp(key, "slot_status") == 0) {
        int n = 0;
        if (k) for (int i = 0; i < NSLOTS && n < buf_len - 1; i++) {
            char c = '-';
            switch (k->slots[i].status) {
                case ST_OK:         c = 'o'; break;
                case ST_MISSING:    c = 'm'; break;
                case ST_DECODE_ERR: c = 'x'; break;
                case ST_LOADING:    c = '.'; break;
                default:            c = '-'; break;
            }
            buf[n++] = c;
        }
        buf[n] = 0;
        return n;
    }

    if (strcmp(key, "loudness") == 0) {
        /* 16 space-separated RMS fractions (E1). 0 = empty / not yet loaded. */
        int n = 0;
        if (k) for (int i = 0; i < NSLOTS; i++) {
            int w = snprintf(buf + n, buf_len - n, "%s%.4f", i ? " " : "", k->slots[i].loudness);
            if (w < 0 || w >= buf_len - n) break;
            n += w;
        }
        return n;
    }

    if (strcmp(key, "seq") == 0) {   /* E2 -> "<run> <playhead-step>" */
        return snprintf(buf, buf_len, "%d %d", k ? k->seq_run : 0, k ? k->seq_step : 0);
    }
    return -1;
}

static int get_error(void *inst, char *buf, int buf_len) {
    (void)inst; (void)buf; (void)buf_len;
    return 0;
}

static plugin_api_v2_t g_api = {
    .api_version     = MOVE_PLUGIN_API_VERSION_2,
    .create_instance = create_instance,
    .destroy_instance = destroy_instance,
    .on_midi         = on_midi,
    .set_param       = set_param,
    .get_param       = get_param,
    .get_error       = get_error,
    .render_block    = render_block,
};

plugin_api_v2_t *move_plugin_init_v2(const host_api_v1_t *host) {
    g_host = host;   /* used read-only for get_bpm() (E2); every field NULL-guarded */
    return &g_api;
}
