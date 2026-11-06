// Linux server smoke test of Computer Use: drives `agent-desktop mcp --headed` the way a provider does,
// on an agent display of its own, next to a "Tommy" display, both on one session bus.
//
//   dbus-run-session -- bun scripts/agent-desktop-smoke.ts [--driver <agent-desktop>] [--electron <electron>]
//
// Needs xvfb, openbox and at-spi2-core (tommy-install adds them). Starts its own two Xvfb displays and
// a window manager on the agent one, so it does not touch a running Tommy. Writes
// .tommy-build/agent-desktop-smoke.json and exits non-zero when a check fails.
//
// Checks: the driver answers; an Electron app on the agent display that asks for accessibility is
// listed, can be clicked (directly, else at its bounds), typed into and captured; a window on the
// Tommy display that does not ask stays off the tree, also after the bus accessibility switches.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type DynamicRecord, isNumber } from "@tommy/contracts/runtime-values";
import { Option, Schema } from "effect";
import { getArray, getRecord, getString, isRecord } from "../src/backend/protocol";
import { agentDisplayEnvironment } from "../src/main/agent-display";

const root = resolve(import.meta.dirname, "..");
function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return (index > 0 ? process.argv[index + 1] : undefined) ?? fallback;
}
const driver = argument("--driver", join(root, ".tommy-build", "agent-desktop", "agent-desktop"));
const electron = argument("--electron", join(root, "node_modules", "electron", "dist", "electron"));
const reportPath = join(root, ".tommy-build", "agent-desktop-smoke.json");
const checks = new Map<string, boolean>();
const notes = new Map<string, string>();
const children: ChildProcess[] = [];
const scratch = mkdtempSync(join(tmpdir(), "agent-desktop-smoke-"));

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitUntil(what: string, ready: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(250);
  }
  return true;
}

function freeDisplay(from: number): string {
  for (let n = from; n < from + 50; n += 1) if (!existsSync(`/tmp/.X11-unix/X${n}`)) return `:${n}`;
  throw new Error("No free X display number.");
}

async function startDisplay(display: string): Promise<void> {
  children.push(spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" }));
  await waitUntil(`Xvfb ${display}`, async () => existsSync(`/tmp/.X11-unix/X${display.slice(1)}`));
}

function withoutAccessibility(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ACCESSIBILITY_ENABLED: _a, QT_ACCESSIBILITY: _q, ...rest } = environment;
  return rest;
}

