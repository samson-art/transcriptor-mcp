# Contributing

Setup, scripts and layout are in the README, under "Self-host → Development". You need Node.js 22, `yt-dlp` on your `PATH`, and `ffmpeg` for frames.

## The cycle

A person and a coding agent use the same steps for every change.

1. Intent. Open an issue with the "Change proposal" template. Describe the problem, the outcome and the acceptance criteria, not the implementation. You can skip this step for a change that you can describe in one sentence. That change must touch none of the areas under "When to run the full cycle" in [AGENTS.md](AGENTS.md).
2. Plan. Write the plan in the pull request description, with the template: files that change, order of work, risks.
3. Test first. For a bug, first add a test that fails for the reported reason, and note its failing output. Then fix the code without a change to that test, and commit both together. For a feature, write tests for the acceptance criteria.
4. Checks. Run `make check-no-smoke` (format, lint, typecheck, tests, build). The pre-commit hook also runs it, so do not skip it with `--no-verify`.
5. Pull request. Fill in "Verified" (what you ran and what it showed) and "Not verified" (what you were not able to run, and why).
6. Review. The maintainer reviews against the acceptance criteria in the issue. The maintainer also cuts releases.

## Decisions

[docs/adr/](docs/adr/) records decisions that are easy to undo by accident. Read the related ADR before you change the code it names. If your change makes or reverses a decision, add or update an ADR in the same pull request.

## Coding agents

[AGENTS.md](AGENTS.md) is the shared context for every agent. Claude Code reads it through [CLAUDE.md](CLAUDE.md). Claude Code also loads these items:

- The skills in [.claude/skills/](.claude/skills/): `change` (this cycle), `release` and `grilling` (the interview behind step 1).
- The hooks in [.claude/settings.json](.claude/settings.json).

With another agent, point it at `.claude/skills/change/SKILL.md` and let it follow that file.

## Writing

Write docs, CHANGELOG entries, issues, pull requests, commit messages and comments in plain English. Use the rules in [.claude/skills/simple-english/SKILL.md](.claude/skills/simple-english/SKILL.md): short sentences, active voice, one word for one meaning.

## Never commit

Never commit cookies, `.env` files, tokens, keys, or anything that `.gitignore` covers. The pre-commit hook refuses staged files that `.gitignore` matches, including files that you added with `git add -f`. The hook runs only in a checkout where `npm ci` ran, so run `npm ci` in every clone and every git worktree. CI checks the repo again on every push and pull request.
