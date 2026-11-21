/**
 * The entry point of the Tommy server. It builds the services, starts the agents and stops them on
 * a quit. People reach the server through Telegram; there is no window to show.
 */

import { join, resolve } from "node:path";
import { createTommyLogger, toLogValue } from "@tommy/logging";
import { Effect } from "effect";
import { app, BrowserWindow, crashReporter, protocol, session } from "electron";
import { runCauseEffect } from "../backend/effect-boundary";
import { type ApplicationServices, createApplicationServices } from "./application-services";
import { removeClaudeCodeSessionEnvironment } from "./claude-session-environment";
import { stopStuckExitAfterLimit } from "./exit-watchdog";
import { configureLinuxPasswordStore } from "./linux-password-store";
import { startMainLog } from "./provider-log";
import { takeServerModeEnvironment } from "./server-mode";
import { trustSystemCertificates } from "./system-certificates";
import { TeardownRegistry } from "./teardown-registry";
import type { TraceFile } from "./trace-file";

const logger = createTommyLogger("main");

// Electron keeps running after both events. These add a redacted log line and a trace span.
let crashTrace: TraceFile | null = null;
process.on("unhandledRejection", (reason) => reportMainProcessFailure("unhandledRejection", reason));
process.on("uncaughtExceptionMonitor", (error, origin) => reportMainProcessFailure(origin, error));
// Electron shows an error box for an uncaught exception while no other listener handles it. On a
// server nobody can close it, and it blocks the quit. The monitor above still logs the exception.
process.on("uncaughtException", () => {});

type ExitReason = "signal" | "quit";
let exitRecorded = false;

/** Records once why Tommy quits, in the main log and in the trace, before the teardown closes the trace. */
function recordExit(reason: ExitReason): void {
  if (exitRecorded) return;
  exitRecorded = true;
  logger.info(`Quitting: ${reason}.`);
  if (!crashTrace) return;
  crashTrace.record({ kind: "exit", name: reason, durationMs: 0, outcome: "requested" });
  Effect.runFork(crashTrace.flush());
}

function reportMainProcessFailure(origin: "uncaughtException" | "unhandledRejection", error: unknown): void {
  logger.error(`Main process ${origin}:`, toLogValue(error));
  if (!crashTrace) return;
  crashTrace.record({ kind: "crash", name: origin, durationMs: 0, outcome: "reported" });
  Effect.runFork(crashTrace.flush());
}

// Before any network call: a TLS-inspecting network needs the roots that IT installed.
try {
  trustSystemCertificates();
} catch (error) {
  logger.warn("Could not read the system certificate store; Node uses its bundled roots only:", toLogValue(error));
}

const commandLineUserDataDirectory = app.commandLine.getSwitchValue("user-data-dir").trim();
// Before any child process starts: agents must not run as part of a Claude Code session that started Tommy.
removeClaudeCodeSessionEnvironment(process.env);
const serverMode = takeServerModeEnvironment(process.env, app.isPackaged, process.platform);
// Electron exposes FedCM without an account chooser, so every request fails with a NetworkError.
// Sites such as Google Sign-In use FedCM when it exists and fall back to their popup when it does not.
app.commandLine.appendSwitch("disable-features", "FedCm");
// Linux #2374: name the Secret Service where Chromium would keep no sign-in.
if (configureLinuxPasswordStore())
  logger.info(`No Chromium keyring for "${process.env.XDG_CURRENT_DESKTOP ?? ""}"; using gnome-libsecret.`);
if (commandLineUserDataDirectory) app.setPath("userData", resolve(commandLineUserDataDirectory));
// The data folder and the keyring item use this name.
app.setName("Tommy");
app.enableSandbox();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
// A second launch exits at once and must not write into the files of the instance that runs.
if (hasSingleInstanceLock) {
  startMainLog(join(app.getPath("userData"), "logs"));
  // Crash dumps stay in `crashDumps` on this computer.
  crashReporter.start({ uploadToServer: false });
  // A file request that never finishes must not keep the process and its lock after an exit.
  stopStuckExitAfterLimit(join(app.getPath("userData"), "logs"));
}
// The Linux service draws its browser and previews on a virtual display.
if (process.platform === "linux") app.disableHardwareAcceleration();
// A visual reply page. It needs no fetch or CORS support: only a frame loads it.
protocol.registerSchemesAsPrivileged([{ scheme: "tommy-visual", privileges: { standard: true, secure: true } }]);

