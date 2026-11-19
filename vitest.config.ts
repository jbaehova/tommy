import { configDefaults, defineConfig } from "vitest/config";
import { TEST_TIMEOUT_MS } from "./src/backend/test-deadlines";
import BalancedSequencer from "./tools/vitest/balanced-sequencer";

export default defineConfig({
  test: {
    execArgv: ["--disable-warning=ExperimentalWarning"],
    globals: true,
    // The worker count is left to vitest, which uses one less than the machine
    // reports: the CI runner reports four vCPUs, so it runs three. Asking that
    // runner for a fourth was measured and is slower, not faster - 125.7s
    // against 100.6s - because the workers then contend with the main process.
    // Every spy, global patch and fake timer a test file installs is undone
    // after each test, in both projects, so nothing depends on file order.
    restoreMocks: true,
    // A `vmThreads` worker keeps each file's module graph until it is recycled, and vitest recycles
    // it only when its heap passes this limit. The default is system memory / workers: 3.5 GB on
    // the 7 GB macOS release runner with two workers, above the ~1.75 GB heap that V8 gives a
    // worker there. The worker then ran out of heap before it was recycled ("Worker exited
    // unexpectedly") in the unsharded release run.
    vmMemoryLimit: "1GiB",
    // Only `shard()` is overridden, so a local run orders files exactly as before. See the
    // sequencer for why `--shard` alone splits this suite badly.
    sequence: { sequencer: BalancedSequencer },
    // The default triggers make `--changed` and `related` select every test when `package.json`
    // or a vitest config changes, but only in a checkout path with no dot directory. Never select
    // the full suite for a focused run: `test:changed` must stay on the dependents of a change.
    forceRerunTriggers: [],
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          // Strictly longer than the wait deadline - see src/backend/test-deadlines.ts.
          testTimeout: TEST_TIMEOUT_MS,
          // No test inherits the developer's HOME, provider keys or time zone -
          // see tools/vitest/hermetic-environment.ts.
          setupFiles: ["./tools/vitest/hermetic-setup.ts"],
          include: [
            "src/backend/**/*.test.ts",
            "src/main/**/*.test.ts",
            "scripts/**/*.test.ts",
            "packages/logging/**/*.test.ts",
          ],
        },
      },
    ],
    exclude: [
      ...configDefaults.exclude,
      "tests/visual/**",
      ".tommy-build/**",
      // Agent tools put git worktrees inside the checkout.
      "**/.worktrees/**",
      "**/.claude/worktrees/**",
      "**/.codex/**",
    ],
  },
});
