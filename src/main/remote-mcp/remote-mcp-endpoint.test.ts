import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AgentMemory } from "@tommy/contracts/ipc";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { RemoteMcpMessageRow } from "../../backend/remote-mcp-reader";
import { RemoteMcpEndpoint } from "./remote-mcp-endpoint";
import { RemoteMcpGrants } from "./remote-mcp-grants";
import { DEFAULT_REMOTE_MCP_REDIRECT_URIS } from "./remote-mcp-settings";
import { RemoteMcpTools } from "./remote-mcp-tools";

const REDIRECT = DEFAULT_REMOTE_MCP_REDIRECT_URIS[0];
const FAKE_KEY = `sk-ant-api03-${"a".repeat(80)}`;

function memory(agentId: string, text: string): AgentMemory {
  return {
    id: `memory-${text.length}`,
    agentId,
    text,
    origin: "manual",
    sourceTurnId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

const message: RemoteMcpMessageRow = {
  agentId: "agent-1",
  threadId: "thread-1",
  messageId: "message-1",
  author: "user",
  createdAt: "2026-11-02T00:00:00.000Z",
  text: `Remember the trip to Busan. The key is ${FAKE_KEY}`,
};

interface SaveCall {
  client: string;
  text: string;
  timeoutSeconds: number;
}

interface Harness {
  origin: string;
  saves: SaveCall[];
  backups: string;
  notices: string[];
  folder: string;
  outside: string;
  grants: RemoteMcpGrants;
  advance(ms: number): void;
  close(): Promise<void>;
}

async function start(options: { save?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "remote-mcp-"));
  const folder = join(root, "wiki");
  const outside = join(root, "private");
  await mkdir(join(folder, "concepts"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(folder, "index.md"), "# Index\nBusan trip notes are in concepts.\n");
  await writeFile(join(folder, "concepts", "travel.md"), `Busan in spring.\napi key ${FAKE_KEY}\n`);
  await writeFile(join(outside, "secret.md"), "outside text that must stay private");
  await symlink(join(outside, "secret.md"), join(folder, "linked.md"));
  await writeFile(join(folder, "keys.pem"), "inside key file that is not a note");
  await symlink(join(folder, "keys.pem"), join(folder, "inner.md"));
  let clock = Date.now();
  const grants = new RemoteMcpGrants({ path: join(root, "grants.json"), now: () => clock });
  await Effect.runPromise(grants.load());
  const saves: SaveCall[] = [];
  const backups = join(root, "backups");
  const tools = new RemoteMcpTools({
    agents: () => [{ id: "agent-1", name: "Tommy", title: "Root", description: "The root agent" }],
    memories: () => [memory("agent-1", "The owner likes the Busan sea")],
    sharedMemories: () => [memory("tommy-shared-memory", "Shared fact about Seoul")],
    messages: {
      page: (_agents, cursor) => (cursor ? [] : [message]),
      around: () => [message],
    },
    folders: [folder],
    ...(options.save
      ? {
          saveKnowledge: async (input: SaveCall) => {
            saves.push(input);
            await writeFile(join(folder, "concepts", "travel.md"), "Busan in summer.\n");
            return { agentName: "Tommy", status: "completed" as const, text: `Updated concepts/travel.md ${FAKE_KEY}` };
          },
          backupFolder: backups,
        }
      : {}),
  });
  const notices: string[] = [];
  let endpoint: RemoteMcpEndpoint | null = null;
  const server = createServer((request, response) => {
    void Effect.runPromise(endpoint?.handle(request, response) ?? Effect.succeed(false)).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const origin = `http://127.0.0.1:${address.port}`;
  endpoint = new RemoteMcpEndpoint({
    settings: {
      origin,
      folders: [folder],
      redirectUris: [...DEFAULT_REMOTE_MCP_REDIRECT_URIS],
      knowledgeAgent: options.save ? "Tommy" : null,
    },
    grants,
    tools,
    tellOwner: (text) =>
      Effect.sync(() => {
        notices.push(text((key, ...params) => `${key} ${JSON.stringify(params[0] ?? {})}`));
        return true;
      }),
    version: "0.0.0-test",
  });
  return {
    origin,
    saves,
    backups,
    notices,
    folder,
    outside,
    grants,
    advance: (ms) => {
      clock += ms;
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function register(origin: string, redirect: string = REDIRECT) {
  return fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: "Claude", token_endpoint_auth_method: "none" }),
  });
}

/** Runs the sign-in to the redirect with a code, as a browser and the owner would. */
async function signIn(harness: Harness, typed?: (code: string) => string[]) {
  const registered = await register(harness.origin);
  const { client_id: clientId } = z.object({ client_id: z.string() }).parse(await registered.json());
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-1",
    resource: `${harness.origin}/mcp`,
  });
  const page = await fetch(`${harness.origin}/oauth/authorize?${query}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  const request = /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const notice = harness.notices.at(-1) ?? "";
  const code = /"code":"(\d{4}) (\d{4})"/.exec(notice)?.slice(1).join("") ?? "";
  expect(code).toHaveLength(8);
  let answer: Response | null = null;
  for (const value of typed ? typed(code) : [code]) {
    answer = await fetch(`${harness.origin}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request, code: value, decision: "approve" }),
    });
  }
  return { answer, clientId, verifier };
}

