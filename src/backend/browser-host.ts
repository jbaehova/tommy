import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { basename, extname, join } from "node:path";
import type { BrowserProfileProxyConnection } from "@tommy/contracts/browser-profile-proxy";
import { INPUT_LIMITS } from "@tommy/contracts/input-limits";
import type {
  AgentBrowserProfile,
  BrowserElement,
  BrowserEnvironment,
  BrowserImageMode,
  BrowserJsonValue,
  BrowserNavigationDirection,
  BrowserPreview,
  BrowserSecretRequest,
  BrowserSnapshot,
  BrowserTab,
  BrowserTarget,
} from "@tommy/contracts/ipc";
import { isNumber, isString } from "@tommy/contracts/runtime-values";
import { sourceText } from "@tommy/i18n/source";
import { createTommyLogger, redactText, toLogValue } from "@tommy/logging";
import { Deferred, Effect, Exit, Fiber, Option, Result, Scope, Semaphore } from "effect";
import {
  app,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type Event as ElectronEvent,
  type NativeImage,
  nativeImage,
  type Session,
  session,
  type WebContents,
  WebContentsView,
  type WebContentsWillFrameNavigateEventParams,
} from "electron";
import { writeJsonFileAtomically } from "./atomic-json-file";
import type { BrowserCardFillResult } from "./browser-card-fill";
import { BrowserCdpEngine, type BrowserUploadAssignment, type SnapshotReadResult } from "./browser-cdp";
import { refuseCookieBanners, stopCookieBanners } from "./browser-consent";
import { BrowserControlSessions } from "./browser-control-sessions";
import { BrowserDiagnostics } from "./browser-diagnostics";
import { type BrowserOperationError, browserCall, browserFailure, browserSync } from "./browser-effects";
import {
  type BrowserHostTab,
  type BrowserPreviewPage,
  currentTabUrl,
  hasHistoryEntry,
  type KeepQueueBlocked,
  toPublicTab,
} from "./browser-host-tab";
import { sessionBrowserUserAgent } from "./browser-identity";
import { describeBrowserTarget, navigateAndWait } from "./browser-navigation";
import {
  browserLoadOptions,
  browserRequestHeaders,
  diagnosticUrl,
  isAllowedBrowserPermission,
  isAllowedMainUrl,
  logUrlHost,
  normalizeBrowserUrl,
  preferredBrowserLanguageCodes,
} from "./browser-policy";
import { type BrowserProxyRelay, openBrowserProxyRelay, socksExit } from "./browser-profiles/browser-proxy-relay";
import { BrowserRecorder } from "./browser-recorder";
import { type BrowserScriptResult, type BrowserStepOutcome, runBrowserScript } from "./browser-script";
import {
  agentBrowserSessionKey,
  type BrowserTabOwner,
  type BrowserTabSession,
  browserTabPartition,
  defaultBrowserEnvironment,
  isPersistableBrowserUrl,
  persistentBrowserUrl,
  readBrowserState,
  reownStoredBrowserTab,
  resolveEnvironment,
  type StoredBrowserStateV2,
  type StoredBrowserTab,
  storedSessionFields,
  storedTabSession,
} from "./browser-state";
import {
  type ActionResultReader,
  BrowserDialogTurn,
  type BrowserFillFieldsResult,
  BrowserToolQueueWait,
  boundEngineOperation,
  type DialogTabResult,
  dialogTabResult,
  enqueueTabOperation,
  hasCurrentImage,
  isTimeoutError,
  markImageTaken,
  passImageOn,
  readActionSnapshot,
  readActionStatus,
  readTabSnapshot,
  remainingTime,
  runTabAction,
  runTabEvaluation,
  runTabFillFields,
  skipActionResult,
} from "./browser-tab-operations";
import {
  type BrowserCardVault,
  type BrowserDynamicToolHooks,
  type BrowserInputCall,
  browserInputAction,
  browserToolTimeout,
} from "./browser-tool-actions";
import type { BrowserManualStepRequest } from "./browser-tools";
import {
  BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS,
  BROWSER_SCRIPT_EVALUATE_MAX_BYTES,
  BROWSER_SCRIPT_MAX_STEPS,
  type BrowserStep,
  type BrowserToolArguments,
  type BrowserToolCall,
  parseBrowserToolArguments,
  parseBrowserToolCall,
} from "./browser-tools";
import { runCauseEffect } from "./effect-boundary";
import type { DynamicToolCallParams, DynamicToolResult } from "./protocol";
import { isRecord } from "./protocol";
import type { VaultCardSecret } from "./vault-items";
import { TimeoutError, withTimeout } from "./with-timeout";

interface BrowserHostEvents {
  changed: [tabs: BrowserTab[], activeTabId: string | null];
  documentChanged: [tabId: string, documentIds: ReadonlySet<string>];
}

const MAX_ENCODED_CAPTURE_PIXELS = 4_194_304;
/**
 * The shortest side of an image for the model. Some model endpoints refuse an image with a shorter
 * side, and the image stays in the session, so each later turn fails too (#6188).
 */
const MIN_CAPTURE_SIDE = 64;
/**
 * How long enumerating a tab's documents may take before it is unwound. It runs off a navigation
 * rather than a tool call, so no caller is waiting on it and nothing else supplies a deadline -- but
 * it is queued on the tab, so whatever the agent does next waits behind it.
 */
const DOCUMENT_ENUMERATION_TIMEOUT_MS = 10_000;
/** A cache purge that never answers must refuse a fill instead of holding every later fill. */
const CACHE_PURGE_TIMEOUT_MS = 10_000;
/**
 * How long a preview request waits for a new frame before it answers with the last one. The card
 * asks again three seconds after each answer, and the capture keeps running, so the next request
 * gets the frame that was late.
 */
const PREVIEW_STALE_AFTER_MS = 1_000;
/**
 * How long `handle_dialog` waits for the action that opened the dialog. After it, the status read waits
 * in the tab queue for the action, under the action's own deadline.
 */
const DIALOG_ACTION_WAIT_MS = 10_000;
/**
 * How long an agent tool waits for the earlier operations of its tab. One operation takes at most about
 * a minute: a 30 s action, its read, and the bot check waits. A longer wait means that an operation
 * cannot finish, such as a command that a page dialog holds.
 */
const TOOL_QUEUE_WAIT_MS = 120_000;
/**
 * The download limits of one browser session, so that a page cannot fill the disk. A session
 * starts no new download while `MAX_ACTIVE_DOWNLOADS` are in progress, and a download larger
 * than `MAX_DOWNLOAD_BYTES` stops.
 */
const MAX_ACTIVE_DOWNLOADS = 4;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;
/**
 * An agent's tab that nobody used for this long unloads its page, and loads it again on its next use,
 * so a long run does not keep in memory the page of each tab an agent left open. The tab keeps a
 * blank page, as a restored tab does. When memory is low, the tab unloads after
 * `LOW_MEMORY_TAB_SLEEP_MS`.
 */
const IDLE_TAB_SLEEP_MS = 30 * 60_000;
const LOW_MEMORY_TAB_SLEEP_MS = 5 * 60_000;
const IDLE_TAB_SWEEP_MS = 60_000;

interface BrowserConsoleMessageDetails {
  level: "info" | "warning" | "error" | "debug";
  message: string;
  sourceId: string;
}

const logger = createTommyLogger("browser-host");
const BROWSER_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
};

export type BrowserSecretOutcome = { status: "submitted" } | { status: "failed"; reason: string };

export interface PreparedBrowserSecret {
  request: BrowserSecretRequest;
  /**
   * True when agent code from `evaluate` can still run in the page or in a page of its origin in
   * the same session, or a service worker served the page after such a script. That code can
   * listen to the fields, so only the user may decide to fill them.
   */
  agentScriptedOrigin: boolean;
  /**
   * True when the target fields are built for this secret: password fields for a password, one-time
   * code fields for an authenticator code. A field that the agent chose for something else, such as a
   * search box, could put the value in a URL the agent reads.
   */
  vaultFillable: boolean;
  /**
   * `vault` is true for a value that no user typed. A navigation that would carry it in its URL, such as
   * a GET form submission, is then blocked. `username` goes in the username field of the request. When
   * the fill is not confirmed, the outcome names why. The host has replaced the document by then, so
   * the tab is free for the agent and it can ask again.
   */
  submit(secret: string, vault: boolean, username?: string): Effect.Effect<BrowserSecretOutcome, BrowserOperationError>;
  cancel(): void;
}

type BrowserAction = BrowserToolArguments<"act">["action"];

type BrowserToolName = BrowserToolCall["tool"];
type BrowserToolCallOf<Name extends BrowserToolName> = Extract<BrowserToolCall, { tool: Name }>;
type BrowserToolHandlers = {
  [Name in BrowserToolName]: (
    call: BrowserToolCallOf<Name>,
    params: DynamicToolCallParams,
    hooks: BrowserDynamicToolHooks,
  ) => Effect.Effect<DynamicToolResult, BrowserOperationError>;
};

// The generic name keeps each handler paired with its own call type.
function runBrowserTool<Name extends BrowserToolName>(
  handlers: BrowserToolHandlers,
  tool: Name,
  call: BrowserToolCallOf<Name>,
  params: DynamicToolCallParams,
  hooks: BrowserDynamicToolHooks,
): Effect.Effect<DynamicToolResult, BrowserOperationError> {
  return handlers[tool](call, params, hooks);
}

const AGENT_CODE_CARD_FILL =
  "Card fill is unavailable while a script from evaluate can still run in this page or in another open page of this site. Reload this page, close or navigate each other tab where you ran evaluate on this site, take a fresh snapshot, and call fill_card again, or use request_takeover.";

/**
 * The origins of the documents in the page. A frame whose renderer is gone, for example after a crash,
 * has no document. `isDestroyed()` of its `WebContents` stays false, but Electron throws when code
 * reads the frame, and in an Electron event listener that throw stops the main process.
 */
function frameOrigins(contents: WebContents): string[] {
  if (contents.isDestroyed() || contents.mainFrame.isDestroyed()) return [];
  return contents.mainFrame.framesInSubtree.flatMap((frame) => (frame.isDestroyed() ? [] : [frame.origin]));
}

function markScriptedOrigin(tab: BrowserHostTab, origin: string): void {
  const origins = tab.scriptedOrigins ?? new Set<string>();
  origins.add(origin);
  tab.scriptedOrigins = origins;
}

function markWorkerExposedOrigin(tab: BrowserHostTab, origin: string): void {
  const origins = tab.workerExposedOrigins ?? new Set<string>();
  origins.add(origin);
  tab.workerExposedOrigins = origins;
}

function urlOrigin(value: string): string | null {
  return URL.canParse(value) ? new URL(value).origin : null;
}

/** Whether `url` carries `secret` as typed, percent-encoded, or form-encoded. */
function urlCarriesSecret(url: string, secret: string): boolean {
  if (url.includes(secret)) return true;
  try {
    if (decodeURIComponent(url.replaceAll("+", " ")).includes(secret)) return true;
  } catch {
    // A malformed escape elsewhere in the URL; the query values below still decode.
  }
  try {
    return [...new URL(url).searchParams.values()].some((value) => value.includes(secret));
  } catch {
    return false;
  }
}

function rejectAgentServiceTool(): Effect.Effect<DynamicToolResult, BrowserOperationError> {
  return Effect.fail(browserFailure(new Error("This browser tool requires the agent service.")));
}

export class BrowserHost {
  readonly #window: BrowserWindow;
  readonly #session: Session;
  /** The persistent sessions other than the shared one, by partition directory name. */
  readonly #tabSessions = new Map<string, Session>();
  readonly #browserProfile: (agentId: string) => AgentBrowserProfile;
  readonly #profileExists: (profileId: string) => boolean;
  readonly #downloadsRoot: string;
  readonly #statePath: string;
  readonly #tabs = new Map<string, BrowserHostTab>();
  /** Tabs whose saved profile proxy could not load. They remain on disk without loading a page. */
  readonly #unrestoredTabs = new Map<string, StoredBrowserTab>();
  readonly #closingTabDrains = new Map<string, Fiber.Fiber<void, BrowserOperationError>>();
  readonly #listeners = new Set<(...args: BrowserHostEvents["changed"]) => void>();
  readonly #documentListeners = new Set<(...args: BrowserHostEvents["documentChanged"]) => void>();
  readonly #controls = new BrowserControlSessions();
  readonly #reservedDownloadPaths = new Set<string>();
  /** Downloads in progress in all sessions, so an agent's own session does not add to the limit. */
  #activeDownloads = 0;
  readonly #recorder: BrowserRecorder;
  #activeTabId: string | null = null;
  /**
   * The origins, per session, whose Cache Storage an agent script could write since the last purge.
   * A service worker can serve those entries to a later document as page code. Each tab's
   * `scriptedOrigins` follows the agent code that runs in its document.
   */
  readonly #cacheTaintedOrigins = new WeakMap<Session, Set<string>>();
  /** The last purge of each tainted origin, per session. False when it failed. A fill waits for it. */
  readonly #originPurges = new WeakMap<Session, Map<string, Promise<boolean>>>();
  #persistLock = Semaphore.makeUnsafe(1);
  readonly #scope = Scope.makeUnsafe();
  #destroying: Deferred.Deferred<void, BrowserOperationError> | null = null;
  /** Whether the machine is too low on memory for one more tab. Only a server has a reading. */
  readonly #memoryLow: () => boolean;
  readonly #profileProxy: (profileId: string) => BrowserProfileProxyConnection | null;
  readonly #proxyLock = Semaphore.makeUnsafe(1);
  readonly #appliedProxies = new Map<
    string,
    {
      key: string;
      signIn: { host: string; port: number; username: string; password: string } | null;
      relay: BrowserProxyRelay | null;
      proxied: boolean;
    }
  >();
  readonly #idleTabSweep: NodeJS.Timeout;

