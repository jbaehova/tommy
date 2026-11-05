/**
 * The one link that this app receives: the return leg of an MCP sign-in,
 * `tommy://mcp-auth?code=...&state=...`.
 *
 * Both halves are required and neither is inspected here. `state` is what the waiting sign-in is
 * keyed by, so a link this run did not start finds nothing and does nothing. An error the
 * authorization server sends back instead of a code is no link at all: the sign-in ends on its own
 * deadline.
 */

export type DeepLink = { kind: "mcp-auth"; state: string; code: string };

/**
 * Where an MCP grant comes back when this machine could not bind a loopback port. Some authorization
 * servers refuse a private-use scheme at `/authorize`, so this is the fallback.
 */
export const MCP_OAUTH_REDIRECT_URL = "tommy://mcp-auth";

const MCP_OAUTH_HOST = "mcp-auth";

export function parseDeepLink(value: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "tommy:" || url.hostname !== MCP_OAUTH_HOST) return null;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return null;
  return { kind: "mcp-auth", state, code };
}

/** The first argument that is a link, for a second instance's argv. */
export function findDeepLink(values: string[]): DeepLink | null {
  for (const value of values) {
    const link = parseDeepLink(value);
    if (link) return link;
  }
  return null;
}
