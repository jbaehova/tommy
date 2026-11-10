import { EventEmitter } from "node:events";
import type { AgentSummary } from "@tommy/contracts/ipc";
import {
  decodeVoiceLiveEvent,
  decodeVoiceLiveSession,
  decodeVoiceLiveStart,
  type VoiceLiveEvent,
} from "@tommy/contracts/ipc-voice";
import { LIVE_VOICE_CODECS, LIVE_VOICE_ROUTES, liveVoiceEvent } from "@tommy/contracts/team-protocol/live-voice-v1";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { AgentClient } from "../agent-client";
import { runCauseEffect } from "../effect-boundary";
import type { AppServerNotification, ResponseDecoder } from "../protocol";
import { ProviderClientOperationError } from "../provider-client-effects";
import { LiveVoice, type LiveVoiceHooks } from "./live-voice";

const agent: AgentSummary = {
  id: "agent-test",
  name: "Tester",
  title: "Researcher",
  description: "Finds facts.",
  notifications: false,
  provider: "codex",
  model: "example-model",
  reasoningEffort: "medium",
  threadId: null,
  workspacePath: "/workspace",
  preview: "",
  updatedAt: null,
  avatarSeed: "agent-test",
  avatarHue: null,
  avatarUrl: null,
};

class VoiceClient extends EventEmitter implements AgentClient {
  readonly provider = "codex";
  readonly running = true;
  readonly requests: string[] = [];
  login = "chatgpt";
  notification: (value: AppServerNotification) => void = () => undefined;
  start(): void {}
  stop(): Effect.Effect<void> {
    return Effect.void;
  }
  request<T>(
    method: string,
    _params: unknown,
    decoder: ResponseDecoder<T>,
  ): Effect.Effect<T, ProviderClientOperationError> {
    return Effect.try({
      try: () => {
        this.requests.push(method);
        if (method === "account/read") return decoder({ account: { type: this.login }, requiresOpenaiAuth: true });
        if (method === "thread/realtime/start") {
          queueMicrotask(() =>
            this.notification({
              method: "thread/realtime/sdp",
              params: { threadId: "thread-test", sdp: "v=0\r\nanswer" },
            }),
          );
        }
        return decoder({});
      },
      catch: (cause) => new ProviderClientOperationError({ cause }),
    });
  }
  notify(): void {}
  respond(): void {}
  respondError(): void {}
}

function setup(overrides: Partial<LiveVoiceHooks> = {}) {
  const client = new VoiceClient();
  const events: Array<{ event: VoiceLiveEvent; owner: string }> = [];
  const speeches: string[] = [];
  let holds = 0;
  const voice = new LiveVoice({
    agent: () => agent,
    client: () => Effect.succeed(client),
    ensureThread: () => Effect.succeed("thread-test"),
    holdDrain: () => {
      holds += 1;
      let released = false;
      return () => {
        if (!released) holds -= 1;
        released = true;
      };
    },
    awaitIdle: () => Effect.void,
    addSpeech: (_agent, _thread, _role, text) => {
      speeches.push(text);
    },
    emit: (event, owner) => {
      events.push({ event, owner });
    },
    redact: (text) => text.replaceAll("example-secret", "[redacted]"),
    ...overrides,
  });
  client.notification = (notification) => voice.handleNotification(notification, client);
  return { client, voice, events, speeches, holds: () => holds };
}

const offer = { agentId: agent.id, sdp: "v=0\r\noffer" };

