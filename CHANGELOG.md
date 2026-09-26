# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.10] - 2026-09-26

### Security

- An unplanned REST error no longer sends its own message to the caller. The REST API answered every error with its message, so an error nobody planned for could show an internal detail: while the API image lacked `CHANGELOG.md`, `GET /changelogs` answered `ENOENT: no such file or directory, open '/app/CHANGELOG.md'`. A 5xx that is not one of the server's own errors now answers the text MCP tools already used — `Internal server error (a fault in this server, not in your request)…` — and the real error goes to the log and to Sentry as before. The MCP HTTP transport's own error handler (outside tool calls) does the same. So does an MCP resource read, such as `transcriptor://transcript/{videoId}` or a widget page, on HTTP and stdio: its error carried its own message, for example a cookies path. The REST log line of such an error now carries the request id, which links it to the log lines of its request.

### Fixed

- The REST API answers 400 and 429 where it answered 500. Every error that was not one of the server's own became a 500: a body that failed the schema (`body must have required property 'url'`), a body that was not JSON, and a request over `RATE_LIMIT_MAX` — each reported to Sentry as an error. They now keep Fastify's status and message, labelled `Bad request` or `Too many requests`, and are no longer sent to Sentry: under a burst, one event per rejected request would spend the quota the limit protects. In `http_requests_total`, these requests move from `status_code="500"` to `400` or `429`, so an alert on the REST 5xx rate sees fewer events.

## [1.5.9] - 2026-09-26

### Fixed

- `GET /changelogs` works in the REST API image. From 0.5.9, when the endpoint arrived, to 1.5.8, the image shipped without `CHANGELOG.md`, so every call answered HTTP 500, put the file's absolute path in the response body and sent an error event to Sentry. The image now carries the file. The API smoke test fails if the endpoint does not return it. The MCP image does not serve this route and is unchanged.
- `.env.example` lists five env vars the server already read: `YT_DLP_FRAME_TIMEOUT`, `YT_DLP_JS_RUNTIMES`, `YT_DLP_REMOTE_COMPONENTS`, `YT_DLP_NO_WARNINGS` and `YT_DLP_IGNORE_NO_FORMATS`, with their defaults. Nothing about them changed. Do not set `YT_DLP_NO_WARNINGS=1`: the server reads yt-dlp warnings to classify failures, so a private, removed or bot-checked video can then look like a normal one. A test now fails when the code reads an env var that the file does not name.

## [1.5.8] - 2026-09-24

### Changed

- **Caption tracks are downloaded by yt-dlp only.** Since 1.4.0 a track listed with its own URL was fetched straight from Node — 0.2 s against the 4–7 s of a yt-dlp run. On 2026-09-24 YouTube refused those requests with `HTTP 429` seven times between 12:09 and 19:18 UTC — nine refused direct fetches over the week against none for yt-dlp — while the same track came through yt-dlp, with the server's cookies and its browser impersonation, eight minutes after a refusal. The direct fetch is gone, and `SUBTITLE_FETCH_TIMEOUT_MS` with it. A transcript that is not cached costs the 4–7 s of a yt-dlp run where it cost 0.2 s; the explicit `type`/`lang` path no longer runs yt-dlp for the JSON in front of the track (the id is in a YouTube URL, and for any other platform that run comes after the track), so its total stays at one run for YouTube. `subtitle_requests_total` keeps its `path` label, now always `yt_dlp`.
- **A refusal after the hold counts as the next strike, however long the hold has been over.** The hold counted a repeat only when it came within ten minutes of the previous wait ending, so on a sparse day every 429 read as the first one: the wait never grew past ten minutes, and nothing said that this address was banned. Only a track resets the count now, and the canary asks for one every `CANARY_INTERVAL_MS` while nothing else answers (fifteen minutes by default, an hour on the hosted server).

### Added

- `subtitle_rate_limit_strikes{platform}`: refusals in a row from a platform's caption endpoint with no track in between, 0 once a track arrives. Two or more means the platform refused again after the hold ran out, with no track handed over in between — the address is banned. The alert to build on it is `max by (platform) (subtitle_rate_limit_strikes{platform="youtube"}) >= 2`, for the platform the canary keeps asking; it resolves when a track comes back, and also on a restart, because the count lives in the process — if the ban holds, it fires again after the next hold. `SUBTITLES_RATE_LIMIT_HOLD_MS=0` turns the count off with the hold.

## [1.5.7] - 2026-09-24

### Fixed

- **A frame that could not be taken could hold its processes for 8 to 22 minutes.** Each stage of `get_video_frame` — the stream lookup, up to two direct reads, the section download, the frame from the clip — got the whole timeout for itself, and an ffmpeg stopped by that timeout did not stop: it acts on `SIGTERM` between packets, and one blocked in a network read gets there only when the read returns. On 2026-09-24 eight failed calls lasted 470–1327 s each; with four quicker failures, failed frames took 7,500 of the 10,690 seconds that all tools worked on this version. The client repeated each call every 30 s with the same arguments, so four ffmpeg processes read the same stream at once and the process cap was reached. A call now has one budget for all of its stages. ffmpeg is stopped with `SIGKILL` and gives up on a read that stalls for 15 s — the ffmpeg that yt-dlp starts for the section download too, since it outlives a yt-dlp stopped by the timeout. A call repeated with the same arguments while the first one runs waits for that run instead of starting another.
- **One interrupted yt-dlp run could leave every later run without cookies.** yt-dlp rewrites the cookies file it is given when it exits, and empties it first. A writable file was handed over as it was, so a run killed during that write left the file empty, and every run after it refused the file as not a Netscape cookies file — on this server from 09:54 UTC on 2026-09-24, hidden for a while by the cache. Every run now gets its own copy, whether the original is writable or not, readable only by the server's user.
- **A video dubbed into many languages could not be read.** yt-dlp lists every automatic caption language once per audio track: one 17-minute video with 21 audio tracks gave 11.7 MB of JSON, more than the 10 MB the server accepted from yt-dlp, so the run was killed — and that kill is the one that emptied the cookies file above. The limit is now 50 MB, and JSON over 10 MB is logged with its length.
- **`get_playlist_transcripts` with `maxItems` answered with no transcripts.** When yt-dlp stops at `--max-downloads` it exits with 101, and the handler for that exit read the downloaded files only after the temporary directory holding them had been removed. It now reads them first.

### Changed

- `YT_DLP_FRAME_TIMEOUT` (default: `YT_DLP_TIMEOUT`) now limits a whole `get_video_frame` call, including the time its processes wait for a free slot, instead of each process the call starts. A stage that would start after the limit does not start, and the call answers with the `timeout` text. `0` still means no limit.
- The example compose file mounts `cookies.txt` read-only: the server never writes the file it is given.

## [1.5.6] - 2026-09-23

### Fixed

- **The first rate limit after a restart was invisible to anything watching `subtitle_requests_total`.** A Prometheus counter series that first appears already holding the value it was incremented to gives `increase()` no earlier sample to compare against, so the step it should produce reads as a flat line. Measured on this server: a caption request was refused with `HTTP 429` at 15:00 UTC on 2026-09-23, the series `{outcome="rate_limited"}` came into existence at 1, and a rule watching for an increase over the last fifteen minutes stayed silent — at exactly the moment such a rule exists for, since a restart also clears the in-process hold that keeps the server from feeding the limit. Every platform now gets all six series (two paths by three outcomes) at zero before its first request leaves the server, so a refusal is a step from a value that was already being scraped. Counting is unchanged; only the zeroes are new.

## [1.5.5] - 2026-09-23

### Changed

- **Every error a tool returns now names one next step, and no tool overwrites the sentence below it any more.** Four tools replaced whatever the layer beneath them had said with a fixed line of their own — "Failed to fetch video info.", "Failed to capture a frame for this video." — so a caller that had been told *why* never saw it. In the week of 2026-09-17, 50 failed calls came from 39 addresses with up to six repeats of one address: the texts said what failed and nothing about whether repeating would help. The overrides are gone, the reason from below reaches the caller, and where a video does have tracks the answer now ends with them, ranked (`-orig` first, then the language just asked for, then English) and cut at fifteen per list with a pointer to the full list.
- **"No subtitles" says what was asked for, what speech-to-text did, what the track list looks like, and exactly one thing to do next.** The old sentence claimed Whisper had been tried when this server has it off, pointed at `GET /subtitles/available` (a route that is POST, and means nothing to an MCP caller), and told a caller who had passed neither `type` nor `lang` to omit them. It also said auto-discovery tries three official and three automatic tracks, which stopped being true in 1.5.4. Each of those is now a separate fact with its own branch — including the difference between a track list that is empty and one that could not be read, which used to be the same sentence.
- **The dead ends that could not name a reason answer with one text instead of three**, and the same is true of the five tools that rejected a URL: they each said "Invalid video URL." without saying which platforms are supported or that a link without `https://` is refused even on a supported one. The language code text now describes the rule the server actually enforces — letters, digits, hyphens and underscores, up to 32 characters — rather than a narrower one it invented; a caller following the old wording would have rejected the very track names this server hands out (`en_US`, `en-nP7-2PuUl7o`). The cursor error says how long the text it paginates is, the search failure names the arguments worth dropping, and an empty playlist reports the `type` and `lang` the server actually used rather than the ones it was passed.
- **A frame that could not be captured says at which timestamp.** At any timestamp past zero it offers one earlier retry; at `00:00:00.000` it does not, because "retry with an earlier timestamp" there is byte for byte the call that just failed.
- `get_video_info` no longer answers 404 when its own result is malformed. That shape means a fault in this server, not a missing video, so it is now reported as one — masked text to the caller, event to Sentry.
- The `geo_blocked` and `age_restricted` texts no longer promise that a video's title and description stay readable. That is true on YouTube and false on TikTok, where the same block hides the page, and the promise sent callers to another tool for nothing.

### Fixed

- **Every Whisper attempt left a ten-minute timer running.** The per-request deadline raced the job with `setTimeout(…, WHISPER_TIMEOUT)` and never cleared it, so the loser of the race held its callback — and the event loop — for the full timeout after the job had already answered. Found by a new test that hung the suite for ten minutes at exit.

## [1.5.4] - 2026-09-23

### Changed

- **Auto-discovery asks for the track somebody wanted, and asks at most twice.** It used to walk up to three official languages and then three automatic ones, in alphabetical order, so a video listing `ar, de, en` spent two requests before reaching the one the caller would use, and a single call could spend six requests against a caption budget a day-long 429 is measured in. Tracks are now ranked before anything is asked for — the audio's own language first (YouTube's `-orig` track, or the language the platform reports), then English, then the rest — and the ladder stops after two tracks: it alternates between the ranked official and automatic lists, so a video that lists both gets its best of each, and a video that lists one kind gets the two best of that kind. Most videos are answered by the first request rather than the third. `subtitle_tracks_untried_total` counts every listed track the cap left unasked when the ladder came back empty: that is the upper bound on transcripts this costs, and the number to watch if callers start hearing "no subtitles" for videos that have some.
- **The canary does not probe when a real transcript just came back from the same platform.** The probe exists to prove the caption path still works, and it spent a request every interval whether or not the path had just proved itself. A successful transcript is the same proof, already paid for. The probe now runs only when nothing has answered for a whole interval — which is also the only time its answer is news. The gauge and the alert are unchanged: an observed success sets `transcriptor_canary_ok` exactly as a probe would, so a platform that stops answering still shows up within one interval. On the hosted server this drops the probe from 24 caption requests a day to none during any hour with traffic.

## [1.5.3] - 2026-09-22

### Added

- **`subtitle_requests_total`: a count of every request this server makes to a platform's caption endpoint, by path and outcome.** Three times in five days YouTube answered `HTTP 429` to that endpoint for hours, and 1.5.2 stopped the server from feeding the limit once it starts. Neither release answers the question that decides how to avoid the next one: how many requests fit before the limit, and whether the track's own address and a yt-dlp run are counted against the same budget. Logs cannot answer it — they die with the container at every deploy — so this is a counter, labelled `platform`, `path` (`direct` or `yt_dlp`) and `outcome` (`ok`, `rate_limited`, `error`). At the minute a limit starts, the requests in the preceding hour, six hours and day are then readable per path. Only requests that actually left the server are counted: a call refused by the hold, and a track the platform never listed, are not.

## [1.5.2] - 2026-09-22

### Fixed

