import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * The host sends a notification through Firebase Cloud Messaging while Android stops the app, so it
 * seals the text with keys that only the phone and the host know. The seal uses only HMAC-SHA256: a
 * keystream of HMAC blocks over a random nonce and a counter, and an HMAC tag over the nonce and the
 * ciphertext. `SealedNotification.kt` is the opener.
 */

/** The size of the secret that the phone makes and gives only to its host. */
export const NOTIFICATION_SECRET_BYTES = 32;
export const NOTIFICATION_NONCE_BYTES = 16;
const TAG_BYTES = 16;
const BLOCK_BYTES = 32;

/**
 * The secret that the phone gives one host. Each host gets its own, made from the phone secret, so
 * a host cannot seal content for another host. The label stays: changing it changes the secrets.
 */
export function notificationHostSecret(phoneSecret: Uint8Array, serverId: string): Uint8Array {
  return hmac(sha256, phoneSecret, utf8ToBytes(`tommy live activity host ${serverId}`));
}

/** Seals `text` for the phone. Use a new random `nonce` for each seal. */
export function sealNotification(text: string, keys: { seal: Uint8Array; tag: Uint8Array }, nonce: Uint8Array): string {
  if (nonce.length !== NOTIFICATION_NONCE_BYTES) throw new Error("The notification nonce has a wrong size.");
  const plain = utf8ToBytes(text);
  const cipher = new Uint8Array(plain.length);
  for (let offset = 0; offset < plain.length; offset += BLOCK_BYTES) {
    const stream = hmac(sha256, keys.seal, concatBytes(nonce, counter(offset / BLOCK_BYTES)));
    for (let index = 0; index < BLOCK_BYTES && offset + index < plain.length; index += 1) {
      cipher[offset + index] = (plain[offset + index] ?? 0) ^ (stream[index] ?? 0);
    }
  }
  const body = concatBytes(nonce, cipher);
  return base64Url(concatBytes(body, hmac(sha256, keys.tag, body).subarray(0, TAG_BYTES)));
}

export function encodeNotificationBytes(bytes: Uint8Array): string {
  return base64Url(bytes);
}

export function decodeNotificationBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const character of value) {
    buffer = (buffer << 6) | ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
  }
  return bytes;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64Url(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    text += ALPHABET[a >> 2];
    text += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) text += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) text += ALPHABET[c & 63];
  }
  return text;
}

function counter(block: number): Uint8Array {
  return new Uint8Array([(block >>> 24) & 0xff, (block >>> 16) & 0xff, (block >>> 8) & 0xff, block & 0xff]);
}
