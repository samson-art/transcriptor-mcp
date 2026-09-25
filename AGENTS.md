# AGENTS.md

Shared context for every coding agent and contributor. This file holds only the facts that you cannot infer from the code. The process is in [CONTRIBUTING.md](CONTRIBUTING.md) and in `.claude/skills/`. The decisions are in [docs/adr/](docs/adr/).

transcriptor-mcp is an MCP server (8 tools, 4 widgets) and a REST API. Both wrap `yt-dlp` to fetch transcripts, metadata and frames from YouTube and 10 other platforms. It is TypeScript, ESM, Node 22 and Jest.

## Commands

- `npm ci` installs dependencies and the husky pre-commit hook.
- `make check-no-smoke` is the gate: format-check, lint, typecheck, Jest, build. CI, pre-commit and the publish workflow all run it. It must be green before you say you are done.
- `npx jest src/youtube.test.ts -t '<name>'` runs one suite or one test.
- `npm run build` runs `tsc` to `dist/`, then four vite builds to `dist/ui/<app>.html`. The server reads those HTML files at runtime.
- To run locally: `npm run build`, then `npm run start:mcp` (stdio), `start:mcp:http` (port 4200) or `start` (REST, port 3000). You need `yt-dlp` on `PATH`, `ffmpeg` for frames, and `ffprobe` for `WHISPER_MAX_DURATION_SECONDS`. The `dev`, `dev:mcp` and `dev:mcp:http` scripts currently fail: `ts-node-dev` cannot load this ESM package.
- `node .claude/hooks/guards.check.mjs` self-checks the agent hooks. It needs `gh` and network access.

## Map

- `src/mcp-core.ts`: the whole MCP surface (tools, prompts, resources, widget resources and CSP, `withToolErrorHandling`, the per-call log line).
- `src/mcp.ts` is the stdio entry. `src/mcp-http.ts` is stateless Streamable HTTP ([ADR 001](docs/adr/001-stateless-streamable-http.md)). `src/index.ts` is the REST API (5 of the 8 tools).
- `src/validation.ts`: the service layer shared by MCP and REST (URL and language checks, cache, auto-discovery ladder, Whisper fallback, in-flight dedupe).
- `src/youtube.ts`: the `yt-dlp`/`ffmpeg` runs, failure classification, cookies copies. The startup `yt-dlp --version` check is in `src/yt-dlp-check.ts`.
- `src/errors.ts` (typed errors and caller texts), `src/subtitle-rate-limit.ts` (429 hold), `src/canary.ts`, `src/metrics.ts`, `src/cache.ts` (optional Redis), `src/whisper*.ts`.
- `ui/`: React widgets. `web/`: static site. `legal/`: public terms. `load/`: k6 scripts.

Do not edit generated files by hand. They are `dist/`, `dist-site/`, `web/widgets-demo/snapshots/*.html` and `package-lock.json`. The exception is the two version fields in `package-lock.json` at release. To change the snapshots, recapture them in a browser. `dist/` also holds stale outputs of deleted modules, so do not grep it for current code.

## When to run the full cycle

The `change` skill runs the full cycle: interview → intent issue → plan → test first → checks → PR → review. If a change touches any of these areas, use it:

- MCP tool contract: tool names, input/output schemas, descriptions, annotations, `_meta`, error texts and shapes. The code is in `src/mcp-core.ts`, `src/errors.ts`, and `LANG_PATTERN` and `ALLOWED_VIDEO_DOMAINS` in `src/validation.ts`. Mirrors that must follow: `src/e2e/mcp-smoke.ts`, `web/clients.mjs`, the README tool reference, `ui/`.
- Env vars: added, changed or removed.
- Caption rate limit, retry, cache or strike logic: `src/subtitle-rate-limit.ts`, `execFileAsync` and `downloadSubtitles` in `src/youtube.ts`, the ladder in `src/validation.ts`, `src/cache.ts`, `src/canary.ts`.
- Release plumbing: `Dockerfile`, `server.json`, `.github/workflows/`, Makefile publish targets.
- Metrics names or labels, or the fields of the "MCP tool call" log line.
- Widgets: `ui/`, `vite.config.ts`, the widget CSP and `ui://` URIs.

For anything else that fits in one sentence, edit, run the gate and open the PR.

## Rules that are easy to break

