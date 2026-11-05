// The Signal wire protocol: the frames a peer and the Signal service exchange over `WSS /v1/signal`.
//
// Signal (`remote/api`) relays SDP and ICE between a host and its clients and hands out resume
// tokens and TURN credentials. Team chats, files and commands never pass through it - those travel
// on the WebRTC data channels it helped negotiate, and their protocol is `../team-protocol` instead.
// The one exception is Slack: the Tommy Slack app posts every workspace's events to Signal.
// Signal checks the Slack signature, reads only the workspace ID, and passes the request body to
// the `ingress` socket of the host that the workspace is linked to, without storing or logging it.
// Discord is the second: Signal holds the Tommy Discord bot's Gateway connection, passes each
// guild's mentions of Tommy to the guild's host, and makes the host's Discord calls
// (`./discord-api.ts`).
// Telegram is the third: the Tommy bot's updates come to Signal, which passes each to the host of
// its chat, and the host calls the Bot API through Signal, which holds the token (`./telegram-route.ts`).
// GitHub is the fourth: the Tommy GitHub App's events come to Signal, which checks the App's
// signature and passes each to every host whose GitHub triggers watch its repository
// (`./github-route.ts`).
//
// Three parties speak this and none of them ships together: the service
// (`remote/api/src/signal-service.ts`), the shared client that mobile and the future web client run
// (`packages/team-client/src/remote-peer.ts`), and the desktop's hidden-window peer
// (`src/renderer/src/features/team/team-webrtc.ts`). Each wrote these shapes out by hand, and the
// desktop's copies had degraded into a flat `.loose()` bag of optionals: `sdp`, `candidate` and
// `resumeToken` were `string | undefined` on every branch, so the compiler could not tell a `ready`
// from an `ice-candidate` and every field had to be re-checked at the point of use.
//
// Types and constants only, so a client pays nothing at runtime to import them. Validation is one
// implementation per trust direction and is deliberately not shared: `remote/api` keeps its zod
// schema for the untrusted *client* input it accepts - byte limits, identifier patterns, a closed
// discriminated union - and `./decode.ts` carries the guards a client runs over the *service's*
// output. Neither is the other's mirror, and neither should grow into it.
//
// Unlike `../team-protocol` there are no frozen per-version artifacts here, because this protocol
// has only ever had one version. `version` on these frames is the socket protocol; the app protocol
// negotiated on the data channels is a different number entirely.

// The largest generic webhook body Signal passes to a host. Signal does not inspect or retain it.
export const WEBHOOK_DELIVERY_BODY_BYTES_LIMIT = 64 * 1024;

export type WebhookDeliveryStatus = 200 | 202 | 400 | 401 | 404 | 413 | 429 | 503;

export const SIGNAL_ERROR_CODES = [
  "authentication_required",
  "invalid_message",
  "host_unavailable",
  "host_busy",
  "permission_denied",
  "rate_limited",
  "session_revoked",
  "protocol_error",
] as const;
