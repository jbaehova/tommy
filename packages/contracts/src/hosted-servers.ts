import {
  BILLING_CURRENCIES,
  BILLING_INTERVALS,
  BILLING_PLAN_IDS,
  type BillingCurrency,
  type BillingInterval,
  type BillingPlanId,
} from "./billing";
import { INPUT_LIMITS } from "./input-limits";
import { isBoolean, isDynamicRecord, isOneOf, isString } from "./runtime-values";
import { slugifyTeamServerName } from "./validation";

/** The provider machine sizes, from the boat machine table (docs.boat.dev/machines). */
export const HOSTED_SERVER_SIZES = {
  small: { vcpu: 2, memoryGb: 4, diskGb: 12 },
  default: { vcpu: 4, memoryGb: 8, diskGb: 50 },
  large: { vcpu: 8, memoryGb: 16, diskGb: 125 },
} as const;

export type HostedServerSize = keyof typeof HOSTED_SERVER_SIZES;

export const HOSTED_SERVER_SIZE_NAMES = ["small", "default", "large"] as const satisfies readonly HostedServerSize[];

export const HOSTED_SERVER_STATES = [
  /** The row exists, and the account server waits for Stripe to confirm the first payment. */
  "awaiting_payment",
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "waking",
  "error",
  "deleted",
] as const;

export type HostedServerState = (typeof HOSTED_SERVER_STATES)[number];

/**
 * The reason codes for a server in the error state, or for a server that stopped. They never contain
 * provider text. `plan_ended`: the plan was cancelled or not paid, so the server stopped. Its data stays.
 */
export const HOSTED_SERVER_ERRORS = [
  "provider_error",
  "provider_billing",
  "provider_limit",
  "start_failed",
  "plan_ended",
] as const;

export type HostedServerError = (typeof HOSTED_SERVER_ERRORS)[number];

/**
 * Returns the trimmed name, or null for a name that the team store of the server refuses. The server
 * cannot publish its host with such a name.
 */
export function parseHostedServerName(value: string): string | null {
  const name = value.trim();
  if (name.length < INPUT_LIMITS.serverNameMin || name.length > INPUT_LIMITS.serverName || /\p{Cc}/u.test(name)) {
    return null;
  }
  return slugifyTeamServerName(name).length >= INPUT_LIMITS.serverNameMin ? name : null;
}

export interface HostedServerSummary {
  deletionScheduledAt?: number | null;
  /** The same value as the Remote host id of the server. */
  serverId: string;
  name: string;
  size: HostedServerSize;
  plan: BillingPlanId;
  interval: BillingInterval;
  currency: BillingCurrency;
  state: HostedServerState;
  error: HostedServerError | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The state of one hosted server, for its owner and its members. `sleeping`: the Worker stopped the
 * server because nobody used it. A client then waits for the user's next input before it wakes it.
 */
export interface HostedServerStatus {
  serverId: string;
  state: HostedServerState;
  error: HostedServerError | null;
  sleeping: boolean;
}

export function isHostedServerSize(value: unknown): value is HostedServerSize {
  return isOneOf(HOSTED_SERVER_SIZE_NAMES, value);
}

export function isHostedServerState(value: unknown): value is HostedServerState {
  return isOneOf(HOSTED_SERVER_STATES, value);
}

/** Returns null for a value that is not a hosted server summary. */
export function parseHostedServerSummary(value: unknown): HostedServerSummary | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.serverId) ||
    !isString(value.name) ||
    !isHostedServerSize(value.size) ||
    !isOneOf(BILLING_PLAN_IDS, value.plan) ||
    !isOneOf(BILLING_INTERVALS, value.interval) ||
    !isOneOf(BILLING_CURRENCIES, value.currency) ||
    !isString(value.state) ||
    !(value.error === null || isString(value.error)) ||
    !isString(value.createdAt) ||
    !isString(value.updatedAt)
  ) {
    return null;
  }
  // A state or an error that a newer Worker added shows as an error, so an older app still lists the server.
  const state: HostedServerState = isHostedServerState(value.state) ? value.state : "error";
  const error: HostedServerError | null =
    state !== value.state ? "provider_error" : isOneOf(HOSTED_SERVER_ERRORS, value.error) ? value.error : null;
  return {
    deletionScheduledAt:
      typeof value.deletionScheduledAt === "number" &&
      Number.isSafeInteger(value.deletionScheduledAt) &&
      value.deletionScheduledAt > 0
        ? value.deletionScheduledAt
        : null,
    serverId: value.serverId,
    name: value.name,
    size: value.size,
    plan: value.plan,
    interval: value.interval,
    currency: value.currency,
    state,
    error,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** Returns null for a value that is not a hosted server status. */
export function parseHostedServerStatus(value: unknown): HostedServerStatus | null {
  if (
    !isDynamicRecord(value) ||
    !isString(value.serverId) ||
    !isString(value.state) ||
    !(value.error === null || isString(value.error)) ||
    !isBoolean(value.sleeping)
  ) {
    return null;
  }
  // As in the summary: a state that a newer Worker added shows as an error.
  const state: HostedServerState = isHostedServerState(value.state) ? value.state : "error";
  const error: HostedServerError | null =
    state !== value.state ? "provider_error" : isOneOf(HOSTED_SERVER_ERRORS, value.error) ? value.error : null;
  return { serverId: value.serverId, state, error, sleeping: value.sleeping };
}
