import type { TommyDesktopApi } from "@tommy/contracts/ipc";
import { IPC_ENDPOINTS, LOCAL_SERVER_ID } from "@tommy/contracts/ipc";
import { beforeEach, expect, it, vi } from "vitest";

// `bridgeGroup` builds these methods from `IPC_ENDPOINTS`, so no line of the preload names them.
// These tests hold what the old literal methods held: the renderer sends at most its one input,
// and nothing main answers or pushes reaches the renderer undecoded.

const bridge = vi.hoisted(() => {
  // The main window: the preload reads its URL for the server of a chat window.
  vi.stubGlobal("window", { addEventListener: () => {}, location: { search: "" } });
  const api: { current: TommyDesktopApi | null } = { current: null };
  return {
    api,
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
    listeners: new Map<string, Set<(event: null, payload: unknown) => void>>(),
  };
});
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: TommyDesktopApi) => {
      bridge.api.current = api;
    },
  },
  webUtils: {},
  ipcRenderer: {
    invoke: bridge.invoke,
    on: (channel: string, callback: (event: null, payload: unknown) => void) => {
      const listeners = bridge.listeners.get(channel) ?? new Set();
      listeners.add(callback);
      bridge.listeners.set(channel, listeners);
    },
    removeListener: (channel: string, callback: (event: null, payload: unknown) => void) =>
      bridge.listeners.get(channel)?.delete(callback),
  },
}));

import "./index";

function api(): TommyDesktopApi {
  if (!bridge.api.current) throw new Error("The preload API was not exposed.");
  return bridge.api.current;
}

function send(channel: string, payload: unknown): void {
  for (const handler of bridge.listeners.get(channel) ?? []) handler(null, payload);
}

const status = { modelId: "gpt-live-transcribe", phase: "ready", progress: 100, message: null };

beforeEach(() => {
  bridge.invoke.mockReset();
});

it("sends at most one input, and none when the caller passes none", async () => {
  bridge.invoke.mockResolvedValue({ text: "Hello" });
  const input = { streamId: "stream" };

  // A second argument is not part of the signature, but a renderer can still pass one: a method
  // with fewer parameters fits a callback type that has more, such as an event handler.
  const finish: (value: typeof input, extra: string) => Promise<unknown> = api().voice.finishStream;
  await expect(finish(input, "extra")).resolves.toEqual({ text: "Hello" });
  expect(bridge.invoke).toHaveBeenLastCalledWith(IPC_ENDPOINTS.voice.finishStream.channel, input);

  bridge.invoke.mockResolvedValue(status);
  await expect(api().voice.getModelStatus()).resolves.toEqual(status);
  expect(bridge.invoke).toHaveBeenLastCalledWith(IPC_ENDPOINTS.voice.getModelStatus.channel);
});

// Main reads the server from the scope and routes to it, so a wrong server acts on another host.
it("scopes a request to the selected server unless the caller names one", async () => {
  bridge.invoke.mockResolvedValue([]);

  await api().agent.listMemories("agent-1");
  expect(bridge.invoke).toHaveBeenLastCalledWith(IPC_ENDPOINTS.agentMemories.listMemories.channel, {
    serverId: LOCAL_SERVER_ID,
    payload: "agent-1",
  });
  await api().agent.listMemories("agent-1", "remote-1");
  expect(bridge.invoke).toHaveBeenLastCalledWith(IPC_ENDPOINTS.agentMemories.listMemories.channel, {
    serverId: "remote-1",
    payload: "agent-1",
  });

  // A scope that carries nothing takes the server as its only argument.
  await api().agent.listAgents();
  expect(bridge.invoke).toHaveBeenLastCalledWith(IPC_ENDPOINTS.agent.listAgents.channel, {
    serverId: LOCAL_SERVER_ID,
    payload: null,
  });
  await api().agent.listAgents("remote-1");
  expect(bridge.invoke).toHaveBeenLastCalledWith(IPC_ENDPOINTS.agent.listAgents.channel, {
    serverId: "remote-1",
    payload: null,
  });
});

it("rejects a result that does not decode", async () => {
  bridge.invoke.mockResolvedValue({ phase: "unknown", progress: 100, message: null });

  await expect(api().voice.getModelStatus()).rejects.toThrow("Invalid voice model status.");
});

it("decodes an event and stops at unsubscribe", () => {
  const channel = IPC_ENDPOINTS.voice.streamTranscript.channel;
  const transcript = { streamId: "stream-1", text: "hello" };
  const listener = vi.fn();
  const stop = api().voice.onStreamTranscript(listener);

  send(channel, transcript);
  expect(listener).toHaveBeenCalledWith(transcript);
  expect(() => send(channel, { streamId: "stream-1" })).toThrow();

  stop();
  expect(bridge.listeners.get(channel)?.size).toBe(0);
  send(channel, transcript);
  expect(listener).toHaveBeenCalledTimes(1);
});
