// A generic webhook route: Signal maps one opaque public route ID to the host that registered it.
// The host makes the route ID when a routine gets a webhook trigger. The account service
// stores only that ownership metadata and signs it into the short-lived ingress ticket.

// The relay forwards these values without normalizing them. Keep the names shared with the host
// verifier so the public contract cannot drift between Signal and the desktop.
export const WEBHOOK_TIMESTAMP_HEADER = "x-tommy-timestamp";
export const WEBHOOK_DELIVERY_ID_HEADER = "x-tommy-delivery-id";
export const WEBHOOK_SIGNATURE_HEADER = "x-tommy-signature";

// The host refuses a signature whose timestamp is further than this from its clock: a replay.
export const WEBHOOK_MAX_CLOCK_SKEW_SECONDS = 5 * 60;

export const WEBHOOK_TIMESTAMP_PATTERN = /^[0-9]{1,12}$/u;
export const WEBHOOK_DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
export const WEBHOOK_SIGNATURE_PATTERN = /^sha256=[A-Fa-f0-9]{64}$/u;

// One host may register many webhook routines, but the route ticket must stay bounded.
export const WEBHOOK_ROUTES_LIMIT = 64;

export interface WebhookRoute {
  id: string;
  /** When the account service registered this route, in milliseconds. */
  linkedAt: number;
}
