import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentModelOption, AgentStatus, TeamRole } from "@tommy/contracts/ipc";
import { TEAM_CURRENT_CAPABILITIES, teamCapabilitiesForProtocol } from "@tommy/contracts/team-protocol/current";
import {
  PROVIDER_ACCOUNT_MODELS_CAPABILITY,
  PROVIDER_ACCOUNT_MODELS_ROUTE,
} from "@tommy/contracts/team-protocol/provider-account-models-v1";
import { PROVIDER_ACCOUNTS_ROUTES } from "@tommy/contracts/team-protocol/provider-accounts-v1";
import { teamSideRouteCodec } from "@tommy/contracts/team-protocol/side-routes";
import { listProviderAccounts } from "@tommy/team-client/team-admin-requests";
import type { TeamApiRequest } from "@tommy/team-client/team-api-requests";
import { describe, expect, it } from "vitest";
import { runCauseEffect } from "../../backend/effect-boundary";
import { decodeProviderAccountModelsFromMain } from "../../preload/provider-account-models-decoding";
import { decodeProviderAccountModelsFromHost } from "../provider-account-models-decoding";
import type { TeamApiProviderAccountModels } from "./dependencies";
import type { TeamApiRequestContext } from "./request-context";
import { routeProviderAccountModels } from "./route-provider-account-models";

const ACCOUNT = "a0123456789abcdef";
const model: AgentModelOption = {
  provider: "codex",
  id: "example-model",
  name: "Example model",
  description: "An account-specific model.",
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["medium", "max", "ultra"],
  fastServiceTier: "priority",
};
const status: AgentStatus = {
  phase: "ready",
  cliVersion: null,
  auth: { kind: "chatgpt", email: null },
  capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
  message: null,
  fullAccess: true,
  providers: [
    {
      id: "codex",
      state: "available",
      version: null,
      message: null,
      accounts: [{ id: ACCOUNT, label: null, email: null, state: "connected", message: null, models: [model] }],
    },
  ],
};

function contextFor(payload: object, role: TeamRole = "owner") {
  const request = new IncomingMessage(new Socket());
  request.method = "POST";
  request.url = PROVIDER_ACCOUNT_MODELS_ROUTE;
  request.push(Buffer.from(JSON.stringify(payload)));
  request.push(null);
  const answers: Array<{ status: number; body: object | null }> = [];
  const context: TeamApiRequestContext = {
    request,
    response: new ServerResponse(request),
    method: "POST",
    url: new URL(PROVIDER_ACCOUNT_MODELS_ROUTE, "https://example.com"),
    protocol: 9,
    capabilities: new Set(TEAM_CURRENT_CAPABILITIES),
    member: {
      id: "member-a",
      username: "user",
      email: null,
      name: null,
      role,
      createdAt: "2026-01-01T00:00:00Z",
      disabled: false,
    },
    token: "fake-token",
    sessionId: "session-a",
    sessionExpiresAt: "2030-01-01T00:00:00Z",
    agentLevel: () => "manage",
    json: (status, body) => {
      answers.push({ status, body });
      return "handled";
    },
    empty: () => "handled",
  };
  return { context, answers };
}

function service(models: AgentModelOption[] = [model]): TeamApiProviderAccountModels {
  return { getStatus: () => status, listAgentModels: () => models };
}

