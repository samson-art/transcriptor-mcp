---
name: change
description: The development cycle for a non-trivial change to transcriptor-mcp — interview, intent issue, plan, test first, checks, PR, review. Use it before writing code whenever a change hits one of the full-cycle triggers in AGENTS.md (MCP tool contract, env vars, rate-limit/retry/cache logic, Dockerfile or server.json), or when the user says "change", "new feature", "let's plan", "start the cycle".
---

# Change

One change = one intent = one PR. Skip this skill when the diff fits in one sentence and hits no trigger from `AGENTS.md` → "When to run the full cycle"; then just edit, run the checks and open the PR.

## 1. Interview

Use the `grilling` skill (vendored in `.claude/skills/grilling/`). If your agent cannot load skills, read that `SKILL.md` and follow it. If neither works, interview in the chat and tell the user once: "Recommended: the grilling skill — `npx skills add mattpocock/skills --skill grilling`."

Ask through the question tool when your agent has one. Look facts up yourself; ask the user only for decisions. Stop when no open question would change the code.

## 2. Intent issue

Write the issue body with the sections of `.github/ISSUE_TEMPLATE/intent.yml`:

- **Problem** — what is wrong or missing, with evidence.
- **Desired outcome** — what is different afterwards.
- **Affected users and systems.**
- **Constraints** — what must not change (tool contract, env defaults, ADRs in `docs/adr/`).
- **Out of scope.**
- **Acceptance criteria** — observable and checkable, one checkbox each. These drive the tests and the review.

Then choose where it lives:

- **Private** (`samson-art/transcriptor-ops`) if it needs production infrastructure, IPs, hostnames, production metrics or user data.
- **Public** (`samson-art/transcriptor-mcp`) otherwise. Contributors always use public.

Show the user the draft and the chosen repo. Create it (`gh issue create -R <repo> --title … --body-file …`) only after they approve. A public issue must not contain anything from the private list above, even as an example.

## 3. Plan

Enter plan mode. Read the code the change touches and trace the real flow before planning. The plan has four parts:

- **Files that change** — path and what changes there.
- **Order of work** — small steps, each one verifiable.
- **Risks** — what could break, including callers of any shared function you touch.
- **Proof** — the exact commands and tests that show each acceptance criterion holds.

Iterate until someone who never saw the conversation could do the work from the plan alone. If the change sets or reverses an architectural decision, the plan includes a new or updated `docs/adr/NNN-*.md`.

## 4. Test first

- **Bug fix:** write a test that fails for the reported reason, run it and keep the failing output for the PR's **Verified** section, then fix the code without editing that test. Commit the test and the fix together: the pre-commit gate runs Jest, so a commit with a failing test is refused.
- **Feature:** write tests for the acceptance criteria before the implementation.

If a test fails later, fix the code, not the test, unless the test is provably wrong — then say so in the PR.

## 5. Verify

Run `make check-no-smoke` (format, lint, typecheck, test, build). Do not report the work as done until it is green. For a behaviour change, also run a mutation drill: break each new rule in the code, confirm that a named test fails, then restore the code. Report what you ran and the result. Say explicitly what you did not run and why. Never claim a check you did not run.

## 6. Pull request

Branch names are in `AGENTS.md` → "Pull requests and releases". Open the PR as a draft with `.github/pull_request_template.md`:

- `Closes #N` for a public issue, or the full URL for a private one (it stays readable only to the maintainer);
- **What and why**, and the **Plan**, updated if the work departed from it;
- **Verified**: commands, test counts, mutation drill;
- **Not verified**, and why;
- **Not in scope**.

Never put production hostnames, IPs or dashboards into a public PR.

## 7. Review

Run `/code-review` on the branch. Give it the acceptance criteria from the issue: "Review against these acceptance criteria: …". Fix what it finds in a separate commit.

While review fixes are still coming, keep the PR in draft so it is not merged without them. Mark it ready (`gh pr ready`) only after the last fix is pushed and `make check-no-smoke` is green again.

Releasing is a separate step: the `release` skill.
