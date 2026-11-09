import {
  type AgentEvent,
  type AgentSummary,
  latestTurnAnswer,
  type ServerNotificationLevel,
} from "@tommy/contracts/ipc";
import {
  type AndroidNotificationRelayPush,
  NOTIFICATION_SEALED_LIMIT,
  type NotificationSound,
} from "@tommy/contracts/notification-relay";
import { TEAM_CHANNEL_ATTENTION_CAPABILITY } from "@tommy/contracts/team-protocol/current";
import { resolveLocale, translateFor } from "@tommy/i18n";
import { redactText, toLogValue } from "@tommy/logging";
import {
  type AgentNotificationChannel,
  agentEventCanNotify,
  agentEventRequestThread,
  agentNotificationLevel,
  notificationForAgentEvent,
} from "@tommy/team-client/agent-notifications";
import {
  decodeNotificationBytes,
  NOTIFICATION_NONCE_BYTES,
  NOTIFICATION_SECRET_BYTES,
} from "@tommy/team-client/notification-seal";
import {
  type PushNotificationContent,
  type PushNotificationKeys,
  type PushNotificationKind,
  pushNotificationKeys,
  sealPushNotification,
} from "@tommy/team-client/push-notification-seal";
import { Effect, Exit, Fiber, Result, Schema, Scope } from "effect";
import { isNoUpdateAnswer } from "../backend/agent/routine-quiet-runs";
import type { PushNotificationStore, PushTarget, StoredPushRegistration } from "./push-notification-store";
import type { TeamApiAgents } from "./team-api/dependencies";
import { markerExclusionsForCapabilities } from "./team-api/request-helpers";

/** The answer of a turn is among the last messages of the conversation. */
const ANSWER_PAGE_SIZE = 20;
/**
 * The owner did something on the computer of this host this recently, so the desktop app there shows
 * the event. It is short: a task can end at any time after the owner leaves the computer.
 */
export const DESKTOP_USE_MS = 30 * 1000;
/**
 * Android can stop the app before it says that it goes away, and the host sees the lost connection
 * about 30 s later. An event in that time is kept this
 * long, and goes out when the phone turns out to be away and the member has not seen it.
 */
const HELD_EVENT_MS = 5 * 60 * 1000;
/** The most events kept for one phone. */
const HELD_EVENT_LIMIT = 20;
/**
 * A phone that Android stopped while it sent `away` sends it when it runs again, just before it says
 * that it is back. The kept events wait this long, so the phone does not show them on screen.
 */
const HELD_FLUSH_DELAY_MS = 3_000;
/** A notification that Google did not take is sent again after these times. */
const RESEND_DELAYS_MS = [10_000, 60_000] as const;

export interface NotificationRelayRequest {
  platform: "android";
  push: AndroidNotificationRelayPush;
}

type PushNotificationAgents = Pick<
  TeamApiAgents,
  "on" | "off" | "listAgents" | "readConversationPageFor" | "getRuntimeSnapshot" | "listConversationReads"
>;

interface PushNotificationOptions {
  agents: PushNotificationAgents;
  store: Pick<PushNotificationStore, "list" | "replace">;
  /** Sends one notification. `gone` means the phone gets no more. */
  send(request: NotificationRelayRequest): Effect.Effect<"sent" | "gone", PushNotificationSendFailure>;
  /** The agents that the member's phone with this protocol and these capabilities cannot see. */
  hiddenAgentIds(protocol: number, capabilities: ReadonlySet<string>, memberId: string): ReadonlySet<string>;
  /** Whether the member is still a member and not disabled. A removed member gets no more notifications. */
  memberActive(memberId: string): boolean;
  /** Whether a desktop app of the member has a focused window. Its window shows the event. */
  desktopFocusedElsewhere(memberId: string, sessionId: string): boolean;
  /**
   * The levels that the member chose on this server for all of their devices
   * (`agent-notification-levels-v1`). The server level replaces the level of the phone's registration,
   * and the level of an agent replaces the server level for the events of that agent.
   */
  memberLevels?(memberId: string): {
    server: ServerNotificationLevel | null;
    agents: ReadonlyMap<string, ServerNotificationLevel>;
  };
  /** Whether the member is at the computer of this host, where the desktop app shows the event. */
  atHostComputer(memberId: string, event: AgentEvent): boolean;
  /** The channel whose execution thread `threadId` is, or `null` for an agent's own thread. */
  channelForThread?(threadId: string): AgentNotificationChannel | null;
  randomBytes(size: number): Uint8Array;
  now?: () => number;
  logger?: {
    info(message: string, ...values: unknown[]): void;
    warn(message: string, ...values: unknown[]): void;
  };
}

