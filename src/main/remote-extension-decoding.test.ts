// @vitest-environment node

import { isAgentEvent } from "@tommy/contracts/ipc";
import { LEARNED_SKILL_READ_LIMITS } from "@tommy/contracts/ipc-skill-learning";
import { describe, expect, it } from "vitest";
import { decodeLearnedSkillFromMain, decodeLearnedSkillsFromMain } from "../preload/skill-learning-decoding";
import {
  decodeAgentSpeedModelsFromHost,
  decodeBrowserProfileProxyFromHost,
  decodeLearnedSkillFromHost,
  decodeLearnedSkillsFromHost,
  decodeMessageDeletionEventFromHost,
  decodeScopedVoiceLiveEventFromHost,
  decodeSkillLearningFromHost,
  decodeVaultCodesFromHost,
  decodeWorkflowIntegrationCatalogFromHost,
} from "./remote-extension-decoding";

const PROFILE_ID = "0123456789abcdef0123456789abcdef";

describe("remote additive response boundaries", () => {
  it("rejects proxy credentials before returning profile metadata", () => {
    const profile = { profileId: PROFILE_ID, address: "https://user@proxy.example.com:443", hasPassword: true };
    expect(decodeBrowserProfileProxyFromHost(profile)).toEqual(profile);
    expect(() => decodeBrowserProfileProxyFromHost({ ...profile, password: "PRIVATE" })).toThrow();
    expect(() =>
      decodeBrowserProfileProxyFromHost({ ...profile, address: "https://user:PRIVATE@proxy.example.com:443" }),
    ).toThrow();
  });

  it("bounds speed model and preference metadata", () => {
    expect(
      decodeAgentSpeedModelsFromHost({
        models: [{ provider: "codex", id: "example", fastServiceTier: "priority", privateData: "PRIVATE" }],
      }),
    ).toEqual({ models: [{ provider: "codex", id: "example", fastServiceTier: "priority" }] });
    expect(() =>
      decodeAgentSpeedModelsFromHost({
        models: [{ provider: "codex", id: "example", fastServiceTier: "x".repeat(65) }],
      }),
    ).toThrow();
    expect(() => decodeSkillLearningFromHost({ mode: "", choices: ["ask"] })).toThrow();
    expect(() => decodeSkillLearningFromHost({ mode: "ask", choices: [false] })).toThrow();
  });

  it("rejects setup keys and invalid periods in code responses", () => {
    const code = { id: "login-1", code: "123456", period: 30, remainingMs: 29_000 };
    expect(decodeVaultCodesFromHost({ codes: [code] })).toEqual({ codes: [code] });
    expect(() => decodeVaultCodesFromHost({ codes: [code], twoStepKey: "PRIVATE" })).toThrow();
    expect(() => decodeVaultCodesFromHost({ codes: [{ ...code, secret: "PRIVATE" }] })).toThrow();
    expect(() => decodeVaultCodesFromHost({ codes: [{ ...code, remainingMs: 30_001 }] })).toThrow();
    expect(() => decodeVaultCodesFromHost({ codes: [{ ...code, id: "x".repeat(65) }] })).toThrow();
  });

  it("keeps deletion events bounded and strips undeclared content", () => {
    const event = {
      type: "conversation-messages-deleted",
      agentId: "agent-1",
      threadId: "thread-1",
      messageIds: ["old-1"],
    };
    expect(decodeMessageDeletionEventFromHost({ ...event, privateData: "PRIVATE" })).toEqual(event);
    expect(() => decodeMessageDeletionEventFromHost({ ...event, messageIds: [] })).toThrow();
    expect(() =>
      decodeMessageDeletionEventFromHost({ ...event, messageIds: Array.from({ length: 501 }, () => "old-1") }),
    ).toThrow();
    expect(isAgentEvent({ ...event, messageIds: [] })).toBe(false);
  });

  it("keeps the host scope outside voice transcript fields", () => {
    const event = { type: "transcript", sessionId: "voice-1", role: "user", text: "Hello", final: true };
    expect(decodeScopedVoiceLiveEventFromHost({ serverId: "host-1", event: { ...event, ownerId: "other" } })).toEqual({
      serverId: "host-1",
      event,
    });
    expect(() =>
      decodeScopedVoiceLiveEventFromHost({ serverId: "host-1", event: { ...event, role: "system" } }),
    ).toThrow();
    expect(() =>
      decodeScopedVoiceLiveEventFromHost({ serverId: "host-1", event: { ...event, text: "x".repeat(100_001) } }),
    ).toThrow();
  });

  it("projects only public connector fields at every nesting level", () => {
    const catalog = {
      github: false,
      places: [],
      telegram: [],
      discord: [],
      token: "PRIVATE",
      slack: [
        {
          connectionId: "slack-example",
          name: "Example",
          token: "PRIVATE",
          channels: [{ id: "channel-1", name: "general", secret: "PRIVATE" }],
        },
      ],
    };
    expect(decodeWorkflowIntegrationCatalogFromHost(catalog)).toEqual({
      github: false,
      places: [],
      telegram: [],
      discord: [],
      slack: [{ connectionId: "slack-example", name: "Example", channels: [{ id: "channel-1", name: "general" }] }],
    });
  });

  it("validates the optional local workflow author without widening frozen events", () => {
    expect(isAgentEvent({ type: "workflows-changed", workflowId: "workflow-1" })).toBe(true);
    expect(isAgentEvent({ type: "workflows-changed", workflowId: "workflow-1", agentId: "agent-1" })).toBe(true);
    expect(isAgentEvent({ type: "workflows-changed", workflowId: "workflow-1", agentId: "" })).toBe(false);
  });
  it("bounds remote learned revisions independently at Host and Main and projects undeclared fields", () => {
    const detail = {
      id: "local-skill-00000000-0000-0000-0000-000000000000",
      slug: "example",
      name: "Example",
      description: "A repeatable check.",
      category: "other",
      creatorName: "Local",
      version: 2,
      installs: 0,
      featured: false,
      iconUrl: null,
      updatedAt: "2026-01-01T00:00:00Z",
      versionId: "2",
      bundleSha256: "a".repeat(64),
      files: ["SKILL.md"],
      instructions: "Check the result.",
    };
    for (const decode of [decodeLearnedSkillFromHost, decodeLearnedSkillFromMain]) {
      expect(decode({ ...detail, token: "PRIVATE", path: "/Users/user/private" })).toEqual(detail);
      expect(() =>
        decode({ ...detail, instructions: "x".repeat(LEARNED_SKILL_READ_LIMITS.instructions + 1) }),
      ).toThrow();
      expect(() =>
        decode({ ...detail, files: Array.from({ length: LEARNED_SKILL_READ_LIMITS.files + 1 }, () => "SKILL.md") }),
      ).toThrow();
      expect(() => decode({ ...detail, iconUrl: "https://example.com/private-token" })).toThrow();
      expect(() => decode({ ...detail, version: 0 })).toThrow();
    }
    for (const decode of [decodeLearnedSkillsFromHost, decodeLearnedSkillsFromMain]) {
      expect(decode([detail])).toEqual([detail]);
      expect(() => decode(Array.from({ length: LEARNED_SKILL_READ_LIMITS.list + 1 }, () => detail))).toThrow();
    }
  });
});
