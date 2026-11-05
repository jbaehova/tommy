/**
 * The addresses one Marketplace agent or skill has: the page a person shares, the link that opens
 * that listing in the app, and the browser client's entry for it.
 *
 * ```
 * tommy://marketplace/agents/<id>               the link the page button opens
 * tommy://marketplace/skills/<slug>
 * /app?marketplaceAgent=<id>                      the page's link to the browser client
 * /app?marketplaceSkill=<slug>
 * ```
 *
 * This follows `plugin-links.ts`: the host gives the kind, the path gives the argument, and a query
 * is refused, so the shape cannot grow an `?install=1`. A link opens the listing's page in the app;
 * adding the agent or skill is still a press of Add there.
 *
 * An agent has only its id, a UUID the Worker makes. A skill has a unique slug, made from its name.
 * Both forms are built from that value and never read from catalog data, so a listing cannot put a
 * foreign address behind the button that copies its own link.
 */

export type MarketplaceListingKind = "agent" | "skill";

export interface MarketplaceListingLink {
  kind: MarketplaceListingKind;
  /** The agent id, or the skill slug. */
  id: string;
}

/** `crypto.randomUUID()` in the Worker: lower-case hex in the 8-4-4-4-12 form. */
const MARKETPLACE_AGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * The Worker's `slugify`: lower-case letters, digits and hyphens, at most 64. No dot and no slash, so
 * a slug cannot reach another path.
 */
const MARKETPLACE_SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export function isMarketplaceAgentId(value: string): boolean {
  return MARKETPLACE_AGENT_ID_PATTERN.test(value);
}

export function isMarketplaceSkillSlug(value: string): boolean {
  return MARKETPLACE_SKILL_SLUG_PATTERN.test(value);
}
