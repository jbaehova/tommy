# Contributing

## Development setup

```bash
git clone https://github.com/jbaehova/tommy.git
cd tommy
bun install --frozen-lockfile
bun run check
```

Tommy runs as a Linux server. Check a change with the end-to-end scripts in `scripts/` and on a
server; a development start on your own computer uses the agent folders in your home folder.

Coding agents skip `bun run check`: see [Checks](#checks).

The supported toolchain is pinned in `package.json`. Use stable Bun 1.4.2, TypeScript 7, Vite 7, and the
existing Biome configuration. Biome is the only lint and format tool. Do not add a second linter,
Prettier, or a second state library without first discussing the architectural cost.
The Biome configuration also loads the repository-owned GritQL rules in
`tools/biome/anti-slop/rules`. Fix these findings at the domain boundary. Do not suppress a rule or
replace a concrete contract with a broad dictionary type.

Biome's `suspicious/noImportCycles` rejects circular imports across the whole repository, so runtime
imports point in one direction. When two modules need each other, move the shared piece into a third
module both can import.
Type-only imports (`import type`) are erased by the compiler and stay allowed in both directions.

## Security-sensitive changes

Preserve the following boundaries, and their tests where they exist:

- Electron sandboxing of the agent browser, and the deny-all permissions of the default session.
- The Telegram webhook secrets, the owner check, and the Mini App launch-data check with each bot's
  own credential.
- Attachment realpath, MIME, size, quota, and managed-protocol checks.
- Queue serialization, idempotency, crash reconciliation, and atomic persistence.
- The agent browser session's lack of a preload.
- Secret redaction and agent child-process cleanup.

Full agent access is intentional today, but new privileges or network surfaces still require an
explicit threat-model note in the pull request.

## Dependencies

Prefer the platform and existing dependencies. A new runtime dependency should remove more
complexity than it adds, have a compatible open-source license, and be justified in the pull request.

Bun does not resolve a version that is less than 3 days old (`minimumReleaseAge` in `bunfig.toml`),
and Dependabot waits the same time. Only `effect` is excluded (see the `bunfig.toml` comment). Only
the packages in `trustedDependencies` in `package.json` can run install scripts. If a new dependency needs its install script, add it to that list and give the
reason in the `bunfig.toml` comment. `bun pm untrusted` shows the blocked scripts.

## Checks

CI runs the full set (`bun run check`) on each pull request. A full run reads the whole repository
and loads a laptop, so locally run only what your change needs:

1. In a fresh worktree, run `bun install --frozen-lockfile`.
2. Run one check at a time: `bun run test:changed`, `bun run test:related -- <source>`, or
   `bun run test:desktop -- <path>`.
3. Type-check one project: `bun run typecheck:node`, or the changed package's `typecheck`.
4. Format only the files you changed: `biome check --write --max-diagnostics=none <paths>`.
5. The pre-commit hook runs the staged checks. Do not skip it with `--no-verify`.

See the [check design notes](docs/development-checks.md) before you change a check or a dependency.

## Tests

- End-to-end tests are scripts under `scripts/` that drive the real app and write their output under
  `.tommy-build/`.
- Use Vitest only for migrations (a fixture for each released schema), the Telegram and webhook
  trust boundary, secret redaction, and lint rule fixtures.
- Wait for state or events, not for time. Assert behavior and data, not markup or layout. Do not use
  `data-testid`.
- Fix a lint error; do not add `biome-ignore`. Each GritQL rule has fixtures that it must reject and
  fixtures that it must accept.

## Terms

Do not use **bot** in new code (released names stay). **teammate** and **group** are words of the
interface, never type names. See [docs/glossary.md](docs/glossary.md).
