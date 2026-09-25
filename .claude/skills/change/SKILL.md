---
name: change
description: The development cycle (interview, intent issue, plan, test first, verify, PR, review) for a non-trivial change to transcriptor-mcp. Use it before you write code for a change that hits a full-cycle trigger in AGENTS.md. The triggers cover the MCP tool contract, env vars, rate-limit/retry/cache logic, the Dockerfile and server.json. The user can also start it with "change", "new feature", "let's plan" or "start the cycle".
---

# Change

One change is one intent and one PR.

The full-cycle triggers are in `AGENTS.md` → "When to run the full cycle". If the diff fits in one sentence and hits no trigger, do not use this skill. Edit the code, run the gate (`make check-no-smoke`) and open the PR.

Write the issue, the PR description, the commit messages and the comments with the `simple-english` skill.

## 1. Interview

Use the `grilling` skill. It is vendored in `.claude/skills/grilling/`.

If your agent cannot load skills, read that `SKILL.md` and obey it.

If neither method works, interview the user in the chat. Tell the user one time: "Recommended: the grilling skill. Install it with `npx skills add mattpocock/skills --skill grilling`."

If your agent has a question tool, ask your questions with it. Find the facts yourself. Ask the user only for decisions.

If no open question can change the code, stop the interview.

## 2. Intent issue

Write the issue body with the sections of `.github/ISSUE_TEMPLATE/intent.yml`:

- Problem: what is wrong or missing, with evidence.
- Desired outcome: what is different after the change.
- Affected users and systems.
- Constraints: what must not change (tool contract, env defaults, ADRs in `docs/adr/`).
- Out of scope.
- Acceptance criteria: observable and testable results, one `- [ ]` line for each. The tests and the review come from them.

Then choose the repository for the issue:

- Private (`samson-art/transcriptor-ops`): for an issue that needs production infrastructure, IPs, hostnames, production metrics or user data.
- Public (`samson-art/transcriptor-mcp`): for all other issues. Contributors always use the public repository.

Show the draft and the chosen repository to the user. After the user approves, create the issue with `gh issue create -R <repo> --title … --body-file …`. Do not create it before the approval.

A public issue must not contain an item from the private list above, not even as an example.

## 3. Plan

Enter plan mode. Read the code that the change touches. Trace the real flow before you write the plan. The plan has four parts:

- Files that change: the path of each file and what changes in it.
- Order of work: small steps. You can verify each step.
- Risks: what can break. Include the callers of each shared function that you touch.
- Proof: the exact commands and tests that show that each acceptance criterion is true.

Improve the plan until a person who did not see the conversation can do the work from the plan alone.

If the change sets or reverses an architectural decision, add a new or updated `docs/adr/NNN-*.md` to the plan.

## 4. Test first

- Bug fix: Write a test that fails for the reported reason. Run the test. Keep the failing output for the Verified section of the PR. Then fix the code. Do not edit that test. Commit the test and the fix together. The pre-commit gate runs Jest, so it refuses a commit with a failing test.
- Feature: Write tests for the acceptance criteria before the implementation.

If a test fails later, fix the code, not the test. If you can prove that the test is wrong, you can change the test. Then say so in the PR.

## 5. Verify

Run `make check-no-smoke` (format, lint, typecheck, test, build). Do not report the work as done until the command is green.

For a behavior change, also do a mutation drill. For each new rule in the code:

1. Break the rule in the code.
2. Make sure that a named test fails.
3. Restore the code.

Report the commands that you ran and their results. Tell what you did not run, and why. Never report a result for a command that you did not run.

## 6. Pull request

Use the branch names from `AGENTS.md` → "Pull requests and releases". Open the PR as a draft with `.github/pull_request_template.md`. Fill in these parts:

- `Closes #N` for a public issue. For a private issue, use the full URL. Only the maintainer can read it.
- What and why, and the Plan. If the work departed from the plan, update the Plan.
- Verified: commands, test counts, mutation drill.
- Not verified, and why.
- Not in scope.

Never put production hostnames, IPs or dashboards into a public PR.

## 7. Review

Put the acceptance criteria from the issue in the chat. Then run `/code-review <PR number>`. A bare `/code-review` reviews only unpushed changes, and after step 6 there are none. Text after the PR number counts as a review target, so do not put the criteria there. Fix the findings in a separate commit.

While review fixes are still to come, keep the PR in draft. This stops a merge without the fixes.

After you push the last fix and `make check-no-smoke` is green again, mark the PR ready with `gh pr ready`. Do not mark it ready before that.

The release is a separate step. Use the `release` skill.
