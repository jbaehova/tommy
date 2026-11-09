import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { directSessionId } from "@tommy/contracts/direct-connection";
import type {
  AgentEvent,
  AgentTaskReadState,
  BranchAgentTaskInput,
  CentralAuthUser,
  ChannelSummary,
  ConfigureHostInput,
  ConversationMessageSender,
  ConversationPageAnchor,
  HostStatus,
  MarkAgentTaskReadInput,
  MarkConversationReadInput,
  MarkConversationUnreadInput,
  SetTeamTypingInput,
  TeamPresenceSnapshot,
  TeamSessionSummary,
  UpdateHostIdentityInput,
} from "@tommy/contracts/ipc";
import { type AgentAccessLevel, conversationMessageSender, SIGNED_OUT_CHANNEL_MEMBER_ID } from "@tommy/contracts/ipc";
import type { HostRestartState } from "@tommy/contracts/team-protocol/host-update-v1";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger, toLogValue } from "@tommy/logging";
import { Cause, Context, Deferred, Effect, Fiber, Layer, ManagedRuntime, Result } from "effect";
import type { AgentService } from "../backend/agent-service";
import type { ChannelService } from "../backend/channel-service";
import type { AgentAccessStore } from "./agent-access-store";
import { type AgentNotificationLevelStore, OWNER_NOTIFICATION_KEY } from "./agent-notification-level-store";
import { BrowserViewGateway } from "./browser-view-gateway";
import type { DirectDevice, DirectDeviceStore } from "./direct-device-store";
import { DirectHostGateway } from "./direct-host-gateway";
import type { PushNotificationStore } from "./push-notification-store";
import {
  type NotificationRelayRequest,
  PushNotificationSendFailure,
  PushNotificationService,
} from "./push-notifications";
import { RemoteWorkflowError, remoteDecode } from "./remote-service-effects";
import type { ServerAuditStore } from "./server-audit-store";
import { OWNER_PIN_KEY, type SidebarPinStore } from "./sidebar-pin-store";
import type { TeamApiAgentNotificationLevels, TeamApiSidebarPins } from "./team-api/dependencies";
import { TeamApiServer } from "./team-api-server";
import type { TeamIdentity, TeamStore } from "./team-store";

const logger = createTommyLogger("host-service");

interface HostEvents {
  changed: [status: HostStatus];
  presence: [snapshot: TeamPresenceSnapshot];
}

type ForwardedApiOptions = ConstructorParameters<typeof TeamApiServer>[0];

interface HostServiceOptions {
  channels?: ChannelService;
  mcpServers?: ForwardedApiOptions["mcpServers"];
  mcpSignIns?: ForwardedApiOptions["mcpSignIns"];
  signInRelay?: ForwardedApiOptions["signInRelay"];
  vault?: ForwardedApiOptions["vault"];
  providerHostSignIns?: ForwardedApiOptions["providerHostSignIns"];
  providerAccounts?: ForwardedApiOptions["providerAccounts"];
  providerUsageResets?: ForwardedApiOptions["providerUsageResets"];
  providerSignOut?: ForwardedApiOptions["providerSignOut"];
  mcpToolRuntimePreparation?: ForwardedApiOptions["mcpToolRuntimePreparation"];
  storage?: ForwardedApiOptions["storage"];
  machine?: ForwardedApiOptions["machine"];
  events?: ForwardedApiOptions["events"];
  instanceTransfer?: ForwardedApiOptions["instanceTransfer"];
  routineFlows?: ForwardedApiOptions["routineFlows"];
  workflows?: ForwardedApiOptions["workflows"];
  hiddenAgents?: ForwardedApiOptions["hiddenAgents"];
  voice?: ForwardedApiOptions["voice"];
  /** The level that each person chose for each agent (`agent-notification-levels-v1`). */
  agentNotificationLevels?: AgentNotificationLevelStore;
  /** The chats that each person pinned (`sidebar-pins-v1`). */
  sidebarPins?: SidebarPinStore;
  agentAccess?: AgentAccessStore;
  /** Records who joined, left, or got another server role. */
  serverAudit?: Pick<ServerAuditStore, "read" | "record">;
  agentTasks?: ForwardedApiOptions["agentTasks"];
  browserProfiles?: ForwardedApiOptions["browserProfiles"];
  admin?: ForwardedApiOptions["admin"];
  focusUse?: ForwardedApiOptions["focusUse"];
  appVersion: string;
  store: TeamStore;
  agents: ForwardedApiOptions["agents"] & Pick<AgentService, "adoptConversationReads" | "branchTask" | "markTaskRead">;
  agentsReady: NonNullable<ForwardedApiOptions["agentsReady"]>;
  skills: NonNullable<ForwardedApiOptions["skills"]>;
  sidebarLayout: NonNullable<ForwardedApiOptions["sidebarLayout"]>;
  mailbox: ForwardedApiOptions["mailbox"];
  browser: ForwardedApiOptions["browser"];
  logDirectory?: string;
  getSignedInUser: () => CentralAuthUser;
  platform?: "darwin" | "linux";
  unattended?: boolean;
  /** Devices connect straight to this host, with no Signal and no account service. */
  directConnection?: {
    devices: DirectDeviceStore;
    listen: { host: string; port: number };
    /** The address that devices use, such as `https://tommy.example.com`. */
    publicUrl: string | null;
  };
  /** Sends one sealed notification to Firebase. `gone` means the phone gets no more. */
  sendPushNotification?: (
    hostId: string,
    request: NotificationRelayRequest,
  ) => Effect.Effect<"sent" | "gone", RemoteWorkflowError>;
  /** The phones that get notifications, kept for the next start. */
  pushNotificationStore?: PushNotificationStore;
  /** Whether the owner uses the desktop app on this computer now and sees the event there, so the owner's phone stays quiet. */
  hostComputerInUse?: (event: AgentEvent) => boolean;
}

