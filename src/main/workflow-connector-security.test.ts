// @vitest-environment node
import { createHmac } from "node:crypto";
import { redactText } from "@tommy/logging";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { readWebhookPublicOrigin, readWorkflowConnectorSettings } from "./workflow-connector-config";
import { equalWebhookSecret, verifyGitHubWebhook, verifySlackWebhook } from "./workflow-connector-security";
import { WorkflowConnectors } from "./workflow-connectors";

const token = "example-connector-token-123456789";
const signingSecret = "example-signing-secret-123456789";

describe("workflow connector trust boundary", () => {
  it("checks GitHub raw bytes and Slack's signed timestamp in constant-time comparisons", () => {
    const body = Buffer.from('{"text":"hello"}');
    const github = `sha256=${createHmac("sha256", signingSecret).update(body).digest("hex")}`;
    const timestamp = "1800000000";
    const slack = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
    expect(verifyGitHubWebhook(signingSecret, body, github)).toBe(true);
    expect(verifyGitHubWebhook(signingSecret, Buffer.from("{}"), github)).toBe(false);
    expect(verifyGitHubWebhook(signingSecret, body, "sha256=x")).toBe(false);
    expect(verifySlackWebhook(signingSecret, body, timestamp, slack, 1_800_000_000_000)).toBe(true);
    expect(verifySlackWebhook(signingSecret, body, timestamp, slack, 1_800_000_300_001)).toBe(false);
    expect(verifySlackWebhook(signingSecret, body, "1800000001", slack, 1_800_000_000_000)).toBe(false);
    expect(equalWebhookSecret(signingSecret, signingSecret)).toBe(true);
    expect(equalWebhookSecret(signingSecret, "incorrect")).toBe(false);
    expect(equalWebhookSecret(signingSecret, "")).toBe(false);
  });

  it("redacts connector credentials from outgoing message text and diagnostic text", async () => {
    const settings = readWorkflowConnectorSettings({
      TOMMY_WORKFLOW_CONNECTORS_JSON: JSON.stringify({
        github: { token, webhookSecret: signingSecret, repositories: ["example/project"] },
        slack: [
          {
            id: "slack-example",
            name: "Example",
            token,
            signingSecret,
            workspaceId: "TEXAMPLE",
            serviceUserId: "UEXAMPLE",
            channels: [{ id: "CEXAMPLE", name: "general" }],
          },
        ],
        telegram: [
          {
            id: "telegram-example",
            name: "Example chat",
            token,
            webhookSecret: "example_telegram_secret_123456789",
            serviceUserId: "12345",
            username: "tommy_example",
            chatId: "-12345",
          },
        ],
      }),
    });
    expect(settings.invalid).toBe(false);
    const bodies: string[] = [];
    const connectors = new WorkflowConnectors({
      config: settings.config,
      workflows: () => null,
      request: async (_url, init) => {
        if (typeof init.body === "string") bodies.push(init.body);
        return Response.json({ ok: true });
      },
    });
    await Effect.runPromise(connectors.start());
    try {
      expect(
        await Effect.runPromise(connectors.post("slack-example", "CEXAMPLE", `safe ${token} ${signingSecret}`)),
      ).toEqual({ posted: true });
    } finally {
      await Effect.runPromise(connectors.stop());
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("safe");
    expect(bodies[0]).not.toContain(token);
    expect(bodies[0]).not.toContain(signingSecret);
    expect(redactText(`request failed: ${token} ${signingSecret}`)).not.toContain(token);
    expect(redactText(signingSecret)).not.toContain(signingSecret);
    expect(redactText(`https://api.telegram.org/bot${token}/sendMessage`)).not.toContain(token);
  });

  it("disables missing or invalid optional settings and rejects ambiguous public origins", () => {
    expect(readWorkflowConnectorSettings({})).toEqual({ config: {}, invalid: false });
    expect(readWorkflowConnectorSettings({ TOMMY_WORKFLOW_CONNECTORS_JSON: "not JSON" })).toEqual({
      config: {},
      invalid: true,
    });
    expect(
      readWorkflowConnectorSettings({ TOMMY_WORKFLOW_CONNECTORS_JSON: JSON.stringify({ slack: [{ token }] }) }).invalid,
    ).toBe(true);
    expect(readWebhookPublicOrigin({ TOMMY_WEBHOOK_PUBLIC_URL: "https://tommy.example.com" })).toBe(
      "https://tommy.example.com",
    );
    for (const value of [
      "http://example.com",
      "https://example.com/hooks",
      "https://user:secret@example.com",
      "https://example.com?token=x",
      "https://example.com/#x",
    ])
      expect(readWebhookPublicOrigin({ TOMMY_WEBHOOK_PUBLIC_URL: value })).toBeNull();
  });
});