describe("live voice boundary", () => {
  it("keeps a foreign or stale owner from ending a call", async () => {
    const state = setup();
    try {
      const first = await runCauseEffect(state.voice.start(offer, "owner-a"));
      expect(state.holds()).toBe(1);
      await expect(runCauseEffect(state.voice.start(offer, "owner-b"))).rejects.toThrow();
      expect(state.holds()).toBe(1);
      await runCauseEffect(state.voice.stop(first.sessionId, "owner-b"));
      expect(state.voice.isLiveThread("thread-test")).toBe(true);
      expect(state.client.requests.filter((request) => request === "thread/realtime/stop")).toHaveLength(0);
      await runCauseEffect(state.voice.stop(first.sessionId, "owner-a"));
      expect(state.holds()).toBe(0);
      expect(state.events.every(({ owner }) => owner === "owner-a")).toBe(true);
      const second = await runCauseEffect(state.voice.start(offer, "owner-a"));
      await runCauseEffect(state.voice.stop(first.sessionId, "owner-a"));
      expect(state.voice.isLiveThread("thread-test")).toBe(true);
      await runCauseEffect(state.voice.stop(second.sessionId, "owner-a"));
    } finally {
      await runCauseEffect(state.voice.dispose());
    }
  });

  it("cancels a start whose authenticated connection closed", async () => {
    const entered = Promise.withResolvers<void>();
    const state = setup({ awaitIdle: () => Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Effect.never)) });
    const started = runCauseEffect(state.voice.start(offer, "closed-owner"));
    const outcome = started.then(
      () => "started",
      () => "cancelled",
    );
    await entered.promise;
    await runCauseEffect(state.voice.stopOwner("closed-owner"));
    expect(await outcome).toBe("cancelled");
    expect(state.holds()).toBe(0);
    expect(state.client.requests).not.toContain("thread/realtime/start");
    await runCauseEffect(state.voice.dispose());
  });

  it("uses the request nonce when Stop precedes the SDP answer", async () => {
    const entered = Promise.withResolvers<void>();
    const state = setup({ awaitIdle: () => Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Effect.never)) });
    const started = runCauseEffect(state.voice.start({ ...offer, requestId: "attempt-a" }, "owner"));
    const outcome = started.then(
      () => "started",
      () => "cancelled",
    );
    await entered.promise;
    await runCauseEffect(state.voice.cancel("attempt-b", "owner"));
    expect(state.holds()).toBe(1);
    await runCauseEffect(state.voice.cancel("attempt-a", "foreign-owner"));
    expect(state.holds()).toBe(1);
    await runCauseEffect(state.voice.cancel("attempt-a", "owner"));
    expect(await outcome).toBe("cancelled");
    expect(state.holds()).toBe(0);
    await runCauseEffect(state.voice.dispose());
  });

  it("refuses API-key auth instead of silently using API credits", async () => {
    const state = setup();
    state.client.login = "apiKey";
    await expect(runCauseEffect(state.voice.start(offer, "owner"))).rejects.toThrow();
    expect(state.holds()).toBe(0);
    expect(state.client.requests).not.toContain("thread/realtime/start");
    await runCauseEffect(state.voice.dispose());
  });

  it("ends the owner's call before account changes can reuse it", async () => {
    const ended = Promise.withResolvers<void>();
    const state = setup({
      emit: (event) => {
        if (event.type === "ended") ended.resolve();
      },
    });
    await runCauseEffect(state.voice.start(offer, "owner"));
    state.client.notification({ method: "account/updated", params: { authMode: null } });
    await ended.promise;
    expect(state.voice.isLiveThread("thread-test")).toBe(false);
    expect(state.holds()).toBe(0);
    await runCauseEffect(state.voice.dispose());
  });

  it("redacts transcripts and does not persist a duplicated transcript item", async () => {
    const state = setup();
    try {
      const session = await runCauseEffect(state.voice.start(offer, "owner-a"));
      const notification = {
        method: "thread/realtime/transcript/done",
        params: {
          threadId: "thread-test",
          itemId: "speech-1",
          role: "user",
          text: "example-secret",
        },
      };
      state.client.notification(notification);
      state.client.notification(notification);
      expect(state.speeches).toEqual(["[redacted]"]);
      expect(state.events.map(({ event }) => JSON.stringify(event)).join("")).not.toContain("example-secret");
      expect(
        state.events.every(({ owner, event }) => owner === "owner-a" && event.sessionId === session.sessionId),
      ).toBe(true);
    } finally {
      await runCauseEffect(state.voice.dispose());
    }
  });

  it("rejects oversized and malformed SDP or cross-session events", () => {
    expect(() => decodeVoiceLiveStart({ ...offer, sdp: "a".repeat(65_537) })).toThrow();
    expect(() => decodeVoiceLiveSession({ sessionId: "session", sdp: "" })).toThrow();
    expect(() =>
      decodeVoiceLiveEvent({ type: "transcript", sessionId: "", role: "user", text: "text", final: true }),
    ).toThrow();
    expect(() =>
      liveVoiceEvent({ type: "live-voice", kind: "ended", sessionId: "session", error: "x".repeat(4_001) }),
    ).toThrow();
    expect(() => LIVE_VOICE_CODECS.get(LIVE_VOICE_ROUTES.start)?.request({ ...offer, voice: "unknown" })).toThrow();
    expect(liveVoiceEvent({ type: "future-event" })).toBeNull();
  });
});
