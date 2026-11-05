// The Electron half of `browser-secure-login-e2e.ts`. It drives the real `BrowserHost` in a hidden
// window, with a temporary profile and HTTPS pages served inside the session. The values are made up.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { app, BrowserWindow, webContents } from "electron";
import { BrowserHost } from "../src/backend/browser-host";
import { runCauseEffect } from "../src/backend/effect-boundary";
import type { DynamicToolCallParams } from "../src/backend/protocol";

const argument = (name: string) => {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};
const root = argument("fixture-root");
const reportPath = argument("report-path");
const SITE = "https://login.tommy.test";
const USERNAME = "fixture-user@example.test";
const SECRET = "fixture-password-729104";

/** Each POST that the page sends: what the site got. */
const posts: Array<{ path: string; body: string }> = [];
let reloadHangs = false;

const FORM = (action: string) => `<!doctype html><title>Sign in</title><body>
  <form id="form" method="post" action="${action}">
    <label>Account<input id="user" type="email" name="user"></label>
    <label>Password<input id="pass" type="password" name="pass"></label>
    <button id="go">Sign in</button>
  </form></body>`;

function site(request: Request, body: string): Response | Promise<Response> {
  const { pathname } = new URL(request.url);
  const html = (text: string) => new Response(text, { headers: { "Content-Type": "text/html" } });
  if (request.method === "POST") {
    posts.push({ path: pathname, body });
    return html("<!doctype html><title>Done</title><h1>Signed in</h1>");
  }
  if (pathname === "/login") return html(FORM("/session"));
  // A single-page sign-in: the page stays, and shows its next step with no navigation.
  if (pathname === "/spa")
    return html(`<!doctype html><title>App</title><body>
      <label>Account<input id="user" type="text"></label>
      <label>Password<input id="pass" type="password"></label>
      <button id="go" onclick="document.body.insertAdjacentHTML('beforeend', '<h1>Next step</h1>');
        document.getElementById('user').value=''; document.getElementById('pass').value='';">Sign in</button></body>`);
  // A page that removes its form as soon as the card opens, so the fill cannot start.
  if (pathname === "/moves")
    return html(
      `${FORM("/session")}<script>window.moveForm = () => document.getElementById('form').remove();</script>`,
    );
  // A page whose button does nothing and whose reload never answers: only a blank page replaces it.
  if (pathname === "/stuck") {
    if (reloadHangs) return new Promise<Response>(() => {});
    reloadHangs = true;
    return html(`<!doctype html><title>Stuck</title><body>
      <label>Password<input id="pass" type="password" oninput="document.body.dataset.copy=this.value"></label>
      <button id="go" onclick="document.body.dataset.clicked='1'">Sign in</button></body>`);
  }
  if (pathname === "/filled")
    return html(`<!doctype html><title>Filled</title><body>
      <label>Password<input id="pass" type="password" oninput="document.body.dataset.copy=this.value"></label><button id="go">Sign in</button></body>`);
  return new Response("Not found", { status: 404 });
}

const passed: string[] = [];
const scenario = async (name: string, run: () => Promise<void>) => {
  // A check that waits forever names itself, in place of a run that never ends.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    run(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 60_000);
    }),
  ]).finally(() => clearTimeout(timer));
  passed.push(name);
  process.stdout.write(`passed: ${name}\n`);
};

