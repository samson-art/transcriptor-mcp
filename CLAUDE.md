@AGENTS.md

## Claude Code

- Skills in `.claude/skills/`: `change` (the cycle for triggered changes), `release` (maintainer only), `grilling` (the interview behind `change`), `simple-english` (all prose, see the writing rule in AGENTS.md). In interviews, ask through the AskUserQuestion tool, with the recommended option first.
- Hooks in `.claude/settings.json` run on every Bash call. They read the real git options, not the text of messages:
  - `guard-secrets` refuses forced `git add` and commits of gitignored or key files. It also refuses commits that skip the pre-commit checks (`--no-verify`/`-n`, `HUSKY=0`, `core.hooksPath` overrides).
  - `guard-release` refuses a `v*` tag or `gh release create` unless the target is the merge commit of a merged PR. That commit must also contain the head of that PR and the branch tips, local and remote.

  If a hook blocks you, fix the cause. Do not reword the command to get past it.
- `/code-review` reads this file, not a `REVIEW.md`. Give it the acceptance criteria from the intent issue.
