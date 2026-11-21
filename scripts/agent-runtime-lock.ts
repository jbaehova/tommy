import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u, "Must use a complete SHA-256 value.");
const piArtifactSchema = z.object({
  url: z.url(),
  assetSha256: sha256Schema,
  downloadBytes: z.number().int().positive(),
  installedBytes: z.number().int().positive(),
  executable: z.literal("pi"),
  files: z.record(z.string().min(1), sha256Schema),
});
const piLockSchema = z.object({
  version: z.string().min(1),
  license: z.string().min(1),
  licenseUrl: z.url(),
  artifacts: z.object({
    "darwin-arm64": piArtifactSchema,
    "darwin-x64": piArtifactSchema,
    "linux-x64": piArtifactSchema,
    "linux-arm64": piArtifactSchema,
  }),
});
const codexArtifactSchema = z.object({
  asset: z.string().min(1),
  assetSha256: sha256Schema,
  downloadBytes: z.number().int().positive(),
  installedBytes: z.number().int().positive(),
  executable: z.literal("bin/codex"),
});
const claudeArtifactSchema = z.object({
  package: z.string().regex(/^@anthropic-ai\/claude-agent-sdk-(?:darwin-arm64|darwin-x64|linux-x64|linux-arm64)$/u),
  asset: z.string().regex(/^claude-agent-sdk-(?:darwin-arm64|darwin-x64|linux-x64|linux-arm64)-\d+\.\d+\.\d+\.tgz$/u),
  assetSha256: sha256Schema,
  binarySha256: sha256Schema,
  downloadBytes: z.number().int().positive(),
  installedBytes: z.number().int().positive(),
  executable: z.literal("claude"),
  platformDirectory: z.enum(["linux", "mac"]),
});
/**
 * Bun ships one npm package per target and no `bunx` of its own, so the staged layout makes that
 * name itself. `baseline` on x64: Bun's plain x64 builds need AVX2, and a machine older than that
 * would answer a spawn with an illegal instruction and no message. The baseline build starts
 * slightly slower, which is nothing against launching one MCP server.
 */
const bunArtifactSchema = z.object({
  package: z.string().regex(/^@oven\/bun-(?:darwin-aarch64|darwin-x64-baseline|linux-x64-baseline|linux-aarch64)$/u),
  asset: z
    .string()
    .regex(/^bun-(?:darwin-aarch64|darwin-x64-baseline|linux-x64-baseline|linux-aarch64)-\d+\.\d+\.\d+\.tgz$/u),
  assetSha256: sha256Schema,
  binarySha256: sha256Schema,
  downloadBytes: z.number().int().positive(),
  installedBytes: z.number().int().positive(),
  executable: z.literal("bun"),
});

/**
 * Cursor ships the CLI as one archive per target, with one `dist-package` folder: a Node.js runtime,
 * the bundled JavaScript, and a launcher script. `files` names the hash of the files that start the
 * CLI: the launchers, the runtime and the entry script. The archive hash covers the other files, such
 * as the script chunks and native modules, at download only, as the Codex lock does for its package.
 */
const cursorArtifactSchema = z.object({
  platformDirectory: z.enum(["darwin", "linux"]),
  architecture: z.enum(["arm64", "x64"]),
  asset: z.literal("agent-cli-package.tar.gz"),
  assetSha256: sha256Schema,
  downloadBytes: z.number().int().positive(),
  installedBytes: z.number().int().positive(),
  executable: z.literal("cursor-agent"),
  files: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u), sha256Schema),
});

const agentRuntimeLockSchema = z.object({
  schemaVersion: z.literal(1),
  codex: z.object({
    repository: z.literal("https://github.com/openai/codex"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    tag: z.string().regex(/^rust-v\d+\.\d+\.\d+$/u),
    license: z.literal("Apache-2.0"),
    licenseSha256: sha256Schema,
    artifacts: z.object({
      "darwin-arm64": codexArtifactSchema,
      "darwin-x64": codexArtifactSchema,
      "linux-x64": codexArtifactSchema,
      "linux-arm64": codexArtifactSchema,
    }),
  }),
  claude: z.object({
    registry: z.literal("https://registry.npmjs.org"),
    sdkVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    license: z.literal("Anthropic Legal Agreements"),
    licenseSha256: sha256Schema,
    artifacts: z.object({
      "darwin-arm64": claudeArtifactSchema,
      "darwin-x64": claudeArtifactSchema,
      "linux-x64": claudeArtifactSchema,
      "linux-arm64": claudeArtifactSchema,
    }),
  }),
  /**
   * The JavaScript runtime Tommy downloads for the MCP servers, not for a provider CLI.
   *
   * `tag` is the source tag the licence is read from; `version` is what `bun --version` prints and
   * what the npm packages carry. Bun states both as the same number, and the schema keeps them
   * separate anyway, because a lock that cannot say they disagree cannot notice when they do.
   */
  bun: z.object({
    registry: z.literal("https://registry.npmjs.org"),
    repository: z.literal("https://github.com/oven-sh/bun"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    tag: z.string().regex(/^bun-v\d+\.\d+\.\d+$/u),
    license: z.literal("MIT"),
    licenseSha256: sha256Schema,
    artifacts: z.object({
      "darwin-arm64": bunArtifactSchema,
      "darwin-x64": bunArtifactSchema,
      "linux-x64": bunArtifactSchema,
      "linux-arm64": bunArtifactSchema,
    }),
  }),
  /**
   * The Cursor CLI, which signs in with a Cursor plan. It is proprietary, so Tommy downloads it on
   * the user's computer and does not ship it in a release. The terms are at `licenseUrl`. A version is
   * a date and a commit, which is also the folder of the download.
   */
  cursor: z.object({
    registry: z.literal("https://raw.githubusercontent.com/agentclientprotocol/registry/main/cursor/agent.json"),
    distribution: z.literal("https://downloads.cursor.com/lab"),
    version: z.string().regex(/^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,40}$/u),
    license: z.literal("Proprietary"),
    licenseUrl: z.literal("https://cursor.com/terms-of-service"),
    artifacts: z.object({
      "darwin-arm64": cursorArtifactSchema,
      "darwin-x64": cursorArtifactSchema,
      "linux-x64": cursorArtifactSchema,
      "linux-arm64": cursorArtifactSchema,
    }),
  }),
  pi: piLockSchema,
});

export type AgentRuntimeLock = z.infer<typeof agentRuntimeLockSchema>;

export function parseAgentRuntimeLock(value: unknown): AgentRuntimeLock {
  return agentRuntimeLockSchema.parse(value);
}
