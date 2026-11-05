import type {
  AccountSession,
  AppAppearancePreference,
  AppInfo,
  ApprovalAutomationPreference,
  AppSetupState,
  AppThemePalette,
  CentralAuthState,
  MobileConnectedDevice,
  NotificationOpenedEvent,
  UpdateStatus,
} from "@tommy/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  decodeAccountSessions,
  decodeAppAppearancePreference,
  decodeAppInfo,
  decodeAppLanguagePreference,
  decodeApprovalAutomationPreference,
  decodeAppSetupState,
  decodeCentralAuthState,
  decodeChatWindowTargets,
  decodeMobileConnectedDevices,
  decodeMobileConnectTicket,
  decodeNotificationOpenedEvent,
  decodeNotificationPreference,
  decodePendingMarketplaceListing,
  decodeUpdatePreference,
  decodeUpdateStatus,
  decodeVoiceServerProbe,
  decodeVoiceServerSettings,
} from "./app-decoding";

const omarchyPalette = {
  id: "omarchy",
  name: "Omarchy",
  scheme: "dark",
  colors: {
    canvas: "#1a1b26",
    frame: "#13141c",
    sidebar: "#13141c",
    surface: "#24283b",
    text: "#a9b1d6",
    textMuted: "#565f89",
    border: "#414868",
    accent: "#7aa2f7",
    accentForeground: "#1a1b26",
    success: "#9ece6a",
    warning: "#e0af68",
    danger: "#f7768e",
  },
} satisfies AppThemePalette;

const updateStatus = {
  phase: "downloading",
  currentVersion: "1.0.0",
  availableVersion: "1.1.0",
  progress: 40,
  checkedAt: "2026-09-23T10:00:00.000Z",
  message: null,
  errorCode: null,
} satisfies UpdateStatus;

const codeSent = {
  status: "code_sent",
  challengeId: "challenge-1",
  email: "user@example.com",
  expiresAt: 2,
  resendAvailableAt: 1,
} satisfies CentralAuthState;

// Each value is what main sends, typed as its contract, so it must come back unchanged.
const voiceServer = {
  address: "http://studio.local:8000/v1",
  hasApiKey: true,
  routes: {
    dictation: true,
    speech: false,
    transcriptionModel: "Systran/faster-whisper-large-v3",
    speechModel: null,
    voice: null,
  },
};

