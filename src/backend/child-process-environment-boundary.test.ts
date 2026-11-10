import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServerConfig } from "@tommy/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childProcessEnvironment } from "./child-process-environment";
import { ClaudeAgentClient } from "./claude-client";
import { mcpEnvironment } from "./mcp-provider-shapes";
import { decodeRecordResponse } from "./protocol";

const run = promisify(execFile);
const HOST_KEY = "TOMMY_WORKFLOW_CONNECTORS_JSON";
const FAKE_CONNECTOR = "example-host-connector-credential";

afterEach(() => vi.unstubAllEnvs());

describe("host connector subprocess boundary", () => {
  it("removes each spelling without changing the host environment or other credentials", () => {
    const inherited = {
      [HOST_KEY]: FAKE_CONNECTOR,
      tommy_workflow_connectors_json: "example-lowercase-credential",
      ANTHROPIC_API_KEY: "example-provider-key",
      NODE_OPTIONS: "--max-old-space-size=256",
    };
    const child = childProcessEnvironment(inherited);
    expect(child[HOST_KEY]).toBeUndefined();
    expect(child.tommy_workflow_connectors_json).toBeUndefined();
    expect(child.ANTHROPIC_API_KEY).toBe("example-provider-key");
    expect(child.NODE_OPTIONS).toBe(inherited.NODE_OPTIONS);
    expect(inherited[HOST_KEY]).toBe(FAKE_CONNECTOR);
    expect({ ...inherited, ...child }[HOST_KEY]).toBeUndefined();
  });

  it("does not send the reserved value to a real child process", async () => {
    const { stdout } = await run(
      process.execPath,
      [
        "--eval",
        [
          "process.stdout.write(JSON.stringify({",
          "hostKeyPresent: process.env.TOMMY_WORKFLOW_CONNECTORS_JSON !== undefined,",
          "providerKey: process.env.ANTHROPIC_API_KEY, marker: process.env.EXAMPLE_MARKER",
          "}))",
        ].join(""),
      ],
      {
        env: childProcessEnvironment({
          [HOST_KEY]: FAKE_CONNECTOR,
          ANTHROPIC_API_KEY: "example-provider-key",
          EXAMPLE_MARKER: "kept",
        }),
        timeout: 5_000,
        maxBuffer: 1024,
      },
    );
    expect(JSON.parse(stdout)).toEqual({ hostKeyPresent: false, providerKey: "example-provider-key", marker: "kept" });
  });

  it("filters the final Claude SDK environment after account and agent additions", async () => {
    vi.stubEnv(HOST_KEY, FAKE_CONNECTOR);
    let sdkEnvironment: NodeJS.ProcessEnv | undefined;
    const client = new ClaudeAgentClient(
      { executable: "example-claude", version: "2.1.318", source: "system" },
      (params) => {
        sdkEnvironment = params.options?.env;
        throw new Error("Stop before a provider is launched.");
      },
      undefined,
      30_000,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        [HOST_KEY]: "example-agent-override",
        CLAUDE_CONFIG_DIR: "/Users/user/.claude",
        EXAMPLE_ACCOUNT: "kept",
      }),
    );
    client.start();
    try {
      await expect(Effect.runPromise(client.request("model/list", {}, decodeRecordResponse))).rejects.toThrow();
      expect(sdkEnvironment).toBeDefined();
      expect(sdkEnvironment?.[HOST_KEY]).toBeUndefined();
      expect(sdkEnvironment?.EXAMPLE_ACCOUNT).toBe("kept");
      expect(sdkEnvironment?.CLAUDE_CONFIG_DIR).toBe("/Users/user/.claude");
    } finally {
      await Effect.runPromise(client.stop());
    }
  });

  it("refuses the reserved MCP passthrough and pair while keeping unrelated explicit values", () => {
    vi.stubEnv(HOST_KEY, FAKE_CONNECTOR);
    vi.stubEnv("EXAMPLE_MCP_INHERITED", "inherited");
    const config: McpServerConfig = {
      id: "example-mcp",
      name: "example-mcp",
      enabled: true,
      transport: "stdio",
      command: "example-mcp",
      args: [],
      workingDirectory: "",
      url: "",
      headers: [],
      envPassthrough: [HOST_KEY, "EXAMPLE_MCP_INHERITED"],
      env: [
        { key: "tommy_workflow_connectors_json", value: "example-pair-override" },
        { key: "EXAMPLE_MCP_INHERITED", value: "explicit" },
        { key: "EXAMPLE_MCP_SECRET", value: "example-mcp-key" },
      ],
    };
    const environment = mcpEnvironment(config);
    expect(environment).toEqual({ EXAMPLE_MCP_INHERITED: "explicit", EXAMPLE_MCP_SECRET: "example-mcp-key" });
    expect(JSON.stringify(environment)).not.toContain(FAKE_CONNECTOR);
    expect(process.env[HOST_KEY]).toBe(FAKE_CONNECTOR);
  });
});
