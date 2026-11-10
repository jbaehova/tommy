// @vitest-environment node
import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import { registerSecretValue } from "@tommy/logging";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { WorkflowGitHubChange } from "../backend/workflows/workflow-github-api";
import { WorkflowConnectorGitHub } from "./workflow-connector-github";
import { type WorkflowConnectorFetch, WorkflowConnectorHttp } from "./workflow-connector-http";

const secret = "private-example-value-729105";
const connection = {
  token: "example-github-token",
  webhookSecret: "example-webhook-secret",
  repositories: ["example/project"],
};
const change: WorkflowGitHubChange = {
  repository: "example/project",
  number: 1,
  action: "comment",
  title: "",
  body: "A report.",
  labels: [],
  people: [],
  reason: "completed",
  files: null,
};

describe("workflow connector export redaction", () => {
  it("refuses a secret-bearing GitHub identifier before making a request", async () => {
    registerSecretValue(secret);
    let requests = 0;
    const request: WorkflowConnectorFetch = async () => {
      requests += 1;
      return Response.json({});
    };
    const github = new WorkflowConnectorGitHub(connection, new WorkflowConnectorHttp(request));
    await expect(
      Effect.runPromise(github.change({ ...change, action: "label.remove", labels: [secret] })),
    ).rejects.toThrow();
    await expect(Effect.runPromise(github.change({ ...change, action: "assign", people: [secret] }))).rejects.toThrow();
    expect(requests).toBe(0);
  });

  it("does not publish or link a binary file that contains a known secret", async () => {
    registerSecretValue(secret);
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(secret)]);
    const requests: string[] = [];
    const request: WorkflowConnectorFetch = async (url) => {
      requests.push(url);
      return new Response(new Uint8Array(bytes));
    };
    const github = new WorkflowConnectorGitHub(connection, new WorkflowConnectorHttp(request));
    const result = await Effect.runPromise(
      github.attachFiles({
        ...change,
        files: {
          folder: "example",
          files: [
            {
              name: "image.png",
              contentType: "image/png",
              size: bytes.length,
              url: "https://raw.githubusercontent.com/example/project/main/image.png",
            },
          ],
        },
      }),
    );
    expect(result.files).toBeNull();
    expect(result.body).toBe(change.body);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("raw.githubusercontent.com");
  });

  it("redacts text file bytes before encoding them for repository storage", async () => {
    registerSecretValue(secret);
    const stored: string[] = [];
    const request: WorkflowConnectorFetch = async (url, input) => {
      if (url.startsWith("https://raw.githubusercontent.com/")) return new Response(`The result includes ${secret}.`);
      if (input.method === "PUT") {
        const body = JSON.parse(typeof input.body === "string" ? input.body : "null");
        if (!isDynamicRecord(body) || typeof body.content !== "string") throw new Error("Expected stored file bytes.");
        stored.push(Buffer.from(body.content, "base64").toString("utf8"));
        return Response.json({});
      }
      if (url.includes("/contents/")) return new Response(null, { status: 404 });
      return Response.json({ object: { sha: "example-sha" } });
    };
    const github = new WorkflowConnectorGitHub(connection, new WorkflowConnectorHttp(request));
    const result = await Effect.runPromise(
      github.attachFiles({
        ...change,
        files: {
          folder: "example",
          files: [
            {
              name: "report.txt",
              contentType: "text/plain",
              size: 100,
              url: "https://raw.githubusercontent.com/example/project/main/report.txt",
            },
          ],
        },
      }),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(secret);
    expect(stored[0]).toContain("[redacted]");
    expect(result.body).toContain("https://github.com/example/project/blob/");
  });
});
