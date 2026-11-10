import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentAccessLevel, TeamRole } from "@tommy/contracts/ipc";
import { TEAM_CURRENT_CAPABILITIES, teamCapabilitiesForProtocol } from "@tommy/contracts/team-protocol/current";
import { LIVE_VOICE_CAPABILITY, LIVE_VOICE_ROUTES } from "@tommy/contracts/team-protocol/live-voice-v1";
import { MESSAGE_DELETE_ROUTES } from "@tommy/contracts/team-protocol/message-delete-v1";
import { optionalTeamEvent } from "@tommy/contracts/team-protocol/optional-events";
import {
  ROUTINE_RUN_PLACE_CAPABILITY,
  ROUTINE_RUN_PLACE_ROUTES,
} from "@tommy/contracts/team-protocol/routine-run-place-v1";
import { teamSideRouteCodec } from "@tommy/contracts/team-protocol/side-routes";
import { SKILL_LEARNING_CAPABILITY, SKILL_LEARNING_ROUTES } from "@tommy/contracts/team-protocol/skill-learning-v1";
import { sourceText } from "@tommy/i18n/source";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { RemoteWorkflowError } from "../remote-service-effects";
import type { TeamApiLiveVoice, TeamApiMessageDeletion, TeamApiSkillLearning } from "./dependencies";
import { HttpError } from "./http-error";
import type { TeamApiRequestContext } from "./request-context";
import { routeLiveVoice } from "./route-live-voice";
import { routeMessageDeletion } from "./route-message-deletion";
import { routeSkillLearning } from "./route-skill-learning";

function requestContext(path: string, payload: object, role: TeamRole = "member", level: AgentAccessLevel = "chat") {
  const request = new IncomingMessage(new Socket());
  request.method = "POST";
  request.url = path;
  request.push(Buffer.from(JSON.stringify(payload)));
  request.push(null);
  const answers: Array<{ status: number; body: object | null }> = [];
  const context: TeamApiRequestContext = {
    request,
    response: new ServerResponse(request),
    method: "POST",
    url: new URL(path, "https://example.com"),
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
    agentLevel: () => level,
    json: (status, body) => {
      answers.push({ status, body });
      return "handled";
    },
    empty: () => "handled",
  };
  return { context, answers };
}

const skillService: TeamApiSkillLearning = {
  listLocalSkills: () => Effect.die("unauthorized list"),
  readLocalSkill: () => Effect.die("unauthorized read"),
  snapshot: () => ({ mode: "ask", choices: ["automatic", "ask", "off"] }),
  set: () => Effect.die("unauthorized mutation"),
  save: () => Effect.die("unauthorized save"),
  restore: () => Effect.die("unauthorized restore"),
};

