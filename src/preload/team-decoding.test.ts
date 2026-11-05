import type {
  HostStatus,
  ScopedTeamPresenceSnapshot,
  ServerSummary,
  TeamMemberSummary,
  TeamPresenceSnapshot,
  TeamSessionSummary,
} from "@tommy/contracts/ipc";
import { describe, expect, it } from "vitest";
import {
  decodeHostStatus,
  decodeScopedTeamPresence,
  decodeServer,
  decodeServers,
  decodeTeamMember,
  decodeTeamMembers,
  decodeTeamPresenceSnapshot,
  decodeTeamSessions,
} from "./team-decoding";

const hostStatus = {
  phase: "online",
  configured: true,
  enabledOnLaunch: false,
  serverId: "server-1",
  serverName: "Studio",
  apiUrl: "https://studio.example.test",
  logoUrl: null,
  apiOnline: true,
  message: null,
} satisfies HostStatus;

const member = {
  id: "member-1",
  username: "ada",
  email: "ada@example.test",
  name: null,
  role: "admin",
  createdAt: "2026-09-23T10:00:00.000Z",
  disabled: false,
} satisfies TeamMemberSummary;

const memberWithAvatar = { ...member, avatarUrl: "https://example.test/ada.png" } satisfies TeamMemberSummary;

const presence = {
  serverId: null,
  members: [{ ...member, online: true, typingAgentId: null }],
  updatedAt: "2026-09-23T10:00:00.000Z",
} satisfies TeamPresenceSnapshot;

const session = {
  id: "session-1",
  memberId: "member-1",
  username: "ada",
  createdAt: "2026-09-23T10:00:00.000Z",
  expiresAt: "2026-10-23T10:00:00.000Z",
} satisfies TeamSessionSummary;

const localServer = {
  notificationsMuted: false,
  notificationsMutedUntil: null,
  notificationLevel: "all",
  id: "local",
  name: "This computer",
  kind: "local",
  state: "online",
  apiUrl: null,
  logoUrl: null,
  role: null,
  active: true,
} satisfies ServerSummary;

const remoteServer = {
  ...localServer,
  notificationsMuted: true,
  notificationsMutedUntil: 1_790_000_000_000,
  notificationLevel: "needs-me",
  id: "server-1",
  name: "Studio",
  kind: "remote",
  state: "incompatible",
  apiUrl: "https://studio.example.test",
  role: "member",
  active: false,
  compatibility: {
    localAppVersion: "1.4.0",
    hostAppVersion: null,
    localProtocol: { minimum: 1, maximum: 3 },
    hostProtocol: null,
    negotiatedProtocol: null,
    capabilities: ["direct-messages"],
  },
  issue: { code: "host_update_required", message: "The host must update.", retryable: false },
  connectionSequence: 2,
} satisfies ServerSummary;

describe("team decoders", () => {
  it.each([
    ["host status", decodeHostStatus, hostStatus],
    ["team member", decodeTeamMember, member],
    ["team member with an avatar", decodeTeamMember, memberWithAvatar],
    ["team member list", decodeTeamMembers, [member, memberWithAvatar]],
    ["team presence", decodeTeamPresenceSnapshot, presence],
    ["team session list", decodeTeamSessions, [session]],
    ["local server", decodeServer, localServer],
    ["server list", decodeServers, [localServer, remoteServer]],
    ["server without a connection issue", decodeServer, { ...remoteServer, compatibility: null, issue: null }],
    ["server with a failed hosted start", decodeServer, { ...remoteServer, hostedIssue: "wake_failed" }],
    ["server with an ended plan", decodeServer, { ...remoteServer, hostedIssue: "plan_ended" }],
    ["server with an expired start", decodeServer, { ...remoteServer, hostedIssue: "start_timeout" }],
    [
      "server with a hosted start",
      decodeServer,
      { ...remoteServer, hostedSleep: "waking", hostedStart: { step: "provider_limit", startedAt: 1 } },
    ],
    ["server with no hosted start", decodeServer, { ...remoteServer, hostedStart: null }],
    ["server on this computer", decodeServer, { ...remoteServer, thisComputer: true }],
    ["server with a key change time", decodeServer, { ...remoteServer, keyChangedAt: 1_700_000_000_000 }],
    [
      "server presence",
      decodeScopedTeamPresence,
      { serverId: "server-1", snapshot: presence } satisfies ScopedTeamPresenceSnapshot,
    ],
  ] as const)("keeps a valid %s", (_name, decode: (value: unknown) => unknown, value) => {
    expect(decode(value)).toEqual(value);
  });

  it.each([
    ["host status with an unknown phase", decodeHostStatus, { ...hostStatus, phase: "sleeping" }],
    ["team member with an unknown role", decodeTeamMember, { ...member, role: "guest" }],
    ["team member with a numeric avatar", decodeTeamMember, { ...member, avatarUrl: 1 }],
    ["team member list that is not an array", decodeTeamMembers, member],
    ["team presence without typing state", decodeTeamPresenceSnapshot, { ...presence, members: [member] }],
    ["team session without a member", decodeTeamSessions, [{ ...session, memberId: null }]],
    ["server with an unknown state", decodeServers, [{ ...localServer, state: "asleep" }]],
    ["server without a role", decodeServer, { ...localServer, role: undefined }],
    [
      "server with an unknown issue code",
      decodeServer,
      { ...remoteServer, issue: { ...remoteServer.issue, code: "x" } },
    ],
    [
      "server with a malformed protocol range",
      decodeServer,
      { ...remoteServer, compatibility: { ...remoteServer.compatibility, localProtocol: { minimum: 1 } } },
    ],
    ["server with a text connection sequence", decodeServer, { ...remoteServer, connectionSequence: "2" }],
    ["server with an invalid hosted issue", decodeServer, { ...remoteServer, hostedIssue: "<script>" }],
    [
      "server with an invalid hosted start step",
      decodeServer,
      { ...remoteServer, hostedStart: { step: "<script>", startedAt: 1 } },
    ],
    ["server with a hosted start without a time", decodeServer, { ...remoteServer, hostedStart: { step: "machine" } }],
    ["server on this computer marked false", decodeServer, { ...remoteServer, thisComputer: false }],
    ["server with a text key change time", decodeServer, { ...remoteServer, keyChangedAt: "2026-10-31" }],
    ["server with a negative key change time", decodeServer, { ...remoteServer, keyChangedAt: -1 }],
    ["server presence without a server", decodeScopedTeamPresence, { snapshot: presence }],
  ] as const)("rejects a %s", (_name, decode: (value: unknown) => unknown, value) => {
    expect(() => decode(value)).toThrow(/^Invalid /);
  });
});
