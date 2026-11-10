import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentAuthState,
  type AgentModelOption,
  type AgentProviderId,
  DEFAULT_PROMPT_CACHE_TTL,
  type PromptCacheTtl,
} from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { Effect } from "effect";
import { AcpAgentClient, type AcpHistoryPersistence } from "./acp-client";
import { CURSOR_ACP_FLAVOR } from "./acp-flavor";
import { claudeModelName, serviceTierFields } from "./agent/provider-models";
import type { AgentClient } from "./agent-client";
import { CodexAppServerClient } from "./app-server-client";
import { ClaudeAgentClient } from "./claude-client";
import {
  type AgentCliInfo,
  cliPathEnvironment,
  resolveClaudeCli,
  resolveCodexCli,
  resolveCursorCli,
  resolvePiCli,
} from "./cli";
import { readCursorUsage } from "./cursor-usage";
import type { McpOAuthAuthority } from "./mcp-oauth-provider";
import type { McpOAuthProxySettingsStore } from "./mcp-oauth-proxy";
import type { McpDropReporter, McpEndpointSource, McpServerSource, McpToolRuntimeSource } from "./mcp-provider-shapes";
import { PiAgentClient } from "./pi-client";
import {
  confineSpawnTarget,
  cursorConfinedEnv,
  cursorStatePaths,
  type ProcessConfinement,
  piAgentDirectory,
  piStatePaths,
} from "./process-confinement";
import { type AccountReadResult, isCodexLoginType, type ModelListResponse } from "./protocol";
import { type ProviderClientOperationError, providerFailure } from "./provider-client-effects";

/** One command Tommy runs against a provider's own CLI, waiting for the process to exit. */
interface ProviderCliCommand {
  readonly argv: readonly string[];
  readonly env: (cli: AgentCliInfo) => Record<string, string>;
  readonly timeoutMs: number;
  /**
   * A code sign-in closes the CLI's input at once, so that a question the CLI asks first gets its
   * default answer instead of waiting. Only for a `device` or `link` sign-in, which reads no code.
   */
  readonly closeInput?: true;
}

/**
 * The command of a sign-in. Its arguments and variables can depend on the CLI.
 */
interface ProviderSignInCommand extends Omit<ProviderCliCommand, "argv" | "env"> {
  readonly argv:
    | readonly string[]
    | ((cli: AgentCliInfo) => Effect.Effect<readonly string[], ProviderClientOperationError>);
  readonly env: (cli: AgentCliInfo) => Record<string, string>;
}

const CLI_LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * How a provider keeps more than one account on this computer. Its CLI keeps the credentials,
 * sessions and settings of one account in a home folder that one variable names, so each account
 * after the first gets a folder of its own. The first account stays in the CLI's default folder.
 */
export interface ProviderAccountSupport {
  /** The variable that names the CLI's home folder. */
  readonly homeVariable: string;
  /** Signs a new, empty home folder in through the browser: a CLI command, or an ACP `authenticate`. */
  readonly signIn: ProviderCliCommand | AcpAuthenticateSignIn;
  /** Signs the account out before its folder is removed, for a CLI that keeps a credential outside it. */
  readonly signOut?: ProviderCliCommand;
  /** False for a CLI version that ignores `homeVariable`. Absent when every version reads it. */
  supports?(cli: AgentCliInfo): boolean;
  /**
   * A usage read in a process of its own leaves a session on disk. An account with no agent process
   * then shows its last reading, from its sign-in check, and starts no process to read usage.
   */
  readonly usageLeavesSession?: boolean;
}

const CLAUDE_COMMAND_ENV = (cli: AgentCliInfo): Record<string, string> =>
  cli.source === "managed" ? { DISABLE_AUTOUPDATER: "1" } : {};

/**
 * How a provider is signed in. This used to be an optional `cliLogin` field, and its absence meant
 * "this is Codex": two call sites ran the Codex browser login for any driver without one, so a
 * provider that simply had nothing to spawn would have opened a ChatGPT login. The union makes each
 * answer say what it is, and a new arm is a compile error at both sites rather than a wrong login.
 */