const valid: [string, (value: unknown) => unknown, unknown][] = [
  ["a voice server", decodeVoiceServerSettings, voiceServer],
  ["no voice server", decodeVoiceServerSettings, null],
  [
    "a voice server test that found models",
    decodeVoiceServerProbe,
    { ok: true, models: { transcription: ["whisper-1"], speech: ["kokoro"], voices: ["af_heart"] } },
  ],
  [
    "a voice server test that failed",
    decodeVoiceServerProbe,
    { ok: false, field: "apiKey", message: "studio.local:8000 refused the API key." },
  ],
  [
    "app info",
    decodeAppInfo,
    { name: "Tommy", version: "1.0.0", platform: "darwin", variant: "dev" } satisfies AppInfo,
  ],
  [
    "app info with an install ID",
    decodeAppInfo,
    {
      name: "Tommy",
      version: "1.0.0",
      platform: "darwin",
      variant: "production",
    } satisfies AppInfo,
  ],
  [
    "setup state",
    decodeAppSetupState,
    { completed: true, preferredProvider: "codex", preferredModel: null } satisfies AppSetupState,
  ],
  [
    "approval automation",
    decodeApprovalAutomationPreference,
    {
      defaultAutoApprove: true,
      autoApproveOverrides: { "agent-1": false },
    } satisfies ApprovalAutomationPreference,
  ],
  ["language preference", decodeAppLanguagePreference, { language: "ko" }],
  [
    "appearance preference",
    decodeAppAppearancePreference,
    { appearance: "light", transparentWindow: true, palette: null, palettes: [] } satisfies AppAppearancePreference,
  ],
  [
    "appearance preference with a theme palette",
    decodeAppAppearancePreference,
    { appearance: "dark", transparentWindow: false, palette: "omarchy", palettes: [omarchyPalette] },
  ],
  ["signed out", decodeCentralAuthState, { status: "signed_out" } satisfies CentralAuthState],
  ["code sent", decodeCentralAuthState, codeSent],
  [
    "code sent with every option",
    decodeCentralAuthState,
    {
      ...codeSent,
      developmentCode: "123456",
      issue: { code: "rate_limited", message: "Wait.", retryAfterSeconds: 30 },
    } satisfies CentralAuthState,
  ],
  [
    "signed in",
    decodeCentralAuthState,
    {
      status: "signed_in",
      user: { id: "user-1", email: "user@example.com", name: null, avatarUrl: null },
    } satisfies CentralAuthState,
  ],
  [
    "signed in with an analytics answer",
    decodeCentralAuthState,
    {
      status: "signed_in",
      user: { id: "user-1", email: "user@example.com", name: null, avatarUrl: null },
    } satisfies CentralAuthState,
  ],
  [
    "account error",
    decodeCentralAuthState,
    { status: "error", issue: { code: "offline", message: "No network." } } satisfies CentralAuthState,
  ],
  ["Mobile Connect ticket", decodeMobileConnectTicket, { qrData: "tommy://mobile-connect", expiresAt: 1 }],
  [
    "connected devices",
    decodeMobileConnectedDevices,
    [
      { sessionId: "session-1", name: "Phone", platform: "ios", connectedAt: 1, lastActiveAt: 2, via: "link" },
    ] satisfies MobileConnectedDevice[],
  ],
  [
    "account sessions",
    decodeAccountSessions,
    [
      { sessionId: "session-1", name: "Mac", kind: "desktop", current: true, connectedAt: 1, lastActiveAt: 2 },
    ] satisfies AccountSession[],
  ],
  ["update status", decodeUpdateStatus, updateStatus],
  ["host-managed update status", decodeUpdateStatus, { ...updateStatus, managedByHost: true } satisfies UpdateStatus],
  ["update preference", decodeUpdatePreference, { autoDownload: true, allowRemoteUpdates: true, autoInstall: false }],
  ["notification preference", decodeNotificationPreference, { desktopNotifications: true, messagePreview: false }],
  [
    "opened notification",
    decodeNotificationOpenedEvent,
    { serverId: "local", agentId: "agent-1", threadId: null } satisfies NotificationOpenedEvent,
  ],
  [
    "opened channel notification",
    decodeNotificationOpenedEvent,
    { serverId: "local", agentId: "agent-1", threadId: null, channelId: "channel-1" } satisfies NotificationOpenedEvent,
  ],
  ["chat windows", decodeChatWindowTargets, [{ serverId: "local", agentId: "agent-1" }]],
];

