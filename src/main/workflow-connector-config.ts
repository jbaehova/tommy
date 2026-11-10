import { createTommyLogger, registerSecretValue } from "@tommy/logging";
import { Schema } from "effect";

const logger = createTommyLogger("workflow-connectors");

const text = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum), Schema.isPattern(/^[^\p{Cc}]+$/u));
const identifier = text(128).check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const secret = text(4_096).check(Schema.isMinLength(16));
const channel = Schema.Struct({ id: identifier, name: text(256) });
const github = Schema.Struct({
  token: secret,
  webhookSecret: secret,
  appSlug: Schema.optionalKey(text(100).check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))),
  repositories: Schema.Array(text(256).check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
});
const slack = Schema.Struct({
  id: identifier,
  name: text(256),
  token: secret,
  signingSecret: secret,
  workspaceId: identifier,
  serviceUserId: identifier,
  channels: Schema.Array(channel).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
/** One Telegram connection is one linked chat. A reply must use that chat as well. */
const telegram = Schema.Struct({
  id: identifier,
  name: text(256),
  token: secret,
  webhookSecret: text(256).check(Schema.isMinLength(16), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  serviceUserId: text(32).check(Schema.isPattern(/^\d+$/)),
  username: text(64).check(Schema.isPattern(/^[A-Za-z0-9_]+$/)),
  chatId: text(32).check(Schema.isPattern(/^-?\d+$/)),
});

const WorkflowConnectorConfiguration = Schema.Struct({
  github: Schema.optionalKey(github),
  slack: Schema.optionalKey(Schema.Array(slack).check(Schema.isMaxLength(20))),
  telegram: Schema.optionalKey(Schema.Array(telegram).check(Schema.isMaxLength(100))),
});

export type WorkflowConnectorConfig = typeof WorkflowConnectorConfiguration.Type;
export type SlackWorkflowConnection = typeof slack.Type;
export type TelegramWorkflowConnection = typeof telegram.Type;
export type GitHubWorkflowConnection = typeof github.Type;

export interface WorkflowConnectorSettings {
  config: WorkflowConnectorConfig;
  /** Invalid optional configuration is disabled. The original value is never returned or logged. */
  invalid: boolean;
}

/** Host-only configuration. Neither the input nor its credentials may cross IPC or the Team API. */
export function readWorkflowConnectorSettings(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkflowConnectorSettings {
  const input = environment.TOMMY_WORKFLOW_CONNECTORS_JSON;
  if (!input?.trim()) return { config: {}, invalid: false };
  // Register the whole envelope before parsing. A malformed envelope must be redacted as well.
  registerSecretValue(input);
  try {
    if (Buffer.byteLength(input) > 128 * 1_024) return { config: {}, invalid: true };
    const config = Schema.decodeUnknownSync(WorkflowConnectorConfiguration)(JSON.parse(input));
    const ids = [...(config.slack ?? []), ...(config.telegram ?? [])].map((connection) => connection.id);
    if (new Set(ids).size !== ids.length) return { config: {}, invalid: true };
    for (const connection of config.slack ?? []) {
      if (new Set(connection.channels.map((item) => item.id)).size !== connection.channels.length)
        return { config: {}, invalid: true };
    }
    registerWorkflowConnectorSecrets(config);
    return { config, invalid: false };
  } catch {
    return { config: {}, invalid: true };
  }
}

/** Also used when an embedding host supplies settings without the environment loader. */
export function registerWorkflowConnectorSecrets(config: WorkflowConnectorConfig): void {
  if (config.github) {
    registerSecretValue(config.github.token);
    registerSecretValue(config.github.webhookSecret);
  }
  for (const connection of config.slack ?? []) {
    registerSecretValue(connection.token);
    registerSecretValue(connection.signingSecret);
  }
  for (const connection of config.telegram ?? []) {
    registerSecretValue(connection.token);
    registerSecretValue(connection.webhookSecret);
  }
}

/** Only an HTTPS origin is accepted. Paths, credentials and queries cannot alter a route. */
export function readWebhookPublicOrigin(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const input = environment.TOMMY_WEBHOOK_PUBLIC_URL?.trim();
  if (!input) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("Invalid public webhook origin");
    return url.origin;
  } catch {
    logger.warn("Public webhooks are disabled because their HTTPS origin is invalid.");
    return null;
  }
}
