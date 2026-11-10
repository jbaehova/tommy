import {
  AGENT_PROVIDERS,
  type AgentModelOption,
  type AgentSummary,
  workspaceAccessEnforced,
} from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger } from "@tommy/logging";
import { Effect } from "effect";
import type { DynamicToolCallParams } from "../protocol";
import { agentReasoningEffort, requestedRuntime, requestedToolModel } from "./model-tools";
import {
  profileToolErrorMessage,
  restrictionInput,
  updateAgentsToolSchema,
  widensAgentSettings,
} from "./profile-tools";
import { type TommyToolResponse, tommyToolResult } from "./routine-tools";
import type { TommyToolRouterHooks } from "./tommy-tool-router";
import { ToolOperationFailed, toolStep } from "./tool-operation";

const logger = createTommyLogger("update-agents-tool");

/** The settings of one changed agent. Instructions are left out, so a result for many agents stays small. */
function agentSettings(agent: AgentSummary, models: AgentModelOption[]) {
  return {
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    ...agentReasoningEffort(agent, models),
    // A runtime change during work applies before the next turn.
    ...(agent.pendingRuntime ? { pendingRuntime: agent.pendingRuntime } : {}),
    access: workspaceAccessEnforced(agent) ? "workspace" : "full",
    notifications: agent.notifications,
  };
}

type AgentResult =
  | ({ agentId: string; ok: true } & ReturnType<typeof agentSettings>)
  | { agentId: string; ok: false; error: string };

/**
 * `update_agents`: the settings of `update_profile` that a coordinator sets on many agents at once.
 * Each agent gets the same checks and its own write, in order, so a failure for one agent leaves the
 * others to go on and the result names it.
 */
export const handleUpdateAgentsTool = Effect.fn("UpdateAgentsTool.handle")(
  function* (
    params: DynamicToolCallParams,
    senderAgentId: string,
    hooks: Pick<
      TommyToolRouterHooks,
      "listAgents" | "listModels" | "agentModels" | "providerAccounts" | "updateAgent" | "redactMcp"
    >,
  ): Effect.fn.Return<TommyToolResponse, ToolOperationFailed> {
    const { agentIds, provider, model, reasoningEffort, access, notifications } = updateAgentsToolSchema.parse(
      params.arguments,
      { reportInput: true },
    );
    const runtimeRequest = { provider, model, reasoningEffort };
    if ([provider, model, reasoningEffort, access, notifications].every((value) => value === undefined)) {
      throw new Error("At least one setting is required.");
    }
    if (!hooks.listAgents().some((agent) => agent.id === senderAgentId)) {
      throw new Error("The calling agent no longer exists.");
    }
    // A provider or model that no account lists is wrong for every agent, so the whole call fails once.
    // A model that only some accounts serve, and an effort alone, are checked per agent (#6109).
    if (provider !== undefined || model !== undefined) {
      const accountOnly = AGENT_PROVIDERS.flatMap((id) =>
        (hooks.providerAccounts(id) ?? []).flatMap((account) => account.models ?? []),
      );
      requestedToolModel(runtimeRequest, [...hooks.listModels(), ...accountOnly]);
    }
    const failed = (agentId: string, message: string): AgentResult => ({ agentId, ok: false, error: message });
    const failure = (agentId: string, cause: unknown) =>
      Effect.sync(() => {
        const message = hooks.redactMcp(profileToolErrorMessage(cause));
        logger.warn("An agent in update_agents was not updated.", { agentId, error: message });
        return failed(agentId, message);
      });

    const results = yield* Effect.forEach(agentIds, (agentId) =>
      Effect.gen(function* () {
        const target = hooks.listAgents().find((agent) => agent.id === agentId);
        if (!target) return failed(agentId, sourceText("error.agent.unknown", { id: agentId }));
        if (widensAgentSettings(target, access)) {
          return failed(agentId, sourceText("error.agent.onlyUserWidensSettings"));
        }
        const ownProvider = provider ?? target.provider;
        const models = hooks.agentModels({
          provider: ownProvider,
          providerAccountId: ownProvider === target.provider ? target.providerAccountId : undefined,
        });
        const runtime = yield* toolStep(() => requestedRuntime(target, runtimeRequest, models));
        const updated = yield* hooks.updateAgent(
          {
            agentId,
            ...(notifications === undefined ? {} : { notifications }),
            ...runtime,
            ...restrictionInput(access),
          },
          senderAgentId,
        );
        const updatedModels = hooks.agentModels({
          provider: updated.provider,
          providerAccountId: updated.providerAccountId,
        });
        return { agentId, ok: true, ...agentSettings(updated, updatedModels) } satisfies AgentResult;
      }).pipe(
        Effect.catch((error) => failure(agentId, error.cause)),
        Effect.catchDefect((defect) => failure(agentId, defect)),
        // A stop between two agents ends the call; the write of one agent is never cut in half.
        Effect.uninterruptible,
      ),
    );
    const updatedCount = results.filter((result) => result.ok).length;
    return tommyToolResult({ updated: updatedCount, failed: results.length - updatedCount, results });
  },
  Effect.catchDefect((cause) => Effect.fail(new ToolOperationFailed({ cause }))),
);
