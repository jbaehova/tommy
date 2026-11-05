// What main answers for team servers, the team host, its members and invites, direct messages, and
// remote desktop sessions.
//
// Each decoder checks every field the contract type requires and keeps each optional field it
// carries, so a value the renderer reads always has the shape its type says.

import {
  type HostedServerIssue,
  type HostedServerStart,
  type HostStatus,
  type ScopedTeamPresenceSnapshot,
  SERVER_NOTIFICATION_LEVELS,
  type ServerCompatibility,
  type ServerConnectionIssue,
  type ServerSummary,
  type TeamMemberSummary,
  type TeamPresenceMember,
  type TeamPresenceSnapshot,
  type TeamRole,
  type TeamSessionSummary,
} from "@tommy/contracts/ipc";
import {
  decodeList,
  decodeRecord,
  nullableNumber,
  nullableString,
  requiredBoolean,
  requiredNumber,
  requiredString,
} from "@tommy/contracts/ipc-decoding";
import { type DynamicRecord, isBoolean, isNumber, isOneOf, isString } from "@tommy/contracts/runtime-values";

const HOST_PHASES = ["unconfigured", "idle", "starting", "online", "stopping", "error"] as const;
const TEAM_ROLES = ["owner", "admin", "member"] as const;
const SERVER_KINDS = ["local", "remote"] as const;
const SERVER_STATES = ["online", "connecting", "offline", "error", "incompatible"] as const;
const SERVER_ISSUE_CODES = [
  "client_update_required",
  "host_update_required",
  "protocol_error",
  "authentication_required",
  "network_unavailable",
] as const;

export function decodeServer(value: unknown): ServerSummary {
  return server(decodeRecord(value, "server"));
}

export function decodeServers(value: unknown): ServerSummary[] {
  return decodeList(value, "server list", server);
}

export function decodeHostStatus(value: unknown): HostStatus {
  const status = decodeRecord(value, "host status");
  if (!isOneOf(HOST_PHASES, status.phase)) throw new Error("Invalid phase.");
  return {
    phase: status.phase,
    configured: requiredBoolean(status, "configured"),
    enabledOnLaunch: requiredBoolean(status, "enabledOnLaunch"),
    serverId: nullableString(status, "serverId"),
    serverName: nullableString(status, "serverName"),
    apiUrl: nullableString(status, "apiUrl"),
    logoUrl: nullableString(status, "logoUrl"),
    apiOnline: requiredBoolean(status, "apiOnline"),
    message: nullableString(status, "message"),
  };
}

export function decodeTeamMember(value: unknown): TeamMemberSummary {
  return teamMember(decodeRecord(value, "team member"));
}

export function decodeTeamMembers(value: unknown): TeamMemberSummary[] {
  return decodeList(value, "team member list", teamMember);
}

export function decodeTeamPresenceSnapshot(value: unknown): TeamPresenceSnapshot {
  const snapshot = decodeRecord(value, "team presence");
  return {
    serverId: nullableString(snapshot, "serverId"),
    members: decodeList(snapshot.members, "team presence member list", presenceMember),
    updatedAt: requiredString(snapshot, "updatedAt"),
  };
}

export function decodeScopedTeamPresence(value: unknown): ScopedTeamPresenceSnapshot {
  const scoped = decodeRecord(value, "server presence");
  return { serverId: requiredString(scoped, "serverId"), snapshot: decodeTeamPresenceSnapshot(scoped.snapshot) };
}

export function decodeTeamSessions(value: unknown): TeamSessionSummary[] {
  return decodeList(value, "team session list", (session) => ({
    id: requiredString(session, "id"),
    memberId: requiredString(session, "memberId"),
    username: requiredString(session, "username"),
    createdAt: requiredString(session, "createdAt"),
    expiresAt: requiredString(session, "expiresAt"),
  }));
}

