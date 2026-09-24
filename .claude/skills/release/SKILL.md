---
name: release
description: Maintainer-only release of transcriptor-mcp — version bump and CHANGELOG in the PR, merge, ancestry check, tag (which deploys production), publish watch, and the post-release check. Run only when the maintainer asks for a release.
disable-model-invocation: true
---

# Release

A tag push deploys production: CI publishes `:X.Y.Z` and `:latest`, and the hosted deployment pulls `:latest` on its own. Every step that merges, tags or pushes waits for the maintainer's explicit go-ahead in this session.

Only a PR that changes shipped behaviour is a release. Docs, legal and chore PRs merge without a version.

## 1. In the PR, before merge

1. **Version.** X.Y.Z is the next version after the newest tag (`git tag --sort=-v:refname | head -1`), never lower. The number in the branch name is a guess; the tag decides.
2. **Bump it in four places:**
   - `package.json` `version`;
   - `package-lock.json` (the two top-level version fields);
   - `server.json` `version`;
   - `server.json` `packages[0].identifier` (the image tag).
3. **CHANGELOG.**
   - Move the entries into `## [X.Y.Z] - YYYY-MM-DD`. The date is the tag date, so fix it if the tag slips a day.
   - Keep `## [Unreleased]` empty at the top.
   - Use Keep a Changelog subsections (Added, Changed, Fixed, Security). Start each entry with a bold lead sentence, written for operators and callers, with the measured numbers.
   - Name new, changed or removed env vars. They must also be in `.env.example`, and in the README env table if operators set them.
4. **PR title and body.** The title is `X.Y.Z: <one sentence>`. In the body, add an **After merge** section: the post-deploy checks that show the change works.
5. **Ready to merge** means the gate is green on the last commit, every review fix is pushed, and the PR is out of draft.

## 2. Merge and check ancestry

1. The maintainer merges with a merge commit, not a squash. If they ask you to merge, use `gh pr merge N --merge`.
2. Pull the merge commit:
   ```bash
   git switch main
   git pull --ff-only
   ```
3. Prove the merge contains the whole PR, including fixes pushed after someone clicked Merge:
   ```bash
   gh pr view N --json headRefOid,headRefName
   git merge-base --is-ancestor <headRefOid> <merge sha>
   git merge-base --is-ancestor origin/<headRefName> <merge sha>   # if the branch still exists
   ```
   Never read "already merged" as "merged with my latest push". If anything is missing, open a follow-up PR and release that one instead. In Claude Code the `guard-release` hook repeats this check at tag time.

## 3. Tag and watch the publish

```bash
git tag -a vX.Y.Z -m vX.Y.Z <merge sha>
git push origin vX.Y.Z
```

Then watch the run for this tag, not the newest run: right after the push, GitHub may not have created it yet. A tag-push run has the tag as its branch. Repeat the list until it returns an id:

```bash
gh run list --workflow publish-docker.yml --branch vX.Y.Z --limit 1 --json databaseId -q '.[0].databaseId'
gh run watch <id> --exit-status
```

`publish-docker.yml` runs the gate, builds the image, checks the `curl_cffi` impersonation targets and runs the MCP smoke test. It then pushes both images and publishes `server.json` to the MCP Registry. Tags alone are the practice: don't create a GitHub Release unless the maintainer asks.

If two versions merged back-to-back, tag each merge commit. 1.5.3 was never tagged, so no image or registry entry exists for it.

## 4. After the deploy

1. Run the PR's **After merge** checks.
2. Schedule a one-off check about two hours after the tag. Use the scheduled-tasks tool (`fireAt`, local time) with this self-contained prompt, filled in:

   > In /Users/samsonov/projects/yt-captions-downloader, use the transcriptor-prod-analytics skill to answer "did vX.Y.Z help?". Compare the window since <tag time, UTC> with the same length before it, focusing on <what the release was meant to change>. Report in Russian: what changed, in numbers. If you find a regression or an unmet goal, draft an intent issue for each (Problem, Desired outcome, Constraints, Acceptance criteria). Mark each draft public (samson-art/transcriptor-mcp) or private (samson-art/transcriptor-ops, if it needs production hosts, IPs, prod metrics or user data). Do not create issues; list the drafts for the maintainer.

   It must be a local task on the maintainer's machine: the analytics skill reaches production through access a cloud session does not have. Scheduled tasks run while the Claude app is open, or on its next launch.
3. The weekly production report is a standing local task (`transcriptor-weekly-prod-report`). If `list_scheduled_tasks` does not show it, tell the maintainer rather than recreating it silently.

Operational details (where production runs, how to reach it, emergency procedures) live in the private `samson-art/transcriptor-ops` README. Never copy them into this repo.
