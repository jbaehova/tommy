// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { appendDiagnosticLog } from "./remote-diagnostics";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function logOf(messages: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tommy-remote-diagnostics-"));
  roots.push(root);
  for (const message of messages) await runCauseEffect(appendDiagnosticLog(root, "providers", message));
  return readFile(join(root, "providers.log"), "utf8");
}

describe("host diagnostic log", () => {
  it("redacts credentials in provider log lines and preserves Unicode", async () => {
    const log = await logOf([
      "starting stream api_key=sk-live-0123456789abcdef for owner@example.com\n",
      "pairing token 3f9a1c77b2e04d11\n",
      "Zażółć\n",
      "fatal",
    ]);

    expect(log).toContain("starting stream");
    expect(log).toContain("Zażółć\n");
    expect(log).toContain("fatal");
    expect(log).not.toContain("0123456789abcdef");
    expect(log).not.toContain("owner@example.com");
    expect(log).not.toContain("3f9a1c77b2e04d11");
  });

  it("redacts credentials at the end of long lines and preserves the next line", async () => {
    const log = await logOf([
      `${"x".repeat(8_010)}api_key=sk-live-0123456789abcdef\n`,
      `${"a ".repeat(3_987)}Authorization: Bearer sample_0123456789abcdef\n`,
      "next line\n",
    ]);

    expect(log).not.toContain("0123456789abcdef");
    expect(log).not.toContain("sample_0123456789abcdef");
    expect(log).toContain("next line\n");
  });
});
