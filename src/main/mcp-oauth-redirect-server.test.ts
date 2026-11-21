import { get } from "node:http";
import { translateFor } from "@tommy/i18n";
import { expect, it } from "vitest";
import { startMcpOAuthRedirectServer } from "./mcp-oauth-redirect-server";

it("sends a local grant only once and shows a fixed page for refusals and rejected hosts", async () => {
  const grants: string[] = [];
  const server = await startMcpOAuthRedirectServer({
    preferredPort: 0,
    language: { locale: "en", translate: translateFor("en") },
    deliver: (state, code) => {
      if (state !== "local-state" || grants.length > 0) return false;
      grants.push(code);
      return true;
    },
  });
  try {
    const callback = `${server.redirectUrl}?state=local-state&code=fixture-grant`;
    const otherHost = await new Promise<number | undefined>((resolve, reject) => {
      get(callback, { headers: { host: "remote.example.com" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    expect(otherHost).toBe(403);
    expect((await fetch(callback, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${server.redirectUrl}?state=local-state&error=access_denied`)).status).toBe(400);
    expect(grants).toEqual([]);
    const result = await fetch(callback);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await result.text()).not.toContain("fixture-grant");
    expect((await fetch(callback)).status).toBe(400);
    expect(grants).toEqual(["fixture-grant"]);
  } finally {
    await server.close();
  }
});
