import { isBrowserProfileId } from "./ipc-browser-profiles";
import { isDynamicRecord } from "./runtime-values";

export type BrowserProxyScheme = "http" | "https" | "socks5";
export type BrowserProxyFailure = "signIn" | "unreachable";
/** Host-owned proxy. Credentials stay on the host. */
export interface BrowserProfileProxyConnection {
  scheme: BrowserProxyScheme;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
}
export interface BrowserProfileProxyInput {
  profileId: string;
  /** Null restores the host's system proxy. Credentials can be percent encoded. */
  address: string | null;
  /** Keep the password only when the same endpoint and user remain selected. */
  keepPassword?: boolean;
}
export interface BrowserProfileProxySummary {
  profileId: string;
  /** An address with no password. */
  address: string | null;
  hasPassword: boolean;
}
export function decodeBrowserProfileProxyInput(value: unknown): BrowserProfileProxyInput {
  if (
    !isDynamicRecord(value) ||
    !isBrowserProfileId(value.profileId) ||
    (value.address !== null && (typeof value.address !== "string" || value.address.length > 2048)) ||
    (value.keepPassword !== undefined && typeof value.keepPassword !== "boolean")
  )
    throw new Error("Invalid browser profile proxy.");
  return {
    profileId: value.profileId,
    address: value.address,
    ...(value.keepPassword === undefined ? {} : { keepPassword: value.keepPassword }),
  };
}
/** Parses an explicit proxy address. A malformed address never selects a direct connection. */
export function parseBrowserProfileProxy(address: string): BrowserProfileProxyConnection | null {
  try {
    if (address.length === 0 || address.length > 2048 || /[\r\n\s]/u.test(address)) return null;
    const url = new URL(address);
    const scheme = url.protocol.slice(0, -1);
    if (scheme !== "http" && scheme !== "https" && scheme !== "socks5") return null;
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return null;
    const host = url.hostname;
    if (!host || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:.]+\])$/u.test(host)) return null;
    const port = url.port ? Number(url.port) : scheme === "https" ? 443 : scheme === "http" ? 80 : 1080;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const username = url.username ? decodeURIComponent(url.username) : null;
    const password = url.password ? decodeURIComponent(url.password) : null;
    if ((username && proxyCredentialBytes(username) > 255) || (password && proxyCredentialBytes(password) > 255))
      return null;
    if (password && username === null) return null;
    return { scheme, host, port, username, password };
  } catch {
    return null;
  }
}
function proxyCredentialBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
export function browserProfileProxyAddress(proxy: BrowserProfileProxyConnection): string {
  const credentials = proxy.username === null ? "" : `${encodeURIComponent(proxy.username)}@`;
  return `${proxy.scheme}://${credentials}${proxy.host}:${proxy.port}`;
}

/** A remote host may return metadata only, never a password or a credential-bearing URL. */
export function decodeHostBrowserProfileProxy(value: unknown): BrowserProfileProxySummary {
  if (
    !isDynamicRecord(value) ||
    !isBrowserProfileId(value.profileId) ||
    typeof value.hasPassword !== "boolean" ||
    "password" in value
  )
    throw new Error("Invalid browser profile proxy response.");
  if (value.address === null) return { profileId: value.profileId, address: null, hasPassword: value.hasPassword };
  if (typeof value.address !== "string") throw new Error("Invalid browser profile proxy response.");
  const proxy = parseBrowserProfileProxy(value.address);
  if (!proxy || proxy.password !== null) throw new Error("Invalid browser profile proxy response.");
  return { profileId: value.profileId, address: browserProfileProxyAddress(proxy), hasPassword: value.hasPassword };
}
