import { parseDirectPairingLink } from "@tommy/contracts/direct-connection";

let pendingPairingLink: string | null = null;

/** A pairing link waits for the pairing screen, which fills its address and code. Others open the app. */
export function redirectIncomingLink(path: string): string {
  if (parseDirectPairingLink(path)) pendingPairingLink = path;
  return "/";
}

export function takePendingPairingLink(): string | null {
  const link = pendingPairingLink;
  pendingPairingLink = null;
  return link;
}
