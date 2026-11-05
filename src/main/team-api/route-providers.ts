import type { AgentProviderId } from "@tommy/contracts/agent-providers";
import {
  agentProviderName,
  isManagedRuntimeProvider,
  MANAGED_RUNTIME_PROVIDERS,
  MANAGED_TOOL_RUNTIMES,
  type ManagedProviderId,
} from "@tommy/contracts/agent-providers";
import type { ProviderRuntimeSnapshot, ProviderRuntimeStatus } from "@tommy/contracts/ipc";
import { type DynamicRecord, isOneOf } from "@tommy/contracts/runtime-values";
import { PROVIDERS_ADMIN_CAPABILITY, PROVIDERS_ADMIN_ROUTES } from "@tommy/contracts/team-protocol/providers-v1";
import {
  PROVIDERS_RUNTIMES_V2_CAPABILITY,
  PROVIDERS_RUNTIMES_V2_ROUTES,
} from "@tommy/contracts/team-protocol/providers-v2";
import {
  PROVIDERS_SIGN_IN_V3_CAPABILITY,
  PROVIDERS_SIGN_IN_V3_PROVIDERS,
  PROVIDERS_SIGN_IN_V3_ROUTES,
} from "@tommy/contracts/team-protocol/providers-v3";
import {
  PROVIDERS_V4_CAPABILITY,
  PROVIDERS_V4_ROUTES,
  PROVIDERS_V4_SIGN_IN_PROVIDERS,
} from "@tommy/contracts/team-protocol/providers-v4";
import { PROVIDERS_V5_CAPABILITY, PROVIDERS_V5_ROUTES } from "@tommy/contracts/team-protocol/providers-v5";
import { PROVIDERS_V8_CAPABILITY, PROVIDERS_V8_ROUTES } from "@tommy/contracts/team-protocol/providers-v8";
import { sourceText } from "@tommy/i18n/source";
import { redactText, registerSecretValue } from "@tommy/logging";
import { Effect } from "effect";
import { normalizePastedCode } from "../../backend/agent/cli-code-login";
import { AgentLifecycleFailed } from "../../backend/agent-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { parseProviderId } from "../ipc/app-inputs";
import { parseProviderApiKeyInput } from "../ipc/provider-handlers";
import type { TeamApiAdmin } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

/** The bound `providers-v1` and `providers-v2` put on a runtime message. */
const RUNTIME_MESSAGE_LIMIT = 1024;

/**
 * The providers of this computer, managed from a joined server: sign-in with a device code, provider
 * API keys, the managed CLI runtimes and the custom endpoints. Frozen by `providers-v1`, by
 * `providers-v2` for the runtime routes that include Gemini, by `providers-v3` for the Claude
 * and Grok sign-in on another device, by `providers-v4` for the runtimes and sign-in of Cursor
 * and Cline, and by `providers-v8`, which names a provider by any id and lists the runtimes as rows.
 *
 * `requireAdmin` runs on every route. A key or a header value only arrives here; no response
 * carries one, and no error message quotes the request.
 */
