import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { McpOAuthProxy } from "./mcp-oauth-proxy";

it("forwards MCP routing headers while isolating provider credentials and route bearers", async () => {
  const requests: IncomingHttpHeaders[] = [];
  const upstream = createServer((request, response) => {
    requests.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("The upstream fixture has no port.");
  const proxy = new McpOAuthProxy({
    settings: null,
    target: () =>
      Effect.succeed({
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: [{ key: "x-row-header", value: "fixture-row-value" }],
        token: "fixture-upstream-token",
      }),
    refresh: () => Effect.succeed(null),
  });
  try {
    const route = await Effect.runPromise(proxy.route("a".repeat(32)));
    const response = await fetch(route.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${route.bearer}`,
        cookie: "fixture-provider-cookie",
        "x-provider-key": "fixture-provider-key",
        "content-type": "application/json",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "example_tool",
        "mcp-param-project": "example-project",
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"example_tool"}}',
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authorization).toBe("Bearer fixture-upstream-token");
    expect(requests[0]?.cookie).toBeUndefined();
    expect(requests[0]?.["x-provider-key"]).toBeUndefined();
    expect(requests[0]?.["x-row-header"]).toBe("fixture-row-value");
    expect(requests[0]?.["mcp-method"]).toBe("tools/call");
    expect(requests[0]?.["mcp-name"]).toBe("example_tool");
    expect(requests[0]?.["mcp-param-project"]).toBe("example-project");
    const other = await Effect.runPromise(proxy.route("b".repeat(32)));
    const refused = await fetch(other.url, { headers: { authorization: `Bearer ${route.bearer}` } });
    expect(refused.status).toBe(403);
    await refused.text();
    expect(requests).toHaveLength(1);
  } finally {
    await Effect.runPromise(proxy.close());
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
      upstream.closeAllConnections();
    });
  }
});
