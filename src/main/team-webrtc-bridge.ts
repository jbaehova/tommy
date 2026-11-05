import type { EventEmitter } from "node:events";
import type { RemoteMemberRole } from "@tommy/contracts/signal-protocol/ticket";
import type { Effect } from "effect";
import type { RemoteWorkflowError } from "./remote-service-effects";

export type TeamWebRtcChannel = "rpc" | "events" | "files" | "desktop";

/** What a direct connection reports to the Team transports above it. */
export interface TeamWebRtcBridgeEvents {
  signalReady: [peerId: string];
  signalOpen: [peerId: string];
  incoming: [
    peerId: string,
    connection: {
      hostId: string;
      connectionId: string;
      sessionId: string;
      userId: string;
      membershipId: string;
      role: RemoteMemberRole;
      sessionExpiresAt: number;
    },
  ];
  connected: [peerId: string, binding?: { localFingerprint: string; remoteFingerprint: string }];
  disconnected: [peerId: string];
  pathLost: [peerId: string];
  pathRestored: [peerId: string];
  data: [peerId: string, channel: TeamWebRtcChannel, data: string | ArrayBuffer];
  path: [peerId: string, path: "p2p" | "relay"];
  error: [peerId: string, code: string, message: string, terminal?: boolean];
}

/** The side of a direct connection that the Team transports use. */
export interface TeamWebRtcBridge extends EventEmitter<TeamWebRtcBridgeEvents> {
  start(): Effect.Effect<void, RemoteWorkflowError>;
  prepareSignal(peerId: string, signalUrl: string): Effect.Effect<void, RemoteWorkflowError>;
  connect(input: { peerId: string; signalUrl: string }): Effect.Effect<void, RemoteWorkflowError>;
  disconnect(peerId: string): Effect.Effect<void, RemoteWorkflowError>;
  disconnectPeer(peerId: string): Effect.Effect<void, RemoteWorkflowError>;
  send(
    peerId: string,
    channel: TeamWebRtcChannel,
    data: string | ArrayBuffer,
  ): Effect.Effect<void, RemoteWorkflowError>;
}
