import { AGENT_TASKS_ROUTES } from "@tommy/contracts/team-protocol/agent-tasks-v1";
import { toWireAgentKeys } from "@tommy/contracts/team-protocol/current-agent-keys";
import { ROUTINE_RUN_PLACE_CAPABILITY } from "@tommy/contracts/team-protocol/routine-run-place-v1";
import { teamSideRouteCodec } from "@tommy/contracts/team-protocol/side-routes";
import { SKILL_LEARNING_CAPABILITY } from "@tommy/contracts/team-protocol/skill-learning-v1";
import {
  createTeamProtocolV8Event,
  encodeTeamProtocolV8WebRtcHttpResponse,
} from "@tommy/contracts/team-protocol/v8-webrtc-adapter";
import { describe, expect, it } from "vitest";
import { withBlockExtensions, withPeerEventExtensions } from "./team-webrtc-host-peer";

const snapshot = {
  agentId: "agent-a",
  threadId: "thread-a",
  activeTurnId: null,
  revision: 1,
  messages: [
    {
      id: "message-a",
      author: "system",
      source: "system",
      status: "completed",
      text: "Save this skill?",
      createdAt: "2026-01-01T00:00:00Z",
      itemType: "skill-suggestion:create",
      skillSuggestion: { name: "Reusable check", secret: "PRIVATE" },
    },
  ],
};
const task = {
  id: "task-a",
  agentId: "agent-a",
  threadId: "thread-a",
  origin: "user",
  title: "Check status",
  state: "idle",
  outcome: "completed",
  hold: null,
  activeTurnId: null,
  progress: null,
  error: null,
  queuedMessages: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  closedAt: null,
  routineId: "routine-a",
};
const capabilities = new Set([SKILL_LEARNING_CAPABILITY, ROUTINE_RUN_PLACE_CAPABILITY]);

describe("direct peer optional metadata boundary", () => {
  it("keeps the suggestion through the second frozen HTTP projection only for a capable peer", () => {
    const encode = () =>
      encodeTeamProtocolV8WebRtcHttpResponse("GET", "/v1/agents/agent-a/conversation", 200, {
        ...snapshot,
        references: {},
        pageInfo: { hasOlder: false, olderCursor: null },
        readState: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: null },
      });
    expect(JSON.stringify(encode())).not.toContain("skillSuggestion");
    const current = withBlockExtensions(capabilities, snapshot, encode());
    expect(JSON.stringify(current)).toContain('"skillSuggestion":{"name":"Reusable check"}');
    expect(JSON.stringify(current)).not.toContain("PRIVATE");
    expect(JSON.stringify(withBlockExtensions(new Set(), snapshot, encode()))).not.toContain("skillSuggestion");
  });

  it("keeps routine task relations in the real optional route response without extending the frozen codec", () => {
    const source = { agentId: "agent-a", tasks: [task], limit: 1 };
    const codec = teamSideRouteCodec(AGENT_TASKS_ROUTES.list);
    if (!codec) throw new Error("Missing task route fixture.");
    const encoded = codec.response(AGENT_TASKS_ROUTES.list, 200, source);
    expect(JSON.stringify(encoded)).not.toContain("routineId");
    expect(JSON.stringify(withBlockExtensions(capabilities, source, encoded))).toContain('"routineId":"routine-a"');
    expect(
      JSON.stringify(withBlockExtensions(new Set(), source, codec.response(AGENT_TASKS_ROUTES.list, 200, source))),
    ).not.toContain("routineId");
  });

  it("keeps suggestions on base events and routine links on optional events after peer encoding", () => {
    const source = toWireAgentKeys({ type: "conversation", snapshot });
    const encoded = JSON.stringify(createTeamProtocolV8Event(1, source));
    expect(encoded).not.toContain("skillSuggestion");
    expect(withPeerEventExtensions(capabilities, source, encoded)).toContain(
      '"skillSuggestion":{"name":"Reusable check"}',
    );
    expect(withPeerEventExtensions(new Set(), source, encoded)).not.toContain("skillSuggestion");
    const taskSource = { type: "agent-tasks-changed", snapshot: { agentId: "agent-a", tasks: [task], limit: 1 } };
    const projected = {
      ...taskSource,
      snapshot: { ...taskSource.snapshot, tasks: [{ ...task, routineId: undefined }] },
    };
    const frame = JSON.stringify({ version: 2, type: "event", sequence: 2, payload: projected });
    expect(withPeerEventExtensions(capabilities, taskSource, frame)).toContain('"routineId":"routine-a"');
    expect(withPeerEventExtensions(new Set(), taskSource, frame)).not.toContain("routineId");
  });
});
