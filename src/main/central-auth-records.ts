import type { HostKeyHandover } from "@tommy/contracts/host-key-handover";
import type { RemoteSessionTicket } from "@tommy/contracts/remote-control-plane";
import type { RemoteMemberRole, RemoteTicketClaims } from "@tommy/contracts/signal-protocol/ticket";

/** The account API's answers, and the decoders that `CentralAuthManager` checks them with. */

export interface RemoteHostSummary {
  hostId: string;
  name: string;
  logoKey: string | null;
  devicePublicKey: string | null;
  /** The host's signed key handovers. An account server from before handovers sends none. */
  keyHandovers: HostKeyHandover[];
  authEpoch: number;
  membershipId: string;
  role: "owner" | "admin" | "member";
  /** The active members that the host's plan allows. An account server from before plans sends none. */
  memberLimit?: number;
  /**
   * A hosted server with a plan: its owner and its admins can restart it. An older account server sends none.
   */
  hosted?: boolean;
}

export type RemoteConnectionBootstrap = RemoteSessionTicket;

export type VerifiedRemoteSessionTicket = Pick<
  RemoteTicketClaims,
  "sessionId" | "hostId" | "userId" | "membershipId" | "authEpoch" | "sessionExpiresAt"
> & {
  role: RemoteMemberRole;
  clientPublicKey: string;
};
