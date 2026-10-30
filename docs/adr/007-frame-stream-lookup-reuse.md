# 007. A frame call reuses the stream lookup of the same URL and width for 5 minutes, in process memory only

- Status: Accepted
- Date: 2026-10-30
- Sources: issue #87 and the pull request that closes it

## Context

`get_video_frame` ran one stream lookup for each call. The lookup is one yt-dlp run that prints the video id, the length and the direct stream URLs (`fetchVideoStreamInfo`). Then ffmpeg reads one frame from a stream URL. The stream URLs stay valid for hours.

Clients take many frames from one video in a row. The production logs of the week 2026-10-23 to 2026-10-29 show this:

- About 7,800 frame calls came in. 87% of them were for a video that the server looked up in the previous 10 minutes.
- Eight videos got 42% of the frame calls. For seven of them, the median gap between two frames was 0.4 to 0.7 s.
- Frame calls used 42% of all tool time. A successful frame from YouTube took 5.5 s (median). The lookup was about 2.9 s of that.
- The six largest runs of frames lasted from 6 minutes to 3.4 hours.
- YouTube answered "Video unavailable" 137 times for a video that was not removed. It rate-limited the session about 90 times. 232 frame calls got 503 `busy`, because the process queue was full.

## Decision

In `src/youtube.ts`, `captureVideoFrame` gets its lookup from `lookupStreamInfo`:

- The key is the format selector and the URL. The width changes the format selector, so another width gets its own lookup.
- `streamLookups`, a map in process memory, keeps a lookup for 5 minutes from its start (`STREAM_LOOKUP_TTL_MS`). Calls that come while the lookup runs wait for it.
- A failed lookup leaves the map at once.
- `captureVideoFrame` drops the lookup when none of its streams gave a frame, or when it had no stream. Then the call takes the section download as before, with no second lookup.
- A drop removes a lookup only while the map still holds that lookup (`dropStreamLookup`). So a late failure of an old lookup does not remove a newer one.
- `cache_hits_total{kind="stream"}` counts a reused lookup. `cache_misses_total{kind="stream"}` counts a lookup run.
- A restart empties the map.

## Alternatives

- No reuse, as before this change: one lookup for each frame.
- Redis, the shared cache of the other kinds. The stream URLs are signed for the address of the server that asked. In a shared store, they reach servers with other addresses, and those servers cannot use them.
- A longer time than 5 minutes. With 5 minutes, a run of frames already sends one lookup every 5 minutes instead of one for each frame. A longer time saves only a few more lookups. It also keeps a lookup longer after the video changed, for example after it became private, or after the exit address of the proxy changed.
- One more lookup, without the map, after a failed read. The maintainer rejected it: the section download already exists, and a second run adds load on the platform.
- A field in the per-call log line instead of the metric. The maintainer chose the metric.

## Consequences

- A run of frames from one video sends one lookup to the platform every 5 minutes for each width. The direct read still goes to the media servers of the platform for every frame.
- TikTok and Bilibili answer a direct read with 403. So their lookup is dropped after each call, and each call still runs a lookup, as before.
- A shared lookup runs with the budget, the cookies copy and the logger of the call that started it. Its failure reaches every call that waits on it. A waiting call does not wait longer than its own budget, because the first call started earlier.
- A reused lookup ran with the cookies copy of an earlier call. The call that started the lookup waits for it before it deletes its copy. No run gets the original file, so ADR 004 holds.
- A frame call can still get a frame for up to 5 minutes after a video becomes private or is removed. This needs stream URLs that still work.
- This is not the caption path. The goal is the same as in [ADR 003](003-caption-request-budget.md): fewer requests from one address. ADR 002, 003, 005 and 006 do not change.
- A sum of `cache_hits_total` or `cache_misses_total` over all kinds now includes `stream`. To keep the old total, leave out `kind="stream"`.
- The usual in-flight map is cleared in `finally`. This map keeps a successful lookup for 5 minutes on purpose. A failure leaves at once.
- The map has no size cap. It holds the URL and width pairs of the last 5 minutes. Expired entries leave the map at the next lookup that runs.

## Do not

- Do not move the lookups to Redis or to `src/cache.ts`. The URLs are signed for this server.
- Do not key by the URL alone. Another width needs another format.
- Do not keep a failed lookup, or a lookup whose streams gave no frame.
- Do not add a second lookup inside the call. The section download is the fallback.
- Do not drop a lookup by its key alone. Then a late failure of an old lookup removes the newer lookup, and the next call runs one more lookup.
- Do not clear a successful lookup in `finally`. The reuse is the point of the map.
- Guarded by the `stream lookup reuse` tests in `src/youtube.test.ts`:
  - runs one lookup for frames of one video and width, and counts a miss, then hits
  - lets frames that run at the same time wait for one lookup
  - runs a new lookup 5 minutes after the last one started
  - runs a lookup of its own for another width
  - keeps no failed or empty lookup
  - drops a reused lookup whose stream gives no frame, and takes the section download without a new lookup
  - does not let a late read failure drop a newer lookup
