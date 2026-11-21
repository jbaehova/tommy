import type { AvatarImageInput } from "./ipc-agents";
import type { HostRestartEvent } from "./team-protocol/host-update-v1";
import type { MachineAlertEvent } from "./team-protocol/machine-resources-v1";
export type TeamRole = "owner" | "admin" | "member";

/**
 * The owner and admins manage the server, its members and its invitations. The owner is an admin
 * that nobody can change or remove. A missing role manages nothing.
 */
export function canAdministerServer(role: TeamRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

// How much of a server's agent activity reaches the desktop as an OS notification. "needs-me" keeps
// only input requests and approvals.
export type ServerNotificationLevel = "all" | "needs-me" | "nothing";
export const SERVER_NOTIFICATION_LEVELS: readonly ServerNotificationLevel[] = ["all", "needs-me", "nothing"];

export interface UpdateHostIdentityInput {
  serverName?: string;
  logo?: AvatarImageInput | null;
}

export interface TeamMemberSummary {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  avatarUrl?: string | null;
  role: TeamRole;
  createdAt: string;
  disabled: boolean;
}

export interface TeamPresenceMember extends TeamMemberSummary {
  online: boolean;
  typingAgentId: string | null;
}

export interface TeamPresenceSnapshot {
  serverId: string | null;
  members: TeamPresenceMember[];
  updatedAt: string;
}

export interface DirectMessage {
  id: string;
  threadId: string;
  senderMemberId: string;
  recipientMemberId: string;
  text: string;
  createdAt: string;
  sequence: number;
}

export type TeamRealtimeEvent =
  | {
      type: "team-identity";
      serverId: string;
      serverName: string;
      logoVersion: string | null;
    }
  | {
      type: "team-presence";
      snapshot: TeamPresenceSnapshot;
    }
  | {
      type: "team-direct-message";
      message: DirectMessage;
      memberIds: [string, string];
    }
  | {
      type: "team-direct-typing";
      senderMemberId: string;
      recipientMemberId: string;
      typing: boolean;
    }
  | HostRestartEvent
  | MachineAlertEvent;

export function isTeamRealtimeEvent(value: unknown): value is TeamRealtimeEvent {
  if (!isDynamicRecord(value)) return false;
  if (value.type === "team-identity") {
    return (
      isIdentifier(value.serverId) &&
      isLimitedString(value.serverName, INPUT_LIMITS.serverName) &&
      (value.logoVersion === null || isIdentifier(value.logoVersion))
    );
  }
  if (value.type === "team-presence") return isTeamPresenceSnapshot(value.snapshot);
  if (value.type === "team-direct-message") {
    if (!isDirectMessage(value.message) || !Array.isArray(value.memberIds)) return false;
    return (
      value.memberIds.length === 2 &&
      value.memberIds[0] === value.message.senderMemberId &&
      value.memberIds[1] === value.message.recipientMemberId
    );
  }
  return (
    value.type === "team-direct-typing" &&
    isIdentifier(value.senderMemberId) &&
    isIdentifier(value.recipientMemberId) &&
    value.senderMemberId !== value.recipientMemberId &&
    isBoolean(value.typing)
  );
}

export function isTeamPresenceSnapshot(value: unknown): value is TeamPresenceSnapshot {
  if (!isDynamicRecord(value) || !Array.isArray(value.members)) return false;
  return (
    (value.serverId === null || isIdentifier(value.serverId)) &&
    isTimestamp(value.updatedAt) &&
    value.members.length <= INPUT_LIMITS.teamMembers &&
    value.members.every(isTeamPresenceMember)
  );
}

function isTeamPresenceMember(value: unknown): value is TeamPresenceMember {
  if (!isDynamicRecord(value)) return false;
  return (
    isIdentifier(value.id) &&
    isLimitedString(value.username, INPUT_LIMITS.email) &&
    (value.email === null || isLimitedString(value.email, INPUT_LIMITS.email)) &&
    (value.name === null || isLimitedString(value.name, INPUT_LIMITS.accountName)) &&
    (value.avatarUrl === undefined || value.avatarUrl === null || isHttpUrl(value.avatarUrl, INPUT_LIMITS.avatarUrl)) &&
    (value.role === "owner" || value.role === "admin" || value.role === "member") &&
    isTimestamp(value.createdAt) &&
    isBoolean(value.disabled) &&
    isBoolean(value.online) &&
    (value.typingAgentId === null || isIdentifier(value.typingAgentId))
  );
}

function isDirectMessage(value: unknown): value is DirectMessage {
  if (!isDynamicRecord(value)) return false;
  return (
    isIdentifier(value.id) &&
    isIdentifier(value.threadId) &&
    isIdentifier(value.senderMemberId) &&
    isIdentifier(value.recipientMemberId) &&
    value.senderMemberId !== value.recipientMemberId &&
    isLimitedString(value.text, INPUT_LIMITS.directMessageText) &&
    isTimestamp(value.createdAt) &&
    isNumber(value.sequence) &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0
  );
}

function isIdentifier(value: unknown): value is string {
  return isLimitedString(value, INPUT_LIMITS.identifier);
}

function isTimestamp(value: unknown): value is string {
  return isLimitedString(value, 64) && Number.isFinite(Date.parse(value));
}

function isHttpUrl(value: unknown, limit: number): value is string {
  if (!isLimitedString(value, limit)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isLimitedString(value: unknown, limit: number): value is string {
  return isString(value) && value.length > 0 && value.length <= limit;
}

import { INPUT_LIMITS } from "./input-limits";
import { isBoolean, isDynamicRecord, isNumber, isString } from "./runtime-values";
