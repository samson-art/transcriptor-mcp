@AGENTS.md

## Claude Code

- Skills in `.claude/skills/`: `change` (the cycle for triggered changes), `release` (maintainer only), `grilling` (the interview behind `change`), `simple-english` (all prose, see the writing rule in AGENTS.md). In interviews, ask through the AskUserQuestion tool, with the recommended option first.
- Hooks in `.claude/settings.json` run on every Bash call. They read the real git options, not the text of messages:
  - `guard-secrets` refuses forced `git add` and `git update-index --add`, and commits of gitignored or key files. It also refuses commits that skip the pre-commit checks (`--no-verify`/`-n`, `HUSKY=0`, `core.hooksPath` changes, `GIT_CONFIG_*`, one-off aliases). It refuses a commit in a checkout that has no pre-commit hook: run `npm ci` there first.
  - `guard-release` checks every `v*` tag that a command creates or pushes (`git tag`, `git push`, `gh release create`). The tag must name the merge commit of a merged PR by its sha. That commit must contain the head of the PR and the branch tips, local and remote. If GitHub or origin does not answer, the hook refuses. `publish-docker.yml` runs the same check on every tag push.

  If a hook blocks you, fix the cause. Do not reword the command to get past it.
- `/code-review` reads this file, not a `REVIEW.md`. Run it with the PR number as the target (`/code-review <PR number>`). A bare `/code-review` reviews only unpushed changes. Put the acceptance criteria from the intent issue in the chat before you run it, not after the command.
