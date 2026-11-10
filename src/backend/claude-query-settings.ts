import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import { isDynamicRecord, isNumber, isOneOf, isString } from "@tommy/contracts/runtime-values";
import { Effect, Semaphore } from "effect";
import type { ClaudeMcpServer } from "./mcp-provider-shapes";
import { type ProviderClientOperationError, providerCall } from "./provider-client-effects";

export interface ClaudeQueryFile {
  path: string;
  temporaryDirectory: string | null;
}

const OWNED_QUERY_FILE = /^([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

/** Only a dead process's marked files are ours to remove. Unknown and live owners stay untouched. */
const removeDeadClaudeQueryFiles = Effect.fn("ClaudeQuerySettings.removeDeadQueryFiles")(function* (directory: string) {
  const entries = yield* providerCall(() => readdir(directory, { withFileTypes: true }));
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = OWNED_QUERY_FILE.exec(entry.name);
    const pid = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const dead = yield* Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (cause) {
        return isDynamicRecord(cause) && cause.code === "ESRCH";
      }
    });
    if (dead) yield* removeClaudeQueryFile(join(directory, entry.name));
  }
});

/** Owns one private CLI input, including its temporary directory when no state root is supplied. */
const writeClaudeQueryFile = Effect.fn("ClaudeQuerySettings.writeQueryFile")(function* (
  stateDirectory: string | undefined,
  folder: "claude-settings" | "claude-mcp",
  content: string,
): Effect.fn.Return<ClaudeQueryFile, ProviderClientOperationError> {
  const directory = stateDirectory
    ? join(stateDirectory, folder)
    : yield* providerCall(() => mkdtemp(join(tmpdir(), `tommy-${folder}-`)));
  const file = {
    path: join(directory, `${process.pid}-${randomUUID()}.json`),
    temporaryDirectory: stateDirectory ? null : directory,
  };
  yield* providerCall(() => mkdir(directory, { recursive: true, mode: 0o700 })).pipe(
    Effect.andThen(removeDeadClaudeQueryFiles(directory)),
    Effect.andThen(providerCall(() => writeFile(file.path, content, { flag: "wx", mode: 0o600 }))),
    Effect.onError(() => removeClaudeQuerySettings(file)),
  );
  return file;
});

/** Sign-in helpers and environment values must never become process arguments. */
export const writeClaudeFlagSettings = Effect.fn("ClaudeQuerySettings.writeFlagSettings")(function* (
  stateDirectory: string | undefined,
  settings: Settings,
): Effect.fn.Return<ClaudeQueryFile, ProviderClientOperationError> {
  return yield* writeClaudeQueryFile(stateDirectory, "claude-settings", JSON.stringify(settings));
});

/** External MCP credentials use only a private file, including clients with no state root. */
export const writeClaudeMcpConfig = Effect.fn("ClaudeQuerySettings.writeMcpConfig")(function* (
  stateDirectory: string | undefined,
  servers: Record<string, ClaudeMcpServer>,
): Effect.fn.Return<ClaudeQueryFile, ProviderClientOperationError> {
  return yield* writeClaudeQueryFile(stateDirectory, "claude-mcp", JSON.stringify({ mcpServers: servers }));
});

/** A missing file or a cleanup failure must not stop query teardown. */
export const removeClaudeQueryFile = Effect.fn("ClaudeQuerySettings.removeQueryFile")(function* (file: string | null) {
  if (file) yield* providerCall(() => rm(file, { force: true })).pipe(Effect.ignore);
});

export const removeClaudeQuerySettings = Effect.fn("ClaudeQuerySettings.removeQuerySettings")(function* (
  file: ClaudeQueryFile | null,
) {
  if (!file) return;
  yield* removeClaudeQueryFile(file.path);
  const directory = file.temporaryDirectory;
  if (directory) yield* providerCall(() => rmdir(directory)).pipe(Effect.ignore);
});

