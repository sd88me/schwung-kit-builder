/*
 * Kit Builder — internal audition drum player (spec §14)
 *
 * A v2 sound-generator plugin loaded by the Schwung shim as `overtake_dsp`.
 * 16 one-shot sample slots (one voice per slot — §14.4 retrigger model),
 * velocity-scaled amplitude, overlapping playback across pads.
 *
 * Threading (per host/plugin_api_v1.h): on_midi / render_block / set_param /
 * get_param run on the SPI audio thread — no file I/O, no malloc/free, no
 * cross-thread locks there. WAV decoding happens on a demoted worker thread
 * started in create_instance; the audio path picks up results via an atomic
 * pointer swap (spec §14.3).
 *
 * Param bridge (all addressed as `overtake_dsp:<key>` from the shim):
 *   set_param "slot_<N>"   = absolute WAV path for pad N+1, or "" to clear
 *   set_param "clear_all"  = clear every slot
 *   get_param "module_id"  -> "kit-builder"
 *   get_param "__ready"    -> "1" once the instance is up
 *   get_param "sounding"   -> decimal 16-bit mask of slots with an active voice
 *   get_param "slot_status"-> 16 chars, one per slot: - empty  o ok  m missing
 *                             x decode-error  . loading
 *   get_param "loudness"   -> 16 space-separated RMS fractions (0..~1), one per
 *                             slot; 0 = empty / not loaded (E1 loudness match)
 *
 * E2 audition step sequencer (16 fixed steps, one 16-bit lane per pad):
 *   set_param "seq_run"    = "1"/"0"  play / stop (stop resets playhead to 0)
 *   set_param "seq_lane_<N>" = decimal step mask (0..65535) for pad N
 *   set_param "seq_clear"  = clear all lanes and stop
 *   set_param "seq_fg"     = "1"  foreground heartbeat; without one for
 *                            ~30 render blocks the sequencer pauses + resets
 *                            (so a parked tool goes silent)
 *   get_param "seq"        -> "<run> <playhead-step>"
 * Tempo follows the host's global BPM (host_api get_bpm()).
 */
#ifndef KIT_PLAYER_H
#define KIT_PLAYER_H

/* No public interface — the plugin is entered only through move_plugin_init_v2
 * (see kit_player.c). This header exists for the repo layout in spec §5. */

#endif /* KIT_PLAYER_H */
