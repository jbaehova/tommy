// @vitest-environment node
import { EventEmitter } from "node:events";
import { IPC_ENDPOINTS, type VoiceLiveSession } from "@tommy/contracts/ipc";
import { LIVE_VOICE_ROUTES } from "@tommy/contracts/team-protocol/live-voice-v1";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type LiveVoiceIpcService, remoteLiveVoiceEventTarget, voiceLiveIpcHandlers } from "./voice-live-handlers";

const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, payload: unknown) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, payload: unknown) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => {
    throw new Error("Deferred was not ready.");
  };
  const promise = new Promise<Value>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

class Sender extends EventEmitter {
  readonly id: number;
  #destroyed = false;
  constructor(id: number) {
    super();
    this.id = id;
  }
  isDestroyed() {
    return this.#destroyed;
  }
  destroy() {
    this.#destroyed = true;
    this.emit("destroyed");
  }
}

const remoteServers = {
  supportsCapability: () => false,
  request<T>(): Effect.Effect<T> {
    return Effect.die(new Error("Unexpected remote request."));
  },
};

function register(
  liveVoice: LiveVoiceIpcService,
  remote: Parameters<typeof voiceLiveIpcHandlers>[0]["remoteServers"] = remoteServers,
) {
  const handlers = voiceLiveIpcHandlers({ liveVoice, remoteServers: remote });
  handlers.startLive(IPC_ENDPOINTS.voice.startLive.channel);
  handlers.stopLive(IPC_ENDPOINTS.voice.stopLive.channel);
  handlers.cancelLive(IPC_ENDPOINTS.voice.cancelLive.channel);
}

interface VoiceTestPayload {
  agentId?: string;
  sdp?: string;
  sessionId?: string;
  requestId?: string;
  ownerId?: string;
}

function invoke(
  channel: string,
  sender: Sender,
  payload: VoiceTestPayload,
  trusted = true,
  serverId = "local",
): Promise<void> {
  const listener = registrations.get(channel);
  if (!listener) throw new Error("Missing test registration.");
  const result = listener(
    { sender, senderFrame: { url: trusted ? "tommy-app://app/index.html" : "https://untrusted.example.com/" } },
    { serverId, payload },
  );
  return Promise.resolve(result).then(() => {});
}