export async function routeProviders(
  context: TeamApiRequestContext,
  admin: TeamApiAdmin | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !isProvidersRoute(url.pathname)) return "unmatched";
  const providers = admin?.providers;
  const capability = V8_ROUTES.has(url.pathname)
    ? PROVIDERS_V8_CAPABILITY
    : V5_ROUTES.has(url.pathname)
      ? PROVIDERS_V5_CAPABILITY
      : V4_ROUTES.has(url.pathname)
        ? PROVIDERS_V4_CAPABILITY
        : V3_ROUTES.has(url.pathname)
          ? PROVIDERS_SIGN_IN_V3_CAPABILITY
          : V2_ROUTES.has(url.pathname)
            ? PROVIDERS_RUNTIMES_V2_CAPABILITY
            : PROVIDERS_ADMIN_CAPABILITY;
  if (!providers || !capabilities.has(capability))
    throw new HttpError(400, sourceText("error.team.providersUnsupported"));
  requireAdmin(member);
  const body = await readJson(request);
  const { service, credentials, runtimes } = providers;
  try {
    switch (url.pathname) {
      case PROVIDERS_ADMIN_ROUTES.codeLoginStart: {
        // `providers-v1` signs in Codex only; its response has no `paste` shape.
        const id = parsed(provider, body);
        if (id !== "codex")
          throw new Error(sourceText("error.provider.noCodeSignIn", { provider: agentProviderName(id) }));
        // The admin types the code in their own browser; nothing it is traded for comes back.
        return json(200, await runCauseEffect(service.startProviderCodeLogin(id)));
      }
      case PROVIDERS_ADMIN_ROUTES.codeLoginCancel: {
        // A v1 client never started a Claude or Grok sign-in, so it cannot cancel one either.
        const id = parsed(provider, body);
        if (id === "codex") await runCauseEffect(service.cancelProviderCodeLogin(id));
        return json(200, {});
      }
      case PROVIDERS_SIGN_IN_V3_ROUTES.codeLoginStart:
        return json(200, await runCauseEffect(service.startProviderCodeLogin(parsed(signInProvider, body))));
      case PROVIDERS_SIGN_IN_V3_ROUTES.codeLoginSubmit: {
        // The code is a credential: it goes to the CLI's stdin, and no error quotes it.
        const input = parsed(codeSubmitInput, body);
        service.submitProviderCodeLogin(input.provider, input.code);
        return json(200, {});
      }
      case PROVIDERS_SIGN_IN_V3_ROUTES.codeLoginCancel:
        await runCauseEffect(service.cancelProviderCodeLogin(parsed(signInProvider, body)));
        return json(200, {});
      // A provider id that this host does not know gets a 400. The sign-in service refuses a known
      // provider that has no code sign-in.
      case PROVIDERS_V8_ROUTES.codeLoginStart:
        return json(200, await runCauseEffect(service.startProviderCodeLogin(parsed(hostProvider, body))));
      case PROVIDERS_V8_ROUTES.codeLoginSubmit: {
        // The code is a credential: it goes to the CLI's stdin, and no error quotes it.
        const input = parsed(codeSubmitInputV8, body);
        service.submitProviderCodeLogin(input.provider, input.code);
        return json(200, {});
      }
      case PROVIDERS_V8_ROUTES.codeLoginCancel:
        await runCauseEffect(service.cancelProviderCodeLogin(parsed(hostProvider, body)));
        return json(200, {});
      case PROVIDERS_V8_ROUTES.runtimesStatus:
        return json(200, wireSnapshotV8(runtimes.getStatus()));
      case PROVIDERS_V8_ROUTES.runtimesDownload:
        return json(200, wireSnapshotV8(await runCauseEffect(runtimes.download(parsed(managedProviderV8, body)))));
      case PROVIDERS_V8_ROUTES.runtimesCancel:
        return json(200, wireSnapshotV8(await runCauseEffect(runtimes.cancel(parsed(managedProviderV8, body)))));
      case PROVIDERS_V8_ROUTES.runtimesCheck:
        return json(200, wireSnapshotV8(await runCauseEffect(runtimes.checkForUpdates())));
      case PROVIDERS_V5_ROUTES.codeLoginStart:
      case PROVIDERS_V4_ROUTES.codeLoginStart:
        return json(200, await runCauseEffect(service.startProviderCodeLogin(parsed(signInProviderV4, body))));
      case PROVIDERS_V5_ROUTES.codeLoginSubmit:
      case PROVIDERS_V4_ROUTES.codeLoginSubmit: {
        // The code is a credential: it goes to the CLI's stdin, and no error quotes it.
        const input = parsed(codeSubmitInputV4, body);
        service.submitProviderCodeLogin(input.provider, input.code);
        return json(200, {});
      }
      case PROVIDERS_V5_ROUTES.codeLoginCancel:
      case PROVIDERS_V4_ROUTES.codeLoginCancel:
        await runCauseEffect(service.cancelProviderCodeLogin(parsed(signInProviderV4, body)));
        return json(200, {});
      case PROVIDERS_V8_ROUTES.apiKeyState:
      case PROVIDERS_V5_ROUTES.apiKeyState:
      case PROVIDERS_ADMIN_ROUTES.apiKeyState:
        return json(200, {
          status: credentials.status(
            parsed(
              V8_ROUTES.has(url.pathname) ? keyProviderV8 : V5_ROUTES.has(url.pathname) ? managedProvider : provider,
              body,
            ),
          ),
        });
      case PROVIDERS_V8_ROUTES.apiKeySet:
      case PROVIDERS_V5_ROUTES.apiKeySet:
      case PROVIDERS_ADMIN_ROUTES.apiKeySet: {
        const input = parsed(
          V8_ROUTES.has(url.pathname)
            ? parseProviderApiKeyInput
            : V5_ROUTES.has(url.pathname)
              ? peerApiKeyInput
              : wireApiKeyInput,
          body,
        );
        const save = () =>
          credentials
            .set(input.provider, input.key)
            .pipe(
              Effect.mapError(
                (error) => new AgentLifecycleFailed({ operation: "changeProviderCredential", cause: error.cause }),
              ),
            );
        // The key and the process that uses it change together.
        await runCauseEffect(service.changeProviderCredential(input.provider, save));
        return json(200, {});
      }
      case PROVIDERS_V8_ROUTES.apiKeyClear:
      case PROVIDERS_V5_ROUTES.apiKeyClear:
      case PROVIDERS_ADMIN_ROUTES.apiKeyClear: {
        const id = parsed(
          V8_ROUTES.has(url.pathname) ? keyProviderV8 : V5_ROUTES.has(url.pathname) ? managedProvider : provider,
          body,
        );
        await runCauseEffect(
          service.clearProviderCredential(id, () =>
            credentials
              .clear(id)
              .pipe(
                Effect.mapError(
                  (error) => new AgentLifecycleFailed({ operation: "changeProviderCredential", cause: error.cause }),
                ),
              ),
          ),
        );
        return json(200, {});
      }
      default:
        return "unmatched";
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // A busy provider or a failed download is a sentence for the admin, not a host fault. A provider
    // process can quote its key, so the message leaves this computer redacted.
    if (error instanceof Error) throw new HttpError(409, redactText(error.message));
    throw error;
  }
}

