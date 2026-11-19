// @vitest-environment node
import type { AgentSummary, ConversationMessage, QueueDelivery } from "@tommy/contracts/ipc";
import { sourceText } from "@tommy/i18n/source";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type TelegramCommandService, TelegramCommands } from "./telegram-commands";

const agent = {
  id: "agent-one",
  name: "Builder",
  provider: "codex",
  model: "gpt-test",
  reasoningEffort: "medium",
  access: "full",
  workspacePath: "/srv/tommy/agents/one",
  additionalFolders: ["/srv/projects/old"],
} as const;

function fixture(options: { memories?: number; history?: number } = {}) {
  const updates: unknown[] = [];
  const deleted: string[] = [];
  const canceled: string[] = [];
  const delivery = (id: string, status: QueueDelivery["status"]): QueueDelivery => ({
    id,
    messageId: `message-${id}`,
    recipientAgentId: agent.id,
    sender: { kind: "user" },
    text: id,
    attachments: [],
    replyToMessageId: null,
    status,
    position: null,
    turnId: null,
    error: null,
    createdAt: "2026-11-19T00:00:00.000Z",
  });
  const deliveries = [delivery("d1", "queued"), delivery("d2", "running"), delivery("d3", "queued")];
  const summary: AgentSummary = {
    ...agent,
    additionalFolders: [...agent.additionalFolders],
    title: "",
    description: "",
    notifications: true,
    threadId: "thread-one",
    preview: "",
    updatedAt: null,
    avatarSeed: "one",
    avatarHue: null,
    avatarUrl: null,
  };
  const service: TelegramCommandService = {
    listAgents: () => [summary],
    listAgentModels: () => [
      {
        provider: "codex",
        id: "gpt-test",
        name: "Test",
        description: "",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
      {
        provider: "codex",
        id: "gpt-fast",
        name: "Fast",
        description: "",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low"],
      },
    ],
    updateAgent: (input) =>
      Effect.sync(() => {
        updates.push(input);
        return summary;
      }),
    deleteAgent: (id) =>
      Effect.sync(() => {
        deleted.push(id);
      }),
    compactAgentContext: () => Effect.void,
    listQueue: () => ({ agentId: agent.id, deliveries }),
    cancelQueuedMessage: (_agentId, id) =>
      Effect.sync(() => {
        canceled.push(id);
      }),
    getUsage: () => Effect.succeed({ limits: [] }),
    listMemories: () =>
      Array.from({ length: options.memories ?? 0 }, (_, index) => ({
        id: `m${index}`,
        agentId: agent.id,
        text: `memory ${index} ${"x".repeat(400)}`,
        origin: "manual" as const,
        sourceTurnId: null,
        createdAt: "",
        updatedAt: "",
      })),
    listRoutines: () => [],
    updateRoutine: () => {
      throw new Error("not used");
    },
    testRoutine: () => Effect.die("not used"),
    readConversation: () =>
      Effect.succeed({
        agentId: agent.id,
        threadId: "t",
        activeTurnId: null,
        revision: 1,
        messages: Array.from(
          { length: options.history ?? 0 },
          (_, index): ConversationMessage => ({
            id: `c${index}`,
            author: index % 2 ? "assistant" : "user",
            text: `message ${index} ${"y".repeat(2000)}`,
            createdAt: "",
            status: "completed",
          }),
        ),
      }),
    getRuntimeSnapshot: () => ({
      agents: [],
      activeTurns: [],
      work: [],
      latestMessages: [],
      attentionComplete: true,
      pendingPrompts: [],
      pendingApprovals: [],
      pendingBrowserTakeovers: [],
      failedTurns: [],
    }),
    instructionsSaving: () => () => {},
  };
  const commands = new TelegramCommands({
    service,
    dataRoot: "/var/lib/tommy",
    realDirectory: async (path) =>
      ["/var/lib/tommy", "/var/lib/tommy/.config", "/srv/projects/new", "/srv/tommy/agents/one"].includes(path)
        ? path
        : null,
  });
  const run = (text: string, isRoot = false) =>
    Effect.runPromise(commands.handle(agent.id, text, sourceText, { timeZone: "Asia/Seoul", language: "en", isRoot }));
  return { run, updates, deleted, canceled };
}

describe("Telegram agent commands", () => {
  it("leaves ordinary text and other commands to the agent, and parses model choices", async () => {
    const f = fixture();
    expect(await f.run("hello")).toBeNull();
    expect(await f.run("/stop")).toBeNull();
    const list = await f.run("/model");
    expect(list?.html).toContain("gpt-fast");
    expect(list?.markup && "keyboard" in list.markup ? list.markup.keyboard.length : 0).toBe(2);
    await f.run("/model FAST");
    await f.run("/model nothing");
    await f.run("/effort high");
    await f.run("/effort ultra");
    await f.run("/access workspace");
    expect(f.updates).toEqual([
      { agentId: agent.id, model: "gpt-fast" },
      { agentId: agent.id, reasoningEffort: "high" },
      { agentId: agent.id, access: "workspace" },
    ]);
  });

  it("refuses to delete the root agent and asks for the exact name", async () => {
    const f = fixture();
    await f.run("/delete Builder", true);
    await f.run("/delete");
    await f.run("/delete builder");
    expect(f.deleted).toEqual([]);
    await f.run("/delete Builder");
    expect(f.deleted).toEqual([agent.id]);
  });

  it("accepts only existing absolute folders outside Tommy's data and the workspace", async () => {
    const f = fixture();
    for (const path of ["relative/path", "/missing", "/var/lib/tommy/.config", "/srv/tommy/agents/one"])
      await f.run(`/folders add ${path}`);
    expect(f.updates).toEqual([]);
    await f.run("/folders add /srv/projects/new");
    await f.run("/folders remove /srv/projects/old");
    expect(f.updates).toEqual([
      { agentId: agent.id, additionalFolders: ["/srv/projects/old", "/srv/projects/new"] },
      { agentId: agent.id, additionalFolders: [] },
    ]);
  });

  it("cancels only waiting messages and keeps long lists under the Telegram limit", async () => {
    const f = fixture({ memories: 200, history: 40 });
    await f.run("/cancel");
    expect(f.canceled).toEqual(["d1", "d3"]);
    for (const command of ["/memory", "/history 30", "/history", "/queue", "/status"]) {
      const reply = await f.run(command);
      expect(reply?.html.length).toBeLessThanOrEqual(4096);
    }
  });
});