let shutdownStarted = false;
let constructing: Promise<ApplicationServices> | null = null;
/** The teardown ended, also by an error. Until then `before-quit` holds every quit request. */
let shutdownDone = false;

// systemd stops the server with SIGTERM. Without a handler, Electron ends at once and its services
// do not stop.
{
  const quitAfterSignal = () => {
    recordExit("signal");
    app.quit();
  };
  process.once("SIGINT", quitAfterSignal);
  process.once("SIGTERM", quitAfterSignal);
  process.once("SIGHUP", quitAfterSignal);
}

/**
 * Filled in as `createApplicationServices` builds, so a quit that arrives part-way through stops
 * exactly what exists. Each step's position in the sequence is declared where the service is built.
 */
const teardown = new TeardownRegistry({
  reportError: (name, error) => logger.error(`Unable to shut down ${name}:`, toLogValue(error)),
});

/** A window that never loads. The agent browser attaches its tabs to it; nobody sees it. */
function createBrowserWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: "Tommy",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
}

/** Nothing loads in the default session, so it grants nothing. The agent browser has its own sessions. */
function denyDefaultSessionPermissions(): void {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

if (!hasSingleInstanceLock) {
  // No application services exist yet, so the secondary process can exit without shutdown work.
  process.exit(0);
} else {
  void app
    .whenReady()
    .then(async () => {
      if (shutdownStarted) return;
      denyDefaultSessionPermissions();
      constructing = createApplicationServices({ browserWindow: createBrowserWindow(), serverMode, teardown });
      const built = await constructing;
      if (shutdownStarted) return;
      crashTrace = built.trace;
      built.service.on("event", (event) => built.trace.observeAgentEvent(event));
      // A routine or its owner can be deleted outside the events API. Its route is then revoked here.
      let webhookAgentIds = new Set(built.service.listAgents().map((agent) => agent.id));
      built.service.on("event", (event) => {
        switch (event.type) {
          case "routines-changed":
          case "channel-routines-changed":
          // A save or a delete can remove a webhook trigger, and a new secret can add a route.
          case "workflows-changed":
            built.eventsRuntime.syncRoutes({ all: false });
            return;
          case "agents-changed": {
            const previous = webhookAgentIds;
            webhookAgentIds = new Set(event.agents.map((agent) => agent.id));
            if ([...previous].some((id) => !webhookAgentIds.has(id))) built.eventsRuntime.syncRoutes({ all: false });
            return;
          }
          case "channels-changed":
            if (!built.service.routineRecords.ownerExists({ kind: "channel", id: event.channelId }))
              built.eventsRuntime.syncRoutes({ all: false });
            return;
        }
      });
      await runCauseEffect(built.agentInitialization.start()).catch((error) => {
        logger.error("Unable to initialize the agents:", toLogValue(error));
      });
      if (!shutdownStarted && built.agentInitialization.succeeded) Effect.runFork(built.prewarmAgentDatabase);
    })
    .catch((error) => {
      // A quit during the start is already running: the shutdown deadline applies to it.
      if (shutdownStarted) {
        logger.warn("The quit stopped the start:", toLogValue(error));
        return;
      }
      logger.error("Tommy failed to start:", toLogValue(error));
      app.quit();
    });
}

// The hidden browser window never closes by itself. Tommy quits only on a signal or a quit request.
app.on("window-all-closed", () => {});

app.on("before-quit", (event) => {
  // The quit that follows the teardown.
  if (shutdownDone) return;
  event.preventDefault();
  // A second request while the teardown runs.
  if (shutdownStarted) return;
  void prepareForShutdown().finally(() => app.quit());
});

/**
 * The teardown gives up on each step after its own limit, but steps run one after another, and
 * something outside it can still hold the quit. A process that outlives its quit keeps the
 * single-instance lock, so every later start exits without running.
 */
const SHUTDOWN_DEADLINE_MS = 30_000;

async function prepareForShutdown(deadlineMs = SHUTDOWN_DEADLINE_MS): Promise<void> {
  if (shutdownStarted) return;
  recordExit("quit");
  shutdownStarted = true;
  setTimeout(() => {
    logger.error(`Tommy did not quit within ${deadlineMs} ms and will exit now.`);
    app.exit(0);
  }, deadlineMs).unref();
  try {
    // Let construction register its last cleanup and the active database migration finish.
    const services = await constructing?.catch(() => null);
    if (services) await runCauseEffect(services.agentInitialization.stop());
    await teardown.runAll();
  } finally {
    shutdownDone = true;
  }
}
