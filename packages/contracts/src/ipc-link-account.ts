/**
 * The Link account of this computer (link.com, by Stripe). Agents ask it for a one-time card, the user
 * approves each payment in the Link app, and the browser types the card. The tokens never cross to the
 * renderer.
 *
 * - `disconnected`: no sign-in is stored.
 * - `pending`: Link's sign-in page is open in the browser, and Tommy waits for the user to approve it.
 * - `connected`: agents can ask to pay with Link.
 * - `expired`: Link refused the stored sign-in. The user must connect again.
 */
export type LinkAccountState = "disconnected" | "pending" | "connected" | "expired";

export interface LinkAccountStatus {
  state: LinkAccountState;
  /** The email of the Link account, when Link gave one. */
  email: string | null;
  /** The last sign-in failure, as a sentence. Null after a success or a cancel. */
  error: string | null;
}
