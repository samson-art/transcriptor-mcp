# 004. Every yt-dlp call gets its own 0600 copy of the cookies file, and yt-dlp never gets the original

- Status: Accepted
- Date: 2026-09-24 (1.5.7)
- Sources: PR #42 (8da3450, 7692f58), CHANGELOG 1.5.7

## Context

When yt-dlp exits, it rewrites the cookies file it was given: it truncates the file, then writes. Before 1.5.7, the code passed a writable cookies file as is. It made a copy only after a failed access check.

One run was killed during that write, by the 10 MB output cap on the JSON of a video with 21 dubbed audio tracks. It left the shared file empty. Every later run refused the file as not a Netscape cookies file. The cache hid the outage for a while, and Sentry did not see it, because the failure classified as `unknown`.

## Decision

- `copyCookiesFile` in `src/youtube.ts` always writes a new temp copy with mode 0600, whether the original is writable or not.
- Each tool function that passes `--cookies` makes one copy per call and deletes it in `finally`. `get_video_frame` and `get_playlist_transcripts` share their copy between their two yt-dlp runs.
- The server never passes the original to yt-dlp. The example compose file mounts `cookies.txt` read-only.
- `fetchYtDlpJson`'s output cap is 50 MB, and the server logs JSON over 10 MB. `searchVideos` keeps 10 MB.

## Alternatives

- Copy only a file that is not writable (before 1.5.7). This caused the empty-file outage.
- Configuration only: mount the file read-only and keep the old code, which then copies every time. This leaves every writable mount exposed (inferred: PR #42 does not say so).
- One shared temp copy per process. A single killed run empties it for every later run.
- Keep the 10 MB cap. JSON size grows with the number of dubbed audio tracks, not with video length.

## Consequences

- Each call pays one small file copy.
- The server throws away cookie updates that yt-dlp writes back. A stale session needs a manual re-export of the original.
- The copy holds a signed-in session, so the 0600 mode matters on a shared tmpdir.

## Do not

- Do not "skip the copy for a writable file" or drop `mode: 0o600`. If you do, `src/youtube.test.ts` ("should never hand yt-dlp the original cookies file") fails.
- Every new yt-dlp call site that passes `--cookies` must use `copyCookiesFile`. Only the `fetchYtDlpJson` call site has its own test. The other call sites have no guard.
