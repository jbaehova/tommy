// Checks the secure sign-in form on the real browser host: one form fills the account name and the
// password, a failed fill leaves the tab free for the agent, and no tab stays locked after a fill.
// It uses a hidden Electron window and a temporary profile, and takes no focus. The check is local.
// Run: `bun scripts/browser-secure-login-e2e.ts`.
// Writes .tommy-build/browser-secure-login-e2e/report.json.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutElectronRuntimeFlags } from "./electron-spawn-env";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reportPath = join(projectRoot, ".tommy-build/browser-secure-login-e2e/report.json");
const root = await mkdtemp(join(tmpdir(), "tommy-secure-login-"));

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", env });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}.`))));
  });
}

let failed = false;
try {
  const entry = join(root, "browser-secure-login.mjs");
  await run(
    process.execPath,
    [
      "build",
      join(projectRoot, "scripts/browser-secure-login-electron.ts"),
      "--target=node",
      "--format=esm",
      "--external=electron",
      `--outfile=${entry}`,
    ],
    process.env,
  );
  await run(
    join(projectRoot, "node_modules/.bin/electron"),
    [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      entry,
      `--fixture-root=${root}`,
      `--report-path=${reportPath}`,
    ],
    withoutElectronRuntimeFlags(process.env),
  );
  process.stdout.write(`passed: ${reportPath}\n`);
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
