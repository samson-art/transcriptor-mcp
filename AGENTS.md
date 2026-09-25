# AGENTS.md

Shared context for every coding agent and contributor. Only facts you cannot infer from the code are here. The process lives in [CONTRIBUTING.md](CONTRIBUTING.md) and in `.claude/skills/`. Decisions live in [docs/adr/](docs/adr/).

transcriptor-mcp is an MCP server (8 tools, 4 widgets) and a REST API that wrap `yt-dlp` to fetch transcripts, metadata and frames from YouTube and 10 other platforms. It is TypeScript, ESM, Node 22 and Jest.

## Commands

- `npm ci` installs dependencies and the husky pre-commit hook.
- `make check-no-smoke` is **the gate**: format-check, lint, typecheck, Jest, build. CI, pre-commit and the publish workflow all run it. It must be green before you say you are done.
- `npx jest src/youtube.test.ts -t '<name>'` runs one suite or one test.
- `npm run build` runs `tsc` to `dist/`, then four vite builds to `dist/ui/<app>.html`. The server reads those HTML files at runtime.
- To run locally: `npm run build`, then `npm run start:mcp` (stdio), `start:mcp:http` (port 4200) or `start` (REST, port 3000). You need `yt-dlp` on `PATH`, `ffmpeg` for frames, and `ffprobe` for `WHISPER_MAX_DURATION_SECONDS`. The `dev`, `dev:mcp` and `dev:mcp:http` scripts currently fail: `ts-node-dev` cannot load this ESM package.
- `node .claude/hooks/guards.check.mjs` self-checks the agent hooks. It needs `gh` and network access.

## Map

- `src/mcp-core.ts`: the whole MCP surface (tools, prompts, resources, widget resources and CSP, `withToolErrorHandling`, the per-call log line).
- `src/mcp.ts` is the stdio entry. `src/mcp-http.ts` is stateless Streamable HTTP ([ADR 001](docs/adr/001-stateless-streamable-http.md)). `src/index.ts` is the REST API (5 of the 8 tools).
- `src/validation.ts`: the service layer shared by MCP and REST (URL and language checks, cache, auto-discovery in the original language, Whisper fallback, in-flight dedupe).
- `src/youtube.ts`: the `yt-dlp`/`ffmpeg` runs, failure classification, cookies copies. The startup `yt-dlp --version` check lives in `src/yt-dlp-check.ts`.
- `src/errors.ts` (typed errors and caller texts), `src/subtitle-rate-limit.ts` (429 hold), `src/canary.ts`, `src/metrics.ts`, `src/cache.ts` (optional Redis), `src/whisper*.ts`.
- `ui/`: React widgets. `web/`: static site. `legal/`: public terms. `load/`: k6 scripts.

**Generated — don't edit by hand:** `dist/` (it also holds stale outputs of deleted modules, so don't grep it for current code), `dist-site/`, `web/widgets-demo/snapshots/*.html` (recapture them in a browser), `package-lock.json` apart from the two version fields at release.

## When to run the full cycle

Use the `change` skill (interview → intent issue → plan → test first → checks → PR → review) when a change touches any of these:

- **MCP tool contract:** tool names, input/output schemas, descriptions, annotations, `_meta`, error texts and shapes (`src/mcp-core.ts`, `src/errors.ts`, `LANG_PATTERN` and `ALLOWED_VIDEO_DOMAINS` in `src/validation.ts`). Mirrors that must follow: `src/e2e/mcp-smoke.ts`, `web/clients.mjs`, the README tool reference, `ui/`.
- **Env vars:** added, changed or removed.
- **Caption rate limit, retry, cache or strike logic:** `src/subtitle-rate-limit.ts`, `execFileAsync` and `downloadSubtitles` in `src/youtube.ts`, auto-discovery in `src/validation.ts`, `src/cache.ts`, `src/canary.ts`.
- **Release plumbing:** `Dockerfile`, `server.json`, `.github/workflows/`, Makefile publish targets.
- **Metrics names/labels, or the fields of the "MCP tool call" log line.**
- **Widgets:** `ui/`, `vite.config.ts`, the widget CSP and `ui://` URIs.

Anything else that fits in one sentence: edit, run the gate, open the PR.

## Rules that are easy to break

