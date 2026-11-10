// @vitest-environment node

import { EventEmitter } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import {
  decodeBrowserProfileProxyInput,
  decodeHostBrowserProfileProxy,
  parseBrowserProfileProxy,
} from "@tommy/contracts/browser-profile-proxy";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { openBrowserProxyRelay } from "../backend/browser-profiles/browser-proxy-relay";

const profileId = "1234567890abcdef1234567890abcdef";

/** A real TCP origin deliberately ignores Connection: close, as an untrusted site may do. */
async function singleHttpRequest(headers: string, chunks: readonly string[]): Promise<void> {
  let received = "";
  const progress = new EventEmitter();
  const sockets = new Set<Socket>();
  const expectedHead = `POST /first HTTP/1.1\r\nHost: first.example.com\r\n${headers}Connection: close\r\n\r\n`;
  const expected = expectedHead + chunks.join("");
  const origin = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (bytes) => {
      received += bytes.toString();
      progress.emit("received");
      if (received.length === expected.length)
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    origin.once("error", reject);
    origin.listen(0, "127.0.0.1", resolve);
  });
  const address = origin.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture origin.");
  const targets: string[] = [];
  const relay = await Effect.runPromise(
    openBrowserProxyRelay(async (target) => {
      targets.push(target.host);
      return { stream: createConnection({ host: "127.0.0.1", port: address.port }), early: Buffer.alloc(0) };
    }),
  );
  const client = createConnection({ host: relay.host, port: relay.port });
  const connected = new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  const closed = new Promise<void>((resolve, reject) => {
    client.once("close", () => resolve());
    client.once("error", reject);
  });
  const observed = (length: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (received.length < length) return;
        progress.off("received", check);
        resolve();
      };
      progress.on("received", check);
      check();
    });
  let response = "";
  let sentAgain = false;
  client.on("data", (bytes) => {
    response += bytes.toString();
    if (sentAgain || !response.includes("\r\n\r\n")) return;
    sentAgain = true;
    client.write(
      "GET http://second.example.com/private HTTP/1.1\r\nHost: second.example.com\r\nCookie: example-private=second-site\r\n\r\n",
    );
  });
  try {
    await connected;
    const authorization = Buffer.from(`${relay.username}:${relay.password}`).toString("base64");
    client.write(
      `POST http://first.example.com/first HTTP/1.1\r\nHost: first.example.com\r\nProxy-Authorization: Basic ${authorization}\r\n${headers}\r\n`,
    );
    await observed(expectedHead.length);
    let length = expectedHead.length;
    for (const chunk of chunks) {
      client.write(chunk);
      length += Buffer.byteLength(chunk);
      await observed(length);
    }
    await closed;
    expect(sentAgain).toBe(true);
    expect(targets).toEqual(["first.example.com"]);
    expect(received).toBe(expected);
    expect(received).not.toContain("second.example.com");
    expect(received).not.toContain("example-private");
  } finally {
    client.destroy();
    await Effect.runPromise(relay.close);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
}

describe("Browser profile proxy boundary", () => {
  it("bounds a complete proxy header and closes a refused connection", async () => {
    let exits = 0;
    const relay = await Effect.runPromise(
      openBrowserProxyRelay(async () => {
        exits += 1;
        throw new Error("No upstream connection in this fixture.");
      }),
    );
    const request = (head: string) =>
      new Promise<string>((resolve, reject) => {
        const client = createConnection({ host: relay.host, port: relay.port });
        let response = "";
        client.on("data", (chunk) => {
          response += chunk.toString();
        });
        client.on("error", reject);
        client.on("close", () => resolve(response));
        client.on("connect", () => client.write(head));
      });
    try {
      expect(await request("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n")).toContain(
        "407 Proxy Authentication Required",
      );
      const authorization = Buffer.from(`${relay.username}:${relay.password}`).toString("base64");
      const oversized = `CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${authorization}\r\nX-Padding: ${"x".repeat(64 * 1024)}\r\n\r\n`;
      expect(await request(oversized)).toContain("400 Bad Request");
      for (const headers of [
        "Content-Length: 0\r\nTransfer-Encoding: chunked\r\n",
        "Content-Length: 0\r\nContent-Length: 1\r\n",
        "Content-Length: 0\r\nContent-Length: 0\r\n",
        "Transfer-Encoding: gzip, chunked\r\n",
      ]) {
        expect(
          await request(
            `POST http://example.com/ HTTP/1.1\r\nProxy-Authorization: Basic ${authorization}\r\n${headers}\r\n`,
          ),
        ).toContain("400 Bad Request");
      }
      expect(
        await request(
          `POST http://example.com/ HTTP/1.1\r\nProxy-Authorization: Basic ${authorization}\r\nContent-Length: 0\r\n\r\nGET http://second.example.com/private HTTP/1.1\r\n\r\n`,
        ),
      ).toContain("400 Bad Request");
      expect(exits).toBe(0);
    } finally {
      await Effect.runPromise(relay.close);
    }
  });

  it("never forwards a later site's request after a bodyless HTTP request", async () => {
    await singleHttpRequest("", []);
  });

  it("streams one Content-Length body and refuses later request bytes", async () => {
    await singleHttpRequest("Content-Length: 4\r\n", ["d", "ata"]);
  });

  it("streams split chunk framing and trailers without forwarding a later site's request", async () => {
    await singleHttpRequest("Transfer-Encoding: chunked\r\n", [
      "4\r",
      "\nda",
      "ta\r",
      "\n0\r\n",
      "X-Example: yes\r\n",
      "\r\n",
    ]);
  });

  it("rejects credential-bearing host responses and non-proxy schemes", () => {
    expect(() =>
      decodeHostBrowserProfileProxy({ profileId, address: "http://user:secret@example.com:8080", hasPassword: true }),
    ).toThrow();
    expect(() =>
      decodeHostBrowserProfileProxy({ profileId, address: null, hasPassword: false, password: "secret" }),
    ).toThrow();
    expect(parseBrowserProfileProxy("direct://example.com")).toBeNull();
    expect(parseBrowserProfileProxy("http://example.com:8080/path")).toBeNull();
    expect(parseBrowserProfileProxy("socks5://user:secret@example.com:1080")).toMatchObject({
      scheme: "socks5",
      username: "user",
      password: "secret",
    });
    expect(() => decodeBrowserProfileProxyInput({ profileId, address: null, keepPassword: "true" })).toThrow();
  });
});