/** What the phone of a member can see. */
interface PushNotificationViewer {
  memberId: string;
  protocol: number;
  capabilities: ReadonlySet<string>;
}

/** The agent and the kind of an event that can notify. */
export interface PushNotificationSubject {
  agentId: string;
  kind: PushNotificationKind;
}

interface HeldEvent {
  event: AgentEvent;
  at: number;
}

interface Registration {
  stored: StoredPushRegistration;
  capabilities: ReadonlySet<string>;
  keys: PushNotificationKeys;
  /** `false` after the connection of the session closed, as when Android stops the app. */
  connected: boolean;
  /** Events that came while the phone looked on screen, oldest first. */
  held: HeldEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Sends a notification to a member's Android phone when an agent that the member can see
 * finishes, fails, cannot start a message, or waits for input, an approval or a browser step, while
 * the app is not on screen.
 * It decides as the desktop does (`notificationForAgentEvent`): the member's level, the agent's own
 * switch, and no notification for a quiet routine run. It sends nothing while a window of the member's
 * desktop app has focus (`desktop-focus-v1`). The agent name and the text are sealed for the phone, so
 * Google sees the token, the time, and sealed bytes only.
 *
 * The phones are kept in a file, so they get notifications after this computer restarts, also when
 * they do not connect again.
 */
export class PushNotificationService {
  readonly #options: PushNotificationOptions;
  readonly #now: () => number;
  readonly #registrations = new Map<string, Registration>();
  readonly #listener = (event: AgentEvent) => {
    this.#releaseAnswered(event);
    Effect.runFork(this.#deliver(event).pipe(Effect.forkIn(this.#scope, { startImmediately: true })));
  };
  #scope = Scope.makeUnsafe();
  #listening = false;
  /** Between `start` and `dispose`. A request that comes later must not save a list without the other phones. */
  #running = false;
  /** Saves finish before `dispose` returns, so the file has the last list. */
  readonly #saves = new Set<Fiber.Fiber<void>>();