  constructor(
    window: BrowserWindow,
    downloadsRoot: string,
    statePath: string,
    options: {
      recordingDurationMs?: number;
      recordingMaxConcurrent?: number;
      recordingMaxAggregateBytes?: number;
      memoryLow?: () => boolean;
      /** The session that the new tabs of this agent open in. */
      browserProfile?: (agentId: string) => AgentBrowserProfile;
      /** Whether a named profile still exists. A tab never opens in a deleted profile. */
      profileExists?: (profileId: string) => boolean;
      /** Host-owned address lookup. A failure prevents the profile from loading. */
      profileProxy?: (profileId: string) => BrowserProfileProxyConnection | null;
    } = {},
  ) {
    this.#window = window;
    this.#memoryLow = options.memoryLow ?? (() => false);
    this.#browserProfile = options.browserProfile ?? (() => ({ kind: "shared" }));
    this.#profileExists = options.profileExists ?? (() => false);
    this.#profileProxy = options.profileProxy ?? (() => null);
    this.#downloadsRoot = downloadsRoot;
    this.#statePath = statePath;
    this.#session = session.fromPartition("persist:tommy-browser", { cache: true });
    this.#recorder = new BrowserRecorder(
      downloadsRoot,
      (tabId, recording) => {
        const tab = this.#tabs.get(tabId);
        if (!tab) return;
        if (tab.recording !== recording) this.#invalidatePreviews(tab);
        tab.recording = recording;
        this.#emitChanged();
      },
      {
        ...(options.recordingDurationMs === undefined ? {} : { maxRecordingMs: options.recordingDurationMs }),
        ...(options.recordingMaxConcurrent === undefined
          ? {}
          : { maxConcurrentRecordings: options.recordingMaxConcurrent }),
        ...(options.recordingMaxAggregateBytes === undefined
          ? {}
          : { maxAggregateBytes: options.recordingMaxAggregateBytes }),
      },
    );
    // Service workers read the process fallback instead of the session, so it changes too.
    app.userAgentFallback = sessionBrowserUserAgent(app.userAgentFallback);
    this.#configureSession(this.#session);
    this.#idleTabSweep = setInterval(() => {
      void runCauseEffect(this.#sleepIdleTabs()).catch((error) =>
        logger.warn("Unable to sleep browser tabs", { error: toLogValue(error) }),
      );
    }, IDLE_TAB_SWEEP_MS);
    this.#idleTabSweep.unref();
  }

  readonly restore = Effect.fn("BrowserHost.restore")(function* (
    this: BrowserHost,
    agents: readonly BrowserTabOwner[] = [],
  ): Effect.fn.Return<void, BrowserOperationError> {
    const state = yield* readBrowserState(this.#statePath);
    if (state.tabs.length === 0) return;

    const tabs: BrowserHostTab[] = [];
    for (const saved of state.tabs) {
      // Each saved tab passed the tab limit when it opened, so a restart does not drop one. The reown can
      // put the tabs of several chats in the agent's main chat, which then lists and closes all of them.
      const stored = reownStoredBrowserTab(saved, agents);
      // A tab comes back in the session it opened in, whatever the agent's setting is now. A tab of
      // a deleted profile does not come back: no other session may load its page.
      const tabSession = storedTabSession(stored);
      if (tabSession?.kind === "profile" && !this.#profileExists(tabSession.profileId)) continue;
      // A restored tab must never load before its saved proxy applies.
      if (Exit.isFailure(yield* Effect.exit(this.#applyProfileProxy(tabSession)))) {
        this.#unrestoredTabs.set(stored.id, stored);
        continue;
      }
      const tab = this.#createTab(
        stored.id,
        stored.url,
        stored.ownerThreadId,
        stored.ownerAgentId,
        stored.environment,
        undefined,
        tabSession,
      );
      if (stored.sharedThreadIds) tab.sharedThreadIds = new Set(stored.sharedThreadIds);
      this.#tabs.set(tab.id, tab);
      this.#unrestoredTabs.delete(tab.id);
      this.#bindTabEvents(tab);
      tabs.push(tab);
    }
    this.#activeTabId = this.#tabs.has(state.activeTabId ?? "") ? state.activeTabId : (tabs[0]?.id ?? null);
    this.#emitChanged();

    for (const tab of tabs) tab.pendingRestore = () => loadSavedPage(tab);
    const activeTab = this.#activeTabId ? this.#tabs.get(this.#activeTabId) : undefined;
    if (activeTab) yield* this.#wake(activeTab);
  }).bind(this);

  /**
   * Starts the held-back load of a restored or sleeping tab, once, ahead of anything else queued on
   * it.
   */
  readonly #wake = Effect.fn("BrowserHost.wake")(function* (this: BrowserHost, tab: BrowserHostTab) {
    const pending = tab.pendingRestore;
    if (!pending) return;
    tab.pendingRestore = undefined;
    tab.sleeping = undefined;
    // Restore in queue order before the next agent operation.
    yield* Effect.forkIn(
      enqueueTabOperation(tab, pending, true).pipe(
        Effect.ignore,
        Effect.provideService(BrowserToolQueueWait, undefined),
      ),
      tab.scope,
      { startImmediately: true },
    );
  });

  readonly #sleepIdleTabs = Effect.fn("BrowserHost.sleepIdleTabs")(function* (this: BrowserHost) {
    const now = Date.now();
    const idleMs = this.#memoryLow() ? LOW_MEMORY_TAB_SLEEP_MS : IDLE_TAB_SLEEP_MS;
    for (const tab of this.#tabs.values()) {
      if (tab.pendingRestore || !this.#maySleep(tab)) continue;
      if (this.#tabInUse(tab)) tab.lastUsedAt = now;
      else if (now - tab.lastUsedAt >= idleMs) yield* this.#sleep(tab);
    }
  });

  /**
   * Only an agent's own tab sleeps. A popup and its opener keep a live link between their pages, and
   * a reload breaks it, as it does staged uploads.
   */
  #maySleep(tab: BrowserHostTab): boolean {
    return (
      (tab.ownerThreadId !== null || tab.ownerAgentId !== null) &&
      !tab.closing &&
      !tab.contents.isDestroyed() &&
      !tab.popup &&
      !tab.hasSharedBrowsingContext &&
      ![...this.#tabs.values()].some((child) => child.openerTabId === tab.id) &&
      !tab.engine.hasUploadDocuments()
    );
  }

  /** A reload loses what the page holds, so a tab that a person or a task still has open stays loaded. */
  #tabInUse(tab: BrowserHostTab): boolean {
    return (
      this.#activeTabId === tab.id ||
      // A preview capture is not a use. An unload that starts during one waits behind it on the queue.
      tab.pendingOperations > (tab.previewCapture ? 1 : 0) ||
      tab.recording ||
      tab.secret !== undefined ||
      tab.secretDocument === true ||
      tab.filledCard === true ||
      tab.contents.isCurrentlyAudible()
    );
  }

  /**
   * Unloads the page and ends its renderer process, and keeps the tab: its id, owner, URL and settings
   * stay, and the next use loads the page again through `#wake`. The page's own state, such as its
   * history and unsent form input, is lost, as when a browser discards a background tab.
   */
  readonly #sleep = Effect.fn("BrowserHost.sleep")(function* (this: BrowserHost, tab: BrowserHostTab) {
    const page = currentPreviewPage(tab);
    const saved = savedPreview(tab);
    const capture = saved ? undefined : yield* this.#previewCapture(tab);
    const sleeping: NonNullable<BrowserHostTab["sleeping"]> = { title: tab.contents.getTitle(), preview: null };
    let unloaded = false;
    tab.sleeping = sleeping;
    tab.pendingRestore = () => (unloaded ? loadSavedPage(tab) : Effect.void);
    yield* Effect.forkIn(
      enqueueTabOperation(
        tab,
        () =>
          Effect.gen({ self: this }, function* () {
            const preview =
              saved ??
              (capture ? yield* Deferred.await(capture.frame).pipe(Effect.catch(() => Effect.succeed(null))) : null);
            if (tab.sleeping !== sleeping || tab.closing || tab.contents.isDestroyed()) return;
            sleeping.preview = showsCurrentPage(tab, page) && this.#canShowOwner(tab) ? preview : null;
            unloaded = true;
            yield* this.#closeRenderer(tab);
          }),
        true,
      ).pipe(Effect.ignore, Effect.provideService(BrowserToolQueueWait, undefined)),
      tab.scope,
      { startImmediately: true },
    );
    this.#emitChanged();
  });

  /**
   * Gives the tab a new view that has loaded no page, and closes the old one. A blank page keeps its
   * renderer process and that memory; a view with no page has no process until `#wake` loads one.
   */
  readonly #closeRenderer = Effect.fn("BrowserHost.closeRenderer")(function* (this: BrowserHost, tab: BrowserHostTab) {
    const { view, contents, engine } = tab;
    engine.releaseDialogs();
    yield* engine.destroy();
    yield* browserSync(() => {
      // The tab can close, or the host stop, while the engine stops. Their own cleanup closes the old view.
      if (tab.closing || this.#destroying || this.#tabs.get(tab.id) !== tab) return;
      const next = this.#createView(undefined, this.#tabSession(tab));
      this.#mountView(next);
      next.setBounds(view.getBounds());
      tab.view = next;
      tab.contents = next.webContents;
      tab.engine = engine.forContents(next.webContents);
      this.#bindTabEvents(tab);
      this.#unmountView(view);
      if (!contents.isDestroyed()) contents.close();
      this.#releaseScriptedDocument(tab);
    });
  });

  onChanged(listener: (...args: BrowserHostEvents["changed"]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onDocumentChanged(listener: (...args: BrowserHostEvents["documentChanged"]) => void): () => void {
    this.#documentListeners.add(listener);
    return () => this.#documentListeners.delete(listener);
  }

  endControl(threadId: string, turnId: string): void {
    this.#controls.end(threadId, turnId);
    // A later turn cannot answer the previous turn's dialog.
    for (const tab of this.#tabs.values()) tab.engine.endDialogOwnership(threadId, turnId);
  }

  clearControls(): void {
    this.#controls.clear();
    for (const tab of this.#tabs.values()) tab.engine.endDialogOwnership();
  }

  listTabs(): BrowserTab[] {
    return [...this.#tabs.values()].filter((tab) => !tab.closing && !tab.contents.isDestroyed()).map(toPublicTab);
  }

  /** The renderer process of each open tab, so the resource monitor can count tabs apart from windows. */
  tabProcessIds(): number[] {
    return [...this.#tabs.values()]
      .filter((tab) => !tab.closing && !tab.contents.isDestroyed())
      .map((tab) => tab.contents.getOSProcessId())
      .filter((pid) => pid > 0);
  }

  /** An agent open either loads its first page or releases the tab. */
  readonly #open = Effect.fn("BrowserHost.openTab")(function* (
    this: BrowserHost,
    url: string,
    ownerThreadId: string | null,
    ownerAgentId: string | null,
  ): Effect.fn.Return<BrowserTab, BrowserOperationError> {
    if (!this.#hasTabCapacity(ownerThreadId, ownerAgentId)) {
      return yield* browserFailure(
        new Error(sourceText("error.backend.browserTabLimit", { limit: INPUT_LIMITS.browserTabs })),
      );
    }
    // Each tab is its own renderer process.
    if (this.#memoryLow()) return yield* browserFailure(new Error(sourceText("error.backend.browserLowMemory")));
    const normalizedUrl = yield* browserSync(() => normalizeBrowserUrl(url));
    const tabSession = !ownerAgentId ? undefined : yield* this.#agentTabSession(ownerAgentId);
    yield* this.#applyProfileProxy(tabSession);
    const tab = this.#createTab(
      randomUUID(),
      normalizedUrl,
      ownerThreadId,
      ownerAgentId,
      defaultBrowserEnvironment(),
      undefined,
      tabSession,
    );

    this.#tabs.set(tab.id, tab);
    this.#bindTabEvents(tab);
    this.#activeTabId = tab.id;
    this.#emitChanged();
    return yield* Effect.gen({ self: this }, function* () {
      yield* this.#persistState();

      yield* navigateAndWait(tab.contents, () => tab.contents.loadURL(normalizedUrl, browserLoadOptions()), null).pipe(
        Effect.catch((operationFailure) =>
          Effect.gen({ self: this }, function* () {
            const error = operationFailure.cause;
            if (this.#tabs.get(tab.id) === tab) {
              this.#unmountView(tab.view);
              this.#tabs.delete(tab.id);
              yield* tab.engine.destroy();
              tab.contents.close();
              if (this.#activeTabId === tab.id) {
                this.#activeTabId = this.#tabs.keys().next().value ?? null;
              }
            }
            this.#emitChanged();
            yield* this.#persistState();
            return yield* browserFailure(
              new Error(sourceText("error.backend.browserOpenFailed", { url: normalizedUrl, reason: String(error) })),
            );
          }),
        ),
      );

      return toPublicTab(tab);
    }).pipe(Effect.onInterrupt(() => this.close(tab.id).pipe(Effect.ignore)));
  }).bind(this);

  /**
   * The limit counts the open tabs of the owner thread: the tabs that `list_tabs` of that thread shows
   * and that it can close. Tabs of the agent's other threads do not count, as the thread cannot see them.
   */
  #hasTabCapacity(ownerThreadId: string | null, ownerAgentId: string | null): boolean {
    const tabs = [...this.#tabs.values()].filter(
      (tab) =>
        !tab.closing &&
        !tab.contents.isDestroyed() &&
        tab.ownerThreadId === ownerThreadId &&
        (tab.ownerAgentId === null || tab.ownerAgentId === ownerAgentId),
    );
    return tabs.length < INPUT_LIMITS.browserTabs;
  }

  readonly close = Effect.fn("BrowserHost.close")(function* (
    this: BrowserHost,
    tabId: string,
  ): Effect.fn.Return<void, BrowserOperationError> {
    const tab = this.#tabs.get(tabId);
    if (!tab) {
      if (this.#unrestoredTabs.delete(tabId)) {
        yield* this.#persistState();
        this.#emitChanged();
      }
      return;
    }
    const tabIds = [...this.#tabs.keys()];
    const closedIndex = tabIds.indexOf(tabId);
    this.#unmountView(tab.view);
    this.#releaseScriptedDocument(tab);
    this.#tabs.delete(tabId);
    const childDrains = [...this.#tabs.values()]
      .filter((child) => child.openerTabId === tabId)
      .map((child) => this.close(child.id));

    if (this.#activeTabId === tabId) {
      this.#activeTabId =
        (tab.openerTabId && this.#tabs.has(tab.openerTabId) ? tab.openerTabId : null) ??
        tabIds.slice(closedIndex + 1).find((id) => this.#tabs.has(id)) ??
        tabIds
          .slice(0, closedIndex)
          .reverse()
          .find((id) => this.#tabs.has(id)) ??
        null;
      const active = this.#activeTabId ? this.#tabs.get(this.#activeTabId) : undefined;
      if (active) yield* this.#wake(active);
    }
    this.#emitChanged();
    tab.closing = true;
    // An open dialog holds the tab queue until it closes.
    tab.engine.releaseDialogs();
    const destroy = yield* Effect.forkIn(
      Effect.gen({ self: this }, function* () {
        yield* Deferred.await(tab.queue);
        yield* Effect.all(childDrains, { concurrency: "unbounded", discard: true });
        const discarded = yield* Effect.exit(this.#recorder.discard(tabId, "tab-closed"));
        yield* tab.engine.destroy();
        yield* Scope.close(tab.scope, Exit.void);
        yield* browserSync(() => {
          if (!tab.contents.isDestroyed()) tab.contents.close();
        });
        if (Exit.isFailure(discarded)) return yield* Effect.failCause(discarded.cause);
      }),
      this.#scope,
      { startImmediately: true, uninterruptible: true },
    );
    this.#closingTabDrains.set(tab.id, destroy);
    const results = yield* Effect.all([Fiber.join(destroy), this.#persistState()].map(Effect.exit), {
      concurrency: "unbounded",
    });
    if (this.#closingTabDrains.get(tab.id) === destroy) this.#closingTabDrains.delete(tab.id);
    const failure = results.find(Exit.isFailure);
    if (failure) return yield* Effect.failCause(failure.cause);
  }, Effect.uninterruptible).bind(this);

  readonly prepareSecret = Effect.fn("BrowserHost.prepareSecret")(function* (
    this: BrowserHost,
    params: DynamicToolCallParams,
  ): Effect.fn.Return<PreparedBrowserSecret, BrowserOperationError> {
    const call = yield* browserSync(() => parseBrowserToolCall("submit_secret", params.arguments));
    if (call.tool !== "submit_secret")
      return yield* browserFailure(new Error("Invalid secure authentication request."));
    const args = call.args;
    yield* browserSync(() => this.#requireToolTab(params, args.tabId));
    const tab = yield* this.#requireTab(args.tabId);
    if (tab.secret) return yield* browserFailure(new Error(sourceText("error.backend.authActive")));
    const url = yield* browserSync(() => new URL(currentTabUrl(tab)));
    if (url.protocol !== "https:")
      return yield* browserFailure(new Error(sourceText("error.backend.authHttpsRequired")));
    yield* browserSync(() => this.#requireIsolatedFromConnectedTabs(tab, url.origin));
    if (args.method !== "password" && args.digits < 4)
      return yield* browserFailure(new Error(sourceText("error.backend.authDigitsRange")));
    if (
      (args.method === "password" && args.targets.length !== 1) ||
      (args.targets.length !== 1 && args.targets.length !== args.digits) ||
      (args.submission === "click") !== Boolean(args.submitTarget) ||
      (args.method !== "password" && args.usernameTarget)
    )
      return yield* browserFailure(
        new Error(
          args.method !== "password" && args.usernameTarget
            ? "Invalid authentication targets: usernameTarget is only for method=password."
            : args.submission === "click" && !args.submitTarget
              ? "Invalid authentication targets: submission=click needs submitTarget."
              : args.submission !== "click" && args.submitTarget
                ? "Invalid authentication targets: submitTarget is only for submission=click."
                : args.method === "password"
                  ? "Invalid authentication targets: method=password needs exactly one field target."
                  : `Invalid authentication targets: use one field target for the whole code, or ${args.digits} digit field targets.`,
        ),
      );
    const protection = { origin: url.origin, submitted: false, replaced: false, running: false };
    tab.secret = protection;
    stopCookieBanners(tab.contents);
    this.#invalidatePreviews(tab);
    return yield* Effect.gen({ self: this }, function* () {
      const entry = yield* this.#enqueue(
        args.tabId,
        (_tab, keepQueueBlocked) =>
          Effect.gen({ self: this }, function* () {
            yield* this.#recorder.discard(args.tabId, "requested");
            tab.diagnostics.clearDiagnostics();
            return yield* boundEngineOperation(
              tab,
              tab.engine.prepareSecret(
                args.targets,
                url.origin,
                args.submission,
                args.submitTarget,
                args.usernameTarget,
              ),
              10_000,
              "Authentication target resolution timed out.",
              keepQueueBlocked,
            );
          }),
        true,
      );
      return {
        // Password cards do not use digits; keep public metadata within its released bounds.
        request: {
          method: args.method,
          origin: url.origin,
          digits: args.method === "password" ? 6 : args.digits,
          ...(args.usernameTarget ? { askUsername: true as const } : {}),
          ...(args.usernameTarget && args.username ? { username: args.username } : {}),
        },
        agentScriptedOrigin: yield* this.#agentCodeCanRead(tab, [url.origin], entry.servedByWorker),
        vaultFillable:
          args.method === "password"
            ? entry.fields.password
            : args.method === "authenticator" && entry.fields.oneTimeCode,
        cancel: () => {
          if (tab.secret === protection && !protection.submitted) {
            tab.secret = undefined;
            this.#emitChanged();
          }
        },
        submit: (secret: string, vault: boolean, username?: string) =>
          Effect.gen({ self: this }, function* (): Effect.fn.Return<BrowserSecretOutcome, BrowserOperationError> {
            if (tab.secret !== protection || protection.submitted)
              return yield* browserFailure(new Error(sourceText("error.backend.authExpired")));
            // A connected page can navigate to the secret's site while the card is open.
            yield* browserSync(() => this.#requireIsolatedFromConnectedTabs(tab, url.origin));
            if (args.method !== "password" && !new RegExp(`^[0-9]{${args.digits}}$`, "u").test(secret))
              return yield* browserFailure(new Error(sourceText("error.backend.authDigitsRequired")));
            protection.submitted = true;
            this.#invalidatePreviews(tab);
            protection.running = true;
            let kept = false;
            let leaked = false;
            let failure: string | null = null;
            // A blocked navigation ends the wait for one, so the user gets the tab at once.
            let stopWaiting = () => {};
            const contents = tab.contents;
            const blockLeak = (event: ElectronEvent<WebContentsWillFrameNavigateEventParams>) => {
              if (!urlCarriesSecret(event.url, secret)) return;
              leaked = true;
              event.preventDefault();
              stopWaiting();
            };
            if (vault) contents.on("will-frame-navigate", blockLeak);
            yield* Effect.gen({ self: this }, function* () {
              const entered = yield* this.#enqueue(
                args.tabId,
                (_tab, keepQueueBlocked) =>
                  Effect.gen({ self: this }, function* () {
                    yield* boundEngineOperation(
                      tab,
                      entry.enter(secret, username ?? args.username),
                      10_000,
                      "Authentication submission timed out.",
                      keepQueueBlocked,
                    );
                    if (!protection.replaced && !leaked) {
                      yield* Effect.callback<void>((resume) => {
                        const contents = tab.contents;
                        const cleanup = () => {
                          clearTimeout(timer);
                          stopWaiting = () => {};
                          contents.off("did-navigate", finish);
                          contents.off("destroyed", finish);
                        };
                        const finish = () => {
                          cleanup();
                          resume(Effect.void);
                        };
                        const timer = setTimeout(finish, 5_000);
                        stopWaiting = finish;
                        contents.once("did-navigate", finish);
                        contents.once("destroyed", finish);
                        return Effect.sync(cleanup);
                      });
                    }
                    if (!protection.replaced) {
                      // A reload would restart a single-page sign-in at its first step. Keep the
                      // document when its fields are empty and nothing a snapshot reads shows the value.
                      const cleared = yield* boundEngineOperation(
                        tab,
                        entry.clear(secret),
                        10_000,
                        "Authentication field cleanup timed out.",
                        keepQueueBlocked,
                      ).pipe(Effect.catch(() => Effect.succeed(false)));
                      if (cleared && !protection.replaced) kept = true;
                    }
                  }),
                true,
              ).pipe(Effect.result);
              if (Result.isFailure(entered))
                failure = entered.failure.cause instanceof Error ? entered.failure.cause.message : "The fill failed.";
              // The fields can hold the secret, so nothing reads this document again. Load with GET rather
              // than replaying a possible form POST. A page that will not reload gives way to a blank one,
              // and the agent goes back to its site. Capture stays blocked until a navigation is done.
              if (!protection.replaced && !kept)
                yield* this.#enqueue(
                  args.tabId,
                  (_tab, keepQueueBlocked) =>
                    boundEngineOperation(
                      tab,
                      navigateAndWait(tab.contents, () =>
                        tab.contents.loadURL(currentTabUrl(tab), browserLoadOptions()),
                      ),
                      10_000,
                      "Authentication page reload timed out.",
                      keepQueueBlocked,
                    ).pipe(
                      Effect.catch(() =>
                        protection.replaced
                          ? Effect.void
                          : boundEngineOperation(
                              tab,
                              navigateAndWait(tab.contents, () => tab.contents.loadURL("about:blank")),
                              5_000,
                              "Authentication page replacement timed out.",
                              keepQueueBlocked,
                            ),
                      ),
                    ),
                  true,
                ).pipe(Effect.catch(() => Effect.void));
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  contents.off("will-frame-navigate", blockLeak);
                  protection.running = false;
                  tab.diagnostics.clearDiagnostics();
                  if (protection.replaced) {
                    tab.contents.navigationHistory.clear();
                    tab.secret = undefined;
                  } else if (kept) {
                    tab.secretDocument = true;
                    tab.secret = undefined;
                  }
                  this.#emitChanged();
                }),
              ),
            );
            if (leaked) return { status: "failed", reason: "The page tried to put the secret in its address." };
            if (failure) return { status: "failed", reason: failure };
            return protection.replaced || kept
              ? { status: "submitted" }
              : { status: "failed", reason: "The page could not be replaced after the fill." };
          }),
      };
    }).pipe(
      // Keep the reason, such as which target is wrong, so the agent can correct the request.
      Effect.catch((error) =>
        Effect.gen({ self: this }, function* () {
          tab.secret = undefined;
          // A reason can end in a selector, so end it with a period before the next sentence.
          const reason = error.cause instanceof Error ? ` ${error.cause.message.replace(/\.?\s*$/u, ".")}` : "";
          return yield* browserFailure(
            new Error(
              `Secure authentication is unavailable.${reason} Correct the request, or report the blocked step with request_takeover.`,
            ),
          );
        }),
      ),
    );
  }).bind(this);

  /**
   * Pages in one opener group can keep references to each other's documents, including a document
   * that received a secret and was later replaced. The browser blocks that access between sites, so
   * secure input is allowed in a connected tab only when no frame in another connected tab has the
   * secret's site.
   */
  #requireIsolatedFromConnectedTabs(tab: BrowserHostTab, origin: string): void {
    if (!tab.hasSharedBrowsingContext) return;
    const site = approximateSite(origin);
    for (const connected of this.#connectedTabs(tab)) {
      if (connected === tab) continue;
      if (
        frameOrigins(connected.contents).some(
          (frameOrigin) => frameOrigin !== "null" && approximateSite(frameOrigin) === site,
        )
      )
        throw new Error(
          "Secure input is unavailable while a connected popup or opener tab shows the same site. Close that tab before retrying.",
        );
    }
  }

  #requireNoSecretDocument(tab: BrowserHostTab, action: string): void {
    if ([...this.#connectedTabs(tab)].some((connected) => connected.secretDocument || connected.filledCard))
      throw new Error(
        `${action} is unavailable while a page that received a secret is open. Use snapshots and actions until it navigates.`,
      );
  }

  /** A filled card shows on the page, so no image of the tab leaves the host until it navigates. */
  #requireNoFilledCard(tab: BrowserHostTab, action: string): void {
    if (tab.filledCard)
      throw new Error(`${action} is unavailable while the page shows a filled card. Use snapshots until it navigates.`);
  }

  #cacheTainted(target: Session): Set<string> {
    const origins = this.#cacheTaintedOrigins.get(target) ?? new Set<string>();
    this.#cacheTaintedOrigins.set(target, origins);
    return origins;
  }

  /**
   * The tab's document is going away, and agent code in it stops. Until now, that code could put code
   * in a same-origin page of a connected tab, so such a page keeps the mark until it navigates. It
   * could also write Cache Storage that a service worker serves to any page of the origin in the
   * session, also after the page loaded. So each other open page of the origin must navigate before
   * a fill, and a tainted origin is cleared again.
   */
  #releaseScriptedDocument(tab: BrowserHostTab): void {
    const scripted = tab.scriptedOrigins;
    const exposed = tab.workerExposedOrigins;
    if (!scripted && !exposed) return;
    delete tab.scriptedOrigins;
    delete tab.workerExposedOrigins;
    // A tab that closed itself has no `contents.session`.
    const target = this.#tabSession(tab);
    // The next fill on the origin reads the result from `#originPurges`.
    for (const origin of new Set([...(scripted ?? []), ...(exposed ?? [])]))
      if (this.#cacheTaintedOrigins.get(target)?.has(origin))
        void runCauseEffect(Effect.forkIn(this.#purgeOrigin(target, origin), this.#scope));
    if (!scripted) return;
    const connected = this.#connectedTabs(tab);
    for (const other of this.#sessionTabs(target)) {
      if (other === tab) continue;
      const otherOrigins = new Set(frameOrigins(other.contents));
      for (const origin of scripted) {
        if (!otherOrigins.has(origin)) continue;
        if (connected.has(other)) markScriptedOrigin(other, origin);
        else markWorkerExposedOrigin(other, origin);
      }
    }
  }

  /** The tabs of one browser session. Popups use the session of their opener. */
  #sessionTabs(target: Session): BrowserHostTab[] {
    return [...this.#tabs.values()].filter((other) => this.#tabSession(other) === target);
  }

  /**
   * Whether agent code can run in the tab's page of one of these origins: a script runs in a page of
   * the origin in the tab's session, or the tab's page was open while one ran. A connected page can
   * reach the tab, and any page can write the Cache Storage that a service worker serves to the tab.
   */
  #agentCodeReaches(tab: BrowserHostTab, origins: string[]): boolean {
    const others = this.#sessionTabs(this.#tabSession(tab));
    return origins.some(
      (origin) =>
        tab.workerExposedOrigins?.has(origin) || others.some((candidate) => candidate.scriptedOrigins?.has(origin)),
    );
  }

  /**
   * Whether agent code can read what Tommy fills into the tab's fields of these origins. A page that
   * a service worker served could run code that a script put in Cache Storage, so that page must
   * reload after Tommy clears the origin's Cache Storage and service workers. When no other page of
   * the origin is open in the session, nothing can write that cache again and the origin is clean.
   */
  readonly #agentCodeCanRead = Effect.fn("BrowserHost.agentCodeCanRead")(function* (
    this: BrowserHost,
    tab: BrowserHostTab,
    origins: string[],
    servedByWorker: boolean,
  ): Effect.fn.Return<boolean> {
    if (this.#agentCodeReaches(tab, origins)) return true;
    const target = this.#tabSession(tab);
    const tainted = this.#cacheTaintedOrigins.get(target);
    const dirty = origins.filter((origin) => tainted?.has(origin));
    if (!tainted || dirty.length === 0) return false;
    const clean = servedByWorker ? [] : dirty.filter((origin) => !this.#originOpenElsewhere(target, origin, tab));
    const purges = dirty.map((origin) =>
      servedByWorker || clean.includes(origin)
        ? this.#purgeOrigin(target, origin)
        : Effect.promise(() => this.#originPurges.get(target)?.get(origin) ?? Promise.resolve(true)),
    );
    // A purge that fails leaves the cache as it was, so the user decides.
    if (!(yield* Effect.all(purges, { concurrency: "unbounded" })).every(Boolean)) return true;
    // A page of the origin can open, and run a script, while the purge runs.
    if (this.#agentCodeReaches(tab, origins)) return true;
    if (!servedByWorker) {
      for (const origin of clean) if (!this.#originOpenElsewhere(target, origin, tab)) tainted.delete(origin);
      return false;
    }
    for (const origin of dirty) markWorkerExposedOrigin(tab, origin);
    return true;
  });

  /**
   * Clears the origin's Cache Storage and service workers after the purge that already runs for it.
   * A later purge that succeeds clears what an earlier one that failed left.
   */
  readonly #purgeOrigin = Effect.fn("BrowserHost.purgeOrigin")(function* (
    this: BrowserHost,
    target: Session,
    origin: string,
  ): Effect.fn.Return<boolean> {
    const purges = this.#originPurges.get(target) ?? new Map<string, Promise<boolean>>();
    this.#originPurges.set(target, purges);
    const previous = purges.get(origin) ?? Promise.resolve(true);
    const purge = runCauseEffect(
      withTimeout(
        browserCall(() =>
          previous.then(() => target.clearStorageData({ origin, storages: ["cachestorage", "serviceworkers"] })),
        ),
        CACHE_PURGE_TIMEOUT_MS,
        "Browser cache cleanup timed out.",
      ).pipe(Effect.mapError((error) => (error instanceof TimeoutError ? browserFailure(error) : error))),
    ).then(
      () => true,
      (error: unknown) => {
        logger.warn("Unable to clear a site's caches", { origin, error: toLogValue(error) });
        return false;
      },
    );
    purges.set(origin, purge);
    return yield* Effect.promise(() => purge);
  });

  /** Whether a page of the origin other than the tab's own is open in the session. */
  #originOpenElsewhere(target: Session, origin: string, tab: BrowserHostTab): boolean {
    return [...this.#tabs.values()].some(
      (other) => other !== tab && this.#tabSession(other) === target && frameOrigins(other.contents).includes(origin),
    );
  }

  #connectedTabs(tab: BrowserHostTab): Set<BrowserHostTab> {
    const connected = new Set([tab]);
    for (const current of connected) {
      for (const candidate of this.#tabs.values()) {
        if (candidate.openerTabId === current.id || candidate.id === current.openerTabId) connected.add(candidate);
      }
    }
    return connected;
  }

  readonly act = Effect.fn("BrowserHost.act")(function* (
    this: BrowserHost,
    tabId: string,
    revision: number,
    action: BrowserAction,
  ): Effect.fn.Return<BrowserSnapshot, BrowserOperationError> {
    return yield* this.#enqueue(tabId, (tab, keepQueueBlocked) =>
      Effect.gen({ self: this }, function* () {
        if (revision !== tab.revision) {
          return yield* browserFailure(new Error("Stale browser references. Take a fresh snapshot before acting."));
        }
        const target =
          action.type === "click" || action.type === "type"
            ? ({ kind: "ref", ref: action.ref, revision } as const)
            : undefined;
        const deadline = Date.now() + 10_000;
        yield* Effect.gen({ self: this }, function* () {
          const dispatch = () =>
            Effect.gen({ self: this }, function* () {
              switch (action.type) {
                case "click":
                  if (!target) return yield* browserFailure(new Error("Legacy click requires a target."));
                  yield* tab.engine.click(target, {}, deadline);
                  return;
                case "type":
                  if (!target) return yield* browserFailure(new Error("Legacy type requires a target."));
                  yield* tab.engine.type(
                    target,
                    action.text,
                    { mode: "replace", submit: action.submit === true },
                    deadline,
                  );
                  return;
                case "key":
                  yield* tab.engine.press(action.key, undefined, deadline);
                  return;
                case "scroll":
                  yield* tab.engine.scroll(undefined, 0, action.deltaY, deadline);
                  return;
                case "back":
                case "forward":
                  yield* navigateAndWait(tab.contents, () => navigateHistory(tab.contents, action.type));
                  return;
                case "reload":
                  yield* navigateAndWait(tab.contents, () => {
                    tab.contents.reload();
                    return true;
                  });
              }
            });
          // The deadline the engine carries is checked between its commands, which a renderer that
          // answers none of them never reaches -- and re-resolving a ref fingerprints the element in
          // the frame that owns it, so a page wedged after the snapshot hangs the dispatch itself.
          const dispatchTimeout = Math.max(1, deadline - Date.now());
          yield* boundEngineOperation(tab, dispatch(), dispatchTimeout, "Browser action timed out.", keepQueueBlocked);
          const settleTimeout = Math.max(1, deadline - Date.now());
          yield* boundEngineOperation(
            tab,
            tab.engine.settle(settleTimeout),
            settleTimeout,
            "Browser action timed out.",
            keepQueueBlocked,
          );
          tab.diagnostics.action({
            action: action.type,
            ...(target ? { target: describeBrowserTarget(target) } : {}),
            outcome: "success",
          });
        }).pipe(
          Effect.catch((operationFailure) =>
            Effect.gen({ self: this }, function* () {
              const error = operationFailure.cause;
              tab.diagnostics.action({
                action: action.type,
                ...(target ? { target: describeBrowserTarget(target) } : {}),
                outcome: "error",
                detail: String(error),
              });
              return yield* browserFailure(error);
            }),
          ),
        );
        const nextRevision = tab.revision + 1;
        return (yield* readTabSnapshot(tab, nextRevision, keepQueueBlocked)).snapshot;
      }),
    );
  }).bind(this);

  readonly screenshot = Effect.fn("BrowserHost.screenshot")(function* (
    this: BrowserHost,
    tabId: string,
    target?: BrowserTarget,
  ): Effect.fn.Return<string, BrowserOperationError> {
    return yield* this.#enqueue(tabId, (tab, keepQueueBlocked) =>
      Effect.gen({ self: this }, function* () {
        yield* browserSync(() => this.#requireNoFilledCard(tab, "Browser screenshot"));
        const image = yield* boundEngineOperation(
          tab,
          tab.engine.screenshot(target, Date.now() + 10_000),
          10_000,
          "Browser screenshot timed out.",
          keepQueueBlocked,
        );
        // An element image can scroll the page to the element, so it does not pass an earlier one on.
        if (!target) markImageTaken(tab);
        return boundedCaptureDataUrl(image);
      }),
    );
  }).bind(this);

  #manualStepLifetime = new AbortController();
  #manualStepReporter: ((request: BrowserManualStepRequest, signal?: AbortSignal) => Effect.Effect<boolean>) | null =
    null;

  setManualStepReporter(reporter: typeof this.reportManualStep | null): void {
    this.#manualStepLifetime.abort();
    this.#manualStepLifetime = new AbortController();
    this.#manualStepReporter = reporter;
  }

  reportManualStep(request: BrowserManualStepRequest, signal?: AbortSignal): Effect.Effect<boolean> {
    const lifetime = this.#manualStepLifetime.signal;
    return (
      this.#manualStepReporter?.(request, signal ? AbortSignal.any([signal, lifetime]) : lifetime) ??
      Effect.succeed(false)
    );
  }

  #canShowOwner(tab: BrowserHostTab): boolean {
    return (
      !tab.closing &&
      ![...this.#connectedTabs(tab)].some(
        (item) => item.secret || item.secretDocument || item.filledCard || item.recording,
      )
    );
  }

  /** Pin the document as well as its URL. A reload, a new owner or protected input invalidates the bytes. */
  readonly captureOwnerTab = Effect.fn("BrowserHost.captureOwnerTab")(function* (
    this: BrowserHost,
    tabId: string,
    agentId: string,
    threadId?: string,
  ) {
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.ownerAgentId !== agentId || (threadId !== undefined && tab.ownerThreadId !== threadId)) return null;
    const ownerThread = tab.ownerThreadId;
    const owned = () =>
      this.#tabs.get(tab.id) === tab &&
      tab.ownerAgentId === agentId &&
      tab.ownerThreadId === ownerThread &&
      this.#canShowOwner(tab);
    if (!owned()) return null;
    const expected = currentTabUrl(tab);
    const url = URL.parse(expected);
    if (
      url?.protocol !== "https:" ||
      url.username ||
      url.password ||
      /(?:^|\.)(?:telegram\.org|telegram\.me|telegram\.dog|t\.me)$/u.test(
        url.hostname.toLowerCase().replace(/\.$/u, ""),
      )
    )
      return null;
    if (tab.pendingRestore && !tab.sleeping?.preview) {
      yield* this.#wake(tab);
      yield* Deferred.await(tab.queue);
    }
    const sleeping = tab.sleeping;
    const page = currentPreviewPage(tab);
    const current = () =>
      owned() &&
      page.url === expected &&
      showsCurrentPage(tab, page) &&
      tab.sleeping === sleeping &&
      (Boolean(sleeping?.preview) || tab.contents.getURL() === page.url);
    if (!current()) return null;
    const preview = yield* this.#capturePreview(tab.id);
    const prefix = "data:image/jpeg;base64,";
    if (!current() || !preview.dataUrl.startsWith(prefix) || preview.dataUrl.length > 2 * 1024 * 1024) return null;
    const bytes = Buffer.from(preview.dataUrl.slice(prefix.length), "base64");
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
    return { bytes, current };
  }).bind(this);

  readonly #capturePreview = Effect.fn("BrowserHost.capturePreview")(function* (
    this: BrowserHost,
    tabId: string,
  ): Effect.fn.Return<BrowserPreview, BrowserOperationError> {
    const tab = this.#tabs.get(tabId);
    if (!tab) return yield* browserFailure(new Error(`Unknown browser tab: ${tabId}`));
    if (!this.#canShowOwner(tab)) return yield* browserFailure(new Error("Browser preview is protected."));
    // The last still of a sleeping tab does not require a renderer.
    if (tab.sleeping?.preview) return tab.sleeping.preview;
    yield* this.#wake(tab);
    if (tab.secret?.submitted)
      return yield* browserFailure(new Error("Browser inspection is protected during authentication."));
    yield* browserSync(() => this.#requireNoFilledCard(tab, "Browser preview"));
    const cached = savedPreview(tab);
    if (cached && tab.pendingOperations > 0) return cached;
    const started = yield* this.#previewCapture(tab);
    const capture = Effect.gen({ self: this }, function* () {
      const frame = yield* Deferred.await(started.frame);
      if (this.#canShowOwner(tab) && showsCurrentPage(tab, started)) return frame;
      const retry = yield* this.#previewCapture(tab);
      const retried = yield* Deferred.await(retry.frame);
      if (!this.#canShowOwner(tab) || !showsCurrentPage(tab, retry))
        return yield* browserFailure(new Error(sourceText("error.backend.browserPreviewPageChanged")));
      return retried;
    });
    if (!cached) return yield* capture;
    // A stale frame is usable only if navigation has not changed its page.
    const stale = Effect.sleep(PREVIEW_STALE_AFTER_MS).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          this.#canShowOwner(tab) && savedPreview(tab) === cached ? Effect.succeed(cached) : Effect.never,
        ),
      ),
    );
    return yield* Effect.raceFirst(capture, stale);
  }).bind(this);

  readonly #previewCapture = Effect.fn("BrowserHost.previewCapture")(function* (
    this: BrowserHost,
    tab: BrowserHostTab,
  ) {
    if (tab.previewCapture && showsCurrentPage(tab, tab.previewCapture)) return tab.previewCapture;
    const page = currentPreviewPage(tab);
    const frame = Deferred.makeUnsafe<BrowserPreview, BrowserOperationError>();
    const capture = { ...page, frame };
    tab.previewCapture = capture;
    yield* Effect.forkIn(
      Effect.gen({ self: this }, function* () {
        const result = yield* Effect.exit(
          enqueueTabOperation(tab, (_tab, keepQueueBlocked) =>
            Effect.gen({ self: this }, function* () {
              yield* browserSync(() => this.#requireNoFilledCard(tab, "Browser preview"));
              const image = yield* boundEngineOperation(
                tab,
                tab.engine.screenshot(),
                10_000,
                "Browser preview timed out.",
                keepQueueBlocked,
              );
              const size = image.getSize();
              if (size.width <= 0 || size.height <= 0)
                return yield* browserFailure(new Error("Browser preview is empty."));

              const targetAspectRatio = 16 / 10;
              let cropWidth = size.width;
              let cropHeight = Math.round(cropWidth / targetAspectRatio);
              if (cropHeight > size.height) {
                cropHeight = size.height;
                cropWidth = Math.round(cropHeight * targetAspectRatio);
              }
              const cropped = image.crop({
                x: Math.max(0, Math.floor((size.width - cropWidth) / 2)),
                y: 0,
                width: cropWidth,
                height: cropHeight,
              });
              const preview = cropped.resize({ width: 960, height: 600, quality: "good" });
              const dataUrl = `data:image/jpeg;base64,${preview.toJPEG(72).toString("base64")}`;
              const frame = { dataUrl, width: 960, height: 600 };
              if (showsCurrentPage(tab, page)) tab.preview = { ...page, frame };
              return frame;
            }),
          ).pipe(Effect.provideService(BrowserToolQueueWait, undefined)),
        );
        if (tab.previewCapture === capture) tab.previewCapture = undefined;
        yield* Deferred.done(frame, result);
      }),
      tab.scope,
      { startImmediately: true },
    );
    return capture;
  });

  /** Invalidate any saved or pending still before allowing protected input. */
  #invalidatePreviews(tab: BrowserHostTab): void {
    for (const connected of this.#connectedTabs(tab)) {
      connected.captureGeneration += 1;
      connected.preview = undefined;
      connected.previewCapture = undefined;
      if (connected.sleeping) connected.sleeping.preview = null;
    }
  }

  readonly #toolHandlers: BrowserToolHandlers = {
    open: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        const tab = yield* this.#open(args.url, params.threadId, params.ownerAgentId ?? null);
        this.#controls.updateTab(params, tab.id);
        return textResult({ tab });
      }),
    list_tabs: (_call, params) => browserSync(() => textResult(this.#toolTabs(params))),
    status: (_call, params) =>
      Effect.gen({ self: this }, function* () {
        const control = {
          sessions: this.#controls.state().sessions.filter((session) => session.threadId === params.threadId),
        };
        return textResult({ ...this.#toolTabs(params), control });
      }),
    snapshot: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        const tabId = args.tabId;
        yield* browserSync(() => this.#requireToolTab(params, tabId));
        const mode = args.image ?? "auto";
        const capture = yield* this.#enqueue(tabId, (tab, keepQueueBlocked) =>
          Effect.gen({ self: this }, function* () {
            if (mode === "always") yield* browserSync(() => this.#requireNoFilledCard(tab, "A snapshot image"));
            let imageUrl: string | null = null;
            // The image comes before delivery: when it fails, the next snapshot still carries the entries.
            const result = yield* readTabSnapshot(
              tab,
              tab.revision + 1,
              keepQueueBlocked,
              undefined,
              undefined,
              (read) =>
                Effect.gen(function* () {
                  const recommended = mode === "auto" && read.recommendImage && !tab.filledCard;
                  // A screenshot or snapshot image just before this one shows the same page.
                  const imageCurrent = hasCurrentImage(tab);
                  if (mode !== "always" && (!recommended || imageCurrent)) {
                    if (imageCurrent) passImageOn(tab);
                    if (recommended) {
                      read.snapshot.image = {
                        included: false,
                        reason:
                          "The last image is of this page, and no tool action ran since. Pass image: always if the page can have changed.",
                        width: read.snapshot.viewport.width,
                        height: read.snapshot.viewport.height,
                      };
                    }
                    return;
                  }
                  const image = yield* boundEngineOperation(
                    tab,
                    tab.engine.screenshot(),
                    10_000,
                    "Browser screenshot timed out.",
                    keepQueueBlocked,
                  );
                  markImageTaken(tab);
                  imageUrl = boundedCaptureDataUrl(image);
                }),
            );
            return { result, imageUrl };
          }),
        );
        return this.#snapshotResult(capture.result, mode, capture.imageUrl);
      }),
    navigate: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        const tabId = args.tabId;
        yield* browserSync(() => this.#requireToolTab(params, tabId));
        return snapshotTextResult(yield* this.#navigate(tabId, args, readActionSnapshot));
      }),
    click: (call, params, hooks) => this.#runInputTool(call, params, hooks),
    type: (call, params, hooks) => this.#runInputTool(call, params, hooks),
    fill_fields: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        yield* browserSync(() => this.#requireToolTab(params, args.tabId));
        const tab = yield* this.#requireTab(args.tabId);
        const result = yield* runTabFillFields(tab, args.revision, args.fields, args.timeoutMs ?? 10_000, () =>
          this.#requireToolTab(params, args.tabId),
        );
        return {
          ...snapshotTextResult(result),
          success: result.status === "completed",
        };
      }),
    press: (call, params, hooks) => this.#runInputTool(call, params, hooks),
    hover: (call, params, hooks) => this.#runInputTool(call, params, hooks),
    scroll: (call, params, hooks) => this.#runInputTool(call, params, hooks),
    select_option: (call, params, hooks) => this.#runInputTool(call, params, hooks),
    set_checked: (call, params, hooks) => this.#runInputTool(call, params, hooks),
    drag: (call, params, hooks) => this.#runInputTool(call, params, hooks),
    upload_files: (call, params, hooks) => this.#runInputTool(call, params, hooks),
    fill_card: ({ args }, params, hooks) =>
      Effect.gen({ self: this }, function* () {
        yield* browserSync(() => this.#requireToolTab(params, args.tabId));
        const vault = hooks.cardVault;
        const card = vault ? yield* vault.secret(args.cardId) : null;
        if (!vault || !card)
          return yield* browserFailure(new Error("No saved card has this id. Call list_vault_items."));
        // The first fill on a page, or into a frame of a new origin, waits for the owner's approval.
        // The approval comes outside the tab queue, and the second pass checks every field again.
        const first = yield* this.#fillCard(args, card, vault);
        if (first.status === "filled") return first.result;
        if (!(yield* vault.approve(args.cardId, first.page, first.frames, args.amount)))
          return yield* browserFailure(
            new Error("The owner did not approve this card fill. Ask the user, or use request_takeover."),
          );
        const second = yield* this.#fillCard(args, card, vault);
        if (second.status === "filled") return second.result;
        return yield* browserFailure(new Error("The card page changed during the approval. Take a fresh snapshot."));
      }),
    wait_for: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        const tabId = args.tabId;
        yield* browserSync(() => this.#requireToolTab(params, tabId));
        return snapshotTextResult(
          yield* this.#waitFor(tabId, args, (tab, keepQueueBlocked, timeoutMs, timeoutMessage) =>
            readTabSnapshot(tab, tab.revision + 1, keepQueueBlocked, timeoutMs, timeoutMessage).pipe(
              Effect.map((read) => read.snapshot),
            ),
          ),
        );
      }),
    evaluate: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        yield* browserSync(() => this.#requireToolTab(params, args.tabId));
        return textResult(
          yield* this.#runEvaluation(
            args.tabId,
            args.expression,
            args.awaitPromise ?? true,
            browserToolTimeout(args.timeoutMs),
          ),
        );
      }),
    set_environment: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        const tabId = args.tabId;
        yield* browserSync(() => this.#requireToolTab(params, tabId));
        return snapshotTextResult(
          yield* this.#enqueue(tabId, (tab, keepQueueBlocked) =>
            Effect.gen({ self: this }, function* () {
              const environment = yield* browserSync(() =>
                resolveEnvironment(args, tab.environment, tab.view.getBounds()),
              );
              // This also bounds the engine's rollback if applying the environment fails.
              yield* boundEngineOperation(
                tab,
                tab.engine.setEnvironment(environment),
                10_000,
                "Browser environment change timed out.",
                keepQueueBlocked,
              );
              tab.environment = environment;
              yield* this.#persistState();
              this.#emitChanged();
              return (yield* readTabSnapshot(tab, tab.revision + 1, keepQueueBlocked)).snapshot;
            }),
          ),
        );
      }),
    recording_start: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        const tabId = args.tabId;
        yield* browserSync(() => this.#requireToolTab(params, tabId));
        yield* this.#enqueue(tabId, (tab) => {
          this.#requireNoSecretDocument(tab, "Recording");
          return this.#recorder.start(tabId, tab.contents);
        });
        return textResult({ recording: true, tabId, limits: { durationMs: 300_000, bytes: 104_857_600 } });
      }),
    recording_stop: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        const tabId = args.tabId;
        yield* browserSync(() => this.#requireToolTab(params, tabId));
        return textResult({
          artifact: yield* this.#enqueue(tabId, () => this.#recorder.stop(tabId)),
        });
      }),
    act: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        yield* browserSync(() => this.#requireToolTab(params, args.tabId));
        return snapshotTextResult(yield* this.act(args.tabId, args.revision, args.action));
      }),
    screenshot: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        yield* browserSync(() => this.#requireToolTab(params, args.tabId));
        // A ref starts with the snapshot revision that made it.
        const target: BrowserTarget | undefined = args.ref
          ? { kind: "ref", ref: args.ref, revision: Number(args.ref.split(":", 1)[0]) }
          : undefined;
        const imageUrl = yield* this.screenshot(args.tabId, target);
        return { success: true, contentItems: [{ type: "inputImage", imageUrl }] };
      }),
    run_script: ({ args }, params, hooks) =>
      Effect.gen({ self: this }, function* () {
        const tabId = args.tabId;
        yield* browserSync(() => this.#requireToolTab(params, tabId));
        const run: BrowserScriptResult = yield* runBrowserScript({
          script: args.script,
          timeoutMs: args.timeoutMs ?? BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS,
          maxSteps: BROWSER_SCRIPT_MAX_STEPS,
          runStep: (step) => this.#runStep(params, tabId, step, hooks),
        });
        const result: BrowserScriptResult = run;
        let snapshot: BrowserSnapshot | undefined;
        let snapshotError: string | undefined;
        // The page waits for its dialog, so a snapshot would wait too.
        if (args.finalSnapshot !== false && run.status !== "tab_closed" && run.status !== "dialog") {
          // The steps are done when the final snapshot fails, so the result keeps their value and log.
          // Otherwise the agent sees only an error and can run the same clicks or submits again.
          const read = yield* Effect.result(this.#finalStepsSnapshot(params, tabId));
          if (Result.isSuccess(read)) snapshot = read.success;
          else {
            const error = read.failure.cause;
            snapshotError = redactText(error instanceof Error ? error.message : String(error));
          }
        }
        // The steps before a failure stay done. Without a snapshot, the URL shows the agent where the
        // script left the tab, so that it does not start again from the wrong page.
        const tab = snapshot || (result.status === "completed" && !snapshotError) ? undefined : this.#tabs.get(tabId);
        return {
          ...snapshotTextResult({
            tabId,
            ...result,
            ...(result.error === undefined ? {} : { error: redactText(result.error) }),
            ...(snapshotError === undefined ? {} : { snapshotError }),
            // A page can put a typed card value in its address, as in the tab list.
            ...(tab ? { url: tab.engine.scrubText(currentTabUrl(tab)) } : {}),
            ...(snapshot ? { snapshot } : {}),
          }),
          success: result.status === "completed",
        };
      }),
    handle_dialog: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        yield* browserSync(() => this.#requireToolTab(params, args.tabId, true));
        const tab = yield* this.#requireTab(args.tabId);
        yield* tab.engine.answerDialog(args.dialogId, args.accept, {
          threadId: params.threadId,
          turnId: params.turnId,
        });
        const answered = args.accept ? "accepted" : "dismissed";
        // The action that opened the dialog goes on, and can open the next one.
        const next = Option.getOrUndefined(
          yield* tab.engine.nextDialog().pipe(Effect.timeoutOption(DIALOG_ACTION_WAIT_MS)),
        );
        if (next) return textResult({ answered, ...dialogTabResult(args.tabId, next) });
        // Waits in the tab queue for the action, then for the page to settle. A dialog can open meanwhile.
        const status = yield* this.#runAction(
          args.tabId,
          "handle_dialog",
          undefined,
          () => Effect.void,
          readActionStatus,
        );
        return textResult({ answered, ...status });
      }),
    close_tab: ({ args }, params) =>
      Effect.gen({ self: this }, function* () {
        const tabId = args.tabId;
        // Checked only for a tab that exists, so closing an id that is already gone stays a silent
        // success and a repeated close is idempotent.
        const tab = this.#tabs.get(tabId);
        if (tab) {
          yield* browserSync(() => this.#requireToolTab(params, tabId, true));
          logger.info("Agent closed a browser tab.", {
            tabId,
            host: logUrlHost(tab.requestedUrl),
            agentId: params.ownerAgentId ?? null,
          });
        }
        yield* this.close(tabId);
        return textResult({ closed: true });
      }),
    // The agent service owns these tools and validates the requesting turn.
    submit_secret: rejectAgentServiceTool,
    request_takeover: rejectAgentServiceTool,
    list_logins: rejectAgentServiceTool,
    list_vault_items: rejectAgentServiceTool,
    save_vault_item: rejectAgentServiceTool,
    request_vault_item: rejectAgentServiceTool,
    delete_vault_item: rejectAgentServiceTool,
  };

  readonly handleDynamicTool = Effect.fn("BrowserHost.handleDynamicTool")(function* (
    this: BrowserHost,
    params: DynamicToolCallParams,
    hooks: BrowserDynamicToolHooks = {},
  ): Effect.fn.Return<DynamicToolResult, BrowserOperationError> {
    return yield* Effect.gen({ self: this }, function* () {
      const call = yield* browserSync(() => parseBrowserToolCall(params.tool, params.arguments));
      yield* browserSync(() => this.#controls.begin(params, call));
      return yield* runBrowserTool(this.#toolHandlers, call.tool, call, params, hooks);
    }).pipe(
      Effect.provideService(BrowserToolQueueWait, TOOL_QUEUE_WAIT_MS),
      Effect.provideService(BrowserDialogTurn, { threadId: params.threadId, turnId: params.turnId }),
      Effect.catch((failure) =>
        Effect.succeed<DynamicToolResult>({
          success: false,
          contentItems: [{ type: "inputText", text: redactText(String(failure.cause)) }],
        }),
      ),
      Effect.ensuring(Effect.sync(() => this.#controls.finish(params))),
    );
  }).bind(this);

  #toolTabs(params: DynamicToolCallParams): { tabs: BrowserTab[]; activeTabId: string | null } {
    // A page can put a typed card value in its title or address, so they go through the tab's scrub.
    const tabs = this.listTabs()
      .filter((tab) => this.#canUseToolTab(params, tab))
      .map((tab) => {
        const engine = this.#tabs.get(tab.id)?.engine;
        return engine ? { ...tab, title: engine.scrubText(tab.title), url: engine.scrubText(tab.url) } : tab;
      });
    const activeTabId = tabs.some((tab) => tab.id === this.#activeTabId)
      ? this.#activeTabId
      : (tabs.at(-1)?.id ?? null);
    return { tabs, activeTabId };
  }

  /**
   * One pass of `fill_card`. It types the card only when the owner approved the page and the origin of
   * each field's frame. Otherwise it types nothing and names the page and the frame origins to approve.
   * That pass ends with a failure in the tab queue, so it takes no snapshot and the refs stay current.
   */
  readonly #fillCard = Effect.fn("BrowserHost.fillCard")(function* (
    this: BrowserHost,
    args: BrowserToolArguments<"fill_card">,
    card: VaultCardSecret,
    vault: BrowserCardVault,
  ) {
    const tab = yield* this.#requireTab(args.tabId);
    if (tab.secret) return yield* browserFailure(new Error(sourceText("error.backend.authActive")));
    let result: BrowserCardFillResult = { filled: [], unconfirmed: [] };
    const outcome: { approval: { page: string; frames: string[] } | null } = { approval: null };
    const snapshot = yield* this.#runAction(
      args.tabId,
      "fill_card",
      args.targets.number,
      (current, deadline, markDispatched) =>
        Effect.gen({ self: this }, function* () {
          const topOrigin = urlOrigin(currentTabUrl(current));
          if (!topOrigin?.startsWith("https://"))
            return yield* browserFailure(new Error("Card fill needs an HTTPS page. Use request_takeover."));
          const frames = new Set<string>();
          let servedByWorker = false;
          result = yield* current.engine.fillCard(
            args.targets,
            card,
            {
              checkOrigin: (origin, frameServedByWorker) => {
                // A script the agent ran on the page or the payment frame's site can read the fields.
                if (this.#agentCodeReaches(current, [origin, topOrigin])) throw new Error(AGENT_CODE_CARD_FILL);
                this.#requireIsolatedFromConnectedTabs(current, topOrigin);
                if (origin !== topOrigin) this.#requireIsolatedFromConnectedTabs(current, origin);
                frames.add(origin);
                servedByWorker ||= frameServedByWorker;
              },
              allowFill: () =>
                Effect.gen({ self: this }, function* () {
                  if (yield* this.#agentCodeCanRead(current, [...frames], servedByWorker))
                    return yield* browserFailure(new Error(AGENT_CODE_CARD_FILL));
                  if (!vault.approved(args.cardId, topOrigin, [...frames])) {
                    outcome.approval = { page: topOrigin, frames: [...frames] };
                    return false;
                  }
                  // A recording would keep the frames that show the card. A fill that waits keeps it.
                  yield* this.#recorder.discard(args.tabId, "requested");
                  return true;
                }),
              onFill: () => {
                markDispatched();
                current.filledCard = true;
                this.#invalidatePreviews(current);
              },
            },
            deadline,
          );
          if (outcome.approval)
            return yield* browserFailure(new Error("The card fill waits for the owner's approval."));
        }),
      readActionSnapshot,
      browserToolTimeout(args.timeoutMs),
    ).pipe(Effect.catch((error) => (outcome.approval ? Effect.succeed(null) : Effect.fail(error))));
    if (outcome.approval) return { status: "approval" as const, ...outcome.approval };
    return {
      status: "filled" as const,
      result: snapshotTextResult({
        filled: result.filled,
        ...(result.unconfirmed.length > 0 ? { unconfirmed: result.unconfirmed } : {}),
        snapshot,
      }),
    };
  });

  readonly #runInputTool = Effect.fn("BrowserHost.runInputTool")(function* (
    this: BrowserHost,
    call: BrowserInputCall,
    params: DynamicToolCallParams,
    hooks: BrowserDynamicToolHooks,
  ): Effect.fn.Return<DynamicToolResult, BrowserOperationError> {
    yield* browserSync(() => this.#requireToolTab(params, call.args.tabId));
    const action = yield* browserSync(() => browserInputAction(call, hooks));
    const run = <A>(readResult: ActionResultReader<A>) =>
      this.#runAction(
        call.args.tabId,
        action.name,
        action.target,
        (tab, deadline, markDispatched) => action.run(tab.engine, deadline, markDispatched),
        readResult,
        browserToolTimeout(call.args.timeoutMs),
        call.tool === "upload_files" ? hooks.onUploadOperationStarted : undefined,
      );
    return call.args.snapshot
      ? snapshotTextResult(yield* run(readActionSnapshot))
      : textResult(yield* run(readActionStatus));
  });

  readonly #navigate = Effect.fn("BrowserHost.navigate")(function* <A>(
    this: BrowserHost,
    tabId: string,
    args: Pick<BrowserToolArguments<"navigate">, "url" | "direction" | "timeoutMs">,
    readResult: ActionResultReader<A>,
  ) {
    const { url, direction } = args;
    if (!url && !direction) return yield* browserFailure(new Error("navigate requires url or direction."));
    return yield* this.#runAction(
      tabId,
      "navigate",
      undefined,
      (tab, deadline) =>
        Effect.gen(function* () {
          const operationTimeout = remainingTime(deadline, "Browser navigate timed out.");
          if (url) {
            const normalizedUrl = yield* browserSync(() => normalizeBrowserUrl(url));
            tab.requestedUrl = normalizedUrl;
            yield* navigateAndWait(
              tab.contents,
              () => tab.contents.loadURL(normalizedUrl, browserLoadOptions()),
              operationTimeout,
            );
          } else if (direction === "reload") {
            yield* navigateAndWait(
              tab.contents,
              () => {
                tab.contents.reload();
                return true;
              },
              operationTimeout,
            );
          } else if (direction) {
            yield* navigateAndWait(tab.contents, () => navigateHistory(tab.contents, direction), operationTimeout);
          }
        }),
      readResult,
      browserToolTimeout(args.timeoutMs),
    );
  });

  readonly #waitFor = Effect.fn("BrowserHost.waitFor")(function* <A>(
    this: BrowserHost,
    tabId: string,
    args: Omit<BrowserToolArguments<"wait_for">, "tabId">,
    readResult: (
      tab: BrowserHostTab,
      keepQueueBlocked: KeepQueueBlocked,
      timeoutMs: number,
      timeoutMessage: string,
    ) => Effect.Effect<A, BrowserOperationError>,
  ) {
    const condition = {
      ...(args.target === undefined ? {} : { target: args.target }),
      ...(args.text === undefined ? {} : { text: args.text }),
      ...(args.url === undefined ? {} : { url: args.url }),
      ...(args.state === undefined ? {} : { state: args.state }),
    };
    if (!condition.target && !condition.text && !condition.url && !condition.state)
      return yield* browserFailure(new Error("wait_for requires a condition."));
    const timeoutMs = browserToolTimeout(args.timeoutMs);
    return yield* this.#enqueue(tabId, (tab, keepQueueBlocked) =>
      Effect.gen(function* () {
        const timeoutMessage = "Browser wait condition timed out.";
        const deadline = Date.now() + timeoutMs;
        // The engine checks this deadline between commands, which a frame that answers none of
        // them never reaches.
        const waitTimeout = remainingTime(deadline, timeoutMessage);
        yield* boundEngineOperation(
          tab,
          tab.engine.waitFor(condition, waitTimeout),
          waitTimeout,
          timeoutMessage,
          keepQueueBlocked,
        );
        return yield* readResult(tab, keepQueueBlocked, remainingTime(deadline, timeoutMessage), timeoutMessage);
      }),
    );
  });

  /**
   * One `run_script` step, with the checks of the tool that the step names. Each step takes its own
   * queue slot and checks the tab policy again first, so a person can take the tab between steps.
   * A failed step is an outcome; only an interruption ends the effect.
   */
  readonly #runStep = Effect.fn("BrowserHost.runStep")(function* (
    this: BrowserHost,
    params: DynamicToolCallParams,
    tabId: string,
    step: BrowserStep,
    hooks: BrowserDynamicToolHooks,
  ): Effect.fn.Return<BrowserStepOutcome> {
    const run = Effect.gen({ self: this }, function* (): Effect.fn.Return<BrowserStepOutcome, BrowserOperationError> {
      yield* browserSync(() => this.#requireToolTab(params, tabId));
      const actionResult = (result: ClosedTabResult | DialogTabResult | null): BrowserStepOutcome => {
        if (result === null) return { status: "ok" };
        return "closed" in result ? { status: "tab_closed" } : { status: "dialog", dialog: result };
      };
      switch (step.action) {
        case "navigate":
          return actionResult(yield* this.#navigate(tabId, step, skipActionResult));
        case "wait_for": {
          const { action: _action, ...args } = step;
          yield* this.#waitFor(tabId, args, () => Effect.void);
          return { status: "ok" };
        }
        case "evaluate":
          return {
            status: "ok",
            // A step often evaluates a statement, such as a click, that returns nothing. As an error, the
            // agent would run the statement again.
            value: yield* this.#runEvaluation(
              tabId,
              step.expression,
              step.awaitPromise ?? true,
              browserToolTimeout(step.timeoutMs),
              true,
              BROWSER_SCRIPT_EVALUATE_MAX_BYTES,
            ),
          };
        case "sleep":
          yield* Effect.sleep(step.ms);
          return { status: "ok" };
        case "snapshot":
          return {
            status: "ok",
            value: yield* this.#enqueue(tabId, (tab, keepQueueBlocked) =>
              readTabSnapshot(tab, tab.revision + 1, keepQueueBlocked).pipe(Effect.map((read) => read.snapshot)),
            ),
          };
        case "click": {
          const { action, ...args } = step;
          return actionResult(yield* this.#runInputStep({ tool: action, args: { ...args, tabId } }, hooks));
        }
        case "type": {
          const { action, ...args } = step;
          return actionResult(yield* this.#runInputStep({ tool: action, args: { ...args, tabId } }, hooks));
        }
        case "press": {
          const { action, ...args } = step;
          return actionResult(yield* this.#runInputStep({ tool: action, args: { ...args, tabId } }, hooks));
        }
        case "hover": {
          const { action, ...args } = step;
          return actionResult(yield* this.#runInputStep({ tool: action, args: { ...args, tabId } }, hooks));
        }
        case "scroll": {
          const { action, ...args } = step;
          return actionResult(yield* this.#runInputStep({ tool: action, args: { ...args, tabId } }, hooks));
        }
        case "select_option": {
          const { action, ...args } = step;
          return actionResult(yield* this.#runInputStep({ tool: action, args: { ...args, tabId } }, hooks));
        }
        case "set_checked": {
          const { action, ...args } = step;
          return actionResult(yield* this.#runInputStep({ tool: action, args: { ...args, tabId } }, hooks));
        }
      }
    });
    return yield* run.pipe(
      Effect.catch((failure) =>
        Effect.succeed<BrowserStepOutcome>({
          status: "error",
          // run_script raises the message as a script Error, which adds its own "Error: " prefix.
          error: redactText(failure.cause instanceof Error ? failure.cause.message : String(failure.cause)),
        }),
      ),
    );
  });

  readonly #runInputStep = Effect.fn("BrowserHost.runInputStep")(function* (
    this: BrowserHost,
    call: BrowserInputCall,
    hooks: BrowserDynamicToolHooks,
  ) {
    const action = yield* browserSync(() => browserInputAction(call, hooks));
    return yield* this.#runAction(
      call.args.tabId,
      action.name,
      action.target,
      (tab, deadline, markDispatched) => action.run(tab.engine, deadline, markDispatched),
      skipActionResult,
      browserToolTimeout(call.args.timeoutMs),
    );
  });

  /** The one snapshot at the end of `run_script`, after the tab policy is checked again. */
  readonly #finalStepsSnapshot = Effect.fn("BrowserHost.finalStepsSnapshot")(function* (
    this: BrowserHost,
    params: DynamicToolCallParams,
    tabId: string,
  ) {
    yield* browserSync(() => this.#requireToolTab(params, tabId));
    return yield* this.#enqueue(tabId, (tab, keepQueueBlocked) =>
      readTabSnapshot(tab, tab.revision + 1, keepQueueBlocked).pipe(Effect.map((read) => read.snapshot)),
    );
  });

  readonly resolveUploadTarget = Effect.fn("BrowserHost.resolveUploadTarget")(function* (
    this: BrowserHost,
    params: DynamicToolCallParams,
  ): Effect.fn.Return<BrowserUploadAssignment, BrowserOperationError> {
    const args = yield* browserSync(() => parseBrowserToolArguments("upload_files", params.arguments));
    const tabId = args.tabId;
    yield* browserSync(() => this.#requireToolTab(params, tabId));
    const target = args.target;
    const timeoutMs = browserToolTimeout(args.timeoutMs);
    return yield* this.#enqueue(tabId, (tab, keepQueueBlocked) =>
      // This preflight scans every frame for the input, so an unresponsive one holds it open exactly
      // as it would the upload itself -- and it is queued ahead of that bounded upload, so without a
      // bound of its own the tab never reaches the operation the timeout was meant to protect.
      boundEngineOperation(
        tab,
        tab.engine.resolveUploadTarget(target),
        timeoutMs,
        "Browser upload target resolution timed out.",
        keepQueueBlocked,
      ),
    ).pipe(Effect.provideService(BrowserToolQueueWait, TOOL_QUEUE_WAIT_MS));
  }).bind(this);

  readonly destroy = Effect.fn("BrowserHost.destroy")(function* (this: BrowserHost) {
    yield* this.closeProfileProxies();
    if (this.#destroying) return yield* Deferred.await(this.#destroying);
    const done = Deferred.makeUnsafe<void, BrowserOperationError>();
    this.#destroying = done;
    clearInterval(this.#idleTabSweep);
    const result = yield* Effect.exit(
      Effect.gen({ self: this }, function* () {
        // Capture the persisted tab list before removing native views.
        const persistence = yield* Effect.forkIn(this.#persistState(), this.#scope, { startImmediately: true });
        const drains = [...this.#closingTabDrains.values()].map(Fiber.join);
        for (const target of this.#persistentSessions()) target.flushStorageData();
        for (const tab of this.#tabs.values()) {
          tab.closing = true;
          tab.engine.releaseDialogs();
          this.#unmountView(tab.view);
          drains.push(
            Effect.gen(function* () {
              yield* Deferred.await(tab.queue);
              yield* tab.engine.destroy();
              yield* Scope.close(tab.scope, Exit.void);
              if (!tab.contents.isDestroyed()) tab.contents.close();
            }),
          );
        }
        this.#tabs.clear();
        this.#listeners.clear();
        this.#controls.clear();
        this.#documentListeners.clear();
        const results = yield* Effect.all(
          [
            browserCall(() => Promise.all(this.#persistentSessions().map((target) => target.cookies.flushStore()))),
            Fiber.join(persistence),
            Effect.all(drains.map(Effect.exit), { concurrency: "unbounded" }).pipe(
              Effect.flatMap((results) =>
                this.#recorder.destroy().pipe(
                  Effect.andThen(
                    Effect.suspend(() => {
                      const failure = results.find(Exit.isFailure);
                      return failure ? Effect.failCause(failure.cause) : Effect.void;
                    }),
                  ),
                ),
              ),
            ),
          ].map(Effect.exit),
          { concurrency: "unbounded" },
        );
        this.#closingTabDrains.clear();
        for (const target of this.#persistentSessions()) target.flushStorageData();
        yield* this.#persistLock.withPermit(Effect.void);
        yield* Scope.close(this.#scope, Exit.void);
        const failure = results.find(Exit.isFailure);
        if (failure) return yield* Effect.failCause(failure.cause);
      }).pipe(Effect.uninterruptible),
    );
    yield* Deferred.done(done, result);
    return yield* result;
  }, Effect.uninterruptible).bind(this);

  /**
   * Deletes the cookies, storage and cache of an agent's own session, for a deleted agent. Its tabs
   * must be closed first: a tab still open in the session keeps it.
   */
  readonly clearAgentSession = Effect.fn("BrowserHost.clearAgentSession")(function* (
    this: BrowserHost,
    agentId: string,
  ): Effect.fn.Return<void, BrowserOperationError> {
    yield* this.clearTabSession({ kind: "agent", key: agentBrowserSessionKey(agentId) });
  }).bind(this);

  /**
   * Deletes the cookies, storage and cache of a session other than the shared one. Its tabs must be
   * closed first: a tab still open in the session keeps it.
   */
  readonly clearTabSession = Effect.fn("BrowserHost.clearTabSession")(function* (
    this: BrowserHost,
    tabSession: BrowserTabSession,
  ): Effect.fn.Return<void, BrowserOperationError> {
    const partition = browserTabPartition(tabSession);
    if (this.tabIdsInSession(tabSession).length > 0)
      return yield* browserFailure(new Error(sourceText("error.backend.browserSessionInUse")));
    // A session that never opened has nothing to clear, and opening one would create it.
    if (!this.#tabSessions.has(partition) && !existsSync(join(app.getPath("sessionData"), "Partitions", partition)))
      return;
    yield* this.#dropAppliedProxy(partition);
    const target = this.#tabSessions.get(partition) ?? session.fromPartition(`persist:${partition}`, { cache: true });
    this.#tabSessions.delete(partition);
    yield* browserCall(() => target.clearStorageData());
    yield* browserCall(() => target.clearCache());
  }).bind(this);

  /** A session's open and deferred tabs, so an explicit profile clear can close every saved tab. */
  tabIdsInSession(tabSession: BrowserTabSession): string[] {
    const partition = browserTabPartition(tabSession);
    const loaded = [...this.#tabs.values()]
      .filter((tab) => tab.tabSession && browserTabPartition(tab.tabSession) === partition)
      .map((tab) => tab.id);
    const deferred = [...this.#unrestoredTabs.values()]
      .filter((tab) => {
        const savedSession = storedTabSession(tab);
        return savedSession !== undefined && browserTabPartition(savedSession) === partition;
      })
      .map((tab) => tab.id);
    return [...loaded, ...deferred];
  }

  /** The session for a new tab of this agent. A profile that does not exist fails: no fallback. */
  readonly #agentTabSession = Effect.fn("BrowserHost.agentTabSession")(function* (
    this: BrowserHost,
    agentId: string,
  ): Effect.fn.Return<BrowserTabSession | undefined, BrowserOperationError> {
    const profile = this.#browserProfile(agentId);
    if (profile.kind === "shared") return undefined;
    if (profile.kind === "agent") return { kind: "agent", key: agentBrowserSessionKey(agentId) };
    if (!this.#profileExists(profile.profileId))
      return yield* browserFailure(new Error(sourceText("error.backend.browserProfileMissing")));
    return { kind: "profile", profileId: profile.profileId };
  }).bind(this);

  readonly #applyProfileProxy = Effect.fn("BrowserHost.applyProfileProxy")(function* (
    this: BrowserHost,
    tabSession: BrowserTabSession | undefined,
  ): Effect.fn.Return<void, BrowserOperationError> {
    if (tabSession?.kind !== "profile") return;
    yield* this.#proxyLock.withPermit(
      Effect.gen({ self: this }, function* () {
        const partition = browserTabPartition(tabSession);
        const proxy = yield* browserSync(() => this.#profileProxy(tabSession.profileId));
        const key = JSON.stringify(proxy);
        const previous = this.#appliedProxies.get(partition);
        if (previous?.key === key) return;
        const target = this.#persistentTabSession(tabSession);
        this.#appliedProxies.delete(partition);
        // Block egress during changes and after any failure. Never add a direct fallback rule.
        yield* browserCall(() =>
          target.setProxy({ mode: "fixed_servers", proxyRules: "http://127.0.0.1:9", proxyBypassRules: "<-loopback>" }),
        );
        yield* browserCall(() => target.closeAllConnections());
        yield* browserCall(() => target.clearAuthCache());
        if (previous?.relay) yield* previous.relay.close;
        const relay =
          proxy?.scheme === "socks5" && proxy.username !== null
            ? yield* openBrowserProxyRelay(
                socksExit({
                  host: proxy.host.replace(/^\[|\]$/gu, ""),
                  port: proxy.port,
                  username: proxy.username,
                  password: proxy.password ?? "",
                }),
              )
            : null;
        const rules = relay
          ? `http://${relay.host}:${relay.port}`
          : proxy
            ? `${proxy.scheme}://${proxy.host}:${proxy.port}`
            : null;
        yield* browserCall(() =>
          target.setProxy(
            rules === null
              ? { mode: "system" }
              : { mode: "fixed_servers", proxyRules: rules, proxyBypassRules: "<-loopback>" },
          ),
        ).pipe(Effect.onError(() => relay?.close ?? Effect.void));
        this.#appliedProxies.set(partition, {
          key,
          relay,
          proxied: proxy !== null,
          signIn:
            relay ??
            (proxy?.username
              ? { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password ?? "" }
              : null),
        });
      }),
    );
  }).bind(this);

  readonly #dropAppliedProxy = Effect.fn("BrowserHost.dropAppliedProxy")(function* (
    this: BrowserHost,
    partition: string,
  ) {
    const applied = this.#appliedProxies.get(partition);
    this.#appliedProxies.delete(partition);
    if (applied?.relay) yield* applied.relay.close;
  }).bind(this);

  /** Close profile tabs first. Existing cookies and storage remain when an address changes. */
  readonly releaseProfileProxy = Effect.fn("BrowserHost.releaseProfileProxy")(function* (
    this: BrowserHost,
    profileId: string,
  ): Effect.fn.Return<void, BrowserOperationError> {
    const tabSession: BrowserTabSession = { kind: "profile", profileId };
    if (this.tabIdsInSession(tabSession).length > 0)
      return yield* browserFailure(new Error(sourceText("error.backend.browserProfileInUse")));
    yield* this.#proxyLock.withPermit(
      Effect.gen({ self: this }, function* () {
        const partition = browserTabPartition(tabSession);
        const target = this.#tabSessions.get(partition);
        if (target) {
          yield* browserCall(() =>
            target.setProxy({
              mode: "fixed_servers",
              proxyRules: "http://127.0.0.1:9",
              proxyBypassRules: "<-loopback>",
            }),
          );
          yield* browserCall(() => target.closeAllConnections());
          yield* browserCall(() => target.clearAuthCache());
        }
        yield* this.#dropAppliedProxy(partition);
      }),
    );
  }).bind(this);

  readonly closeProfileProxies = Effect.fn("BrowserHost.closeProfileProxies")(function* (this: BrowserHost) {
    for (const partition of [...this.#appliedProxies.keys()]) yield* this.#dropAppliedProxy(partition);
  }).bind(this);

  #persistentSessions(): Session[] {
    return [this.#session, ...this.#tabSessions.values()];
  }

  #tabSession(tab: Pick<BrowserHostTab, "tabSession">): Session {
    return tab.tabSession ? this.#persistentTabSession(tab.tabSession) : this.#session;
  }

  #persistentTabSession(tabSession: BrowserTabSession): Session {
    const partition = browserTabPartition(tabSession);
    const existing = this.#tabSessions.get(partition);
    if (existing) return existing;
    const target = session.fromPartition(`persist:${partition}`, { cache: true });
    this.#configureSession(target);
    this.#tabSessions.set(partition, target);
    return target;
  }

  #createTab(
    id: string,
    requestedUrl: string,
    ownerThreadId: string | null,
    ownerAgentId: string | null,
    environment: BrowserEnvironment = defaultBrowserEnvironment(),
    popupOptions?: BrowserWindowConstructorOptions,
    tabSession?: BrowserTabSession,
  ): BrowserHostTab {
    if (this.#destroying) throw new Error("BrowserHost is shutting down.");
    const view = this.#createView(
      popupOptions,
      this.#tabSession({
        ...(tabSession ? { tabSession } : {}),
      }),
    );
    this.#mountView(view);
    const diagnostics = new BrowserDiagnostics();
    const queue = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(queue, Exit.void);
    return {
      id,
      view,
      contents: view.webContents,
      popup: popupOptions !== undefined,
      ...(tabSession ? { tabSession } : {}),
      requestedUrl,
      ownerThreadId,
      ownerAgentId,
      revision: 0,
      queue,
      scope: Scope.makeUnsafe(),
      pendingOperations: 0,
      environment,
      engine: new BrowserCdpEngine(view.webContents),
      diagnostics,
      recording: false,
      captureGeneration: 0,
      documents: 0,
      lastUsedAt: Date.now(),
    };
  }

  #createView(popupOptions: BrowserWindowConstructorOptions | undefined, tabSession: Session): WebContentsView {
    const view = new WebContentsView({
      ...(popupOptions?.webContents ? { webContents: popupOptions.webContents } : {}),
      webPreferences: {
        ...popupOptions?.webPreferences,

        session: tabSession,
        ...BROWSER_WEB_PREFERENCES,
      },
    });
    view.webContents.setAudioMuted(true);
    view.setBackgroundColor("#0b0b0b");
    return view;
  }

  #configureSession(target: Session): void {
    // Use the installed Chromium identity for pages, frames and workers.
    // The request policy keeps the Google account compatibility exception.
    // Service workers read the process fallback instead of the session, so it changes too.
    app.userAgentFallback = sessionBrowserUserAgent(app.userAgentFallback);
    target.setUserAgent(sessionBrowserUserAgent(target.getUserAgent()), preferredBrowserLanguageCodes());
    target.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: browserRequestHeaders(details.url, details.requestHeaders),
      });
    });
    target.webRequest.onCompleted((details) => {
      const tab = [...this.#tabs.values()].find((candidate) => candidate.contents.id === details.webContentsId);
      if (!tab || tab.secret) return;
      tab.diagnostics.add({
        kind: "network",
        level: details.statusCode >= 400 ? "error" : "info",
        message: `${details.method} ${details.statusCode}`,
        ...diagnosticUrlField(details.url),
        method: details.method,
        status: details.statusCode,
      });
      if (details.statusCode >= 400) this.#emitChanged();
    });
    target.webRequest.onErrorOccurred((details) => {
      const tab = [...this.#tabs.values()].find((candidate) => candidate.contents.id === details.webContentsId);
      if (!tab || tab.secret) return;
      // The page or a navigation cancelled a subresource request: it did not fail. Live pages cancel
      // many. A cancelled page load can be a blocked navigation, so it stays an error.
      const cancelled = details.error === "net::ERR_ABORTED" && details.resourceType !== "mainFrame";
      tab.diagnostics.add({
        kind: "network",
        level: cancelled ? "info" : "error",
        message: `${details.method} ${details.error}`,
        ...diagnosticUrlField(details.url),
        method: details.method,
      });
      if (!cancelled) this.#emitChanged();
    });
    target.setPermissionRequestHandler((_webContents, permission, callback) =>
      callback(isAllowedBrowserPermission(permission)),
    );
    target.setPermissionCheckHandler((_webContents, permission) => isAllowedBrowserPermission(permission));
    target.on("will-download", (event, item, contents) => {
      if ([...this.#tabs.values()].some((tab) => tab.secret && tab.contents === contents)) {
        event.preventDefault();
        return;
      }
      if (this.#activeDownloads >= MAX_ACTIVE_DOWNLOADS || item.getTotalBytes() > MAX_DOWNLOAD_BYTES) {
        event.preventDefault();
        return;
      }
      const safeName = basename(item.getFilename()).replace(/[^a-zA-Z0-9._ -]/g, "_");
      const downloadPath = uniqueDownloadPath(
        this.#downloadsRoot,
        safeName || `download-${Date.now()}`,
        this.#reservedDownloadPaths,
      );
      this.#reservedDownloadPaths.add(downloadPath);
      item.setSavePath(downloadPath);
      this.#activeDownloads += 1;
      // A server can send no size, or a wrong one, so the received bytes are checked as they arrive.
      item.on("updated", () => {
        if (item.getState() !== "progressing" || item.getReceivedBytes() <= MAX_DOWNLOAD_BYTES) return;
        logger.warn("Browser download stopped at the size limit", { limitBytes: MAX_DOWNLOAD_BYTES });
        item.cancel();
      });
      item.once("done", () => {
        this.#activeDownloads -= 1;
        this.#reservedDownloadPaths.delete(downloadPath);
      });
    });
  }

  #bindTabEvents(tab: BrowserHostTab): void {
    const contents = tab.contents;
    const changed = () => this.#emitChanged();
    const applied =
      tab.tabSession?.kind === "profile" ? this.#appliedProxies.get(browserTabPartition(tab.tabSession)) : undefined;
    if (applied?.proxied) contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    let proxySignIns = 0;
    contents.on("login", (event, _details, authInfo, callback) => {
      if (!authInfo.isProxy) return;
      event.preventDefault();
      const signIn =
        tab.tabSession?.kind === "profile"
          ? this.#appliedProxies.get(browserTabPartition(tab.tabSession))?.signIn
          : null;
      if (
        !signIn ||
        proxySignIns >= 2 ||
        authInfo.host.replace(/^\[|\]$/gu, "") !== signIn.host.replace(/^\[|\]$/gu, "") ||
        authInfo.port !== signIn.port
      ) {
        callback();
        return;
      }
      proxySignIns++;
      callback(signIn.username, signIn.password);
    });
    contents.on("did-navigate", () => {
      proxySignIns = 0;
    });
    contents.on("close", () => {
      // `#closeRenderer` closes the old contents of a tab that stays open.
      if (tab.contents !== contents) return;
      tab.closing = true;
    });
    contents.on("render-process-gone", () => {
      if (tab.contents === contents) this.#releaseScriptedDocument(tab);
    });
    contents.once("destroyed", () => {
      if (tab.contents !== contents) return;
      // Finish native destruction before removing the view and draining queued work.
      setImmediate(() => {
        void runCauseEffect(this.close(tab.id)).catch((error) =>
          logger.warn("Unable to clean up browser tab", { error: toLogValue(error) }),
        );
      });
    });
    let documentGeneration = 0;
    contents.on("did-frame-navigate", (_event, _url, _code, _status, isMainFrame) => {
      const generation = ++documentGeneration;
      if (!tab.engine.hasUploadDocuments()) {
        if (this.#tabs.get(tab.id) !== tab) return;
        for (const listener of this.#documentListeners) listener(tab.id, new Set());
        return;
      }
      if (this.#tabs.get(tab.id) !== tab) return;
      // Enumeration walks every frame the tab has, and it is queued on the tab, so an unresponsive
      // one stops the tab for good -- and this runs off a navigation, where no caller's deadline
      // covers it.
      void runCauseEffect(
        this.#enqueue(tab.id, (queuedTab, keepQueueBlocked) =>
          boundEngineOperation(
            queuedTab,
            queuedTab.engine.documentIds(),
            DOCUMENT_ENUMERATION_TIMEOUT_MS,
            "Browser document enumeration timed out.",
            keepQueueBlocked,
          ),
        ),
      )
        .then((documentIds) => {
          if (generation !== documentGeneration || this.#tabs.get(tab.id) !== tab) return;
          for (const listener of this.#documentListeners) listener(tab.id, documentIds);
        })
        .catch((error) => {
          // The empty set below tells the upload staging that the documents holding its files are
          // gone, and it deletes them. A timeout does not say that: it says the frames were never
          // asked, so completeness could not be established and the files have to stand.
          if (isTimeoutError(error)) return;
          if (!isMainFrame || generation !== documentGeneration || this.#tabs.get(tab.id) !== tab) return;
          for (const listener of this.#documentListeners) listener(tab.id, new Set());
        });
    });
    contents.on("did-start-loading", changed);
    contents.on("dom-ready", () => {
      // Keep page content at the same width when the viewport scrollbar appears or disappears.
      // Navigation replaces the document, so each new document needs the stylesheet.
      void contents.insertCSS(":where(html) { scrollbar-gutter: stable; }").catch(() => undefined);
      if ((tab.ownerThreadId !== null || tab.ownerAgentId !== null) && !tab.secret) refuseCookieBanners(contents);
    });
    contents.on("did-stop-loading", changed);
    contents.on("console-message", (...eventArgs) => {
      if (tab.secret) return;
      const details = readConsoleMessage(eventArgs);
      if (!details) return;
      tab.diagnostics.add({
        kind: "console",
        level: details.level,
        message: details.message,
        ...diagnosticUrlField(details.sourceId),
      });
      if (details.level === "error") this.#emitChanged();
    });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || tab.secret) return;
      tab.diagnostics.add({
        kind: "load",
        level: "error",
        message: `${code}: ${description}`,
        ...diagnosticUrlField(url),
      });
      this.#emitChanged();
    });
    contents.on("page-title-updated", changed);
    contents.on("did-navigate", (_event, url) => {
      tab.documents += 1;
      this.#releaseScriptedDocument(tab);
      if (tab.secretDocument) {
        tab.secretDocument = false;
        contents.navigationHistory.clear();
      }
      // The next document has no card in its fields. History would bring the filled page back.
      if (tab.filledCard) {
        tab.filledCard = false;
        contents.navigationHistory.clear();
      }
      if (tab.secret?.submitted) {
        tab.secret.replaced = true;
        if (!tab.secret.running) {
          contents.navigationHistory.clear();
          tab.secret = undefined;
          tab.diagnostics.clearDiagnostics();
        }
      }
      if (this.#tabs.get(tab.id) !== tab) return;
      if (isPersistableBrowserUrl(url)) tab.requestedUrl = persistentBrowserUrl(url);
      tab.revision += 1;
      changed();
      this.#schedulePersist();
    });
    contents.on("did-navigate-in-page", (_event, url) => {
      if (this.#tabs.get(tab.id) !== tab) return;
      if (isPersistableBrowserUrl(url)) tab.requestedUrl = persistentBrowserUrl(url);
      tab.revision += 1;
      changed();
      this.#schedulePersist();
    });
    contents.on("will-navigate", (event, url) => {
      if (!isAllowedMainUrl(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event) => {
      if (!event.isMainFrame) return;
      if (!isAllowedMainUrl(event.url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url, referrer, postBody, disposition }) => {
      if (this.#destroying || this.#tabs.get(tab.id) !== tab) return { action: "deny" };
      const unsupported = !["foreground-tab", "background-tab", "new-window"].includes(disposition);
      const failure = tab.secret
        ? sourceText("error.backend.popupSecureInput")
        : unsupported
          ? sourceText("error.backend.popupUnsupportedType")
          : !isAllowedMainUrl(url)
            ? sourceText("error.backend.popupUnsupportedAddress")
            : !this.#hasTabCapacity(tab.ownerThreadId, tab.ownerAgentId)
              ? sourceText("error.backend.popupTabLimit")
              : this.#memoryLow()
                ? sourceText("error.backend.browserLowMemory")
                : undefined;
      if (failure) {
        tab.popupFailure = { id: randomUUID(), message: failure };
        this.#emitChanged();
        return { action: "deny" };
      }
      // Electron supplies the opener preferences and navigates the returned contents itself.
      // Reopening the URL loses WindowProxy, POST bodies, and OAuth callback messages.
      let popup: BrowserHostTab | undefined;
      return {
        action: "allow",
        // The host owns cleanup. Electron otherwise destroys children on opener reload too.
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          webPreferences: { ...BROWSER_WEB_PREFERENCES, session: this.#tabSession(tab) },
        },
        createWindow: (options) => {
          if (popup) return popup.contents;
          popup = this.#createTab(
            randomUUID(),
            url,
            tab.ownerThreadId,
            tab.ownerAgentId,
            structuredClone(tab.environment),
            options,
            tab.tabSession,
          );
          // A thread that drives a shared tab also drives its popups, for example a sign-in window.
          if (tab.sharedThreadIds?.size) popup.sharedThreadIds = new Set(tab.sharedThreadIds);
          // Chromium exposes no opener for noopener/noreferrer requests.
          if (options.webContents?.opener) {
            popup.openerTabId = tab.id;
            popup.hasSharedBrowsingContext = true;
            tab.hasSharedBrowsingContext = true;
          }
          this.#tabs.set(popup.id, popup);
          this.#bindTabEvents(popup);
          tab.popupFailure = undefined;
          this.#activeTabId = popup.id;
          this.#emitChanged();
          this.#schedulePersist();
          const created = popup;
          void runCauseEffect(
            enqueueTabOperation(created, () => created.engine.setEnvironment(created.environment), true),
          ).catch((error) => {
            logger.warn("Unable to apply popup environment", { error: toLogValue(error) });
          });
          // Links without a native guest need an explicit load; native guests already own
          // their navigation, including POST data and the opener WindowProxy.
          if (!options.webContents) {
            void created.contents
              .loadURL(url, {
                httpReferrer: referrer,
                ...(postBody
                  ? {
                      postData: postBody.data,
                      extraHeaders: `content-type: ${postBody.contentType}${postBody.boundary ? `; boundary=${postBody.boundary}` : ""}`,
                    }
                  : {}),
              })
              .catch(() => {
                if (this.#tabs.get(tab.id) !== tab) return;
                tab.popupFailure = {
                  id: randomUUID(),
                  message: sourceText("error.backend.popupLoadFailed"),
                };
                this.#emitChanged();
              });
          }
          return created.contents;
        },
      };
    });
  }

  #snapshotResult(result: SnapshotReadResult, mode: BrowserImageMode, imageUrl: string | null): DynamicToolResult {
    if (!imageUrl) return snapshotTextResult(result.snapshot);
    result.snapshot.image = {
      included: true,
      reason: mode === "always" ? "requested" : result.imageReason,
      width: result.snapshot.viewport.width,
      height: result.snapshot.viewport.height,
    };
    return {
      success: true,
      contentItems: [
        { type: "inputText", text: snapshotJson(result.snapshot) },
        { type: "inputImage", imageUrl },
      ],
    };
  }

  #mountView(view: WebContentsView): void {
    this.#window.contentView.addChildView(view);
    // Initialize the native viewport before hiding a tab that has never been shown.
    view.setVisible(true);
    view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    view.setVisible(false);
  }

  #unmountView(view: WebContentsView): void {
    view.setVisible(false);
    if (!this.#window.isDestroyed()) this.#window.contentView.removeChildView(view);
  }

  readonly #requireTab = Effect.fn("BrowserHost.requireTab")(function* (this: BrowserHost, tabId: string) {
    const tab = this.#tabs.get(tabId);
    if (!tab) return yield* browserFailure(new Error(`Unknown browser tab: ${tabId}`));
    yield* this.#wake(tab);
    tab.lastUsedAt = Date.now();
    return tab;
  });

  /** `dialogTool` is true for a tool that works while a page dialog is open: `handle_dialog` and `close_tab`. */
  #requireToolTab(params: DynamicToolCallParams, tabId: string, dialogTool = false): void {
    const tab = this.listTabs().find((candidate) => candidate.id === tabId);
    if (!tab || !this.#canUseToolTab(params, tab)) throw new Error(`Unknown browser tab: ${tabId}`);
    // Keep every tool out of a tab while a private input form is active.
    // Only `close_tab` gets past a finished fill whose page would not go away: closing reads nothing.
    const secret = this.#tabs.get(tabId)?.secret;
    if (secret && !(dialogTool && secret.submitted && !secret.running))
      throw new Error("Browser inspection is protected during authentication.");
    const engine = this.#tabs.get(tabId)?.engine;
    const dialog = engine?.dialog;
    // The page waits for its dialog, so every other tool would wait until its timeout.
    if (!dialog || dialogTool) return;
    if (engine?.dialogOwnedBy({ threadId: params.threadId, turnId: params.turnId }))
      throw new Error(
        `A ${dialog.type} dialog is open in this tab: ${JSON.stringify(dialog.message)}. Answer it first with handle_dialog, dialogId ${dialog.id}.`,
      );
    throw new Error("A page dialog belongs to a different turn. Report the blocked step or close the tab.");
  }

  /**
   * The owner thread can use its tab. Another thread of the same agent can use it after a person shared
   * it with that thread. A tab with no owner agent is never shared.
   */
  #canUseToolTab(params: DynamicToolCallParams, tab: BrowserTab): boolean {
    const ownerAgentId = params.ownerAgentId ?? null;
    if (tab.ownerThreadId === params.threadId) return tab.ownerAgentId === null || tab.ownerAgentId === ownerAgentId;
    if (tab.ownerAgentId === null || tab.ownerAgentId !== ownerAgentId) return false;
    return this.#tabs.get(tab.id)?.sharedThreadIds?.has(params.threadId) ?? false;
  }

  /**
   * Lets one more thread of the tab's owner agent use the tab: a person tagged the tab in a message to
   * that thread. A tab of another agent, or of no agent, does not change, so a false tag shares nothing.
   */
  shareTab(tabId: string, target: { agentId: string; threadId: string }): void {
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.closing || tab.ownerAgentId === null) return;
    if (tab.ownerAgentId !== target.agentId || tab.ownerThreadId === target.threadId) return;
    if (tab.sharedThreadIds?.has(target.threadId)) return;
    tab.sharedThreadIds = (tab.sharedThreadIds ?? new Set()).add(target.threadId);
    this.#schedulePersist();
  }

  /** A deleted thread can use no tab. */
  unshareThread(threadId: string): void {
    let changed = false;
    for (const tab of this.#tabs.values()) changed = tab.sharedThreadIds?.delete(threadId) === true || changed;
    if (changed) this.#schedulePersist();
  }

  /**
   * The title and address of a tab of this agent, as its message references show them to the provider,
   * or null when the agent does not own the tab. A page can put a typed card value in either one, so
   * both go through the tab's scrub, as the tab list of the browser tool does.
   */
  agentTab(tabId: string, agentId: string): { title: string; url: string } | null {
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.closing || tab.secret || tab.contents.isDestroyed() || tab.ownerAgentId !== agentId) return null;
    const { title, url } = toPublicTab(tab);
    return { title: tab.engine.scrubText(title), url: tab.engine.scrubText(url) };
  }

  readonly #enqueue = Effect.fn("BrowserHost.enqueue")(function* <T>(
    this: BrowserHost,
    tabId: string,
    operation: (tab: BrowserHostTab, keepQueueBlocked: KeepQueueBlocked) => Effect.Effect<T, BrowserOperationError>,
    allowProtected = false,
  ) {
    const tab = yield* this.#requireTab(tabId);
    return yield* enqueueTabOperation(tab, operation, allowProtected);
  });

  readonly #runAction = Effect.fn("BrowserHost.runAction")(function* <A>(
    this: BrowserHost,
    tabId: string,
    action: string,
    target: BrowserTarget | undefined,
    operation: (
      tab: BrowserHostTab,
      deadline: number,
      markDispatched: () => void,
    ) => Effect.Effect<void, BrowserOperationError>,
    readResult: ActionResultReader<A>,
    timeoutMs?: number,
    onOperationStarted?: (completion: Fiber.Fiber<void, BrowserOperationError>) => void,
  ): Effect.fn.Return<A | ClosedTabResult | DialogTabResult, BrowserOperationError> {
    const tab = yield* this.#requireTab(tabId);
    return yield* runTabAction(tab, action, target, operation, readResult, timeoutMs, onOperationStarted);
  });

  readonly #runEvaluation = Effect.fn("BrowserHost.runEvaluation")(function* (
    this: BrowserHost,
    tabId: string,
    expression: string,
    awaitPromise: boolean,
    timeoutMs: number,
    undefinedAsNull = false,
    maxBytes?: number,
  ): Effect.fn.Return<BrowserJsonValue, BrowserOperationError> {
    const tab = yield* this.#requireTab(tabId);
    // The origin is read in the tab's queue, just before the script runs, and again when it ends: a
    // navigation queued before it, or one that commits while it runs, decides where it ran.
    const markScripted = () => {
      const origin = urlOrigin(currentTabUrl(tab));
      if (!origin) return;
      markScriptedOrigin(tab, origin);
      this.#cacheTainted(this.#tabSession(tab)).add(origin);
    };
    return yield* runTabEvaluation(
      tab,
      () => {
        this.#requireNoSecretDocument(tab, "Page evaluation");
        markScripted();
      },
      expression,
      awaitPromise,
      timeoutMs,
      undefinedAsNull,
      maxBytes,
    ).pipe(Effect.ensuring(Effect.sync(markScripted)));
  });

  #emitChanged(): void {
    const tabs = this.listTabs();
    for (const listener of this.#listeners) listener(tabs, this.#activeTabId);
  }

  #schedulePersist(): void {
    if (this.#destroying) return;
    void runCauseEffect(
      Effect.forkIn(
        this.#persistState().pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.error("Unable to persist browser tabs:", toLogValue(error.cause));
            }),
          ),
        ),
        this.#scope,
        { startImmediately: true, uninterruptible: true },
      ),
    );
  }

  readonly #persistState = Effect.fn("BrowserHost.persistState")(function* (this: BrowserHost) {
    const saved = [...this.#tabs.values()].filter((tab) => !tab.closing && !tab.contents.isDestroyed());
    const state: StoredBrowserStateV2 = {
      version: 2,
      activeTabId: saved.some((tab) => tab.id === this.#activeTabId) ? this.#activeTabId : (saved[0]?.id ?? null),
      tabs: [
        ...saved.map((tab) => ({
          id: tab.id,
          url: tab.secret?.origin ?? persistentBrowserUrl(currentTabUrl(tab), { popup: tab.popup }),
          ownerThreadId: tab.ownerThreadId,
          ownerAgentId: tab.ownerAgentId,
          environment: tab.environment,
          ...storedSessionFields(tab.tabSession),
          ...(tab.sharedThreadIds?.size ? { sharedThreadIds: [...tab.sharedThreadIds] } : {}),
        })),
        ...[...this.#unrestoredTabs.values()]
          .filter((tab) => !this.#tabs.has(tab.id) && (tab.profile === undefined || this.#profileExists(tab.profile)))
          .map((tab) => ({ ...tab, environment: tab.environment ?? defaultBrowserEnvironment() })),
      ],
    };
    yield* this.#persistLock.withPermit(
      writeJsonFileAtomically(this.#statePath, state).pipe(Effect.mapError((error) => browserFailure(error.cause))),
    );
  });
}

function currentPreviewPage(tab: BrowserHostTab): BrowserPreviewPage {
  return { url: currentTabUrl(tab), document: tab.documents, generation: tab.captureGeneration };
}

function showsCurrentPage(tab: BrowserHostTab, page: BrowserPreviewPage): boolean {
  const current = currentPreviewPage(tab);
  return page.url === current.url && page.document === current.document && page.generation === current.generation;
}
const loadSavedPage = Effect.fn("BrowserHost.loadSavedPage")(function* (tab: BrowserHostTab) {
  yield* browserCall(() => tab.contents.loadURL("about:blank"));
  yield* tab.engine.setEnvironment(tab.environment);
  yield* tab.engine.navigate(tab.requestedUrl);
  yield* browserSync(() => tab.contents.navigationHistory.clear());
});

/** The saved preview frame, when it still shows the tab's current page. */
function savedPreview(tab: BrowserHostTab): BrowserPreview | null {
  return tab.preview && showsCurrentPage(tab, tab.preview) ? tab.preview.frame : null;
}

/**
 * Returns the last two host labels, or the whole host for an IP address. Without the public suffix
 * list, this can join two sites (for example under `co.uk`) but never splits one site, so a match
 * can only refuse secure input, not permit it.
 */
function approximateSite(origin: string): string {
  const hostname = new URL(origin).hostname;
  if (isIP(hostname.replace(/^\[|\]$/gu, "")) !== 0) return hostname;
  return hostname.split(".").slice(-2).join(".");
}

/** The `url` of a diagnostic entry without credentials, query, or fragment; no key when the URL does not parse. */
function diagnosticUrlField(value: string): { url?: string } {
  const url = diagnosticUrl(value);
  return url === undefined ? {} : { url };
}

function readConsoleMessage(args: unknown[]): BrowserConsoleMessageDetails | null {
  const modern = args[1];
  if (
    isRecord(modern) &&
    (modern.level === "info" || modern.level === "warning" || modern.level === "error" || modern.level === "debug") &&
    isString(modern.message) &&
    isString(modern.sourceId)
  ) {
    return { level: modern.level, message: modern.message, sourceId: modern.sourceId };
  }
  const level = args[1];
  const message = args[2];
  const sourceId = args[4];
  if (!isNumber(level) || !isString(message)) return null;
  return {
    level: level >= 3 ? "error" : level === 2 ? "warning" : level === 0 ? "debug" : "info",
    message,
    sourceId: isString(sourceId) ? sourceId : "",
  };
}

function boundedCaptureDataUrl(image: NativeImage): string {
  const size = image.getSize();
  // A typed failure in `browserSync`, so the agent reads the reason, not a failed tool request (#5991).
  if (size.width <= 0 || size.height <= 0) throw new Error("Browser screenshot is empty.");
  const area = size.width * size.height;
  const scale = Math.sqrt(MAX_ENCODED_CAPTURE_PIXELS / area);
  const fitted =
    area <= MAX_ENCODED_CAPTURE_PIXELS
      ? image
      : image.resize({
          width: Math.max(1, Math.floor(size.width * scale)),
          height: Math.max(1, Math.floor(size.height * scale)),
          quality: "good",
        });
  const fittedSize = fitted.getSize();
  if (fittedSize.width < MIN_CAPTURE_SIDE || fittedSize.height < MIN_CAPTURE_SIDE) return paddedCaptureDataUrl(fitted);
  return fitted.toDataURL();
}

/**
 * Extends a small capture to `MIN_CAPTURE_SIDE` on the right and the bottom with its top-left pixel,
 * the page around an element. The content keeps its scale and position, so a point in the image is
 * still the same pixel.
 */
function paddedCaptureDataUrl(image: NativeImage): string {
  const encoded = image.toDataURL();
  // One representation in the encoded pixels: `getSize` gives a 2x capture in half of them.
  const source = nativeImage.createFromDataURL(encoded);
  const size = source.getSize();
  const width = Math.max(MIN_CAPTURE_SIDE, size.width);
  const height = Math.max(MIN_CAPTURE_SIDE, size.height);
  if (width === size.width && height === size.height) return encoded;
  const pixels = source.toBitmap();
  const padded = Buffer.alloc(width * height * 4);
  padded.fill(pixels.subarray(0, 4));
  for (let row = 0; row < size.height; row++)
    pixels.copy(padded, row * width * 4, row * size.width * 4, (row + 1) * size.width * 4);
  return nativeImage.createFromBitmap(padded, { width, height }).toDataURL();
}

function navigateHistory(contents: WebContents, direction: BrowserNavigationDirection): boolean {
  const offset = direction === "back" ? -1 : 1;
  if (!hasHistoryEntry(contents, offset)) return false;
  contents.navigationHistory.goToOffset(offset);
  return true;
}

function textResult(value: unknown): DynamicToolResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}

