// Drives real HTTP requests through the production attachment response and a real temporary file.
// Run: bun scripts/attachment-range-e2e.ts
// Writes .tommy-build/attachment-range-e2e/report.json.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { attachmentBytesResponse, fileResponse } from "../src/main/file-response";

const out = resolve(".tommy-build/attachment-range-e2e");
const root = await mkdtemp(join(tmpdir(), "tommy-attachment-range-"));
const path = join(root, "managed.bin");
const bytes = Buffer.from("0123456789");
await writeFile(path, bytes);
await writeFile(join(root, "empty.bin"), "");
const report: { passed: boolean; checks: string[]; failure?: string } = { passed: false, checks: [] };
const server = createServer((request, reply) => {
  void (async () => {
    const range = request.headers.range ?? null;
    // No request path becomes a local path. The fixture uses the same managed-ID boundary as main.
    const response =
      request.url === "/cached"
        ? attachmentBytesResponse(bytes, { "Content-Type": "application/octet-stream" }, range)
        : await runCauseEffect(
            fileResponse(
              request.url === "/empty" ? join(root, "empty.bin") : path,
              { "Content-Type": "application/octet-stream" },
              range,
            ),
          );
    reply.writeHead(response.status, Object.fromEntries(response.headers));
    const reader = response.body?.getReader();
    if (!reader) {
      reply.end();
      return;
    }
    reply.once("close", () => {
      void reader.cancel().catch(() => undefined);
    });
    while (!reply.destroyed) {
      const next = await reader.read();
      if (next.done) break;
      reply.write(next.value);
    }
    reply.end();
  })().catch((error: unknown) => reply.destroy(error instanceof Error ? error : new Error(String(error))));
});
try {
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const route of ["/managed", "/cached"]) {
    for (const [range, status, expected, contentRange] of [
      ["bytes=2-5", 206, "2345", "bytes 2-5/10"],
      ["bytes=7-", 206, "789", "bytes 7-9/10"],
      ["bytes=-3", 206, "789", "bytes 7-9/10"],
      ["bytes=0-99", 206, "0123456789", "bytes 0-9/10"],
      ["bytes=20-", 416, "", "bytes */10"],
      ["bytes=-0", 416, "", "bytes */10"],
      ["bytes=2-1", 200, "0123456789", null],
      ["bytes=0-1,4-5", 200, "0123456789", null],
      ["bytes=9007199254740993-", 200, "0123456789", null],
    ] as const) {
      const response = await fetch(`${origin}${route}`, { headers: { Range: range } });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("Content-Range"), contentRange);
      assert.equal(response.headers.get("Accept-Ranges"), "bytes");
      assert.equal(response.headers.get("Content-Length"), String(expected.length));
      assert.equal(await response.text(), expected);
    }
    report.checks.push(
      `${route}: bounded, suffix, open, clamped, invalid and unsatisfiable requests return exact bytes.`,
    );
  }
  const empty = await fetch(`${origin}/empty`);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "");
  const emptyRange = await fetch(`${origin}/empty`, { headers: { Range: "bytes=0-" } });
  assert.equal(emptyRange.status, 416);
  assert.equal(emptyRange.headers.get("Content-Range"), "bytes */0");
  report.checks.push("Empty files return 200 without a range and 416 with a valid range.");
  for (let index = 0; index < 32; index += 1) {
    const response = await fetch(`${origin}/managed`);
    await response.body?.cancel();
  }
  report.checks.push("A cancelled response closes its stream; later requests still succeed.");
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  });
  await rm(root, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