  constructor(options: PushNotificationOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Reads the saved phones when the host starts. They count as away until they connect again. */
  start(): void {
    this.#running = true;
    for (const stored of this.#options.store.list()) {
      if (!this.#registrations.has(stored.sessionId)) this.#add(stored, false);
    }
    this.#listen();
  }

  register(sessionId: string, viewer: PushNotificationViewer, target: PushTarget): void {
    // The phone registers again when it connects to the next runtime.
    if (!this.#running) return;
    const { memberId, protocol, capabilities } = viewer;
    const previous = this.#registrations.get(sessionId);
    this.#options.logger?.info("A phone registered for notifications.", {
      away: target.value.away,
      known: previous !== undefined,
    });
    // The request came over the connection of this session, so it is open.
    if (!this.#add({ sessionId, memberId, protocol, capabilities: [...capabilities], ...target }, true, previous)) {
      throw new Error("The notification secret is not valid.");
    }
    const registration = this.#registrations.get(sessionId);
    // The app on screen showed the kept events. A phone that goes away gets those it did not see.
    if (registration && target.value.away) this.#scheduleFlush(registration);
    else if (registration) this.#dropHeld(registration);
    // A phone that signs in again gets a new session. The old one would notify it a second time.
    const token = target.value.token;
    for (const [other, registration] of this.#registrations) {
      if (other !== sessionId && token !== null && registration.stored.value.token === token) {
        this.#registrations.delete(other);
      }
    }
    this.#listen();
    this.#save();
  }

  /** The connection of the session closed. The phone can still come back on the same session. */
  disconnected(sessionId: string): void {
    const registration = this.#registrations.get(sessionId);
    if (!registration) return;
    registration.connected = false;
    this.#options.logger?.info("A phone connection closed.", { away: registration.stored.value.away });
    this.#scheduleFlush(registration);
  }

  /** The path of the session came back, as when the phone app runs again. The app shows events itself. */
  reconnected(sessionId: string): void {
    const registration = this.#registrations.get(sessionId);
    if (!registration) return;
    registration.connected = true;
    if (!registration.stored.value.away) this.#dropHeld(registration);
  }

  /** The phone turned notifications off, signed out, or the session ended. */
  remove(sessionId: string): void {
    const registration = this.#registrations.get(sessionId);
    if (!this.#running || !registration) return;
    this.#dropHeld(registration);
    this.#registrations.delete(sessionId);
    this.#save();
  }

  /** The saved phones stay in the file for the next start. */
  readonly dispose = Effect.fn("PushNotifications.dispose")(function* (this: PushNotificationService) {
    this.#running = false;
    if (this.#listening) this.#options.agents.off("event", this.#listener);
    this.#listening = false;
    for (const registration of this.#registrations.values()) this.#dropHeld(registration);
    this.#registrations.clear();
    yield* Fiber.awaitAll([...this.#saves]);
    yield* Scope.close(this.#scope, Exit.void);
    this.#scope = Scope.makeUnsafe();
  }, Effect.uninterruptible);

  #add(stored: StoredPushRegistration, connected: boolean, previous?: Registration): boolean {
    const secret = decodeNotificationBytes(stored.value.secret);
    if (secret?.length !== NOTIFICATION_SECRET_BYTES) return false;
    if (previous) this.#clearFlush(previous);
    this.#registrations.set(stored.sessionId, {
      stored,
      capabilities: new Set(stored.capabilities),
      keys: pushNotificationKeys(secret),
      connected,
      held: previous?.held ?? [],
      flushTimer: null,
    });
    return true;
  }

  /**
   * Sends `event` to each phone that is away, or only to `only`. A phone that looks on screen keeps
   * the event, because Android can stop the app before it says that it goes away.
   */
  #deliver = Effect.fn("PushNotifications.deliver")(function* (
    this: PushNotificationService,
    event: AgentEvent,
    only?: Registration,
  ) {
    const subject = eventSubject(event);
    if (!subject) return;
    const now = this.#now();
    const targets = (only ? [only] : [...this.#registrations.values()]).filter((registration) => {
      const { value, memberId, protocol, sessionId } = registration.stored;
      const skip = (reason: string) => {
        this.#options.logger?.info("A phone notification was not sent.", {
          reason,
          kind: subject.kind,
          event: event.type,
        });
        return false;
      };
      // While the app is on screen, it shows the event itself.
      if (!value.away && registration.connected) {
        if (!only) this.#hold(registration, event, now);
        return skip("app-on-screen");
      }
      if (value.mutedUntil !== null && value.mutedUntil * 1_000 > now) return skip("muted");
      if (!this.#options.memberActive(memberId)) {
        this.remove(sessionId);
        return skip("member-not-active");
      }
      if (this.#options.hiddenAgentIds(protocol, registration.capabilities, memberId).has(subject.agentId))
        return skip("agent-hidden");
      // A focused desktop window shows the event, and the phone would only repeat it. A desktop app in
      // the background or closed does not keep the phone quiet.
      if (this.#options.desktopFocusedElsewhere(memberId, sessionId)) return skip("desktop-focused");
      if (this.#options.atHostComputer(memberId, event)) return skip("at-host-computer");
      return true;
    });
    if (!targets.length) return;
    const agents = this.#options.agents.listAgents();
    // A prompt, an approval or a takeover on a channel thread names the channel, as on desktop.
    const requestThread = agentEventRequestThread(event);
    const channel = requestThread ? (this.#options.channelForThread?.(requestThread) ?? null) : null;
    let answer: string | null | undefined;
    for (const registration of targets) {
      const { stored } = registration;
      const { value, memberId } = stored;
      const translate = translateFor(resolveLocale("system", value.locale));
      const chosen = this.#options.memberLevels?.(memberId);
      const level = agentNotificationLevel(chosen?.server ?? value.level, chosen?.agents ?? null, subject.agentId);
      // A phone from before channel-attention-v1 has no channel view, so its title names the agent only.
      const eventChannel = registration.capabilities.has(TEAM_CHANNEL_ATTENTION_CAPABILITY) ? channel : null;
      // The fixed text, as the desktop shows it without a preview.
      const fixed = notificationForAgentEvent(event, agents, translate, level, null, eventChannel);
      if (!fixed) {
        this.#options.logger?.info("A phone notification was not sent.", {
          reason: "no-notification-for-event",
          kind: subject.kind,
          level,
          quiet: event.type === "turn-completed" ? (event.quiet ?? false) : null,
          continues: event.type === "turn-completed" ? (event.continues ?? false) : null,
        });
        continue;
      }
      if (value.preview && subject.kind === "reply" && event.type === "turn-completed" && answer === undefined) {
        answer = yield* this.#answer(event, memberId, agents);
      }
      // The desktop builds the same preview: the answer, the question, or the action to approve,
      // with its secrets redacted.
      const notice = value.preview
        ? (notificationForAgentEvent(
            event,
            agents,
            translate,
            level,
            { reply: answer ?? null, redact: redactText },
            eventChannel,
          ) ?? fixed)
        : fixed;
      const content: PushNotificationContent = {
        serverId: value.serverId,
        agentId: notice.agentId,
        threadId: notice.threadId,
        kind: subject.kind,
        title: notice.title,
        body: notice.body,
      };
      // A failed send waits before it goes again, so each send has its own fiber: the other phones
      // do not wait for it.
      yield* this.#send(registration, content, fixed.body).pipe(Effect.forkIn(this.#scope, { startImmediately: true }));
    }
  });

  /** The answer of a turn in the agent's own chat, or `null` when it has none. */
  #answer = Effect.fn("PushNotifications.answer")(function* (
    this: PushNotificationService,
    event: Extract<AgentEvent, { type: "turn-completed" }>,
    memberId: string,
    agents: readonly AgentSummary[],
  ) {
    if (agents.find((agent) => agent.id === event.agentId)?.threadId !== event.threadId) return null;
    const page = yield* this.#options.agents
      .readConversationPageFor(event.agentId, memberId, undefined, ANSWER_PAGE_SIZE)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const text = page ? latestTurnAnswer(page.messages, event.turnId)?.text : undefined;
    // A routine Test run shows the no-update marker in the chat, but it is not news.
    return text && !isNoUpdateAnswer(text) ? text : null;
  });