- **A day-long YouTube rate limit cost 106 failed calls, and the server kept feeding it.** Twice in four days YouTube answered `HTTP 429` to every caption request from the hosted server for a full 24 hours (18-09 02:36 → 19-09 02:36 and 20-09 17:29 → 21-09 17:17 UTC). Each failed call spent two requests on the platform that was refusing it — the track's own address first, then yt-dlp — and the canary kept probing on its own schedule; together that is several hundred requests into the quota that holds the limit in place, and the caller waited about 5 seconds to be told to "wait a few minutes". A platform that answers 429 to a subtitle download is now held back: the next subtitle request for that platform is refused before anything leaves the server, including the metadata run that used to precede it. Cached transcripts are still served, and so is everything that is not a subtitle download — metadata worked through both days, and `get_video_info` must not break with it. Every call that reports the same limit counts once, an attempt refused again after a wait doubles it (10, 20, 40 minutes, up to an hour), and a download that brings back a track clears it; a run that found no track proves nothing, because it may never have asked. `get_playlist_transcripts` is held back too — one playlist run asks for as many tracks as it has items. The state is process-local, so a restart re-checks the platform, and `SUBTITLES_RATE_LIMIT_HOLD_MS` sets the first wait (`0` turns the hold off).
- **The direct track fetch introduced in 1.4.0 asked as a bare Node runtime.** yt-dlp asks the same caption endpoint as a browser; the request that replaced it sent undici's default headers, so one server spoke to one endpoint as two different clients. It now sends the user agent, `Accept` and `Accept-Language` that yt-dlp sends. This is not a disguise: undici adds a `Sec-Fetch-Mode` of its own that yt-dlp never sends, and the TLS fingerprint stays Node's. Both 429 days began after 1.4.0, when this was the only change on that endpoint.
- **`get_playlist_transcripts` failed every call that used `maxItems`.** Reaching `--max-downloads` is how a bounded run ends: yt-dlp cancels the queue on purpose and exits 101. It reports that on stdout, which `--quiet` swallows, so the server saw an exit code it could not classify and answered "could not determine why" — the tool's only two calls in the week of 2026-09-22 were both this. A cancelled queue now ends the run normally and returns the items already written. A queue that was cancelled with nothing written and a classified platform failure in its output is still reported as that failure: a platform refusing every item ends the same way as a finished bounded run.

### Changed

- The `rate_limited` message no longer says "wait a few minutes, then retry once". These limits last hours, and the sentence invited exactly the repeats that were measured (two addresses asked 10 and 12 times in a quarter of an hour). It now says most requests to the platform keep failing while the limit lasts, that it can last hours, and not to retry this request. A call the server refuses on its own behalf, while it holds the platform back, says exactly the same thing: the caller's next step does not depend on which of the two it was.
- The one log line per tool call carries `vid` next to `addr`: the hashed canonical video id beside the hashed address as it arrived. `youtu.be/X` and `watch?v=X` hash apart in `addr`, so until now there was no way to count how many spellings of one video the cache is asked for — the number that decides whether canonicalizing URLs is worth a release. It covers the watch, short-link and embed spellings; `/shorts/` and `/live/` links still count as a video of their own.

## [1.5.1] - 2026-09-19

### Fixed

- **Thumbnails did not load in ChatGPT, and the widgets ran there with no content security policy at all.** ChatGPT reads a widget's policy only from its own `openai/widgetCSP` key, spelled with `connect_domains` and `resource_domains`. A resource that carries only the standard `ui.csp`, as ours did, gets no policy there, and ChatGPT's developer mode marks the widget "CSP off". An Instagram reel's widget showed the ▶ placeholder instead of the thumbnail, while Claude, which reads `ui.csp`, shows it. Every widget resource now declares the same list under both keys, from one constant, so the two cannot drift. `connect_domains` is empty: the widgets fetch nothing themselves and reach the server through the host. `redirect_domains` is left out on purpose, because ChatGPT appends `?redirectUrl=` to links on the domains it lists. The same finding, measured in developer mode on 2026-09-17: [NimbleBrainInc/synapse#100](https://github.com/NimbleBrainInc/synapse/pull/100).
- **The two track-name fixes listed under 1.5.0 shipped in 1.5.0.** Their entries had been left under Unreleased.

## [1.5.0] - 2026-09-19

### Added

- **`url` in the result of `get_transcript` and `get_video_frame`:** the video page as the server resolved it (a bare YouTube id comes back as its watch URL). An optional field; nothing else in either result changes. The widgets read the page from here, because some hosts — Claude Code among them — never hand a widget the arguments of the call that opened it.

### Fixed

