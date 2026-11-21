/** The local OAuth callback. Telegram sign-ins use their separately scoped HTTPS callback. */
import type { LanguageService } from "./language-service";
import { type CallbackAnswer, startLoopbackCallbackServer } from "./loopback-callback-server";

/** The one path this listener answers. Everything else is a 404, including `/`. */
export const MCP_OAUTH_REDIRECT_PATH = "/mcp-auth";

/** The port tried first. Not assigned by IANA as far as this was checked; any other works the same. */
export const MCP_OAUTH_REDIRECT_PORT = 28_417;

export interface McpOAuthRedirectServer {
  /** The address to register and to send. Stable for as long as this process runs. */
  readonly redirectUrl: string;
  close: () => Promise<void>;
}

export interface McpOAuthRedirectServerOptions {
  /** Deliver a grant only for a pending local state. */
  deliver: (state: string, code: string) => boolean;
  /** Read on each request, so the page uses the language that is set at that time. */
  language: Pick<LanguageService, "locale" | "translate">;
  /** Tried first; any free port is used when it cannot be bound. */
  preferredPort?: number;
}

/**
 * Binds the listener, or fails.
 *
 * A failure is the caller's to handle rather than this module's: the sign-in still has the deep
 * link to fall back to, and a redirect address that silently became a different one is worse than
 * a named failure.
 */
export async function startMcpOAuthRedirectServer({
  deliver,
  language,
  preferredPort,
}: McpOAuthRedirectServerOptions): Promise<McpOAuthRedirectServer> {
  const server = await startLoopbackCallbackServer({
    path: MCP_OAUTH_REDIRECT_PATH,
    receive: (url) => receiveGrant(url, deliver),
    language,
    preferredPort,
    noPort: () => new Error("The MCP sign-in listener was given no port."),
  });
  return {
    redirectUrl: `http://127.0.0.1:${server.port}${MCP_OAUTH_REDIRECT_PATH}`,
    close: server.close,
  };
}

function receiveGrant(url: URL, deliver: McpOAuthRedirectServerOptions["deliver"]): CallbackAnswer {
  if (url.searchParams.get("error")) return { status: 400, message: "error.mcp.redirectRefused" };
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!code || !state) return { status: 400, message: "error.mcp.redirectNotSignIn" };
  return deliver(state, code)
    ? { status: 200, message: "error.mcp.redirectSignedIn" }
    : { status: 400, message: "error.mcp.redirectNoSignIn" };
}
