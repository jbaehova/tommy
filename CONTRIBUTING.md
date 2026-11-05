# Contributing

## Development setup

```bash
git clone https://github.com/jbaehova/tommy.git
cd tommy
bun install --frozen-lockfile
bun run check
bun run dev
```

Coding agents skip `bun run check`: see [AGENTS.md, Checks](AGENTS.md#checks).

The supported toolchain is pinned in `package.json`. Use stable Bun 1.4.2, TypeScript 7, Vite 7, and the
existing Biome configuration. Biome is the only lint and format tool. Do not add a second linter,
Prettier, a second state library, or a UI kit without first discussing the architectural cost.
The Biome configuration also loads the repository-owned GritQL rules in
`tools/biome/anti-slop/rules`. Fix these findings at the domain boundary. Do not suppress a rule or
replace a concrete contract with a broad dictionary type.

Biome's `suspicious/noImportCycles` rejects circular imports across the whole repository, so runtime
imports point in one direction. When two modules need each other, move the shared piece into a third
module both can import — as `features/conversation/conversation-controller-context.tsx` does for the
conversation controller, and `features/team/team-typing.ts` for the one IPC call two differently
scoped owners both need.
Type-only imports (`import type`) are erased by the compiler and stay allowed in both directions.

## Security-sensitive changes

Preserve the following boundaries, and their tests where they exist:

- Electron sandboxing, context isolation, navigation policy, and IPC sender validation.
- Attachment realpath, MIME, size, quota, and managed-protocol checks.
- Queue serialization, idempotency, crash reconciliation, and atomic persistence.
- The remote browser session's lack of preload and `window.tommy` access.
- Secret redaction and agent child-process cleanup.

Full agent access is intentional today, but new privileges or network surfaces still require an
explicit threat-model note in the pull request.

## Dependencies

Prefer the platform and existing dependencies. A new runtime dependency should remove more
complexity than it adds, have a compatible open-source license, and be justified in the pull request.

Bun does not resolve a version that is less than 3 days old (`minimumReleaseAge` in `bunfig.toml`),
and Dependabot waits the same time. Only `@norbert_bodziony/bloub`, which the maintainer publishes,
is excluded. Only the packages in `trustedDependencies` in `package.json` can
run install scripts. If a new dependency needs its install script, add it to that list and give the
reason in the `bunfig.toml` comment. `bun pm untrusted` shows the blocked scripts.