function server(summary: DynamicRecord): ServerSummary {
  const {
    notificationLevel,
    kind,
    state,
    role,
    compatibility,
    issue,
    connectionSequence,
    hostRestart,
    hostedSleep,
    hostedIssue,
    hostedStart,
    memberLimit,
    hosted,
    keyChangedAt,
    thisComputer,
  } = summary;
  if (!isOneOf(SERVER_NOTIFICATION_LEVELS, notificationLevel)) throw new Error("Invalid notificationLevel.");
  if (!isOneOf(SERVER_KINDS, kind)) throw new Error("Invalid kind.");
  if (!isOneOf(SERVER_STATES, state)) throw new Error("Invalid state.");
  if (connectionSequence !== undefined && !isNumber(connectionSequence)) throw new Error("Invalid connectionSequence.");
  if (memberLimit !== undefined && !(isNumber(memberLimit) && Number.isSafeInteger(memberLimit) && memberLimit >= 1)) {
    throw new Error("Invalid memberLimit.");
  }
  if (hosted !== undefined && !isBoolean(hosted)) throw new Error("Invalid hosted.");
  if (
    keyChangedAt !== undefined &&
    !(isNumber(keyChangedAt) && Number.isSafeInteger(keyChangedAt) && keyChangedAt >= 0)
  ) {
    throw new Error("Invalid keyChangedAt.");
  }
  if (thisComputer !== undefined && thisComputer !== true) throw new Error("Invalid thisComputer.");
  return {
    notificationsMuted: requiredBoolean(summary, "notificationsMuted"),
    notificationsMutedUntil: nullableNumber(summary, "notificationsMutedUntil"),
    notificationLevel,
    id: requiredString(summary, "id"),
    name: requiredString(summary, "name"),
    kind,
    state,
    apiUrl: nullableString(summary, "apiUrl"),
    logoUrl: nullableString(summary, "logoUrl"),
    role: role === null ? null : teamRole(role),
    active: requiredBoolean(summary, "active"),
    ...(compatibility === undefined
      ? {}
      : { compatibility: compatibility === null ? null : serverCompatibility(compatibility) }),
    ...(issue === undefined ? {} : { issue: issue === null ? null : serverIssue(issue) }),
    ...(connectionSequence === undefined ? {} : { connectionSequence }),
    ...(hostRestart === undefined ? {} : { hostRestart: hostRestart === null ? null : serverHostRestart(hostRestart) }),
    // Only the indicator reads it, so a value from a newer main process shows no indicator.
    ...(hostedSleep === undefined
      ? {}
      : { hostedSleep: hostedSleep === "sleeping" || hostedSleep === "waking" ? hostedSleep : null }),
    ...(hostedIssue === undefined ? {} : { hostedIssue: decodeHostedIssue(hostedIssue) }),
    ...(hostedStart === undefined ? {} : { hostedStart: decodeHostedStart(hostedStart) }),
    ...(memberLimit === undefined ? {} : { memberLimit }),
    ...(hosted === undefined ? {} : { hosted }),
    ...(keyChangedAt === undefined ? {} : { keyChangedAt }),
    ...(thisComputer === undefined ? {} : { thisComputer }),
  };
}

function serverHostRestart(value: unknown): NonNullable<ServerSummary["hostRestart"]> {
  const restart = decodeRecord(value, "server host restart");
  const { state } = restart;
  if (state !== "waiting" && state !== "restarting") throw new Error("Invalid hostRestart.");
  return { state, version: nullableString(restart, "version") };
}

function serverCompatibility(value: unknown): ServerCompatibility {
  const compatibility = decodeRecord(value, "server compatibility");
  const { capabilities, hostProtocol } = compatibility;
  if (!Array.isArray(capabilities) || !capabilities.every(isString)) throw new Error("Invalid capabilities.");
  return {
    localAppVersion: requiredString(compatibility, "localAppVersion"),
    hostAppVersion: nullableString(compatibility, "hostAppVersion"),
    localProtocol: protocolRange(compatibility.localProtocol),
    hostProtocol: hostProtocol === null ? null : protocolRange(hostProtocol),
    negotiatedProtocol: nullableNumber(compatibility, "negotiatedProtocol"),
    capabilities,
  };
}

function protocolRange(value: unknown): { minimum: number; maximum: number } {
  const range = decodeRecord(value, "protocol range");
  return { minimum: requiredNumber(range, "minimum"), maximum: requiredNumber(range, "maximum") };
}

function serverIssue(value: unknown): ServerConnectionIssue {
  const issue = decodeRecord(value, "server connection issue");
  if (!isOneOf(SERVER_ISSUE_CODES, issue.code)) throw new Error("Invalid code.");
  const { reference } = issue;
  if (reference !== undefined && !isString(reference)) throw new Error("Invalid reference.");
  return {
    code: issue.code,
    message: requiredString(issue, "message"),
    retryable: requiredBoolean(issue, "retryable"),
    ...(reference === undefined ? {} : { reference }),
  };
}

function teamMember(member: DynamicRecord): TeamMemberSummary {
  const { avatarUrl } = member;
  if (avatarUrl !== undefined && avatarUrl !== null && !isString(avatarUrl)) {
    throw new Error("Invalid avatarUrl.");
  }
  return {
    id: requiredString(member, "id"),
    username: requiredString(member, "username"),
    email: nullableString(member, "email"),
    name: nullableString(member, "name"),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    role: teamRole(member.role),
    createdAt: requiredString(member, "createdAt"),
    disabled: requiredBoolean(member, "disabled"),
  };
}

function presenceMember(member: DynamicRecord): TeamPresenceMember {
  return {
    ...teamMember(member),
    online: requiredBoolean(member, "online"),
    typingAgentId: nullableString(member, "typingAgentId"),
  };
}

function teamRole(value: unknown): TeamRole {
  if (!isOneOf(TEAM_ROLES, value)) throw new Error("Invalid role.");
  return value;
}

function decodeHostedIssue(value: unknown): HostedServerIssue | null {
  if (value === null || value === "plan_ended" || value === "wake_failed" || value === "start_timeout") return value;
  throw new Error("Invalid hostedIssue.");
}

function decodeHostedStart(value: unknown): HostedServerStart | null {
  if (value === null) return null;
  const start = decodeRecord(value, "hosted start");
  const { step } = start;
  if (step !== "machine" && step !== "tommy" && step !== "provider_limit") throw new Error("Invalid hostedStart.");
  return { step, startedAt: requiredNumber(start, "startedAt") };
}
