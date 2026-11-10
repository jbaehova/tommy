// @vitest-environment node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@tommy/contracts/ipc";
import { decodeRecord } from "@tommy/contracts/ipc-decoding";
import type { DynamicRecord } from "@tommy/contracts/runtime-values";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ClaudeAgentClient } from "./claude-client";
import { removeClaudeQuerySettings, writeClaudeFlagSettings, writeClaudeMcpConfig } from "./claude-query-settings";
import { runCauseEffect } from "./effect-boundary";
import { decodeRecordResponse } from "./protocol";

const TOKEN = "example-private-gateway-token";

describe("Claude credential settings boundary", () => {
  it.each([false, true])(
    "passes a private path and keeps workspace confinement when workspaceOnly=%s",
    async (workspaceOnly) => {
      const root = await mkdtemp(join(tmpdir(), "tommy-claude-settings-test-"));
      const account = join(root, "account");
      await mkdir(account);
      await writeFile(
        join(account, "settings.json"),
        JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: TOKEN },
          apiKeyHelper: "example-key-helper",
          hooks: { forbidden: true },
        }),
      );
      const captured: Array<{
        path: string;
        mode: number;
        settings: DynamicRecord;
        sandbox: Options["sandbox"];
        managedSettings: Options["managedSettings"];
        hasHooks: boolean;
      }> = [];
      const client = new ClaudeAgentClient(
        { executable: "example-claude", version: "2.1.318", source: "system" },
        (params) => {
          const settings = params.options?.settings;
          if (typeof settings !== "string") throw new Error("Expected a private settings path.");
          captured.push({
            path: settings,
            mode: statSync(settings).mode & 0o777,
            settings: decodeRecord(JSON.parse(readFileSync(settings, "utf8")), "private Claude settings"),
            sandbox: params.options?.sandbox,
            managedSettings: params.options?.managedSettings,
            hasHooks: params.options?.hooks !== undefined,
          });
          throw new Error("Stop before a provider is launched.");
        },
        undefined,
        5_000,
        undefined,
        undefined,
        undefined,
        undefined,
        join(root, "state"),
        () => ({ CLAUDE_CONFIG_DIR: account }),
      );
      client.start();
      try {
        await expect(
          runCauseEffect(
            client.request(
              "thread/start",
              {
                cwd: root,
                profileGeneration: true,
                persistSession: false,
                workspaceOnly,
              },
              decodeRecordResponse,
            ),
          ),
        ).rejects.toThrow("Stop before a provider is launched.");
        expect(captured).toHaveLength(1);
        const observed = captured[0];
        if (!observed) throw new Error("The query boundary did not run.");
        expect(observed.path).not.toContain(TOKEN);
        expect(observed.mode).toBe(0o600);
        expect(observed.settings).toMatchObject({
          env: { ANTHROPIC_AUTH_TOKEN: TOKEN },
          apiKeyHelper: "example-key-helper",
        });
        expect(observed.settings).not.toHaveProperty("hooks");
        expect(observed.sandbox).toBeUndefined();
        if (workspaceOnly) {
          const sandbox = decodeRecord(observed.settings.sandbox, "private Claude sandbox");
          expect(sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
          expect(decodeRecord(sandbox.filesystem, "private Claude filesystem").allowWrite).toContain(root);
          expect(observed.managedSettings).toEqual({ allowManagedHooksOnly: true });
          expect(observed.hasHooks).toBe(true);
        } else expect(observed.settings).not.toHaveProperty("sandbox");
        expect(existsSync(observed.path)).toBe(false);
      } finally {
        await Effect.runPromise(client.stop());
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("owns and removes its private temporary directory when no state directory is supplied", async () => {
    const file = await Effect.runPromise(writeClaudeFlagSettings(undefined, { env: { ANTHROPIC_AUTH_TOKEN: TOKEN } }));
    try {
      expect(file.temporaryDirectory).not.toBeNull();
      if (file.temporaryDirectory) expect(statSync(file.temporaryDirectory).mode & 0o777).toBe(0o700);
      expect(readFileSync(file.path, "utf8")).toContain(TOKEN);
    } finally {
      await Effect.runPromise(removeClaudeQuerySettings(file));
    }
    expect(existsSync(file.path)).toBe(false);
    if (file.temporaryDirectory) expect(existsSync(file.temporaryDirectory)).toBe(false);
  });
  it("keeps external MCP credentials out of SDK arguments without a configured state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tommy-claude-mcp-test-"));
    const server: McpServerConfig = {
      id: "example-mcp",
      name: "example-mcp",
      enabled: true,
      transport: "http",
      command: "",
      args: [],
      workingDirectory: "",
      url: "https://example.com/mcp",
      headers: [{ key: "Authorization", value: `Bearer ${TOKEN}` }],
      env: [],
      envPassthrough: [],
    };
    const captured: Array<{
      mcpFile: string;
      flagFile: string;
      mode: number;
      mcp: DynamicRecord;
      sdkOnly: boolean;
      extraArgs: string;
    }> = [];
    const client = new ClaudeAgentClient(
      { executable: "example-claude", version: "2.1.318", source: "system" },
      (params) => {
        const mcpPath = params.options?.extraArgs?.["mcp-config"];
        const flagPath = params.options?.settings;
        if (typeof mcpPath !== "string" || typeof flagPath !== "string")
          throw new Error("Expected private settings paths.");
        captured.push({
          mcpFile: mcpPath,
          flagFile: flagPath,
          mode: statSync(mcpPath).mode & 0o777,
          mcp: decodeRecord(JSON.parse(readFileSync(mcpPath, "utf8")), "private MCP settings"),
          sdkOnly: Object.values(params.options?.mcpServers ?? {}).every((config) => config.type === "sdk"),
          extraArgs: JSON.stringify(params.options?.extraArgs ?? {}),
        });
        throw new Error("Stop before a provider is launched.");
      },
      undefined,
      5_000,
      () => [server],
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({ CLAUDE_CONFIG_DIR: root, NODE_OPTIONS: "--max-old-space-size=256" }),
    );
    client.start();
    try {
      await expect(
        runCauseEffect(client.request("thread/start", { cwd: root, persistSession: false }, decodeRecordResponse)),
      ).rejects.toThrow("Stop before a provider is launched.");
      expect(captured).toHaveLength(1);
      const observed = captured[0];
      if (!observed) throw new Error("The MCP query boundary did not run.");
      expect(observed.sdkOnly).toBe(true);
      expect(observed.extraArgs).not.toContain(TOKEN);
      expect(observed.mcp).toEqual({
        mcpServers: { "example-mcp": { type: "http", url: server.url, headers: { Authorization: `Bearer ${TOKEN}` } } },
      });
      expect(observed.mode).toBe(0o600);
      expect(existsSync(observed.mcpFile)).toBe(false);
      expect(existsSync(observed.flagFile)).toBe(false);
      expect(existsSync(dirname(observed.mcpFile))).toBe(false);
      expect(existsSync(dirname(observed.flagFile))).toBe(false);
    } finally {
      await Effect.runPromise(client.stop());
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses an unwritable MCP file instead of returning inline credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "tommy-claude-mcp-refusal-"));
    try {
      await writeFile(join(root, "claude-mcp"), "Keep this existing file.");
      await expect(
        Effect.runPromise(
          writeClaudeMcpConfig(root, {
            example: { type: "http", url: "https://example.com/mcp", headers: { Authorization: TOKEN } },
          }),
        ),
      ).rejects.toThrow();
      expect(readFileSync(join(root, "claude-mcp"), "utf8")).toBe("Keep this existing file.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes marked files of a reaped process and preserves live, legacy and unknown owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "tommy-claude-orphan-test-"));
    const ended = spawn(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" });
    const deadPid = ended.pid;
    await once(ended, "close");
    if (deadPid === undefined) throw new Error("The scratch process did not start.");
    const live = spawn(process.execPath, ["--eval", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
    const livePid = live.pid;
    if (livePid === undefined) throw new Error("The scratch live process did not start.");
    try {
      for (const folder of ["claude-settings", "claude-mcp"] as const) {
        const directory = join(root, folder);
        await mkdir(directory);
        const dead = join(directory, `${deadPid}-${randomUUID()}.json`);
        const active = join(directory, `${livePid}-${randomUUID()}.json`);
        const own = join(directory, `${process.pid}-${randomUUID()}.json`);
        const legacy = join(directory, `${randomUUID()}.json`);
        const unknown = join(directory, "unknown-settings.json");
        for (const file of [dead, active, own, legacy, unknown]) await writeFile(file, TOKEN);
        const current =
          folder === "claude-settings"
            ? await Effect.runPromise(writeClaudeFlagSettings(root, { env: { ANTHROPIC_AUTH_TOKEN: TOKEN } }))
            : await Effect.runPromise(
                writeClaudeMcpConfig(root, {
                  example: { type: "http", url: "https://example.com/mcp", headers: { Authorization: TOKEN } },
                }),
              );
        expect(existsSync(dead)).toBe(false);
        for (const file of [active, own, legacy, unknown]) expect(readFileSync(file, "utf8")).toBe(TOKEN);
        expect(existsSync(current.path)).toBe(true);
        await Effect.runPromise(removeClaudeQuerySettings(current));
      }
    } finally {
      const closed = once(live, "close");
      live.stdin.end();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  });
});
