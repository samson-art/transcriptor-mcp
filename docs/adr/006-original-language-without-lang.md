# 006. An omitted `lang` means the video's original language: one track request, or the list

- **Status:** Accepted
- **Date:** 2026-09-25 (1.5.12)
- **Sources:** issue #54, PR #55; supersedes the ladder part of [ADR 003](003-caption-request-budget.md)

## Context

Auto-discovery (ADR 003) ranked the official and the automatic lists separately and then alternated between them, official first, for up to two track requests. An English YouTube video that lists official `ar` and automatic `en-orig` got `official ar` first, and that request succeeded, so `get_transcript` answered in Arabic. The official ranking used the language from the metadata JSON (`data.language`), which a cached track list did not carry: a Russian video listing official `ar, ru` answered `ru` on a cold call and `ar` after another tool had cached its list.

The other defaults made the same guess. `type` without `lang` meant `lang: "en"`, so `type: "auto"` on a Russian video returned a machine translation. Playlists defaulted to `auto`/`en`. The widgets picked the alphabetically first official track.

What the platforms give (yt-dlp 2026.03.13, in the server's metadata run: `--dump-single-json` without `--write-subs`):

- **YouTube** marks the automatic (ASR) track in the audio's own language as `<lang>-orig`, next to a plain `<lang>` entry with the same URL. yt-dlp makes one `-orig` per ASR track. An auto-dubbed video has one per audio track (yt-dlp issue #17659; our 1.5.7 entry saw a 21-audio-track video list every automatic language once per audio track). The top-level `language` comes from the chosen audio format, which yt-dlp takes from the original audio track. A single-audio video without ASR reports no language.
- **Other platforms** key tracks their own way: Facebook by locale (`en_US`), Vimeo lists its automatic track as the official `en-x-autogen`, Dailymotion and VK by language code. They almost never report a language. TikTok, Bilibili and Reddit list their tracks only when subtitles are requested (yt-dlp's `extract_subtitles`), so the metadata run sees none.
- **Chat replays** appear among the subtitles: Twitch lists `rechat` and YouTube live replays list `live_chat`.

Caption requests are a quota per outbound address (ADR 002).

## Decision

In `src/validation.ts`, a call without `lang` goes to auto-discovery (`downloadWithAutoDiscover`). With a `type`, only tracks of that type are candidates.

- **The track list.** `loadAvailableSubtitles` drops chat replays (`CHAT_REPLAYS`) on read, so every reader gets the same list: auto-discovery, `get_available_subtitles`, the REST list and the "no subtitles" hint. It also covers lists cached before this change.
- **No tracks at all.** Whisper runs if it is enabled, since it hears the original language by itself. Its answer goes under the auto-discovery key of every type, so a call with or without a `type` reads it. Without Whisper, YouTube answers "no subtitle tracks". Off YouTube an empty list proves nothing (TikTok, Bilibili and Reddit list tracks only to a request that names one), so the answer asks for `lang`, and a call that gives a `type` does not start Whisper.
- **The original language** comes from `originalLanguage`:
  - a lone `-orig` track names it;
  - several `-orig` tracks (a dubbed video) are settled by the language the platform reports; with nothing to settle them, the language is unknown;
  - without `-orig`, the reported language.

  That language is stored in the `avail` cache entry, so a cached list answers like a fresh one. `und`, `mul`, `zxx` and `mis` count as unknown. `baseLang` reduces `en-US`, `en_US` and `en-x-autogen` to `en`.

- **The track.** `pickOriginalTrack` chooses at most one track:
  - the official track in the original language, else the automatic one (`-orig` first);
  - with the language unknown, only a track without a rival.

  If that track is already cached under its own name, no request is made. A Whisper answer stored under that name does not count: it is what a request by name fell back to, not the track.

- **The list answer.** It comes back with no track request when no track is in the original language, or when the language is unknown and there are several candidates. It also comes back when the one request returns no text: no second track, no Whisper. The text says "got no text", not "empty", because a download that failed for a reason about this video also returns nothing. The answer is a `NotFoundError` with the lists and one next step:
  - pass `type` and `lang`;
  - "do not repeat the same call" when the track was the only one listed. YouTube's `en` and `en-orig` count as one track: they have one URL.

  `subtitle_tracks_untried_total` counts the candidates it did not request.

- **Explicit requests.** A `lang` without a `type` still means `auto`, and the service layer fills it in, so its "no subtitles" answer can say so. `resolveSubtitleArgs` in `src/mcp-core.ts` passes `type` and `lang` on as given. When a named track is missing, the answer suggests omitting `type` and `lang` only where auto-discovery would pick another track, not the same one under its other name. A `lang` that names a chat replay is refused before any run.
- **Playlists** (`get_playlist_transcripts`) need a `lang`. Without one, or with one the server cannot use, the call is refused before any run.
- **The transcript resource** (`transcriptor://transcript/{videoId}`) cannot carry `type` or `lang`. Its list answer names the tracks and points to `get_transcript`.
- **Widgets.** `pickDefaultTrack` in `ui/shared/subtitleTracks.ts` repeats the part of the rule the track list shows: a lone `-orig` and the official track in its language. It never sees the reported language. Where it cannot tell, it still shows a track (English first, and the `-orig` name of a speech track before the plain one), because the `get_video_info` and `search_videos` widgets have a picker.

## Alternatives

- **Keep the two-track ladder and rank by language first.** A failed first track still spends a second request, and with the language unknown the ranking is a guess.
- **Guess English when the language is unknown.** That guess is the bug in #54: a video that lists a machine-translated English track next to its own gets the translation.
- **Run Whisper whenever no original-language track came back.** It would produce the original language, but it downloads the audio and can take a minute for a video whose tracks the caller could name. The maintainer chose to run Whisper only for videos without tracks.
- **One yt-dlp run with a track pattern and no metadata run.** On YouTube a pattern reaches only `-orig`, never an official track in the original language. It also matches every dubbed audio track. On other platforms there is no pattern for "original" at all.
- **`.*-orig` for playlists without `lang`** (the first version of this change). It costs one caption request per dubbed audio track and returns one transcript per track under the same video id.
- **Metadata per video for playlists.** It honours official tracks, but adds a metadata run in front of every video.

## Consequences

- A call without `lang` spends at most one caption request, where it used to spend two.
- The caller has to make a second call with `type` and `lang` in three cases:
  - on platforms that report no language, a video with two or more tracks;
  - on YouTube, a video without automatic captions and with two or more official tracks;
  - off YouTube, a video whose metadata lists no tracks (with Whisper, only when it produced nothing).

  Before this change the server guessed English there.

- `type` without `lang` on YouTube now pays the metadata run that auto-discovery always paid.
- `subtitles_extraction_failures_total{reason="no_subtitles"}` counts a failure only when Whisper actually ran. List answers show as `not_found` in the per-call log line.
- Answers cached under the auto-discovery key before this change are served until they expire (`CACHE_TTL_SUBTITLES_SECONDS`). Track lists cached before it have no reported language until they expire (`CACHE_TTL_METADATA_SECONDS`).

## Don't

- Don't add a second attempt "to be safe", and don't guess a language that the listing does not name. Both are how a translation comes back as the transcript.
- Don't let the reported language outrank a lone `-orig` track. The mark is part of the track list, so every cache entry answers the same. The reported language only settles several `-orig` tracks.
- Don't request `live_chat` or `rechat` as subtitles, and don't send a playlist a track pattern.
- Guarded by `an omitted lang means the original language` in `src/validation.test.ts` and in `src/mcp-core.test.ts`, and by the `pickDefaultTrack` tests in `ui/shared/widgets.test.ts`.