- **Caption requests are a quota per outbound IP.** Limits last hours to a day. Every extra caption request (a retry, another track, a probe, a metadata run in front of the track) prolongs a limit. Don't add retries or fan-out on the caption path. See [ADR 002](docs/adr/002-caption-rate-limit-hold.md) and [ADR 003](docs/adr/003-caption-request-budget.md).
- **Tracks come through yt-dlp only**, never fetched from Node ([ADR 005](docs/adr/005-captions-via-yt-dlp-only.md)).
- **Every `yt-dlp`/`ffmpeg` run that reaches a platform goes through `execFileAsync` in `src/youtube.ts`.** It enforces the process cap and queue and throws `ServerBusyError` (503) above them. Two exceptions are deliberate. The local `ffprobe` length probe skips the queue, because a full queue made short videos read as "too long" (1.5.0). The startup `yt-dlp --version` check in `src/yt-dlp-check.ts` has its own `execFileAsync`.
- **Never hand yt-dlp `COOKIES_FILE_PATH` itself.** Pass a copy from `copyCookiesFile` ([ADR 004](docs/adr/004-private-cookies-copy.md)).
- **yt-dlp exit codes lie both ways.** With `--ignore-no-formats-error` it exits 0 on private or removed videos. Exit 101 at `--max-downloads` is a normal playlist end. In a `try/finally` that deletes a temp dir, use `return await`.
- **Infra failures are not "no subtitles".** `bot_check`, `rate_limited`, `timeout` and `extractor` become 502. They must not trigger Whisper.
- **Caller-facing error texts** reach users verbatim through MCP and REST. Never put in a command line, stderr, a cookies path, a proxy URL, an env var name, a route, or the words yt-dlp, ffmpeg, Whisper or Redis. Each text names exactly one next step. `src/errors.test.ts` checks part of this.
- **MCP schemas import `z` from `'zod/v3'`.** The installed zod is v4, and its JSON Schema breaks strict clients.
- **stdout is JSON-RPC in stdio mode.** Log to stderr. `createLoggerWithSentryBreadcrumbs` writes to stdout, so never give it to the stdio server.
- **Relative imports in `src/` end in `.js`** (nodenext). `ui/` imports have no extension.
- **HTTP MCP is stateless.** A new `McpServer` is built per request, so shared state lives at module level. The process has no auth.
- **External contracts:** metric names and labels, the per-call log line fields, cache key shapes, `ui://` URIs and the widget CSP (declared under both `ui.csp` and `openai/widgetCSP`). Changing any of them silently breaks dashboards, alerts, analytics, cached entries or the published ChatGPT app. Never log raw URLs in the per-call line.
- **Widgets must not assume YouTube.** Take the page from the result: `url`, or `webpageUrl` for `get_video_info`. Never build it from a YouTube id.
- **`ui/` and `web/` are outside tsc, eslint and prettier.** Only `ui/shared/*.test.ts` runs in Jest, so verify widget changes by hand.
- **`legal/*.md` says "provided on request"** for the provider's address and tax ID. Never add a name, address or tax ID.
- **Real YouTube, real production.** `make check`, `make smoke`, `npm run test:e2e:*` and the load tests call real YouTube from your IP. `make publish*` and `gh workflow run publish-docker.yml` push `:latest`, and the hosted deployment auto-pulls it: that is a production deploy.

## Conventions

- Tests sit next to their module. `youtube.test.ts` mocks `node:child_process` and never spawns yt-dlp. Module state has exported reset helpers for tests.
- A behaviour change comes with tests and a mutation drill: break the code, show which named test fails, and report "N of N" in the PR.
- Read env vars at call time (`process.env` or `parseIntEnv`), not at import. A new, changed or removed env var goes into `.env.example`, the README env table if operators need it, and the CHANGELOG.
- Throw the typed `HttpError` subclasses from `src/errors.ts`. Concurrent identical work is deduplicated with a `Map<key, Promise>` that is cleared in `finally`.
- Comments explain why, with dated measurements. Mark a deliberate shortcut with a `ponytail:` comment that names its ceiling.
- New text is in English. Commit subjects are plain imperative sentences about the behaviour change, without conventional-commit prefixes.
- Landing page (`web/`): fewer blocks. Detail goes to the README.

## Decisions

Read the ADR before you change the code it names. If you make or reverse a decision, add or update an ADR in the same PR.

- [001](docs/adr/001-stateless-streamable-http.md): stateless Streamable HTTP in-process; auth and edge limits outside.
- [002](docs/adr/002-caption-rate-limit-hold.md): process-local hold after a caption 429; only a delivered track resets strikes.
- [003](docs/adr/003-caption-request-budget.md): the canary stands down while real traffic works (its two-track ladder is superseded by 006).
- [004](docs/adr/004-private-cookies-copy.md): a private 0600 cookies copy for every yt-dlp call.
- [005](docs/adr/005-captions-via-yt-dlp-only.md): caption tracks through yt-dlp only.
- [006](docs/adr/006-original-language-without-lang.md): an omitted `lang` means the video's original language: one track request, or the track list.

## Autonomy

- **Go ahead:** read, edit, run the gate and unit tests, build, create branches, commit, push a branch, open a draft PR.
- **Ask first:**
  - merging;
  - tagging;
  - anything that pushes an image or runs the publish workflow;
  - bulk calls to real platforms (smoke, e2e, load);
  - creating issues (show the draft first);
  - editing CI, `Dockerfile` or `server.json` outside a planned change.
- **Never:**
  - `git add -f` or `git commit --no-verify`;
  - committing anything `.gitignore` covers (cookies, `.env`, tokens);
  - putting production hostnames, IPs, machine names or dashboards into a public file, issue or PR.

In Claude Code, hooks in `.claude/settings.json` enforce the secrets rules, and they refuse a `v*` tag whose merge commit does not contain the whole PR. Other agents: check both by hand.

## Pull requests and releases

- Branch as `fix/<X.Y.Z>-<slug>` or `feat/<X.Y.Z>-<slug>`, where X.Y.Z is the next version after the newest tag. Docs and chore branches (`chore/<slug>`) do not bump the version.
- Use `.github/pull_request_template.md`. Keep the PR in draft while review fixes are still coming, so it is not merged without them.
- Releases are cut by the maintainer with the `release` skill. A PR that changes shipped behaviour is one release. Tag pushes deploy production.

Public intents go to issues in this repo. Intents that need production details go to a private tracker the maintainer owns. Contributors always use public issues.
