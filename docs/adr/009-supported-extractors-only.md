# 009. Each yt-dlp run loads only the extractors of the 11 supported platforms

- Status: Accepted
- Date: 2026-11-27
- Sources: this PR, CHANGELOG (Unreleased)

## Context

The server compares the caller URL with `ALLOWED_VIDEO_DOMAINS` (`isValidSupportedUrl` in `src/validation.ts`). Before this decision, yt-dlp then ran with all of its extractors, about 1,800 in yt-dlp 2026.03.13. An extractor of a supported site can hand the run to another extractor and another URL. Reddit does this for a link post (`url_transparent`). The generic extractor reads any web page. So the allowlist covered only the first URL of a run, not the hosts that the run reached after it.

yt-dlp has an option for this: `--use-extractors`. It loads only the extractors whose names match the given regexes. A hand-off to an extractor that is not loaded stops with "No suitable extractor … found for URL" (`YoutubeDL.extract_info`, checked in yt-dlp 2026.03.13).

## Decision

- `appendYtDlpEnvArgs` in `src/youtube.ts` adds `--use-extractors SUPPORTED_EXTRACTORS` to every yt-dlp run. All yt-dlp runs that reach a platform build their arguments through it.
- `SUPPORTED_EXTRACTORS` names the extractor families of the 11 platforms: `youtube`, `twitter`, `instagram`, `tiktok`, `twitch`, `vimeo`, `facebook`, `bilibili`, `vk`, `dailymotion`, `reddit` (each with its sub-extractors), and `vm.tiktok`.
- The option comes after `YT_DLP_EXTRA_ARGS`. yt-dlp takes the last value, so an operator cannot widen the list by mistake.
- `fb.watch`, `fb.com` and `v.redd.it` left `ALLOWED_VIDEO_DOMAINS`. In yt-dlp only the generic extractor opens them (offline `suitable()` test, 2026-11-27).
- The failure class `unavailable` now covers "No suitable extractor". The caller hears that the URL points to a page that this server cannot read, and not to retry.

## Alternatives

- `default,-generic`: only the generic extractor goes. Rejected: other extractors also take a host from the URL, so the list still reaches unknown hosts.
- Resolve `fb.watch`, `fb.com` and `v.redd.it` in Node and pass the final URL to yt-dlp. Not now: it adds a request and code for links that few callers use. The `host` field of the per-call log line shows how often they come.
- Name each extractor instead of families. Rejected: yt-dlp adds sub-extractors often, and a family regex keeps them.

## Consequences

- A post on a supported site that points to a video on another site (for example Imgur or Streamable) fails as `unavailable`.
- Short links on `fb.watch`, `fb.com` and `v.redd.it` fail validation. Callers must use the full facebook.com or reddit.com link.
- A new platform needs three changes together: `ALLOWED_VIDEO_DOMAINS`, `extractPlatformFromUrl` and `SUPPORTED_EXTRACTORS`. A test fails when a domain maps to no family.
- If yt-dlp renames a family, that platform fails as `unavailable` until the list follows.

## Do not

- Do not add `generic`, `default` or `all` to `SUPPORTED_EXTRACTORS`, and do not add an extractor that takes its host from the URL.
- Do not move the option before `YT_DLP_EXTRA_ARGS`, and do not start a yt-dlp run without `appendYtDlpEnvArgs`.
- Guarded by `src/youtube.test.ts` ("supported extractors only (ADR 009)") and `src/validation.test.ts` ("refuses short links that only the generic extractor opens").