- Caption requests use a quota per outbound IP. Limits last from hours to a day. Every extra caption request (a retry, another track, a probe, a metadata run in front of the track) makes a limit last longer. Do not add retries or fan-out on the caption path. See [ADR 002](docs/adr/002-caption-rate-limit-hold.md) and [ADR 003](docs/adr/003-caption-request-budget.md).
- Tracks come through yt-dlp only. Node never fetches them ([ADR 005](docs/adr/005-captions-via-yt-dlp-only.md)).
- Every `yt-dlp`/`ffmpeg` run that reaches a platform goes through `execFileAsync` in `src/youtube.ts`. It enforces the process cap and queue, and it throws `ServerBusyError` (503) above them. Two exceptions are deliberate. The local `ffprobe` length probe skips the queue, because a full queue made short videos read as "too long" (1.5.0). The startup `yt-dlp --version` check in `src/yt-dlp-check.ts` has its own `execFileAsync`.
- Never give `COOKIES_FILE_PATH` itself to yt-dlp. Pass a copy from `copyCookiesFile` ([ADR 004](docs/adr/004-private-cookies-copy.md)).
- yt-dlp exit codes are not reliable in either direction. With `--ignore-no-formats-error`, it exits 0 on private or removed videos. Exit 101 at `--max-downloads` is a normal playlist end. In a `try/finally` that deletes a temp dir, use `return await`.
- Infra failures are not "no subtitles". `bot_check`, `rate_limited`, `timeout` and `extractor` become 502. They must not start Whisper.
- Caller-facing error texts reach users verbatim through MCP and REST. Never put these items in them: a command line, stderr, a cookies path, a proxy URL, an env var name or a route. Never put the words yt-dlp, ffmpeg, Whisper or Redis in them. Each text names exactly one next step. `src/errors.test.ts` checks part of this.
- MCP schemas import `z` from `'zod/v3'`. The installed zod is v4, and its JSON Schema breaks strict clients.
- stdout is JSON-RPC in stdio mode. Log to stderr. `createLoggerWithSentryBreadcrumbs` writes to stdout, so never give it to the stdio server.
- Relative imports in `src/` end in `.js` (nodenext). `ui/` imports have no extension.
- HTTP MCP is stateless. The server builds a new `McpServer` for each request, so shared state lives at module level. The process has no auth.
- External contracts: metric names and labels, the per-call log line fields, cache key shapes, `ui://` URIs and the widget CSP. The widget CSP is in both `ui.csp` and `openai/widgetCSP`. A change to any of them silently breaks dashboards, alerts, analytics, cached entries or the published ChatGPT app. Never log raw URLs in the per-call line.
- Widgets must not assume YouTube. Take the page from the result: `url`, or `webpageUrl` for `get_video_info`. Never build it from a YouTube id.
- `ui/` and `web/` are outside tsc, eslint and prettier. Only `ui/shared/*.test.ts` runs in Jest, so check widget changes by hand.
- `legal/*.md` says "provided on request" for the address and the tax ID of the provider. Never add a name, address or tax ID.
- Some commands use real YouTube or real production. `make check`, `make smoke`, `npm run test:e2e:*` and the load tests call real YouTube from your IP. `make publish*` and `gh workflow run publish-docker.yml` push `:latest`. The hosted deployment auto-pulls `:latest`, so these commands are a production deploy.

## Conventions

- Tests are next to their module. `youtube.test.ts` mocks `node:child_process` and never spawns yt-dlp. Each module with state exports reset helpers for tests.
- A behavior change comes with tests and a mutation drill. Break the code, show which named test fails, and report "N of N" in the PR.
- Read env vars at call time (`process.env` or `parseIntEnv`), not at import. A new, changed or removed env var goes into `.env.example` and the CHANGELOG. If operators need it, it also goes into the README env table.
- Throw the typed `HttpError` subclasses from `src/errors.ts`. To deduplicate concurrent identical work, use a `Map<key, Promise>` and clear it in `finally`.
- Comments explain why, with dated measurements. Mark a deliberate shortcut with a `ponytail:` comment that names its ceiling.
- Writing rule: write all prose in English with the `simple-english` skill (`.claude/skills/simple-english/SKILL.md`, default Plain mode). This covers docs (README, AGENTS.md, CONTRIBUTING.md, `docs/`, skills), CHANGELOG entries, issue and PR descriptions and commit messages. It also covers code comments, and review and issue comments. If your agent cannot load skills, read that file before you write.
- Commit subjects are plain imperative sentences about the behavior change, without conventional-commit prefixes.
- Landing page (`web/`): use fewer blocks. Put detail in the README.

## Decisions

Read the ADR before you change the code it names. If you make or reverse a decision, add or update an ADR in the same PR.

- [001](docs/adr/001-stateless-streamable-http.md): stateless Streamable HTTP in-process. Auth and edge limits are outside.
- [002](docs/adr/002-caption-rate-limit-hold.md): process-local hold after a caption 429. Only a delivered track resets strikes.
- [003](docs/adr/003-caption-request-budget.md): at most two ranked tracks per auto-discovery. The canary stands down while real traffic works.
- [004](docs/adr/004-private-cookies-copy.md): a private 0600 cookies copy for every yt-dlp call.
- [005](docs/adr/005-captions-via-yt-dlp-only.md): caption tracks through yt-dlp only.

## Autonomy

- Go ahead: read, edit, run the gate and unit tests, build, create branches, commit, push a branch, open a draft PR.
- Ask first:
  - Merging.
  - Tagging.
  - Anything that pushes an image or runs the publish workflow.
  - Bulk calls to real platforms (smoke, e2e, load).
  - Creating issues. Show the draft first.
  - Editing CI, `Dockerfile` or `server.json` outside a planned change.
- Never:
  - `git add -f` or `git commit --no-verify`.
  - Committing anything that `.gitignore` covers (cookies, `.env`, tokens).
  - Putting production hostnames, IPs, machine names or dashboards into a public file, issue or PR.

In Claude Code, hooks in `.claude/settings.json` enforce the secrets rules. They also refuse a `v*` tag whose merge commit does not contain the whole PR. With other agents, check both by hand.

## Pull requests and releases

- Name the branch `fix/<X.Y.Z>-<slug>` or `feat/<X.Y.Z>-<slug>`, where X.Y.Z is the next version after the newest tag. Docs and chore branches (`chore/<slug>`) do not bump the version.
- Use `.github/pull_request_template.md`. Keep the PR in draft while review fixes are still to come, so that nobody merges it without them.
- The maintainer cuts releases with the `release` skill. A PR that changes shipped behavior is one release. Tag pushes deploy production.

Public intents go to issues in this repo. Intents that need production details go to a private tracker that the maintainer owns. Contributors always use public issues.