type ProviderSignIn =
  /** The provider's own protocol hands back a URL for Tommy to open. */
  | { kind: "browser" }
  /** Tommy spawns the provider's CLI and waits for the process to exit. */
  | { kind: "cli-command"; command: ProviderSignInCommand }
  /** The user signs in with the CLI themselves; Tommy only re-probes the provider afterwards. */
  | { kind: "external" }
  /** The host opens an interactive terminal and refreshes the account when it closes. */
  | { kind: "terminal"; timeoutMs: number }
  /**
   * Tommy starts the `muse serve` device sign-in and opens its page, which holds the code.
   * `muse login` with no terminal only prints that page and never opens it.
   */
  | AcpAuthenticateSignIn;

/**
 * Tommy starts the ACP server and calls `authenticate` with this method, which opens a browser
 * from the server. Only the sign-in process calls it: in a status probe it would open a browser.
 */
interface AcpAuthenticateSignIn {
  readonly kind: "acp-authenticate";
  readonly methodId: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/**
 * A sign-in the user finishes on another device, for a host with no browser the user can see.
 * `codex-device` is the Codex app-server device code.XXMUSE
 * host asks Meta for. `cli` spawns the provider's CLI and reads its link: `device` prints a code the
 * user confirms, `paste` waits for the code the provider's page shows, which the user copies back,
 * and `link` is a page that signs the CLI in by itself.
 */
type ProviderCodeSignIn =
  | { kind: "codex-device" }
  | { kind: "cli"; flow: "device" | "paste" | "link"; command: ProviderSignInCommand };

/**
 * What a client needs from the app at spawn, beyond its own CLI: the stored secrets, and the user's
 * own endpoints.
 *
 * Required rather than optional on purpose: a driver that needs a stored key has no other way to
 * reach one, and a call site that forgets the endpoints builds a client whose user simply sees their
 * models missing. `apiKey` is synchronous because the store is loaded eagerly at startup, and
 * `customProviders` is a getter, because both are read inside a spawn.
 */
export interface ProviderClientContext {
  apiKey(provider: AgentProviderId): string | null;
  /** Durable provider-history ports, selected by the external provider id. */
  readonly history?: (provider: AgentProviderId) => AcpHistoryPersistence | undefined;
  /**
   * The MCP servers the user enabled, read at spawn like the endpoints above. Each client resolves
   * and converts them itself, because the three providers take three different shapes.
   */
  readonly mcpServers: McpServerSource;
  /**
   * What a provider could not be given, reported once per spawn. Optional, so the test call sites
   * and `NO_PROVIDER_CREDENTIALS` stay valid: a driver with no reporter drops silently, exactly as
   * every driver did before.
   */
  readonly reportMcpDrops?: McpDropReporter;
  /**
   * What Tommy downloaded for the MCP servers, read at spawn like everything else here. Optional
   * for the same reason as `reportMcpDrops`: a driver without one sees the machine as it is.
   */
  readonly mcpToolRuntimes?: McpToolRuntimeSource;
  /**
   * Where each http server is reached and with which bearer, read at spawn: a server this machine
   * signed in to is a route of the loopback OAuth proxy. Optional for the same reason again: a
   * driver without one hands over the URL and the headers the user wrote.
   */
  readonly mcpEndpoint?: McpEndpointSource;
  /**
   * The sign-ins this machine holds for http MCP servers. Read by `AgentService` and by nothing
   * else: a driver is given `mcpEndpoint` above, which never holds an OAuth token. This is
   * the whole authority - it signs in, refreshes and forgets - so it travels no further.
   */
  readonly mcpOAuth?: McpOAuthAuthority;
  /**
   * Where the OAuth proxy keeps its port and secret, so a Codex session resumed after a restart
   * reaches the same address. Optional: without it the proxy takes a new port at each start.
   */
  readonly mcpOAuthProxySettings?: McpOAuthProxySettingsStore;
  /**
   * The Tommy version that the OAuth proxy names to a server it signed in to. Optional: without it
   * the proxy passes on the provider's own `clientInfo`.
   */
  readonly appVersion?: string;
  /**
   * Whether this model may still be used. A removed endpoint stays in the running process, with the
   * credentials it started with, until that process restarts, and the restart waits for the work in
   * flight. Read at the last moment before a prompt leaves, because everything above it awaits.
   */
  /**
   * A folder Tommy owns for files it gives a provider process, outside every root an agent can
   * write. Optional for the same reason as `reportMcpDrops`.
   */
  readonly providerStateDirectory?: string;
  /**
   * A folder Tommy owns for the temporary files of provider processes, emptied at each launch.
   * Optional for the same reason as `reportMcpDrops`: without it a process uses the system folder.
   * The app gives it on Windows only.
   */
  /** The free bytes on the volume of a path. Optional: without it the volume is read. */
  readonly availableDiskBytes?: (path: string) => number;
  /**
   * Variables an agent's tools run with, beyond the user's own environment: today the paths that
   * point `gh` and `git` at the built-in GitHub connection. Paths only, never a secret, because a
   * provider process can outlive the token. Read at each spawn; empty while nothing is connected.
   */
  readonly agentEnvironment?: (inherited?: NodeJS.ProcessEnv) => Readonly<Record<string, string>>;
  /**
   * Variables that every provider process gets, and so every program an agent starts: the marker that
   * the server memory guard and `src/main/background-processes.ts` find leftover processes by, and on
   * a server the CPU limit module for Node (`agentProcessEnvironment` in `src/main/server-memory.ts`).
   * Fixed while the app runs. They are not part of `agentEnvironment`: Codex gets that in each thread
   * configuration and replaces a session whose variables change, so Codex gets these in the spawn
   * environment of its app-server instead.
   */
  readonly serverEnvironment?: Readonly<Record<string, string>>;
  /**
   * The home folder variable of a provider account after the first, for a driver with `accounts`.
   * Every process the client starts gets it, the account check included, so the client signs in
   * and keeps its sessions in that folder only.
   */
  readonly accountEnvironment?: Readonly<Record<string, string>>;
  /**
   * How long this server asks Claude to keep the prompt cache, read at each spawn. Optional for the
   * same reason as `reportMcpDrops`: without it the CLI uses its own cache time.
   */
  readonly promptCacheTtl?: () => PromptCacheTtl;
}

/** The agent environment with the account's home folder after it, so the account folder wins. */
function withAccountEnvironment(
  context: ProviderClientContext,
): ((inherited?: NodeJS.ProcessEnv) => Readonly<Record<string, string>>) | undefined {
  const { agentEnvironment, accountEnvironment } = context;
  if (!accountEnvironment) return agentEnvironment;
  return (inherited) => ({ ...agentEnvironment?.(inherited), ...accountEnvironment });
}

/**
 * Claude's agent environment with the prompt cache time of this server. `5m`, the default, leaves the
 * CLI's own choice. `1h` sets `ENABLE_PROMPT_CACHING_1H`, which the CLI reads last: a `promptCacheTtl`
 * in the Claude settings or `CLAUDE_CODE_PROMPT_CACHE_TTL` still wins. The CLI reads the flag before
 * its subscription rules, so subagents, an API key and a subscription on extra usage also get 1 hour.
 */
function claudeAgentEnvironment(
  context: ProviderClientContext,
): (inherited?: NodeJS.ProcessEnv) => Readonly<Record<string, string>> {
  const environment = withAccountEnvironment(context);
  return (inherited) => ({
    ...((context.promptCacheTtl?.() ?? DEFAULT_PROMPT_CACHE_TTL.ttl) === "1h" ? { ENABLE_PROMPT_CACHING_1H: "1" } : {}),
    ...environment?.(inherited),
  });
}

/**
 * The saved Anthropic API key, for the provider's own sign-in when it has no claude.ai account. An
 * account after the first has its own `CLAUDE_CONFIG_DIR`; the account of the key carries the key in
 * its environment, and no other account gets it.
 */
function claudeFallbackApiKey(context: ProviderClientContext): (() => string | null) | undefined {
  return context.accountEnvironment ? undefined : () => context.apiKey("claude");
}

/** Nothing stored and no endpoint, for tests and for call sites that predate the credential store. */
export const NO_PROVIDER_CREDENTIALS: ProviderClientContext = {
  apiKey: () => null,
  mcpServers: () => [],
};

/**
 * How a provider's model list differs from a plain `model/list` reading. Absent for a provider that
 * needs nothing more.
 */
export interface ProviderModelCatalog {
  /** The CLI gives its list in pages, with `nextCursor`. */
  readonly paged?: true;
  /** The list can take the full request timeout, not 5 s. */
  readonly slowList?: true;
  /** No models while the provider says that the user must sign in and it has no client. */
  readonly hiddenWhenSignedOut?: true;
  /** The name to show for a model, before the name the CLI gives. Null keeps the CLI's name. */
  modelName?(id: string): string | null;
  /** Fields that only this provider's CLI reports. */
  modelFields?(model: ModelListResponse["data"][number]): { fastServiceTier?: string; ultrafastServiceTier?: string };
  /** False drops a model that the stored API key cannot use. Runs only while a key is stored. */
  usableWithStoredKey?(id: string, name: string): boolean;
  /**
   * The models to keep when the list failed, timed out or came back empty. Without this hook a
   * failed list keeps the previous models, and an empty list is a real answer.
   */
  fallback?(previous: AgentModelOption[]): AgentModelOption[];
}

/**
 * What a provider *does*. What it is called, how it is described and where its sign-in help points
 * live in the provider registry in `@tommy/contracts/agent-providers`; a driver holds only the
 * behaviour, so a new provider is one registry row plus one driver.
 */
export interface BuiltInProviderDriver {
  id: AgentProviderId;
  signIn: ProviderSignIn;
  /**
   * The files the provider's CLI writes when the user signs in with it. The host checks the account
   * again when one of them changes, so a sign-in done outside Tommy, such as over SSH, needs no
   * restart. Absent for a provider that Tommy always signs in itself.
   */
  signInFiles?(): readonly string[];
  /** Absent for a provider that has no sign-in on another device. */
  codeSignIn?: ProviderCodeSignIn;
  /** Absent for a provider that holds one account only. */
  accounts?: ProviderAccountSupport;
  /**
   * Signs the provider's own sign-in out, in the user's home folder, when its accounts have no
   * `ProviderAccountSupport.signOut`. Absent for a CLI that has no sign-out command.
   */
  signOut?: ProviderCliCommand;
  /** The provider whose downloaded CLI this one runs. Absent when the provider has a CLI of its own. */
  cliProvider?: AgentProviderId;
  /** Absent for a provider whose `model/list` needs no special reading. */
  catalog?: ProviderModelCatalog;
  resolveCli(options?: {
    bundledExecutable?: string | null | undefined;
  }): Effect.Effect<AgentCliInfo, ProviderClientOperationError>;
  createClient(
    cli: AgentCliInfo,
    requestTimeoutMs: number,
    context: ProviderClientContext,
    confinement?: ProcessConfinement,
  ): AgentClient;
  /**
   * The client that writes an agent profile, when the provider needs a different one. Profile
   * generation asks the model one question and must not let it act, so a provider that can be
   * started without tools starts that way here. Without this hook the normal client is used.
   */
  createProfileClient?(cli: AgentCliInfo, requestTimeoutMs: number, context: ProviderClientContext): AgentClient;
  authState(account: AccountReadResult["account"]): AgentAuthState;
  validateAccount(account: NonNullable<AccountReadResult["account"]>): void;
}

function piClient(
  provider: "pi",
  cli: AgentCliInfo,
  timeout: number,
  context: ProviderClientContext,
  confinement: ProcessConfinement | undefined,
): AgentClient {
  const history = context.history?.(provider);
  return new PiAgentClient(cli, {
    requestTimeoutMs: timeout,
    ...(confinement
      ? {
          confine: (target) => {
            const paths = piStatePaths();
            for (const path of paths.writable) mkdirSync(path, { recursive: true, mode: 0o700 });
            // Pi writes an empty `auth.json` before it reads one, and the confined process cannot.
            try {
              writeFileSync(join(piAgentDirectory(), "auth.json"), "{}", { flag: "wx", mode: 0o600 });
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
            }
            return confineSpawnTarget(target, confinement, paths);
          },
        }
      : {}),
    extraEnv: () => ({ ...context.agentEnvironment?.() }),
    ...(context.providerStateDirectory ? { providerStateDirectory: context.providerStateDirectory } : {}),
    mcpServers: context.mcpServers,
    ...(context.reportMcpDrops ? { reportMcpDrops: context.reportMcpDrops } : {}),
    ...(context.mcpToolRuntimes ? { mcpToolRuntimes: context.mcpToolRuntimes } : {}),
    ...(context.mcpEndpoint ? { mcpEndpoint: context.mcpEndpoint } : {}),
    ...(history ? { history } : {}),
  });
}

function piProfileClient(cli: AgentCliInfo, timeout: number, context: ProviderClientContext): AgentClient {
  return new PiAgentClient(cli, {
    requestTimeoutMs: timeout,
    profileGeneration: true,
    ...(context.providerStateDirectory ? { providerStateDirectory: context.providerStateDirectory } : {}),
  });
}

export const BUILT_IN_PROVIDER_DRIVERS: readonly BuiltInProviderDriver[] = [
  {
    id: "pi",
    signIn: { kind: "terminal", timeoutMs: CLI_LOGIN_TIMEOUT_MS },
    signInFiles: () => [join(piAgentDirectory(), "auth.json")],
    resolveCli: resolvePiCli,
    createClient: (cli, timeout, context, confinement) => piClient("pi", cli, timeout, context, confinement),
    createProfileClient: (cli, timeout, context) => piProfileClient(cli, timeout, context),
    authState: (account) => ({ kind: "pi", email: account?.email ?? null }),
    validateAccount: () => undefined,
  },
  {
    id: "codex",
    signIn: { kind: "browser" },
    codeSignIn: { kind: "codex-device" },
    accounts: {
      homeVariable: "CODEX_HOME",
      signIn: { argv: ["login"], env: () => ({}), timeoutMs: CLI_LOGIN_TIMEOUT_MS },
      signOut: { argv: ["logout"], env: () => ({}), timeoutMs: 30_000 },
    },
    catalog: { paged: true, modelFields: serviceTierFields },
    resolveCli: resolveCodexCli,
    createClient: (cli, requestTimeoutMs, context) =>
      new CodexAppServerClient(cli.executable, requestTimeoutMs, {
        ...cliPathEnvironment(cli),
        ...context.serverEnvironment,
        ...context.accountEnvironment,
      }),
    authState: (account) => ({ kind: "chatgpt", email: account?.email ?? null }),
    // An API-key login has no plan usage to read.
    validateAccount: (account) => {
      if (!isCodexLoginType(account.type)) {
        throw new Error(sourceText("error.provider.codexLoginRequired"));
      }
    },
  },
  {
    id: "claude",
    signIn: {
      kind: "cli-command",
      command: { argv: ["auth", "login", "--claudeai"], env: CLAUDE_COMMAND_ENV, timeoutMs: CLI_LOGIN_TIMEOUT_MS },
    },
    // With no browser the CLI prints the link and a "Paste code here" prompt, on a terminal only.
    codeSignIn: {
      kind: "cli",
      flow: "paste",
      command: { argv: ["auth", "login", "--claudeai"], env: CLAUDE_COMMAND_ENV, timeoutMs: CLI_LOGIN_TIMEOUT_MS },
    },
    // On macOS the CLI keeps the credential in a keychain item named after the folder, so the
    // sign-out removes that item before Tommy removes the folder.
    accounts: {
      homeVariable: "CLAUDE_CONFIG_DIR",
      signIn: { argv: ["auth", "login", "--claudeai"], env: CLAUDE_COMMAND_ENV, timeoutMs: CLI_LOGIN_TIMEOUT_MS },
      signOut: { argv: ["auth", "logout"], env: CLAUDE_COMMAND_ENV, timeoutMs: 30_000 },
    },
    // `claudeModelName` says why Claude Code's own model names are not used.
    catalog: { modelName: claudeModelName, modelFields: serviceTierFields },
    resolveCli: resolveClaudeCli,
    createClient: (cli, requestTimeoutMs, context) =>
      new ClaudeAgentClient(
        cli,
        undefined,
        undefined,
        requestTimeoutMs,
        context.mcpServers,
        context.reportMcpDrops,
        context.mcpToolRuntimes,
        context.mcpEndpoint,
        context.providerStateDirectory,
        claudeAgentEnvironment(context),
        undefined,
        claudeFallbackApiKey(context),
      ),
    authState: (account) => ({ kind: "claude", email: account?.email ?? null }),
    validateAccount: () => undefined,
  },
  {
    id: "cursor",
    // `cursor_login` opens the Cursor sign-in page from the server. `CURSOR_API_KEY` in the user's
    // environment signs the CLI in without it.
    signIn: { kind: "acp-authenticate", methodId: "cursor_login", argv: ["acp"], timeoutMs: CLI_LOGIN_TIMEOUT_MS },
    // With `NO_OPEN_BROWSER`, `login` prints the sign-in link and waits until the page signs it in.
    // The ACP `cursor_login` method gives up instead when it cannot open a browser.
    codeSignIn: {
      kind: "cli",
      flow: "link",
      command: { argv: ["login"], env: () => ({ NO_OPEN_BROWSER: "1" }), timeoutMs: CLI_LOGIN_TIMEOUT_MS },
    },
    signOut: { argv: ["logout"], env: () => ({}), timeoutMs: 30_000 },
    resolveCli: resolveCursorCli,
    createClient: (cli, timeout, context, confinement) =>
      new AcpAgentClient(cli, timeout, {
        provider: "cursor",
        flavor: CURSOR_ACP_FLAVOR,
        argv: ["acp"],
        env: {},
        ...(confinement ? { confine: (target) => confineSpawnTarget(target, confinement, cursorStatePaths()) } : {}),
        extraEnv: () => ({ ...context.agentEnvironment?.(), ...(confinement ? cursorConfinedEnv() : {}) }),
        signInMessage: sourceText("error.provider.cursorSignIn"),
        mcpServers: context.mcpServers,
        reportMcpDrops: context.reportMcpDrops,
        mcpToolRuntimes: context.mcpToolRuntimes,
        mcpEndpoint: context.mcpEndpoint,
        history: context.history?.("cursor"),
        readRateLimits: () => readCursorUsage().pipe(Effect.mapError((failure) => providerFailure(failure.cause))),
      }),
    createProfileClient: (cli, timeout) =>
      new AcpAgentClient(cli, timeout, {
        provider: "cursor",
        flavor: CURSOR_ACP_FLAVOR,
        argv: ["acp"],
        profileGeneration: true,
        env: {},
        signInMessage: sourceText("error.provider.cursorSignIn"),
      }),
    authState: (account) => ({ kind: "cursor", email: account?.email ?? null }),
    validateAccount: () => undefined,
  },
] as const;

const PROVIDER_DRIVERS = new Map(BUILT_IN_PROVIDER_DRIVERS.map((driver) => [driver.id, driver]));

/** The driver of a provider of Tommy. Other IDs have none. */
export function providerDriver(provider: AgentProviderId): BuiltInProviderDriver | undefined {
  return PROVIDER_DRIVERS.get(provider);
}

export function requireProviderDriver(provider: AgentProviderId): BuiltInProviderDriver {
  const driver = PROVIDER_DRIVERS.get(provider);
  if (!driver) throw new Error(`Unknown agent provider: ${provider}`);
  return driver;
}
