---
name: release-upgrade-safety
description: Audit a pending Tommy release for upgrade and data-loss hazards before the version is bumped or tagged. Use when asked to cut a release, create or bump a version, prepare a tag, or check whether a change is safe to ship to installed users.
---

# Release upgrade safety

Audit the candidate against the last shipped release. User databases migrate in place. A running
server can have unfinished agent turns, file deliveries and sign-ins when it restarts.

## Establish the range

Record the candidate commit and the last released tag on its history. Check the GitHub release list
if multiple release lines exist. List added, modified, deleted and renamed files.

```sh
git status --short
git describe --abbrev=0 --tags --match 'v*' HEAD
git diff --name-status --find-renames <released-tag> HEAD
```

Include intended working-tree changes when auditing an uncommitted candidate. Identify them in the
report and compare the final release commit before tagging. Account for all files. Tests, CI and
the installer can weaken a release guarantee. Examine both the old and new owners of renamed or
deleted behavior.

## Audit the affected surfaces

| Surface | Trigger and required evidence |
| --- | --- |
| [SQLite](references/gate-a-sqlite.md) | A migration, schema, projection or data owner changed. Test upgrade fixtures, schema parity and recovery. |
| [Stored files](references/gate-b-on-disk-state.md) | A path, serializer, credential owner, transfer directory or storage key changed. Read records written by the shipped version. |
| [Team wire contracts](references/gate-c-team-api.md) | A released adapter or a dependency of its encoder or decoder changed. Compare accepted inputs, output and errors to the tag. |
| [Server trust boundaries](references/gate-d-ipc.md) | A Telegram endpoint, owner check, agent browser, local command or child process changed. Exercise the allowed and refused paths. |
| [Linux installation](references/gate-f-updater.md) | The package, installer, runtime locks, service identity or dependencies changed. Check both Linux artifacts and upgrade a disposable profile. |
| [Reverse actions](references/gate-g-reverse-states.md) | For every release, confirm that the user can leave a new state. Record required steps in the changelog. |

Use the [storage and packaging inventory](references/surfaces.md) to find current owners. Follow
dependencies outside this list when the diff affects a protected behavior. Inspect the source of a
test if it changed or if the command collected zero cases. Run focused checks one at a time.

For a changed provider or Computer Use pin, compare its version, target, source URL, license and
artifact digests. Investigate any replaced bytes under the same version. Check published security
fixes for the changed pins. Preserve access to installed providers and shared runtime stores.

## Report

For each surface state pass, fail, unchecked or unaffected. Attach the relevant path, command and
result. Distinguish an untested Linux installation from a verified one. Report a release blocker
when user data can be lost, a shipped protocol changes meaning, an unsafe input gains access, or
the package cannot reopen installed data. Follow [the release procedure](../../../docs/RELEASING.md)
when asked to release.
