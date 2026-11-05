import type { TeamMemberSummary, TeamPresenceSnapshot } from "@tommy/contracts/ipc";
import { isTeamRealtimeEvent } from "@tommy/contracts/ipc";
import { decodeRecord, nullableString, requiredBoolean, requiredString } from "@tommy/contracts/ipc-decoding";

export function decodeIdentityProof(value: unknown): {
  serverId: string;
  publicKey: string;
  serverName: string;
  fingerprint: string;
  challenge: string;
  signature: string;
  logoVersion: string | null;
} {
  const record = decodeRecord(value, "server identity");
  return {
    serverId: requiredString(record, "serverId"),
    publicKey: requiredString(record, "publicKey"),
    serverName: requiredString(record, "serverName"),
    fingerprint: requiredString(record, "fingerprint"),
    challenge: requiredString(record, "challenge"),
    signature: requiredString(record, "signature"),
    logoVersion: record.logoVersion === undefined ? null : nullableString(record, "logoVersion"),
  };
}

export function decodeTeamPresenceSnapshot(value: unknown): TeamPresenceSnapshot {
  const event = { type: "team-presence", snapshot: value };
  if (!isTeamRealtimeEvent(event) || event.type !== "team-presence") {
    throw new Error("Invalid team presence response.");
  }
  return event.snapshot;
}

function decodeTeamMember(value: unknown): TeamMemberSummary {
  const record = decodeRecord(value, "team member");
  const role = requiredString(record, "role");
  if (role !== "owner" && role !== "admin" && role !== "member") throw new Error("Invalid team member role.");
  return {
    id: requiredString(record, "id"),
    username: requiredString(record, "username"),
    email: nullableString(record, "email"),
    name: nullableString(record, "name"),
    avatarUrl: nullableString(record, "avatarUrl"),
    role,
    createdAt: requiredString(record, "createdAt"),
    disabled: requiredBoolean(record, "disabled"),
  };
}

export function decodeTeamMembers(value: unknown): TeamMemberSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid team members response.");
  return value.map(decodeTeamMember);
}
