---
name: release
description: Maintainer-only release of transcriptor-mcp (version bump and CHANGELOG in the PR, merge, ancestry check, tag, publish watch, post-release check). The tag deploys production. Run it only on a request for a release from the maintainer.
disable-model-invocation: true
---

# Release

A tag push deploys production. CI publishes `:X.Y.Z` and `:latest`. Then the hosted deployment pulls `:latest` on its own.

Before each step that merges, tags or pushes, get an explicit go-ahead from the maintainer in this session.

Only a PR that changes shipped behavior is a release. Docs, legal and chore PRs merge without a version.

## 1. In the PR, before merge

1. Version: Set X.Y.Z to the next version after the newest tag (`git tag --sort=-v:refname | head -1`). Never set a lower version. The number in the branch name is only a guess. The tag decides.
2. Bump the version in four places:
   - `package.json` `version`
   - `package-lock.json` (the two top-level version fields)
   - `server.json` `version`
   - `server.json` `packages[0].identifier` (the image tag)
3. CHANGELOG: Write it with the `simple-english` skill.
   - Move the entries into `## [X.Y.Z] - YYYY-MM-DD`. The date is the tag date. If the tag slips a day, correct the date.
   - Keep `## [Unreleased]` empty at the top.
   - Use Keep a Changelog subsections (Added, Changed, Fixed, Security). Start each entry with a short sentence that says what changed, without bold. Write it for operators and callers, and give the measured numbers.
   - Name new, changed or removed env vars. Each of them must also be in `.env.example`. If operators set them, they must also be in the README env table.
4. PR title and body: The title is `X.Y.Z: <one sentence>`. In the body, add an After merge section. It lists the post-deploy checks that show that the change works.
5. Ready to merge: A PR is ready to merge with these three conditions:
   - The gate is green on the last commit.
   - Every review fix is pushed.
   - The PR is out of draft.

## 2. Merge and check ancestry

1. The maintainer merges with a merge commit, not a squash. If the maintainer asks you to merge, use `gh pr merge N --merge`.
2. Pull the merge commit:
   ```bash
   git switch main
   git pull --ff-only
   ```
3. Prove that the merge contains the whole PR. This includes fixes that someone pushed after a click on Merge:
   ```bash
   gh pr view N --json headRefOid,headRefName
   git merge-base --is-ancestor <headRefOid> <merge sha>
   git merge-base --is-ancestor origin/<headRefName> <merge sha>   # if the branch still exists
   ```
   Never read "already merged" as "merged with my latest push". If a commit is missing, open a follow-up PR and release that PR instead. In Claude Code, the `guard-release` hook does this check again at tag time.

## 3. Tag and watch the publish

```bash
git tag -a vX.Y.Z -m vX.Y.Z <merge sha>
git push origin vX.Y.Z
```

Then watch the run for this tag, not the newest run. Right after the push, the run for this tag can be missing, because GitHub did not create it yet. A tag-push run has the tag as its branch. Do the list command again until it returns an id:

```bash
gh run list --workflow publish-docker.yml --branch vX.Y.Z --limit 1 --json databaseId -q '.[0].databaseId'
gh run watch <id> --exit-status
```

`publish-docker.yml` runs the gate, builds the image, checks the `curl_cffi` impersonation targets and runs the MCP smoke test. Then it pushes both images and publishes `server.json` to the MCP Registry.

The practice is tags only. Do not create a GitHub Release unless the maintainer asks for one.

If two versions merged back-to-back, tag each merge commit. Nobody tagged 1.5.3, so it has no image and no registry entry.

## 4. After the deploy

1. Run the After merge checks of the PR.
2. Schedule a one-off check about two hours after the tag. Fill in this self-contained prompt. Then schedule it with the scheduled-tasks tool (`fireAt`, local time):

   > Work in <the repository root: the output of `git rev-parse --show-toplevel` at the time you schedule this>. Use the transcriptor-prod-analytics skill to answer "did vX.Y.Z help?". Compare the window since <tag time, UTC> with a window of the same length before it. Look mainly at <what the release was meant to change>. Report in Russian: what changed, in numbers. If you find a regression or an unmet goal, draft an intent issue for each one. Each draft has these sections: Problem, Desired outcome, Constraints, Acceptance criteria. Mark each draft public (samson-art/transcriptor-mcp) or private (samson-art/transcriptor-ops). A draft that needs production hosts, IPs, prod metrics or user data is private. Do not create issues. List the drafts for the maintainer.

   The task must be a local task on the machine of the maintainer. The analytics skill gets to production through access that a cloud session does not have. Scheduled tasks run while the Claude app is open, or at its next launch.
3. The weekly production report is a standing local task (`transcriptor-weekly-prod-report`). If `list_scheduled_tasks` does not show it, tell the maintainer. Do not create it again silently.

The README of the private `samson-art/transcriptor-ops` repository has the operational details. They include where production runs, how to get to it, and the emergency procedures. Never copy them into this repo.
