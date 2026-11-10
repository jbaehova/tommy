import { randomUUID } from "node:crypto";
import type { AgentSummary } from "@tommy/contracts/ipc";
import {
  decodeVoiceLiveStart,
  VOICE_LIVE_LIMITS,
  type VoiceLiveEvent,
  type VoiceLiveSession,
  type VoiceLiveStart,
} from "@tommy/contracts/ipc-voice";
import { sourceText } from "@tommy/i18n/source";
import { Deferred, Effect, Schema } from "effect";
import type { AgentClient } from "../agent-client";
import {
  type AppServerNotification,
  decodeAccountReadResult,
  decodeRecordResponse,
  getString,
  isRecord,
} from "../protocol";

const ANSWER_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 5_000;
const UNAUTHORIZED = /\bstatus 401\b|\b401 Unauthorized\b/;

export class LiveVoiceFailed extends Schema.TaggedError<LiveVoiceFailed>()("LiveVoiceFailed", {
  cause: Schema.Defect(),
}) {}

function failure(message: string): LiveVoiceFailed {
  return new LiveVoiceFailed({ cause: new Error(message) });
}

export interface LiveVoiceHooks {
  agent(agentId: string): AgentSummary;
  client(agent: AgentSummary): Effect.Effect<AgentClient, { readonly cause: unknown }>;
  ensureThread(agent: AgentSummary, client: AgentClient): Effect.Effect<string, { readonly cause: unknown }>;
  /** Holds every lane of this agent. Its release must be idempotent. */
  holdDrain(agentId: string): () => void;
  /** Waits for the drain already in progress and refuses a provider turn that remains active. */
  awaitIdle(agentId: string): Effect.Effect<void, { readonly cause: unknown }>;
  addSpeech(agentId: string, providerThreadId: string, role: "user" | "assistant", text: string): void;
  /** The opaque owner is made by trusted IPC or the authenticated Team route, never the payload. */
  emit(event: VoiceLiveEvent, ownerId: string): void;
  redact(text: string): string;
}

interface StartAttempt {
  readonly ownerId: string;
  readonly requestId: string | null;
  readonly agentId: string;
  readonly cancel: Deferred.Deferred<never, LiveVoiceFailed>;
  readonly finished: Deferred.Deferred<void>;
  client: AgentClient | null;
}

interface LiveSession {
  readonly id: string;
  readonly ownerId: string;
  readonly requestId: string | null;
  readonly agentId: string;
  readonly threadId: string;
  readonly client: AgentClient;
  readonly answer: Deferred.Deferred<string, LiveVoiceFailed>;
  readonly stopped: Deferred.Deferred<void>;
  readonly release: () => void;
  readonly onExit: (error: Error) => void;
  readonly finalItems: Set<string>;
  stopping: boolean;
}

/**
 * Owns realtime voice calls on existing Codex threads. Credentials stay in Codex; only bounded
 * SDP crosses Tommy's IPC or authenticated direct WSS. The media track connects to OpenAI.
 * A call holds queued turns of its agent and frees that hold on every exit path.
 */
export class LiveVoice {
  readonly #hooks: LiveVoiceHooks;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #attempts = new Set<StartAttempt>();
  #disposed = false;

  constructor(hooks: LiveVoiceHooks) {
    this.#hooks = hooks;
  }

