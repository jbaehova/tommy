// @vitest-environment node

import {
  decodeVoiceLiveCancel,
  decodeVoiceLiveStart,
  decodeVoiceLiveStop,
  type VoiceModelStatus,
  type VoiceSettings,
  type VoiceStream,
  type VoiceTranscriptionResult,
} from "@tommy/contracts/ipc";
import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { agentRequest } from "./agent-inputs";
import { eventPayloadHandler, handler, payloadHandler, registerIpcGroup } from "./define-ipc-group";
import { parseVoiceApiKey, parseVoiceStream, parseVoiceStreamAudio } from "./voice-inputs";

// Same reason as trusted-ipc.test.ts: electron cannot be imported outside an Electron process, and
// ipcMain is the only thing the wrappers touch, so registrations are captured rather than performed.
const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, ...arguments_: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, ...arguments_: unknown[]) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

const TRUSTED_EVENT = { senderFrame: { url: "tommy-app://app/index.html" } };
const UNTRUSTED_EVENT = { senderFrame: { url: "https://evil.example/index.html" } };

const READY: VoiceModelStatus = { modelId: "gpt-live-transcribe", phase: "ready", progress: null, message: null };

const SETTINGS: VoiceSettings = { modelId: "gpt-live-transcribe", language: "automatic" };

// `voice` is the group under test because it has all three shapes: a request that takes nothing, a
// request that takes a payload, and an event the main process only ever sends.
// With `withEvent`, `transcribe` is bound with `eventPayloadHandler` and also gets the invoke event.
function decodeNote(value: unknown): VoiceStream {
  return { streamId: String(value) };
}

function registerVoice(
  transcribe: (input: VoiceStream, event?: IpcMainInvokeEvent) => VoiceTranscriptionResult,
  withEvent = false,
): void {
  registerIpcGroup("voice", {
    startLive: payloadHandler(agentRequest(decodeVoiceLiveStart), () => ({ sessionId: "voice-session", sdp: "v=0" })),
    stopLive: payloadHandler(agentRequest(decodeVoiceLiveStop), () => undefined),
    cancelLive: payloadHandler(agentRequest(decodeVoiceLiveCancel), () => undefined),
    getModelStatus: handler(() => READY),
    prepareModel: handler(() => READY),
    getSettings: handler(() => SETTINGS),
    setApiKey: payloadHandler(parseVoiceApiKey, () => READY),
    startStream: handler(() => ({ streamId: "stream" })),
    appendStream: payloadHandler(parseVoiceStreamAudio, () => undefined),
    finishStream: withEvent
      ? eventPayloadHandler(decodeNote, (event, input) => transcribe(input, event))
      : payloadHandler(decodeNote, (input) => transcribe(input)),
    cancelStream: payloadHandler(parseVoiceStream, () => undefined),
  });
}

// The type checker owns which endpoints a group has to be given a handler for; what it cannot show
// is what `registerIpcGroup` then does with them. Two things have to hold, and neither is visible in
// the types: the channel a handler ends up on is the one its endpoint declares, and the indirection
// does not step around the sender check that every handler used to be registered behind directly.
describe("IPC group registration", () => {
  it("registers each request endpoint on the channel it declares, and no event", () => {
    registerVoice((input) => ({ text: `heard ${input.streamId}` }));

    expect(registrations.get("voice:get-model-status")?.(TRUSTED_EVENT)).toBe(READY);
    expect(registrations.get("voice:finish-stream")?.(TRUSTED_EVENT, "a note")).toEqual({ text: "heard a note" });
    expect(registrations.has("voice:model-status")).toBe(false);
  });

  it("keeps a bound handler behind the sender check", () => {
    let handled = 0;
    registerVoice(() => {
      handled += 1;
      return { text: "" };
    });

    expect(() => registrations.get("voice:finish-stream")?.(UNTRUSTED_EVENT, "a note")).toThrow(
      "Rejected IPC request from an untrusted renderer.",
    );
    expect(handled).toBe(0);
  });

  it("keeps an event-and-payload handler behind the sender check, and gives it the sender's event", () => {
    const events: unknown[] = [];
    registerVoice((_input, event) => {
      events.push(event);
      return { text: "" };
    }, true);

    expect(() => registrations.get("voice:finish-stream")?.(UNTRUSTED_EVENT, "a note")).toThrow(
      "Rejected IPC request from an untrusted renderer.",
    );
    expect(events).toEqual([]);
    registrations.get("voice:finish-stream")?.(TRUSTED_EVENT, "a note");
    expect(events).toEqual([TRUSTED_EVENT]);
  });
});
