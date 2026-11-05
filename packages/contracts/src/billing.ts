import { DEFAULT_TEAM_MEMBER_LIMIT } from "./input-limits";

export type BillingPlanId = "starter" | "standard" | "pro";
export type BillingInterval = "month" | "year";
export type BillingCurrency = "eur" | "usd" | "pln";
/** The Stripe subscription statuses. The account server stores the status that Stripe reports. */
export type BillingSubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export const BILLING_PLAN_IDS: readonly BillingPlanId[] = ["starter", "standard", "pro"];
export const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];
export const BILLING_CURRENCIES: readonly BillingCurrency[] = ["eur", "usd", "pln"];

export interface BillingPlan {
  id: BillingPlanId;
  storageGb: number;
  /** The number of active members of a server with this plan. The account server enforces it. */
  memberLimit: number;
  /** The number of active hosted sites of a server with this plan. The account server enforces it. */
  siteLimit: number;
  /** The speed of the plan's machine, where Starter is 1. */
  relativeSpeed: number;
}

/** The storage, members and speed of each plan. A buyer pays the Stripe Prices; see `billingListPrices`. */
export const BILLING_PLANS: readonly BillingPlan[] = [
  { id: "starter", storageGb: 12, memberLimit: 1, siteLimit: 3, relativeSpeed: 1 },
  { id: "standard", storageGb: 50, memberLimit: 5, siteLimit: 10, relativeSpeed: 2 },
  { id: "pro", storageGb: 100, memberLimit: 10, siteLimit: 50, relativeSpeed: 4 },
];

/**
 * The monthly list price of each plan, in minor units (cents, grosze). Each amount divides by 5, so a
 * year (12 months less 20%) is a whole number.
 */
const BILLING_PLAN_MONTHLY_PRICES: Readonly<Record<BillingPlanId, Readonly<Record<BillingCurrency, number>>>> = {
  starter: { eur: 2000, usd: 2500, pln: 8000 },
  standard: { eur: 5000, usd: 6000, pln: 20000 },
  pro: { eur: 10000, usd: 12000, pln: 40000 },
};

/**
 * The list price of a plan for one interval, in minor units. `scripts/stripe-bootstrap.ts` sets the
 * Stripe Prices to these amounts. The account server and the app read the Stripe Prices.
 */
export function billingListPrices(plan: BillingPlanId, interval: BillingInterval): Record<BillingCurrency, number> {
  const monthly = BILLING_PLAN_MONTHLY_PRICES[plan];
  if (interval === "month") return { ...monthly };
  const year = (amount: number) => (amount * 12 * 4) / 5;
  return { eur: year(monthly.eur), usd: year(monthly.usd), pln: year(monthly.pln) };
}

/** The active member limit of a server with this plan, or with no plan. */
export function memberLimitForPlan(plan: BillingPlanId | null): number {
  return BILLING_PLANS.find((candidate) => candidate.id === plan)?.memberLimit ?? DEFAULT_TEAM_MEMBER_LIMIT;
}