  /** Includes an SDP negotiation, so an idle provider cannot restart during a call. */
  hasAgent(agentId: string): boolean {
    return (
      [...this.#attempts].some((attempt) => attempt.agentId === agentId) ||
      [...this.#sessions.values()].some((session) => session.agentId === agentId)
    );
  }

  isLiveThread(threadId: string): boolean {
    return [...this.#sessions.values()].some((session) => session.threadId === threadId);
  }

  readonly start = Effect.fn("LiveVoice.start")(function* (this: LiveVoice, input: VoiceLiveStart, ownerId = "local") {
    const request = yield* Effect.try({
      try: () => decodeVoiceLiveStart(input),
      catch: () => failure(sourceText("error.voice.live.cannotStart")),
    });
    if (this.#disposed) return yield* failure(sourceText("error.voice.live.disconnected"));
    const agent = yield* Effect.try({
      try: () => this.#hooks.agent(request.agentId),
      catch: () => failure(sourceText("error.agent.selectedGone")),
    });
    if (agent.provider !== "codex") return yield* failure(sourceText("error.voice.live.codexOnly"));

    const foreignSession = [...this.#sessions.values()].some(
      (prior) => prior.agentId === agent.id && prior.ownerId !== ownerId,
    );
    const foreignStart = [...this.#attempts].some((prior) => prior.agentId === agent.id && prior.ownerId !== ownerId);
    if (foreignSession || foreignStart) return yield* failure(sourceText("error.voice.live.busy"));
    const attempt: StartAttempt = {
      ownerId,
      requestId: request.requestId ?? null,
      agentId: agent.id,
      cancel: Deferred.makeUnsafe(),
      finished: Deferred.makeUnsafe(),
      client: null,
    };
    const replaced = this.#cancelAttempts((prior) => prior.ownerId === ownerId);
    this.#attempts.add(attempt);
    const release = this.#hooks.holdDrain(agent.id);
    let session: LiveSession | undefined;
    let accepted = false;
    return yield* Effect.gen({ self: this }, function* () {
      yield* this.#waitAttempts(replaced);
      for (const prior of [...this.#sessions.values()]) {
        if (prior.ownerId === ownerId) yield* this.#stopSession(prior);
      }
      yield* this.#hooks.awaitIdle(agent.id).pipe(Effect.mapError(() => failure(sourceText("error.voice.live.busy"))));
      const client = yield* this.#hooks.client(agent).pipe(Effect.mapError((error) => this.#safeFailure(error.cause)));
      if (client.provider !== "codex") return yield* failure(sourceText("error.voice.live.codexOnly"));
      attempt.client = client;
      const account = yield* client
        .request("account/read", { refreshToken: false }, decodeAccountReadResult)
        .pipe(Effect.mapError((error) => this.#safeFailure(error.cause)));
      if (account.account?.type !== "chatgpt") return yield* failure(sourceText("error.voice.live.signIn"));
      const threadId = yield* this.#hooks
        .ensureThread(agent, client)
        .pipe(Effect.mapError((error) => this.#safeFailure(error.cause)));
      if (!this.#attempts.has(attempt)) return yield* failure(sourceText("error.voice.live.disconnected"));
      const currentAgent = yield* Effect.try({
        try: () => this.#hooks.agent(agent.id),
        catch: () => failure(sourceText("error.agent.selectedGone")),
      });
      if (
        currentAgent.provider !== agent.provider ||
        currentAgent.providerAccountId !== agent.providerAccountId ||
        currentAgent.model !== agent.model
      )
        return yield* failure(sourceText("error.voice.live.disconnected"));
      if (client.prepareLiveVoiceThread)
        yield* client.prepareLiveVoiceThread(threadId).pipe(Effect.mapError((error) => this.#safeFailure(error.cause)));
      const id = randomUUID();
      const current: LiveSession = {
        id,
        ownerId,
        requestId: request.requestId ?? null,
        agentId: agent.id,
        threadId,
        client,
        release,
        answer: Deferred.makeUnsafe(),
        stopped: Deferred.makeUnsafe(),
        stopping: false,
        finalItems: new Set(),
        onExit: () => this.#end(current, sourceText("error.voice.live.disconnected")),
      };
      session = current;
      this.#sessions.set(id, current);
      client.once("exit", current.onExit);
      yield* client
        .request(
          "thread/realtime/start",
          {
            threadId,
            outputModality: "audio",
            transport: { type: "webrtc", sdp: request.sdp },
            version: "v3",
            ...(request.voice === undefined ? {} : { voice: request.voice }),
          },
          decodeRecordResponse,
          ANSWER_TIMEOUT_MS,
        )
        .pipe(Effect.mapError((error) => this.#safeFailure(error.cause)));
      const sdp = yield* Deferred.await(current.answer).pipe(
        Effect.timeoutOrElse({
          duration: ANSWER_TIMEOUT_MS,
          orElse: () => Effect.fail(failure(sourceText("error.voice.live.timedOut"))),
        }),
      );
      if (!this.#sessions.has(id) || !this.#attempts.has(attempt))
        return yield* failure(sourceText("error.voice.live.disconnected"));
      accepted = true;
      return { sessionId: id, sdp } satisfies VoiceLiveSession;
    }).pipe(
      Effect.raceFirst(Deferred.await(attempt.cancel)),
      Effect.ensuring(
        Effect.suspend(() => {
          this.#attempts.delete(attempt);
          if (accepted)
            return Effect.sync(() => {
              Deferred.doneUnsafe(attempt.finished, Effect.void);
            });
          return (session ? this.#stopSession(session, false) : Effect.sync(release)).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                Deferred.doneUnsafe(attempt.finished, Effect.void);
              }),
            ),
          );
        }),
      ),
    );
  });

  readonly stop = Effect.fn("LiveVoice.stop")(function* (this: LiveVoice, sessionId: string, ownerId = "local") {
    const session = this.#sessions.get(sessionId);
    if (session && session.ownerId === ownerId) yield* this.#stopSession(session);
  });

  readonly cancel = Effect.fn("LiveVoice.cancel")(function* (this: LiveVoice, requestId: string, ownerId = "local") {
    const attempts = this.#cancelAttempts((attempt) => attempt.ownerId === ownerId && attempt.requestId === requestId);
    for (const session of [...this.#sessions.values()])
      if (session.ownerId === ownerId && session.requestId === requestId) yield* this.#stopSession(session);
    yield* this.#waitAttempts(attempts);
  });

  readonly stopOwner = Effect.fn("LiveVoice.stopOwner")(function* (this: LiveVoice, ownerId: string) {
    const attempts = this.#cancelAttempts((attempt) => attempt.ownerId === ownerId);
    for (const session of [...this.#sessions.values()])
      if (session.ownerId === ownerId) yield* this.#stopSession(session);
    yield* this.#waitAttempts(attempts);
  });

  readonly stopAgent = Effect.fn("LiveVoice.stopAgent")(function* (this: LiveVoice, agentId: string) {
    const attempts = this.#cancelAttempts((attempt) => attempt.agentId === agentId);
    for (const session of [...this.#sessions.values()])
      if (session.agentId === agentId) yield* this.#stopSession(session);
    yield* this.#waitAttempts(attempts);
  });

  /** Pass provider notifications here before normal turn handling. */
  handleNotification(notification: AppServerNotification, source: AgentClient): void {
    if (notification.method === "account/updated") {
      this.#cancelAttempts((attempt) => attempt.client === source);
      for (const session of [...this.#sessions.values()]) {
        if (session.client === source) Effect.runFork(this.#stopSession(session));
      }
      return;
    }
    const threadId = getString(notification.params, "threadId");
    const session = [...this.#sessions.values()].find(
      (entry) => entry.threadId === threadId && entry.client === source,
    );
    if (!session || session.stopping) return;
    const params = notification.params;
    switch (notification.method) {
      case "thread/realtime/sdp": {
        const sdp = getString(params, "sdp");
        if (sdp && sdp.length <= VOICE_LIVE_LIMITS.maximumSdpLength)
          Deferred.doneUnsafe(session.answer, Effect.succeed(sdp));
        return;
      }
      case "thread/realtime/error":
        Effect.runFork(this.#stopSession(session, true, this.#reason(getString(params, "message"))));
        return;
      case "thread/realtime/closed":
        this.#end(session, getString(params, "reason") ? sourceText("error.voice.live.disconnected") : null);
        return;
      case "thread/realtime/transcript/delta":
      case "thread/realtime/transcript/done": {
        const role = getString(params, "role");
        if (role !== "user" && role !== "assistant") return;
        const final = notification.method === "thread/realtime/transcript/done";
        const text = getString(params, final ? "text" : "delta");
        if (!text || text.length > VOICE_LIVE_LIMITS.maximumTranscriptLength) return;
        const safe = this.#hooks.redact(text).slice(0, VOICE_LIVE_LIMITS.maximumTranscriptLength);
        this.#hooks.emit({ type: "transcript", sessionId: session.id, role, text: safe, final }, session.ownerId);
        const itemId = getString(params, "itemId");
        const receipt = itemId ? `${role}:${itemId}` : null;
        if (final && safe.trim() && (!receipt || !session.finalItems.has(receipt))) {
          if (receipt) {
            if (session.finalItems.size >= 512) session.finalItems.clear();
            session.finalItems.add(receipt);
          }
          this.#hooks.addSpeech(session.agentId, session.threadId, role, safe);
        }
      }
    }
  }

  /** A voice-started turn cannot take a queued delivery. */
  turnNotification(notification: AppServerNotification): AppServerNotification {
    if (notification.method !== "turn/started" || !isRecord(notification.params)) return notification;
    const threadId = getString(notification.params, "threadId");
    return threadId && this.isLiveThread(threadId)
      ? { ...notification, params: { ...notification.params, unprompted: true } }
      : notification;
  }

  readonly dispose = Effect.fn("LiveVoice.dispose")(function* (this: LiveVoice) {
    this.#disposed = true;
    const attempts = this.#cancelAttempts(() => true);
    for (const session of [...this.#sessions.values()]) yield* this.#stopSession(session);
    yield* this.#waitAttempts(attempts);
  });

  #safeFailure(cause: unknown): LiveVoiceFailed {
    return failure(this.#reason(cause));
  }

  #reason(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    return sourceText(UNAUTHORIZED.test(message) ? "error.voice.live.signIn" : "error.voice.live.cannotStart");
  }

  #cancelAttempts(matches: (attempt: StartAttempt) => boolean): StartAttempt[] {
    const cancelled: StartAttempt[] = [];
    for (const attempt of this.#attempts) {
      if (!matches(attempt)) continue;
      this.#attempts.delete(attempt);
      cancelled.push(attempt);
      Deferred.doneUnsafe(attempt.cancel, Effect.fail(failure(sourceText("error.voice.live.disconnected"))));
    }
    return cancelled;
  }

  readonly #waitAttempts = Effect.fn("LiveVoice.waitAttempts")(function* (attempts: readonly StartAttempt[]) {
    for (const attempt of attempts) yield* Deferred.await(attempt.finished);
  });

  readonly #stopSession = Effect.fn("LiveVoice.stopSession")(function* (
    this: LiveVoice,
    session: LiveSession,
    announce = true,
    error: string | null = null,
  ) {
    if (!this.#sessions.has(session.id)) return;
    if (session.stopping) return yield* Deferred.await(session.stopped);
    session.stopping = true;
    Deferred.doneUnsafe(session.answer, Effect.fail(failure(sourceText("error.voice.live.disconnected"))));
    yield* session.client
      .request("thread/realtime/stop", { threadId: session.threadId }, decodeRecordResponse, STOP_TIMEOUT_MS)
      .pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => this.#end(session, error, announce))));
  });

  #end(session: LiveSession, error: string | null, announce = true): void {
    if (!this.#sessions.delete(session.id)) return;
    session.client.off("exit", session.onExit);
    Deferred.doneUnsafe(session.answer, Effect.fail(failure(error ?? sourceText("error.voice.live.disconnected"))));
    session.release();
    Deferred.doneUnsafe(session.stopped, Effect.void);
    if (announce) this.#hooks.emit({ type: "ended", sessionId: session.id, error }, session.ownerId);
  }
}
