/**
 * The addresses one plugin listing has: the link that opens that listing
 * in the app, and the browser client's entry for it.
 *
 * ```
 * tommy://plugins/<slug>              the link the page button opens
 * /app?plugin=<slug>                    the page's link to the browser client, on the same origin
 * ```
 *
 * The host gives the kind and the path gives the argument, which is the rule `parseInviteUrl`
 * already follows with `hostname === "join"`. An invite needs four fields and so needs a query; a
 * plugin needs one identifier, so a path segment is enough. Refusing a query outright is what stops
 * the shape growing an `?install=1` later.
 *
 * Both forms are *built* from a slug and never read out of catalog data. A listing therefore cannot
 * put a foreign address behind the button that says it copies its own link.
 *
 * `invite-links.ts` is untouched by this: it owns `join`, and the router asks it first, so no invite
 * rule becomes weaker.
 */

export const TOMMY_PLUGIN_HOST = "plugins";

/**
 * A slug cannot hold a dot, an upper-case letter or a slash. The dot is the load-bearing one: it is
 * what stops a slug reaching `catalog.json` when the static catalog routes land beside these pages.
 */
const PLUGIN_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export function isPluginSlug(value: string): boolean {
  return PLUGIN_SLUG_PATTERN.test(value);
}

/**
 * The slug a plugin link names, in either form. Throws for anything else, so a caller that wants a
 * decision rather than a value uses `isPluginUrl`.
 */
export function parsePluginUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The Tommy plugin link is invalid.");
  }

  const customScheme = url.protocol === "tommy:" && url.hostname === TOMMY_PLUGIN_HOST;
  if (
    !customScheme ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("The Tommy plugin link is invalid.");
  }

  /* One segment after the prefix, and no empty one. `..` and a trailing slash both fail here before
     the pattern ever sees them. */
  const rest = url.pathname.replace(/^\//u, "");
  const segments = rest.split("/");
  if (segments.length !== 1) {
    throw new Error("The Tommy plugin link is invalid.");
  }

  const slug = segments[0] ?? "";
  assertPluginSlug(slug);
  return slug;
}

export function isPluginUrl(value: string): boolean {
  try {
    parsePluginUrl(value);
    return true;
  } catch {
    return false;
  }
}

function assertPluginSlug(slug: string): void {
  if (!isPluginSlug(slug)) {
    throw new Error("The Tommy plugin link is invalid.");
  }
}