function probeApp(label: string, display: string, environment: Readonly<Record<string, string>>): ChildProcess {
  const app = join(scratch, `app-${label}`);
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: `probe-${label}`, main: "main.js" }));
  const page = `<title>${label}</title><button onclick="document.title='${label}-clicked'">Press ${label}</button><input aria-label="Field ${label}">`;
  writeFileSync(
    join(app, "main.js"),
    `const { app, BrowserWindow, Menu } = require("electron");
Menu.setApplicationMenu(null);
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 700, height: 400, x: 0, y: 0, title: ${JSON.stringify(label)} });
  win.loadURL("data:text/html," + encodeURIComponent(${JSON.stringify(page)}));
});`,
  );
  const child = spawn(electron, ["--no-sandbox", `--user-data-dir=${join(scratch, `profile-${label}`)}`, app], {
    env: { ...withoutAccessibility(process.env), DISPLAY: display, ...environment },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** One JSON object from the driver, or null when the line is not one. */
function parseLine(line: string): DynamicRecord | null {
  const value = Option.getOrNull(decodeJson(line));
  return isRecord(value) ? value : null;
}

interface ToolResult {
  ok: boolean;
  data: unknown;
  error: string | null;
  /** The error code, message and details, for the report. */
  problem: string | null;
  images: number;
}

/** A provider's view of the driver: one stdio MCP session. */
class McpSession {
  readonly #child: ChildProcess;
  readonly #waiting = new Map<number, (message: unknown) => void>();
  #id = 0;

  constructor(environment: Readonly<Record<string, string>>) {
    this.#child = spawn(driver, ["mcp", "--headed"], {
      env: { ...withoutAccessibility(process.env), ...environment },
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.push(this.#child);
    const output = this.#child.stdout;
    if (!output) throw new Error("The driver has no output.");
    createInterface({ input: output }).on("line", (line) => {
      const message = parseLine(line);
      const id = message?.id;
      if (isNumber(id)) this.#waiting.get(id)?.(message);
    });
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    this.#id += 1;
    const id = this.#id;
    this.#child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((done) => this.#waiting.set(id, done));
  }

  notify(method: string): void {
    this.#child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  /** The JSON envelope of one tool, and how many images came with it. */
  async tool(name: string, args: Readonly<Record<string, string | number | boolean>>): Promise<ToolResult> {
    const message = await this.request("tools/call", { name, arguments: args });
    const content = getArray(getRecord(message, "result"), "content");
    const text = content
      .map((part) => (getString(part, "type") === "text" ? getString(part, "text") : null))
      .find(Boolean);
    const envelope = text ? parseLine(text) : null;
    return {
      ok: envelope?.ok === true,
      data: envelope?.data ?? null,
      error: getString(getRecord(envelope, "error"), "code"),
      problem: envelope?.ok === true ? null : JSON.stringify(envelope?.error ?? text ?? null).slice(0, 600),
      images: content.filter((part) => getString(part, "type") === "image").length,
    };
  }
}

function findRef(node: unknown, role: string, name: string): string | null {
  if (!isRecord(node)) return null;
  const ref = getString(node, "ref_id");
  if (ref && getString(node, "role") === role && getString(node, "name") === name) return ref;
  for (const child of getArray(node, "children")) {
    const found = findRef(child, role, name);
    if (found) return found;
  }
  return null;
}

async function listedPids(mcp: McpSession): Promise<unknown[]> {
  const apps = getArray((await mcp.tool("desktop_list_apps", {})).data, "apps");
  return apps.map((app) => (isRecord(app) ? app.pid : null));
}

async function windowTitles(mcp: McpSession): Promise<string[]> {
  const { data } = await mcp.tool("desktop_list_windows", {});
  return (Array.isArray(data) ? data : []).map((window) => getString(window, "title") ?? "");
}

function busProperty(property: string, value?: boolean): string {
  const args = ["--user", value === undefined ? "get-property" : "set-property", "org.a11y.Bus", "/org/a11y/bus"];
  args.push("org.a11y.Status", property, ...(value === undefined ? [] : ["b", String(value)]));
  return execFileSync("busctl", args, { encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("This smoke test runs on Linux.");
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) throw new Error("Run it inside dbus-run-session.");
  const agentDisplay = freeDisplay(180);
  await startDisplay(agentDisplay);
  const tommyDisplay = freeDisplay(Number(agentDisplay.slice(1)) + 1);
  await startDisplay(tommyDisplay);
  children.push(spawn("openbox", [], { env: { ...process.env, DISPLAY: agentDisplay }, stdio: "ignore" }));
  // The same environment application-services gives the driver and the agent processes on a server.
  const agentEnvironment = agentDisplayEnvironment("linux", { TOMMY_AGENT_DISPLAY: agentDisplay });
  notes.set("agentEnvironment", JSON.stringify(agentEnvironment));

  const mcp = new McpSession(agentEnvironment);
  const initialized = await mcp.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tommy-smoke", version: "0" },
  });
  mcp.notify("notifications/initialized");
  notes.set("server", getString(getRecord(getRecord(initialized, "result"), "serverInfo"), "version") ?? "unknown");
  const status = await mcp.tool("desktop_status", {});
  const accessibility = getRecord(getRecord(status.data, "permissions"), "accessibility");
  checks.set("accessibilityGranted", getString(accessibility, "state") === "granted");

  const agentApp = probeApp("agentside", agentDisplay, agentEnvironment);
  const tommyApp = probeApp("tommyside", tommyDisplay, {});
  checks.set(
    "agentAppListed",
    await waitUntil("the agent app on the tree", async () => (await listedPids(mcp)).includes(agentApp.pid)),
  );
  checks.set("tommyAppHidden", !(await listedPids(mcp)).includes(tommyApp.pid));

  const snapshot = await mcp.tool("desktop_snapshot", { app: "electron", interactive_only: true, compact: true });
  const tree = getRecord(snapshot.data, "tree");
  const button = findRef(tree, "button", "Press agentside");
  const field = findRef(tree, "textfield", "Field agentside");
  checks.set("refsFound", Boolean(button && field));
  if (button) {
    const click = await mcp.tool("desktop_click", { ref_id: button });
    notes.set("directClick", click.ok ? "ok" : (click.error ?? "failed"));
    if (!click.ok) {
      // A headed click on web content can fail its hit test; the bounds and a coordinate click remain.
      const box = getRecord((await mcp.tool("desktop_get", { ref_id: button, property: "bounds" })).data, "value");
      const [x, y, width, height] = ["x", "y", "width", "height"].map((key) => (box ? box[key] : null));
      if (isNumber(x) && isNumber(y) && isNumber(width) && isNumber(height)) {
        const at = await mcp.tool("desktop_mouse_click", {
          xy: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`,
        });
        notes.set("boundsClick", at.ok ? "ok" : (at.problem ?? "failed"));
      }
    }
    checks.set(
      "clickChangedPage",
      await waitUntil(
        "the clicked title",
        async () => (await windowTitles(mcp)).includes("agentside-clicked"),
        5_000,
      ).catch(() => false),
    );
  }
  if (field) {
    const typed = await mcp.tool("desktop_type", { ref_id: field, text: "hello" });
    if (!typed.ok) notes.set("type", typed.problem ?? "failed");
    const value = await mcp.tool("desktop_get", { ref_id: field, property: "value" });
    notes.set("typedValue", JSON.stringify(value.data ?? value.problem));
    checks.set("typedValue", getString(value.data, "value") === "hello");
  }
  const shot = await mcp.tool("desktop_screenshot", { app: "electron" });
  checks.set("screenshot", shot.ok || shot.images > 0);

  const before = { IsEnabled: busProperty("IsEnabled"), ScreenReaderEnabled: busProperty("ScreenReaderEnabled") };
  try {
    busProperty("ScreenReaderEnabled", true);
    busProperty("IsEnabled", true);
    await sleep(3_000);
    checks.set("tommyAppHiddenAfterBusSwitches", !(await listedPids(mcp)).includes(tommyApp.pid));
  } finally {
    busProperty("IsEnabled", before.IsEnabled.endsWith("true"));
    busProperty("ScreenReaderEnabled", before.ScreenReaderEnabled.endsWith("true"));
  }
}

let failure: string | null = null;
try {
  await main();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  for (const child of children.reverse()) child.kill();
  rmSync(scratch, { recursive: true, force: true });
}
const passed = failure === null && [...checks.values()].every(Boolean);
const report = {
  passed,
  failure,
  checks: Object.fromEntries(checks),
  notes: Object.fromEntries(notes),
  at: new Date().toISOString(),
};
mkdirSync(join(root, ".tommy-build"), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n${passed ? "passed" : "failed"}: ${reportPath}\n`);
process.exit(passed ? 0 : 1);
