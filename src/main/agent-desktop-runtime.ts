// agent-desktop, the Computer Use driver. Tommy packages a pinned build (native-runtime.lock.json) and
// hands every provider one stdio MCP entry for it. Nothing runs between calls: each provider spawns
// `agent-desktop mcp` itself, and the driver reads the desktop through the accessibility tree.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_DESKTOP_MCP_SERVER_ID,
  AGENT_DESKTOP_MCP_SERVER_NAME,
  type CapabilityState,
  type McpServerConfig,
} from "@tommy/contracts/ipc";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";
import { createTommyLogger } from "@tommy/logging";
import { Effect, Schema } from "effect";
import { childProcessEnvironment } from "../backend/child-process-environment";

const logger = createTommyLogger("agent-desktop");
const run = promisify(execFile);
const STATUS_TIMEOUT_MS = 10_000;

/**
 * The variables of this process that the driver needs to reach the desktop. Each one is read when a
 * provider spawns the driver, never stored, so a session bus address that changes at each start does
 * not change the stored Codex tool fingerprint.
 */
const PASSTHROUGH = [
  "HOME",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "WAYLAND_DISPLAY",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
];

const StatusEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  data: Schema.optionalKey(
    Schema.Struct({
      permissions: Schema.optionalKey(
        Schema.Struct({ accessibility: Schema.optionalKey(Schema.Struct({ state: Schema.String })) }),
      ),
    }),
  ),
});
const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(StatusEnvelope));

export interface AgentDesktopRuntimeOptions {
  /** The driver this build carries, or null when the build has none for this platform. */
  binary: string | null;
  /** `DISPLAY` of the agent display on a server, else empty: the driver works where the agents work. */
  agentEnvironment: Readonly<Record<string, string>>;
  /**
   * Whether the driver may take focus and send real pointer and key input. Only on a display that no
   * person uses, where a physical click or a scroll disturbs nobody and many apps need one.
   */
  headed: boolean;
}

/**
 * The driver and what it can do on this computer. It owns no process: `check` asks the driver once,
 * and the answer decides whether providers get the MCP entry and what the capability reports.
 */
export class AgentDesktopRuntime {
  readonly #options: AgentDesktopRuntimeOptions;
  #state: CapabilityState = "unavailable";

  constructor(options: AgentDesktopRuntimeOptions) {
    this.#options = options;
  }

  capability(): CapabilityState {
    return this.#state;
  }

  /**
   * Reads `agent-desktop status` on the agent display. Ready only when the accessibility tree answers:
   * on Linux that is the AT-SPI bus of this session, and on macOS the Accessibility grant of Tommy.
   */
  readonly check = Effect.fn("AgentDesktopRuntime.check")(function* (this: AgentDesktopRuntime) {
    const binary = this.#options.binary;
    if (!binary) {
      this.#state = "unavailable";
      return this.#state;
    }
    const env = childProcessEnvironment({ ...process.env, ...this.#options.agentEnvironment });
    // A refused status still prints its envelope and exits non-zero, so a failed run is read too.
    const output = yield* Effect.promise((signal) =>
      run(binary, ["status"], { env, timeout: STATUS_TIMEOUT_MS, signal }).then(
        (result) => result.stdout,
        (error: unknown) => (isDynamicRecord(error) && isString(error.stdout) ? error.stdout : ""),
      ),
    );
    const status = decodeStatus(output.trim());
    const accessibility =
      status._tag === "Some" && status.value.ok ? status.value.data?.permissions?.accessibility?.state : undefined;
    this.#state = accessibility === "granted" ? "ready" : status._tag === "Some" ? "setup-required" : "unavailable";
    logger.info("Checked the Computer Use driver.", { state: this.#state, accessibility: accessibility ?? null });
    return this.#state;
  });

  /** The entry every provider gets while the driver is ready, else null. */
  mcpServerConfig(): McpServerConfig | null {
    const binary = this.#options.binary;
    if (!binary || this.#state !== "ready") return null;
    return {
      id: AGENT_DESKTOP_MCP_SERVER_ID,
      name: AGENT_DESKTOP_MCP_SERVER_NAME,
      transport: "stdio",
      enabled: true,
      command: binary,
      args: this.#options.headed ? ["mcp", "--headed"] : ["mcp"],
      env: Object.entries(this.#options.agentEnvironment).map(([key, value]) => ({ key, value })),
      envPassthrough: PASSTHROUGH,
      // Empty: ACP has no field for it, and an entry with one would be dropped for ACP providers.
      workingDirectory: "",
      url: "",
      headers: [],
    };
  }
}

/**
 * The driver this build runs. A packaged build reads only its own copy: the release is pinned to it,
 * and an environment variable must not decide which program drives the desktop. A checkout reads
 * `TOMMY_AGENT_DESKTOP_PATH`, else the build `bun run prepare:agent-desktop` staged.
 */
export function resolveAgentDesktop(options: {
  packaged: boolean;
  resourcesPath: string;
  sourceRoot: string;
  environment?: NodeJS.ProcessEnv;
}): string | null {
  const executable = process.platform === "win32" ? "agent-desktop.exe" : "agent-desktop";
  const candidate = options.packaged
    ? join(options.resourcesPath, "agent-desktop", executable)
    : (options.environment ?? process.env).TOMMY_AGENT_DESKTOP_PATH ||
      join(options.sourceRoot, ".tommy-build", "agent-desktop", executable);
  return existsSync(candidate) ? candidate : null;
}
