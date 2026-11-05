import {
  DIRECT_CONNECT_PATH,
  DIRECT_DEVICE_QUERY,
  DIRECT_PAIR_PATH,
  DirectPairResponse,
  directSessionId,
  parseDirectPairingLink,
} from "@tommy/contracts/direct-connection";
import type { CentralAuthUser } from "@tommy/contracts/ipc";
import { isDynamicRecord, isString } from "@tommy/contracts/runtime-values";
import { runTeamEffect } from "@tommy/team-client";
import { base64UrlToBytes, bytesToBase64Url } from "@tommy/team-client/base64";
import { createEd25519Identity } from "@tommy/team-client/ed25519";
import type { RemoteTeamDevice } from "@tommy/team-client/remote-peer";
import { Schema } from "effect";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { currentText } from "@/shared/lib/text";
import * as LockedKeychain from "../../../shared/lib/locked-keychain";

const MOBILE_SESSION_KEY = "tommy.mobile.pairing.v1";
const PAIR_TIMEOUT_MS = 15_000;
const MAXIMUM_DEVICE_NAME_LENGTH = 128;

const decodePairResponse = Schema.decodeUnknownSync(DirectPairResponse);

/** A session that the app can no longer use. A paired device has no other end. */
export class MobileSessionExpiredError extends Error {
  constructor() {
    super(currentText().t("mobile.auth.error.sessionEnded"));
  }
}

/** The one server of this phone, and the device key that proves this phone to it. */
export interface MobileSession {
  apiUrl: string;
  /** The device ID. A paired device has no account token. */
  sessionToken: string;
  user: CentralAuthUser;
  host: { hostId: string; hostPublicKey: string };
  /** Base64url of the Ed25519 secret key. It stays in the keychain of this phone. */
  secretKey: string;
  publicKeyPem: string;
}

/** A value with no scheme reads as HTTPS. Other schemes, and a URL that holds credentials, read as none. */
function pairingOrigin(value: string): string | null {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/** Spends a code of `tommy pair`. The device key is made here, and only its public half leaves. */
export async function pairMobileDevice(address: string, code: string): Promise<MobileSession> {
  const { t } = currentText();
  const apiUrl = pairingOrigin(address);
  if (!apiUrl) throw new Error(t("mobile.auth.pair.invalidAddress"));
  const normalizedCode = code.replace(/[\s-]/g, "").toUpperCase();
  if (!normalizedCode) throw new Error(t("mobile.auth.pair.invalidCode"));
  const identity = await runTeamEffect(createEd25519Identity((size) => Crypto.getRandomBytes(size)));
  // A redirect could send the code to another origin, and TLS proves only this one.
  const response = await fetch(`${apiUrl}${DIRECT_PAIR_PATH}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: normalizedCode,
      publicKey: identity.publicKeyPem,
      name: (Device.deviceName ?? Device.modelName ?? "Android").slice(0, MAXIMUM_DEVICE_NAME_LENGTH),
    }),
  }).catch(() => {
    throw new Error(t("mobile.auth.pair.unreachable"));
  });
  if (response.status === 403) throw new Error(t("mobile.auth.pair.invalidCode"));
  if (response.status === 429) throw new Error(t("mobile.auth.pair.rateLimited"));
  if (!response.ok) throw new Error(t("mobile.auth.pair.unreachable"));
  const paired = decodePairResponse(await response.json());
  const session: MobileSession = {
    apiUrl,
    sessionToken: paired.deviceId,
    user: { id: paired.deviceId, email: "", name: null, avatarUrl: null },
    host: { hostId: paired.hostId, hostPublicKey: paired.hostPublicKey },
    secretKey: bytesToBase64Url(identity.secretKey),
    publicKeyPem: identity.publicKeyPem,
  };
  await LockedKeychain.setItemAsync(MOBILE_SESSION_KEY, JSON.stringify(session));
  return session;
}

/** What the QR code of `tommy pair` holds. */
export async function pairWithLink(value: string): Promise<MobileSession> {
  const link = parseDirectPairingLink(value);
  if (!link) throw new Error(currentText().t("mobile.auth.pair.invalidCode"));
  return pairMobileDevice(link.url, link.code);
}

function decodeStoredSession(value: unknown): MobileSession | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.apiUrl) ||
    !isString(value.sessionToken) ||
    !isString(value.secretKey) ||
    !isString(value.publicKeyPem) ||
    !isDynamicRecord(value.host) ||
    !isString(value.host.hostId) ||
    !isString(value.host.hostPublicKey)
  )
    return null;
  return {
    apiUrl: value.apiUrl,
    sessionToken: value.sessionToken,
    user: { id: value.sessionToken, email: "", name: null, avatarUrl: null },
    host: { hostId: value.host.hostId, hostPublicKey: value.host.hostPublicKey },
    secretKey: value.secretKey,
    publicKeyPem: value.publicKeyPem,
  };
}

/** A keychain that the lock keeps closed throws here, so the app reads again when the user opens it. */
export async function readMobileSession(): Promise<MobileSession | null> {
  const stored = await LockedKeychain.getItemAsync(MOBILE_SESSION_KEY);
  if (!stored) return null;
  try {
    return decodeStoredSession(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** The private key goes with the item. The host keeps the device until `tommy revoke-device`. */
export async function logoutMobileSession(_session: MobileSession): Promise<void> {
  await LockedKeychain.deleteItemAsync(MOBILE_SESSION_KEY);
}

/** What the peer needs to connect. */
export function mobileDevice(session: MobileSession): RemoteTeamDevice {
  const url = new URL(DIRECT_CONNECT_PATH, session.apiUrl);
  url.protocol = "wss:";
  url.searchParams.set(DIRECT_DEVICE_QUERY, session.sessionToken);
  return {
    sessionId: directSessionId(session.sessionToken),
    ticket: session.sessionToken,
    url: url.toString(),
    identity: { secretKey: base64UrlToBytes(session.secretKey), publicKeyPem: session.publicKeyPem },
  };
}
