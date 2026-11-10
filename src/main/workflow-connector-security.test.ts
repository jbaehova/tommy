// @vitest-environment node
import { createHmac } from "node:crypto";
import { redactText } from "@tommy/logging";
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

  it("keeps credentials out of the public catalog and registers them for redaction", () => {
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
    const connectors = new WorkflowConnectors({ config: settings.config, workflows: () => null });
    const catalog = JSON.stringify(connectors.catalog());
    expect(catalog).not.toContain(token);
    expect(catalog).not.toContain(signingSecret);
    expect(catalog).not.toContain("webhookSecret");
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