let exitCode = 0;
let host: BrowserHost | undefined;
let window: BrowserWindow | undefined;
async function main() {
  app.setPath("userData", join(root, "profile"));
  app.setPath("sessionData", join(root, "session"));
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    focusable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const browser = new BrowserHost(window, join(root, "downloads"), join(root, "tabs.json"));
  host = browser;
  const owner = { threadId: "login-thread", ownerAgentId: "login-agent", turnId: "login-turn" };
  let sequence = 0;
  const params = (tool: string, args: DynamicToolCallParams["arguments"]): DynamicToolCallParams => ({
    namespace: "tommy_browser",
    tool,
    arguments: args,
    callId: `login-${++sequence}`,
    ...owner,
  });
  // The session of a tab serves the HTTPS pages, so one tab on loopback opens it first.
  const loopback = createServer((_request, response) => response.end("<!doctype html><title>Seed</title>"));
  await new Promise<void>((resolve) => loopback.listen(0, "127.0.0.1", resolve));
  const address = loopback.address();
  assert(address && typeof address === "object", "Missing the loopback address.");
  const seed = await runCauseEffect(
    browser.open(`http://127.0.0.1:${address.port}/`, owner.threadId, owner.ownerAgentId),
  );
  const seedContents = webContents.getAllWebContents().find((contents) => contents.getURL() === seed.url);
  assert(seedContents, "Missing the session of the fixture.");
  await seedContents.session.protocol.handle("https", async (request) =>
    new URL(request.url).hostname === "login.tommy.test"
      ? site(request, request.method === "POST" ? await request.text() : "")
      : new Response("Not found", { status: 404 }),
  );
  await runCauseEffect(browser.close(seed.id));
  loopback.close();

  const openLogin = async (path: string) => {
    const tab = await runCauseEffect(browser.open(`${SITE}${path}`, owner.threadId, owner.ownerAgentId));
    return tab.id;
  };
  const prepare = (tabId: string, extra: object = {}) =>
    runCauseEffect(
      browser.prepareSecret(
        params("submit_secret", {
          tabId,
          method: "password",
          targets: [{ kind: "css", selector: "#pass" }],
          submission: "click",
          submitTarget: { kind: "css", selector: "#go" },
          digits: 0,
          ...extra,
        }),
      ),
    );
  const tool = (name: string, args: object) => runCauseEffect(browser.handleDynamicTool(params(name, args)));
  const text = (result: { contentItems: Array<{ type: string; text?: string }> }) =>
    result.contentItems.map((item) => item.text ?? "").join(" ");

  await scenario("one form fills the account name and the password, and the site gets both", async () => {
    const tabId = await openLogin("/login");
    const handoff = await prepare(tabId, { usernameTarget: { kind: "css", selector: "#user" } });
    assert.equal(handoff.request.askUsername, true);
    assert.equal(handoff.request.method, "password");
    const outcome = await runCauseEffect(handoff.submit(SECRET, false, USERNAME));
    assert.deepEqual(outcome, { status: "submitted" });
    const post = posts.at(-1);
    assert.equal(post?.path, "/session");
    const form = new URLSearchParams(post?.body);
    assert.equal(form.get("user"), USERNAME);
    assert.equal(form.get("pass"), SECRET);
    const snapshot = await tool("snapshot", { tabId, image: "never" });
    assert.ok(snapshot.success, "The agent could not read the tab after the sign-in.");
    assert.ok(text(snapshot).includes("Signed in"));
    assert.ok(!text(snapshot).includes(SECRET), "The secret reached a snapshot.");
    await runCauseEffect(browser.close(tabId));
  });

  await scenario("the account name that the agent knows shows in the form and is the default", async () => {
    const tabId = await openLogin("/login");
    const handoff = await prepare(tabId, {
      usernameTarget: { kind: "css", selector: "#user" },
      username: USERNAME,
    });
    assert.equal(handoff.request.username, USERNAME);
    assert.deepEqual(await runCauseEffect(handoff.submit(SECRET, false)), { status: "submitted" });
    assert.equal(new URLSearchParams(posts.at(-1)?.body).get("user"), USERNAME);
    await runCauseEffect(browser.close(tabId));
  });

  await scenario("a request with no account-name field is the released password form", async () => {
    const tabId = await openLogin("/login");
    const handoff = await prepare(tabId);
    assert.equal(handoff.request.askUsername, undefined);
    assert.equal(handoff.request.username, undefined);
    handoff.cancel();
    const snapshot = await tool("snapshot", { tabId, image: "never" });
    assert.ok(snapshot.success, "A cancelled form must give the tab back.");
    await runCauseEffect(browser.close(tabId));
  });

  await scenario("usernameTarget is refused for a code, and on a field that is not an account field", async () => {
    const tabId = await openLogin("/login");
    await assert.rejects(
      prepare(tabId, { method: "otp", digits: 6, usernameTarget: { kind: "css", selector: "#user" } }),
    );
    await assert.rejects(prepare(tabId, { usernameTarget: { kind: "css", selector: "#go" } }));
    const snapshot = await tool("snapshot", { tabId, image: "never" });
    assert.ok(snapshot.success, "A refused request must give the tab back.");
    await runCauseEffect(browser.close(tabId));
  });

  await scenario("a single-page sign-in keeps its page, and the agent reads its next step", async () => {
    const tabId = await openLogin("/spa");
    const handoff = await prepare(tabId, { usernameTarget: { kind: "css", selector: "#user" } });
    assert.deepEqual(await runCauseEffect(handoff.submit(SECRET, false, USERNAME)), { status: "submitted" });
    const snapshot = await tool("snapshot", { tabId, image: "never" });
    assert.ok(snapshot.success, "The agent could not read the page after the fill.");
    assert.ok(text(snapshot).includes("Next step"));
    assert.ok(!text(snapshot).includes(SECRET), "The secret reached a snapshot.");
    await runCauseEffect(browser.close(tabId));
  });

  await scenario("a form that changed fails with a reason, and the tab stays free for the agent", async () => {
    const tabId = await openLogin("/moves");
    const handoff = await prepare(tabId, { usernameTarget: { kind: "css", selector: "#user" } });
    const contents = webContents.getAllWebContents().find((item) => item.getURL().endsWith("/moves"));
    assert(contents, "Missing the page of the fixture.");
    await contents.executeJavaScript("window.moveForm()");
    const outcome = await runCauseEffect(handoff.submit(SECRET, false, USERNAME));
    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.ok(outcome.reason.length > 0);
    const snapshot = await tool("snapshot", { tabId, image: "never" });
    assert.ok(snapshot.success, `The tab stayed locked: ${text(snapshot)}`);
    const again = await prepare(tabId, { usernameTarget: { kind: "css", selector: "#user" } });
    again.cancel();
    await runCauseEffect(browser.close(tabId));
  });

  await scenario("a page that will not reload gives way to a blank page, so the tab is not locked", async () => {
    const tabId = await openLogin("/stuck");
    const handoff = await prepare(tabId);
    // The page keeps a copy of the value and nothing navigates, so the host must replace this document.
    const outcome = await runCauseEffect(handoff.submit(SECRET, false));
    assert.equal(outcome.status, "submitted");
    const status = await tool("list_tabs", {});
    const listed = text(status);
    assert.ok(!listed.includes("Secure authentication"), `The tab stayed locked: ${listed}`);
    const snapshot = await tool("snapshot", { tabId, image: "never" });
    assert.ok(snapshot.success, `The agent could not read the tab: ${text(snapshot)}`);
    await tool("navigate", { tabId, url: `${SITE}/login` });
    await runCauseEffect(browser.close(tabId));
  });

  await scenario("close_tab works on a finished fill whose page could not be replaced", async () => {
    const tabId = await openLogin("/filled");
    const handoff = await prepare(tabId);
    const contents = webContents.getAllWebContents().find((item) => item.getURL().endsWith("/filled"));
    assert(contents, "Missing the page of the fixture.");
    const load = contents.loadURL.bind(contents);
    contents.loadURL = () => Promise.reject(new Error("The fixture refuses this load."));
    const outcome = await runCauseEffect(handoff.submit(SECRET, false));
    contents.loadURL = load;
    assert.equal(outcome.status, "failed");
    const snapshot = await runCauseEffect(
      browser.handleDynamicTool(params("snapshot", { tabId, image: "never" })),
    ).catch((error: unknown) => ({ success: false, contentItems: [{ type: "inputText", text: String(error) }] }));
    assert.ok(!snapshot.success, "A filled page must stay closed to the agent.");
    const closed = await tool("close_tab", { tabId });
    assert.ok(closed.success, `close_tab failed: ${text(closed)}`);
  });
}

main()
  .catch((error: unknown) => {
    exitCode = 1;
    process.stderr.write(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  })
  .finally(async () => {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      `${JSON.stringify({ status: exitCode === 0 ? "passed" : "failed", cases: passed }, null, 2)}\n`,
    );
    // A page that never answers can hold the teardown, and the report is already written.
    setTimeout(() => app.exit(exitCode), 5_000);
    if (host) await runCauseEffect(host.destroy()).catch(() => undefined);
    window?.destroy();
    app.exit(exitCode);
  });
