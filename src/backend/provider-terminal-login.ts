import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { sourceText } from "@tommy/i18n/source";
import { Effect, type Scope } from "effect";
import type { CliLoginProcess } from "./agent/cli-login-flow";
import { waitForSuccessfulProcess } from "./agent/provider-status";
import { childProcessEnvironment } from "./child-process-environment";
import { type AgentCliInfo, cliPathEnvironment } from "./cli";
import { stopProcessTree } from "./process-tree";
import { type ProviderClientOperationError, providerCall, providerSync } from "./provider-client-effects";

const execute = promisify(execFile);
const OPEN_MAC = `on run argv
  tell application "Terminal"
    activate
    set loginTab to do script (item 1 of argv)
    return tty of loginTab
  end tell
end run`;
const WAIT_MAC = `on run argv
  tell application "Terminal"
    repeat
      set foundBusy to false
      repeat with candidateWindow in windows
        repeat with candidateTab in tabs of candidateWindow
          if tty of candidateTab is item 1 of argv then
            if busy of candidateTab then set foundBusy to true
          end if
        end repeat
      end repeat
      if not foundBusy then return
      delay 0.2
    end repeat
  end tell
end run`;
const CLOSE_MAC = `on run argv
  tell application "Terminal"
    repeat with candidateWindow in windows
      repeat with candidateTab in tabs of candidateWindow
        if tty of candidateTab is item 1 of argv then
          close candidateTab
          return
        end if
      end repeat
    end repeat
  end tell
end run`;

/** The path comes from the CLI resolver. Quote it as one shell word, including embedded apostrophes. */
function terminalLoginCommand(executable: string): string {
  return `'${executable.replaceAll("'", "'\\''")}'`;
}

/** Owns the terminal opened for Pi login. Closing Pi causes CliLoginFlow to refresh its account. */
export const startProviderTerminalLogin = Effect.fn("ProviderTerminalLogin.start")(function* (
  cli: AgentCliInfo,
  timeoutMs: number,
): Effect.fn.Return<CliLoginProcess, ProviderClientOperationError, Scope.Scope> {
  if (process.platform === "darwin") {
    const opened = yield* providerCall(() =>
      execute("/usr/bin/osascript", ["-e", OPEN_MAC, terminalLoginCommand(cli.executable)], {
        timeout: 30_000,
        maxBuffer: 4096,
        env: childProcessEnvironment(),
      }),
    );
    const tty = opened.stdout.trim();
    if (!/^\/dev\/ttys\d+$/u.test(tty))
      return yield* providerSync(() => {
        throw new Error(sourceText("error.provider.terminalLoginFailed"));
      });
    // The TTY identifies only the tab this operation opened. Other windows and tabs stay open.
    yield* Effect.addFinalizer(() =>
      providerCall(() =>
        execute("/usr/bin/osascript", ["-e", CLOSE_MAC, tty], {
          timeout: 10_000,
          maxBuffer: 4096,
          env: childProcessEnvironment(),
        }),
      ).pipe(Effect.ignore),
    );
    const child = yield* Effect.acquireRelease(
      providerSync(() =>
        spawn("/usr/bin/osascript", ["-e", WAIT_MAC, tty], { stdio: "ignore", env: childProcessEnvironment() }),
      ),
      (child) => stopProcessTree(child).pipe(Effect.ignore),
    );
    return { child, done: waitForSuccessfulProcess(child, timeoutMs) };
  }
  const child = yield* Effect.acquireRelease(
    providerSync(() =>
      spawn("xterm", ["-e", cli.executable], {
        stdio: "ignore",
        env: childProcessEnvironment({ ...process.env, ...cliPathEnvironment(cli) }),
      }),
    ),
    (child) => stopProcessTree(child).pipe(Effect.ignore),
  );
  return { child, done: waitForSuccessfulProcess(child, timeoutMs) };
});