const V2_ROUTES = new Set<string>(Object.values(PROVIDERS_RUNTIMES_V2_ROUTES));
const V3_ROUTES = new Set<string>(Object.values(PROVIDERS_SIGN_IN_V3_ROUTES));
const V5_ROUTES = new Set<string>(Object.values(PROVIDERS_V5_ROUTES));
const V4_ROUTES = new Set<string>(Object.values(PROVIDERS_V4_ROUTES));
const V8_ROUTES = new Set<string>(Object.values(PROVIDERS_V8_ROUTES));
const ROUTES = new Set<string>([
  ...Object.values(PROVIDERS_ADMIN_ROUTES),
  ...V2_ROUTES,
  ...V3_ROUTES,
  ...V4_ROUTES,
  ...V5_ROUTES,
  ...V8_ROUTES,
]);

function isProvidersRoute(pathname: string): boolean {
  return ROUTES.has(pathname);
}

function provider(body: DynamicRecord): ManagedProviderId {
  const id = parseProviderId(body.provider);
  if (!isOneOf(MANAGED_RUNTIME_PROVIDERS, id)) throw new Error("Unknown provider.");
  return id;
}

type SignInProviderId = Extract<(typeof PROVIDERS_SIGN_IN_V3_PROVIDERS)[number], AgentProviderId>;