/** An action that closed its tab returns this in place of a snapshot. */
type ClosedTabResult = { tabId: string; closed: true; openerTabId?: string };

/** A tool result that is a snapshot, or a fill result that carries one. */
type SnapshotToolPayload =
  | BrowserSnapshot
  | ClosedTabResult
  | DialogTabResult
  | BrowserFillFieldsResult
  | (Pick<BrowserCardFillResult, "filled"> &
      Partial<Pick<BrowserCardFillResult, "unconfirmed">> & {
        snapshot: BrowserSnapshot | ClosedTabResult | DialogTabResult | null;
      })
  | (BrowserScriptResult & { tabId: string; snapshotError?: string; url?: string; snapshot?: BrowserSnapshot });

function snapshotTextResult(value: SnapshotToolPayload): DynamicToolResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: snapshotJson(value) }],
  };
}

/**
 * The model reads many snapshots in a task, so the model text is compact. Each element is one line,
 * which leaves out the JSON keys and the empty defaults. The history leaves out what the model already
 * knows: network requests that succeeded, and its own actions that succeeded with no detail. The
 * snapshot tool description says so. Only the snapshot's own elements become lines: a value that a
 * script returns keeps its `elements` key as it is.
 */
function snapshotJson(value: SnapshotToolPayload): string {
  if ("elements" in value) return JSON.stringify(withElementLines(value));
  if ("snapshot" in value) return JSON.stringify({ ...value, snapshot: withElementLines(value.snapshot) });
  return JSON.stringify(value);
}

