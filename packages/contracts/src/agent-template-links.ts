/**
 * The addresses one agent template has: the link that opens that template in
 * the app, and the browser client's entry for it.
 *
 * ```
 * tommy://agents/<id>              the link the page button opens
 * /app?agent=<id>                    the page's link to the browser client, on the same origin
 * ```
 *
 * This follows `plugin-links.ts`: the host gives the kind, one path segment gives the id, and a
 * query is refused, so the shape cannot grow an `?install=1`. A link opens a preview in the app;
 * installing is still a press of Install there.
 */

export const TOMMY_AGENT_TEMPLATE_PATH_PREFIX = "/agents/";

/** The Worker makes ids from 16 random bytes in base64url, which is 22 characters. */
const AGENT_TEMPLATE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

export function isAgentTemplateId(value: string): boolean {
  return AGENT_TEMPLATE_ID_PATTERN.test(value);
}

/**
 * The site a share link names: a loopback origin only. Nothing else passes, so a configured address
 * cannot turn the copied link into another site.
 */
export function isAgentTemplateShareOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

export function createAgentTemplateShareUrl(id: string, origin: string): string {
  assertAgentTemplateId(id);
  if (!isAgentTemplateShareOrigin(origin)) throw new Error("The Tommy agent link origin is invalid.");
  return `${origin}${TOMMY_AGENT_TEMPLATE_PATH_PREFIX}${id}`;
}

function assertAgentTemplateId(id: string): void {
  if (!isAgentTemplateId(id)) throw new Error("The Tommy agent link is invalid.");
}
