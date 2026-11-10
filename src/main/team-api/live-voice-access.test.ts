import type { VoiceLiveSession } from "@tommy/contracts/ipc-voice";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { TeamApiLiveVoice } from "./dependencies";
import { TeamLiveVoiceAccess } from "./live-voice-access";
import type { TeamApiRequestContext } from "./request-context";

function deferred<Value>() {
  let resolve: (value: Value | PromiseLike<Value>) => void = () => {
    throw new Error("Deferred was not ready.");
  };
  const promise = new Promise<Value>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const context: Pick<TeamApiRequestContext, "member" | "sessionId" | "token"> = {
  member: {
    id: "member-a",
    username: "user",
    email: null,
    name: null,
    role: "member",
    createdAt: "2026-01-01T00:00:00Z",
    disabled: false,
  },
  sessionId: "session-a",
  token: "fake-token",
};
const owner = "team:member-a:session-a";

function service(): TeamApiLiveVoice {
  return {
    start: () => Effect.succeed({ sessionId: "voice-a", sdp: "v=0" }),
    stop: () => Effect.void,
    cancel: () => Effect.void,
    stopOwner: () => Effect.void,
  };
}

describe("Team live voice access boundary", () => {
  it("checks the current token and agent role again before starting", async () => {
    let starts = 0;
    const guard = new TeamLiveVoiceAccess(
      {
        ...service(),
        start: () =>
          Effect.sync(() => {
            starts += 1;
            return { sessionId: "voice-a", sdp: "v=0" };
          }),
      },
      () => false,
    );
    await expect(
      runCauseEffect(guard.forSession(context).start({ agentId: "agent-a", sdp: "v=0" }, owner)),
    ).rejects.toMatchObject({ status: 403 });
    expect(starts).toBe(0);
  });

  it("stops a revoked call even when the client has no event socket", async () => {
    let allowed = true;
    const stops: string[] = [];
    const checked: string[] = [];
    const guard = new TeamLiveVoiceAccess(
      {
        ...service(),
        stopOwner: (ownerId) =>
          Effect.sync(() => {
            stops.push(ownerId);
          }),
      },
      (token, agentId) => {
        checked.push(`${token}|${agentId}`);
        return allowed;
      },
    );
    await runCauseEffect(guard.forSession(context).start({ agentId: "agent-a", sdp: "v=0" }, owner));
    const event = { type: "transcript", sessionId: "voice-a", role: "user", text: "hello", final: true } as const;
    expect(guard.permitsEvent(owner, event)).toBe(true);
    expect(guard.permitsEvent("team:member-a:other-session", event)).toBe(false);
    expect(guard.permitsEvent(owner, { ...event, sessionId: "other-voice" })).toBe(false);
    allowed = false;
    expect(guard.permitsEvent(owner, event)).toBe(false);
    await runCauseEffect(guard.stopUnavailable());
    expect(stops).toEqual([owner]);
    expect(checked.every((value) => value === "fake-token|agent-a")).toBe(true);
  });

  it("stops an SDP answer that arrives after access was revoked during setup", async () => {
    let allowed = true;
    const started = deferred<void>();
    const answer = deferred<VoiceLiveSession>();
    const stopped: string[] = [];
    const stoppedOwners: string[] = [];
    const guard = new TeamLiveVoiceAccess(
      {
        ...service(),
        start: () =>
          Effect.promise(() => {
            started.resolve(undefined);
            return answer.promise;
          }),
        stopOwner: (ownerId) =>
          Effect.sync(() => {
            stoppedOwners.push(ownerId);
          }),
        stop: (sessionId, ownerId) =>
          Effect.sync(() => {
            stopped.push(`${sessionId}|${ownerId}`);
          }),
      },
      () => allowed,
    );
    const pending = runCauseEffect(
      guard.forSession(context).start({ agentId: "agent-a", requestId: "request-a", sdp: "v=0" }, owner),
    );
    await started.promise;
    allowed = false;
    await runCauseEffect(guard.stopUnavailable());
    answer.resolve({ sessionId: "late-voice", sdp: "v=0" });
    await expect(pending).rejects.toMatchObject({ status: 403 });
    expect(stoppedOwners).toEqual([owner]);
    expect(stopped).toEqual([`late-voice|${owner}`]);
    expect(guard.permitsEvent(owner, { type: "ended", sessionId: "late-voice", error: null })).toBe(false);
  });

  it("refuses a forged owner for Start, Stop, Cancel and owner cleanup", async () => {
    let calls = 0;
    const forbidden = () =>
      Effect.sync(() => {
        calls += 1;
      });
    const guard = new TeamLiveVoiceAccess(
      {
        start: () => forbidden().pipe(Effect.as({ sessionId: "voice-a", sdp: "v=0" })),
        stop: forbidden,
        cancel: forbidden,
        stopOwner: forbidden,
      },
      () => true,
    );
    const port = guard.forSession(context);
    const forged = "team:owner:other-session";
    for (const operation of [
      port.start({ agentId: "agent-a", sdp: "v=0" }, forged),
      port.stop("voice-a", forged),
      port.cancel("request-a", forged),
      port.stopOwner(forged),
    ]) {
      await expect(runCauseEffect(operation)).rejects.toMatchObject({ status: 403 });
    }
    expect(calls).toBe(0);
  });

  it("keeps a replacement call when the earlier setup or End event completes late", async () => {
    const started = deferred<void>();
    const first = deferred<VoiceLiveSession>();
    const stopped: string[] = [];
    const guard = new TeamLiveVoiceAccess(
      {
        ...service(),
        start: (input) =>
          input.agentId === "first-agent"
            ? Effect.promise(() => {
                started.resolve(undefined);
                return first.promise;
              })
            : Effect.succeed({ sessionId: "current-voice", sdp: "v=0" }),
        stop: (sessionId) =>
          Effect.sync(() => {
            stopped.push(sessionId);
          }),
      },
      () => true,
    );
    const port = guard.forSession(context);
    const pending = runCauseEffect(port.start({ agentId: "first-agent", sdp: "v=0" }, owner));
    await started.promise;
    await runCauseEffect(port.start({ agentId: "second-agent", sdp: "v=0" }, owner));
    guard.ended(owner, "prior-voice");
    first.resolve({ sessionId: "prior-voice", sdp: "v=0" });
    await expect(pending).rejects.toMatchObject({ status: 403 });
    expect(stopped).toEqual(["prior-voice"]);
    expect(guard.permitsEvent(owner, { type: "ended", sessionId: "current-voice", error: null })).toBe(true);
  });
  it("permits only the matching End metadata during revocation cleanup", async () => {
    let allowed = true;
    const observations: boolean[] = [];
    const guard = new TeamLiveVoiceAccess(
      {
        ...service(),
        stopOwner: () =>
          Effect.sync(() => {
            observations.push(guard.permitsEvent(owner, { type: "ended", sessionId: "voice-a", error: null }));
            observations.push(
              guard.permitsEvent(owner, {
                type: "transcript",
                sessionId: "voice-a",
                role: "user",
                text: "private",
                final: true,
              }),
            );
            observations.push(guard.permitsEvent(owner, { type: "ended", sessionId: "other-voice", error: null }));
          }),
      },
      () => allowed,
    );
    await runCauseEffect(guard.forSession(context).start({ agentId: "agent-a", sdp: "v=0" }, owner));
    allowed = false;
    await runCauseEffect(guard.stopUnavailable());
    expect(observations).toEqual([true, false, false]);
    expect(guard.permitsEvent(owner, { type: "ended", sessionId: "voice-a", error: null })).toBe(false);
  });
});