const needsAuthCacheLock = Semaphore.makeUnsafe(1);

/**
 * A proxy supplies the current sign-in itself. Clear only known timestamp marks for its server
 * names, so a 401 from before sign-in cannot hide that server for another 15 minutes. Unknown
 * shapes and the marks of other servers stay. The replacement is atomic for concurrent readers.
 */
export const clearClaudeNeedsAuthMarks = Effect.fn("ClaudeQuerySettings.clearNeedsAuthMarks")(
  function* (configDirectory: string, names: readonly string[]) {
    if (names.length === 0) return;
    yield* needsAuthCacheLock.withPermits(1)(
      Effect.gen(function* () {
        const file = join(configDirectory, "mcp-needs-auth-cache.json");
        const marks = yield* providerCall(async (): Promise<unknown> => JSON.parse(await readFile(file, "utf8")));
        if (!isDynamicRecord(marks)) return;
        const selected = new Set(names);
        const kept = Object.fromEntries(
          Object.entries(marks).filter(
            ([name, mark]) => !(selected.has(name) && isDynamicRecord(mark) && isNumber(mark.timestamp)),
          ),
        );
        if (Object.keys(kept).length === Object.keys(marks).length) return;
        const temporary = join(configDirectory, `mcp-needs-auth-cache.${randomUUID()}.tmp`);
        yield* providerCall(() => writeFile(temporary, JSON.stringify(kept), { flag: "wx", mode: 0o600 })).pipe(
          Effect.andThen(providerCall(() => rename(temporary, file))),
          Effect.ensuring(removeClaudeQueryFile(temporary)),
        );
      }),
    );
  },
  (effect) => effect.pipe(Effect.ignore),
);

/**
 * Tool-free calls load no user hooks, plugins, tools or skills. They still need the user's sign-in
 * backend and credential helpers so a gateway, Bedrock or Vertex works as it does in normal turns.
 */
export const claudeSignInSettings = Effect.fn("ClaudeQuerySettings.signInSettings")(function* (
  configDirectory: string,
): Effect.fn.Return<Settings> {
  const parsed = yield* providerCall(
    async (): Promise<unknown> => JSON.parse(await readFile(join(configDirectory, "settings.json"), "utf8")),
  ).pipe(Effect.orElseSucceed(() => null));
  if (!isDynamicRecord(parsed)) return {};
  const apiKeyHelper = parsed.apiKeyHelper;
  const proxyAuthHelper = parsed.proxyAuthHelper;
  const awsCredentialExport = parsed.awsCredentialExport;
  const awsAuthRefresh = parsed.awsAuthRefresh;
  const gcpAuthRefresh = parsed.gcpAuthRefresh;
  const forceLoginMethod = parsed.forceLoginMethod;
  const forceLoginOrgUUID = parsed.forceLoginOrgUUID;
  const env = isDynamicRecord(parsed.env)
    ? Object.fromEntries(Object.entries(parsed.env).filter((entry): entry is [string, string] => isString(entry[1])))
    : {};
  return {
    ...(isString(apiKeyHelper) && apiKeyHelper ? { apiKeyHelper } : {}),
    ...(isString(proxyAuthHelper) && proxyAuthHelper ? { proxyAuthHelper } : {}),
    ...(isString(awsCredentialExport) && awsCredentialExport ? { awsCredentialExport } : {}),
    ...(isString(awsAuthRefresh) && awsAuthRefresh ? { awsAuthRefresh } : {}),
    ...(isString(gcpAuthRefresh) && gcpAuthRefresh ? { gcpAuthRefresh } : {}),
    ...(isOneOf(["claudeai", "console", "gateway"] as const, forceLoginMethod) ? { forceLoginMethod } : {}),
    ...(isString(forceLoginOrgUUID) || (Array.isArray(forceLoginOrgUUID) && forceLoginOrgUUID.every(isString))
      ? { forceLoginOrgUUID }
      : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
});
