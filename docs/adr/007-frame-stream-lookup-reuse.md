# 007. A frame call reuses the stream lookup of the same URL and width for 5 minutes, in process memory only

- Status: Accepted
- Date: 2026-10-30
- Sources: issue #87, PR #96

## Context

`get_video_frame` ran one stream lookup for each call. The lookup is one yt-dlp run that prints the video id, the length, the chosen format and the direct stream URLs (`fetchVideoStreamInfo`). Then ffmpeg reads one frame from a stream URL. The stream URLs stay valid for hours.

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
- `captureVideoFrame` drops the lookup when none of its streams gave a frame, or when it had no stream. Then the call takes the section download as before, with no second lookup. The section download is a yt-dlp download of a clip of about 2 s from the timestamp, and ffmpeg takes the first frame of that clip.
- Two answers keep the lookup, because they say nothing about the stream URLs. The first is a direct read that the server refuses before ffmpeg starts: 503 `busy`, or no budget left. The budget is the one time limit of a frame call (`YT_DLP_FRAME_TIMEOUT`). The second is the answer "timestamp beyond the duration".
- If the section download fails with a known class of the video (`private`, `unavailable`, `geo_blocked`, `age_restricted`) and leaves no clip, the call throws that class. A call that reuses a lookup runs no lookup of its own, so only this run can name the class. The caller gets the exact text instead of the general text about the video stream. This also applies to a call that ran a fresh lookup.
- A call makes its cookies copy only when it runs yt-dlp. A lookup hit whose direct read gives a frame makes no copy.
- A drop removes a lookup only while the map still holds that lookup (`dropStreamLookup`). So a late failure of an old lookup does not remove a newer one.
- `captureVideoFrame` and `downloadVideoSection` add a random part to the names of the frame file and the clip. Calls that wait on one lookup resume together. With names from the URL and the millisecond alone, two calls got one file.
- `cache_hits_total{kind="stream"}` counts a reused lookup. `cache_misses_total{kind="stream"}` counts a lookup that the server starts, or tries to start. A lookup that the server refuses with 503 `busy`, or that runs out of time before it starts, also counts as a miss.
- A restart empties the map.

## Alternatives

- No reuse, as before this change: one lookup for each frame.
- Redis, the shared cache of the other kinds. The stream URLs are signed for the address of the server that asked. In a shared store, they reach servers with other addresses, and those servers cannot use them.
- A longer time than 5 minutes. With 5 minutes, a run of frames already sends one lookup every 5 minutes instead of one for each frame. A longer time saves only a few more lookups. It also keeps a lookup longer after the video changed, for example after it became private, or after the exit address of the proxy changed.
- One more lookup, without the map, after a failed read. The maintainer rejected it: the section download already exists, and a second run adds load on the platform.
- A field in the per-call log line instead of the metric. The maintainer chose the metric.

## Consequences

- A run of frames from one video sends one lookup to the platform every 5 minutes for each width. The direct read still goes to the media servers of the platform for every frame.
- TikTok and Bilibili answer a direct read with 403. So the first call that reads drops their lookup, and the next call runs a new lookup. Calls that wait on one lookup take the section download together. Each call has its own frame file and clip, so these calls never share a file.
- A shared lookup runs with the budget, the cookies copy and the logger of the call that started it. Its failure reaches every call that waits on it. With a budget, a waiting call does not wait longer than with a lookup of its own. The shared lookup has an earlier place in the process queue, and its budget ends earlier. With a budget of 0, this bound does not exist: a stalled lookup holds every call that waits on it, and new calls join it until its 5 minutes end. The wait for a place in the queue has no timer, so a call can wait past its own budget, as before this change.
- A reused lookup ran with the cookies copy of an earlier call. The call that started the lookup waits for it before it deletes its copy. No run gets the original file, so ADR 004 holds.
- A frame call can still get a frame for up to 5 minutes after a video becomes private or is removed. This needs stream URLs that still work. When they stop working, the section download gives the exact class.
- This is not the caption path. The goal is the same as in [ADR 003](003-caption-request-budget.md): fewer requests from one address. ADR 002, 003, 005 and 006 do not change.
- A sum of `cache_hits_total` or `cache_misses_total` over all kinds now includes `stream`. To keep the old total, leave out `kind="stream"`.
- The usual in-flight map is cleared in `finally`. This map keeps a successful lookup for 5 minutes on purpose. A failure leaves at once.
- The map has no size cap. It holds the URL and width pairs of the last 5 minutes. Expired entries leave the map at the next miss.

## Do not

- Do not move the lookups to Redis or to `src/cache.ts`. The URLs are signed for this server.
- Do not key by the URL alone. Another width needs another format.
- Do not keep a failed lookup, or a lookup whose streams gave no frame. The two answers that the Decision names as keeping the lookup are the only exceptions.
- Do not add a second lookup inside the call. The section download is the fallback.
- Do not drop a lookup by its key alone. Then a late failure of an old lookup removes the newer lookup, and the next call runs one more lookup.
- Do not clear a successful lookup in `finally`. The reuse is the point of the map.
- Do not name the frame file or the clip by the URL and the millisecond alone. Calls that share a lookup take the section download in the same millisecond.
- Guarded by the `stream lookup reuse` tests in `src/youtube.test.ts`, for example `runs one lookup for frames of one video and width, and counts a miss, then hits`, `counts the 5 minutes from the start of a lookup, not from its end`, `removes an expired lookup of another video at the next miss`, `keeps a lookup when the server refuses a direct read before ffmpeg starts` and `does not let a late read failure drop a newer lookup`.
