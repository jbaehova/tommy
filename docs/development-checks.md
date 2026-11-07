# Development check design notes

These notes explain the checks referenced by [repository instructions](../AGENTS.md#checks).
Read the relevant section when changing CI, dependencies, or lint rules. Routine tasks use the
short command list in `AGENTS.md`.

## Check coverage

CI runs one job, `Check`, from [.github/workflows/ci.yml](../.github/workflows/ci.yml) on each push to
`main` and on each pull request. Its steps run in this order: install with the frozen lockfile,
`lint`, `check:ui`, `i18n:check`, `typecheck`, `build`, `verify:preload` and `test:desktop`.
`bun run check` runs the same steps on one computer. It reads the whole repository, so agents
leave it to CI (see [AGENTS.md](../AGENTS.md#checks)).

Full lint and typecheck read more than the changed files. A shared export can break desktop,
mobile, or a package outside the edited project. Lint uses
`biome check --max-diagnostics=none .`: the default diagnostic limit hides findings after the first
20 even though the reported total includes them. `bun run format` adds `--write` to the full scan;
this is why routine fixes target paths or use the staged-file hook.

The aggregate typecheck selects `typecheck:*`, so a new project needs a script with that prefix.
Mobile uses `@tommy/brand`, `@tommy/contracts`, and `@tommy/team-client`. Its Expo and Uniwind
generation writes ignored files before TypeScript runs.

Each `typecheck` script starts `scripts/type-checker.ts`, not a bare `tsc`. The script runs tsrs, the
Rust port of TypeScript, when tsrs has a binary for the computer: macOS arm64 and Linux, so CI too.
On Windows and Intel Macs it runs `node_modules/typescript/bin/tsc`. tsrs follows a TypeScript 7.1
build and the catalog `typescript` is 7.0, so the two can report different errors. Editors still use
the catalog `typescript`.

The `tsrs` version is exact and must be older than `minimumReleaseAge` in `bunfig.toml` (3 days).

`tsconfig.node.json` and `tsconfig.web.json` set `verbatimModuleSyntax`: a file compiles alone the
same way under `tsc` and the bundler, because a type-only import must say `import type`.
`exactOptionalPropertyTypes` is not on yet.

`apps/mobile` `typecheck` calls `scripts/mobile-codegen.ts`. It runs `codegen` only when a hash of
the codegen inputs and of the route file names differs from `.expo/codegen-inputs.sha256`, or when
an output is missing. File times do not decide: a checkout changes them, and Uniwind does not write a
file whose content is the same.

The pre-commit hook in `.githooks/pre-commit` runs `check:staged`, then `check:ui` and
`scripts/staged-typecheck.ts`. The last two run only when the commit stages code, style, GritQL,
`tsconfig*.json`, `package.json`, `biome.json`, `apps/mobile/app.json` or `bun.lock` files, so a commit
of only text or data JSON is fast. When `tommy-database-schema.ts`, `channel-schema.ts`,
`mcp-schema.ts`, the parity test or `tommy-database-schema-history.json` is staged, the hook also runs
`src/backend/tommy-database-schema-parity.test.ts`.

`scripts/staged-typecheck.ts` reads the root `typecheck:*` scripts and selects each project that can
see a staged file: the file is under a fixed part of the project's tsconfig `include`, in its
workspace package, in a workspace package that it depends on (also through other workspace
packages), or in a folder that it imports through a relative path. A root `tsconfig*.json`,
`package.json` or `bun.lock` selects all projects. A mobile codegen input, such as `app.json` or the
brand CSS, selects mobile. `biome.json` and GritQL files select no project: TypeScript does not read
them. The script runs the projects one at a time and reports each one that fails. `--dry-run` prints
each selected script with the path that selected it. A JSON file that a module imports does not start
a type check in the hook; CI checks it.

`check:staged` lets Biome fix the working-tree copy of each staged file, and the hook then stages
those files again. It stages again only the files that have no unstaged changes; otherwise the commit
would also take the author's unstaged edits. When Biome changes a file that is only partly staged,
the hook stops the commit and names the file.

One project typecheck, such as `typecheck:node` or `typecheck:renderer`, takes under 10 seconds and
less than 1.5 GB of memory. The load that the check rules prevent comes from the aggregate command,
which starts all projects at the same time.

`verify:preload` reads `out/preload` after the build. TypeScript checks the preload source, but
the renderer gets the bundle. The script runs each bundle in a `node:vm` context with a fake
Electron and checks that `window.tommy` has exactly one function for each endpoint that
`IPC_ENDPOINTS` names, and that each function uses the channel of its endpoint. It also rejects
`import()` and a `require` of a module that a sandboxed preload cannot load.

`scripts/install-electron.ts` runs `install-electron` in the root `postinstall`. It tries again,
two times at most, only when the download fails with HTTP 429 or 5xx or a lost connection, because
`@electron/get` has no retry. Each attempt checks the archive against the package checksums.

The E2E scripts under `scripts/` (`*-e2e.ts`, `*-smoke.ts`) drive the real app and are not part of
CI. Run the one for the area you change.

## Focused tests

`bun run test:changed` is `vitest run --changed origin/main --maxWorkers=1`. First it runs
`git merge-base origin/main HEAD`, and stops with an error when `origin/main` or a common commit is
missing. Without this guard, Vitest ignores the failed `git diff`, finds no test files and exits
with code 0, so a broken test would pass. Vitest takes the files
in `git diff origin/main...HEAD`, the staged files, and the unstaged and untracked files. Then it
runs each test file whose import graph contains one of them. It uses the root `vitest.config.ts`,
so each file goes to its usual project (`node` or `renderer`) and environment. When
no test imports a changed file, it finds no test files and exits with code 0. Fetch `origin/main`
first if it is old: an old base selects tests for changes that are already on `main`.

`bun run test:related -- <source>...` is `vitest related --run --maxWorkers=1`. It runs the test
files that import the named source files, with no Git query.

A change to `vitest.config.ts`, a setup file or `package.json` selects no test. The root config
sets `forceRerunTriggers: []`. The Vitest default (`**/package.json/**`,
`**/{vitest,vite}.config.*/**`) selects every test for such a change, but only when the checkout
path has no dot directory: `**` does not match a dot directory such as `.t3` or `.claude`. A full
run on one worker is not a focused check. A setup file is not in a test's import graph. After such
a change, run the test files that it can affect with
`bun run test:desktop -- <path>`.

A shared module can have many dependents. Do a list first to see the set without a run:
`bun x vitest list --filesOnly --changed origin/main`.

## Test environment guard

`tools/vitest/hermetic-setup.ts` is the first setup file of the `node` and `renderer` projects, so it
runs before each test file imports anything. It deletes credential-shaped variables (`*_API_KEY`,
`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_PRIVATE_KEY`, and `ANTHROPIC_*`, `OPENAI_*`, `OPENROUTER_*`,
`XAI_*`, `GEMINI_*`, `AWS_*`), the directory overrides `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
`XDG_STATE_HOME` and `XDG_CACHE_HOME`,
and `ELECTRON_RUN_AS_NODE`. It sets `TZ=UTC` and `LANG=C.UTF-8`, and points `HOME`, `USERPROFILE`,
`APPDATA` and `LOCALAPPDATA` at a temporary directory for the file, which it removes after the file. The `renderer` project runs
files in worker threads, and a thread's `process.env` does not reach the native `homedir()`, so
`tools/vitest/hermetic-global-setup.ts` also moves `HOME` in the main process before the threads
start.

A key in the developer's shell could otherwise let a fake-provider test reach a real provider, and
every profile path (`~/Tommy`, the app data directory) comes from `homedir()`, so a path bug could
write into the developer's own conversations. A test that needs a token or a directory sets it
itself.

## Why the jsdom project uses `vmThreads`

The measurements in this section are from the suite before most unit tests were removed.

`test:desktop` is not slow because of test count. The 54 `renderer` files hold 732 of the 3401
tests and take three quarters of the run, and what cost the most was per-file setup rather than
anything in the tests: building a jsdom for each file was 61.8s of a 176.7s CI run. So the
`renderer` project uses `pool: "vmThreads"`: one jsdom per worker, and a module
registry per file inside a VM context. That took the full suite from 118.7s to 92.6s locally.

The mounts themselves are not the cost, which is worth recording because the file sizes suggest
otherwise. Measured on one worker: `installTommyStub()` is 0.4ms, `AppProviders` with a probe
under it is 4.3ms, and a full `<App />` is 21.8ms, of which the view tree is 17.4ms. Dividing a
file's total time by its render count attributes the whole test to the mount and overstates it by
more than twenty times. Two other theories also measured close to nothing: the 50ms `waitFor` poll
interval is worth 9% on the worst file, because `waitFor` runs its callback once before it polls
and the condition is usually already true.

Isolation is the reason that pool was chosen over the faster `isolate: false`. The renderer files
share module-level store state, so without a per-file registry they pass only in the order vitest
happens to pick: `--sequence.shuffle.files` fails eight files under `isolate: false` and passes
under both `vmThreads` and the previous `forks` default. Use that flag when changing pool settings;
a green run in the default order proves nothing here.

The `node` project stays on isolated `forks`. Its files register IPC handlers and read
per-process globals, so they fail on `threads` whether or not isolation is on, and on `vmForks`
they fail on the filesystem; it also spends its time in the tests themselves rather than in
environment setup, so it has little to gain.

The worker count is left to vitest. It uses one less than the machine reports, and the runner
reports four vCPUs, so it runs three. Asking for a fourth is slower, not faster - 125.7s against
100.6s - because the workers then contend with the main process.

Compare pool settings with the summed `tests` phase divided by the wall clock, not the wall clock
alone. The wall clock is not usable evidence on its own: five runs of one commit, with nothing
changed between them, took 106.7s, 131.8s, 134.0s, 134.1s and 141.5s, a spread of 33%. Two runs of
a config change will therefore agree with almost any conclusion, and reading one slow run as a
worker-count change cost a wrong commit here.

The ratio is stable where the wall clock is not, because it says how many workers were actually
busy: it held between 1.99 and 2.08 across all seven runs on three workers, at durations from 100.6s
to 141.5s, and reached 2.64 on four. Use it, or repeat the run, before believing a pool change.

`deps.optimizer` is not enabled: it left `import` unchanged, at 26.1s against 26.2s, because that
phase is this repository's own module graph re-executing per file rather than dependency resolution.

`bun run dev:prepare` checks Bun, copies the files that `.worktreeinclude` lists from the main
checkout into a new worktree, creates missing local state in `.tommy/dev-state.json`, and installs
the packages. Existing state is reused. `bun run dev` does the same before it starts.

## Lint and UI rules

Biome rejects these patterns in tests: `toHaveClass`, `toHaveStyle`, `getComputedStyle`,
`toContainElement`, `toHaveAttribute("title", …)`, `expect(x.innerHTML)`, DOM-tree walks,
`querySelector("svg" | "img")`, `document.activeElement`, snapshots, `*ByTestId` queries,
assertions reached through CSS classes, an awaited bare `setTimeout`, and `it.only`.
Use `toHaveFocus()` to name the element whose focus matters. Stories have no `play` functions:
`tools/ui-foundation/no-story-play.grit` rejects a new one in any `*.stories.tsx` file.

GritQL cannot connect a test query to the product's `data-testid` attribute. `check:ui` counts
renderer `data-testid` attributes separately, with a budget of zero.

`check:ui` also detects CSS classes that no component, story, or HTML entry point names. This found
about 1,400 lines of unused CSS. A dynamic `prefix-${value}` counts as a use only inside a class
attribute; the same template in an ID must not keep unrelated CSS alive.

Errors cover prohibited syntax. Warnings ask for judgment, such as an `object` parameter or a
module mock. Making correct boundary code worse to remove a warning defeats the check. A spy call
can synchronize an async test; the assertions after that wait must prove behavior.

Every GritQL rule has rejected examples marked `// flag` beside accepted examples. This matters
because a rule that matches nothing passes without enforcing anything. One rule failed to detect
`querySelector<HTMLElement>` until its fixture covered that spelling.

The UI fixtures have two trees. `renderer` breaks every check beside valid examples.
`renderer-clean` breaks none. Both are needed: a check that reports once per file can falsely reject
a valid example without changing the failure count in the first tree.

The shared UI Biome override also runs `tools/ui-foundation/no-desktop-preload.grit`.
It rejects direct `window.tommy` and `globalThis.tommy` access, including optional and
literal indexed forms. Browser APIs, comments, and string documentation remain valid.
Its positive and negative fixtures run in `scripts/ui-foundation-check.test.ts`.

### Promise rules

`nursery/noFloatingPromises` is an error in `biome.json`. Await a promise, or write `void` when the
call is fire-and-forget and the called function handles its own errors.
`nursery/noMisusedPromises` was rejected: its 37 findings were all `if (cachedPromise)` presence
checks.

Biome reports every GritQL plugin under the one category `plugin`, so each plugin message starts
with `[<name>]`. A new GritQL rule must start with no findings.

### Plugin cost

Each GritQL plugin walks every file in its scope again. On 2026-10-06 the plugins used about 60 of
79 CPU-seconds of a full `biome lint .`. To measure one plugin, lint with a temporary config that
turns off the built-in rules and enables only that plugin, and subtract the time with no plugins.

- Check a cheap condition before a costly one. `no-hardcoded-ui-text` matched its long attribute
  regex on every JSX attribute: about 16 of its 23 CPU-seconds. It now checks the attribute name
  first.
- One snippet with a metavariable can cost less than one snippet per spelling.
  `Reflect.$method($args)` costs about half as much as two `Reflect.<method>($args)` snippets.
  `JsCallExpression(callee=...)` was faster still, but it also matched `Reflect.get?.()` and a call
  with type arguments, so it was rejected.
- Do not merge rules into one `or { ... }` file. A merged file of the 8 global rules cost 71
  CPU-seconds, against 24 for the separate files.
- Scope a plugin only to where its pattern can mean something. `no-collections-in-stores` and
  `no-cleanup-in-effect-callbacks` run on the SolidJS code only. The type rules stay global,
  because they apply to scripts and tests too.

Before you change a pattern for speed, show that the old and the new rule report the same
locations over the whole repository and on a file of edge cases.

### Removed rules and their limits

- `no-runtime-typeof` could not distinguish valid narrowing of `unknown` at a trust boundary from
  redundant checks of known values. All sixteen warnings were valid uses. The false positives
  made other warnings easier to overlook.
- `no-chained-type-assertions` repeated Biome's `noUnsafeTypeAssertion` and missed the
  unparenthesized `value as unknown as T` spelling. `noExplicitAny` already covers `any`.
- `no-shape-in-symbol-names` enforced a naming preference with a `const $name = $value` pattern.
  Each plugin traverses the files separately, and that common pattern cost more than the rest of
  the linter. Review can handle a naming decision without that cost.

A new rule must reject a specific syntax, leave valid neighboring code alone, and add coverage
that the existing checks do not provide.
