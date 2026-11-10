import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpOAuth, type McpOAuthRecord, type McpOAuthStorage, secureOAuthFetch } from "./mcp-oauth-provider";

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function serverFor(receive: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(receive);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server has no port.");
  disposals.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}

const registrationSchema = z.object({
  client_name: z.string(),
  application_type: z.string(),
  redirect_uris: z.array(z.string()),
  scope: z.string().optional(),
});

async function authorizationServer(refuseNumericRedirect = false) {
  const registrations: Array<z.infer<typeof registrationSchema>> = [];
  let origin = "";
  origin = await serverFor((request, response) => {
    const path = new URL(request.url ?? "/", origin).pathname;
    response.setHeader("content-type", "application/json");
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      response.end(
        JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["tools"] }),
      );
      return;
    }
    if (path.startsWith("/.well-known/oauth-authorization-server")) {
      response.end(
        JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["tools", "offline_access"],
        }),
      );
      return;
    }
    if (path !== "/register" || request.method !== "POST") {
      response.writeHead(404).end("{}");
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => {
      body += part;
    });
    request.on("end", () => {
      const decoded = registrationSchema.safeParse(JSON.parse(body));
      if (!decoded.success) {
        response.writeHead(400).end(JSON.stringify({ error: "invalid_client_metadata" }));
        return;
      }
      registrations.push(decoded.data);
      if (refuseNumericRedirect && decoded.data.redirect_uris.some((url) => new URL(url).hostname === "127.0.0.1")) {
        response.writeHead(400).end(JSON.stringify({ error: "invalid_redirect_uri" }));
        return;
      }
      response.writeHead(201).end(JSON.stringify({ ...decoded.data, client_id: `fixture-${registrations.length}` }));
    });
  });
  return { origin, registrations };
}

function signInClient(origin: string, app?: McpOAuthRecord["app"]) {
  const resource = `${origin}/mcp`;
  const records = new Map<string, McpOAuthRecord>(app ? [[resource, { app }]] : []);
  const opened: URL[] = [];
  const storage: McpOAuthStorage = {
    read: (key) => records.get(key) ?? null,
    write: (key, record) =>
      Effect.sync(() => {
        records.set(key, record);
      }),
    clear: (key) =>
      Effect.sync(() => {
        records.delete(key);
      }),
  };
  const oauth = new McpOAuth({
    storage,
    redirectUrl: `${origin}/mcp-auth`,
    openExternal: async (url) => {
      opened.push(new URL(url));
    },
  });
  disposals.push(() => Effect.runPromise(oauth.close()));
  return { resource, oauth, opened };
}

describe("MCP OAuth loopback registration boundary", () => {
  it("registers a native app with the requested offline scope and only retries the same listener", async () => {
    const host = await authorizationServer(true);
    const { oauth, resource, opened } = signInClient(host.origin);
    const attempt = oauth.signIn(resource);
    if (!attempt) throw new Error("The fixture sign-in was refused.");
    expect(await Effect.runPromise(attempt.begin())).toBe(true);
    expect(host.registrations).toHaveLength(2);
    expect(host.registrations[0]?.application_type).toBe("native");
    expect(host.registrations[0]?.client_name).toBe("Tommy");
    expect(host.registrations[0]?.scope).toBe("tools offline_access");
    const initial = new URL(host.registrations[0]?.redirect_uris[0] ?? "");
    const retried = new URL(host.registrations[1]?.redirect_uris[0] ?? "");
    expect(initial.hostname).toBe("127.0.0.1");
    expect(retried.hostname).toBe("localhost");
    expect(retried.port).toBe(initial.port);
    expect(retried.pathname).toBe(initial.pathname);
    expect(opened[0]?.searchParams.get("redirect_uri")).toBe(retried.href);
    attempt.abandon();
  });

  it("tries the other loopback name after an unanswered browser trip", async () => {
    const host = await authorizationServer();
    const { oauth, resource, opened } = signInClient(host.origin);
    const first = oauth.signIn(resource);
    if (!first) throw new Error("The fixture sign-in was refused.");
    await Effect.runPromise(first.begin());
    first.abandon();
    const second = oauth.signIn(resource);
    if (!second) throw new Error("The fixture retry was refused.");
    await Effect.runPromise(second.begin());
    expect(host.registrations).toHaveLength(2);
    expect(new URL(opened[0]?.searchParams.get("redirect_uri") ?? "").hostname).toBe("127.0.0.1");
    expect(new URL(opened[1]?.searchParams.get("redirect_uri") ?? "").hostname).toBe("localhost");
    second.abandon();
  });

  it("does not change an administrator's registered app callback", async () => {
    const host = await authorizationServer();
    const { oauth, resource, opened } = signInClient(host.origin, { clientId: "fixture-manual-app", scope: "tools" });
    for (let index = 0; index < 2; index++) {
      const attempt = oauth.signIn(resource);
      if (!attempt) throw new Error("The fixture app sign-in was refused.");
      await Effect.runPromise(attempt.begin());
      attempt.abandon();
    }
    expect(host.registrations).toHaveLength(0);
    expect(opened.map((url) => url.searchParams.get("redirect_uri"))).toEqual([
      `${host.origin}/mcp-auth`,
      `${host.origin}/mcp-auth`,
    ]);
  });
});

describe("MCP OAuth response boundary", () => {
  it("treats a metadata request redirected to HTML as missing without changing MCP responses", async () => {
    const origin = await serverFor((request, response) => {
      if (request.url?.startsWith("/.well-known/")) {
        response.writeHead(302, { location: "/login" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end("<html>Sign in</html>");
    });
    const metadata = await secureOAuthFetch({ resource: `${origin}/mcp` })(
      `${origin}/.well-known/oauth-authorization-server`,
    );
    expect(metadata.status).toBe(404);
    const mcp = await secureOAuthFetch({ resource: `${origin}/mcp`, mcpTraffic: true })(`${origin}/mcp`);
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toBe("<html>Sign in</html>");
  });

  it("rejects an HTML token answer with a safe error instead of its response body", async () => {
    const origin = await serverFor((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end("<html>fixture-private-value</html>");
    });
    const fetchOAuth = secureOAuthFetch({ resource: `${origin}/mcp` });
    await expect(fetchOAuth(`${origin}/token`, { method: "POST", body: "grant_type=refresh_token" })).rejects.toThrow(
      /sign-in server/i,
    );
  });
});
