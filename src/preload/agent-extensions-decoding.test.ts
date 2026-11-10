// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeScopedAgentEvent } from "./agent-event-decoding";
import { decodeAgentSpeedSettingsFromMain, decodeBrowserProfileProxyFromMain } from "./agent-extensions-decoding";
import { decodeSavedSkillSuggestionFromMain, decodeSkillLearningFromMain } from "./skill-learning-decoding";
import { decodeVaultCodesFromMain, decodeVaultState } from "./vault-decoding";
import { decodeScopedVoiceLiveEventFromMain, decodeVoiceLiveSessionFromMain } from "./voice-live-decoding";
import { decodeWorkflowIntegrationCatalogFromMain } from "./workflow-decoding";

const PROFILE_ID = "0123456789abcdef0123456789abcdef";

describe("additive privileged IPC response boundaries", () => {
  it("rejects proxy passwords in either a field or an address", () => {
    const summary = { profileId: PROFILE_ID, address: "https://user@proxy.example.com:443", hasPassword: true };
    expect(decodeBrowserProfileProxyFromMain(summary)).toEqual(summary);
    expect(() => decodeBrowserProfileProxyFromMain({ ...summary, password: "private" })).toThrow();
    expect(() =>
      decodeBrowserProfileProxyFromMain({ ...summary, address: "https://user:private@proxy.example.com:443" }),
    ).toThrow();
    expect(() => decodeBrowserProfileProxyFromMain({ ...summary, address: "file:///private" })).toThrow();
  });

  it("keeps two-step availability and refuses a setup key in summaries and code answers", () => {
    const login = {
      id: "login-1",
      kind: "login",
      website: "example.com",
      username: "user",
      notes: "",
      hasPassword: true,
      hasTwoStep: true,
    };
    expect(decodeVaultState({ status: "ready", items: [login] }).items).toEqual([login]);
    expect(() => decodeVaultState({ status: "ready", items: [{ ...login, twoStepKey: "PRIVATE" }] })).toThrow();
    const code = { id: "login-1", code: "123456", period: 30, remainingMs: 29_000 };
    expect(decodeVaultCodesFromMain({ codes: [code] })).toEqual({ codes: [code] });
    expect(() => decodeVaultCodesFromMain({ codes: [{ ...code, secret: "PRIVATE" }] })).toThrow();
    expect(() => decodeVaultCodesFromMain({ codes: [{ ...code, remainingMs: 31_000 }] })).toThrow();
    expect(() => decodeVaultCodesFromMain({ codes: [{ ...code, code: "123456x" }] })).toThrow();
  });

  it("refuses invalid speed and learning settings before renderer state can use them", () => {
    expect(() => decodeAgentSpeedSettingsFromMain({ fastMode: false, ultrafast: true })).toThrow();
    expect(decodeAgentSpeedSettingsFromMain({ fastMode: true, ultrafast: true })).toEqual({
      fastMode: true,
      ultrafast: true,
    });
    expect(() => decodeSkillLearningFromMain({ mode: "ask", choices: [false] })).toThrow();
    expect(() => decodeSavedSkillSuggestionFromMain({ saved: "yes" })).toThrow();
  });

  it("bounds live voice events and keeps only their declared fields", () => {
    const event = { type: "transcript", sessionId: "voice-1", role: "user", text: "Hello", final: true };
    expect(decodeScopedVoiceLiveEventFromMain({ serverId: "local", event })).toEqual({ serverId: "local", event });
    expect(() =>
      decodeScopedVoiceLiveEventFromMain({ serverId: "local", event: { ...event, role: "system" } }),
    ).toThrow();
    expect(() =>
      decodeScopedVoiceLiveEventFromMain({ serverId: "local", event: { ...event, text: "x".repeat(100_001) } }),
    ).toThrow();
    expect(() => decodeVoiceLiveSessionFromMain({ sessionId: "voice-1", sdp: " " })).toThrow();
    expect(decodeVoiceLiveSessionFromMain({ sessionId: "voice-1", sdp: "v=0", secret: "PRIVATE" })).toEqual({
      sessionId: "voice-1",
      sdp: "v=0",
    });
  });

  it("bounds deletion batches and exposes only exact removed IDs", () => {
    const event = {
      type: "conversation-messages-deleted",
      agentId: "agent-1",
      threadId: "thread-1",
      messageIds: ["old-message"],
    };
    expect(decodeScopedAgentEvent({ serverId: "local", event: { ...event, privateData: "PRIVATE" } })).toEqual({
      serverId: "local",
      event,
    });
    expect(() => decodeScopedAgentEvent({ serverId: "local", event: { ...event, messageIds: [] } })).toThrow();
    expect(() =>
      decodeScopedAgentEvent({
        serverId: "local",
        event: { ...event, messageIds: Array.from({ length: 501 }, () => "message") },
      }),
    ).toThrow();
    expect(() => decodeScopedAgentEvent({ serverId: "local", event: { ...event, messageIds: [false] } })).toThrow();
  });
  it("does not retain extra connector credentials in renderer state", () => {
    const catalog = {
      github: false,
      places: [],
      telegram: [],
      discord: [],
      token: "PRIVATE",
      slack: [
        {
          connectionId: "slack-example",
          name: "Example",
          token: "PRIVATE",
          channels: [{ id: "channel-1", name: "general", secret: "PRIVATE" }],
        },
      ],
    };
    expect(decodeWorkflowIntegrationCatalogFromMain(catalog)).toEqual({
      github: false,
      places: [],
      telegram: [],
      discord: [],
      slack: [{ connectionId: "slack-example", name: "Example", channels: [{ id: "channel-1", name: "general" }] }],
    });
  });
});
