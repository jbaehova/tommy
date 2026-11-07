---
name: ship
description: Ship the current branch to main. Review the diff, fix findings, open the pull request, wait for CI until green, then squash-merge. Use when a feature is done and the user asks to ship it, open and merge a PR, or get the change to main.
---

# Ship

Move one finished branch to `main` through four gates: local review, pull
request, CI, merge. Do each gate in sequence. Do not skip a gate to go faster.

When the user invokes this skill, they approve the merge at the end, but only
when every gate is green. Stop and ask when a gate needs a product decision,
a force-push, or a bypass.

## Before you start

- Read `AGENTS.md` and each nested `AGENTS.md` for a directory in the diff.
- Run `git status` and `git branch --show-current`. When the branch is
  `main`, create a branch first. Do not ship from `main`.
- Run `git fetch origin main`. Get the change set with
  `git diff --stat origin/main...HEAD` and `git status --short`.
- When a pull request for the branch exists (`gh pr view --json number,state,url`),
  continue from the first gate that is not done.
- Keep a checklist in `TASKS.md` with one item for each gate.

## Gate 1: Review the diff locally

1. Commit the finished work. Write the message in ASD-STE100 Simplified
   Technical English. Leave unrelated changes out of the commit.
2. Review `origin/main...HEAD` for correctness, data loss, the
   non-negotiable rules in `AGENTS.md`, personal values (see `AGENTS.md`),
   and reuse. Use the `code-review` skill when it is available, or a review
   subagent with the diff range.
3. Fix only findings that you can prove with a failing input or a code path.
   Record the others as not valid, with the reason.
4. Run the narrowest relevant test file and
   `biome check --write --max-diagnostics=none <changed paths>`. Run one
   typecheck project for the code you changed, as `AGENTS.md` says. Do not
   run broad checks.
5. Commit the fixes. The pre-commit hook runs its own checks. Do not use
   `--no-verify`. When the hook fails, fix the cause and commit again.

For a UI change, run the `smoke` skill and take before and after
screenshots. Upload them with `gh pr create --attach` or
`gh pr edit --attach` (gh 2.101 or later; run `gh --version`). Do not
commit them.

## Gate 2: Open the pull request

1. Push the branch: `git push -u origin HEAD`.
2. Write the body from `.github/PULL_REQUEST_TEMPLATE.md`. Fill
   `## What changed` with the user-visible result and the surfaces the
   change touches. Fill `## Verification` with the checks you ran and the
   checks you left to CI.
3. State the model and harness in the body.
4. Create the PR: `gh pr create --base main --title "<title>" --body-file <file>`.
   Write the title as one imperative sentence, as recent `main` commits do.
5. When the `link_pull_request` tool is available, link the PR URL.

## Gate 3: Make CI green

GitHub does not run `pull_request` workflows on a PR with a merge conflict,
so a wait for `Check` does not end. Before each wait, run
`gh pr view <pr> --json mergeable,mergeStateStatus,headRefOid`.
`UNKNOWN` means that GitHub still calculates the state: ask again later.

1. Watch the checks on the head SHA:
   `gh pr checks <pr> --watch --interval 120`. Run it in the background.
   When it shows no checks 10 minutes after a push, look for a merge
   conflict first, then read `gh run list --branch <branch> --limit 5`.
2. For each failed job, read only the failed log:
   `gh run view <run-id> --log-failed`. Find the cause.
3. When the failure comes from the change, fix it, commit, and push.
4. When the failure is not related to the change, such as a network
   timeout, run `gh run rerun <run-id> --failed` once. When the same job
   fails again, stop and report it to the user.
5. When `mergeable` is `CONFLICTING`, merge `main` into the branch, resolve
   the conflicts, and push. Do not force-push.
6. Answer each open human review thread. Do not resolve a thread that
   another person opened before you answer it.

Never weaken or skip a test to make CI green.

## Gate 4: Merge

Merge only when, on the same head SHA, `mergeStateStatus` is `CLEAN`,
`Check` is success, and no conversation is open. Then merge:

```
gh pr merge <pr> --squash --delete-branch --match-head-commit <head-sha>
```

`--match-head-commit` stops the merge when a new push arrived after your
last check. Do not use `--admin`. Do not bypass branch protection. Do not
delete this worktree.

After the merge, run `gh pr view <pr> --json state,mergeCommit` and confirm
`MERGED`. Run `git fetch origin main` and confirm that `origin/main` contains
the merge commit.

## Stop and ask

Stop and ask the user when:

- A fix needs a force-push, a history rewrite, or a change outside this
  repository.
- A valid finding or a merge conflict needs a product decision.
- CI fails twice on a cause that you cannot fix in the change.
- The merge needs `--admin` or a protection change.

## Report format

| Gate | Result | Evidence |
| --- | --- | --- |
| Local review | findings fixed / rejected | commit SHAs |
| Pull request | opened | PR URL |
| CI | success | run link |
| Merge | merged | merge commit SHA on `main` |

Then list the checks you ran locally and the checks you left to CI, one line
each.