async function exchange(origin: string, body: Record<string, string>) {
  return fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

/** Signs in and connects an MCP client with the access token. */
async function connect(harness: Harness) {
  const { answer, clientId, verifier } = await signIn(harness);
  const code = new URL(answer?.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const exchanged = await exchange(harness.origin, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  const tokens = z.object({ access_token: z.string() }).parse(await exchanged.json());
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${harness.origin}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    }),
  );
  const call = async (name: string, args: Record<string, string>) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const parts = result.content.flatMap((item) => (item.type === "text" ? [item.text] : []));
    return { text: parts.join("\n"), isError: result.isError === true };
  };
  return { client, call };
}

describe("remote MCP endpoint", () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await start();
  });
  afterEach(async () => {
    await harness.close();
  });

  it("refuses a client that registers an unknown redirect address", async () => {
    const response = await register(harness.origin, "https://attacker.example.com/callback");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("gives tokens only for the code from the owner's Telegram chat and PKCE", async () => {
    const { answer, clientId, verifier } = await signIn(harness);
    expect(answer?.status).toBe(302);
    const location = new URL(answer?.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("state-1");
    const code = location.searchParams.get("code") ?? "";

    const wrongVerifier = await exchange(harness.origin, {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: randomBytes(32).toString("base64url"),
    });
    expect(wrongVerifier.status).toBe(400);
    // A failed exchange spends the code.
    const again = await exchange(harness.origin, {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(again.status).toBe(400);
  });

  it("ends a sign-in after five wrong codes", async () => {
    const { answer } = await signIn(harness, (code) => [
      ...Array.from({ length: 5 }, (_, index) => String((Number(code) + index + 1) % 100_000_000).padStart(8, "0")),
      code,
    ]);
    expect(answer?.status).toBe(400);
    expect(answer?.headers.get("location")).toBeNull();
  });

  it("serves redacted read-only tools to a signed-in client and stops after revocation", async () => {
    const { answer, clientId, verifier } = await signIn(harness);
    const code = new URL(answer?.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const exchanged = await exchange(harness.origin, {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    const tokens = z.object({ access_token: z.string(), refresh_token: z.string() }).parse(await exchanged.json());
    expect(harness.notices.at(-1)).toContain("status.messaging.remoteMcpConnected");

    const unauthorized = await fetch(`${harness.origin}/mcp`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata=");

    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${harness.origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    const listed = await client.listTools();
    expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    const text = async (name: string, args: { query?: string; path?: string }) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      const parts = result.content.flatMap((item) => (item.type === "text" ? [item.text] : []));
      return { text: parts.join("\n"), isError: result.isError === true };
    };

    const memories = await text("search_memories", { query: "busan" });
    expect(memories.text).toContain("Busan sea");
    const chats = await text("search_conversations", { query: "Busan" });
    expect(chats.text).toContain("trip to Busan");
    expect(chats.text).not.toContain(FAKE_KEY);
    const file = await text("read_knowledge", { path: "wiki/concepts/travel.md" });
    expect(file.text).toContain("Busan in spring");
    expect(file.text).not.toContain(FAKE_KEY);
    for (const path of ["wiki/../private/secret.md", "wiki/linked.md", "private/secret.md", "wiki/inner.md"]) {
      const escaped = await text("read_knowledge", { path });
      expect(escaped.isError).toBe(true);
      expect(escaped.text).not.toContain("outside text");
      expect(escaped.text).not.toContain("inside key file");
    }
    const search = await text("search_knowledge", { query: "outside" });
    expect(search.text).not.toContain("outside text");
    await client.close();

    // A refresh replaces the refresh token. A retry of the old one right away still works, as for a
    // client whose answer was lost. The old one used again later ends the grant.
    const refresh = (refreshToken: string) =>
      exchange(harness.origin, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    const accessOf = async (response: Response) => {
      expect(response.status).toBe(200);
      return z.object({ access_token: z.string() }).parse(await response.json()).access_token;
    };
    await accessOf(await refresh(tokens.refresh_token));
    const retried = await accessOf(await refresh(tokens.refresh_token));
    harness.advance(61_000);
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    const afterReuse = await fetch(`${harness.origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${retried}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(afterReuse.status).toBe(401);
    expect(harness.grants.list()).toHaveLength(0);
  });
});

describe("remote MCP knowledge saving", () => {
  let harness: Harness;
  afterEach(async () => {
    await harness.close();
  });

  it("offers no save tool when the server has no knowledge agent", async () => {
    harness = await start();
    const { client, call } = await connect(harness);
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("save_knowledge");
    const refused = await call("save_knowledge", { request: "Add a page" });
    expect(refused.isError).toBe(true);
    expect(harness.saves).toHaveLength(0);
    await client.close();
  });

  it("copies the knowledge files, then gives the request to the knowledge agent", async () => {
    harness = await start({ save: true });
    expect(harness.notices.length).toBe(0);
    const { client, call } = await connect(harness);
    expect(harness.notices[0]).toContain("status.messaging.remoteMcpCodeSave");
    expect(harness.notices.at(-1)).toContain("status.messaging.remoteMcpConnectedSave");
    const tools = (await client.listTools()).tools;
    const save = tools.find((tool) => tool.name === "save_knowledge");
    expect(save?.annotations?.readOnlyHint).toBe(false);
    expect(tools.filter((tool) => tool.name !== "save_knowledge").every((tool) => tool.annotations?.readOnlyHint)).toBe(
      true,
    );

    const result = await call("save_knowledge", { request: "Busan is in summer now", content: "Busan in summer" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Updated concepts/travel.md");
    expect(result.text).not.toContain(FAKE_KEY);
    // The client is named by its redirect host, not by the name it registered.
    expect(harness.saves).toEqual([
      expect.objectContaining({ client: new URL(REDIRECT).host, text: expect.stringContaining("Busan in summer") }),
    ]);
    const [backup] = await readdir(harness.backups);
    expect(backup).toBeDefined();
    const copied = await readFile(join(harness.backups, backup ?? "", "wiki", "concepts", "travel.md"), "utf8");
    expect(copied).toContain("Busan in spring");
    // The backup holds the folder's text files only: never what a link inside it names.
    const listing = await readdir(join(harness.backups, backup ?? "", "wiki"));
    expect(listing).not.toContain("linked.md");
    expect(listing).not.toContain("keys.pem");
    await client.close();
  });
});
