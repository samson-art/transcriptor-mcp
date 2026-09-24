# 003. Auto-discovery asks for at most two ranked tracks, and the canary stands down while real traffic proves the path

- **Status:** Accepted
- **Date:** 2026-09-22 (1.5.4)
- **Sources:** PR #39 (2b837f0), PR #37 operator notes, PR #40 (0303698), CHANGELOG 1.5.4

## Context

Caption requests are a budget measured per outbound address (ADR 002), and before 1.5.4 the biggest spender was this server. Auto-discovery tried up to three official tracks in list order, then up to three automatic tracks. A video listing `ar, de, en` spent two requests before it reached `en`, and one call could spend six. The canary probed every interval even when a real transcript had just come back. At the default 15-minute interval it made about 70% of all caption requests.

## Decision

In `src/validation.ts`:

- `preferredTrackOrder` ranks tracks before any request: an `-orig` track first, then the language the platform reports, then English, then the rest. The same ranking drives the "no subtitles" next-step suggestion in `src/mcp-core.ts`.
- The ladder asks for at most `AUTO_DISCOVERY_ATTEMPTS = 2` tracks. This is a module constant, not an env var. It alternates between the ranked official and automatic lists. When a video lists only one kind, it asks for the two best of that kind.
- `subtitle_tracks_untried_total{platform}` counts the tracks the cap left unasked, only when the ladder came back empty.

In `src/canary.ts`, a tick is skipped when any track from the canary URL's platform came back within the last `CANARY_INTERVAL_MS`.

## Alternatives

- **The old ladder**, 3 official then 3 automatic. Up to six requests per call.
- **Try every listed track** (reconstructed, not recorded).
- **Make the cap configurable** (reconstructed). It stays a constant. PR #39 names it as the dial to turn if `no_subtitles` failures climb together with the untried count.
- **An unconditional canary** on its own schedule, as before 1.5.4.

## Consequences

- A video whose two best tracks both fail answers "no subtitles", and may fall back to Whisper, even if other tracks are listed. The "no subtitles" text states the cap. To see the cost, compare `subtitle_tracks_untried_total` with the "no subtitles" answers. `subtitles_extraction_failures_total{reason="no_subtitles"}` counts them only when `WHISPER_MODE` is not `off`. With Whisper off (the default), use the `not_found` outcome of `get_transcript` in the per-call log line or in `mcp_tool_errors_total`.
- The canary makes no caption requests while real traffic keeps returning tracks. Its own probe also counts as a returned track, so an idle server probes every second interval.

## Don't

- Don't raise the cap or walk every track in answer to one "no subtitles for a video that has some" report. Check the untried metric first.
- Don't drop the ranking "to keep the platform order", or make the canary always probe "to be safe". Both spend caption quota.
- Guarded by the ladder tests in `src/validation.test.ts` (including official-only and auto-only lists) and by `src/canary.test.ts`.