- **The widgets took every video for a YouTube video.** For an Instagram reel the transcript widget showed YouTube's grey "no thumbnail" image, "Untitled" and "Unknown channel", and asked the server about `youtube.com/watch?v=<the reel's shortcode>`: two wasted yt-dlp runs per render, and "Load subtitles" would have made a third. Instagram shortcodes are 11 characters long, like YouTube ids, and `i.ytimg.com` answers a foreign id with a placeholder image rather than an error, so nothing looked wrong on the YouTube side. The widgets now take the page from the tool result and never turn an id into a YouTube link or thumbnail unless the server said the video is from YouTube; with no page at all they show a plain card with no Open button and make no calls. A cue opens the video at its time only where the platform has such a link (YouTube `?t=`, Vimeo `#t=`), and the page itself elsewhere. The author line is left out when there is none instead of reading "Unknown channel", a missing length no longer shows a lone "—", and the frame widget's button reads "Open".
- **Thumbnails from the other ten platforms were blocked** by the widgets' content security policy, which allowed `ytimg.com` only. The four widget resources now share one list of the CDNs yt-dlp's thumbnails come from, surveyed on the hosted server with one public video per platform (two VK videos came from two CDNs, VK's own and OK's; TikTok's other two regional CDN families are listed without having been seen); every one loads without cookies or a Referer. The widgets now send no Referer either: Bilibili's CDN answers a foreign one with 403, and ChatGPT's widget frames send one. Bilibili sends `http://` thumbnails, which the widgets upgrade to `https://`. A thumbnail that fails to load — platform thumbnails are signed and expire, in days on Instagram and hours on TikTok — falls back to the placeholder.
- **"Load subtitles" fetched the subtitles `get_transcript` had just fetched, and for a video without tracks ran Whisper again.** Three keys disagreed. The subtitle cache was keyed by whether a format was named, not by the format the text is in: `get_transcript` stored under `default`, the widget asked for `srt`, the server default. Auto-discovery stored the track it found only under its own key, while the widget asks for that track by name. And the widget called with yt-dlp's canonical page URL, while the server had cached everything under the link the model sent (`youtu.be/…?si=`, `/shorts/…`, a share token). Now the key names the resolved format, auto-discovery also stores its track under the key a request by name reads, and the widget calls with the URL `get_transcript` answered for. A Whisper transcript the model asked for with a language, on a video that lists no tracks, is asked for again by that language. All of this holds with the default `srt` format: if the model names another format for `get_transcript`, or `YT_DLP_SUB_FORMAT` sets one, the transcript is stored under that format while the widget asks for `srt` (its parser reads SRT and VTT only), and "Load subtitles" fetches again — for a video without tracks, through Whisper. Entries stored under `default` before this release are no longer read: with Redis caching, each such video requested again within the subtitle TTL is fetched once more, and one without tracks is transcribed by Whisper again.
- **Two review fixes to 1.4.1 that missed its merge.** The `ffprobe` length probe no longer waits in the process queue: a full queue refused it, and a 13-second video was answered "too long, do not repeat the call" instead of "server busy"; it reads a local file and never touches the platform, which is all the cap is for. The length is compared in whole seconds, as yt-dlp's own filter does, so an audio track running a fraction past the cap is not over it. An `ffprobe` that fails is logged. README names `ffprobe` as a requirement of `WHISPER_MAX_DURATION_SECONDS`.
- **A listed track whose name is not a short language code could not be asked for.** `get_available_subtitles` lists tracks under yt-dlp's keys, and some keys are not plain language codes: Facebook keys captions by locale (`en_US`), YouTube keys a named manual track by its vssId (`en-nP7-2PuUl7o`), and Vimeo keys its auto captions as `en-x-autogen`. The `lang` check allowed only letters, digits and `-`, up to 10 characters. So `get_transcript` and `get_raw_subtitles` answered "Invalid language code" for such a track. The transcript widget picks a listed track and asks for it by name, so it showed the same error. The check now also allows `_`, up to 32 characters. The MCP tools, the REST API and the second cache entry that auto-discovery writes for the widget all use this one rule. It still rejects anything yt-dlp reads as more than one literal track in `--sub-langs`: commas, dots and other regex characters, spaces, a leading `-` (yt-dlp reads it as "exclude") and `all`. The old check accepted a leading `-` and `all`, and `all` asked yt-dlp for every track of the video.
- **A `lang` such as `toString` failed with an internal error** instead of "no subtitles": the direct track fetch looked the name up on a plain object and found `Object.prototype.toString`. It now reads only the tracks the video lists.

### Changed

- **Jest also runs `ui/shared/*.test.ts`,** the widgets' pure helpers: the first automated check on the widgets, which until now only `vite build` touched.
- **The per-call log line undercounts widget calls in some hosts.** The `transcriptor/source` mark added in 1.3.3 travels in the call's `_meta`, and hosts that strip it (Claude Code) make a widget's calls read as `source=model`; calls from other hosts still arrive marked. Nothing changes in code; read `source` as a lower bound.
- **The video-info widget still calls the subtitle tools with yt-dlp's canonical page URL,** because `get_video_info` returns no resolved one. For a YouTube link in another form (`youtu.be`, `/shorts/`, `?si=`), its track list costs one more metadata run per hour, and its "Load subtitles" does not find what `get_transcript` cached for that link: one more download, or for a video without tracks one more Whisper run. Other platforms mostly get back the link they were given.
- **The frame widget's capture controls now show in hosts that never pass it the call's arguments** (Claude Code), taking the page, format and width from the result; the model's own options win where they arrive.

## [1.4.1] - 2026-09-18

### Fixed

- **Whisper ran for no Instagram reel.** With `WHISPER_MAX_DURATION_SECONDS` set, the audio download told yt-dlp `duration <= N`, and yt-dlp treats a video whose length it does not know as failing that test. Instagram never reports a duration, so every reel without captions was skipped before any audio was fetched and answered "no subtitles" (seen on the hosted server: two reels turned away by a 120-second cap, one of them 12.7 seconds long). The filter is now `!is_live & duration <=? N`: a live stream and a video the platform reports as longer are still skipped up front, a video of unreported length is downloaded and then measured with `ffprobe`, and one that turns out longer than the cap is deleted and answered as before. A length ffprobe cannot read counts as over the cap, so the ceiling stays a ceiling. Two review fixes to this change missed the 1.4.1 merge and shipped in 1.5.0.

## [1.4.0] - 2026-09-17

### Changed

- **A listed subtitle track is fetched by its own URL instead of a second yt-dlp run:** the track list already carries the track's address, and downloading it directly takes about 0.2 s where yt-dlp took 4–7 s (measured on the production host). The yt-dlp path stays as the fallback and runs whenever the track is not listed with its own address (YouTube lists some auto tracks only as an HLS manifest), the answer is not the subtitle format that was asked for, or the request fails.
- **One yt-dlp run answers video info, the track list and chapters:** whichever of the three is asked for first runs yt-dlp once, fills all three cache entries and hands the JSON to the transcript path for the track address. Calls for the same video that arrive together share that one run instead of each starting their own. The canary keeps its own single probe: it skips this run, writes nothing to the cache and still exercises the yt-dlp caption download.
- **A transcript request with an explicit `type`/`lang` reads that JSON before downloading**, so when the track has no address of its own the call costs one metadata run more than it did in 1.3.3. In exchange the video's info, track list and chapters are already cached for the calls that usually follow a transcript. `SUBTITLE_FETCH_TIMEOUT_MS` (default 15000) bounds the direct request; `YT_DLP_PROXY`, when set, turns the direct path off, because a plain fetch would go around the proxy.

## [1.3.3] - 2026-09-17

### Added

- **One `MCP tool call` log line per tool call:** info on success, warn on failure, with `tool`, `outcome`, `reason`, `ms`, `platform`, `host`, `explicit` (whether `type` or `lang` was passed), `addr` (the first 12 hex characters of the SHA-256 of the URL the tool was called with, normalized when it is valid; the URL itself is not logged) and `source` (`widget` when the call came from one of the server's widgets, which now mark their calls with `_meta["transcriptor/source"]`, otherwise `model`). It shows failures by platform and how often the same address is asked again.

### Fixed

- **A private, removed or bot-checked YouTube video was answered as a success:** yt-dlp runs with `--ignore-no-formats-error`, which turns the platform's refusal into a warning and exit code `0`, and it still prints a stub (`youtube video #<id>`, no formats). `get_video_info` served and cached that stub, `get_available_subtitles` cached empty lists, and `get_transcript` said the video had no subtitles in the requested language. A stub with no formats whose warning names a reason now fails with that reason. Region- and age-restricted videos still return their metadata — that is what the flag is for.
- **Failures got the wrong reason, or none:** TikTok's `Unexpected response from webpage request` and a missing impersonation target are now `extractor`, `Video is unavailable` is `unavailable`, TikTok's `Your IP address is blocked from accessing this post` is `geo_blocked`, and YouTube's session throttle (`This content isn't available, try again later`) is `rate_limited` instead of reading as a deleted video. Reading a video's metadata or its stream for a frame now fails with the class yt-dlp reported (`private`, `unavailable`, `geo_blocked`, `age_restricted`) instead of a generic "not found", and an explicit `type`/`lang` request for a private video answers that the video is private, not that it has no subtitles in that language.
- **`get_video_chapters` answered a video without chapters with an error:** it now returns an empty list.
- **An explicit subtitles request ran yt-dlp a second time just for the video id:** for a YouTube URL the id is now taken from the URL.

### Changed

- **Failure texts tell the caller whether to retry:** each yt-dlp failure class says what happened, whose side it is on and one next step (do not retry; retry once; wait a few minutes, then retry once). `bot_check` and `extractor` no longer say "try again later"; `rate_limited` and `timeout` still allow one retry. An unexpected error says it is a server fault and allows one retry, instead of "Tool failed. Please try again.". The REST API returns the same texts.
- **Metrics:** `mcp_tool_calls_total` counts every call when it starts, failed ones included (it used to count successes only). `mcp_request_duration_seconds` has a new `outcome` label (`ok` or `error`), and `cache_hits_total` / `cache_misses_total` a new `kind` label (`sub`, `avail`, `info`, `chapters`). Queries that use these series without aggregation now get several series: quantiles need `sum by (le, endpoint) (rate(mcp_request_duration_seconds_bucket[...]))`, `_count` and `_sum` need `sum by (endpoint) (...)`, and the cache counters `sum(...)`. `mcp_tool_errors_total{reason}` for info, availability, chapters and frames now carries the yt-dlp class where it used to say `not_found`, and `subtitles_extraction_failures_total{reason}` can also carry one (`private`, `unavailable`, `geo_blocked`, `age_restricted`).
- **REST:** a private, removed, region-blocked or age-restricted video answers `404` with `"error": "Not found"` and the new text, where it used to be `"Video not found"`; these 404s are still counted in `http_404_expected_total`, which now counts every planned 404. `POST /video/chapters` answers a video without chapters with `200` and an empty list instead of `404`.
- **Health probes, metrics scrapes and the `405` for `GET /mcp` are logged at warn level only**, so they no longer write two info lines per request.

## [1.3.2] - 2026-09-17

### Added

- **`WHISPER_MAX_DURATION_SECONDS`:** when set, the Whisper fallback only downloads the audio of videos up to that length; a longer video, or one whose length is unknown (a live stream), is skipped before any audio is fetched, and the call answers that there are no subtitles. Unset or `0` keeps the old behavior, no limit. It keeps a server that enables Whisper for short clips from spending minutes of CPU on an hour-long video without captions.

### Fixed

- **TikTok videos, and some Dailymotion videos, could not be opened at all:** the image installed yt-dlp without `curl_cffi`, so no browser impersonation target was available. TikTok's extractor needs one and failed every request with `Unexpected response from webpage request`, which callers saw as "not found". The image now installs `yt-dlp[default,curl-cffi]`, and `get_video_info` and `get_video_frame` work for TikTok. Most TikTok videos expose no subtitle track, so without a Whisper fallback `get_transcript` still answers that there are no subtitles for them.
- **The transcript and video-info widgets asked about the wrong video on platforms other than YouTube:** they called `get_video_info`, `get_available_subtitles` and `get_raw_subtitles` with the bare video id, which the server reads as a YouTube id. They now pass the page URL: the `url` the tool was called with, or the video's `webpageUrl`. The transcript widget builds its fallback YouTube link and thumbnail only for YouTube.

### Changed

- **The "no subtitles" message no longer gives callers an operator setting:** with Whisper on, it said the fallback failed and to raise `WHISPER_TIMEOUT`. It now says that speech-to-text produced nothing and, with `WHISPER_MAX_DURATION_SECONDS` set, names the limit and asks not to repeat the call; without the limit, it says a timed-out transcription may still finish in the background and one retry a few minutes later may succeed.
- **yt-dlp's `default` extra is installed as well:** `requests`, `brotli`, `websockets`, `mutagen`, `pycryptodomex`, `certifi` and the bundled `yt-dlp-ejs` challenge solver. yt-dlp now uses its `requests` transport instead of `urllib`.
- **The publish workflow checks impersonation before pushing:** a step runs `yt-dlp --list-impersonate-targets` in the freshly built image and stops the release unless a Chrome target backed by `curl_cffi` is available. The check does not use the network.

## [1.3.1] - 2026-09-17

### Fixed

- **The canary asked for an auto-generated track of a video that only has official captions:** the default fixture (`jNQXAC9IVRw`) carries official `en` captions and no auto track the server can serve, so every probe failed with `not_found`, `transcriptor_canary_ok` read `0` from the first boot of 1.3.0 on, and the second probe raised the "transcript path failing" alert on a healthy server. The probe now requests `type=official`. A custom `CANARY_URL` must point at a video with an official English track.

## [1.3.0] - 2026-09-16

### Added

- **A cap on yt-dlp and ffmpeg child processes:** every yt-dlp and ffmpeg run passes through one wrapper in `src/youtube.ts`, so a single cap covers the REST API and both MCP transports. `YT_DLP_MAX_CONCURRENCY` (default `4`) is how many may run at once, `YT_DLP_MAX_QUEUE` (default `8`) how many calls may wait for a slot; a call beyond both is refused at once — `503` with `{"error":"Server busy","message":"The server is busy, try again in a moment."}` from the REST API, an `isError` tool result with the same sentence from MCP — and counted as `mcp_tool_errors_total{reason="busy"}`. Time spent waiting does not count against the call's own timeout. `YT_DLP_MAX_CONCURRENCY=0` restores the old unlimited behavior. Two gauges for tuning: `yt_dlp_processes_active` and `yt_dlp_queue_length`. A measured call peaks at about 40 MiB, so the cap protects the platform's patience and the latency of the calls already running, not memory.
- **A transcript canary on the MCP HTTP server:** once at boot and then every `CANARY_INTERVAL_MS` milliseconds (default `900000`, fifteen minutes) the server fetches the captions of `CANARY_URL` (default `https://www.youtube.com/watch?v=jNQXAC9IVRw`, a 19-second public video) through the same code path and limiter the tools use, bypassing the response cache so a hit proves yt-dlp, not Redis. The result is `transcriptor_canary_ok` and `transcriptor_canary_last_success_timestamp_seconds` on `/metrics`. The second consecutive failure logs `canary: transcript path failing` at error level and sends one Sentry message tagged `canary=true` and `reason`; the first success afterwards sends `canary: transcript path recovered`. A "server busy" refusal is skipped, not counted. `CANARY_INTERVAL_MS=0` turns it off; the stdio server and the REST API never run it.
- **Version metrics:** `transcriptor_build_info{version, yt_dlp_version}` (always `1`) and `yt_dlp_outdated` (`1` when GitHub has a newer yt-dlp release than the one installed), set at startup on the REST API and the MCP HTTP server and refreshed every 24 hours on the latter, so a container that has been up for weeks reports the drift instead of noticing it once at boot.
- **`reason` labels on the error counters:** `mcp_tool_errors_total{tool, reason}` carries a yt-dlp failure class (see Fixed), `busy`, `not_found`, `validation` or `unknown`; `subtitles_extraction_failures_total{reason}` is `no_subtitles` or the infrastructure class that ended the request. Queries that referenced either counter without aggregation now get several series and need `sum by (tool) (...)` / `sum(...)`.
- **Sentry groups yt-dlp failures by class:** `YtDlpError` events are fingerprinted `['yt-dlp', <reason>]` and tagged `yt_dlp_reason`, so a bot check is one issue however many tools raise it. `beforeSend` now drops every `HttpError` below `500` and the `503` busy refusal, so per-video conditions and bursts never open an issue while `502` upstream failures do. `SENTRY_RELEASE` defaults to the package version, so each release is grouped on its own.
- **`SMOKE_SKIP_TRANSCRIPT`** (`1`, `true` or `yes`) skips the real-YouTube `get_transcript` step of `npm run test:e2e:mcp`; initialize, `tools/list`, `GET /mcp` → `405` and the stdio check still run.
- **Site:** `/.well-known/security.txt` (RFC 9116; contacts `contact@` and `legal@transcriptor-mcp.org`, policy `/support/`, expires 2027-09-01); a real 404 page rendered through the site template with `noindex`, so Cloudflare Pages answers unknown paths with HTTP 404 instead of the landing page and 200; a support page at `/support/` (how to connect, how to report a problem with a first reply within two working days, account and sign-in, and known limitations: throttling and bot checks, unsupported private/members-only/age-gated/geo-blocked videos, paged long transcripts, YouTube-only search), linked from the footer of every page.

### Changed

- **Docker images run on Node 22:** both `Dockerfile` stages moved from `node:20-slim` to `node:22-bookworm-slim` — Node 20 reached end of life in April 2026 — and the Debian release is now pinned in the tag; CI and the site deploy run on Node 22 as well. Nothing changes for anyone pulling the image. Running from source on Node 20 still works (`engines` stays `>=20.0.0`) but gets no security patches; the README now recommends Node.js 22 or later.
- **The Docker publish is gated on tests and a smoke run:** `.github/workflows/publish-docker.yml` used to go from checkout straight to `push: true`. It now runs `npm ci` and `make check-no-smoke`, builds the MCP image for `linux/amd64` locally and runs `npm run test:e2e:mcp` against it with `SMOKE_SKIP_TRANSCRIPT=1` (no YouTube call, so no network flake in the gate), and only then pushes the multi-arch images — so a red tag reaches neither Docker Hub nor, since `publish-registry` needs `publish`, the MCP Registry. Runs queue instead of cancelling each other (`concurrency: publish-docker`). A `workflow_dispatch` with `latest_only=true` — the run an n8n workflow fires on every yt-dlp release — now rebuilds the newest `v*` tag with today's yt-dlp and pushes only `:latest`; before this release that path built `main`, so unreleased code shipped to `:latest` and to everyone auto-updating on it.
- **Duration histograms reach 120 seconds:** `http_request_duration_seconds` uses `0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120` and `mcp_request_duration_seconds` uses `0.5, 1, 2.5, 5, 10, 20, 30, 60, 120`; both stopped at `10` before, so every longer call landed in `+Inf` and `histogram_quantile` could not place a p95 above it. The `0.01`, `0.05` and `0.25` boundaries are gone (and `0.1` from the MCP histogram); a query pinned to one of those `le` values returns nothing.
- **The MCP HTTP server adopts an inbound `x-request-id`** as the `reqId` in every log line for that request, so a gateway that forwards its own id can tie its logs to the server's. Anyone who can reach port `4200` can set the header: keep the listener behind a proxy that overwrites it, or accept that clients pick their own log ids.
- **`websiteUrl` in `server.json` and `homepage` in `package.json` point at `https://transcriptor-mcp.org`.** The README environment table and [.env.example](.env.example) document `YT_DLP_MAX_CONCURRENCY`, `YT_DLP_MAX_QUEUE`, `CANARY_INTERVAL_MS` and `CANARY_URL`.
- **Privacy Policy 1.1 and Terms of Service 1.1:** the hosted Service keeps a response cache — caption text, video metadata, subtitle lists and chapter lists, keyed by the video address and request parameters, with no user identifier — for up to 30 days. Both documents said the cache was off.

### Fixed

- **yt-dlp failures are classified instead of all reading as "no subtitles":** the stderr and kill signal of a failed run are matched against a fixed pattern list and given one `reason` — `bot_check`, `rate_limited`, `private`, `age_restricted`, `geo_blocked`, `extractor`, `unavailable`, `timeout` or `unknown` — which is logged on every yt-dlp error line. The four classes that describe the server's standing with the platform rather than the video (`bot_check`, `rate_limited`, `timeout`, `extractor`) now end the request as `502 Upstream error` with one fixed sentence for the caller, e.g. "The video platform is rate-limiting requests right now. Try again in a few minutes." — on every REST route and MCP tool that runs yt-dlp, where the answer used to be the "no subtitles" `404` or a tool's generic "Failed to fetch…". **A `502` is a retry condition, not a missing-captions answer.** A private, age-restricted, geo-blocked or removed video still answers as before, and the Whisper fallback no longer runs against a platform that just refused the server.
- **The "No subtitles for language" hint names `get_available_subtitles`** first and keeps `GET /subtitles/available` for REST users; MCP clients were being sent to a path they cannot reach.

### Security

- **`get_playlist_transcripts` no longer hands the yt-dlp command line to the client:** a playlist failure used to answer with the full invocation — including the `--cookies` path and `--proxy` URL when configured — up to 4000 characters of stderr, and operator hints. It now answers with the one-sentence text for the failure class; the command and stderr stay in the server log. Partial results when some items downloaded are unchanged.
- **Unexpected MCP tool errors answer with a fixed line:** any error that is not one of the server's own typed errors is answered as "Tool failed. Please try again." instead of its raw message, which could hold a command line, a cookies path or a proxy URL; the error is logged with its stack and reported to Sentry, which the MCP tool path never did before. Typed errors keep their text.

## [1.2.4] - 2026-08-29

### Fixed

- **All eight tools now declare `destructiveHint`:** the annotations set `readOnlyHint`, `idempotentHint` and `openWorldHint` but left `destructiveHint` unset, so clients had to fall back to the protocol default. ChatGPT Apps review reads what the server advertises rather than what the spec defaults to, and treats a missing hint as a submission blocker. `false` is correct for every tool — `get_transcript`, `get_raw_subtitles`, `get_available_subtitles`, `get_video_info`, `get_video_chapters`, `get_video_frame`, `get_playlist_transcripts` and `search_videos` only retrieve public captions, metadata, chapters, frames and search results. `openWorldHint` stays `true`: the tools do reach third-party platforms over the public internet, which is what the flag means in the MCP spec.
- **Cursor and LM Studio install badges pointed at the old endpoint** in the README connect section, so a one-click install produced a configuration holding the retired path-based URL.

## [1.2.3] - 2026-08-28

### Changed

- **Hosted endpoint moved to its own subdomain:** `https://gateway.mcpal.io/mcp/transcriptor` is now `https://transcriptor.gateway.mcpal.io/mcp`. Updated everywhere it is published — the registry entry ([server.json](server.json)), the README connect section and its one-click install links, the landing page and `llms.txt` (both generated from `SERVER_URL` in [web/clients.mjs](web/clients.mjs)), and the service address named in the [Terms of Service](legal/TERMS_OF_SERVICE.md) and [Privacy Policy](legal/PRIVACY_POLICY.md). **Existing clients must repoint:** a configuration holding the old path-based URL has to be updated by hand.

## [1.2.2] - 2026-08-14

### Fixed

- **Transcript widget rendered an empty card:** `ontoolresult` is installed once from `onAppCreated`, so its closure captured `appRef` while that state was still `null`. `loadVideoMeta` then hit its `if (!appRef) return null` guard, `get_video_info` was never called, and neither the video card nor the caption list ever appeared — the widget showed only its title bar. The app instance is now passed through `handleTranscriptResult` → `loadVideoMeta` instead of read from state, matching what the video-info widget already does with the `app` argument it is handed.

### Changed

- **README widget section shows the real interface:** the single `example-usage.webp` is replaced by four screenshots, one per widget, captured from the production bundles driven by real server payloads. All four use MCP and AI-workflow material, so the images speak to the audience the README is written for: a `search_videos` carousel for *"model context protocol MCP server production"*, a `get_video_frame` capture of an agent-to-server architecture slide, a `get_transcript` view of a 3-minute MCP explainer with official captions, and a `get_video_info` card showing views, likes, and a 169-language caption picker. They live in [assets/](assets).
- **Widgets heading no longer breaks its own anchor:** the heading emoji carried a U+FE0F variation selector, which GitHub keeps in the generated slug, so the `#-widgets` links in the MCP Apps badge and the nav bar resolved to nothing. Replaced with an emoji that needs no variation selector.
- **FAQ section removed** from the README.

## [1.2.1] - 2026-08-13

### Added

- **Published to the official MCP Registry** as `io.github.samson-art/transcriptor-mcp` ([server.json](server.json)). The entry advertises both the hosted Streamable HTTP endpoint (`https://gateway.mcpal.io/mcp/transcriptor`, OAuth) and the self-hostable Docker image, so MCP clients can discover and install the server directly.
- **`io.modelcontextprotocol.server.name` label on the MCP image:** the registry's ownership proof for OCI packages — without it the published image cannot be bound to the server entry.
- **`publish-registry` job in `publish-docker.yml`:** after the images are pushed on a `v*` tag, `server.json` is synced to the released version and republished with `mcp-publisher login github-oidc`. No secret needed; authorizes the `io.github.samson-art/*` namespace via the repository's OIDC identity.

- **Native Streamable HTTP transport (`src/mcp-http.ts`, `src/mcp-http-entry.ts`):** The MCP server now speaks HTTP itself at `POST /mcp` — the `mcp-proxy` Python sidecar is gone. Runs in the SDK's **stateless** mode: no `Mcp-Session-Id` is issued and no state is kept between requests, so any instance can serve any request. A fresh `McpServer` and transport are built per request (required by the SDK, which throws when a stateless transport is reused). Started with `npm run start:mcp:http`; port and bind address come from `MCP_PORT` (default 4200) and `MCP_HOST` (default 0.0.0.0).
- **`GET /health` and `GET /metrics` on the MCP port:** liveness for the new Docker `HEALTHCHECK`, and Prometheus exposition that restores visibility of the `mcp_tool_calls_total` / `mcp_tool_errors_total` / `mcp_request_duration_seconds` series, which have been recorded in-process but unexposed since the HTTP layer was removed.
- **`MCP_PORT` / `MCP_HOST` in `.env.example`:** previously set in compose files but read by nothing.

### Changed

- **README rewritten around connecting, not architecture:** one-click install links for Cursor and VS Code, a one-line `claude mcp add` command, click-paths for Claude and ChatGPT, and the real hosted endpoint in place of the `your-host.example` placeholder. Tool reference, transport details, REST API and development notes moved into collapsible sections. Docker Hub description resynced, dropping env vars nothing reads any more (`MCP_AUTH_TOKEN`, `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS`, `MCP_RATE_LIMIT_*`, `MCP_SESSION_*`) and the retired `/sse` endpoint.
- **MCP image default command is now HTTP** (`npm run start:mcp:http`), matching the port mapping deployments already use. **Breaking for stdio users:** `docker run --rm -i <image>` must become `docker run --rm -i <image> npm run start:mcp`. README, `Makefile`, and the e2e smoke test were updated accordingly.
- **MCP SDK bumped to `^1.30.0`:** adds SSE keep-alive frames (default every 15 s) and `X-Accel-Buffering: no`, both of which matter for long-running tool calls behind a buffering proxy or an idle-timeout gateway.
- **E2E MCP smoke rewritten for the new transport:** readiness now probes `GET /health` instead of `GET /sse`; `initialize` asserts that **no** session header comes back; `tools/call` no longer sends one; added a `tools/list` check covering all eight tools and a `GET /mcp` → 405 check; the stdio check passes an explicit `npm run start:mcp` command.

### Removed

- **`mcp-proxy` sidecar and its Python dependency chain:** the `pip3 install mcp-proxy` layer is dropped from the MCP image. This also removes the `mcp`-package pinning problem (mcp 2.x renamed `streamablehttp_client`, which mcp-proxy 0.11.0 still imports).
- **Legacy SSE transport (`GET /sse`, `POST /message`) and mcp-proxy's `/status`:** the MCP spec removes the 2024-11-05 HTTP+SSE transport, and clients are expected to drop it. Streamable HTTP clients are unaffected; SSE-configured clients must switch to `POST /mcp`.

## [1.2.0] - 2026-07-02

### Added

- **`get_video_frame` MCP tool:** Captures a single frame from a video at a given timestamp. Input: `url`, `timecode` (`"MM:SS"` or `"HH:MM:SS(.mmm)"`, e.g. `"01:23"`, `"00:01:23.500"`) or `seconds` (default: `0`, first frame), `format` (`jpeg` default / `png`), `width` (default 1280, max 1920, never upscales), `quality` (ffmpeg `-q:v` 2–31, default 4). Returns an MCP `image` content block (base64) plus `structuredContent` (`videoId`, `timestampSeconds`, `timestamp`, `mimeType`, `sizeBytes`, `width` — actual output width read from PNG/JPEG headers).
- **`captureVideoFrame()` in `src/youtube.ts`:** Fast path resolves video id, duration, and a direct stream URL in one `yt-dlp --print id --print duration --print urls` call, then ffmpeg seeks over HTTP (`-ss`) and grabs one frame without downloading the video. Fallback: `yt-dlp --download-sections` fetches a ~2s re-encoded clip (`--force-keyframes-at-cuts`, first frame = exact timestamp) and ffmpeg extracts it locally. Honors cookies, `YT_DLP_PROXY` (also passed to ffmpeg via `-http_proxy`), and yt-dlp env args. Returns a discriminated outcome (`ok` / `timestamp_beyond_duration` / `capture_failed`). Requires `ffmpeg` (already included in the Docker image).
- **`YT_DLP_FRAME_TIMEOUT`:** Timeout for frame-capture yt-dlp/ffmpeg runs; falls back to `YT_DLP_TIMEOUT` (default 60000 ms).
- **MCP Apps (interactive widgets):** React UIs served as `ui://` resources for hosts supporting [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (`registerAppTool` / `registerAppResource` with `ui.resourceUri` and `openai/outputTemplate` metadata):
  - `search_videos` — result carousel with video details and subtitle search;
  - `get_transcript` — video card with searchable timed subtitles and track picker;
  - `get_video_info` — video card with metadata and collapsible description;
  - `get_video_frame` — frame viewer with recapture controls (±1s/±10s steppers, timecode input, watch-at-time link).
- **Vite single-file UI build:** New `ui/` workspace (React 19, Vite, `vite-plugin-singlefile`) compiled into self-contained `dist/ui/<app>.html` files via `npm run build:ui`; `npm run build` now builds both the server and the UI apps.

### Changed

- **MCP SDK:** `@modelcontextprotocol/sdk` 1.26 → 1.29; added `@modelcontextprotocol/ext-apps` for app tool/resource registration.
- **`transcriptor://info` resource and usage guide:** Now list `get_video_frame` and the widget resource URIs.
- **README:** Documents the `get_video_frame` tool (inputs, response shape, timeout).

## [1.1.0] - 2026-05-28

### Added

- **Hosted service legal terms:** Added `legal/EULA.md` and `legal/TERMS_OF_SERVICE.md` for the hosted Transcriptor MCP offering (OAuth-protected MCP at operator endpoints). Self-hosted deployments remain under the MIT License.

### Changed

- **README — remote MCP setup:** Quick start and connection docs now describe self-hosted HTTP/SSE via [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) (optional TLS/Bearer auth at a reverse proxy) instead of Smithery/Glama URL install, session `apiToken`, and one-click registry badges.

### Removed

- **Smithery and Glama artifacts:** Removed `smithery.yaml`, `glama.json`, and README/registry connection docs (badges, remote URL install links, session `apiToken` flow).
- **Legacy `.well-known` MCP discovery files:** Removed `.well-known/mcp-config` and `.well-known/mcp/server-card.json` (artifacts from the old in-process MCP HTTP server; not served by stdio or `mcp-proxy`). Tool discovery uses live MCP (`tools/list`, etc.).
- **`scripts/generate-server-card.mjs`:** Removed build-time server-card generator and `postbuild` / `generate:server-card` npm scripts.

## [1.0.0] - 2026-04-26

### Added

- **MCP HTTP edge guidance:** Added documentation and examples for deploying stdio `mcp-proxy` behind an external edge (reverse proxy or API gateway) with token auth and traffic control.
- **Edge/operator guides:** Added `docs/edge-smithery-gate.md` and `docs/mcp-edge-rate-limit.md` with concrete policies for `X-MCP-Api-Token`, Smithery-shaped traffic gating, and reverse-proxy rate-limit strategies.
- **Build-time server-card generation:** Added `scripts/generate-server-card.mjs` and npm scripts (`generate:server-card`, `postbuild`) to produce `.well-known/mcp/server-card.json` automatically after build for SEP-1649/Smithery discovery.
- **MCP config schema support for `apiToken`:** `.well-known/mcp-config` now documents and maps `apiToken` (`X-MCP-Api-Token`) in addition to `authToken`.

### Changed

- **Smithery session config contract:** `smithery.yaml` now separates `authToken` (Authorization/Bearer for self-hosted edge auth) from `apiToken` (`X-MCP-Api-Token` for token pools/quotas), with explicit header mapping metadata.
- **Docs alignment around MCP architecture:** README and docs now consistently describe this repo’s MCP model as stdio + external `mcp-proxy`, clarify that Node app `RATE_LIMIT_*` applies to REST API only, and move MCP auth/rate-limit responsibilities to infrastructure edge layers.
- **Monitoring documentation scope:** `docs/monitoring.md` clarifies that `/metrics` is exposed by the REST API only, while MCP-over-HTTP observability belongs to proxy/WAF metrics, logs, or Sentry.
- **Quick-start and public-url guidance:** MCP quick-start/public URL docs now include stronger guidance for edge auth, `/mcp` and `/sse` protection, and safer `.well-known` behavior for catalog discovery.
- **Pre-commit checks:** `.husky/pre-commit` now runs `make prepare && make check-no-smoke`.

### Security

- **Safer MCP auth signaling in server card:** Generated server card keeps `authentication.required: false` to avoid advertising unsupported OAuth schemes while relying on edge-enforced `X-MCP-Api-Token`/Bearer policies documented for operators.

## [0.6.9] - 2026-03-31

### Added

- **`get_playlist_transcripts` hardening (`downloadPlaylistSubtitles` in `src/youtube.ts`):** Returns a discriminated **`DownloadPlaylistSubtitlesOutcome`** (`ok` + `results` or `failure`) instead of `null` on error. On yt-dlp failure, still scans the temp directory and returns **partial results** when any subtitle files were written (aligned with single-video `runYtDlpAndExtractSubtitles`).
- **`--ignore-errors`** for playlist subtitle runs so one bad entry does not abort the batch. Opt out with **`YT_DLP_PLAYLIST_IGNORE_ERRORS=0`**. Documented in `docs/configuration.md` and `.env.example`.
- **`YT_DLP_VERBOSE_ON_ERROR`:** When set to `1`, after a failed playlist run with no partial files, runs yt-dlp once more with `-v` and without `--quiet`/`--no-progress` and logs stderr for diagnostics. Documented in `docs/configuration.md` and `.env.example`.
- **`collectExecFileErrorDetails()`** and **`ExecFileErrorDetails`:** Normalized fields from failed `execFile` / yt-dlp runs (`message`, `exitCode`, `signal`, `cmd`, `stdout`, `stderr`) for structured logs.
- **`formatPlaylistDownloadFailureMessage()`:** Builds the MCP/API-facing error string (message, exit code, stderr tail, operational hints).
- **`appendYtDlpEnvArgs` options:** Optional third argument **`AppendYtDlpEnvArgsOptions`** with **`quiet: false`** to omit `--no-progress` and `--quiet` (used for verbose replay).

### Changed

- **Playlist failure logging:** Logs **`exitCode`**, **`signal`**, and **`cmd`** when present, not only empty stdout/stderr under `--quiet`.
- **MCP `get_playlist_transcripts`:** On full failure, throws an error whose message comes from **`formatPlaylistDownloadFailureMessage`** instead of the generic `Failed to fetch playlist subtitles.`

### Tests

- **`src/youtube.test.ts`:** Coverage for `collectExecFileErrorDetails`, `formatPlaylistDownloadFailureMessage`, `--ignore-errors` / `YT_DLP_PLAYLIST_IGNORE_ERRORS=0`, failure outcome shape, and `appendYtDlpEnvArgs` with `quiet: false`.

## [0.6.8] - 2026-03-23

### Added

- **Background Whisper jobs and late cache write:** When the client hits `WHISPER_TIMEOUT` but Whisper finishes afterward, the transcript is still saved to Redis (same subtitle cache keys as a normal success) so the next request for that video can be a cache hit. Implemented via deduplicated in-flight jobs in `src/whisper-jobs.ts` (`startOrReuseWhisperJob`), `Promise.race` against `getWhisperConfig().timeout` in `src/validation.ts` for auto-discovery and explicit `type`/`lang` flows, and optional `timeoutMs` on `transcribeWithWhisper` / local+API helpers (`0` = no `fetch` abort).
- **`WHISPER_BACKGROUND_TIMEOUT`:** Env var for the long-running Whisper HTTP client used by background jobs (unset = `max(1800000, 3 × WHISPER_TIMEOUT)`; `0` = no client-side abort). Documented in `docs/configuration.md`, `docs/caching.md`, `.env.example`, and `docker-compose.example.yml`.
- **Prometheus gauge `whisper_background_jobs_active`:** Tracks in-flight deduplicated background Whisper jobs; `setWhisperBackgroundJobsActive()` in `src/metrics.ts`.
- **Tests:** `src/whisper-jobs.test.ts`; `src/whisper.test.ts` asserts `fetch` is called without `signal` when `timeoutMs === 0`; `src/validation.test.ts` covers `cache.set` after simulated timeout for auto-discover and explicit lang.

### Changed

- **`WHISPER_TIMEOUT` semantics (docs):** Clarified as the per-request wait before returning 404 to the client; background transcription may continue for cache population when Redis is enabled.
- **`docs/monitoring.md`:** Documented `whisper_background_jobs_active` for API and MCP metrics tables.

## [0.6.7] - 2026-03-14

### Added

- **VTT word-by-word deduplication:** `parseVTT` now groups and deduplicates consecutive cues with identical text, fixing duplicated words in word-level VTT subtitles (e.g. from YouTube auto-generated captions).

### Changed

- **Subtitle validation and download logic:** Refactored `validateAndDownloadSubtitles` — introduced `throwNoSubtitlesError` for centralized "subtitles not found" handling; split auto-discovery and explicit-request flows into `handleAutoDiscoverFlow` and `handleExplicitRequestFlow` for clearer structure and maintainability.
- **Error messages:** Improved guidance for subtitle availability and Whisper fallback attempts when subtitles are not found.
- **README and documentation:** Refined introduction and connection options; added "supported platforms" section emphasizing multi-platform support; clarified Whisper fallback and Redis caching in `docs/configuration.md`; streamlined quick-start with Smithery and Glama no-install options.

## [0.6.6] - 2026-03-13

### Added

- **Reddit support:** Reddit (reddit.com, old.reddit.com, v.redd.it) added as a supported platform for video transcripts and metadata. Documentation, validation, and MCP tool descriptions updated.
- **`extractPlatformFromUrl()`:** New helper extracts platform identifier from input URL hostname (youtube, reddit, vimeo, etc.) for flexible source reporting.

### Changed

- **`source` field:** Response schemas and validation now accept generic strings for `source` (e.g. `youtube`, `whisper`, `reddit`) instead of fixed literals, allowing new platforms without schema changes.
- **Publish Docker workflow:** Extracts and outputs built image tags; removed unused release trigger.

## [0.6.5] - 2026-03-13

### Added

- **Publish Docker workflow:** Manual run via `workflow_dispatch` with optional `version` input (e.g. `0.6.5` or `v0.6.5`) and `latest_only` flag. When `latest_only=true`, builds from default branch and pushes only `:latest` (no version tag).
- **Docker image verification:** Publish workflow logs the yt-dlp version installed in the built image for easier debugging.
- **docs/configuration.md:** Section on container memory limits for long Whisper transcriptions — `deploy.resources.limits.memory` (e.g. 4–6 GB) to avoid OOM kills on CPU.

### Changed

- **WHISPER_TIMEOUT default:** Increased from 2 minutes (120000 ms) to 10 minutes (600000 ms) to better support long videos.
- **404 error messages:** When Whisper fallback fails, the "Subtitles not found" response now explicitly mentions that Whisper was attempted and suggests increasing `WHISPER_TIMEOUT` (e.g. 3600000 for 1-hour videos).
- **Whisper error logging:** Local and API modes now distinguish timeout (AbortError) vs network/service error in log messages.
- **docs/configuration.md:** Updated WHISPER_TIMEOUT description and flow text for 1-hour videos on CPU; `.env.example` and `docker-compose.example.yml` use 600000 as the example value.

## [0.6.4] - 2026-02-17

### Added

- **Use-case documentation:** Four new guides in `docs/`: [IDE and AI assistants (Cursor, Claude, VS Code)](docs/use-case-ide-cursor-claude.md), [No-code automation (n8n)](docs/use-case-n8n-automation.md), [Researchers and batch processing](docs/use-case-researchers-batch.md), and [Self-hosted and enterprise](docs/use-case-self-hosted.md). Linked from main README and `docs/README.md`.

### Changed

- **README:** Use-case section now references `docs/README.md` with the full list of guides (summarize video, search and transcript, IDE/Cursor/Claude, n8n, researchers/batch, self-hosted).
- **mcp-http.test.ts:** Simplified `idempotentHint` assertion for server-card tools; corrected env var cleanup order in `resolvePublicBaseUrlForRequest` test.

## [0.6.3] - 2026-02-15

### Added

- **Sentry:** `beforeSend` filters out expected client errors (NotFoundError, ValidationError) to reduce noise; expected 404s are monitored via Prometheus instead.
- **Prometheus metric `http_404_expected_total`:** Counter for expected 404 responses (NotFoundError) with labels `method` and `route`.
- **404 response `available` field:** When subtitles are not found, the API now returns `available: { official, auto }` in the 404 payload so clients can show supported languages without an extra `/subtitles/available` call.
- **Load test result report:** `load/load-test-result-2025-02-15.md` — results for subtitles, mixed, 10 VU 1 min, and podcast 2h scenarios (k6, BASE_URL, thresholds, metrics).

### Changed

- **Error messages:** NotFoundError messages now hint at `/subtitles/available` and auto-discovery (omit type/lang).
- **Sentry context:** 5xx events include `requestUrl` from body for subtitle endpoints; `route` tag added; MCP errors include transport type and sessionId.
- **docs/sentry.md:** Documented `beforeSend` filtering, Prometheus for expected 404s, SENTRY_RELEASE recommendation.

### Removed

- **Obsolete load test result:** Removed `load/load-test-subtitles-result-2026-02-13.md`; results consolidated in `load/load-test-result-2025-02-15.md`.

## [0.6.2] - 2026-02-15

### Added

- **Sentry Performance / tracing:** Optional **`SENTRY_TRACES_SAMPLE_RATE`** (0–1, default `0.1`) and **`SENTRY_SEND_DEFAULT_PII`** env vars. `src/instrument.ts` passes `tracesSampleRate` and `sendDefaultPii` to Sentry.init. Performance monitoring is active when running via `start` / `start:mcp` / `start:mcp:http` (instrument loaded first). Documented in `docs/sentry.md` (Performance / Tracing section) and `.env.example`.
- **Load scenario "10 VU, 1 min":** New k6 script `load/ten-users-1min.js` — 10 concurrent users, each requests one video at a time until 1 minute; uses VIDEO_POOL. Make target **`load-test-10vu-1min`**, npm script **`load-test:10vu-1min`**. Documented in `load/load-testing.md` with thresholds (`http_req_failed` &lt; 5%, p95 &lt; 120 s).
- **Load scenario "100 VU, 2h podcasts":** New k6 script `load/podcast-2h-100vu.js` — 100 VU at once, one 2h podcast per VU; uses **`PODCAST_2H_POOL`** and **`getPodcast2hRequest()`** in `load/config.js` (~95 long-form videos: JRE, Lex Fridman, Tim Ferriss, Rich Roll, вДудь, etc.). Make target **`load-test-podcast-2h`**, npm script **`load-test:podcast-2h`**. Documented in `load/load-testing.md` (scenario section, recommended API env, how to read `test_run_duration`).

### Changed

- **load/config.js:** Added `PODCAST_2H_POOL` and `getPodcast2hRequest(iter, vu)` for the 2h podcast load scenario.
- **load/load-testing.md:** New scenario table rows for `ten-users-1min.js` and `podcast-2h-100vu.js`; PODCAST_2H_POOL description; thresholds for ten-users-1min; dedicated sections "Scenario: 10 users, one video per request for 1 minute" and "Scenario: 100 users, 2h podcasts".

## [0.6.1] - 2026-02-15

### Added

- **Configurable subtitle format (srt, vtt, ass, lrc):** New env **`YT_DLP_SUB_FORMAT`** and optional **`format`** parameter for MCP tools `get_transcript`, `get_raw_subtitles`, and `get_playlist_transcripts`. REST API `POST /subtitles` accepts `format`. Default remains `srt`. Cache keys include format. Exported `SubtitleFormat` and `resolveSubtitleFormat()` in `src/youtube.ts`; `get_raw_subtitles` output schema and server card include `ass` and `lrc`.
- **yt-dlp retries and extra args (all calls):** **`YT_DLP_RETRIES`** (`-R`), **`YT_DLP_RETRY_SLEEP`** (e.g. `linear=1::2`), **`YT_DLP_EXTRA_ARGS`** (space-separated). Documented in `docs/configuration.md` and `.env.example`.
- **yt-dlp sleep options (rate limits):** **`YT_DLP_SLEEP_REQUESTS`**, **`YT_DLP_SLEEP_INTERVAL`**, **`YT_DLP_MAX_SLEEP_INTERVAL`**, **`YT_DLP_SLEEP_SUBTITLES`**. Documented in `docs/configuration.md` and `.env.example`.
- **yt-dlp subtitle encoding:** **`YT_DLP_ENCODING`** (e.g. `utf-8`, `cp1251`) for subtitle downloads (`--encoding`).
- **yt-dlp audio download options (Whisper only):** **`YT_DLP_AUDIO_CONCURRENT_FRAGMENTS`** (`-N`), **`YT_DLP_AUDIO_LIMIT_RATE`**, **`YT_DLP_AUDIO_THROTTLED_RATE`**, **`YT_DLP_AUDIO_RETRIES`**, **`YT_DLP_AUDIO_FRAGMENT_RETRIES`**, **`YT_DLP_AUDIO_RETRY_SLEEP`**, **`YT_DLP_AUDIO_BUFFER_SIZE`**, **`YT_DLP_AUDIO_HTTP_CHUNK_SIZE`**, **`YT_DLP_AUDIO_DOWNLOADER`**, **`YT_DLP_AUDIO_DOWNLOADER_ARGS`** for DASH/HLS reliability and speed. Documented in `docs/configuration.md` and `.env.example`.
- **`YT_DLP_NO_WARNINGS`:** When set to `1`, pass `--no-warnings` to all yt-dlp calls. Reduces log noise.
- **`YT_DLP_IGNORE_NO_FORMATS`:** When not set to `0`, pass `--ignore-no-formats-error` when fetching video metadata (info, chapters, available subtitles), so region-locked or undownloadable videos still return metadata. Set to `0` to fail on "No video formats" (default yt-dlp behavior). Documented in `docs/configuration.md`.

### Changed

- **yt-dlp headless behavior:** All yt-dlp calls now pass `--quiet` and `--no-progress` for cleaner server logs. `appendYtDlpSubtitleArgs()` in `src/youtube.ts` applies common subtitle args; unit tests in `youtube.test.ts` and `validation.test.ts` updated for format and new env vars.

## [0.6.0] - 2026-02-15

### Added

- **MCP tool `get_playlist_transcripts`:** Fetch cleaned subtitles for multiple videos from a playlist in one call. Parameters: `url` (playlist or watch with list=), optional `playlistItems` (yt-dlp -I spec, e.g. "1:5", "1,3,7", "-1"), `maxItems`, `type`, `lang`. New `downloadPlaylistSubtitles()` in `src/youtube.ts`; tool registered in `mcp-core.ts` and server card.
- **`search_videos` extended with yt-dlp filters:** Optional `dateBefore` (e.g. "now-1year"), `date` (exact date), `matchFilter` (e.g. "!is_live", "duration < 3600"). `searchVideos()` in `src/youtube.ts` now accepts these in `SearchVideosOptions`; yt-dlp receives `--datebefore`, `--date`, `--match-filter` when set.
- **yt-dlp `--no-playlist` for single-video tools:** `downloadSubtitles`, `fetchYtDlpJson`, and `downloadAudio` now pass `--no-playlist` so URLs like `watch?v=X&list=Y` process only the single video instead of the full playlist.
- **yt-dlp env filters:** New optional env vars: `YT_DLP_MAX_FILESIZE` (e.g. "50M") for Whisper audio; `YT_DLP_DOWNLOAD_ARCHIVE` (path) and `--break-on-existing` for `get_playlist_transcripts`; `YT_DLP_AGE_LIMIT` for `search_videos`. Documented in `docs/configuration.md` and `.env.example`.

## [0.5.9] - 2026-02-15

### Added

- **`YT_DLP_AUDIO_TIMEOUT`:** Separate timeout for audio download (Whisper fallback). Falls back to `YT_DLP_TIMEOUT` when unset. Enables processing videos up to 5 hours at slow download speeds (e.g. at ~420 KiB/s, 5 h audio needs ~15 min; set `900000` ms). Documented in `docs/configuration.md` and `.env.example`.
- **`GET /changelogs`:** REST API and MCP HTTP servers now expose `GET /changelogs`, returning `CHANGELOG.md` as `text/markdown` for programmatic access.

### Changed

- **Long videos (5+ hours):** `docs/configuration.md` — added `YT_DLP_AUDIO_TIMEOUT` and guidance for 5-hour videos (use local Whisper, `WHISPER_TIMEOUT=3600000`; Whisper API max 25 MB).

## [0.5.8] - 2026-02-15

### Added

- **Optimal audio quality for Whisper:** When downloading audio via yt-dlp for Whisper fallback, the app now prefers smaller streams to reduce download time without hurting speech recognition. Format selector `bestaudio[abr<=192]/bestaudio` (prefer streams ≤192 kbps; fallback to best audio) and `--audio-quality 5` (~128 kbps VBR for m4a) are used by default. Configurable via **`YT_DLP_AUDIO_FORMAT`** (default: `bestaudio[abr<=192]/bestaudio`) and **`YT_DLP_AUDIO_QUALITY`** (0–9, default: `5`). Documented in `docs/configuration.md` and `.env.example`. Unit tests in `youtube.test.ts` assert default and env-driven args for `downloadAudio`.

### Changed

- **Audio download (Whisper):** `downloadAudio()` in `src/youtube.ts` now passes `-f`, `--audio-quality`, and the chosen format/quality to yt-dlp. Flow description in `docs/configuration.md` (Whisper section) updated to mention the default format and quality.

## [0.5.7] - 2026-02-15

### Changed

- **Unit tests optimized for real usage scenarios:** `mcp-core.test.ts` — added scenario tests "Use case: Search and transcript" (search_videos → get_transcript with url from first result) and "Use case: Pagination for long transcripts" (get_raw_subtitles with response_limit and next_cursor); consolidated duplicate "invalid URL" error tests into one "tools requiring video URL" test. `mcp-http.test.ts` — consolidated five server-card tests into one comprehensive test (tools, prompts, resources, SEP-1649, configSchema, Tool Quality); grouped `resolvePublicBaseUrlForRequest` tests by scenario (fallbacks, Host matching, X-Forwarded-Host, Smithery cf-worker).

## [0.5.6] - 2026-02-15

### Added

- **CORS for MCP HTTP discovery:** `@fastify/cors` enabled for MCP HTTP server (origin: true, methods: GET). Allows Smithery and other registries to fetch `/.well-known/mcp/server-card.json` and `/.well-known/mcp/config-schema.json` from cross-origin requests (SEP-1649).
- **SEP-1649 server card fields:** Server card now includes `$schema`, `version`, `protocolVersion`, `transport` (streamable-http /mcp), and `capabilities`. Improves compatibility with MCP Server Cards spec and Smithery tool discovery.
- **README "When to use Transcriptor MCP":** New section describing when to choose transcriptor-mcp (transcripts/metadata without downloads, multi-platform, Whisper fallback, remote/HTTP, monitoring).
- **Quick Start reordered:** Smithery URL (`https://server.smithery.ai/samson-art/transcriptor-mcp`) is now the first option ("no install"); Docker and local Node follow. Explicit "Connect by URL — no local install" messaging. README links to [Smithery server page](https://smithery.ai/servers/samson-art/transcriptor-mcp) in header, Quick Start, Features, and "When to use".
- **Use-case documentation:** `docs/use-case-summarize-video.md` (summarize video via get_transcript + model) and `docs/use-case-search-and-transcript.md` (search YouTube, then get transcript). Linked from `docs/README.md` and main README.
- **`search_videos` extended:** Optional `offset` (pagination), `uploadDateFilter` (`hour` | `today` | `week` | `month` | `year`), and `response_format` (`json` | `markdown`). `searchVideos()` in `src/youtube.ts` now accepts `SearchVideosOptions` (`offset`, `dateAfter`); yt-dlp receives `--dateafter` when filter is set. Server card and README tool reference updated.
- **Smithery badge and VS Code install badges (README):** Smithery badge added to the badge row; Overview now states "Optimized for Smithery with resources, prompts, and flexible configuration". Quick Start includes one-click install badges for VS Code and VS Code Insiders (URL-based config for the Smithery server).
- **Discoverable info resource:** New MCP resource `transcriptor://info` (Smithery discoverable) returning JSON with server message, `availableResources` (info, transcript template, supported-platforms, usage), `tools`, and `prompts`. Registered in `mcp-core.ts` and listed in server card.
- **Dynamic transcript resource:** New MCP resource template `transcriptor://transcript/{videoId}`. Clients can read a video transcript by URI (e.g. `transcriptor://transcript/dQw4w9WgXcQ`) without calling a tool. Uses `ResourceTemplate` from the MCP SDK; handler fetches and parses subtitles and returns JSON (`videoId`, `type`, `lang`, `text`, optional `source`).
- **MCP prompt `search_and_summarize`:** New prompt with args `query` (required) and `url` (optional). Builds a user message that asks the model to search YouTube for the query and summarize the first result’s transcript, or to summarize the given video URL. Exposed in server card and in `transcriptor://info`.
- **Unit tests for Tool Quality:** In `mcp-http.test.ts`, two tests for `GET /.well-known/mcp/server-card.json`: "includes title for each tool (Tool Quality)" asserts every tool has the expected `title`; "includes parameter descriptions for get_raw_subtitles (Tool Quality)" asserts all parameters of `get_raw_subtitles` (url, type, lang, response_limit, next_cursor) have a non-empty `description`. Added "includes SEP-1649 fields" test for `$schema`, `version`, `protocolVersion`, `transport`, and `capabilities`.

### Changed

- **Tool Quality (Smithery):** Server card now includes `title` for every tool (e.g. "Get video transcript", "Get raw video subtitles") and `description` for every parameter of `get_raw_subtitles` (type, lang, response_limit, next_cursor). In `mcp-core.ts`, optional fields of `subtitleInputSchema` now have `.describe()` so live MCP `tools/list` returns parameter descriptions. Improves Smithery Tool Quality score (tool descriptions, parameter descriptions, annotations).
- **README Features:** First bullet is "Connect by URL (Smithery)" — use the server without installing Docker or Node. MCP quick start section retitled to "Docker and self-hosted" with a pointer to Smithery for one-click connection.
- **smithery.yaml:** Comment added with public URL and "Connect by URL — no local install".
- **MCP config schema and .well-known/mcp-config:** Enriched `documentation` with expanded `gettingStarted` (three steps including Smithery URL and tool names), `apiLink` (GitHub readme), and updated `security` text. Applied in both `MCP_SESSION_CONFIG_SCHEMA` in `mcp-http.ts` and `.well-known/mcp-config`.
- **Server card:** Resources list now includes `info` (`transcriptor://info`) and `transcript` (template `transcriptor://transcript/{videoId}`); prompts list includes `search_and_summarize` with arguments `query` and `url`. Server-card test updated to allow resources with either `uri` or `uriTemplate`.

## [0.5.5] - 2026-02-15

### Added

- **MCP tool `search_videos`:** Search videos on YouTube via yt-dlp (ytsearch). No required parameters; provide `query` and optional `limit` (default 10, max 50). Returns list of videos with metadata (id, title, url, duration, uploader, viewCount, thumbnail). New `searchVideos(query, limit, log)` in `src/youtube.ts`; tool registered in `mcp-core.ts` and exposed in server card.
- **Sentry breadcrumbs from Pino logs:** When a 4xx or 5xx error is sent to Sentry, the event now includes a full trail of log calls (debug, info, warn, error) that led up to the error. REST API and MCP HTTP use a Pino logger that writes each log line to stdout and adds a Sentry breadcrumb; `maxBreadcrumbs` set to 100 in Sentry init. New module `src/logger-sentry-breadcrumbs.ts` (`createLoggerWithSentryBreadcrumbs()`); docs/sentry.md updated with a Breadcrumbs section.
- **`MCP_PUBLIC_URLS`:** Comma-separated list of public base URLs for multi-origin MCP deployments (e.g. Smithery + direct domain). The server selects the matching URL per request using `Host` or `X-Forwarded-Host`. When set, takes precedence over `MCP_PUBLIC_URL`. Backward compatible: single `MCP_PUBLIC_URL` still works.
- **POST /sse compatibility:** Some MCP clients (e.g. Cursor via Smithery) POST to `/sse` for streamable HTTP. The server now accepts POST on `/sse` and delegates to the streamable handler; canonical endpoint remains POST `/mcp`.

## [0.5.4] - 2026-02-14

### Added

- **MCP Prompts:** Server now exposes two prompts for discovery and use by MCP clients (e.g. Smithery). `get_transcript_for_video` — builds a user message that asks the model to fetch the video transcript via the get_transcript tool (argument: `url`). `summarize_video` — builds a user message that asks the model to fetch the transcript and summarize the video (argument: `url`). Both appear in `GET /.well-known/mcp/server-card.json` and are available via `prompts/list` and `prompts/get`.
- **MCP Resources:** Server now exposes two static resources. `supported-platforms` (`transcriptor://docs/supported-platforms`) — list of supported video platforms. `usage` (`transcriptor://docs/usage`) — brief usage guide for transcriptor-mcp tools. Both appear in the server card and are available via `resources/list` and `resources/read`. Improves Smithery Server Capabilities score (Prompts and Resources).

## [0.5.3] - 2026-02-14

### Added

- **MCP server card:** `GET /.well-known/mcp/server-card.json` returns static server card for MCP discovery (server name, version, authentication requirements, list of tools with names, descriptions, input schemas, and annotations). No authentication required. Documented in `docs/quick-start.mcp.md`.
- **MCP tool annotations:** All MCP tools now expose `annotations: { readOnlyHint: true, idempotentHint: true }` in the tool definition and in the server card. Enables clients (e.g. Smithery, Cursor) to discover read-only and idempotent tools for caching and UX.
- **Smart subtitle auto-discovery:** When `type` and `lang` are both omitted for `POST /subtitles` (REST API) or `get_transcript`/`get_raw_subtitles` (MCP), the service now auto-discovers subtitles instead of defaulting to `auto`/`en`. Flow: (1) fetch available subtitles; (2) try each official language until success; (3) for YouTube auto captions, prefer `*-orig` (original-language tracks) first, then iterate remaining auto; (4) for non-YouTube, iterate auto list as-is; (5) if no subtitles found, fallback to Whisper; (6) return 404 only when all attempts and Whisper fail. Request schema: `type` and `lang` no longer have defaults when omitted, enabling detection of auto-discover vs explicit request. Cache key for auto-discover: `sub:{url}:auto-discovery`.
- **Whisper request metric:** New Prometheus counter `whisper_requests_total` with label `mode` (`local` or `api`) records each Whisper transcription attempt. Exposed on both REST API and MCP HTTP `/metrics`. `recordWhisperRequest(mode)` in `src/metrics.ts`; called from `transcribeWithWhisper()` when transcription is actually attempted (not when skipped). Documented in `docs/monitoring.md` (metrics tables and PromQL examples). Unit tests in `whisper.test.ts` assert the metric is recorded for local and api mode and not recorded when Whisper returns early.

### Changed

- **MCP `get_transcript`:** Input is now only `url`. Parameters `type`, `lang`, `response_limit`, and `next_cursor` have been removed. The tool uses auto-discovery for type/language and returns the first chunk with default size. For explicit type/lang and pagination use `get_raw_subtitles`.

## [0.5.2] - 2026-02-14

### Fixed

- **MCP SSE initialization 404 when used from another origin (e.g. Smithery):** The SDK sends a relative path in the SSE `endpoint` event (`/message?sessionId=...`). Clients that open the connection from a different origin (e.g. Smithery.ai auth/scan popup) resolved that path against their own origin and POSTed to the wrong host, resulting in "Initialization failed with status 404". The server now supports **`MCP_PUBLIC_URL`**. When set, the SSE transport sends the full message URL in the `endpoint` event so the client POSTs to the correct server.

### Added

- **`MCP_PUBLIC_URL`:** Optional public base URL of the MCP server. When set, the SSE transport advertises the full message endpoint URL in the `endpoint` event. Documented in `docs/configuration.md`.
- **`src/sse-transport.ts`:** `createSseTransport()` factory and `SseTransportWithFullUrl` subclass of the SDK's SSE transport; when `MCP_PUBLIC_URL` is set, the transport sends the full URL in the endpoint event.

## [0.5.0] - 2026-02-13

### Added

- **Prometheus metrics (prom-client):** Metrics are now produced with `prom-client`. REST API: `http_requests_total` (labels: method, route, status_code), `http_request_duration_seconds` histogram, `http_request_errors_total`, `cache_hits_total`, `cache_misses_total`, `subtitles_extraction_failures_total`. MCP HTTP server exposes `GET /metrics` and `GET /failures`; MCP metrics: `mcp_tool_calls_total`, `mcp_tool_errors_total` (by tool), `mcp_session_total` gauge (streamable/sse), `mcp_request_duration_seconds` histogram, plus `subtitles_extraction_failures_total`. Default label `service=api` or `service=mcp` for scraping both from one Prometheus.
- **Failures endpoint:** `GET /failures` (REST and MCP HTTP) returns JSON with the list of URLs where subtitle extraction failed (YouTube + Whisper both failed). Keeps last 100 entries per process in memory; only recorded when Whisper fallback is enabled and was attempted. Validation layer calls `recordSubtitlesFailure(url)` when no subtitles are found after Whisper attempt.
- **Monitoring documentation:** `docs/monitoring.md` — quick start with Docker Compose (Prometheus + Grafana), endpoints table (metrics, failures), full metric list for API and MCP, PromQL examples, and scrape config for custom Prometheus.
- **README:** Features section — link to [Monitoring](docs/monitoring.md) (Prometheus + Grafana, failed-extractions list).
- **docs/configuration.md:** Health and metrics — `GET /metrics` now references monitoring.md for full list; added `GET /failures` (JSON list of failed subtitle URLs).

### Changed

- **Metrics implementation:** `src/metrics.ts` rewritten to use `prom-client` (Registry, Counter, Histogram, Gauge). `renderPrometheus()` is async and returns `register.metrics()`. REST API: request recording uses `onRequest`/`onResponse` hooks with method, route, status_code, and duration; errors counted in onResponse when statusCode >= 400 (no longer in error handler). MCP core: each tool records success via `recordMcpToolCall(tool)` and errors via `recordMcpToolError(tool)`; MCP HTTP sets `setMetricsService('mcp')`, exposes `/metrics` and `/failures`, and updates session gauge for streamable/sse sessions.
- **docker-compose.example.yml:** Removed standalone `whisper` service from the example (simplified stack; Whisper can be run separately or via external URL).
- **Load tests:** `load/config.js` — BASE_URL can be overridden via env (e.g. `LOAD_BASE_URL`); pool index uses `Math.trunc(iter)` for clarity.

### Dependencies

- **Added:** `prom-client` ^15.1.3 for Prometheus metrics.

## [0.4.9] - 2026-02-13

### Added

- **`.env.local.example`:** Template for local overrides (COOKIES_FILE_PATH, WHISPER_API_KEY, CACHE_REDIS_URL, MCP_AUTH_TOKEN). Copy to `.env.local` and fill in; file is gitignored.
- **`docs/README.md`:** Links to `docs/caching.md` and `load/load-testing.md`.

### Changed

- **Documentation sync:** README, docker-compose.example.yml, .env.example, docs, and docker-hub-description.md aligned for consistency.
- **`.env.example`:** Added MCP vars (MCP_PORT, MCP_HOST, MCP_AUTH_TOKEN, MCP_ALLOWED_HOSTS, MCP_ALLOWED_ORIGINS), LOG_LEVEL, YT_DLP_SKIP_VERSION_CHECK, YT_DLP_REQUIRED.
- **`docker-compose.example.yml`:** Added SHUTDOWN_TIMEOUT; comments reference `.env.example`, `docs/configuration.md`, and `docs/caching.md`.
- **README.md:** Docker build for REST API now uses `-f Dockerfile --target api`.
- **`docs/quick-start.rest.md`:** Docker build command updated to use `-f Dockerfile --target api`.
- **`docs/configuration.md`:** Added `.env.local.example` usage for local overrides with sensitive values.
- **`docker-hub-description.md`:** Added Optional Redis cache to Features; env table extended with CACHE_*, MCP_RATE_LIMIT_*, MCP_SESSION_*, SHUTDOWN_TIMEOUT; reference to `docker-compose.example.yml` for full Whisper/COOKIES setup.

## [0.4.8] - 2026-02-13

### Fixed

- **yt-dlp cookies on read-only volume:** When `COOKIES_FILE_PATH` points to a read-only file (e.g. Docker volume mounted without write access), yt-dlp failed with `PermissionError` while saving cookies at exit, even when the download succeeded. The app now copies the cookies file to a writable temp location before passing it to yt-dlp; the temp file is removed after each call. New `ensureWritableCookiesFile()` in `youtube.ts` checks read/write access and returns either the original path or a temp copy. Used by `downloadSubtitles`, `downloadAudio`, and `fetchYtDlpJson`.

### Added

- **Unit tests:** `ensureWritableCookiesFile` — returns original path when writable; copies to temp and cleans up when read-only.

## [0.4.7] - 2026-02-13

### Added

- **CI (GitHub Actions):** `.github/workflows/ci.yml` runs on push/PR to `main`: `npm ci`, `make check-no-smoke` (format-check, lint, typecheck, test, build). On push to `main`, optional smoke job runs REST API smoke with `SMOKE_SKIP_MCP=1`. `.github/workflows/publish-docker.yml` runs on tag push `v*`: build and push REST API and MCP images to Docker Hub (multi-arch linux/amd64, linux/arm64). Requires `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets.
- **Readiness and metrics (REST API):** `GET /health/ready` — when `CACHE_MODE=redis`, pings Redis; returns 503 if Redis is unreachable (for Kubernetes readiness). `GET /metrics` — Prometheus text format with counters: `http_requests_total`, `http_request_errors_total`, `cache_hits_total`, `cache_misses_total`. New `src/metrics.ts`; validation layer records cache hit/miss; REST error handler and onResponse hook record errors and requests.
- **Cache:** `cache.ping()` in `src/cache.ts` for Redis liveness. Unit tests for `ping()` when cache off and when Redis URL unset.
- **Documentation:** README — repo/package name note (yt-captions-downloader vs transcriptor-mcp), Versioning subsection (version from package.json, tagging), Security section (do not commit or log `WHISPER_API_KEY`, `CACHE_REDIS_URL`, `MCP_AUTH_TOKEN`, cookies path; use env or secret manager). `docs/configuration.md` — Health and metrics (health, health/ready, metrics), Recommended values for production table. `docs/caching.md` — section “When Redis is unavailable” (graceful degradation: request still served via yt-dlp).
- **E2E smoke:** MCP streamable HTTP smoke now includes `checkMcpStreamableGetTranscript`: after initialize, calls `tools/call` for `get_transcript` and asserts content or structuredContent. `load/load-testing.md` — “Recommended thresholds for regression” (e.g. `http_req_failed` rate<0.05, p95<120s; `k6 run --throw` for CI).
- **Pre-commit (Husky):** `husky` devDependency and `prepare` script; `.husky/pre-commit` runs `npm run format-check && npm run lint`.
- **verify-pool script:** `npm run verify-pool` (and Make target) runs `load/verify-pool.js` to validate the k6 load-test video ID pool.

### Changed

- **Graceful shutdown:** REST API (`src/index.ts`) and MCP HTTP (`src/mcp-http.ts`) now call `closeCache()` after closing the server so the Redis connection is closed cleanly.
- **yt-dlp-check:** Fallback logger uses `console.warn` instead of `console.info` for the info-level message to satisfy the no-console lint rule.
- **Dependencies:** Bumped Fastify plugins (`@fastify/cors` ^11.2.0, `@fastify/multipart` ^9.4.0, `@fastify/rate-limit` ^10.3.0, `@fastify/swagger` ^9.7.0, `@fastify/swagger-ui` ^5.2.5, `@fastify/type-provider-typebox` ^6.1.0), `@sinclair/typebox` ^0.34.48, `ioredis` ^5.9.3. Dev: `@types/jest` ^30.0.0, `@types/node` ^25.2.3, `@typescript-eslint/*` and `typescript-eslint` ^8.55.0, `eslint` ^9.18.0, `jest` ^30.2.0, `prettier` ^3.8.1, `ts-jest` ^29.4.6, `typescript` ^5.9.3, `husky` ^9.1.7.

## [0.4.6] - 2026-02-13

### Added

- **Optional Redis cache:** Responses for subtitles, video info, available subtitles, and chapters can be cached in Redis to reduce repeated yt-dlp calls. Configure via env: `CACHE_MODE` (`off` or `redis`), `CACHE_REDIS_URL` (required when `redis`), `CACHE_TTL_SUBTITLES_SECONDS` (default 7 days for subtitles), `CACHE_TTL_METADATA_SECONDS` (default 1 hour for video info, available subtitles, chapters). New `src/cache.ts` with `getCacheConfig()`, `get()`, `set()`, `close()`. Both REST API and MCP use the cache when enabled. Documented in `docs/caching.md`, `docs/configuration.md`, and `.env.example`.
- **MCP uses validation layer:** MCP tools now call `validateAndDownloadSubtitles`, `validateAndFetchAvailableSubtitles`, `validateAndFetchVideoInfo`, and `validateAndFetchVideoChapters` instead of calling youtube/whisper directly, so MCP benefits from the same cache and validation as the REST API. Removed private `fetchSubtitlesContent` from `mcp-core.ts`; tools catch `ValidationError` and `NotFoundError` and return tool errors.
- **Unit tests:** `cache.test.ts` for `getCacheConfig` (mode, TTLs from env), get/set when `CACHE_MODE=off`, and `close()`. `validation.test.ts` mocks `./cache.js` so existing tests run with cache disabled. `mcp-core.test.ts` updated to mock validation’s validateAnd* and expect corresponding calls.

### Changed

- **Dependency:** Added `ioredis` for Redis cache backend (used only when `CACHE_MODE=redis`).

## [0.4.5] - 2026-02-13

### Added

- **REST/MCP error types:** `src/errors.ts` exports `HttpError`, `ValidationError`, and `NotFoundError` with status codes and error labels. Validation helpers throw these; REST global error handler maps them to 4xx/5xx and consistent JSON (`error`, `message`).
- **MCP HTTP auth module:** `src/mcp-auth.ts` provides `ensureAuth(request, reply, authToken)` and `getHeaderValue()`; MCP HTTP server uses them when `MCP_AUTH_TOKEN` is set. Token comparison is timing-safe to prevent timing attacks.
- **Unit tests:** `mcp-auth.test.ts` for `getHeaderValue` and `ensureAuth` (no auth, missing/ malformed Bearer, wrong token, correct token). `mcp-http.test.ts` for 401 on `/mcp` when auth required and no/ invalid header, and that `/health` remains allowed without auth when token is set.
- **Load testing:** `docs/load-testing.md` documents k6-based load tests for the REST API (health, subtitles, mixed). Make targets: `load-test`, `load-test-health`, `load-test-subtitles`, `load-test-mixed` (Docker k6); npm scripts: `load-test`, `load-test:subtitles`, `load-test:mixed`. Configurable via `LOAD_BASE_URL` / `BASE_URL` and `RATE_LIMIT_MAX` for throughput.

### Changed

- **MCP:** Shared logic for subtitle fetch and Whisper fallback is now in a private `fetchSubtitlesContent(resolved, log)` in `mcp-core.ts`. Tools `get_transcript` and `get_raw_subtitles` call it and only handle final processing (parse + paginate vs raw + paginate). Removes duplication of `resolveSubtitleArgs`, `downloadSubtitles`, and Whisper fallback between the two tools.
- **Docker: single Dockerfile with shared base.** One Dockerfile now builds both REST API and MCP images via multi-stage build. Stages: `builder` (Node, npm ci, build) → `base` (node, python3, pip, curl, unzip, ffmpeg, Deno, yt-dlp -U, YT_DLP_JS_RUNTIMES) → `api` (REST, port 3000) and `mcp` (MCP, port 4200). Build with `docker build -f Dockerfile --target api .` or `--target mcp .`. `Dockerfile.mcp` removed; Makefile targets `docker-build-api` and `docker-build-mcp` (and buildx variants) use the same Dockerfile with the appropriate target. README and `docs/quick-start.mcp.md` updated to use `--target api` / `--target mcp`.

### Security

- **MCP HTTP auth:** Bearer token validation uses `crypto.timingSafeEqual` so comparison time does not depend on the token value.

## [0.4.4] - 2026-02-13

### Changed

- **Chapters: single yt-dlp fetch.** `validateAndFetchVideoChapters` (REST `/video-info/chapters`) and MCP tool `get_video_chapters` now perform one yt-dlp network call instead of two. `fetchVideoChapters` in `youtube.ts` accepts an optional third argument `preFetchedData`; when provided, it reuses that data and skips the internal `fetchYtDlpJson` call. Validation and MCP handlers fetch once and pass the result into `fetchVideoChapters`, so video ID and chapters are derived from the same response.

### Added

- **Export:** `YtDlpVideoInfo` type is now exported from `youtube.ts` for callers that pass pre-fetched data into `fetchVideoChapters`.
- **Unit tests:** `youtube.test.ts` — `fetchVideoChapters` with `preFetchedData` (no execFile call, correct chapter mapping; null handling). `validation.test.ts` — `fetchYtDlpJson` called once and data passed to `fetchVideoChapters`; Vimeo test expects three-argument call. `mcp-core.test.ts` — chapters tool expectations updated for fetch order and three-argument `fetchVideoChapters` call.

## [0.4.3] - 2026-02-13

### Added

- **yt-dlp proxy (optional):** All yt-dlp requests (subtitle download, video info, chapters, audio for Whisper) can be routed through a proxy. Set `YT_DLP_PROXY` to a URL; supported schemes: `http://`, `https://`, `socks5://` (e.g. `http://user:password@proxy.example.com:8080`, `socks5://127.0.0.1:9050` for Tor). Documented in `docs/configuration.md` and `.env.example`; in Docker, set the variable in the container `environment` if needed.

### Changed

- **Unit tests:** `youtube.test.ts` — `getYtDlpEnv` and `appendYtDlpEnvArgs` now cover `YT_DLP_PROXY` / `proxyFromEnv` (trim, presence of `--proxy` in args, omission when unset).

## [0.4.2] - 2026-02-13

### Changed

- **MCP tools `get_transcript` and `get_raw_subtitles`:** Parameter `lang` is now optional. When omitted, subtitle download still uses `en` for yt-dlp; when Whisper fallback is used, language is auto-detected (no `language` query param sent to Whisper). Tool descriptions updated to mention optional `lang` and auto-detect behavior.

### Added

- **Unit tests:** `mcp-core.test.ts` — Whisper fallback with omitted `lang` (auto-detect). `whisper.test.ts` — no `language` param when `lang` is empty.

## [0.4.1] - 2026-02-12

### Added

- **yt-dlp cookies file logging:** When `COOKIES_FILE_PATH` is set, the app now logs cookies file status before each yt-dlp call (subtitle download, audio download, video info/chapters). Logs include path, existence, file size, or access error message (no cookie contents). Helps diagnose "Sign in to confirm you're not a bot" and other YouTube auth issues when running in Docker or with mounted cookies.

## [0.4.0] - 2026-02-12

### Changed

- **Project rename:** `yt-captions-downloader` → `transcriptor-mcp`. Package name, GitHub repo, Docker images, and docker-compose service names have been updated.
- **Package:** `transcriptor-mcp` (was `yt-captions-downloader-mcp`).
- **GitHub:** `samson-art/transcriptor-mcp`.
- **Docker images:** `artsamsonov/transcriptor-mcp` (MCP), `artsamsonov/transcriptor-mcp-api` (REST API).
- **docker-compose services:** `transcriptor-mcp` (MCP), `transcriptor-mcp-api` (REST API).
- **MCP server name:** `transcriptor-mcp` (reported in MCP initialize).
- **User-Agent:** `transcriptor-mcp` (for yt-dlp requests).
- **MCP config key:** Use `transcriptor` in `claude_desktop_config.json` / Cursor MCP settings (shorter UX).

## [0.3.8] - 2026-02-12

### Added

- **Multi-platform support:** Subtitles, available subtitles, video info, and chapters work with URLs from YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, and Dailymotion (via yt-dlp). Bare video IDs are supported for YouTube only.
- **Whisper fallback:** When YouTube subtitles cannot be obtained (yt-dlp returns none), the app can transcribe video audio via Whisper. Configurable with `WHISPER_MODE` (`off`, `local`, `api`). Local mode uses a self-hosted HTTP service (e.g. [whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice) in Docker); API mode uses an OpenAI-compatible transcription endpoint. New env vars: `WHISPER_BASE_URL`, `WHISPER_TIMEOUT`, `WHISPER_API_KEY`, `WHISPER_API_BASE_URL`. REST responses for `/subtitles` and `/subtitles/raw` include optional `source: "youtube" | "whisper"`; MCP tools `get_transcript` and `get_raw_subtitles` use the same fallback and expose `source` in structured content.
- **Audio download:** `downloadAudio(videoId, logger)` in `youtube.ts` downloads audio-only via yt-dlp for Whisper input; uses same cookies and timeout as subtitle download.
- **Docker:** `docker-compose.example.yml` adds a `whisper` service (image `onerahmet/openai-whisper-asr-webservice:latest`) and example `WHISPER_*` env for `transcriptor-mcp-api` and `transcriptor-mcp`. `.env.example` and `docs/configuration.md` document all Whisper options.
- **Unit tests:** `src/whisper.test.ts` for `getWhisperConfig` and `transcribeWithWhisper`; `validation.test.ts` extended with Whisper fallback success and 404 when Whisper returns null.
- **yt-dlp startup check:** REST API, MCP HTTP, and MCP stdio servers run a yt-dlp availability check at startup. If yt-dlp is missing or fails to run, the app logs an ERROR and exits (unless `YT_DLP_REQUIRED=0`). If the installed version is older than the latest on GitHub, a WARNING is logged.
- **Environment variables:** `YT_DLP_SKIP_VERSION_CHECK` — when set to `1`, skips the GitHub version check and WARNING; `YT_DLP_REQUIRED` — when set to `0`, logs ERROR but does not exit when yt-dlp is missing or fails.
- **Unit tests:** `src/yt-dlp-check.test.ts` for version parsing, comparison, GitHub fetch, and startup check behavior.

### Changed

- `docs/configuration.md`: Documented `YT_DLP_SKIP_VERSION_CHECK` and `YT_DLP_REQUIRED`; startup checks reference `src/yt-dlp-check.ts`. Added "Whisper fallback" section for all `WHISPER_*` variables and usage (local container vs API).

## [0.3.7] - 2026-02-11

### Added

- **REST API:** `GET /health` endpoint returning `{ "status": "ok" }` for liveness/readiness and Docker `HEALTHCHECK`.
- **REST API:** Optional CORS allowlist via `CORS_ALLOWED_ORIGINS` (comma-separated origins); when unset, all origins remain allowed.
- **MCP HTTP server:** Rate limiting configurable via `MCP_RATE_LIMIT_MAX` and `MCP_RATE_LIMIT_TIME_WINDOW`.
- **MCP HTTP server:** Session TTL and periodic cleanup via `MCP_SESSION_TTL_MS` and `MCP_SESSION_CLEANUP_INTERVAL_MS`.
- **Version:** `src/version.ts` reads version from `package.json`; REST API and MCP server use it for responses and server info.
- **E2E smoke test:** MCP coverage — starts MCP container and verifies stdio (initialize over stdin/stdout), streamable HTTP (`POST /mcp`), and SSE (`GET /sse`). New env vars: `SMOKE_SKIP_MCP`, `SMOKE_MCP_IMAGE`, `SMOKE_MCP_URL` / `SMOKE_MCP_PORT`, `SMOKE_MCP_AUTH_TOKEN`, plus API-related overrides.
- **Docs:** `docs/configuration.md` — CORS, MCP rate limit/session/cleanup, health endpoint, and E2E smoke test env vars. `.env.example` updated with `CORS_ALLOWED_ORIGINS` and MCP HTTP options.

### Changed

- REST API and MCP server now derive version from `package.json` instead of hardcoded values.
- REST API: global Fastify error handler returns 500 with `error` and `message`; route handlers no longer wrap in try/catch so validation/parsing errors are handled consistently.
- E2E smoke test flow: single entry `npm run test:e2e:api` with optional MCP checks; README updated with env var table and simplified run instructions.
- `docker-compose.example.yml`: reordered keys (ports after environment), added `restart: unless-stopped` for MCP service; API service no longer includes `build` (image-only).
- Jest: exclude `src/e2e/api-smoke.ts` from coverage (top-level await).

## [0.3.6] - 2026-02-05

### Changed

- Upgraded Fastify to v5 and related plugins (`@fastify/cors`, `@fastify/multipart`, `@fastify/rate-limit`, `@fastify/swagger`, `@fastify/swagger-ui`, `@fastify/type-provider-typebox`) to compatible major versions.
- Bumped `@modelcontextprotocol/sdk` to ^1.26.0.

## [0.3.5] - 2026-02-04

### Added

- OpenAPI/Swagger documentation at `/docs` with request/response schemas for all REST endpoints (subtitles, raw subtitles, available subtitles, video info, chapters).
- E2E smoke test now verifies that Swagger UI at `/docs` is reachable.

### Changed

- REST routes registered with `@fastify/swagger` and `@fastify/swagger-ui`; each endpoint documents body and response schemas for generated OpenAPI spec.

## [0.3.4] - 2026-02-04

### Added

- Docker-based e2e smoke test for the REST API (`src/e2e/api-smoke.ts`) that builds a local image, starts a container and verifies `POST /subtitles` against a real YouTube video.
- Documentation in `README` for running Docker smoke tests locally and as part of the `make publish` workflow.
- Additional unit tests for validation helpers and yt-dlp integration (URL / video ID / language sanitization, video info and chapter extraction, environment-driven yt-dlp flags).
- Dedicated test suite for MCP tools (`src/mcp-core.test.ts`) covering success and error paths for transcripts, raw subtitles, available subtitles, video info and chapters.

### Changed

- Hardened `validation.ts` helpers to provide more explicit 4xx errors for invalid URLs, video IDs and language codes across subtitles, available subtitles, video info and chapters endpoints.
- Improved `youtube.ts` helpers to map more yt-dlp metadata, expose chapter markers, and sort official vs auto subtitle language codes for stable output.
- Refined MCP core implementation to use stricter validation and add pagination/error handling tests for all tools.
- Updated Jest configuration to collect coverage from `src`, exclude entrypoints (REST + MCP) and enable verbose output.

## [0.3.3] - 2026-02-04

### Added

- New `/subtitles/available` REST endpoint that returns the video ID and sorted lists of official vs auto-generated subtitle language codes.
- Validation helper `validateAndFetchAvailableSubtitles` for safely extracting and sanitizing YouTube video IDs before fetching available subtitles.
- Unit test `fetchAvailableSubtitles.test.ts` covering `fetchAvailableSubtitles` behavior (official vs auto subtitles).
- Documentation for using the MCP server as an n8n MCP client over streamable HTTP, including guidance on `N8N_PROXY_HOPS`.

### Changed

- Production `Dockerfile` now installs Deno as a JS runtime for `yt-dlp`, updates `yt-dlp` to the latest stable release, and configures `YT_DLP_JS_RUNTIMES="deno,node"`.
- MCP core now imports Zod via `zod/v3` to improve JSON Schema compatibility with strict MCP clients (such as n8n).
- Jest configuration adds a `moduleNameMapper` rule to map `.js` imports back to TypeScript sources under NodeNext/ESM.
- Updated API documentation in `README` to cover the new `/subtitles/available` endpoint with request/response examples.
- Updated `.gitignore` to also ignore `Makefile`.

## [0.3.1] - 2026-02-03

### Added

- MCP server over HTTP transports:
  - Streamable HTTP endpoint at `/mcp` (`src/mcp-http.ts`)
  - SSE endpoint at `/sse` with message handler at `/message` (`src/mcp-http.ts`)
- Optional auth for HTTP MCP via `MCP_AUTH_TOKEN` (Bearer token)
- Optional SSE allowlists via `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS`
- Extracted reusable MCP server core into `src/mcp-core.ts`
- New script: `start:mcp:http`

### Changed

- Updated `docker-compose.example.yml` MCP service to run HTTP mode and expose port `4200`
- Updated `Dockerfile.mcp` to expose `4200` for HTTP mode
- Streamlined `src/mcp.ts` to be stdio-only entrypoint
- Bumped package version to `0.3.1`

## [0.3.0] - 2026-02-03

### Added

- MCP server (Cursor) over stdio (`src/mcp.ts`) with tools:
  - `get_transcript` (plain text transcript, paginated)
  - `get_raw_subtitles` (raw SRT/VTT, paginated)
  - `get_available_subtitles` (official vs auto language codes)
  - `get_video_info` (basic metadata via yt-dlp)
- Docker image for MCP server (`Dockerfile.mcp`)
- `docker-compose.example.yml` with an additional MCP service example
- `REPOSITORY_OVERVIEW.md` project overview document

### Changed

- Switched project to ESM:
  - `package.json` now uses `"type": "module"`
  - TypeScript config updated to `module/moduleResolution: nodenext`
  - Local imports updated to use `.js` extensions for NodeNext compatibility
- Added MCP-related scripts:
  - `start:mcp`, `dev:mcp`
- yt-dlp integration extended with:
  - `fetchVideoInfo`
  - `fetchAvailableSubtitles`
  - shared handling for yt-dlp env flags (`--cookies`, `--js-runtimes`, `--remote-components`)
- Jest config renamed to `jest.config.cjs`

### Security

- Added `cookies.txt` to `.gitignore` to avoid accidental commits of sensitive cookies

## [0.2.0] - 2026-01-29

### Added

- Docker Compose configuration for easier container orchestration and deployment
- Cookie support for accessing age-restricted or region-locked YouTube videos
- `COOKIES_FILE_PATH` environment variable for persistent cookie file management
- `@fastify/multipart` dependency for handling file uploads in cookie requests
- Comprehensive cookie handling with proper sanitization and temporary file management

### Changed

- Refactored API routes in `src/index.ts` for improved code organization
- Updated README with detailed cookie usage examples and new environment variables
- Simplified validation logic by removing redundant cookie validation code
- Enhanced subtitle download function to support optional cookie parameters

### Removed

- Health check endpoint from Dockerfile (moved to application-level routing)

## [0.1.0] - 2025-12-27

### Added

- API for downloading subtitles from YouTube videos
- Support for official and auto-generated subtitles
- Support for multiple subtitle languages
- `/api/subtitles` endpoint for retrieving cleaned subtitles (plain text)
- `/api/subtitles/raw` endpoint for retrieving raw subtitles with timestamps
- Support for SRT and VTT formats
- `/health` endpoint for server health checks
- Input data validation using TypeBox schema validation
- Error handling with clear error messages
- Docker image for application deployment
- CORS support for cross-origin requests
- Request and error logging
- TypeScript for type safety
- Rate limiting with configurable limits and time windows
- Graceful shutdown handling (SIGTERM, SIGINT)
- Unhandled promise rejection and uncaught exception handlers
- Configurable yt-dlp command timeout via environment variables
- Configurable shutdown timeout via environment variables
- Jest testing framework with test coverage
- Unit tests for YouTube subtitle functionality
- Unit tests for request validation
