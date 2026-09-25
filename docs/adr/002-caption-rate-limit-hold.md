# 002. After a caption 429, hold that platform's caption path in the process, and only a delivered track resets the strikes

- Status: Accepted
- Date: 2026-09-22 (1.5.2), strike count reworked 2026-09-24 (1.5.8)
- Sources: PR #37 (0cb85a8, 6116a4f), PR #43 (de1dcf5, a560bbd), PR #39, CHANGELOG 1.5.2, 1.5.8

## Context

YouTube's caption limit is keyed to the server's outbound address. Two limits lasted about a day each (CHANGELOG 1.5.2). A change of the address lifted a third one at once (PR #39). This shows what the limit is keyed to. While a limit lasted, every failed call spent more caption requests and the canary kept probing, which fed the limit. Callers told to "wait a few minutes, then retry once" repeated the call 10–12 times.

From 1.5.2 to 1.5.7, a refusal counted as a repeat strike only under one condition: it came within the base wait of the end of the previous wait. With sparse traffic every 429 read as strike 1, so the wait never grew and nothing showed a ban.

## Decision

`src/subtitle-rate-limit.ts`:

- After a 429 on a caption download, the server holds that platform's caption path before anything leaves the server. The check runs after the cache lookup and before the metadata run, so the server still serves cached transcripts.
- The hold covers every caption download path: `get_transcript`, `get_raw_subtitles`, `get_playlist_transcripts`, the transcript resource, REST `/subtitles` and `/subtitles/raw`, and the canary. A hold also skips the Whisper fallback. The hold never covers metadata, the track list, chapters, frames and search.
- Calls in flight that report the same limit count once. Any refusal after the end of a wait is the next strike, however late it comes. The wait doubles 10 → 20 → 40 minutes, capped at 60 (at the default base).
- Only a download that returns a track clears the hold. A run that found nothing proves nothing.
- The state is process-local on purpose. A restart re-checks the platform.
- The gauge `subtitle_rate_limit_strikes{platform}` exposes the count. 2 or more means a ban on a platform the canary probes (YouTube by default). Elsewhere the count does not decay, so two refusals far apart also read as 2.
- `SUBTITLES_RATE_LIMIT_HOLD_MS=0` turns off both the hold and the count. The `rate_limited` text says not to retry.

## Alternatives

- No hold. Let tools and yt-dlp retries run into the limit, as before 1.5.2.
- Count a repeat only within a time window (1.5.2–1.5.7). With sparse traffic, this cannot see a ban.
- Keep hold state in Redis. Rejected: a restart is a good moment to re-check the platform.
- Hold metadata too. Rejected: metadata worked through both day-long limits.
- Clear the hold on any successful run. Rejected: a run with no track possibly never asked the caption endpoint.

## Consequences

- During a ban the server sends one wave of caption requests per hold: normally one yt-dlp run, from a caller or from the canary. Concurrent calls at expiry, a playlist run, or yt-dlp's own retries can send more than one request.
- A refused call costs milliseconds and no platform request.
- Alerts use strikes ≥ 2 instead of firing on each 429. A restart resets the count, so such an alert also resolves on restart.
- The limit can lift sooner, but uncached transcripts on a held platform still fail for up to an hour.

## Do not

- Do not add a time decay to the strike count. The missing decay looks like a bug, but a decay brings back the pre-1.5.8 blindness.
- Do not clear the hold on any successful exit, or count parallel 429s as separate strikes. Do not move the state to Redis, or extend the hold to metadata. Do not soften the text to "try again in a few minutes".
- Guarded by `src/subtitle-rate-limit.test.ts`.
