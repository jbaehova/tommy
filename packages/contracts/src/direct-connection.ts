// The direct connection between a Tommy client and its one host. A client opens one WebSocket
// to the host and sends the Team frames on it. No other server takes part in the connection.

import { Schema } from "effect";

export const DIRECT_CONNECT_PATH = "/tommy/v1/connect";
export const DIRECT_FILES_PATH = "/tommy/v1/files";
export const DIRECT_PAIR_PATH = "/tommy/v1/pair";
export const DIRECT_DEVICE_QUERY = "device";
export const DIRECT_FILES_TOKEN_QUERY = "token";

/** A pairing code holds this many characters, from `DIRECT_PAIRING_ALPHABET`. */
export const DIRECT_PAIRING_CODE_LENGTH = 12;
/** No 0, 1, I, L, O or U: a person reads the code from a terminal and types it. */
export const DIRECT_PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A paired device has no session end. This is the last time a `Date` can hold, in seconds. */
export const DIRECT_SESSION_EXPIRES_AT_SECONDS = 8_640_000_000_000;

/** The close code when the host refuses a device, so that the client does not retry. */
export const DIRECT_CLOSE_DEVICE_REVOKED = 4401;
/** The close code when a newer connection of the same device takes over. */
export const DIRECT_CLOSE_REPLACED = 4409;

const PAIRING_LINK_PROTOCOL = "tommy:";
const PAIRING_LINK_HOST = "pair";

/** What the QR code of `tommy pair` holds. */
export function createDirectPairingLink(input: { url: string; code: string }): string {
  const link = new URL(`${PAIRING_LINK_PROTOCOL}//${PAIRING_LINK_HOST}`);
  link.searchParams.set("url", input.url);
  link.searchParams.set("code", input.code);
  return link.toString();
}

export function parseDirectPairingLink(value: string): { url: string; code: string } | null {
  try {
    const link = new URL(value);
    const url = link.searchParams.get("url");
    const code = link.searchParams.get("code");
    if (link.protocol !== PAIRING_LINK_PROTOCOL || link.hostname !== PAIRING_LINK_HOST || !url || !code) return null;
    return new URL(url).protocol === "https:" ? { url, code } : null;
  } catch {
    return null;
  }
}

/** The session of a device. A reconnect keeps it, as a client's stored push and read state need. */
export function directSessionId(deviceId: string): string {
  return `device-${deviceId}`;
}

/**
 * The value that the signed authentication transcript holds in the place of a channel fingerprint.
 * The host chooses `connectionId` for each socket, so a signature cannot work on another socket.
 */
export function directConnectionBinding(connectionId: string): { host: string; client: string } {
  return { host: `host:${connectionId}`, client: `client:${connectionId}` };
}

export const DirectPairRequest = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(32)),
  publicKey: Schema.String.check(Schema.isMaxLength(8_192)),
  name: Schema.String.check(Schema.isMaxLength(128)),
});
export type DirectPairRequest = typeof DirectPairRequest.Type;

export const DirectPairResponse = Schema.Struct({
  hostId: Schema.String,
  hostFingerprint: Schema.String,
  hostPublicKey: Schema.String,
  deviceId: Schema.String,
});
export type DirectPairResponse = typeof DirectPairResponse.Type;

export const DirectHello = Schema.Struct({
  connectionId: Schema.String,
  filesToken: Schema.String,
});
export type DirectHello = typeof DirectHello.Type;

/**
 * Text messages on the connect socket start with one kind character. A binary message is always a
 * `files` frame. A client can send `files` on the separate files socket, so that a large file does
 * not hold back chat.
 */
/** `desktop` holds the control messages of a live browser view; `desktopBinary` holds base64 of its frames. */
export type DirectFrameKind = "hello" | "rpc" | "events" | "files" | "desktop" | "desktopBinary" | "ping" | "pong";

const KINDS: readonly (readonly [DirectFrameKind, string])[] = [
  ["hello", "h"],
  ["rpc", "r"],
  ["events", "e"],
  ["files", "f"],
  ["desktop", "d"],
  ["desktopBinary", "b"],
  ["ping", "p"],
  ["pong", "P"],
];
const KIND_PREFIX = new Map(KINDS);
const PREFIX_KIND = new Map(KINDS.map(([kind, prefix]) => [prefix, kind] as const));

export function encodeDirectFrame(kind: DirectFrameKind, payload = ""): string {
  return `${KIND_PREFIX.get(kind) ?? ""}${payload}`;
}

export function decodeDirectFrame(text: string): { kind: DirectFrameKind; payload: string } | null {
  const kind = PREFIX_KIND.get(text.charAt(0));
  return kind ? { kind, payload: text.slice(1) } : null;
}