const malformed: [string, (value: unknown) => unknown, unknown][] = [
  // The key never comes back to the renderer, so a record that carries one fails closed.
  ["a voice server with its key", decodeVoiceServerSettings, { ...voiceServer, apiKey: "sk-secret" }],
  [
    "a voice server that dictates with no model",
    decodeVoiceServerSettings,
    { ...voiceServer, routes: { ...voiceServer.routes, transcriptionModel: null } },
  ],
  [
    "a voice server that speaks with no voice",
    decodeVoiceServerSettings,
    { ...voiceServer, routes: { ...voiceServer.routes, speech: true, speechModel: "kokoro", voice: null } },
  ],
  ["a voice server test with an unknown field", decodeVoiceServerProbe, { ok: false, field: "model", message: "" }],
  [
    "a voice server test with an empty model",
    decodeVoiceServerProbe,
    { ok: true, models: { transcription: [""], speech: [], voices: [] } },
  ],
  ["app info on an unknown platform", decodeAppInfo, { name: "Tommy", version: "1", platform: "aix", variant: "dev" }],
  [
    "setup state with an unknown provider",
    decodeAppSetupState,
    { completed: true, preferredProvider: "other", preferredModel: null },
  ],
  ["approval automation without overrides", decodeApprovalAutomationPreference, { defaultAutoApprove: true }],
  ["language preference with an unknown tag", decodeAppLanguagePreference, { language: "xx" }],
  ["appearance preference with no transparent window", decodeAppAppearancePreference, { appearance: "dark" }],
  [
    "appearance preference with a string transparent window",
    decodeAppAppearancePreference,
    { appearance: "dark", transparentWindow: "true" },
  ],
  [
    "appearance preference with no theme palettes",
    decodeAppAppearancePreference,
    { appearance: "dark", transparentWindow: false, palette: null },
  ],
  [
    "a theme palette id with a path",
    decodeAppAppearancePreference,
    { appearance: "dark", transparentWindow: false, palette: "../omarchy", palettes: [] },
  ],
  [
    "a theme palette color that is not hex",
    decodeAppAppearancePreference,
    {
      appearance: "dark",
      transparentWindow: false,
      palette: null,
      palettes: [{ ...omarchyPalette, colors: { ...omarchyPalette.colors, accent: "red; background: url(x)" } }],
    },
  ],
  [
    "a theme palette with a missing color",
    decodeAppAppearancePreference,
    {
      appearance: "dark",
      transparentWindow: false,
      palette: null,
      palettes: [{ ...omarchyPalette, colors: { canvas: "#1a1b26" } }],
    },
  ],
  ["an unknown account status", decodeCentralAuthState, { status: "banned" }],
  ["signed in without a user", decodeCentralAuthState, { status: "signed_in" }],
  ["code sent with a text expiry", decodeCentralAuthState, { ...codeSent, expiresAt: "soon" }],
  ["Mobile Connect ticket without data", decodeMobileConnectTicket, { expiresAt: 1 }],
  ["a device on an unknown platform", decodeMobileConnectedDevices, [{ sessionId: "s", name: "n", platform: "tv" }]],
  ["account sessions that are not a list", decodeAccountSessions, { sessionId: "s" }],
  ["update status in an unknown phase", decodeUpdateStatus, { ...updateStatus, phase: "done" }],
  ["update status with an unknown failure", decodeUpdateStatus, { ...updateStatus, errorCode: "boom" }],
  ["update preference without a switch", decodeUpdatePreference, null],
  ["notification preference without a switch", decodeNotificationPreference, { desktopNotifications: "yes" }],
  ["opened notification without an agent", decodeNotificationOpenedEvent, { serverId: "local", threadId: null }],
  [
    "opened notification with a non-string channel",
    decodeNotificationOpenedEvent,
    { serverId: "local", agentId: "agent-1", threadId: null, channelId: 7 },
  ],
  ["a chat window without an agent", decodeChatWindowTargets, [{ serverId: "local" }]],
  ["chat windows that are not a list", decodeChatWindowTargets, { serverId: "local", agentId: "agent-1" }],
  // A scan row never carries a credential, so one that does is refused with the whole list.
  // A custom agent summary never carries an environment value, so one that does is refused with the whole list.
];

describe("app decoding", () => {
  it.each(valid)("keeps %s unchanged", (_name, decode, value) => {
    expect(decode(value)).toEqual(value);
  });

  it.each(malformed)("rejects %s", (_name, decode, value) => {
    expect(() => decode(value)).toThrow(/^Invalid /);
  });
});

const AGENT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

// A Marketplace link began in a URL a web page chose. Only an agent id or a skill slug of the right
// form reaches the renderer, with no other field; anything else is no link at all.
describe("pending Marketplace listing", () => {
  it.each([
    ["an agent", { kind: "agent", id: AGENT_ID }],
    ["a skill", { kind: "skill", id: "release-notes" }],
  ])("keeps %s", (_name, value) => {
    expect(decodePendingMarketplaceListing(value)).toEqual(value);
  });

  it("drops a field main did not name", () => {
    expect(decodePendingMarketplaceListing({ kind: "skill", id: "release-notes", install: true })).toEqual({
      kind: "skill",
      id: "release-notes",
    });
  });

  it.each([
    ["no link", null],
    ["a bare slug", "release-notes"],
    ["an unknown kind", { kind: "plugin", id: "release-notes" }],
    ["an agent with a slug", { kind: "agent", id: "release-notes" }],
    ["an agent id in upper case", { kind: "agent", id: AGENT_ID.toUpperCase() }],
    ["a skill with a path", { kind: "skill", id: "../account" }],
    ["a skill with a dot", { kind: "skill", id: "notes.md" }],
    ["a skill slug over 64 characters", { kind: "skill", id: "a".repeat(65) }],
    ["an empty id", { kind: "skill", id: "" }],
    ["an id that is not text", { kind: "agent", id: 42 }],
  ])("refuses %s", (_name, value) => {
    expect(decodePendingMarketplaceListing(value)).toBeNull();
  });
});
