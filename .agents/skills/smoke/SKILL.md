---
name: smoke
description: Smoke test Tommy server and Telegram changes through their production entry points. Use for QA of a change or pull request.
---

# Smoke test

Use Node 24 and the Bun version in `package.json`. Install dependencies in a fresh checkout with
`bun install --frozen-lockfile`.

Read the PR diff when a PR is named. Otherwise read the changes from the merge base of
`origin/main`, including uncommitted work. Write down the user action, expected result and reverse
action for each affected path. Include a restart when a change touches persistent state.

## Select a check

Use the smallest end-to-end script that exercises the change. Read its setup and check whether it
uses an external service. These scripts create temporary profiles and write results to
`.tommy-build/`.

| Path under test | Command |
| --- | --- |
| Telegram webhook requests and owner commands | `bun scripts/telegram-vps-e2e.ts` |
| Agent turns and replies to Telegram | `bun scripts/telegram-agent-host-e2e.ts` |
| Telegram workflow output | `bun scripts/workflow-telegram-e2e.ts` |
| Signed inbound webhooks | `bun scripts/direct-webhooks-e2e.ts` |
| Queue recovery after a restart | `bun scripts/queue-restore-loop-e2e.ts` |

Find other scenario scripts with `rg --files scripts -g '*-e2e.ts'`. Run one at a time. Read the
reported result and its artifact. For a Mini App or provider change, state whether the test used a
real client, issuer or provider. Record an inaccessible surface as unchecked.

For an installed Linux service, use a disposable installation. Give it a separate data directory
and its own test credentials. Use only the installation authorized for this test. Stop processes
that you started. Keep screenshots and reports under `.tommy-build/` and remove credentials and
personal information from shared evidence.

## Report

For each action, give the observed result, pass or fail, and the evidence path. Include the expected
result when the action failed. State which parts require a real deployment or service.
