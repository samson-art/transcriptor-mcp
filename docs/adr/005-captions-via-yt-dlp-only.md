# 005. Caption tracks are downloaded by yt-dlp only, never fetched from Node

- **Status:** Accepted
- **Date:** 2026-09-24 (1.5.8)
- **Sources:** PR #43 (de1dcf5, a560bbd), PR #31, #37, #38, commit 64079b5, CHANGELOG 1.4.0, 1.5.2, 1.5.3, 1.5.8

## Context

1.4.0 (PR #31) fetched a listed track by its own URL from Node. The direct fetch took 0.2–0.44 s, against 4–7 s for a yt-dlp run. 1.4.0 kept yt-dlp as the fallback. Two day-long YouTube 429 episodes followed (ADR 002).

1.5.2 copied yt-dlp's User-Agent, Accept and Accept-Language onto the direct fetch. That did not make the two clients match. undici adds its own `Sec-Fetch-Mode`, the TLS fingerprint stays Node's, and the fetch sent no cookies.

From 1.5.2 a direct 429 held the whole platform, yt-dlp included. On 2026-09-24 the direct fetch was refused several times in a few hours. Eight minutes after one refusal, a yt-dlp run with the server's cookies downloaded the same track (PR #43). The reason why the platform treats the two clients differently is not proven.

## Decision

- `downloadSubtitles` in `src/youtube.ts` runs only yt-dlp, with the server's cookies.
- The browser impersonation comes from yt-dlp, not from a server flag. Its YouTube extractor marks each caption track `impersonate: true`, and yt-dlp uses `curl_cffi` for it. The Docker image must keep `yt-dlp[default,curl-cffi]`, and the publish workflow checks that impersonation targets exist.
- The explicit `type`/`lang` path does not run the metadata JSON before the track. For YouTube the id comes from the URL. For other platforms the JSON run comes after the track.
- `subtitle_requests_total` keeps its `path` label, now always `yt_dlp`, so dashboards and queries keep working.

## Alternatives

- **Direct fetch with a yt-dlp fallback** (1.4.0–1.5.7). Rejected: the platform refused the Node client while yt-dlp got the same track.
- **Header parity only** (1.5.2). Rejected: the TLS fingerprint and the missing cookies still set the client apart.
- **Keep the metadata run in front of the track** to warm caches. Rejected in the PR #43 review (a560bbd): that run only paid for itself while it produced the track URL.

## Consequences

- The track step costs a yt-dlp run instead of 0.2–0.44 s. On the explicit path the total barely changes, because a JSON run used to stand in front of the fast fetch. Auto-discovery with a cold track list pays the full 4–7 s more.
- The caption endpoint sees one client identity.

## Don't

- Do not fetch `subtitles[lang][].url` or `automatic_captions[lang][].url` from Node, however free the latency win looks. The same entry says `impersonate: true`, so yt-dlp does not read it with a plain client either.
- Do not put the JSON run back in front of the track, or delete the constant `path` label as dead code.
- Guarded by `src/youtube.test.ts` ("never fetches a listed track itself").
