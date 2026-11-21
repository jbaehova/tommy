import { isAbsolute, resolve } from "node:path";

/**
 * The redirect addresses of the claude.ai connectors. A client that registers another address is
 * refused unless the server setting adds it.
 */
export const DEFAULT_REMOTE_MCP_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

export interface RemoteMcpSettings {
  /** The public HTTPS origin of the server, the one of the Telegram interface. */
  origin: string;
  /** The folders that the knowledge tools read, as absolute paths. */
  folders: string[];
  redirectUris: string[];
}

export type RemoteMcpSettingsResult =
  | { settings: RemoteMcpSettings }
  | { settings: null; problem: "off" | "telegram" | "folders" | "redirects" };

/** An extra redirect address: HTTPS, or HTTP on loopback for a local test client. */
function validRedirect(value: string): boolean {
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

/**
 * Reads the server settings of the remote MCP endpoint. It is off unless `TOMMY_REMOTE_MCP=on`. It
 * needs the Telegram interface: the owner approves each sign-in with a code in the manager chat.
 */
export function readRemoteMcpSettings(env: NodeJS.ProcessEnv, telegramOrigin: string | null): RemoteMcpSettingsResult {
  if (env.TOMMY_REMOTE_MCP !== "on") return { settings: null, problem: "off" };
  if (!telegramOrigin) return { settings: null, problem: "telegram" };
  const folders = (env.TOMMY_REMOTE_MCP_FOLDERS ?? "")
    .split(":")
    .map((value) => value.trim())
    .filter(Boolean);
  if (folders.some((folder) => !isAbsolute(folder))) return { settings: null, problem: "folders" };
  const extra = (env.TOMMY_REMOTE_MCP_REDIRECT_URIS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!extra.every(validRedirect)) return { settings: null, problem: "redirects" };
  return {
    settings: {
      origin: telegramOrigin,
      folders: [...new Set(folders.map((folder) => resolve(folder)))],
      redirectUris: [...new Set([...DEFAULT_REMOTE_MCP_REDIRECT_URIS, ...extra])],
    },
  };
}
