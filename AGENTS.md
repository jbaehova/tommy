# Repository guidance

## Communication

Write all text (updates, answers, commits, PRs, reviews) in ASD-STE100 Simplified Technical
English, as short as possible. Keep code, commands, paths and identifiers unchanged.

Continue when a step needs no developer input. Ask only when you cannot continue, or before a
destructive step: deleting data, force-pushing, or a change outside this repository. For multi-step
work, keep a checklist in `TASKS.md` at the worktree root (git-ignored). For an audit that divides
into independent areas, use one subagent per area, check its evidence, and finish with one table.
Mark claims you could not confirm and say where you looked.

**Non-negotiable** rules change only on an explicit developer decision. Other rules are defaults:
follow the developer's preference and state which default you set aside.

## Non-negotiable

- **Migrations are irreversible.** No backup of `tommy.db` exists. Preserve all user data and
  support every shipped source schema.
- **Released Team API adapters are permanent.** Do not change a shipped wire protocol's meaning.
- **Keep the renderer-to-main trust boundary:** sandboxing, context isolation, navigation policy,
  IPC sender validation, and their tests. Read [CONTRIBUTING.md](CONTRIBUTING.md#security-sensitive-changes) first.
- **Redact secrets** on every log, export, and send path, including diagnostics and analytics.
- **Keep PolyForm Noncommercial 1.0.0.** No incompatible dependencies. Keep the `Required Notice:`
  lines of `LICENSE` and the attribution in `NOTICE` exactly as they are.
- **Keep personal values out of git.** The repository is public. Do not commit values or steps of
  one person or installation (emails, personal resource IDs, hosts, IPs, local paths). Put them in
  `.env`, skills outside the repository, or user settings. Scan each diff before a commit or push.

## Product constraints

- User data (workspaces, conversations, attachments, browser and team data) stays on the computer
  that runs Tommy. Exception: a signed-in phone keeps an encrypted read-only cache
  (`apps/mobile/src/features/workspace/model/workspace-cache.ts`), deleted on sign-out, session
  expiry or server removal.
- Cloudflare holds accounts, avatars, host configuration, memberships, invitations and sessions;
  never chats, files or commands.
- The user's SQLite database is the source of truth.
- Agents keep workspace, thread and identity across provider switches and restarts.

## Effect

- Use Effect 4.0.0 (read the installed source, no v3 aliases) for migrated server and desktop
  services and I/O. Prefer named `Effect.fn`, `Effect.gen`, `Context.Service`, explicit layers and
  `Schema.TaggedError`.
- Derive types from schemas. Decode untrusted values at the boundary only; keep released decoder
  behavior. Wrap I/O failures at the adapter; keep public error codes and messages.
- Run Effects at framework boundaries. One Effect-returning method per async operation, no paired
  Promise methods. Reuse managed runtimes; keep teardown order, deadlines and retries. Add no
  generic retry or wrapper policies.
- The database host may import `effect` and `node:*`, never Electron or the application database.

## Shared UI and text

- `packages/ui` (`@tommy/ui`) owns shared SolidJS components. Reuse them; do not copy them into an
  app. Keep them free of app contexts and `window.tommy`. Read [packages/ui/AGENTS.md](packages/ui/AGENTS.md) first.
- User-visible text comes from `@tommy/i18n` keys; server errors use `sourceText(key)`. Read
  [docs/i18n.md](docs/i18n.md) before adding a key.

## Checks

Broad checks overload the user's computer. Leave full lint, `bun run typecheck`, builds and full
test suites to CI.

1. In a fresh worktree, run `bun install --frozen-lockfile`.
2. Run one check at a time. Use `bun run test:changed`, `bun run test:related -- <source>`, or
   `bun run test:desktop -- <path>`.
3. Type-check one project: `bun run typecheck:node`, `bun run typecheck:renderer`, or the changed
   package's `typecheck`. State what remains unverified.
4. Format changed files only: `biome check --write --max-diagnostics=none <paths>`. Never
   `bun run format`.
5. The pre-commit hook runs the staged checks. Do not run them by hand or use `--no-verify`.

See [check design notes](docs/development-checks.md) when changing checks or dependencies.

## Surfaces to check

State which surfaces a change touches: desktop renderer, mobile, Linux server install
(`scripts/hosting`), IPC contracts, migrations plus the latest schema, and docs. Check reverse
actions (snooze, pause, revoke, mute).

## Local processes

- Never kill by process pattern (`pkill -f`). Use `bun run dev:stop`; for other processes, target a
  PID you started or ask.
- Never drive another worktree's app. Use `bun run dev:automation`; `click` and `type` need
  `--allow-mutations` and a named instance.
- Do not delete a dead stack record you did not resolve (`bun run dev:forget` after resolving).
- Reuse a running dev instance and the ports it reports. See [README.md](README.md#commands).

## Terms

Do not use **bot** in new code (released names stay). **teammate** and **group** are UI words,
never types. See [docs/glossary.md](docs/glossary.md).

## Task-specific instructions

Read the AGENTS.md of each directory you change: `src/renderer`, `src/main`, `src/main/ipc`,
`src/backend`, `src/preload`, `packages/contracts`, `packages/ui`, `packages/team-client`,
`apps/mobile`. Before a version bump or tag, use
[release-upgrade-safety](.agents/skills/release-upgrade-safety/SKILL.md).

## Tests

- E2E tests only: a script under `scripts/` that drives the real app and writes an artifact under
  `.tommy-build/`.
- Vitest only for migrations (fixtures per released schema, see `src/backend/AGENTS.md`), the trust
  boundary, secret redaction, and lint or UI rule fixtures.
- Wait for state or events, not time. Assert behavior and data, not markup or layout. No
  `data-testid`.
- Fix errors; do not add `biome-ignore`. Each GritQL rule and UI check needs positive and negative
  fixtures.

## Pull requests

- Open a PR only when asked. Short body: what, why, focused checks run, model and harness.
- For UI changes, show before and after; do not commit screenshots.
- `biome-ignore`, `@ts-expect-error`, `@ts-ignore`, rule overrides, `any` or `unknown` widening, or
  checker-bypassing assertions need a named reason and developer approval.
