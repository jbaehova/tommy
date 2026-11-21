import { join } from "node:path";
import { teeLogLines } from "@tommy/logging";
import { Effect } from "effect";
import { appendDiagnosticLog } from "./remote-diagnostics";

const PROVIDER_LOG_PREFIXES = ["provider-runtime", "provider-runtimes", "provider-models", "agent-error"] as const;

/** Keeps provider failures and runtime diagnostics in a rotating, redacted log. */
export function startProviderLog(logsDirectory: string): () => void {
  const directory = join(logsDirectory, "providers");
  return teeLogLines(PROVIDER_LOG_PREFIXES, (line) => {
    Effect.runFork(appendDiagnosticLog(directory, "providers", `${line}\n`));
  });
}

/**
 * Keeps the agent deletion lines in `<logs>/agents/agents.log`, with the same size limit. A delete that
 * fails names only its stage and an error code, so a support report can show which step failed.
 */
export function startAgentLog(logsDirectory: string): () => void {
  const directory = join(logsDirectory, "agents");
  return teeLogLines(["agent-removal"], (line) => {
    Effect.runFork(appendDiagnosticLog(directory, "agents", `${line}\n`));
  });
}

/** Keeps a process-wide record of startup, shutdown and message-routing failures. */
export function startMainLog(logsDirectory: string): void {
  const directory = join(logsDirectory, "main");
  teeLogLines(["main", "update", "channel-routing", "drain-scheduler"], (line) => {
    Effect.runFork(appendDiagnosticLog(directory, "main", `${line}\n`));
  });
}
