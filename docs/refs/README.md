# Export format references

## MPC `.xpm` (Batch D3)

Method and format come from a **real** MPC-V 2.1 drum program that Sam
exported (`All_purposeCrunchy_Kit.xpm`, `Application_Version 2.14.0.20`,
Windows). The reference file itself is not committed (~1.3 MB); its
structural chunks live verbatim in `src/exporters/xpm_template.mjs` and the
generator is `src/exporters/mpc_xpm.mjs`.

Approach validated against **github.com/psrpinto/roger** (`program.go` →
`renderProgramXml`): take a real `.xpm` as a template, keep it byte-for-byte,
and change only:

- `<ProgramName>`
- each used pad's **Layer 1** `<SampleName>` (bare name, no extension — the
  MPC loads `<SampleName>.wav` from the `.xpm`'s own folder)
- (`roger` also sets Layer-1 `<SliceEnd>` to the sample frame count; we leave
  it `0` for now — no WAV decode in module JS)

Regenerated facts, matched to the reference by `diff`:

- always **128** `<Instrument>` blocks; pads 17..128 keep an empty
  `<SampleName>` and differ from populated pads only by two inert defaults
  (`WarpTempo` 120 vs 20, Layer-1 `SliceLoopCrossFadeLength` -1 vs 0)
- `<PadNoteMap>`: `Note = (35 + pad) mod 128` (pad 93 wraps to 0)
- `<PadGroupMap>`: all `0`
- CRLF line endings on XML structure; the `<ProgramPads-v2.10>` JSON body is
  LF even in a real export
- `<QLinkAssignments/>` self-closed

`buildXpm()` output is structurally identical to the reference (ignoring the
four fields that legitimately carry kit data: SampleName, SliceEnd,
ProgramName, MuteGroup).

## `.ablpresetbundle` — dropped from scope (2026-09-10)

`.ablpresetbundle` is an *inbound* format (built off-device, uploaded to Move
via Move Manager, or opened in Note). Kit Builder runs on Move and its kits
are already there as the native Move `.ablpreset`, so there's no import path for
it to serve; a kit leaving Move with its samples is Move's native
`.ablbundle` drum-rack save. No exporter, no reference kept. `wav_strip.mjs`
survives — it serves the MPC `.xpm` gather.

## Vendored dropbear client (`src/vendor/dropbear-aarch64/`)

`dbclient` / `scp` / `dropbearkey`, static aarch64 binaries — "Send to Force"
(EXPORT page) pushes a kit over SSH to an Akai Force running MockbaMod. Move
ships `sshd` + `scp` for *inbound* connections only; there's no outbound `ssh`
client anywhere on the device (`/usr/bin/scp` execs `/usr/bin/ssh`, which
doesn't exist — confirmed by running it). host_system_cmd's allowlist
includes a bare `sh ` prefix, so a bundled client can be invoked; it just has
to actually exist.

**musl, not glibc.** A `gcc-aarch64-linux-gnu` (glibc) `-static` build of
`dbclient` segfaults on Move on the very first invocation — no args, no
network, just `SIGSEGV` (exit 139). This is the well-known glibc-static
trap: `getaddrinfo`/`getpwnam`/`getpwuid`/`getspnam` still `dlopen()` NSS
`.so`s at runtime even in a "static" binary (the linker warns about exactly
this), and that path is broken or absent on Move's stripped runtime. A musl
build of the same source has no such dependency — musl resolves NSS at link
time — and it runs cleanly: confirmed on-device, `dropbearkey` generated a
real ed25519 key on the actual hardware.

Rebuild via `scripts/build_dropbear.sh` (fetches dropbear source + a
self-contained musl cross toolchain from musl.cc — no Docker needed, unlike
the DSP build). Not run automatically: unlike `dsp.so`, these binaries don't
change with kit-builder's own code, so they're committed and only rebuilt by
hand when bumping `DROPBEAR_VERSION` in that script. Dropbear is MIT-licensed
(Matt Johnston + contributors) — see `src/vendor/dropbear-aarch64/LICENSE`.