/** The providers `providers-v3` signs in. */
function signInProvider(body: DynamicRecord): SignInProviderId {
  const id = parseProviderId(body.provider);
  if (!isOneOf(PROVIDERS_SIGN_IN_V3_PROVIDERS, id)) throw new Error("Unknown provider.");
  return id;
}

/** The error never quotes the code. The CLI checks what the code is; this uses the local check. */
function codeSubmitInput(body: DynamicRecord): { provider: SignInProviderId; code: string } {
  return { provider: signInProvider(body), code: pastedCode(body) };
}

function pastedCode(body: DynamicRecord): string {
  if (typeof body.code !== "string") throw new Error("Invalid sign-in code.");
  const code = normalizePastedCode(body.code);
  // From here on, an error or a log line that quotes the code is masked, as for a provider key.
  registerSecretValue(code);
  return code;
}

type SignInProviderIdV4 = Extract<(typeof PROVIDERS_V4_SIGN_IN_PROVIDERS)[number], AgentProviderId>;

/** The providers `providers-v4` signs in. */
function signInProviderV4(body: DynamicRecord): SignInProviderIdV4 {
  const id = parseProviderId(body.provider);
  if (!isOneOf(PROVIDERS_V4_SIGN_IN_PROVIDERS, id)) throw new Error("Unknown provider.");
  return id;
}

function codeSubmitInputV4(body: DynamicRecord): { provider: SignInProviderIdV4; code: string } {
  return { provider: signInProviderV4(body), code: pastedCode(body) };
}

// `providers-v5` does not name Inception, DeepSeek or OpenRouter; `providers-v8` sets their keys.
function peerApiKeyInput(body: DynamicRecord) {
  return parseProviderApiKeyInput(body);
}

function wireApiKeyInput(body: DynamicRecord) {
  const input = parseProviderApiKeyInput(body);
  if (!isOneOf(MANAGED_RUNTIME_PROVIDERS, input.provider)) throw new Error("Unknown provider.");
  return input;
}

function managedProvider(body: DynamicRecord): ManagedProviderId {
  const id = parseProviderId(body.provider);
  if (!isOneOf(MANAGED_RUNTIME_PROVIDERS, id)) throw new Error("Unknown provider.");
  return id;
}

function parsed<T>(parse: (value: DynamicRecord) => T, body: DynamicRecord): T {
  try {
    return parse(body);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid provider request.");
  }
}

/** A long download error is cut to the wire bound, so the snapshot never fails closed on the client. */

function wireStatus(status: ProviderRuntimeStatus): ProviderRuntimeStatus {
  return { ...status, message: status.message?.slice(0, RUNTIME_MESSAGE_LIMIT) ?? null };
}

/** A `providers-v8` provider: any provider of this host. The wire accepts an id that this host does not know. */
function hostProvider(body: DynamicRecord) {
  return parseProviderId(body.provider);
}

function codeSubmitInputV8(body: DynamicRecord) {
  return { provider: hostProvider(body), code: pastedCode(body) };
}

function managedProviderV8(body: DynamicRecord): ManagedProviderId {
  const id = hostProvider(body);
  if (!isManagedRuntimeProvider(id)) throw new Error(sourceText("error.team.providerNotManaged"));
  return id;
}

/** A `providers-v8` provider whose key this host keeps: a managed runtime, or a key-only provider on Pi. */
function keyProviderV8(body: DynamicRecord) {
  return managedProviderV8(body);
}

/** The `providers-v8` runtime snapshot: one row for each managed runtime, keyed by `id`. */
function wireSnapshotV8(snapshot: ProviderRuntimeSnapshot) {
  return {
    revision: snapshot.revision,
    providers: MANAGED_RUNTIME_PROVIDERS.map((id) => ({ id, ...wireStatus(snapshot.providers[id]) })),
    toolRuntimes: MANAGED_TOOL_RUNTIMES.map((id) => ({ id, ...wireStatus(snapshot.toolRuntimes[id]) })),
  };
}
