# 006. An omitted `lang` means the video's original language: one track request, or the list

- **Status:** Accepted
- **Date:** 2026-09-25 (1.5.12)
- **Sources:** issue #54; supersedes the ladder part of [ADR 003](003-caption-request-budget.md)

## Context

Auto-discovery (ADR 003) ranked the official and the automatic lists separately and then alternated between them, official first, for up to two track requests. An English YouTube video that lists official `ar` and automatic `en-orig` got `official ar` first, and that request succeeded, so `get_transcript` answered in Arabic. The official ranking used the language from the metadata JSON (`data.language`), which a cached track list does not carry: a Russian video listing official `ar, ru` answered `ru` on a cold call and `ar` after another tool had cached its list.

The other defaults made the same guess. `type` without `lang` meant `lang: "en"`, so `type: "auto"` on a Russian video returned a machine translation. Playlists defaulted to `auto`/`en`. The widgets picked the alphabetically first official track.

What the platforms give (yt-dlp 2026.03.13):

- **YouTube** marks the automatic track in the audio's own language as `<lang>-orig`, next to a plain `<lang>` entry with the same URL.
- **Other platforms** key tracks their own way: Facebook by locale (`en_US`), Vimeo lists its automatic track as the official `en-x-autogen`, TikTok uses `eng-US`, Bilibili `ai-zh`. They almost never report a language.
- **Chat replays** appear among the subtitles: Twitch lists `rechat` and YouTube live replays list `live_chat`.

Caption requests are a quota per outbound address (ADR 002). A second guess costs a request and can still be a translation.

## Decision

In `src/validation.ts`, a call without `lang` goes to auto-discovery (`downloadWithAutoDiscover`). With a `type`, only tracks of that type are candidates.

- **Candidates.** The listed tracks without chat replays (`CHAT_REPLAYS`).
- **No tracks at all.** Whisper runs if it is enabled, since it hears the original language by itself. Otherwise the answer is "no subtitle tracks".
- **The original language** comes from `originalLanguage`. It is the base of the `-orig` track first, then the language the platform reports. That language is now stored in the `avail` cache entry, so a cached list answers like a fresh one. `und`, `mul`, `zxx` and `mis` count as unknown. `baseLang` reduces `en-US`, `en_US` and `en-x-autogen` to `en`.
- **The track.** `pickOriginalTrack` chooses at most one track:
  - the official track in the original language, else the automatic one (`-orig` first);
  - with the language unknown, only a track without a rival.
- **The list answer.** It comes back with no track request when no track is in the original language, or when the language is unknown and there are several candidates. It also comes back when the one request returns empty: no second track, no Whisper. The answer is a `NotFoundError` with the chat-free lists and one next step: pass `type` and `lang`. `subtitle_tracks_untried_total` counts the candidates it did not request.
- **Explicit requests.** A `lang` without a `type` still means `auto`. `resolveSubtitleArgs` in `src/mcp-core.ts` no longer substitutes `lang: "en"`.
- **Playlists** (`get_playlist_transcripts`). Without a `lang`, yt-dlp gets `.*-orig` in the same single run (`ORIG_AUTO_TRACKS` in `src/youtube.ts`). With `type: official`, or on a platform other than YouTube, the call is refused before any run, and the error asks for `lang`.
- **Widgets.** `pickDefaultTrack` in `ui/shared/subtitleTracks.ts` repeats the rule. Where the server would answer with the list, the widget still shows a track (English first), because a person has the picker.

## Alternatives

- **Keep the two-track ladder and rank by language first.** A failed first track still spends a second request, and with the language unknown the ranking is a guess.
- **Guess English when the language is unknown.** That guess is the bug in #54: a Spanish TikTok that lists a machine-translated `eng-US` gets the translation.
- **Run Whisper whenever no original-language track came back.** It would produce the original language, but it downloads the audio and can take a minute for a video whose tracks the caller could name. The maintainer chose to run Whisper only for videos without tracks.
- **One yt-dlp run with a track pattern and no metadata run.** On YouTube a pattern reaches only `-orig`, never an official track in the original language. On other platforms there is no pattern for "original" at all.
- **Metadata per video for playlists.** It honours official tracks, but adds a metadata run in front of every video.

## Consequences

- A call without `lang` spends at most one caption request, where it used to spend two.
- On platforms that report no language, a video with two or more tracks now costs the caller a second call with `type` and `lang`.
- `type` without `lang` on YouTube now pays the metadata run that auto-discovery always paid.
- `subtitles_extraction_failures_total{reason="no_subtitles"}` counts a failure only when Whisper actually ran. List answers show up in `subtitle_tracks_untried_total` and as `not_found` in the per-call log line.
- Answers cached under the auto-discovery key before this change are served until they expire (`CACHE_TTL_SUBTITLES_SECONDS`).

## Don't

- Don't add a second attempt "to be safe", and don't guess a language that the listing does not name. Both are how a translation comes back as the transcript.
- Don't rank the reported language ahead of `-orig`. `-orig` is part of the track list itself, so every cache entry answers the same, including entries written before the reported language was stored.
- Don't request `live_chat` or `rechat` as subtitles.
- Guarded by `an omitted lang means the original language` in `src/validation.test.ts` and in `src/mcp-core.test.ts`, the playlist pattern test in `src/youtube.test.ts`, and the `pickDefaultTrack` tests in `ui/shared/widgets.test.ts`.
