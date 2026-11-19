import type { AgentSummary } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { AgentUpdate } from "../backend/agent-service";
import { TelegramApiFailure } from "./telegram-api";
import type { TelegramConnection } from "./telegram-directory";
import { TelegramProfile } from "./telegram-profile";

function setup() {
  let agent: AgentSummary = {
    id: "agent-one",
    name: "Agent One",
    title: "",
    description: "",
    notifications: true,
    provider: "codex",
    model: "example-codex",
    reasoningEffort: "medium",
    threadId: "thread-one",
    workspacePath: "/example",
    preview: "",
    updatedAt: null,
    avatarSeed: "one",
    avatarHue: null,
    avatarUrl: null,
  };
  let binding: TelegramConnection = {
    id: 10,
    operationId: "operation-one",
    name: agent.name,
    verified: true,
    ownerConfirmed: true,
    username: "example_agent",
    agentId: agent.id,
  };
  let transferOnToken = false;
  let nameRequestFails = false;
  const update = vi.fn((input: AgentUpdate) => {
    agent = {
      ...agent,
      name: input.name ?? agent.name,
      provider: input.provider ?? agent.provider,
      model: input.model ?? agent.model,
    };
    return Effect.succeed(agent);
  });
  const remoteName = vi.fn(() =>
    nameRequestFails ? Effect.fail(new TelegramApiFailure({ kind: "transport", status: 0 })) : Effect.void,
  );
  const setName = vi.fn((_id: number, name: string) => {
    binding = { ...binding, name };
    return Effect.succeed(undefined);
  });
  const profile = new TelegramProfile(
    {
      listAgents: () => [agent],
      listAgentModels: () => [
        {
          provider: "claude",
          id: "example-claude",
          name: "Example",
          description: "",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["medium"],
        },
      ],
      updateAgent: update,
    },
    { get: () => binding, setDisplayName: setName },
    {
      getManagedBotToken: () => {
        if (transferOnToken) binding = { ...binding, operationId: "other" };
        return Effect.succeed("10:example_child_token");
      },
      setMyName: remoteName,
    },
    { token: "11:example_manager_token" },
  );
  return {
    profile,
    binding,
    update,
    setName,
    remoteName,
    transfer() {
      transferOnToken = true;
    },
    failName(value: boolean) {
      nameRequestFails = value;
    },
  };
}

describe("Telegram owner profile commands", () => {
  it("refuses stale bindings and secret display names before changes to either profile", async () => {
    const h = setup();
    await Effect.runPromise(h.profile.handle({ ...h.binding, operationId: "old" }, "/engine claude", sourceText));
    await Effect.runPromise(h.profile.handle(h.binding, "/name ghp_fixture123456789abc", sourceText));
    expect(h.update).not.toHaveBeenCalled();
    expect(h.setName).not.toHaveBeenCalled();
    expect(h.remoteName).not.toHaveBeenCalled();
    h.transfer();
    await Effect.runPromise(h.profile.handle(h.binding, "/name Example", sourceText));
    expect(h.remoteName).not.toHaveBeenCalled();
  });

  it("limits changes to the addressed agent and reconciles a failed external profile update on repeat", async () => {
    const h = setup();
    expect(await Effect.runPromise(h.profile.handle(h.binding, "hello", sourceText))).toBeNull();
    await Effect.runPromise(h.profile.handle(h.binding, "/engine other", sourceText));
    expect(h.update).not.toHaveBeenCalled();
    await Effect.runPromise(h.profile.handle(h.binding, "/engine claude", sourceText));
    await Effect.runPromise(h.profile.handle(h.binding, "/engine claude", sourceText));
    expect(h.update).toHaveBeenCalledExactlyOnceWith({
      agentId: "agent-one",
      provider: "claude",
      model: "example-claude",
    });
    h.failName(true);
    const first = await Effect.runPromise(h.profile.handle(h.binding, "/name Example", sourceText));
    expect(first).toBe(sourceText("status.agent.telegramNameRetry"));
    h.failName(false);
    const second = await Effect.runPromise(h.profile.handle(h.binding, "/name Example", sourceText));
    expect(second).toBe(sourceText("status.agent.telegramNameSet", { name: "Example" }));
    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.remoteName).toHaveBeenCalledTimes(2);
  });
});