class HostApiRuntime extends Context.Service<
  HostApiRuntime,
  {
    start(): Effect.Effect<number, RemoteWorkflowError>;
  }
>()("tommy/main/HostApiRuntime") {}

export class HostService extends EventEmitter<HostEvents> {
  readonly #options: HostServiceOptions;
  readonly #api: TeamApiServer;
  readonly #runtime: ManagedRuntime.ManagedRuntime<HostApiRuntime, never>;
  readonly #operations = new Set<Deferred.Deferred<void>>();
  #shutdown: Deferred.Deferred<void, RemoteWorkflowError> | null = null;
  readonly #browserView: BrowserViewGateway;
  #lastBrowserViewInputAt: number | null = null;
  readonly #directGateway: DirectHostGateway | null;
  readonly #pushNotifications: PushNotificationService | undefined;
  #status: HostStatus;
  #runtimeGeneration = 0;
  #startOperation: Fiber.Fiber<HostStatus, RemoteWorkflowError> | null = null;
  #webRtcOnline = false;
  /** `undefined` until the account service first reports, so the first report always binds. */
  #boundAccountId: string | null | undefined = undefined;

  constructor(options: HostServiceOptions) {
    super();
    this.#options = options;
    this.#status = initialHostStatus(options.store.getIdentity());
    this.#browserView = new BrowserViewGateway({
      browser: options.browser,
      authenticate: (token) => options.store.authenticate(token),
      onInput: () => {
        this.#lastBrowserViewInputAt = Date.now();
      },
    });
    const sendPushNotification = options.sendPushNotification;
    const pushNotificationStore = options.pushNotificationStore;
    this.#pushNotifications =
      sendPushNotification && pushNotificationStore
        ? new PushNotificationService({
            agents: options.agents,
            store: pushNotificationStore,
            send: (request) => {
              const hostId = options.store.getIdentity()?.serverId;
              if (!hostId)
                return Effect.fail(
                  new PushNotificationSendFailure({
                    cause: new Error(sourceText("error.auth.hostCredentialUnavailable")),
                  }),
                );
              return sendPushNotification(hostId, request).pipe(
                Effect.mapError(({ cause }) => new PushNotificationSendFailure({ cause })),
              );
            },
            // The Team API server is made below. A notification reads it when it is sent.
            hiddenAgentIds: (protocol, capabilities, memberId) =>
              this.#api.hiddenAgentIds(protocol, capabilities, memberId),
            randomBytes: (size) => new Uint8Array(randomBytes(size)),
            memberActive: (memberId) => {
              const member = options.store.getMember(memberId);
              return member !== null && !member.disabled;
            },
            desktopFocusedElsewhere: (memberId, sessionId) =>
              this.#api.memberDesktopFocusedElsewhere(memberId, sessionId),
            // The desktop app of this computer runs as the owner.
            atHostComputer: (memberId, event) =>
              memberId === options.store.getOwnerMemberId() && (options.hostComputerInUse?.(event) ?? false),
            memberLevels: (memberId) => {
              const key = this.#notificationKey(memberId);
              return {
                server: options.agentNotificationLevels?.serverLevel(key) ?? null,
                agents: options.agentNotificationLevels?.levels(key) ?? new Map(),
              };
            },
            channelForThread: (threadId) => this.channelForThread(threadId),
            logger,
          })
        : undefined;
    this.#api = new TeamApiServer({
      appVersion: options.appVersion,
      store: options.store,
      agents: options.agents,
      agentsReady: options.agentsReady,
      ...(options.channels === undefined ? {} : { channels: options.channels }),
      ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
      ...(options.mcpSignIns === undefined ? {} : { mcpSignIns: options.mcpSignIns }),
      ...(options.signInRelay === undefined ? {} : { signInRelay: options.signInRelay }),
      ...(options.vault === undefined ? {} : { vault: options.vault }),
      ...(options.providerHostSignIns === undefined ? {} : { providerHostSignIns: options.providerHostSignIns }),
      ...(options.providerAccounts === undefined ? {} : { providerAccounts: options.providerAccounts }),
      ...(options.providerUsageResets === undefined ? {} : { providerUsageResets: options.providerUsageResets }),
      ...(options.providerSignOut === undefined ? {} : { providerSignOut: options.providerSignOut }),
      ...(options.mcpToolRuntimePreparation === undefined
        ? {}
        : { mcpToolRuntimePreparation: options.mcpToolRuntimePreparation }),
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      ...(options.machine === undefined ? {} : { machine: options.machine }),
      ...(options.events === undefined ? {} : { events: options.events }),
      ...(options.instanceTransfer === undefined ? {} : { instanceTransfer: options.instanceTransfer }),
      ...(options.routineFlows === undefined ? {} : { routineFlows: options.routineFlows }),
      ...(options.workflows === undefined ? {} : { workflows: options.workflows }),
      ...(options.hiddenAgents === undefined ? {} : { hiddenAgents: options.hiddenAgents }),
      ...(options.voice === undefined ? {} : { voice: options.voice }),
      ...(options.agentNotificationLevels === undefined
        ? {}
        : { agentNotificationLevels: this.#agentNotificationLevels(options.agentNotificationLevels) }),
      ...(options.sidebarPins === undefined ? {} : { sidebarPins: this.#sidebarPins(options.sidebarPins) }),
      ...(options.agentAccess === undefined ? {} : { agentAccess: options.agentAccess }),
      ...(options.serverAudit === undefined ? {} : { serverAudit: options.serverAudit }),
      ...(options.agentTasks === undefined ? {} : { agentTasks: options.agentTasks }),
      ...(options.browserProfiles === undefined ? {} : { browserProfiles: options.browserProfiles }),
      admin: {
        ...options.admin,
        identity: { updateIdentity: (input) => this.updateIdentity(input).pipe(Effect.asVoid) },
        ...(options.directConnection === undefined
          ? {}
          : {
              devices: {
                list: () => this.listDirectDevices(),
                createPairingCode: () => this.createPairingCode(),
                revoke: (deviceId: string) => this.revokeDirectDevice(deviceId),
              },
            }),
      },
      skills: options.skills,
      sidebarLayout: options.sidebarLayout,
      mailbox: options.mailbox,
      browser: options.browser,
      browserView: this.#browserView,
      onPresence: (snapshot) => this.emit("presence", snapshot),
      onSessionRevoked: (sessionId) => this.#revokeDeviceSession(sessionId),
      ...(this.#pushNotifications === undefined ? {} : { pushNotifications: this.#pushNotifications }),
      ...(options.focusUse === undefined ? {} : { focusUse: options.focusUse }),
    });
    this.#runtime = ManagedRuntime.make(
      Layer.succeed(
        HostApiRuntime,
        HostApiRuntime.of({
          // The saved phones get notifications again once the API runs, also before they connect.
          start: () => this.#api.start().pipe(Effect.tap(() => Effect.sync(() => this.#pushNotifications?.start()))),
        }),
      ),
    );
    const closeSession = (sessionId: string) =>
      Effect.gen({ self: this }, function* () {
        this.#pushNotifications?.remove(sessionId);
        yield* this.#browserView.revokeTeamSession(sessionId);
        this.#options.browser.releaseUserControlHeldBy({ kind: "session", sessionId });
      });
    const pathChanged = (sessionId: string, lost: boolean) => {
      if (lost) this.#pushNotifications?.disconnected(sessionId);
      else this.#pushNotifications?.reconnected(sessionId);
    };
    this.#directGateway = options.directConnection
      ? new DirectHostGateway({
          store: options.store,
          appVersion: options.appVersion,
          transferDirectory: join(options.logDirectory ?? ".tommy-remote", "transfers"),
          closeSession,
          pathChanged,
          devices: options.directConnection.devices,
          listen: options.directConnection.listen,
          owner: () => {
            const membershipId = options.store.getOwnerMemberId();
            return membershipId ? { membershipId, userId: options.getSignedInUser().id } : null;
          },
        })
      : null;
  }

  /** A one-time code that pairs one device with this host, or null without the direct connection. */
  createPairingCode(): { code: string; expiresAt: number; publicUrl: string | null } | null {
    const direct = this.#options.directConnection;
    return direct ? { ...direct.devices.createPairingCode(), publicUrl: direct.publicUrl } : null;
  }

  listDirectDevices(): readonly DirectDevice[] {
    return this.#options.directConnection?.devices.list() ?? [];
  }

  /** Removes a paired device, closes its connection and stops its phone notifications. */
  readonly revokeDirectDevice = Effect.fn("HostService.revokeDirectDevice")(function* (
    this: HostService,
    deviceId: string,
  ) {
    this.#pushNotifications?.remove(directSessionId(deviceId));
    if (this.#directGateway) yield* this.#directGateway.revokeDevice(deviceId);
  }).bind(this);

  /** Applies a changed network route to the devices that are connected now. */
  readonly applyNetworkRoute = Effect.fn("HostService.applyNetworkRoute")(function* (this: HostService) {}).bind(this);

  getStatus(): HostStatus {
    return this.#status;
  }

  /**
   * Why the Team host half of this instance must not restart right now. A session still
   * connecting never blocks: only a connected stream, a live browser view, or a moving file
   * transfer holds the restart. Agent work is reported by AgentService, not here.
   */
  describeRestartBlockers(): string[] {
    const reasons: string[] = [];
    if (this.#browserView.activeViewCount() > 0) reasons.push("browser-view");
    if (this.#directGateway?.hasActiveTransfers()) reasons.push("file-transfer");
    return reasons;
  }

  /**
   * Binds the host to the signed-in account, or unbinds it on sign-out. The status is
   * rebuilt from the newly active identity rather than patched, so a second account can
   * never inherit the first one's server name, id or launch preference.
   */
  /**
   * The synchronous half of an account change, for callers that announce the new account
   * before `applySignedInAccount` can finish: it stops this host answering for the previous
   * one right away. A process that has not applied an account yet is left alone - that is
   * startup reporting the account the file was already loaded for.
   */
  unbindChangedAccount(user: CentralAuthUser | null): void {
    const nextAccountId = user?.id ?? null;
    if (this.#boundAccountId === undefined || this.#boundAccountId === nextAccountId) return;
    if (!this.#options.store.configured) return;
    // A start still in flight belongs to the account on its way out. Bumping here rather
    // than waiting for the queued `applySignedInAccount` is what stops it reporting the
    // previous host online - or its failure as an error - on the new account's status.
    this.#runtimeGeneration += 1;
    this.#options.store.unbindActiveHost();
    this.#status = initialHostStatus(null);
    this.emit("changed", this.getStatus());
  }

  readonly applySignedInAccount = Effect.fn("HostService.applySignedInAccount")(
    function* (this: HostService, user: CentralAuthUser | null): Effect.fn.Return<void, RemoteWorkflowError> {
      const nextAccountId = user?.id ?? null;
      // `unbindChangedAccount` may have cleared the store since this account was bound, to
      // stop it answering for an account that was on its way out. Reporting the same account
      // again then has to activate it, not take it for the host that is already running.
      const stillBound = this.#options.store.configured || nextAccountId === null;
      if (this.#boundAccountId === nextAccountId && stillBound) {
        // The same account, reported again - a renamed profile or a new avatar. Rebinding
        // here would stop a host that is happily online.
        if (user && this.#options.store.configured && (yield* this.#options.store.syncAccount(user))) {
          this.#api.refreshPresence();
        }
        return;
      }
      const previousServerId = this.#status.serverId;
      if (this.#boundAccountId !== undefined) {
        this.#runtimeGeneration += 1;
        // The same three steps as `stop`, and for the same reason: a start still in flight
        // belongs to the previous account. The bumped generation makes it abort at its next
        // checkpoint, and draining it here is what stops `start()` from handing the new
        // account that superseded operation instead of starting its own host. Each step is
        // attempted on its own, so a gateway that will not come down cannot skip the drain.
        yield* this.#attemptTeardown(this.#stopRuntime());
        yield* this.#attemptTeardown(this.#startOperation ? Fiber.join(this.#startOperation) : Effect.void);
        yield* this.#attemptTeardown(this.#stopRuntime());
      }
      let activated = false;
      return yield* Effect.gen({ self: this }, function* () {
        if (user && this.#signedInAccountId() !== user.id) {
          // Another account was announced while the runtime was being torn down. Binding this
          // one now would hand its host, members and invitations to whoever is signed in
          // instead - and the switch queued for them is what binds theirs.
          return;
        }
        if (user) yield* this.#options.store.activateAccount(user);
        else yield* this.#options.store.deactivate();
        activated = true;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            // Publish even when activation failed. The previous account is gone either way, and a
            // status still naming its host would offer the rail a server this process can no
            // longer answer for - the store has already unbound it.
            //
            // A failure leaves the binding unknown rather than recorded, so the next report of the
            // same account runs activation again instead of short-circuiting into an unconfigured
            // store the user cannot get out of without restarting.
            this.#boundAccountId = activated ? nextAccountId : undefined;
            this.#publishActiveHost(previousServerId);
          }),
        ),
      );
    },
    (operation) => this.#provide(operation),
  ).bind(this);

  #publishActiveHost(previousServerId: string | null): void {
    const identity = this.#options.store.getIdentity();
    if (identity && identity.serverId === previousServerId) {
      // The host this process started with, now confirmed as this account's. Keep the
      // status the constructor already published rather than resetting a live runtime.
      this.#setStatus({
        configured: true,
        serverName: identity.serverName,
        logoUrl: identity.logoVersion ? serverLogoUrl(identity.logoVersion) : null,
        enabledOnLaunch: identity.enabledOnLaunch,
      });
    } else {
      this.#status = initialHostStatus(identity);
      this.emit("changed", this.getStatus());
    }
    if (identity) {
      this.#api.refreshPresence();
      this.#api.refreshIdentity();
    }
  }

  readonly configure = Effect.fn("HostService.configure")(
    function* (this: HostService, input: ConfigureHostInput): Effect.fn.Return<HostStatus, RemoteWorkflowError> {
      const account = yield* remoteDecode(() => this.#options.getSignedInUser());
      const identity = yield* this.#options.store.configureWithAccount(input.serverName, account, input.logo);
      // Nothing is bound while the first host is being written, so neither the store's
      // `activeAccountId` nor `unbindChangedAccount` can see a switch announced during the
      // write. Central authentication has the new account the moment it is announced, which
      // is what the renderer was told, so that is what this is checked against.
      if (this.#signedInAccountId() !== account.id) {
        // The store bound the host as it created it, and refusing the call is not enough on
        // its own: the members and identity behind it would still answer the new account.
        this.#options.store.unbindActiveHost();
        this.#status = initialHostStatus(null);
        this.emit("changed", this.getStatus());
        return yield* new RemoteWorkflowError({
          cause: new Error(sourceText("error.team.accountChangedDuringCreate")),
        });
      }
      // The store checked the account before it resolved; the switch can still land between
      // there and here, and publishing then would show A's server to B.
      if (!this.#isActiveHost(identity.serverId)) return this.getStatus();
      this.#setStatus({
        phase: "idle",
        configured: true,
        serverId: identity.serverId,
        serverName: identity.serverName,
        logoUrl: identity.logoVersion ? serverLogoUrl(identity.logoVersion) : null,
        enabledOnLaunch: false,
        message: null,
      });
      this.#api.refreshPresence();
      this.#api.refreshIdentity();
      this.#setStatus({ apiUrl: null, message: sourceText("status.host.registered") });
      return this.getStatus();
    },
    (operation) => this.#provide(operation),
  ).bind(this);

  readonly updateIdentity = Effect.fn("HostService.updateIdentity")(
    function* (this: HostService, input: UpdateHostIdentityInput): Effect.fn.Return<HostStatus, RemoteWorkflowError> {
      yield* remoteDecode(() => this.#options.store.assertOwnerAccount(this.#options.getSignedInUser()));
      const identity = yield* this.#options.store.updateIdentity(input);
      // Before anything is published: the store checked the account before it resolved, and a
      // switch landing in this gap would show the previous account's name and logo.
      if (!this.#isActiveHost(identity.serverId)) return this.getStatus();
      this.#setStatus({
        serverName: identity.serverName,
        logoUrl: identity.logoVersion ? serverLogoUrl(identity.logoVersion) : null,
        message: sourceText("status.host.identityUpdated"),
      });
      this.#api.refreshIdentity();
      return this.getStatus();
    },
    (operation) => this.#provide(operation),
  ).bind(this);

  /**
   * Every remote step runs under the signed-in account's authentication, so one that started
   * for a host the account no longer has would register or upload on the wrong account's
   * behalf. The store's own guards stop the local half; this stops the network half.
   */
  /** The account central authentication has announced, or none while signed out. */
  #signedInAccountId(): string | null {
    try {
      return this.#options.getSignedInUser().id;
    } catch {
      return null;
    }
  }

  #isActiveHost(serverId: string): boolean {
    return this.#options.store.getIdentity()?.serverId === serverId;
  }

  readonly start = Effect.fn("HostService.start")(function* (this: HostService) {
    if (this.#startOperation) return yield* Fiber.join(this.#startOperation);
    const operation = yield* Effect.forkIn(this.#provide(this.#startRuntimeOperation()), this.#runtime.scope, {
      startImmediately: false,
    });
    this.#startOperation = operation;
    operation.addObserver(() => {
      if (this.#startOperation === operation) this.#startOperation = null;
    });
    return yield* Fiber.join(operation);
  }).bind(this);

  readonly #startRuntimeOperation = Effect.fn("HostService.startRuntimeOperation")(function* (
    this: HostService,
  ): Effect.fn.Return<HostStatus, RemoteWorkflowError, HostApiRuntime> {
    const gateway = this.#directGateway;
    if (!gateway)
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.host.webRtcNotConfigured")) });
    if (!this.#options.store.configured)
      return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.host.nameBeforePublish")) });
    if ((this.#status.phase === "online" && this.#webRtcOnline) || this.#status.phase === "starting") {
      return this.getStatus();
    }
    if (this.#status.phase === "stopping") return this.getStatus();
    const generation = ++this.#runtimeGeneration;
    const signedInUser = yield* remoteDecode(() => this.#options.getSignedInUser());
    yield* remoteDecode(() => this.#options.store.assertOwnerAccount(signedInUser));
    if (yield* this.#options.store.syncAccount(signedInUser)) this.#api.refreshPresence();
    this.#setStatus({ phase: "starting", message: sourceText("status.host.starting") });

    const attempt1 = yield* Effect.gen({ self: this }, function* () {
      const apiPort = yield* HostApiRuntime.use((api) => api.start());
      if (yield* this.#cancelSupersededStartEffect(generation)) return this.getStatus();
      const identity = this.#options.store.getIdentity();
      if (!identity)
        return yield* new RemoteWorkflowError({ cause: new Error(sourceText("error.host.nameBeforePublish")) });
      yield* gateway.start({ hostId: identity.serverId, localApiPort: apiPort });
      this.#webRtcOnline = true;
      if (yield* this.#cancelSupersededStartEffect(generation)) return this.getStatus();
      this.#setStatus({
        apiUrl: this.#options.directConnection?.publicUrl ?? null,
        apiOnline: true,
        message: sourceText("status.host.ready"),
      });
      yield* this.#options.store.setEnabledOnLaunch(identity.serverId, true);
      if (yield* this.#cancelSupersededStartEffect(generation)) return this.getStatus();
      this.#setStatus({ phase: "online", enabledOnLaunch: true });
    }).pipe(Effect.result);
    if (Result.isFailure(attempt1)) {
      const error = attempt1.failure.cause;
      if (generation !== this.#runtimeGeneration) {
        yield* this.#stopRuntime();
        return this.getStatus();
      }
      yield* this.#stopRuntime();
      this.#setStatus({
        phase: "error",
        apiOnline: false,
        apiUrl: null,
        message: error instanceof Error ? error.message : sourceText("error.host.publishFailed"),
      });
    } else if (attempt1.success !== undefined) return attempt1.success;
    return this.getStatus();
  });

  readonly stop = Effect.fn("HostService.stop")(
    function* (this: HostService, persistPreference = true): Effect.fn.Return<HostStatus, RemoteWorkflowError> {
      if (this.#status.phase === "unconfigured") return this.getStatus();
      const serverId = this.#options.store.getIdentity()?.serverId;
      this.#runtimeGeneration += 1;
      if (persistPreference)
        yield* remoteDecode(() => this.#options.store.assertOwnerAccount(this.#options.getSignedInUser()));
      this.#setStatus({ phase: "stopping", message: sourceText("status.host.stopping") });
      yield* this.#stopRuntime();
      if (this.#startOperation) yield* Fiber.join(this.#startOperation);
      yield* this.#stopRuntime();
      // The awaits above can outlive this host. An account switch in between makes both the
      // preference and the status below the previous account's, and the account that just
      // became active already has its own status from `applySignedInAccount`.
      if (this.#options.store.getIdentity()?.serverId !== serverId) return this.getStatus();
      if (persistPreference && serverId) yield* this.#options.store.setEnabledOnLaunch(serverId, false);
      this.#setStatus({
        phase: "idle",
        enabledOnLaunch: persistPreference ? false : this.#status.enabledOnLaunch,
        apiUrl: null,
        apiOnline: false,
        message: sourceText("status.host.private"),
      });
      return this.getStatus();
    },
    (operation, _persistPreference?: boolean) => this.#provide(operation),
  ).bind(this);

  listMembers() {
    return Effect.sync(() => this.#options.store.listMembers());
  }

  getPresence(): TeamPresenceSnapshot {
    return this.#api.getPresence();
  }

  connectedClientCount(): number {
    return this.#api.connectedClientCount();
  }

  /** The last request that changed data, typing, or input in a browser view. */
  lastClientUseAt(): number | null {
    const request = this.#api.lastClientUseAt();
    const view = this.#lastBrowserViewInputAt;
    if (request === null || view === null) return request ?? view;
    return Math.max(request, view);
  }

  announceRestart(state: HostRestartState, version: string | null): void {
    this.#api.announceHostRestart(state, version);
  }

  setTyping(input: SetTeamTypingInput): void {
    this.#api.setLocalTyping(input.agentId, input.typing);
  }

  readAgentConversation(agentId: string) {
    return remoteDecode(() => this.#currentAgentReaderId()).pipe(
      Effect.flatMap((readerId) => this.#options.agents.readConversationFor(agentId, readerId)),
    );
  }

  readAgentConversationPage(agentId: string, anchor: ConversationPageAnchor = { type: "latest" }, limit = 50) {
    return remoteDecode(() => this.#currentAgentReaderId()).pipe(
      Effect.flatMap((readerId) => this.#options.agents.readConversationPageFor(agentId, readerId, anchor, limit)),
    );
  }

  searchAgentConversationMessages(
    query: string,
    agentId?: string,
    cursor?: string,
    limit = 100,
    includeSideThreads = false,
  ) {
    return this.#options.agents.searchConversationMessages(query, agentId, cursor, limit, includeSideThreads);
  }

  searchAgentConversationFiles(query: string, cursor?: string, limit = 50) {
    return this.#options.agents.searchConversationFiles(query, cursor, limit);
  }

  listAgentConversationReads() {
    return this.#options.agents.listConversationReads(this.#currentAgentReaderId());
  }

  markAgentConversationRead(input: MarkConversationReadInput) {
    return remoteDecode(() => this.#currentAgentReaderId()).pipe(
      Effect.flatMap((readerId) =>
        this.#options.agents.markConversationRead(input.agentId, readerId, input.throughMessageId),
      ),
    );
  }

  markAgentConversationUnread(input: MarkConversationUnreadInput) {
    return remoteDecode(() => this.#currentAgentReaderId()).pipe(
      Effect.flatMap((readerId) =>
        this.#options.agents.markConversationUnread(input.agentId, readerId, input.fromMessageId),
      ),
    );
  }

  /** Makes a branch of a local conversation. This computer's reader has read the branch through its last copied message. */
  branchAgentTask(input: BranchAgentTaskInput) {
    return remoteDecode(() => this.#currentAgentReaderId()).pipe(
      Effect.flatMap((readerId) => this.#options.agents.branchTask(input, readerId)),
    );
  }

  /** Moves this computer's reader's mark of a side thread, the mark that the member's other devices read. */
  markAgentTaskRead(input: MarkAgentTaskReadInput): AgentTaskReadState {
    return this.#options.agents.markTaskRead(input, this.#currentAgentReaderId());
  }

  listSessions(): TeamSessionSummary[] {
    return this.#options.store.listSessions();
  }

  /** Gives a duplicated agent the levels of its source agent. */
  copyAgentAccess(sourceAgentId: string, agentId: string): Effect.Effect<void> {
    return this.#api.copyAgentAccess(sourceAgentId, agentId);
  }

  /** The key of a member's agent notification levels. The owner shares them with the desktop app of this computer. */
  #notificationKey(memberId: string): string {
    return memberId === this.#options.store.getOwnerMemberId() ? OWNER_NOTIFICATION_KEY : memberId;
  }

  #agentNotificationLevels(store: AgentNotificationLevelStore): TeamApiAgentNotificationLevels {
    return {
      snapshot: (memberId, hidden) => store.snapshot(this.#notificationKey(memberId), hidden),
      set: (memberId, input) => store.set(this.#notificationKey(memberId), input),
      setServer: (memberId, level) => store.setServer(this.#notificationKey(memberId), level),
      subscribe: (listener) =>
        store.subscribe((key) => {
          // The owner's levels have one key for the desktop app of this computer and the owner's phones.
          const memberId = key === OWNER_NOTIFICATION_KEY ? this.#options.store.getOwnerMemberId() : key;
          if (memberId) listener(memberId);
        }),
    };
  }

  /** The key of a member's pins. The owner shares them with the desktop app of this computer. */
  #sidebarPinKey(memberId: string): string {
    return memberId === this.#options.store.getOwnerMemberId() ? OWNER_PIN_KEY : memberId;
  }

  #sidebarPins(store: SidebarPinStore): TeamApiSidebarPins {
    return {
      snapshot: (memberId, hidden) => store.snapshot(this.#sidebarPinKey(memberId), hidden),
      set: (memberId, items, hidden) => store.set(this.#sidebarPinKey(memberId), items, hidden),
      seed: (memberId, items, hidden) => store.seed(this.#sidebarPinKey(memberId), items, hidden),
      subscribe: (listener) =>
        store.subscribe((key) => {
          // The owner's pins have one key for the desktop app of this computer and the owner's phones.
          const memberId = key === OWNER_PIN_KEY ? this.#options.store.getOwnerMemberId() : key;
          if (memberId) listener(memberId);
        }),
    };
  }

  readonly #revokeDeviceSession = Effect.fn("HostService.revokeDeviceSession")(function* (
    this: HostService,
    sessionId: string,
  ): Effect.fn.Return<void, RemoteWorkflowError> {
    this.#pushNotifications?.remove(sessionId);
    if (this.#directGateway) yield* this.#directGateway.revokeSession(sessionId);
  });

  readonly revokeSession = Effect.fn("HostService.revokeSession")(
    function* (this: HostService, sessionId: string): Effect.fn.Return<void, RemoteWorkflowError> {
      yield* this.#revokeDeviceSession(sessionId);
      yield* this.#options.store.revokeSession(sessionId);
      yield* this.#browserView.revokeTeamSession(sessionId);
      this.#options.browser.releaseUserControlHeldBy({ kind: "session", sessionId });
      this.#api.refreshPresence();
    },
    (operation) => this.#provide(operation),
  ).bind(this);

  #provide<A>(operation: Effect.Effect<A, RemoteWorkflowError, HostApiRuntime>): Effect.Effect<A, RemoteWorkflowError> {
    return Effect.suspend(() => {
      const completed = Deferred.makeUnsafe<void>();
      this.#operations.add(completed);
      return Effect.flatMap(this.#runtime.contextEffect, (context) =>
        operation.pipe(Effect.provideContext(context)),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.#operations.delete(completed);
            Deferred.doneUnsafe(completed, Effect.void);
          }),
        ),
      );
    });
  }

  readonly shutdown = Effect.fn("HostService.shutdown")(function* (this: HostService) {
    if (this.#shutdown) return yield* Deferred.await(this.#shutdown);
    const stopped = Deferred.makeUnsafe<void, RemoteWorkflowError>();
    this.#shutdown = stopped;
    return yield* Effect.acquireUseRelease(
      Effect.void,
      () => this.stop(false).pipe(Effect.asVoid),
      () =>
        Effect.acquireUseRelease(
          Effect.void,
          () =>
            Effect.all([this.#directGateway?.stop() ?? Effect.void], {
              concurrency: "unbounded",
              discard: true,
            }),
          () =>
            Effect.gen({ self: this }, function* () {
              while (this.#operations.size > 0) {
                yield* Effect.all([...this.#operations].map(Deferred.await), { concurrency: "unbounded" });
              }
              yield* this.#runtime.disposeEffect;
            }),
        ),
    ).pipe(Effect.onExit((exit) => Effect.sync(() => Deferred.doneUnsafe(stopped, exit))));
  }, Effect.uninterruptible).bind(this);

  /** Keep later teardown steps running so an account switch cannot retain the old listener. */
  #attemptTeardown<A>(step: Effect.Effect<A, RemoteWorkflowError>): Effect.Effect<void> {
    return step.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          logger.error("Unable to stop the host runtime while switching accounts:", toLogValue(Cause.squash(cause)));
        }),
      ),
    );
  }

  readonly #stopRuntime = Effect.fn("HostService.stopRuntime")(function* (this: HostService) {
    this.#webRtcOnline = false;
    // The phones register again when they connect to the next runtime. The saved notification
    // phones are read again when it starts.
    const pendingPushes = yield* Effect.forkChild(this.#pushNotifications?.dispose() ?? Effect.void);
    return yield* Effect.acquireUseRelease(
      Effect.void,
      () => this.#directGateway?.stop() ?? Effect.void,
      () => this.#api.stop().pipe(Effect.ensuring(Fiber.await(pendingPushes))),
    );
  }, Effect.uninterruptible);

  readonly #cancelSupersededStartEffect = Effect.fn("HostService.cancelSupersededStart")(function* (
    this: HostService,
    generation: number,
  ): Effect.fn.Return<boolean, RemoteWorkflowError> {
    if (generation === this.#runtimeGeneration) return false;
    yield* this.#stopRuntime();
    return true;
  });

  #setStatus(patch: Partial<HostStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.emit("changed", this.getStatus());
  }

  channelActor(): { id: string; name: string } {
    let user: CentralAuthUser;
    try {
      user = this.#options.getSignedInUser();
    } catch {
      return { id: SIGNED_OUT_CHANNEL_MEMBER_ID, name: "You" };
    }
    return { id: this.#currentAgentReaderId(), name: user.name ?? "You" };
  }

  /**
   * The level of `personId`, who asked a channel member to add or remove `agentId`, for that agent:
   * the level their own save through the Team API has. This computer's user manages every agent. A
   * person who is no longer an active member of the team has none.
   */
  channelPersonAgentLevel(personId: string, agentId: string): AgentAccessLevel {
    if (!this.channelPersonIsRemote(personId)) return "manage";
    const member = this.#options.store.getMember(personId);
    if (!member || member.disabled) return "none";
    return this.#api.agentLevel(member, agentId);
  }

  /**
   * Whether `personId`, who wrote a channel request, is someone other than this computer's user: a
   * team member, whose app has only what the Team API gives it.
   */
  channelPersonIsRemote(personId: string): boolean {
    if (personId === SIGNED_OUT_CHANNEL_MEMBER_ID || personId === this.#findCurrentMemberId()) return false;
    try {
      return personId !== `local-user:${this.#options.getSignedInUser().id}`;
    } catch {
      // Signed out: the person is a team member or nobody this computer knows.
      return true;
    }
  }

  /** The channel list as the host user reads it, as the IPC list does. Empty without channels. */
  listChannels(): ChannelSummary[] {
    return this.#options.channels?.store.list(this.channelActor().id, true) ?? [];
  }

  /** The channel whose execution thread `threadId` is, or null for an agent's own thread. */
  channelForThread(threadId: string): { id: string; name: string } | null {
    const store = this.#options.channels?.store;
    const channelId = store?.channelForThread(threadId);
    return store && channelId ? { id: channelId, name: store.get(channelId).name } : null;
  }

  /**
   * The host user as the sender of an agent message. Signed out there is none: a message with no
   * sender is the reader's own, and the signed-out id would name this person as someone else to the
   * members of a team they host later.
   */
  conversationSender(): ConversationMessageSender | undefined {
    let user: CentralAuthUser;
    try {
      user = this.#options.getSignedInUser();
    } catch {
      return undefined;
    }
    return conversationMessageSender(this.#currentAgentReaderId(), user.name?.trim() || user.email);
  }

  #currentAgentReaderId(): string {
    const accountReaderId = `local-user:${this.#options.getSignedInUser().id}`;
    const memberId = this.#findCurrentMemberId();
    // Channel reads are keyed by the reader id this method answers, so they adopt with it.
    if (!memberId) {
      this.#options.channels?.store.adoptReads(SIGNED_OUT_CHANNEL_MEMBER_ID, accountReaderId);
      return accountReaderId;
    }
    this.#options.agents.adoptConversationReads(accountReaderId, memberId);
    this.#options.channels?.store.adoptReads(accountReaderId, memberId);
    this.#options.channels?.store.adoptReads(SIGNED_OUT_CHANNEL_MEMBER_ID, memberId);
    return memberId;
  }

  #findCurrentMemberId(): string | null {
    try {
      const email = this.#options.getSignedInUser().email.trim().toLowerCase();
      const member = this.#options.store
        .listMembers()
        .find(
          (candidate) =>
            candidate.email?.trim().toLowerCase() === email || candidate.username.trim().toLowerCase() === email,
        );
      return member && !member.disabled ? member.id : null;
    } catch {
      return null;
    }
  }
}

function initialHostStatus(identity: TeamIdentity | null): HostStatus {
  return {
    phase: identity ? "idle" : "unconfigured",
    configured: Boolean(identity),
    enabledOnLaunch: identity?.enabledOnLaunch ?? false,
    serverId: identity?.serverId ?? null,
    serverName: identity?.serverName ?? null,
    logoUrl: identity?.logoVersion ? serverLogoUrl(identity.logoVersion) : null,
    apiUrl: null,
    apiOnline: false,
    message: null,
  };
}

function serverLogoUrl(version: string): string {
  return `tommy-server-logo://local/logo?v=${encodeURIComponent(version)}`;
}
