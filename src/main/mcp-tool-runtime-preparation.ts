import type { McpServerConfig } from "@tommy/contracts/ipc";
import { Effect } from "effect";
import { type McpToolRuntimes, needsManagedRuntime } from "../backend/mcp-provider-shapes";
import type { ProviderRuntimeManager } from "./provider-runtime-manager";

/** The managed tool runtimes as an MCP connection test reaches them. */
export interface McpToolRuntimePreparation {
  startToolRuntimes: () => void;
  ensureToolRuntimesReady: OmitThisParameter<ProviderRuntimeManager["ensureToolRuntimesReady"]>;
  toolRuntimes: () => McpToolRuntimes;
}

/** How long a connection test waits for the managed runtimes before probing without them. */
const TOOL_RUNTIME_TEST_WAIT_MS = 60_000;

/**
 * What a connection test waits for: nothing for http and installed commands, the bounded
 * download for a command nothing names.
 */
export const prepareToolRuntimeForTest = Effect.fn("Mcp.prepareToolRuntimeForTest")(function* (
  config: McpServerConfig,
  preparation: McpToolRuntimePreparation,
) {
  if (yield* needsManagedRuntime(config, preparation.toolRuntimes())) {
    yield* preparation.ensureToolRuntimesReady().pipe(
      Effect.timeout(TOOL_RUNTIME_TEST_WAIT_MS),
      Effect.catch(() => Effect.void),
    );
  }
});