describe("provider account model boundaries", () => {
  it("requires an administrator before reading or decoding account data", async () => {
    const { context } = contextFor({ provider: "invalid-provider", providerAccountId: ACCOUNT }, "member");
    const denied: TeamApiProviderAccountModels = {
      getStatus: () => {
        throw new Error("An ordinary member must not read account status.");
      },
      listAgentModels: () => {
        throw new Error("An ordinary member must not read account models.");
      },
    };
    await expect(routeProviderAccountModels(context, denied)).rejects.toMatchObject({ status: 403 });
  });

  it("refuses unknown accounts and missing capabilities instead of using the default account", async () => {
    const missing = contextFor({ provider: "codex", providerAccountId: "a1111111111111111" });
    await expect(routeProviderAccountModels(missing.context, service())).rejects.toMatchObject({ status: 404 });
    const unsupported = contextFor({ provider: "codex", providerAccountId: ACCOUNT });
    unsupported.context.capabilities.delete(PROVIDER_ACCOUNT_MODELS_CAPABILITY);
    await expect(routeProviderAccountModels(unsupported.context, service())).rejects.toMatchObject({ status: 400 });
  });

  it("keeps an authoritative empty catalog and exposes only that provider", async () => {
    const { context, answers } = contextFor({ provider: "codex", providerAccountId: ACCOUNT });
    await routeProviderAccountModels(context, service([]));
    expect(answers).toEqual([{ status: 200, body: { models: [] } }]);
    const filtered = contextFor({ provider: "codex", providerAccountId: ACCOUNT });
    await routeProviderAccountModels(filtered.context, service([model, { ...model, provider: "claude" }]));
    expect(filtered.answers).toEqual([{ status: 200, body: { models: [model] } }]);
  });

  it("refuses an account without a catalog before the runtime can substitute its default", async () => {
    const { context } = contextFor({ provider: "codex", providerAccountId: ACCOUNT });
    const pending: TeamApiProviderAccountModels = {
      getStatus: () => ({
        ...status,
        providers: [
          {
            id: "codex",
            state: "available",
            version: null,
            message: null,
            accounts: [{ id: ACCOUNT, label: null, email: null, state: "checking", message: null }],
          },
        ],
      }),
      listAgentModels: () => {
        throw new Error("An unavailable account must not use the default catalog.");
      },
    };
    await expect(routeProviderAccountModels(context, pending)).rejects.toMatchObject({ status: 409 });
  });

  it("validates independent host and main boundaries and drops extra fields", () => {
    const sent = { models: [{ ...model, token: "fake-secret", endpoint: "https://user:fake@example.com" }] };
    expect(decodeProviderAccountModelsFromHost(sent, "codex")).toEqual({ models: [model] });
    expect(decodeProviderAccountModelsFromMain(sent, "codex")).toEqual({ models: [model] });
    for (const decode of [decodeProviderAccountModelsFromHost, decodeProviderAccountModelsFromMain]) {
      expect(() => decode({ models: [{ ...model, provider: "claude" }] }, "codex")).toThrow();
      expect(() => decode({ models: [{ ...model, supportedReasoningEfforts: ["invalid"] }] }, "codex")).toThrow();
    }
  });

  it("adds only V9 optional fields while the released account codec drops the new catalog", () => {
    expect(teamCapabilitiesForProtocol(7)).not.toContain(PROVIDER_ACCOUNT_MODELS_CAPABILITY);
    expect(teamCapabilitiesForProtocol(8)).not.toContain(PROVIDER_ACCOUNT_MODELS_CAPABILITY);
    const legacy = teamSideRouteCodec(PROVIDER_ACCOUNTS_ROUTES.list);
    const projected = legacy?.response(PROVIDER_ACCOUNTS_ROUTES.list, 200, {
      providers: [{ provider: "codex", accounts: status.providers?.[0]?.accounts ?? [] }],
      agents: [],
    });
    expect(JSON.stringify(projected)).not.toContain("example-model");
    const current = teamSideRouteCodec(PROVIDER_ACCOUNT_MODELS_ROUTE);
    expect(current?.response(PROVIDER_ACCOUNT_MODELS_ROUTE, 200, { models: [model] })).toEqual({ models: [model] });
  });
  it("keeps the other accounts when one optional catalog fails and never substitutes a global catalog", async () => {
    const other = "a1111111111111111";
    const host = {
      providers: [
        {
          provider: "codex",
          accounts: [
            { id: ACCOUNT, label: null, email: null, state: "connected", message: null },
            { id: other, label: null, email: null, state: "connected", message: null },
          ],
        },
      ],
      agents: [{ agentId: "agent-a", accountId: ACCOUNT }],
    };
    const request: TeamApiRequest = async (_method, path, decode, body) => {
      if (path === PROVIDER_ACCOUNTS_ROUTES.list) return decode(host);
      if (typeof body === "object" && body !== null && !Array.isArray(body) && body.providerAccountId === ACCOUNT)
        throw new Error("Example unavailable catalog.");
      return decode({ models: [model] });
    };
    const result = await runCauseEffect(listProviderAccounts(request, true));
    expect(result.providers[0]?.accounts[0]).toMatchObject({ id: ACCOUNT, models: [] });
    expect(result.providers[0]?.accounts[1]?.models).toEqual([model]);
    expect(result.agents).toEqual(host.agents);
  });
});
