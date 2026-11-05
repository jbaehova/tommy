import { decodeHostLogo, HOST_LOGO_ROUTES } from "@tommy/contracts/team-protocol/host-logo-v1";
import type { TeamProtocolV2Json } from "@tommy/contracts/team-protocol/v2";

/** Reads the server logo from the host as a data URI. */
export async function loadServerLogo(
  request: <T>(path: string, decode: (value: unknown) => T, body: TeamProtocolV2Json) => Promise<T>,
  logoKey: string,
): Promise<string> {
  const { mimeType, data } = await request(HOST_LOGO_ROUTES.read, decodeHostLogo, { version: logoKey });
  return `data:${mimeType};base64,${data}`;
}
