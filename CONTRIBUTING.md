# Contributing

Setup, scripts and layout are in the README, under **Self-host → Development**. You need Node.js 22, `yt-dlp` on your `PATH`, and `ffmpeg` for frames.

## The cycle

Every change goes through the same steps, whether a person or a coding agent does the work.

1. **Intent.** Open an issue with the **Change proposal** template. Describe the problem, the outcome and the acceptance criteria, not the implementation. Skip this step for a change you can describe in one sentence that touches none of the areas listed under "When to run the full cycle" in [AGENTS.md](AGENTS.md).
2. **Plan.** Write it in the pull request description, using the template: files that change, order of work, risks.
3. **Test first.** For a bug, first add a test that fails for the reported reason and note its failing output. Then fix the code without editing that test, and commit both together. For a feature, write tests for the acceptance criteria.
4. **Checks.** Run `make check-no-smoke` (format, lint, typecheck, tests, build). The pre-commit hook runs it too, so do not skip it with `--no-verify`.
5. **Pull request.** Fill in **Verified** (what you ran and what it showed) and **Not verified** (what you could not run, and why).
6. **Review.** The maintainer reviews against the acceptance criteria in the issue. The maintainer also cuts releases.

## Decisions

[docs/adr/](docs/adr/) records decisions that are easy to undo by accident. Read the relevant ADR before you change the code it names. If your change makes or reverses a decision, add or update an ADR in the same pull request.

## Coding agents

[AGENTS.md](AGENTS.md) is the shared context for every agent. Claude Code reads it through [CLAUDE.md](CLAUDE.md). Claude Code also loads:

- the skills in [.claude/skills/](.claude/skills/): `change` (this cycle), `release` and `grilling` (the interview behind step 1);
- the hooks in [.claude/settings.json](.claude/settings.json).

With another agent, point it at `.claude/skills/change/SKILL.md` and let it follow that file.

## Never commit

Cookies, `.env` files, tokens, keys, or anything `.gitignore` covers. The pre-commit hook refuses staged files that `.gitignore` matches, even ones added with `git add -f`.