function withElementLines(snapshot: BrowserSnapshot | ClosedTabResult | DialogTabResult | null | undefined) {
  return snapshot && "elements" in snapshot ? { ...snapshot, elements: snapshot.elements.map(elementLine) } : snapshot;
}

/** Tags that the role already implies. The line names a tag only when it adds to the role. */
const ROLE_TAGS: Readonly<Record<string, readonly string[]>> = {
  button: ["button"],
  link: ["a"],
  textbox: ["input", "textarea"],
  searchbox: ["input"],
  // A native select keeps its tag: only it takes select_option.
  combobox: ["input"],
  checkbox: ["input"],
  radio: ["input"],
  slider: ["input"],
  spinbutton: ["input"],
  option: ["option"],
  img: ["img"],
};

/**
 * `ref [role] "name" [<tag>] [value="…"] [description="…"] [state:value…] [bounds=x,y,w,h]
 * [frame=id frameUrl="…"]`. Text values are JSON strings; the other tokens have no spaces.
 */
function elementLine(element: BrowserElement): string {
  const tokens = [element.ref];
  if (element.role) tokens.push(element.role);
  tokens.push(JSON.stringify(element.name));
  if (!element.role || !ROLE_TAGS[element.role]?.includes(element.tag)) tokens.push(`<${element.tag}>`);
  if (element.value !== null) tokens.push(`value=${JSON.stringify(element.value)}`);
  if (element.description) tokens.push(`description=${JSON.stringify(element.description)}`);
  tokens.push(...element.states);
  const { bounds, frame } = element;
  if (bounds) tokens.push(`bounds=${bounds.x},${bounds.y},${bounds.width},${bounds.height}`);
  if (frame) tokens.push(`frame=${frame.id}`, `frameUrl=${JSON.stringify(frame.url)}`);
  return tokens.join(" ");
}

function uniqueDownloadPath(root: string, name: string, reserved: Set<string>): string {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let suffix = 1; ; suffix += 1) {
    const candidate = join(root, suffix === 1 ? name : `${stem} (${suffix})${extension}`);
    if (!reserved.has(candidate) && !existsSync(candidate)) return candidate;
  }
}
