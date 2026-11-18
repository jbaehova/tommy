// The Electron half of `browser-secure-login-e2e.ts`. It drives the real `BrowserHost` in a hidden
// window, with a temporary profile and HTTPS pages served inside the session. The values are made up.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { decodeRecord } from "@tommy/contracts/ipc-decoding";
import { isDynamicRecord } from "@tommy/contracts/runtime-values";
import { app, BrowserWindow, webContents } from "electron";
import { BrowserHost } from "../src/backend/browser-host";
import { readBrowserState } from "../src/backend/browser-state";
import type { BrowserToolCall } from "../src/backend/browser-tools";
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
  if (pathname === "/fails") throw new Error("The fixture refuses its first page load.");
  if (pathname === "/fields")
    return html(`<!doctype html><title>Code fields</title><body>
      <label>Masked password<input id="masked" type="text" style="-webkit-text-security:disc"></label>
      <label>Authenticator<input id="totpmfa" type="text" autocomplete="off"></label>
      <label>SMS code<input id="smsOtp" type="text"></label>
      <label>Recovery code<input id="totpbackup" type="text"></label>
      <button id="go">Continue</button></body>`);
  if (pathname === "/v3/signin/challenge/totp" || pathname === "/checkout")
    return html(`<!doctype html><title>Enter code</title><body>
      <form method="post" action="/verified">
        <label for="entry">Enter code</label><input id="entry" type="tel" name="pin">
        <label>SMS code<input id="message" type="tel"></label>
        <label>Recovery code<input id="backup" type="text"></label>
        <label>Promo code<input id="offer" type="text"></label>
        <span id="description">Authenticator code</span><input id="token" type="tel" aria-labelledby="description">
        <button id="go">Next</button>
      </form></body>`);
  if (pathname === "/large")
    return html(`<!doctype html><title>Large page</title><body>
      <div hidden>${"<div>Hidden menu item</div>".repeat(11_000)}</div>
      <label>Report<input id="entry"></label>
      <button id="commit" onclick="document.getElementById('result').textContent='Saved '+document.getElementById('entry').value">Commit</button>
      <p id="result">Pending</p></body>`);
  if (pathname === "/large-ambiguous")
    return html(`<!doctype html><title>Large ambiguous page</title><body>
      <input id="entry"><div hidden>${"<div>Hidden menu item</div>".repeat(11_000)}</div>
      <div id="host"></div><script>
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML='<input id="entry">';
      </script></body>`);
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
  const prepare = (tabId: string, extra: Partial<Extract<BrowserToolCall, { tool: "submit_secret" }>["args"]> = {}) =>
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
  const tool = (name: string, args: DynamicToolCallParams["arguments"]) =>
    runCauseEffect(browser.handleDynamicTool(params(name, args)));
  const text = (result: { contentItems: Array<{ type: string; text?: string }> }) =>
    result.contentItems.map((item) => item.text ?? "").join(" ");

  await scenario(
    "masked password and authenticator fields qualify without admitting SMS or recovery fields",
    async () => {
      const tabId = await openLogin("/fields");
      try {
        for (const [selector, method, fillable] of [
          ["#masked", "password", true],
          ["#totpmfa", "authenticator", true],
          ["#smsOtp", "authenticator", false],
          ["#totpbackup", "authenticator", false],
        ] as const) {
          const handoff = await prepare(tabId, {
            method,
            digits: method === "password" ? 0 : 6,
            targets: [{ kind: "css", selector }],
          });
          assert.equal(handoff.vaultFillable, fillable, `Wrong saved-login policy for ${selector}.`);
          handoff.cancel();
        }
      } finally {
        await runCauseEffect(browser.close(tabId));
      }
    },
  );

  await scenario(
    "a plain code label qualifies only on an authenticator step, with unrelated fields excluded",
    async () => {
      for (const path of ["/v3/signin/challenge/totp", "/checkout"]) {
        const tabId = await openLogin(path);
        try {
          for (const [selector, fillable] of [
            ["#entry", path.endsWith("/totp")],
            ["#message", false],
            ["#backup", false],
            ["#offer", false],
            ["#token", true],
          ] as const) {
            const handoff = await prepare(tabId, {
              method: "authenticator",
              digits: 6,
              targets: [{ kind: "css", selector }],
            });
            assert.equal(handoff.vaultFillable, fillable, `Wrong saved-login policy for ${path} ${selector}.`);
            assert.equal(handoff.agentScriptedOrigin, false);
            handoff.cancel();
          }
        } finally {
          await runCauseEffect(browser.close(tabId));
        }
      }
    },
  );

  await scenario(
    "a labelled authenticator field submits its code without exposing it in the next snapshot",
    async () => {
      const tabId = await openLogin("/v3/signin/challenge/totp");
      try {
        const handoff = await prepare(tabId, {
          method: "authenticator",
          digits: 6,
          targets: [{ kind: "css", selector: "#entry" }],
        });
        assert.equal(handoff.vaultFillable, true);
        const contents = webContents.getAllWebContents().find((item) => item.getURL().endsWith("/challenge/totp"));
        assert(contents, "Missing the authenticator fixture.");
        const navigated = new Promise<void>((resolve) => contents.once("did-finish-load", () => resolve()));
        assert.deepEqual(await runCauseEffect(handoff.submit("482061", false)), { status: "submitted" });
        await navigated;
        assert.equal(posts.at(-1)?.path, "/verified");
        assert.equal(new URLSearchParams(posts.at(-1)?.body).get("pin"), "482061");
        const snapshot = await tool("snapshot", { tabId, image: "never" });
        assert.ok(snapshot.success, text(snapshot));
        assert.ok(text(snapshot).includes("Signed in"));
        assert.ok(!text(snapshot).includes("482061"), "The code reached a snapshot.");
      } finally {
        await runCauseEffect(browser.close(tabId));
      }
    },
  );

  await scenario("an evaluated site waits until all exposed documents navigate before saved login", async () => {
    const first = await openLogin("/login");
    const second = await openLogin("/login");
    try {
      const evaluated = await tool("evaluate", { tabId: first, expression: "document.title" });
      assert.ok(evaluated.success, text(evaluated));
      const held = await prepare(second);
      assert.equal(held.agentScriptedOrigin, true);
      held.cancel();
      const moved = await tool("navigate", { tabId: first, url: `${SITE}/login?fresh=first` });
      assert.ok(moved.success, text(moved));
      const exposed = await prepare(second);
      assert.equal(exposed.agentScriptedOrigin, true, "The other open document was cleared too soon.");
      exposed.cancel();
      const reloaded = await tool("navigate", { tabId: second, url: `${SITE}/login?fresh=second` });
      assert.ok(reloaded.success, text(reloaded));
      const clean = await prepare(second);
      assert.equal(clean.agentScriptedOrigin, false, "Fresh documents remained blocked after cache cleanup.");
      clean.cancel();
    } finally {
      await runCauseEffect(browser.close(first));
      await runCauseEffect(browser.close(second));
    }
  });

  await scenario("large hidden menus do not hide controls and script values retain elements arrays", async () => {
    const tabId = await openLogin("/large");
    try {
      const snapshot = await tool("snapshot", { tabId, image: "never" });
      assert.ok(snapshot.success, text(snapshot));
      assert.ok(text(snapshot).includes("Commit"), "The visible action was absent from the snapshot.");
      const result = await tool("run_script", {
        tab_id: tabId,
        script: `await type("#entry", "A");
          await type("#entry", "B", { replace: false });
          await click(role("button", "Commit", { exact: true }));
          await waitFor({ text: "Saved AB", state: "networkidle" });
          return { elements: [{ text: "A" }], result: await evaluate(() => document.getElementById("result").textContent) };`,
      });
      assert.ok(result.success, text(result));
      const payload = decodeRecord(JSON.parse(text(result)), "browser script result");
      assert.ok(isDynamicRecord(payload));
      assert.equal(payload.status, "completed");
      assert.deepEqual(payload.value, { elements: [{ text: "A" }], result: "Saved AB" });
    } finally {
      await runCauseEffect(browser.close(tabId));
    }
  });

  await scenario("a selector stays ambiguous when its second match follows a large hidden subtree", async () => {
    const tabId = await openLogin("/large-ambiguous");
    try {
      const result = await tool("type", { tabId, target: { kind: "css", selector: "#entry" }, text: "Must not enter" });
      assert.equal(result.success, false, "A second shadow-root match was ignored.");
      assert.ok(text(result).includes("CSS selector is ambiguous"), text(result));
      const contents = webContents.getAllWebContents().find((item) => item.getURL().endsWith("/large-ambiguous"));
      assert(contents, "Missing the ambiguous fixture.");
      assert.equal(await contents.executeJavaScript("document.getElementById('entry').value"), "");
    } finally {
      await runCauseEffect(browser.close(tabId));
    }
  });

  await scenario("a crashed scripted renderer does not keep a fresh login blocked", async () => {
    const first = await openLogin("/login?crash=first");
    const second = await openLogin("/login?crash=second");
    try {
      const evaluated = await tool("evaluate", { tabId: first, expression: "document.title" });
      assert.ok(evaluated.success, text(evaluated));
      const contents = webContents.getAllWebContents().find((item) => item.getURL().endsWith("?crash=first"));
      assert(contents, "Missing the renderer to crash.");
      const crashed = new Promise<void>((resolve) => contents.once("render-process-gone", () => resolve()));
      contents.forcefullyCrashRenderer();
      await crashed;
      await runCauseEffect(browser.reload(second));
      const clean = await prepare(second);
      assert.equal(clean.agentScriptedOrigin, false, "A dead renderer still blocked a fresh login.");
      clean.cancel();
    } finally {
      await runCauseEffect(browser.close(first));
      await runCauseEffect(browser.close(second));
    }
  });

  await scenario("back navigation cannot make a retained scripted document eligible for automatic fill", async () => {
    const tabId = await openLogin("/login?history=first");
    try {
      const evaluated = await tool("evaluate", { tabId, expression: "(window.exampleScriptedPage = true)" });
      assert.ok(evaluated.success, text(evaluated));
      const away = await tool("navigate", { tabId, url: `${SITE}/login?history=second` });
      assert.ok(away.success, text(away));
      await runCauseEffect(browser.navigate(tabId, "back"));
      const contents = webContents.getAllWebContents().find((item) => item.getURL().endsWith("?history=first"));
      assert(contents, "Missing the page after back navigation.");
      const retained = await contents.executeJavaScript("window.exampleScriptedPage === true");
      const handoff = await prepare(tabId);
      assert.equal(
        handoff.agentScriptedOrigin,
        retained === true,
        "A retained scripted page became eligible for a saved login.",
      );
      handoff.cancel();
    } finally {
      await runCauseEffect(browser.close(tabId));
    }
  });

  await scenario("a failed person-opened tab stays available while an agent failure leaves no tab", async () => {
    const url = `${SITE}/fails`;
    await assert.rejects(runCauseEffect(browser.open(url, owner.threadId, owner.ownerAgentId)));
    const kept = browser.listTabs().find((tab) => tab.url === url);
    assert.ok(kept, "The failed person-opened address was discarded.");
    await runCauseEffect(browser.close(kept.id));
    const before = browser.listTabs().length;
    const result = await tool("open", { url });
    assert.equal(result.success, false);
    assert.equal(browser.listTabs().length, before, "A failed agent-opened tab was retained.");
  });

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

  await scenario("an unavailable saved profile proxy preserves its tab without loading it", async () => {
    const statePath = join(root, "unavailable-proxy-tabs.json");
    const tab = {
      id: "saved-person-tab",
      url: "https://example.com/kept",
      ownerThreadId: owner.threadId,
      ownerAgentId: owner.ownerAgentId,
      profile: "1234567890abcdef1234567890abcdef",
      agentSession: "11111111111111111111111111111111",
    };
    await writeFile(statePath, JSON.stringify({ version: 2, activeTabId: tab.id, tabs: [tab] }));
    const expected = await runCauseEffect(readBrowserState(statePath));
    assert.ok(window);
    const profileBrowser = new BrowserHost(window, join(root, "downloads"), statePath, {
      profileExists: () => true,
      profileProxy: () => {
        throw new Error("The fixture proxy is unavailable.");
      },
    });
    try {
      await runCauseEffect(profileBrowser.restore());
      assert.equal(profileBrowser.listTabs().length, 0, "A page loaded without its saved proxy.");
      assert.deepEqual(profileBrowser.tabIdsInSession({ kind: "profile", profileId: tab.profile }), [tab.id]);
    } finally {
      await runCauseEffect(profileBrowser.destroy());
    }
    const saved = await runCauseEffect(readBrowserState(statePath));
    assert.equal(saved.tabs.length, 1, "A temporary proxy failure erased the person's tab.");
    assert.deepEqual(saved.tabs[0], expected.tabs[0]);
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
