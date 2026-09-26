# 003. Auto-discovery asks for at most two ranked tracks (superseded by 006), and the canary stands down while real traffic proves the path

- Status: Accepted. The ladder part is superseded by [006](006-original-language-without-lang.md): one track request, or the track list. The canary part stands.
- Date: 2026-09-22 (1.5.4)
- Sources: PR #39 (2b837f0), PR #37 operator notes, PR #40 (0303698), CHANGELOG 1.5.4

## Context

Caption requests are a budget measured per outbound address (ADR 002), and before 1.5.4 the biggest spender was this server. Auto-discovery tried up to three official tracks in list order, then up to three automatic tracks. A video listing `ar, de, en` spent two requests before it reached `en`, and one call spent up to six. The canary probed at every interval, also right after a real transcript came back. At the default 15-minute interval it made about 70% of all caption requests.

## Decision

In `src/validation.ts`:

- *(Superseded by ADR 006. The ranking now only orders the hint and puts `-orig` before its twin.)* `preferredTrackOrder` ranks tracks before any request: an `-orig` track first, then the language the platform reports, then English, then the rest. The same ranking drives the "no subtitles" next-step suggestion in `src/mcp-core.ts`.
- *(Superseded by ADR 006.)* The ladder (the ordered list of track requests) asks for at most `AUTO_DISCOVERY_ATTEMPTS = 2` tracks. This is a module constant, not an env var. It alternates between the ranked official and automatic lists. When a video lists only one kind, it asks for the two best of that kind.
- *(Superseded by ADR 006.)* `subtitle_tracks_untried_total{platform}` counts the tracks that the cap left unasked. It counts them only for a ladder that came back empty.

If any track from the platform of the canary URL came back within the last `CANARY_INTERVAL_MS`, the canary in `src/canary.ts` skips its tick.

## Alternatives

- The old ladder, 3 official then 3 automatic. Up to six requests per call.
- Try every listed track (reconstructed, not recorded).
- *(Superseded by ADR 006.)* Make the cap configurable (reconstructed). It stays a constant. PR #39 names it as the dial to turn in one case: `no_subtitles` failures climb together with the untried count.
- An unconditional canary on its own schedule, as before 1.5.4.

## Consequences

- *(Superseded by ADR 006.)* Other tracks can be listed, but a video whose two best tracks both fail still answers "no subtitles". It can then fall back to Whisper. The "no subtitles" text states the cap. To see the cost, compare `subtitle_tracks_untried_total` with the "no subtitles" answers. `subtitles_extraction_failures_total{reason="no_subtitles"}` counts them only for a `WHISPER_MODE` other than `off`. With Whisper off (the default), use the `not_found` outcome of `get_transcript` in the per-call log line or in `mcp_tool_errors_total`.
- The canary makes no caption requests while real traffic keeps returning tracks. Its own probe also counts as a returned track, so an idle server probes every second interval.

## Do not

- *(Superseded by ADR 006.)* Do not raise the cap or walk every track in answer to one "no subtitles for a video that has some" report. Look at the untried metric first.
- Do not make the canary always probe "to be safe". It spends caption quota. (The rule about the ranking is superseded by ADR 006.)
- Guarded by `src/canary.test.ts`. The ladder tests went with the ladder (ADR 006).
