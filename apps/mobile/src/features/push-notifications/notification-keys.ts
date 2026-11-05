import { NOTIFICATION_SECRET_BYTES, notificationHostSecret } from "@tommy/team-client/notification-seal";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { untilForeground } from "@/shared/lib/until-foreground";

/** The saved name stays, so an installed app keeps its secret. */
const key = "tommy.mobile.live-activity-secret.v1";

let loaded: Uint8Array | null = null;
let loading: Promise<Uint8Array> | null = null;
const hosts = new Map<string, Uint8Array>();

/**
 * The phone secret. Each host gets its own secret made from it, which seals the notifications. So
 * Google cannot read or change one, and one host cannot seal for another.
 */
export function loadNotificationSecret(): Promise<Uint8Array> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= (async () => {
    try {
      // A locked phone does not open the secret. A read that failed as missing would replace it.
      await untilForeground();
      const stored = await SecureStore.getItemAsync(key);
      const secret = stored ? fromHex(stored) : null;
      loaded = secret?.length === NOTIFICATION_SECRET_BYTES ? secret : await createSecret();
      return loaded;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** The secret of one host, made from the phone secret. */
export function notificationHostKey(phoneSecret: Uint8Array, serverId: string): Uint8Array {
  const cached = hosts.get(serverId);
  if (cached) return cached;
  const secret = notificationHostSecret(phoneSecret, serverId);
  hosts.set(serverId, secret);
  return secret;
}

async function createSecret(): Promise<Uint8Array> {
  const secret = Crypto.getRandomBytes(NOTIFICATION_SECRET_BYTES);
  await SecureStore.setItemAsync(key, toHex(secret));
  return secret;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) return null;
  return Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}
