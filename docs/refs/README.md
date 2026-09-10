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
