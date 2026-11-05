export interface MobileConnectHostBinding {
  hostId: string;
  fingerprint: string;
}

export interface MobileConnectTicket {
  qrData: string;
  expiresAt: number;
}

export type MobileDevicePlatform = "ios" | "android" | "unknown";

export interface MobileConnectedDevice {
  sessionId: string;
  name: string;
  platform: MobileDevicePlatform;
  connectedAt: number;
  lastActiveAt: number;
  /** How the phone signed in: a one-time code, or a permanent link. */
  via: "code" | "link";
}

export interface AccountSession {
  sessionId: string;
  name: string;
  kind: "desktop" | "mobile";
  current: boolean;
  connectedAt: number;
  lastActiveAt: number;
  /**
   * True for the session of a hosted server, with `kind` "desktop" and the server name as `name`. The
   * owner can revoke it; the next restart of the server signs it in again. Released clients decode `kind` as a closed list, so a hosted
   * server is not a new kind, and they drop this field. The account service sends it only when true.
   */
  hostedServer?: boolean;
}

export function isMobileConnectDevelopmentHost(hostname: string): boolean {
  if (hostname === "127.0.0.1" || hostname === "localhost") return true;
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet))) return false;
  const values = octets.map(Number);
  if (values.some((value) => value < 0 || value > 255)) return false;
  const [first, second] = values;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}
