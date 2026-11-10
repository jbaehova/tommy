import type { VoiceLiveEvent, VoiceLiveStart } from "@tommy/contracts/ipc-voice";
import { sourceText } from "@tommy/i18n/source";
import { Effect, Exit } from "effect";
import { RemoteWorkflowError } from "../remote-service-effects";
import type { TeamApiLiveVoice } from "./dependencies";
import { HttpError } from "./http-error";
import type { TeamApiRequestContext } from "./request-context";
import { teamLiveVoiceOwner } from "./route-live-voice";

interface CallAccess {
  readonly token: string;
  readonly agentId: string;
  readonly requestId: string | undefined;
  sessionId: string | null;
  revoked: boolean;
}

/** Checks the current session and roles for both pending and accepted voice calls. */
export class TeamLiveVoiceAccess {
  readonly #voice: TeamApiLiveVoice;
  readonly #allowed: (token: string, agentId: string) => boolean;
  readonly #calls = new Map<string, CallAccess>();

  constructor(voice: TeamApiLiveVoice, allowed: (token: string, agentId: string) => boolean) {
    this.#voice = voice;
    this.#allowed = allowed;
  }

  forSession(context: Pick<TeamApiRequestContext, "member" | "sessionId" | "token">): TeamApiLiveVoice {
    const ownerId = teamLiveVoiceOwner(context.member.id, context.sessionId);
    return {
      start: (input, requestedOwner) =>
        requestedOwner === ownerId ? this.#start(input, ownerId, context.token) : denied(),
      stop: (sessionId, requestedOwner) => (requestedOwner === ownerId ? this.#stop(sessionId, ownerId) : denied()),
      cancel: (requestId, requestedOwner) => (requestedOwner === ownerId ? this.#cancel(requestId, ownerId) : denied()),
      stopOwner: (requestedOwner) => (requestedOwner === ownerId ? this.stopOwner(ownerId) : denied()),
    };
  }

  readonly #start = Effect.fn("TeamLiveVoiceAccess.start")(function* (
    this: TeamLiveVoiceAccess,
    input: VoiceLiveStart,
    ownerId: string,
    token: string,
  ) {
    if (!this.#allowed(token, input.agentId)) return yield* denied();
    const call: CallAccess = {
      token,
      agentId: input.agentId,
      requestId: input.requestId,
      sessionId: null,
      revoked: false,
    };
    this.#calls.set(ownerId, call);
    return yield* this.#voice.start(input, ownerId).pipe(
      Effect.flatMap((session) => {
        call.sessionId = session.sessionId;
        if (call.revoked || this.#calls.get(ownerId) !== call || !this.#allowed(token, input.agentId)) {
          call.revoked = true;
          return this.#voice.stop(session.sessionId, ownerId).pipe(Effect.flatMap(() => denied()));
        }
        return Effect.succeed(session);
      }),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && this.#calls.get(ownerId) === call) this.#calls.delete(ownerId);
        }),
      ),
    );
  });

  readonly #stop = Effect.fn("TeamLiveVoiceAccess.stop")(function* (
    this: TeamLiveVoiceAccess,
    sessionId: string,
    ownerId: string,
  ) {
    const call = this.#calls.get(ownerId);
    yield* this.#voice.stop(sessionId, ownerId);
    if (call?.sessionId === sessionId && this.#calls.get(ownerId) === call) this.#calls.delete(ownerId);
  });

  readonly #cancel = Effect.fn("TeamLiveVoiceAccess.cancel")(function* (
    this: TeamLiveVoiceAccess,
    requestId: string,
    ownerId: string,
  ) {
    const call = this.#calls.get(ownerId);
    if (call?.requestId === requestId) call.revoked = true;
    yield* this.#voice.cancel(requestId, ownerId);
    if (call?.requestId === requestId && this.#calls.get(ownerId) === call) this.#calls.delete(ownerId);
  });

  readonly stopOwner = Effect.fn("TeamLiveVoiceAccess.stopOwner")(function* (
    this: TeamLiveVoiceAccess,
    ownerId: string,
  ) {
    const call = this.#calls.get(ownerId);
    if (call) call.revoked = true;
    yield* this.#voice.stopOwner(ownerId);
    if (this.#calls.get(ownerId) === call) this.#calls.delete(ownerId);
  });

  readonly stopUnavailable = Effect.fn("TeamLiveVoiceAccess.stopUnavailable")(function* (this: TeamLiveVoiceAccess) {
    for (const [ownerId, call] of [...this.#calls]) {
      if (this.#calls.get(ownerId) !== call) continue;
      if (!call.revoked && this.#allowed(call.token, call.agentId)) continue;
      // Mark this before waiting for provider cleanup. No transcript can pass during cleanup.
      call.revoked = true;
      yield* this.stopOwner(ownerId).pipe(Effect.catch(() => Effect.void));
    }
  });

  readonly stopAll = Effect.fn("TeamLiveVoiceAccess.stopAll")(function* (this: TeamLiveVoiceAccess) {
    for (const ownerId of [...this.#calls.keys()]) yield* this.stopOwner(ownerId).pipe(Effect.catch(() => Effect.void));
  });

  permitsEvent(ownerId: string, event: VoiceLiveEvent): boolean {
    const call = this.#calls.get(ownerId);
    if (!call || call.sessionId !== event.sessionId) return false;
    // End contains no speech. The authenticated owner must clear its controls while teardown is
    // in progress, even after an agent role is revoked. A replacement session still cannot match.
    return event.type === "ended" || (!call.revoked && this.#allowed(call.token, call.agentId));
  }

  ended(ownerId: string, sessionId: string): void {
    if (this.#calls.get(ownerId)?.sessionId === sessionId) this.#calls.delete(ownerId);
  }
}

function denied(): Effect.Effect<never, RemoteWorkflowError> {
  return Effect.fail(new RemoteWorkflowError({ cause: new HttpError(403, sourceText("error.team.agentViewOnly")) }));
}