describe("optional Team extension trust boundaries", () => {
  it("keeps new capabilities out of the full v7 and v8 lists", () => {
    const old = new Set(teamCapabilitiesForProtocol(8));
    for (const capability of [
      LIVE_VOICE_CAPABILITY,
      SKILL_LEARNING_CAPABILITY,
      ROUTINE_RUN_PLACE_CAPABILITY,
    ] as const) {
      expect(TEAM_CURRENT_CAPABILITIES).toContain(capability);
      expect(old.has(capability)).toBe(false);
    }
    expect(teamCapabilitiesForProtocol(7).length).toBeLessThanOrEqual(128);
    expect(old.size).toBeLessThanOrEqual(128);
    expect(new Set(TEAM_CURRENT_CAPABILITIES).size).toBe(TEAM_CURRENT_CAPABILITIES.length);
    expect(TEAM_CURRENT_CAPABILITIES.length).toBeLessThanOrEqual(256);
  });

  it("does not accept caller-supplied message deletion privileges", () => {
    const codec = teamSideRouteCodec(MESSAGE_DELETE_ROUTES.agent);
    expect(
      codec?.request(MESSAGE_DELETE_ROUTES.agent, {
        agentId: "a",
        messageId: "m",
        requestId: "r",
        deleteAny: true,
        memberId: "owner",
      }),
    ).toEqual({ agentId: "a", messageId: "m", requestId: "r" });
  });

  it("refuses host learning settings and restore for an ordinary member", async () => {
    for (const path of [
      SKILL_LEARNING_ROUTES.settings,
      SKILL_LEARNING_ROUTES.update,
      SKILL_LEARNING_ROUTES.restore,
      SKILL_LEARNING_ROUTES.listLocal,
      SKILL_LEARNING_ROUTES.readLocal,
    ]) {
      const { context } = requestContext(path, { mode: "automatic" });
      await expect(routeSkillLearning(context, skillService, new Set())).rejects.toMatchObject({ status: 403 });
    }
    const { context } = requestContext(SKILL_LEARNING_ROUTES.save, { agentId: "a", messageId: "m" }, "member", "view");
    await expect(routeSkillLearning(context, skillService, new Set())).rejects.toMatchObject({ status: 403 });
  });

  it("scopes voice Stop to the authenticated session and ignores a claimed owner", async () => {
    const calls: string[] = [];
    const voice: TeamApiLiveVoice = {
      start: () => Effect.die("unexpected start"),
      stop: (sessionId, ownerId) =>
        Effect.sync(() => {
          calls.push(`${sessionId}|${ownerId}`);
        }),
      stopOwner: () => Effect.void,
      cancel: () => Effect.void,
    };
    const { context, answers } = requestContext(LIVE_VOICE_ROUTES.stop, {
      sessionId: "voice-a",
      ownerId: "team:owner:session-b",
    });
    await routeLiveVoice(context, voice, { listAgents: () => [] }, new Set());
    expect(calls).toEqual(["voice-a|team:member-a:session-a"]);
    expect(answers).toEqual([{ status: 200, body: {} }]);
  });

  it("keeps a voice access refusal at 403 after an asynchronous role check", async () => {
    const voice: TeamApiLiveVoice = {
      start: () => Effect.die("unexpected start"),
      stop: () =>
        Effect.fail(new RemoteWorkflowError({ cause: new HttpError(403, sourceText("error.team.agentViewOnly")) })),
      cancel: () => Effect.void,
      stopOwner: () => Effect.void,
    };
    const { context } = requestContext(LIVE_VOICE_ROUTES.stop, { sessionId: "voice-a" });
    await expect(routeLiveVoice(context, voice, { listAgents: () => [] }, new Set())).rejects.toMatchObject({
      status: 403,
    });
  });

  it("rejects malformed known voice and routine completion events", () => {
    expect(() =>
      optionalTeamEvent({ type: "live-voice", kind: "ended", sessionId: "v", error: { token: "fake" } }),
    ).toThrow();
    expect(() =>
      optionalTeamEvent({ type: "routine-thread-turn-completed", taskId: "t", turn: { type: "turn-completed" } }),
    ).toThrow();
    expect(() =>
      optionalTeamEvent({
        type: "conversation-messages-deleted",
        agentId: "a",
        threadId: "t",
        messageIds: Array.from({ length: 501 }, () => "m"),
      }),
    ).toThrow();
    expect(
      optionalTeamEvent({ type: "conversation-messages-deleted", agentId: "a", threadId: "t", messageIds: ["m"] }),
    ).toEqual({ type: "conversation-messages-deleted", agentId: "a", threadId: "t", messageIds: ["m"] });
    expect(optionalTeamEvent({ type: "future-unrecognized-event" })).toBeNull();
  });

  it("keeps runIn on its new codec while legacy event routes remain unchanged", () => {
    const input = {
      agentId: "a",
      name: "Routine",
      instruction: "Check status",
      active: true,
      timezone: "UTC",
      schedule: { kind: "daily", time: "09:00" },
      runIn: "thread",
    };
    expect(
      teamSideRouteCodec(ROUTINE_RUN_PLACE_ROUTES.create)?.request(ROUTINE_RUN_PLACE_ROUTES.create, input),
    ).toMatchObject({ runIn: "thread" });
  });
  it("lets a shared-channel reader remove an own message even when an agent is hidden", async () => {
    const grants: Array<{ memberId: string | null; deleteAny: boolean }> = [];
    const service: TeamApiMessageDeletion = {
      deleteMessage: () => Effect.die("unexpected agent deletion"),
      deleteTaskMessage: () => Effect.die("unexpected task deletion"),
      deleteChannelMessage: (_input, access) =>
        Effect.sync(() => {
          if (!access) throw new Error("Missing authenticated access.");
          grants.push(access);
          return { deleted: true };
        }),
      deleteAgentHistory: () => Effect.die("unexpected agent history deletion"),
      deleteChannelHistory: () => Effect.die("unexpected channel history deletion"),
    };
    const { context, answers } = requestContext(
      MESSAGE_DELETE_ROUTES.channel,
      { channelId: "shared", messageId: "mine", requestId: "request-a", deleteAny: true },
      "member",
      "none",
    );
    await routeMessageDeletion(
      context,
      service,
      { listAgents: () => [] },
      { store: { exists: (id) => id === "shared" } },
      new Set(["hidden-agent"]),
    );
    expect(grants).toEqual([{ memberId: "member-a", deleteAny: false }]);
    expect(answers).toEqual([{ status: 200, body: { deleted: true } }]);
  });
});