  #send = Effect.fn("PushNotifications.send")(function* (
    this: PushNotificationService,
    registration: Registration,
    content: PushNotificationContent,
    shortBody: string,
  ) {
    const { stored, keys } = registration;
    let sealed = sealPushNotification(content, keys, this.#options.randomBytes(NOTIFICATION_NONCE_BYTES));
    // A long agent name and a preview of wide characters can pass the 4 KB limit of Apple and Google.
    if (sealed.length > NOTIFICATION_SEALED_LIMIT) {
      const short = { ...content, title: content.title.slice(0, 64), body: shortBody };
      sealed = sealPushNotification(short, keys, this.#options.randomBytes(NOTIFICATION_NONCE_BYTES));
    }
    const request = relayRequest(stored, sealed, Math.floor(this.#now() / 1_000));
    // A short fault at Google refuses one send.
    for (let attempt = 0; ; attempt += 1) {
      const result = yield* Effect.result(this.#options.send(request));
      if (Result.isSuccess(result)) {
        this.#options.logger?.info("A phone notification was given to the push service.", {
          kind: content.kind,
          result: result.success,
          bytes: sealed.length,
        });
        // The app was removed, or Google refused the token.
        if (result.success === "gone" && this.#registrations.get(stored.sessionId) === registration) {
          this.remove(stored.sessionId);
        }
        return;
      }
      const delay = RESEND_DELAYS_MS[attempt];
      if (delay === undefined) {
        this.#options.logger?.warn("Push notification was not sent:", toLogValue(result.failure.cause));
        return;
      }
      yield* Effect.sleep(delay);
      // The phone removed the registration or registered again, and that registration gets the next events.
      if (this.#registrations.get(stored.sessionId) !== registration) return;
    }
  });

  /** Keeps an event for a phone that looks on screen, in case Android stopped it before it said so. */
  #hold(registration: Registration, event: AgentEvent, now: number): void {
    const held = registration.held.filter((item) => now - item.at < HELD_EVENT_MS);
    held.push({ event, at: now });
    registration.held = held.slice(-HELD_EVENT_LIMIT);
  }

  #dropHeld(registration: Registration): void {
    this.#clearFlush(registration);
    registration.held = [];
  }

  #clearFlush(registration: Registration): void {
    if (registration.flushTimer) clearTimeout(registration.flushTimer);
    registration.flushTimer = null;
  }