describe("live voice IPC ownership", () => {
  it("uses the trusted sender identity and refuses another window's stop", async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    register({
      start: (_input, owner) =>
        Effect.sync(() => {
          starts.push(owner);
          return { sessionId: "voice-1", sdp: "v=0" };
        }),
      stop: (sessionId, owner) =>
        Effect.sync(() => {
          stops.push(`${sessionId}:${owner}`);
        }),
      stopOwner: () => Effect.void,
      cancel: () => Effect.void,
    });
    const owner = new Sender(1);
    const other = new Sender(2);
    await invoke(IPC_ENDPOINTS.voice.startLive.channel, owner, { agentId: "agent-1", sdp: "v=0", ownerId: "forged" });
    expect(starts).toEqual(["local:1"]);
    await invoke(IPC_ENDPOINTS.voice.stopLive.channel, other, { sessionId: "voice-1" });
    expect(stops).toEqual([]);
    await invoke(IPC_ENDPOINTS.voice.stopLive.channel, owner, { sessionId: "voice-1" });
    expect(stops).toEqual(["voice-1:local:1"]);
  });

  it("stops a late session when its renderer dies during SDP setup", async () => {
    const pending = deferred<VoiceLiveSession>();
    const started = deferred<void>();
    const stopped: string[] = [];
    register({
      start: () =>
        Effect.promise(() => {
          started.resolve(undefined);
          return pending.promise;
        }),
      stop: (sessionId) =>
        Effect.sync(() => {
          stopped.push(sessionId);
        }),
      stopOwner: () => Effect.void,
      cancel: () => Effect.void,
    });
    const sender = new Sender(3);
    const answer = invoke(IPC_ENDPOINTS.voice.startLive.channel, sender, { agentId: "agent-1", sdp: "v=0" });
    await started.promise;
    sender.destroy();
    pending.resolve({ sessionId: "late-session", sdp: "v=0" });
    await expect(answer).rejects.toThrow();
    expect(stopped).toEqual(["late-session"]);
  });

  it("rejects an untrusted frame before the service runs", () => {
    let calls = 0;
    register({
      start: () =>
        Effect.sync(() => {
          calls += 1;
          return { sessionId: "voice-1", sdp: "v=0" };
        }),
      stop: () => Effect.void,
      stopOwner: () => Effect.void,
      cancel: () => Effect.void,
    });
    expect(() => invoke(IPC_ENDPOINTS.voice.startLive.channel, new Sender(4), {}, false)).toThrow(
      "Rejected IPC request from an untrusted renderer.",
    );
    expect(calls).toBe(0);
  });

  it("cancels a pending request before it starts after an earlier call closes", async () => {
    const closing = deferred<void>();
    let starts = 0;
    const cancelled: string[] = [];
    register({
      start: () =>
        Effect.sync(() => {
          starts += 1;
          return { sessionId: "voice-1", sdp: "v=0" };
        }),
      stop: () => Effect.void,
      stopOwner: () => Effect.promise(() => closing.promise),
      cancel: (requestId, owner) =>
        Effect.sync(() => {
          cancelled.push(`${requestId}:${owner}`);
        }),
    });
    const sender = new Sender(5);
    const answer = invoke(IPC_ENDPOINTS.voice.startLive.channel, sender, {
      agentId: "agent-1",
      sdp: "v=0",
      requestId: "request-1",
    });
    await invoke(IPC_ENDPOINTS.voice.cancelLive.channel, sender, { requestId: "request-1" });
    closing.resolve(undefined);
    await expect(answer).rejects.toThrow();
    expect(starts).toBe(0);
    expect(cancelled).toEqual(["request-1:local:5"]);
  });

  it("routes remote speech only to its starting window and clears targets on each exit path", async () => {
    const stops: string[] = [];
    let next = 0;
    register(
      {
        start: () => Effect.die("unexpected local start"),
        stop: () => Effect.void,
        stopOwner: () => Effect.void,
        cancel: () => Effect.void,
      },
      {
        supportsCapability: () => true,
        request: (serverId, path, decode) =>
          Effect.sync(() => {
            if (path === LIVE_VOICE_ROUTES.stop) stops.push(serverId);
            return decode(path === LIVE_VOICE_ROUTES.start ? { sessionId: `remote-voice-${++next}`, sdp: "v=0" } : {});
          }),
      },
    );
    const sender = new Sender(11);
    const other = new Sender(12);
    const event = {
      type: "transcript",
      sessionId: "remote-voice-1",
      role: "user",
      text: "private speech",
      final: true,
    } as const;
    await invoke(IPC_ENDPOINTS.voice.startLive.channel, sender, { agentId: "agent-1", sdp: "v=0" }, true, "host-a");
    expect(remoteLiveVoiceEventTarget("host-a", event)?.id).toBe(sender.id);
    expect(remoteLiveVoiceEventTarget("host-b", event)).toBeNull();
    await invoke(IPC_ENDPOINTS.voice.stopLive.channel, other, { sessionId: event.sessionId }, true, "host-a");
    expect(remoteLiveVoiceEventTarget("host-a", event)?.id).toBe(sender.id);
    await invoke(IPC_ENDPOINTS.voice.startLive.channel, sender, { agentId: "agent-1", sdp: "v=0" }, true, "host-b");
    expect(stops).toEqual(["host-a"]);
    expect(remoteLiveVoiceEventTarget("host-a", event)).toBeNull();
    const current = { ...event, sessionId: "remote-voice-2" };
    expect(remoteLiveVoiceEventTarget("host-b", { type: "ended", sessionId: current.sessionId, error: null })?.id).toBe(
      sender.id,
    );
    expect(remoteLiveVoiceEventTarget("host-b", current)).toBeNull();
    await invoke(IPC_ENDPOINTS.voice.startLive.channel, sender, { agentId: "agent-1", sdp: "v=0" }, true, "host-a");
    await invoke(IPC_ENDPOINTS.voice.stopLive.channel, sender, { sessionId: "remote-voice-3" }, true, "host-a");
    expect(remoteLiveVoiceEventTarget("host-a", { ...event, sessionId: "remote-voice-3" })).toBeNull();
    await invoke(IPC_ENDPOINTS.voice.startLive.channel, sender, { agentId: "agent-1", sdp: "v=0" }, true, "host-a");
    sender.destroy();
    expect(remoteLiveVoiceEventTarget("host-a", { ...event, sessionId: "remote-voice-4" })).toBeNull();
  });

  it("never registers a cancelled late remote session as an event target", async () => {
    const started = deferred<void>();
    const answer = deferred<VoiceLiveSession>();
    const paths: string[] = [];
    register(
      {
        start: () => Effect.die("unexpected local start"),
        stop: () => Effect.void,
        stopOwner: () => Effect.void,
        cancel: () => Effect.void,
      },
      {
        supportsCapability: () => true,
        request: (_serverId, path, decode) => {
          paths.push(path);
          return path === LIVE_VOICE_ROUTES.start
            ? Effect.promise(() => {
                started.resolve(undefined);
                return answer.promise;
              }).pipe(Effect.map(decode))
            : Effect.sync(() => decode({}));
        },
      },
    );
    const sender = new Sender(13);
    const pending = invoke(
      IPC_ENDPOINTS.voice.startLive.channel,
      sender,
      { agentId: "agent-1", requestId: "request-remote", sdp: "v=0" },
      true,
      "host-c",
    );
    await started.promise;
    await invoke(IPC_ENDPOINTS.voice.cancelLive.channel, sender, { requestId: "request-remote" }, true, "host-c");
    answer.resolve({ sessionId: "cancelled-voice", sdp: "v=0" });
    await expect(pending).rejects.toThrow();
    expect(paths).toEqual([LIVE_VOICE_ROUTES.start, LIVE_VOICE_ROUTES.cancel, LIVE_VOICE_ROUTES.stop]);
    expect(
      remoteLiveVoiceEventTarget("host-c", { type: "ended", sessionId: "cancelled-voice", error: null }),
    ).toBeNull();
  });
});