  /** An answer from any device ends the wait for a request, so a kept notification of it is old. */
  #releaseAnswered(event: AgentEvent): void {
    const answered =
      event.type === "agent-input-resolved" || event.type === "browser-takeover-resolved"
        ? { agentId: event.agentId, requestId: event.requestId }
        : null;
    if (!answered) return;
    for (const registration of this.#registrations.values()) {
      registration.held = registration.held.filter(({ event: held }) => {
        const request = heldRequest(held);
        return !request || request.agentId !== answered.agentId || request.requestId !== answered.requestId;
      });
    }
  }

  /** Sends the kept events of a phone that is away, after a short wait for the phone to say that it is back. */
  #scheduleFlush(registration: Registration): void {
    if (!registration.held.length || registration.flushTimer) return;
    registration.flushTimer = setTimeout(() => {
      registration.flushTimer = null;
      if (this.#registrations.get(registration.stored.sessionId) !== registration) return;
      Effect.runFork(this.#flush(registration).pipe(Effect.forkIn(this.#scope, { startImmediately: true })));
    }, HELD_FLUSH_DELAY_MS);
  }

  #flush = Effect.fn("PushNotifications.flush")(function* (this: PushNotificationService, registration: Registration) {
    const { value, memberId } = registration.stored;
    if (!value.away && registration.connected) return;
    const now = this.#now();
    const held = registration.held.filter((item) => now - item.at < HELD_EVENT_MS);
    registration.held = [];
    if (!held.length) return;
    const snapshot = this.#options.agents.getRuntimeSnapshot();
    const reads = this.#options.agents.listConversationReads(
      memberId,
      markerExclusionsForCapabilities(registration.capabilities),
    );
    const agents = this.#options.agents.listAgents();
    // A phone that said that it goes away over an open connection was on screen until then, so it
    // gets only the events that it surely did not see. After a lost connection, Android can have
    // stopped the app before it showed them, so the events that the host cannot judge go out too.
    const sawScreen = registration.connected;
    for (const { event } of held) {
      const unseen = heldEventUnseen(event, snapshot, reads, agents);
      if (unseen === false || (unseen === null && sawScreen)) continue;
      yield* this.#deliver(event, registration);
    }
  });

  #save(): void {
    const registrations = [...this.#registrations.values()].map((registration) => registration.stored);
    const save = Effect.runFork(
      this.#options.store
        .replace(registrations)
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              this.#options.logger?.warn("Push notification phones were not saved:", toLogValue(error.cause)),
            ),
          ),
        ),
    );
    this.#saves.add(save);
    save.addObserver(() => this.#saves.delete(save));
  }

  #listen(): void {
    if (this.#listening) return;
    this.#options.agents.on("event", this.#listener);
    this.#listening = true;
  }
}

function soundOf(value: StoredPushRegistration["value"]): NotificationSound | null {
  return value.sound === "none" ? null : value.sound;
}

function relayRequest(stored: StoredPushRegistration, sealed: string, timestamp: number): NotificationRelayRequest {
  const { sessionId, value } = stored;
  return { platform: "android", push: { token: value.token, sessionId, sealed, sound: soundOf(value), timestamp } };
}

/**
 * Whether the member still has to see a kept event: the reply in the agent's own chat is unread, the
 * turn still shows as failed, or the request still waits (an answered one left the list when its
 * answer came). `null` when the host cannot know: a reply in another thread, or a message that did
 * not start.
 */
function heldEventUnseen(
  event: AgentEvent,
  snapshot: ReturnType<PushNotificationAgents["getRuntimeSnapshot"]>,
  reads: ReturnType<PushNotificationAgents["listConversationReads"]>,
  agents: readonly AgentSummary[],
): boolean | null {
  if (event.type === "error") return null;
  if (event.type !== "turn-completed") return true;
  if (event.status !== "completed") {
    return snapshot.failedTurns.some((failed) => failed.agentId === event.agentId && failed.turnId === event.turnId);
  }
  // The read state counts the agent's own chat only. A reply in another thread is not known as read.
  if (agents.find((agent) => agent.id === event.agentId)?.threadId !== event.threadId) return null;
  return (reads[event.agentId]?.unreadCount ?? 0) > 0;
}

/** The request that a kept event waits for, or `null` for an event that waits for nothing. */
function heldRequest(event: AgentEvent): { agentId: string; requestId: string | number } | null {
  switch (event.type) {
    case "prompt":
      return { agentId: event.agentId, requestId: event.requestId };
    case "approval":
      return { agentId: event.approval.agentId, requestId: event.approval.requestId };
    case "browser-takeover-requested":
      return { agentId: event.request.agentId, requestId: event.request.requestId };
    default:
      return null;
  }
}

/** The agent and the kind of an event that can notify. `notificationForAgentEvent` decides the rest. */
function eventSubject(event: AgentEvent): PushNotificationSubject | null {
  if (!agentEventCanNotify(event)) return null;
  switch (event.type) {
    case "turn-completed":
      return { agentId: event.agentId, kind: event.status === "completed" ? "reply" : "failed" };
    case "prompt":
      return { agentId: event.agentId, kind: "input" };
    case "approval":
      return { agentId: event.approval.agentId, kind: "approval" };
    case "browser-takeover-requested":
      return { agentId: event.request.agentId, kind: "browser" };
    // A message or a routine run that did not start failed as a turn does.
    case "error":
      return event.agentId ? { agentId: event.agentId, kind: "failed" } : null;
    default:
      return null;
  }
}

export class PushNotificationSendFailure extends Schema.TaggedError<PushNotificationSendFailure>()(
  "PushNotificationSendFailure",
  { cause: Schema.Defect() },
) {}
